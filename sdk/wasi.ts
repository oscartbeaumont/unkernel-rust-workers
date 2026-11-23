// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The WASI preview 1 subset the kernel imports (module
// "wasi_snapshot_preview1"; kernel side: arch/wasm/kernel/wasi.c).
//
//   clock_time_get, random_get     clocks, boot entropy
//   fd_write(1|2), fd_read(0)      console out, panic text, console in
//   poll_oneoff                    idle (stdin + a clock); zero-timeout polls
//   sched_yield                    let the event loop run while user code is busy
//   proc_exit                      halt (0 power off, 1 halt, 2 restart), 253 panic
//   args_sizes_get, args_get       command line: ["vmlinux", cmdline]
//   fd_prestat_*, path_open,       a read-only preopened "/" holding the
//   fd_filestat_get, fd_read,      initramfs as "initrd"
//   fd_close
//
// poll_oneoff, sched_yield and proc_exit are JSPI Suspending imports: they
// suspend the kernel only when they return a promise (a poll with nothing
// ready, a yield, an exit), and return synchronously otherwise. The ABI is
// wasm32: pointer and size arguments are numbers, timestamps and rights are
// BigInts.
//
// Once the kernel has exited (Kernel.result is set, e.g. by Kernel.stop()),
// the suspending imports park it for good instead of letting it run on.

import type { Kernel } from "./kernel.ts";

export const ERRNO = {
	SUCCESS: 0,
	AGAIN: 6,
	BADF: 8,
	INVAL: 28,
	NOENT: 44,
	NOTDIR: 54,
	NOTSUP: 58,
	ROFS: 69,
} as const;

const CLOCK_REALTIME = 0; // 1 monotonic, 2 process and 3 thread CPU time: all monotonic here
const CLOCK_THREAD_CPUTIME = 3;

const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTTYPE_FD_WRITE = 2;
const SUBCLOCK_ABSTIME = 1;

const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;

const OFLAGS_CREAT = 1;
const OFLAGS_DIRECTORY = 2;
const OFLAGS_TRUNC = 8;

