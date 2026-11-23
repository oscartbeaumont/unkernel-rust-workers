// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The unkernel host runtime, specialized for one app: a UP kernel with a
// console, an initrd and vsock, and no display, input, sound, virtio-gpu,
// shm, disks, network stack, mounts, snapshots, profiler or JIT.
//
// Forked from unkernel's js/core (kernel.ts, instance.ts, devices.ts) at
// package version 0.2.0-261121-e69adda. The protocol layers this app does
// use are copied unchanged: wasi.ts, vsock.ts, tty.ts (kwtty: spawn/connect),
// http.ts (fetch), output.ts. Everything else is not here:
//
//   core host            this file: clocks/random/console/idle (wasi.ts),
//                        task switching, console output and vsock
//   frozen (removed)     display, evdev input, sound, virtio-gpu, shm,
//                        block/disks, net stack, 9p/mounts, commands,
//                        snapshots, profiler, JIT tier, SMP, worker mode
//
// The kernel module imports all of those drivers' entry points whether the
// host offers the device or not, so imports() still answers every
// "unkernel" import: the removed devices answer like the SDK's disabled
// hosts did (init: -ENODEV, everything else a benign 0), which the guest
// never calls because a driver whose init failed is not registered. The
// wasm_fb_*/net_*/input_*/sound_*/shm_* names below are that answer, kept
// as named stubs so a future app cannot silently reach one.
//
// Same ABI as the SDK: wasm_switch_to, poll_oneoff, sched_yield and
// proc_exit are JSPI Suspending imports; every other import returns
// synchronously.

import { VsockDevice } from "./vsock.ts";
import { never, STACK_DROPPED, WasiHost, dropStack, stackDropped } from "./wasi.ts";
import { errorText } from "./output.ts";

/** Console input queued (wasm_driver_console_size, IRQ_CONSOLE). */
const IRQ_CONSOLE = 1;
/** kwvsock packets queued, or room again after a refused packet. */
const IRQ_VSOCK = 6;
const ENODEV = 19;
const EBUSY = 16;

const textDecoder = new TextDecoder();

/** How a kernel run ended: "halt" (power off/reboot), "panic", "trap", "fatal" or "stopped". */
export type ExitKind = "halt" | "panic" | "trap" | "fatal" | "stopped";

export interface ExitResult {
	code: number;
	reason: string;
	kind: ExitKind;
	error?: unknown;
}

/** Boot progress: "memory", "instantiate", "start" (kernel entry), "exit". */
export type BootStage = "memory" | "instantiate" | "start" | "exit";

export interface MemoryStage {
	mib: number;
	requestedMiB: number;
	failures: string[];
	memory64: boolean;
}

export interface KernelStats {
	switches: number;
	idles: number;
	yields: number;
}

export interface KernelConfig {
	/** Compiled vmlinux32.wasm (or the same module lowered), or a bundle of it. */
	module: WebAssembly.Module;
	/** Default 2048. */
	memoryMiB?: number;
	/** Smaller sizes to try, in order, if allocating memoryMiB fails. */
	memoryFallbackMiB?: number[];
	/** Default: the module's bundled one (bundledBoot), else "". */
	cmdline?: string;
	/** Default (undefined): the module's bundled initramfs, if any; null boots without one. */
	initrd?: Uint8Array | null;
	/** Console output. */
	write: (bytes: Uint8Array) => void;
	/** Host diagnostics; default console.error. */
	log?: (msg: string) => void;
	onStage?: (stage: BootStage, detail?: MemoryStage | ExitResult) => void;
	/**
	 * Offer a vsock device (kwvsock: AF_VSOCK, guest CID 3, host CID 2).
	 * Default true; false: the kernel registers no transport (spawn() and
	 * connect() then have nothing to talk to).
	 */
	vsock?: boolean;
	/** A packet from the guest's kwvsock (header and payload; a copy). */
	onVsockPacket?: (pkt: Uint8Array) => void;
	/** kwvsock started: the guest's CID and the largest packet it takes. */
	onVsockInit?: (guestCid: number, rxMax: number) => void;
}

