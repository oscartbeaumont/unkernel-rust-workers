// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// createKernel() for a platform, and the handle it returns: console, exit,
// vsock (listen/connect), spawn/exec over kwtty, fetch over HTTP/1.1.
//
// Forked from unkernel's js/core/instance.ts (package version
// 0.2.0-261121-e69adda). Gone with the devices: disks and the distro image,
// the net stack and its backends, mounts (9p), host commands, GL,
// snapshots and the profiler. What replaces them, for a Worker that boots
// one kernel and proxies HTTP:
//
//   - the kernel comes from the platform as a compiled WebAssembly.Module
//     (Workers compile it at build time; createKernelOn never loads bytes)
//   - no boot progress callback and no AbortSignal: a boot either starts or
//     throws, once per isolate
//   - spawn()/connect()/exec() go straight to vsock: there is no mount or
//     command gate to wait behind.

import { Kernel, bundledBoot, type ExitResult, type KernelStats } from "./kernel.ts";
import { ConsoleOutput } from "./output.ts";
import { VsockHost, type VsockStats } from "./vsock.ts";
import {
	attachOn, connectOn, execOn, spawnOn,
	type AttachOptions, type ConnectOptions, type ExecOptions, type ExecResult,
	type GuestSocket, type PipeOptions, type Pty, type PtyOptions, type Subprocess,
} from "./tty.ts";
import { fetchOver, type FetchTrace } from "./http.ts";

/** What the platform supplies: the kernel and its memory defaults. */
export interface Platform {
	/** The bundled kernel module (compiled at build time). */
	defaultKernel: () => WebAssembly.Module;
	/** Default kernel memory, fixed for the run. Default 2048 MiB. */
	defaultMemoryMiB?: () => number;
	/** Smaller sizes to try, in order, if that cannot be allocated. */
	defaultMemoryFallbackMiB?: number[];
}

export interface CreateKernelOptions {
	/** Kernel memory (fixed for the run). Default platform.defaultMemoryMiB(). */
	memoryMiB?: number;
	/** Smaller sizes to try in order if memoryMiB cannot be allocated. */
	memoryFallbackMiB?: number[];
	/**
	 * Accepted for call-site compatibility with the SDK and ignored: this
	 * fork has no kwemu JIT host (Cloudflare Workers disallows compiling
	 * wasm at run time, so kw_host_jit_caps returns 0 and the guest is
	 * interpreted).
	 */
	jit?: boolean;
	/** A vsock device (kwvsock, AF_VSOCK): spawn/exec/connect/fetch need it. Default true. */
	vsock?: boolean;
	/** Console output, from the first byte. */
	onOutput?: (bytes: Uint8Array) => void;
	/** Host diagnostics ("[host] ...", "vsock ..."). Default console.error. */
	log?: (msg: string) => void;
	/** Initial console size (cols x rows). */
	consoleSize?: { cols: number; rows: number };
}

export interface InstanceStats extends KernelStats {
	/** Milliseconds since kernel entry. */
	uptimeMs: number;
	/** Always 1: a Worker has no threads for a second CPU (and this kernel is the UP build). */
	cpus: number;
	/** Always 0: the kernel arrives compiled. */
	compileMs: number;
	vsock?: VsockStats;
}

/** A booted kernel: its console, its exit, and the low-level Kernel. */
export class KernelInstance {
	/** The low-level runtime object (imports, memory, IRQ bits). */
	readonly kernel: Kernel;
	readonly module: WebAssembly.Module;
	/** The command line it booted with. */
	readonly cmdline: string;
	/** Settles when the kernel exits. */
	readonly exited: Promise<ExitResult>;
	#out: ConsoleOutput;
	#input: WritableStream<Uint8Array | string> | undefined;
	#vsock: VsockHost | undefined;

	/** @internal Use createKernel(). */
	constructor(kernel: Kernel, module: WebAssembly.Module, cmdline: string, vsock: VsockHost | undefined) {
		this.kernel = kernel;
		this.module = module;
		this.cmdline = cmdline;
		this.#vsock = vsock;
		this.#out = new ConsoleOutput(() => !!kernel.result);
		this.exited = kernel.exited.then((res) => {
			this.#vsock?.shutdown();
			this.#out.close();
			return res;
		});
	}

	/** @internal Console output from the kernel (KernelConfig.write). */
	emit(bytes: Uint8Array): void {
		this.#out.emit(bytes);
	}

	/** @internal The vsock protocol's host end (the vsock option). */
	attachVsock(host: VsockHost): void {
		this.#vsock = host;
	}

	/** The vsock protocol's host end, or undefined with `vsock: false`. */
	get vsock(): VsockHost | undefined {
		return this.#vsock;
	}