export const EXIT_PANIC = 253;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A promise that never settles: parks a JSPI-suspended kernel stack for good.
 * A fresh one each time, so nothing keeps the parked stack (and with it the
 * kernel's memory) reachable once the host drops the Kernel.
 */
export function never(): Promise<never> {
	return new Promise(() => {});
}

/** What a dropped stack's suspended import throws (dropStack, stackDropped). */
export const STACK_DROPPED: unique symbol = Symbol("unkernel stack dropped");

/**
 * A rejected promise for a JSPI-suspended kernel stack that never runs
 * again (its task exited, or started on a fresh stack): the import throws
 * STACK_DROPPED there, which unwinds the stack without running kernel code
 * and frees it at once. Parked for good (never()) it is freed only by a
 * garbage collection, and Firefox allows a thread about 2000 stacks (2 GiB
 * at 1 MiB each): "too many continuation stacks".
 */
export function stackDropped(): Promise<never> {
	return Promise.reject(STACK_DROPPED);
}

/** Unwind the parked stack of `task`, if `resumers` has one (stackDropped). */
export function dropStack(resumers: Map<bigint, (task: bigint) => void>, task: bigint): void {
	const resume = resumers.get(task);
	if (!resume) return;
	resumers.delete(task);
	(resume as (v: unknown) => void)(stackDropped());
}

export function nowNs(): bigint {
	return BigInt(Math.round(performance.now() * 1e6));
}

function realtimeNs(): bigint {
	return BigInt(Date.now()) * 1000000n;
}


export function yieldToEventLoop(): Promise<void> {
	const immediate = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
	if (typeof immediate === "function") return new Promise((r) => { immediate(r); });
	return new Promise((r) => {
		const ch = new MessageChannel();
		ch.port1.onmessage = () => {
			ch.port1.close();
			r();
		};
		ch.port2.postMessage(0);
	});
}

type Fd =
	| { type: "stdin" | "stdout" | "stderr" }
	| { type: "dir"; name: Uint8Array; files: Map<string, Uint8Array> }
	| { type: "file"; data: Uint8Array; pos: number };

interface Subscription {
	userdata: bigint;
	tag: number;
	clock?: number;
	deadline?: bigint;
	fd?: number;
}

interface PollEvent {
	userdata: bigint;
	type: number;
	error: number;
	nbytes: bigint;
}

export interface WasiHostOptions {
	/** Program arguments (argv[0] first). */
	args: string[];
	/** Read-only files of the preopened "/". */
	files?: Record<string, Uint8Array>;
}

export class WasiHost {
	k: Kernel;
	args: Uint8Array[];
	/** The last 4 KiB written to stderr (the panic message). */
	stderr: string;
	fds: Map<number, Fd>;
	buf: ArrayBuffer | null;
	dvCache: DataView | null;
	u8Cache: Uint8Array<ArrayBuffer> | null;
	/**
	 * Added to performance.now() for the guest's monotonic clock (ms): a
	 * restored snapshot continues from the value it was saved at.
	 */
	monoOffset = 0;

	/**
	 * @param k  console input/output, idle wake-ups, exit
	 */
	constructor(k: Kernel, { args, files = {} }: WasiHostOptions) {
		this.k = k;
		this.args = args.map((a) => encoder.encode(`${a}\0`));
		this.stderr = "";
		this.fds = new Map<number, Fd>([
			[0, { type: "stdin" }],
			[1, { type: "stdout" }],
			[2, { type: "stderr" }],
			[3, { type: "dir", name: encoder.encode("/"), files: new Map(Object.entries(files)) }],
		]);
		this.buf = null;
		this.dvCache = null;
		this.u8Cache = null;
	}

	/** The guest's monotonic clock (ms). */
	monotonicMs(): number {
		return performance.now() + this.monoOffset;
	}

	clockNs(id: number): bigint {
		return id === CLOCK_REALTIME ? realtimeNs() : BigInt(Math.round(this.monotonicMs() * 1e6));
	}

	/** Views of the kernel's memory, rebuilt only if it grew (the old buffer is then detached). */
	views(): void {
		if (!this.buf || this.buf.byteLength === 0) {
			this.buf = this.k.memory.buffer as ArrayBuffer;
			this.dvCache = new DataView(this.buf);
			this.u8Cache = new Uint8Array(this.buf);
		}
	}

	dv(): DataView {
		this.views();
		return this.dvCache!;
	}

	u8(): Uint8Array<ArrayBuffer> {
		this.views();
		return this.u8Cache!;
	}

	/** [ptr, len] pairs of an iovec array. */
	iovecs(iovs: number, n: number): Array<[number, number]> {
		const dv = this.dv();
		const out: Array<[number, number]> = [];
		for (let i = 0; i < n; i++) out.push([dv.getUint32(iovs + 8 * i, true), dv.getUint32(iovs + 8 * i + 4, true)]);
		return out;
	}

	/** Bytes of console input queued in the kernel object. */
	stdinQueued(): number {
		const k = this.k;
		let n = -k.inputOffset;
		for (const c of k.input) n += c.length;
		return n;
	}

	readStdin(dst: number, want: number): number {
		const k = this.k;
		const u8 = this.u8();
		let n = 0;
		while (n < want && k.input.length) {
			const head = k.input[0]!;
			const take = Math.min(want - n, head.length - k.inputOffset);
			u8.set(head.subarray(k.inputOffset, k.inputOffset + take), dst + n);
			n += take;
			k.inputOffset += take;
			if (k.inputOffset >= head.length) {
				k.input.shift();
				k.inputOffset = 0;
			}
		}
		return n;
	}

	/** The poll_oneoff subscriptions at `inp`. */
	subscriptions(inp: number, n: number): Subscription[] {
		const dv = this.dv();
		const subs: Subscription[] = [];
		for (let i = 0; i < n; i++) {
			const b = inp + 48 * i;
			const sub: Subscription = { userdata: dv.getBigUint64(b, true), tag: dv.getUint8(b + 8) };
			if (sub.tag === EVENTTYPE_CLOCK) {
				sub.clock = dv.getUint32(b + 16, true);
				const timeout = dv.getBigUint64(b + 24, true);
				const abs = dv.getUint16(b + 40, true) & SUBCLOCK_ABSTIME;
				sub.deadline = abs ? timeout : this.clockNs(sub.clock) + timeout;
			} else {
				sub.fd = dv.getUint32(b + 16, true);
			}
			subs.push(sub);
		}
		return subs;
	}

	/** Events for the subscriptions that are ready now. */
	ready(subs: Subscription[]): PollEvent[] {
		const events: PollEvent[] = [];
		for (const s of subs) {
			const ev: PollEvent = { userdata: s.userdata, type: s.tag, error: 0, nbytes: 0n };
			if (s.tag === EVENTTYPE_CLOCK) {
				if (this.clockNs(s.clock!) >= s.deadline!) events.push(ev);
				continue;
			}
			const f = this.fds.get(s.fd!);
			if (!f || f.type === "dir") {
				ev.error = ERRNO.BADF;
			} else if (s.tag === EVENTTYPE_FD_READ) {
				if (f.type === "stdin") {
					const q = this.stdinQueued();
					if (!q) continue;
					ev.nbytes = BigInt(q);
				} else if (f.type === "file") {
					ev.nbytes = BigInt(f.data.length - f.pos);
				} else {
					ev.error = ERRNO.BADF;
				}
			} else if (s.tag !== EVENTTYPE_FD_WRITE || f.type === "stdin") {
				ev.error = ERRNO.BADF;
			}
			events.push(ev);
		}
		return events;
	}

	writeEvents(out: number, nevents: number, events: PollEvent[]): void {
		const dv = this.dv();
		events.forEach((ev, i) => {
			const b = out + 32 * i;
			for (let j = 0; j < 32; j += 8) dv.setBigUint64(b + j, 0n, true);
			dv.setBigUint64(b, ev.userdata, true);
			dv.setUint16(b + 8, ev.error, true);
			dv.setUint8(b + 10, ev.type);
			dv.setBigUint64(b + 16, ev.nbytes, true);
		});
		dv.setUint32(nevents, events.length, true);
	}

	exit(code: number): void {
		const k = this.k;
		if (code === EXIT_PANIC) {
			const msg = this.stderr.trim();
			k.log(`[host] kernel panic: ${msg}`);
			k.exit({ code, reason: `panic: ${msg}`, kind: "panic" });
		} else {
			k.exit({ code, reason: "halt", kind: "halt" });
		}
	}

	imports(): Record<string, unknown> {
		const w = this;
		const k = this.k;
		return {
			args_sizes_get(argc: number, size: number): number {
				const dv = w.dv();
				dv.setUint32(argc, w.args.length, true);
				dv.setUint32(size, w.args.reduce((n, a) => n + a.length, 0), true);
				return ERRNO.SUCCESS;
			},
			args_get(argv: number, buf: number): number {
				const dv = w.dv();
				const u8 = w.u8();
				w.args.forEach((a, i) => {
					dv.setUint32(argv + 4 * i, buf, true);
					u8.set(a, buf);
					buf += a.length;
				});
				return ERRNO.SUCCESS;
			},

			// Hot: the kernel's clocksource (every guest clock_gettime, no vDSO).
			// The monotonic value is written as two u32 halves, without a
			// BigInt (exact below 2^53 ns, 104 days of uptime). Process and
			// thread CPU time are monotonic: the kernel is the only thread.
			clock_time_get(id: number, _precision: bigint, time: number): number {
				const dv = w.dv();
				if (id === CLOCK_REALTIME) {
					dv.setBigUint64(time, realtimeNs(), true);
					return ERRNO.SUCCESS;
				}
				if (id > CLOCK_THREAD_CPUTIME) return ERRNO.INVAL;
				// Worker mode's shared transport looks for input and frame requests here.
				const p = k.poller;
				if (p !== null) p.poll();
				const ns = Math.round((performance.now() + w.monoOffset) * 1e6);
				dv.setUint32(time, ns >>> 0, true);
				dv.setUint32(time + 4, Math.floor(ns / 4294967296), true);
				return ERRNO.SUCCESS;
			},
			random_get(buf: number, len: number): number {
				const u8 = w.u8();
				// Through a copy: getRandomValues refuses a shared memory's view in browsers.
				for (let off = 0; off < len; off += 65536) {
					const n = Math.min(len - off, 65536);
					u8.set(crypto.getRandomValues(new Uint8Array(n)), buf + off);
				}
				return ERRNO.SUCCESS;
			},

			fd_write(fd: number, iovs: number, n: number, nwritten: number): number {
				const f = w.fds.get(fd);
				if (!f || (f.type !== "stdout" && f.type !== "stderr")) return ERRNO.BADF;
				const u8 = w.u8();
				let total = 0;
				for (const [p, len] of w.iovecs(iovs, n)) {
					if (!len) continue;
					if (f.type === "stdout") k.consoleWrite(u8, p, len);
					else w.stderr = (w.stderr + decoder.decode(u8.slice(p, p + len))).slice(-4096);
					total += len;
				}
				w.dv().setUint32(nwritten, total, true);
				return ERRNO.SUCCESS;
			},
			fd_read(fd: number, iovs: number, n: number, nread: number): number {
				const f = w.fds.get(fd);
				if (!f) return ERRNO.BADF;
				let total = 0;
				if (f.type === "stdin") {
					for (const [p, len] of w.iovecs(iovs, n)) {
						const got = w.readStdin(p, len);
						total += got;
						if (got < len) break;
					}
					if (!total && n) return ERRNO.AGAIN;
				} else if (f.type === "file") {
					const u8 = w.u8();
					for (const [p, len] of w.iovecs(iovs, n)) {
						const take = Math.min(len, f.data.length - f.pos);
						u8.set(f.data.subarray(f.pos, f.pos + take), p);
						f.pos += take;
						total += take;
						if (take < len) break;
					}
				} else {
					return ERRNO.BADF;
				}
				w.dv().setUint32(nread, total, true);
				return ERRNO.SUCCESS;
			},
			fd_close(fd: number): number {
				const f = w.fds.get(fd);
				if (!f || f.type !== "file") return ERRNO.BADF;
				w.fds.delete(fd);
				return ERRNO.SUCCESS;
			},
			fd_filestat_get(fd: number, buf: number): number {
				const f = w.fds.get(fd);
				if (!f) return ERRNO.BADF;
				const dv = w.dv();
				for (let j = 0; j < 64; j += 8) dv.setBigUint64(buf + j, 0n, true);
				dv.setUint8(buf + 16, f.type === "file" ? FILETYPE_REGULAR_FILE : f.type === "dir" ? FILETYPE_DIRECTORY : FILETYPE_CHARACTER_DEVICE);
				dv.setBigUint64(buf + 24, 1n, true);
				if (f.type === "file") dv.setBigUint64(buf + 32, BigInt(f.data.length), true);
				return ERRNO.SUCCESS;
			},
			fd_prestat_get(fd: number, buf: number): number {
				const f = w.fds.get(fd);
				if (!f || f.type !== "dir") return ERRNO.BADF;
				const dv = w.dv();
				dv.setUint32(buf, 0, true); // tag 0: directory
				dv.setUint32(buf + 4, f.name.length, true);
				return ERRNO.SUCCESS;
			},
			fd_prestat_dir_name(fd: number, path: number, len: number): number {
				const f = w.fds.get(fd);
				if (!f || f.type !== "dir") return ERRNO.BADF;
				w.u8().set(f.name.subarray(0, len), path);
				return ERRNO.SUCCESS;
			},
			path_open(dirfd: number, _dirflags: number, path: number, pathLen: number, oflags: number,
				_rightsBase: bigint, _rightsInheriting: bigint, _fdflags: number, opened: number): number {
				const d = w.fds.get(dirfd);
				if (!d) return ERRNO.BADF;
				if (d.type !== "dir") return ERRNO.NOTDIR;
				if (oflags & (OFLAGS_CREAT | OFLAGS_TRUNC)) return ERRNO.ROFS;
				const name = decoder.decode(w.u8().slice(path, path + pathLen)).replace(/^(\.?\/)+/, "");
				const data = d.files.get(name);
				if (!data) return ERRNO.NOENT;
				if (oflags & OFLAGS_DIRECTORY) return ERRNO.NOTDIR;
				let fd = 4;
				while (w.fds.has(fd)) fd++;
				w.fds.set(fd, { type: "file", data, pos: 0 });
				w.dv().setUint32(opened, fd, true);
				return ERRNO.SUCCESS;
			},

			// (JSPI) Suspends only when nothing is ready yet. Any host event
			// (console input, a network frame, a block completion: Kernel.wake)
			// ends the wait early, possibly with no event at all.
			poll_oneoff: new WebAssembly.Suspending((inp: number, out: number, nsubs: number, nevents: number) => {
				if (k.result) return never();
				if (!nsubs) return ERRNO.INVAL;
				const subs = w.subscriptions(inp, nsubs);
				const now = w.ready(subs);
				if (now.length) {
					w.writeEvents(out, nevents, now);
					return ERRNO.SUCCESS;
				}
				// Events that arrived through a poller: handled, so do not wait (maybe no event at all, as after a wake).
				if (k.poller?.idle()) {
					w.writeEvents(out, nevents, w.ready(subs));
					return ERRNO.SUCCESS;
				}
				k.stats.idles++;
				let wait = Infinity;
				for (const s of subs)
					if (s.tag === EVENTTYPE_CLOCK) wait = Math.min(wait, Number(s.deadline! - w.clockNs(s.clock!)) / 1e6);
				return new Promise<number>((resolve) => {
					let timer: ReturnType<typeof setTimeout> | null = null;
					let settled = false;
					const done = () => {
						if (settled) return;
						settled = true;
						if (timer !== null) clearTimeout(timer);
						k.idleWake = null;
						k.poller?.awake();
						if (k.result) return; // stopped while idle: stay parked
						w.writeEvents(out, nevents, w.ready(subs));
						resolve(ERRNO.SUCCESS);
					};
					k.idleWake = done;
					if (wait !== Infinity) timer = setTimeout(done, Math.max(0, wait));
					// SMP: an IPI from another CPU (a change of wasm_host_irqs).
					k.watchIrqWord(done, wait === Infinity ? 60000 : Math.max(0, wait));
				});
			}),
			// (JSPI) Let the event loop run while user code is busy.
			sched_yield: new WebAssembly.Suspending(() => {
				if (k.result) return never();
				k.stats.yields++;
				return yieldToEventLoop().then(() => (k.result ? never() : ERRNO.SUCCESS));
			}),
			// (JSPI) Parks the kernel forever: nothing may run after it.
			proc_exit: new WebAssembly.Suspending((code: number) => {
				w.exit(code);
				return never();
			}),
		};
	}
}