/**
 * Does this kernel module import a 64-bit (memory64) memory? Read from the
 * linker's "target_features" section (Binaryen drops "memory64" when
 * lowering); without that section, guess wasm64 and let boot() retry.
 */
export function moduleIsMemory64(module: WebAssembly.Module): boolean {
	const secs = WebAssembly.Module.customSections(module, "target_features");
	if (!secs.length) return true;
	const b = new Uint8Array(secs[0]!);
	let p = 0;
	const leb = () => {
		let v = 0, s = 0, c;
		do { c = b[p++]!; v |= (c & 0x7f) << s; s += 7; } while (c & 0x80);
		return v;
	};
	for (let n = leb(); n > 0 && p < b.length; n--) {
		const prefix = String.fromCharCode(b[p++]!);
		const len = leb();
		const name = textDecoder.decode(b.subarray(p, p + len));
		p += len;
		if (name === "memory64") return prefix !== "-";
	}
	return false;
}

/**
 * The root file system, command line and data disk template bundled into
 * the module by kernel/tools/bundle.mjs (custom sections "unkernel.initrd",
 * "unkernel.cmdline" and "unkernel.datadisk"), or undefined for each that
 * is absent. This app has no disks, so datadisk is read but unused.
 */
export function bundledBoot(module: WebAssembly.Module): { initrd?: Uint8Array; cmdline?: string; datadisk?: Uint8Array } {
	const sec = (name: string) => WebAssembly.Module.customSections(module, name)[0];
	const initrd = sec("unkernel.initrd");
	const cmdline = sec("unkernel.cmdline");
	const datadisk = sec("unkernel.datadisk");
	return {
		initrd: initrd ? new Uint8Array(initrd) : undefined,
		cmdline: cmdline ? textDecoder.decode(cmdline) : undefined,
		datadisk: datadisk ? new Uint8Array(datadisk) : undefined,
	};
}

type Resolver = (task: bigint) => void;

/**
 * A host side that cannot get the event loop while the kernel runs and looks
 * for its events in the WASI clock instead (worker mode's shared transport in
 * the SDK). This fork has none; the type stays because wasi.ts reads it.
 */
export interface KernelPoller {
	poll(): void;
	idle(): boolean;
	awake(): void;
}

/**
 * One kernel instance: its memory, imports, console, vsock pipe and task
 * switching. boot() resolves with an ExitResult when the kernel halts.
 */
export class Kernel {
	opts: KernelConfig;
	log: (msg: string) => void;
	/** Pending console input chunks. */
	input: Uint8Array[];
	inputOffset: number;
	/** rows << 16 | cols, 0 = unknown. */
	consoleSize: number;
	/** resolve() of the current wasm_idle promise. */
	idleWake: (() => void) | null;
	/** task -> resolve(lastTask) */
	resumers: Map<bigint, Resolver>;
	onStage: (stage: BootStage, detail?: MemoryStage | ExitResult) => void;
	/** Settles with the first exit (halt, panic, trap, fatal, stop). */
	exited: Promise<ExitResult>;
	/** Record the exit (the first one wins). */
	exit!: (res: ExitResult) => void;
	/** The exit, once there is one. */
	result: ExitResult | undefined;
	stats: KernelStats;
	/** kwemu's JIT host: this fork offers none (Cloudflare Workers forbids compiling wasm at run time). */
	// (no jit field: see jitImports() below)
	/** kwvsock's host side: the packet queues (vsock.ts). */
	vsock: VsockDevice;
	memory!: WebAssembly.Memory;
	memory64 = false;
	wasi!: WasiHost;
	exports: WebAssembly.Exports | undefined;
	/** Address of wasm_host_irqs, once instantiated. */
	irqAddr: number | undefined;
	retFromFork!: (prev: bigint, next: bigint) => Promise<unknown>;
	/** performance.now() at kernel entry. */
	bootTime = 0;
	/** The kernel build: its linux_banner, once instantiated. */
	fingerprint = "";
	/** No worker mode (no shared transport to poll): always null. Kept because wasi.ts reads it. */
	poller: KernelPoller | null = null;