	/**
	 * A program on its own pty, or on pipes (`pty: false`), served by the
	 * guest's kwtty on vsock port 1022 (tty.ts).
	 */
	spawn(file: string | undefined, args: readonly string[] | undefined, opts: PipeOptions): Promise<Subprocess>;
	spawn(file?: string, args?: readonly string[], opts?: PtyOptions): Promise<Pty>;
	spawn(file?: string, args?: readonly string[], opts?: PtyOptions | PipeOptions): Promise<Pty | Subprocess> {
		return spawnOn(this.#vsock, file, args, opts);
	}

	/** Take over a detachable session (tty.ts attachPty()). */
	attach(session: string, opts?: AttachOptions): Promise<Pty> {
		return attachOn(this.#vsock, session, opts);
	}

	exec(file: string, args: readonly string[] | undefined, opts: ExecOptions & { encoding?: "utf8" }): Promise<ExecResult<string>>;
	exec(file: string, args: readonly string[] | undefined, opts: ExecOptions & { encoding: "buffer" }): Promise<ExecResult<Uint8Array>>;
	exec(file: string, args?: readonly string[], opts?: ExecOptions): Promise<ExecResult<string | Uint8Array>> {
		return execOn(this.#vsock, file, args, opts);
	}

	/** A raw byte stream to a TCP server on the guest's loopback. */
	connect(port: number, opts?: ConnectOptions): Promise<GuestSocket> {
		return connectOn(this.#vsock, port, opts);
	}

	/** HTTP/1.1 to a server on the guest's loopback (http.ts fetchOver()). */
	fetch(input: string | URL | Request, init?: RequestInit, trace?: FetchTrace): Promise<Response> {
		return fetchOver((port, o) => this.connect(port, o), input, init, trace);
	}

	/** Console output as a stream: the first access gets everything since boot; closes at exit. */
	get output(): ReadableStream<Uint8Array> {
		return this.#out.stream;
	}

	/** Call `listener` with console output from now on. Returns the unsubscribe function. */
	onOutput(listener: (bytes: Uint8Array) => void): () => void {
		return this.#out.listen(listener);
	}

	/** Type into the console (bytes, or text encoded as UTF-8). */
	write(data: Uint8Array | string): void {
		this.kernel.sendInput(data);
	}

	/** Console input as a stream. */
	get input(): WritableStream<Uint8Array | string> {
		return (this.#input ??= new WritableStream<Uint8Array | string>({
			write: (chunk) => this.write(chunk),
		}));
	}

	/** Set the console window size; the guest's foreground process gets SIGWINCH. */
	resize(cols: number, rows: number): void {
		this.kernel.setConsoleSize(cols, rows);
	}

	/** No persistent disks and no mounts in this fork: nothing to write back. */
	sync(): Promise<boolean> {
		return Promise.resolve(true);
	}

	/** Not supported by this fork (there is no snapshot host side). */
	snapshot(): Promise<never> {
		return Promise.reject(new Error("snapshot: not available in the specialized SDK fork"));
	}

	/** Stop the kernel now (no clean shutdown). Resolves with the exit. */
	stop(res: { code?: number; reason?: string } = {}): Promise<ExitResult> {
		this.kernel.stop(res);
		return this.exited;
	}

	stats(): InstanceStats {
		const k = this.kernel;
		return {
			...k.stats,
			uptimeMs: k.bootTime ? performance.now() - k.bootTime : 0,
			cpus: 1,
			compileMs: 0,
			vsock: this.#vsock ? { ...this.#vsock.stats } : undefined,
		};
	}

	/** Debug: what the kernel and its vsock are doing now (for the wedge diagnosis). */
	debug(): Record<string, unknown> {
		const k = this.kernel;
		let irqs: number | null = null;
		try {
			if (k.irqAddr !== undefined) irqs = new DataView(k.memory.buffer).getUint32(k.irqAddr, true);
		} catch {}
		return {
			result: k.result ?? null,
			idle: k.idleWake !== null,
			irqs,
			stats: { ...k.stats },
			vsockDevice: { queued: k.vsock.queued },
			vsock: this.#vsock?.debug() ?? null,
		};
	}

	/** Memory actually allocated, in MiB. */
	get memoryMiB(): number {
		return this.kernel.memory.buffer.byteLength / 1048576;
	}

	get memory64(): boolean {
		return this.kernel.memory64;
	}

	/** This fork runs the kernel on this thread. */
	readonly transport = "inline" as const;
}

/**
 * createKernel() for a platform: boot the platform's compiled kernel once,
 * with the devices this fork has (console, initrd, vsock).
 */
export async function createKernelOn(platform: Platform, opts: CreateKernelOptions = {}): Promise<KernelInstance> {
	if (typeof WebAssembly !== "object" || typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function")
		throw new Error("This engine has no JSPI (WebAssembly.Suspending / WebAssembly.promising), which the kernel needs");
	const module = platform.defaultKernel();
	const log = opts.log ?? ((m: string) => console.error(m));
	const bundled = bundledBoot(module);
	const initrd = bundled.initrd ?? null;
	const cmdline = bundled.cmdline ?? "";
	const useVsock = opts.vsock ?? true;

	let kernelRef: Kernel | undefined;
	const vsock = useVsock ? new VsockHost({
		send: (pkt) => kernelRef?.vsock.deliver(pkt),
		log,
	}) : undefined;

	let instance: KernelInstance | undefined;
	let started!: () => void;
	const startedP = new Promise<void>((r) => (started = r));
	const kernel = new Kernel({
		module,
		initrd,
		cmdline,
		memoryMiB: opts.memoryMiB ?? platform.defaultMemoryMiB?.() ?? 2048,
		memoryFallbackMiB: opts.memoryFallbackMiB ?? platform.defaultMemoryFallbackMiB,
		vsock: useVsock,
		onVsockPacket: vsock && ((pkt) => vsock.receive(pkt)),
		onVsockInit: vsock && ((cid, rxMax) => vsock.deviceReady(cid, rxMax)),
		log: opts.log,
		write: (bytes) => {
			opts.onOutput?.(bytes);
			instance?.emit(bytes);
		},
		onStage: (stage) => {
			if (stage === "start") started();
		},
	});
	kernelRef = kernel;
	instance = new KernelInstance(kernel, module, cmdline, vsock);
	if (opts.consoleSize) kernel.setConsoleSize(opts.consoleSize.cols, opts.consoleSize.rows);

	const booting = kernel.boot();
	try {
		await Promise.race([startedP, booting]);
	} catch (e) {
		const err = e as Error;
		instance.stop({ code: 1, reason: err.message });
		throw err;
	}
	booting.catch(() => {}); // it settles with the exit; callers use `exited`
	return instance;
}