	constructor(opts: KernelConfig) {
		this.opts = opts;
		this.log = opts.log ?? ((m) => console.error(m));
		this.input = [];
		this.inputOffset = 0;
		this.consoleSize = 0;
		this.idleWake = null;
		this.resumers = new Map();
		this.onStage = opts.onStage ?? (() => {});
		this.result = undefined;
		this.exited = new Promise((r) => (this.exit = (res) => {
			if (this.result) return; // first exit wins
			this.result = res;
			try { this.onStage("exit", res); } catch {}
			r(res);
		}));
		this.stats = { switches: 0, idles: 0, yields: 0 };
		this.vsock = new VsockDevice({
			enabled: opts.vsock ?? true, memory: () => this.memory,
			raise: () => this.raiseIrq(IRQ_VSOCK),
			onPacket: opts.onVsockPacket, onInit: opts.onVsockInit,
		});
		void this.exited.then(() => this.vsock.close());
		this.exports = undefined;
		this.irqAddr = undefined;
	}

	/** Set a host IRQ bit in wasm_host_irqs (once instantiated) and wake the kernel. */
	raiseIrq(bit: number): void {
		if (!this.result) this.setIrqBits(1 << bit);
		this.wake();
	}

	setIrqBits(bits: number): void {
		if (this.irqAddr === undefined) return;
		const dv = this.dv();
		dv.setUint32(this.irqAddr, dv.getUint32(this.irqAddr, true) | bits, true);
	}

	/** Console output of fd_write 1: mem[p, p + len). No other CPUs, no ring: out at once. */
	consoleWrite(mem: Uint8Array, p: number, len: number): void {
		this.opts.write(mem.slice(p, p + len));
	}

	u8(): Uint8Array {
		return new Uint8Array(this.memory.buffer);
	}

	dv(): DataView {
		return new DataView(this.memory.buffer);
	}

	cstr(ptr: number | bigint, max = 4096): string {
		const u8 = this.u8();
		const p = Number(ptr);
		let end = p;
		while (end < p + max && u8[end] !== 0) end++;
		return textDecoder.decode(u8.slice(p, end));
	}

	fatal(msg: string): void {
		this.log(`[host] fatal: ${msg}`);
		this.exit({ code: 255, reason: msg, kind: "fatal" });
	}

	/** Stop the kernel for good; it parks at its next suspension point. */
	stop(res: Partial<ExitResult> = {}): void {
		this.exit({ code: res.code ?? 0, reason: res.reason ?? "stopped by the host", kind: res.kind ?? "stopped", error: res.error });
		this.wake();
	}

	/** Feed console input (bytes or string). */
	sendInput(data: Uint8Array | string): void {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		if (!bytes.length) return;
		this.input.push(bytes);
		this.setIrqBits(1 << IRQ_CONSOLE);
		this.wake();
	}

	/** Set the console window size (rows << 16 | cols); the guest tty reads it on its next poll. */
	setConsoleSize(cols: number, rows: number): void {
		const size = ((Math.min(rows, 0xffff) << 16) | Math.min(cols, 0xffff)) >>> 0;
		if (!cols || !rows || size === this.consoleSize) return;
		this.consoleSize = size;
		this.setIrqBits(1 << IRQ_CONSOLE);
		this.wake();
	}

	/** With other CPUs an idle wait also ends on an IPI; this fork has one CPU, so nothing to watch. */
	watchIrqWord(_done: () => void, _timeoutMs: number): void {}

	wake(): void {
		const w = this.idleWake;
		this.idleWake = null;
		// Resume the parked stack on a microtask, not inside whatever import or
		// callback raised the IRQ: a JSPI stack must not be resumed from within
		// another stack's execution (the same rule as wasm_switch_to's resume).
		if (w) queueMicrotask(w);
	}

	/**
	 * The imports of the devices this build has no host for. They answer as
	 * the SDK's disabled hosts did; the guest's drivers see no device and
	 * register nothing, so only the init import is ever called.
	 */
	stubImports(): Record<string, unknown> {
		return {
			// kwblk: no disks (/dev/wda would be the first).
			wasm_driver_block_info: (dev: number, _info: bigint): number => -ENODEV,
			wasm_driver_block_submit: (_req: bigint): number => -ENODEV,
			wasm_driver_block_reap: (): bigint => 0n,
			// kwfb (/dev/fb0).
			wasm_driver_fb_init: (): bigint => -BigInt(ENODEV),
			wasm_driver_fb_mode: (): number => 0,
			wasm_driver_fb_attach: (_pixels: bigint, _width: number, _height: number, _stride: number, _format: number): number => 0,
			// kwnet (eth0): no NetStack, so no interface.
			wasm_driver_net_init: (_mac: bigint): bigint => -1n,
			wasm_driver_net_send: (_buf: bigint, len: bigint): bigint => len,
			wasm_driver_net_rx_len: (): bigint => 0n,
			wasm_driver_net_recv: (_buf: bigint, _max: bigint): bigint => 0n,
			// kwinput (evdev).
			wasm_driver_input_init: (): bigint => -BigInt(ENODEV),
			wasm_driver_input_read: (_buf: bigint, _max: bigint): bigint => 0n,
			wasm_driver_input_state: (_mask: number): void => {},
			// kwsnd (ALSA playback).
			wasm_driver_sound_init: (): bigint => -BigInt(ENODEV),
			wasm_driver_sound_event: (_event: number, _rate: number, _channels: number, _format: number): void => {},
			wasm_driver_sound_write: (_buf: bigint, _bytes: bigint): bigint => 0n,
			// kwshm (guest shmem files).
			wasm_driver_shm_init: (_reqSize: number): number => -ENODEV,
			wasm_driver_shm_request: (_buf: bigint, _max: number): number => 0,
			wasm_driver_shm_reply: (_tag: number, _result: number): void => {},
			wasm_driver_shm_detach: (_id: number): void => {},
			wasm_driver_shm_attach: (_id: number, _flags: number, _gen: number, _size: bigint, _pages: bigint, _npages: number): void => {},
		};
	}

	/** kwemu's JIT tier: caps 0 means "no JIT host", so kwemu interprets everything. */
	jitImports(): Record<string, unknown> {
		return {
			kw_host_jit_caps: (): number => 0,
			kw_host_jit_compile: (_ptr: bigint, _len: bigint, _slot: number, _flags: number): number => -1,
			kw_host_jit_free: (_slot: number): void => {},
		};
	}

	imports(): WebAssembly.Imports {
		const k = this;
		const unkernel: Record<string, unknown> = {
			wasm_dump_stacktrace(buf: bigint, max: bigint): void {
				const s = new TextEncoder().encode(new Error().stack ?? "");
				const n = Math.min(s.length, Number(max) - 1);
				k.u8().set(s.subarray(0, n), Number(buf));
				k.u8()[Number(buf) + n] = 0;
			},
			wasm_driver_console_size: (): number => k.consoleSize,
			// Not offered by this fork (no snapshot({ commit })): a kernel that
			// ever asks reaches its consistent point and gets EBUSY.
			wasm_snapshot_point: (_result: number, _blocker: bigint, _freeMap: bigint, _freeBits: bigint): number => -EBUSY,
			// (JSPI) Park prev, run next. Resolves with the task that later
			// switches back to prev.
			wasm_switch_to: new WebAssembly.Suspending((prev: bigint, next: bigint, isNew: unknown, prevDead: unknown) => {
				if (k.result) return never(); // exited or stopped: park for good
				k.stats.switches++;
				const parked = prevDead
					? stackDropped()
					: new Promise<bigint>((r) => k.resumers.set(prev, r));
				if (isNew) {
					dropStack(k.resumers, next);
					queueMicrotask(() => {
						k.retFromFork(prev, next).then(
							() => k.fatal("task returned from ret_from_fork"),
							(e) => k.onTrap(e));
					});
				} else {
					const resume = k.resumers.get(next);
					if (!resume) {
						k.fatal(`switch to unknown task 0x${next.toString(16)}`);
					} else {
						k.resumers.delete(next);
						// Resume on a microtask, not inside this wasm import: V8's
						// stack switching must not run one suspended stack from
						// within another's import (a rare wedge, see README).
						queueMicrotask(() => resume(prev));
					}
				}
				return parked;
			}),
		};

		Object.assign(unkernel, this.stubImports());
		Object.assign(unkernel, this.vsock.imports());
		Object.assign(unkernel, this.jitImports());

		const imports: Record<string, Record<string, unknown>> = {
			env: { memory: this.memory },
			unkernel,
			wasi_snapshot_preview1: this.wasi.imports(),
		};

		// Any other import is a kernel bug (undefined symbol); fail loudly.
		const missing: string[] = [];
		for (const imp of WebAssembly.Module.imports(this.opts.module)) {
			const mod = (imports[imp.module] ??= {});
			if (!(imp.name in mod)) {
				missing.push(`${imp.module}.${imp.name}`);
				mod[imp.name] = () => {
					throw new Error(`unresolved kernel import ${imp.module}.${imp.name} called`);
				};
			}
		}
		if (missing.length) this.log(`[host] warning: unresolved imports: ${missing.join(", ")}`);
		return imports as WebAssembly.Imports;
	}

	onTrap(e: unknown): void {
		if (e === STACK_DROPPED) return; // a dropped stack unwound
		this.log(`[host] wasm trap: ${errorText(e)}`);
		this.exit({ code: 254, reason: String(e), kind: "trap", error: e });
	}

	/** A fixed-size memory of `pages` 64 KiB pages, 64-bit (BigInt sizes) or 32-bit. */
	static newMemory(pages: number, memory64: boolean): WebAssembly.Memory {
		return memory64
			? new WebAssembly.Memory({ initial: BigInt(pages), maximum: BigInt(pages), address: "i64" } as unknown as WebAssembly.MemoryDescriptor)
			: new WebAssembly.Memory({ initial: pages, maximum: pages });
	}

	/**
	 * Allocate the kernel's memory (fixed size: the kernel sizes RAM from it
	 * once at boot). Tries memoryMiB, then each of opts.memoryFallbackMiB.
	 */
	allocateMemory(memoryMiB: number, initrdBytes: number): WebAssembly.Memory {
		const want = [memoryMiB, ...(this.opts.memoryFallbackMiB ?? []).filter((m) => m < memoryMiB)];
		const failures: string[] = [];
		for (const mib of want) {
			const pages = Math.ceil((mib * 1024 * 1024) / 65536);
			try {
				if (!this.memory64 && pages > 65536) throw new RangeError("more than 4 GiB needs the wasm64 (memory64) kernel");
				const memory = Kernel.newMemory(pages, this.memory64);
				if (failures.length) this.log(`[host] allocated ${mib} MiB after failing: ${failures.join("; ")}`);
				this.onStage("memory", { mib, requestedMiB: memoryMiB, failures, memory64: this.memory64 });
				return memory;
			} catch (e) {
				failures.push(`${mib} MiB: ${(e as Error).message}`);
				if (initrdBytes && mib * 1048576 < initrdBytes + 40 * 1048576) break;
			}
		}
		const err = new Error(`cannot allocate the kernel's memory (WebAssembly.Memory, ${this.memory64 ? "memory64" : "32-bit"}): ${failures.join("; ")}`);
		err.name = "MemoryAllocationError";
		throw err;
	}

	/**
	 * Instantiate and boot. Resolves with the ExitResult when the kernel
	 * halts; rejects if it cannot start (memory, instantiation, initrd size).
	 */
	async boot(): Promise<ExitResult> {
		const { module } = this.opts;
		const memoryMiB = this.opts.memoryMiB ?? 2048;
		const bundled = bundledBoot(module);
		const initrd = this.opts.initrd === undefined ? bundled.initrd : this.opts.initrd;
		const cmdline = this.opts.cmdline ?? bundled.cmdline ?? "";
		const memImport = WebAssembly.Module.imports(module).find((i) => i.kind === "memory");
		if (!memImport) throw new Error("vmlinux must import its memory");
		this.memory64 = moduleIsMemory64(module);
		this.memory = this.allocateMemory(memoryMiB, initrd?.length ?? 0);
		// The kernel reads its command line (argv[1]) and initrd (/initrd in
		// the preopened "/") through WASI (arch/wasm/kernel/wasi.c).
		this.wasi = new WasiHost(this, {
			args: cmdline ? ["vmlinux", cmdline] : ["vmlinux"],
			files: initrd?.length ? { initrd } : {},
		});

		this.onStage("instantiate");
		// The JS API does not show whether the memory import is shared, and a
		// guessed memory type may be wrong: retry once with the other type if
		// the engine says that is the mismatch (this fork never shares memory:
		// the kernel is UP and runs on one thread).
		let instance: WebAssembly.Instance | undefined;
		let flippedType = false;
		while (!instance) {
			try {
				instance = await WebAssembly.instantiate(module, this.imports());
			} catch (e) {
				if (!(e instanceof WebAssembly.LinkError)) throw e;
				if (flippedType) throw e;
				flippedType = true;
				const pages = this.memory.buffer.byteLength / 65536;
				const memory64 = !this.memory64;
				this.memory = Kernel.newMemory(pages, memory64);
				this.log(`[host] memory type guess was wrong (${e.message}); using a ${memory64 ? "64" : "32"}-bit memory`);
				this.memory64 = memory64;
			}
		}
		const ex = (this.exports = instance.exports);
		const addr = (name: string) => {
			const g = ex[name];
			if (!(g instanceof WebAssembly.Global)) throw new Error(`missing export ${name}`);
			return Number(g.value);
		};

		this.irqAddr = addr("wasm_host_irqs");
		this.fingerprint = ex.linux_banner instanceof WebAssembly.Global ? this.cstr(addr("linux_banner"), 512).trim() : "";

		// The kernel copies the initrd into memory it allocates (top-down);
		// refuse to boot early if that cannot leave the kernel 32 MiB.
		if (initrd?.length) {
			const memSize = this.memory.buffer.byteLength;
			const start = Math.floor((memSize - initrd.length) / 4096) * 4096;
			const kernelEnd = addr("_end");
			if (start < kernelEnd + 32 * 1024 * 1024)
				throw new Error(`not enough memory for the ${(initrd.length / 1048576).toFixed(1)} MiB initrd ` +
					`(have ${memSize / 1048576} MiB, need at least ${Math.ceil((kernelEnd + 32 * 1048576 + initrd.length) / 1048576) + 1} MiB)`);
		}

		this.retFromFork = WebAssembly.promising(ex.ret_from_fork as (...args: unknown[]) => unknown) as Kernel["retFromFork"];
		const start = WebAssembly.promising(ex._start as () => unknown);
		this.bootTime = performance.now();
		this.onStage("start");
		start().then(() => this.fatal("_start returned"), (e: unknown) => this.onTrap(e));
		return this.exited;
	}
}
