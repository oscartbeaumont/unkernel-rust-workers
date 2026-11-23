// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwtty: programs in the guest, over vsock, each on its own pty or on
// pipes. The host client of the guest's `kwtty serve` (guest/src/kwtty.c,
// started by inittab), which gives each connection a user's login shell, or
// a program, on a pty of its own, or with PIPES on stdin, stdout and stderr
// pipes. On a pty the API follows zigpty / node-pty: spawn(file, args,
// options) gives a Pty. With `pty: false` it gives a Subprocess (web
// streams for stdin, stdout and stderr), and exec() collects its output.
// With CONNECT, connectGuest() gives a raw byte stream to a TCP port on the
// guest's loopback (GuestSocket).
//
// Wire format (both directions; integers little-endian):
//
//   u8 type, u8 flags (bit 0 CRITICAL), u16 length, payload[length]
//
// A receiver skips a frame type it does not know, unless CRITICAL is set:
// then it is a protocol error. Host -> guest: OPEN (1: u16 max_version,
// u16 rows, cols, xpixel, ypixel, then TLV options u8 tag (bit 7
// critical), u16 length, value: TERM 1, ENV 2 "KEY=VALUE", ARG 3 (one per
// argument, the program first; none: a login shell), CWD 4, PIPES 5 (empty:
// pipes instead of a pty), CONNECT 6 (u16 TCP port: the guest connects to
// 127.0.0.1:port before OPENED; other options are ignored), USER 7 (the
// user to run as: a name or a decimal uid, empty for the guest's default
// user; without it the guest runs root's session, as before USER); the host
// marks ARG, CWD, PIPES, CONNECT and a USER other than "", "root" and "0"
// critical, and always sends USER (empty unless `user` is given), so an old
// guest, whose sessions are root's, refuses only a request for another
// user), DETACH 8 (u32 timeout in ms, 0 for the guest's 60 s, then the
// session id; not critical: a guest without it opens a session that is not
// detachable, and OPENED lacks feature bit 3), ATTACH 9 (critical: a
// session id; reattach to that detachable session, with the size of the
// OPEN), REPLAY 10 (with ATTACH: the guest sends the session's recent
// output first), DATA
// (2: at most 4096 bytes from the host, for the pty or stdin; zero length is
// a no-op), RESIZE (3: u16 rows, cols, xpixel, ypixel), SIGNAL (6, critical:
// a signal name without "SIG", for the program), EOF (7: with PIPES, close
// the program's stdin). Guest -> host: OPENED (1: u16 version, u32 features
// (bit 0: PIPES, EOF and STDERR; bit 1: CONNECT; bit 2: USER; bit 3: DETACH,
// ATTACH and REPLAY), u32 pid (0 with CONNECT),
// u32 pts (0xffffffff with PIPES or CONNECT)), DATA (2: the pty, or
// stdout), EXIT (4: u8 how (0 exited, 1 signal), u8 code, u8 core_dumped),
// ERROR (5: a UTF-8 message, then the guest closes), STDERR (8: with
// PIPES). OPEN is the host's first frame and comes once. The guest closes
// right after EXIT; EOF without EXIT means the session was lost.
//
// CONNECT: a failed connect is an ERROR whose message starts with the errno
// name and ": " ("ECONNREFUSED: connect to 127.0.0.1:80: ..."). After
// OPENED no more frames go either way: the vsock connection is a raw byte
// stream to the TCP socket, and the guest passes EOF on as shutdown(SHUT_WR)
// on the other side, both ways (half-close); it ends once both directions
// are done, or at the first error or reset on either side.
//
// Detachable sessions (DETACH): a reset of the connection under the
// session (what a snapshot restore does to every vsock connection the new
// host does not keep) detaches it instead of hanging it up, and an ATTACH
// within its timeout takes it over again: same program, pid and pty. The
// host's own close still hangs it up. An unknown or ended session is an
// ERROR "ENOENT: ...", a guest from before ATTACH refuses the critical
// option ("unknown critical OPEN option"); both are PtyError ENOENT here.
// REPLAY: the last 64 KiB of output, cut where a fresh terminal can start,
// behind the terminal modes in force there; a full-screen program (the
// alternate screen) then gets SIGWINCH twice (one row short, then the
// size) so that it redraws. kwtty.c has the details.
//
// The protocol code only uses the Vsock interface, so it works the same
// inline and in worker mode, and test/tty.test.ts runs it against a fake
// connect() that returns a pair of web streams.

import type { Vsock, VsockConnection } from "./vsock.ts";

/** The guest server's vsock port (guest/src/kwtty.c KWTTY_PORT). Privileged, so no unprivileged guest program can take it. */
export const TTY_PORT = 1022;
/** The protocol version this client speaks (OPEN's max_version). */
export const TTY_VERSION = 1;
/** The most the host puts in one DATA frame. */
export const TTY_MAX_WRITE = 4096;
/** Frame header: type, flags, u16 length. */
export const TTY_HEADER_SIZE = 4;
export const TTY_MAX_PAYLOAD = 0xffff;
/** Frame flag: a receiver that does not know the type must fail the session. */
export const TTY_FLAG_CRITICAL = 1;
/** Option tag bit: a receiver that does not know the tag must fail the session. */
export const TTY_OPT_CRITICAL = 0x80;

// Host -> guest frame types.
export const TTY_OPEN = 1;
export const TTY_DATA = 2;
export const TTY_RESIZE = 3;
export const TTY_SIGNAL = 6;
export const TTY_EOF = 7;
// Guest -> host frame types (DATA is 2 both ways).
export const TTY_OPENED = 1;
export const TTY_EXIT = 4;
export const TTY_ERROR = 5;
export const TTY_STDERR = 8;
// OPEN option tags.
export const TTY_OPT_TERM = 1;
export const TTY_OPT_ENV = 2;
export const TTY_OPT_ARG = 3;
export const TTY_OPT_CWD = 4;
export const TTY_OPT_PIPES = 5;
export const TTY_OPT_CONNECT = 6;
export const TTY_OPT_USER = 7;
export const TTY_OPT_DETACH = 8;
export const TTY_OPT_ATTACH = 9;
export const TTY_OPT_REPLAY = 10;
/** OPENED feature bit: the guest has PIPES, EOF and STDERR. */
export const TTY_FEATURE_PIPES = 1;
/** OPENED feature bit: the guest has CONNECT (connectGuest()). */
export const TTY_FEATURE_CONNECT = 2;
/** OPENED feature bit: the guest has USER (SpawnOptions.user). */
export const TTY_FEATURE_USER = 4;
/** OPENED feature bit: the guest has DETACH, ATTACH and REPLAY (PtyOptions.detachable, attachPty()). */
export const TTY_FEATURE_DETACH = 8;
/** How long a detached session waits for an attach unless PtyOptions.detachTimeout says otherwise (kwtty.c DETACH_MS). */
export const TTY_DETACH_TIMEOUT = 60000;

/** The signals kill() can send (kwtty.c has the same list). */
export const TTY_SIGNALS = ["HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM",
	"CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS"] as const;

const DEFAULT_TERM = "xterm-256color";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 64 << 20;
/** How often to try again while the guest server is not listening yet. */
/**
 * How often connectRetry() retries a refused kwtty connection. Upstream uses
 * 100 ms; the Worker usually asks for the first spawn while the guest is still
 * booting, and a 100 ms poll threw away most of the wait (cold boot 160 ms ->
 * ~85 ms with 5 ms). Only the polling interval changes: the deadline is the
 * same, and every attempt is a refused connect.
 */
const RETRY_MS = 5;
const OPENED_SIZE = 14;
const EMPTY = new Uint8Array(0);

export type PtyErrorCode =
	/** No guest server answered within the timeout (or no OPENED came). */
	| "ETIMEDOUT"
	/** A malformed frame, an unknown critical frame, or a version the client does not speak. */
	| "EPROTO"
	/** The guest sent ERROR; the message is the guest's (a failed exec or chdir; a guest without PIPES refuses `pty: false`, one without CONNECT refuses connectGuest()). */
	| "EREMOTE"
	/** connectGuest(): nothing listens on that TCP port on the guest's 127.0.0.1. */
	| "ECONNREFUSED"
	/** The signal was aborted while opening (or, for exec(), while the program ran: it is killed). */
	| "ABORTED"
	/** The connection ended before OPENED (or, for exec(), before EXIT). */
	| "ECONNRESET"
	/** The kernel exited. */
	| "ECONNABORTED"
	/** write() after the session ended, or the connection failed under it. */
	| "EPIPE"
	/** spawn(), exec() or connect() on an instance created with `vsock: false`. */
	| "ENODEV"
	/** attach(): no such detachable session (an unknown id, one that ended or was hung up after its timeout), or a guest whose kwtty cannot reattach (older than ATTACH). */
	| "ENOENT"
	/** exec(): stdout or stderr went over `maxBuffer` (the program is killed). */
	| "ENOBUFS";

/** Why a pty could not be spawned, or failed. */
export class PtyError extends Error {
	readonly code: PtyErrorCode;
	constructor(code: PtyErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PtyError";
		this.code = code;
	}
}

/** A window size; pixels are 0 when unknown. */
export interface PtySize {
	cols: number;
	rows: number;
	xpixel?: number;
	ypixel?: number;
}

/** What spawn() on a pty, spawn() on pipes and exec() take. */
export interface SpawnOptions {
	/** The program's working directory. Default the user's home. */
	cwd?: string;
	/**
	 * The guest user to run as: a name, or a uid. Default the guest's default
	 * user: `user` (uid 1000) on the distro images, root on the base shell.
	 * "root" or 0 for root. The program gets that user's groups, HOME, USER,
	 * LOGNAME, SHELL and PATH. A user the guest does not have is a PtyError
	 * EREMOTE ("no user NAME"), and so is a user other than root on a guest
	 * from before this option (its sessions are root's).
	 */
	user?: string | number;
	/** Extra environment, applied after the defaults (HOME, USER, LOGNAME, SHELL, PATH, and TERM on a pty), so it may override them. */
	env?: Record<string, string>;
	/** The guest server's port. Default TTY_PORT (1022). */
	port?: number;
	/** How long to wait for the guest server, in ms: connect retries (it may not be up yet) and the handshake together. Default 30000. */
	timeout?: number;
	/** Aborts spawning (PtyError ABORTED). It has no effect once the program runs, except in exec(). */
	signal?: AbortSignal;
}

export interface PtyOptions extends SpawnOptions, Partial<PtySize> {
	/** On a pty (the default). */
	pty?: true;
	/** Default 80 columns by 24 rows. */
	cols?: number;
	rows?: number;
	/** TERM for the program (printable ASCII, at most 64 bytes). Default "xterm-256color". */
	term?: string;
	/**
	 * A session that survives a snapshot restore (kwtty's DETACH): when the
	 * connection is reset under it (a restored kernel resets every vsock
	 * connection), the guest keeps the program and its pty, detached, for
	 * `detachTimeout`, and attach() with `Pty.sessionId` takes it over in the
	 * restored machine. close() and kill() still end it. A guest without
	 * the feature opens an ordinary session (`sessionId` undefined).
	 */
	detachable?: boolean;
	/** How long a detached session waits for attach() before it is hung up, in ms of the guest's monotonic time (which a restore continues). Default TTY_DETACH_TIMEOUT (60 s). */
	detachTimeout?: number;
}

/** A detachable session as a snapshot records it (KernelSnapshot.ttys): what attach() needs. */
export interface TtySessionSnapshot {
	/** Pty.sessionId. */
	id: string;
	pid: number;
	pts: number;
	/** The size last set. */
	cols: number;
	rows: number;
}

/** What attach() takes. */
export interface AttachOptions extends Partial<PtySize> {
	/** The window size now (default the saved size, else 80 by 24); the program gets SIGWINCH if it differs from the pty's. */
	cols?: number;
	rows?: number;
	/** Send the session's recent output first (the last 64 KiB, for a fresh terminal). Default true. */
	replay?: boolean;
	/** The guest server's port. Default TTY_PORT (1022). */
	port?: number;
	/** How long to wait for the guest server, in ms (connect retries and the handshake). Default 30000. */
	timeout?: number;
	/** Aborts attaching (PtyError ABORTED). */
	signal?: AbortSignal;
}

/** spawn() on pipes: stdin, stdout and stderr are pipes, with no pty (and no TERM unless `env` sets it). */
export interface PipeOptions extends SpawnOptions {
	pty: false;
}

export interface ExecOptions extends SpawnOptions {
	/** Bytes for stdin (strings are UTF-8), then EOF. Default: EOF at once. */
	input?: Uint8Array | string;
	/** "utf8" (the default): stdout and stderr as strings; "buffer": as bytes. */
	encoding?: "utf8" | "buffer";
	/** The most bytes stdout and stderr may hold, each; beyond it the program gets SIGKILL and exec() rejects with ENOBUFS. Default 64 MiB. */
	maxBuffer?: number;
	/** Also aborts the run: the program gets SIGKILL and exec() rejects with ABORTED. */
	signal?: AbortSignal;
}

/** How exec()'s program ended, and what it printed. */
export interface ExecResult<T extends string | Uint8Array = string> {
	stdout: T;
	stderr: T;
	/** The exit status, or null when a signal ended the program. */
	exitCode: number | null;
	/** The signal's number in the guest, or null when the program exited. */
	signal: number | null;
}

export type PtyEnd =
	/** The program exited with `code`. */
	| { type: "exit"; code: number }
	/** The program was killed by `signal` (its number in the guest). */
	| { type: "signal"; signal: number; coreDumped: boolean }
	/** The host called close(). */
	| { type: "closed" }
	/** EOF or a reset without EXIT, or the kernel exited (a detachable session lives on in a snapshot taken then), or another attach() took the session over. */
	| { type: "lost" };

export interface Pty extends AsyncDisposable {
	/** The program's pid in the guest. */
	readonly pid: number;
	/** The pty's number: the program's terminal is /dev/pts/<pts>. */
	readonly pts: number;
	/** The size last set (spawn options, then resize()). */
	readonly cols: number;
	readonly rows: number;
	/** The exit status once `ended` settled with an exit, else null. */
	readonly exitCode: number | null;
	/** The protocol version both sides agreed on. */
	readonly version: number;
	/** The guest's feature bits (TTY_FEATURE_PIPES). */
	readonly features: number;
	/**
	 * The id attach() takes after a snapshot restore: set for a session
	 * spawned with `detachable` on a guest that has the feature, and for
	 * one attach() gave, else undefined. After a snapshot with `stop` this
	 * Pty ends "lost" with the kernel, while the session lives on in the
	 * snapshot.
	 */
	readonly sessionId: string | undefined;
	/**
	 * What the pty prints. A pull stream: vsock credit follows what is read,
	 * so keep reading, or the guest program blocks once the window is full.
	 * It ends after EXIT, close() or a lost connection, and errors with the
	 * PtyError that `ended` rejects with. Cancelling it discards the
	 * rest, so `ended` still settles.
	 */
	readonly output: ReadableStream<Uint8Array>;
	/** Type into the pty. Strings are UTF-8. Split into DATA frames of at most 4096 bytes; resolves once they are sent. */
	write(data: Uint8Array | string): Promise<void>;
	/** Set the window size (the foreground process gets SIGWINCH). Ordered with write(). */
	resize(cols: number, rows: number, xpixel?: number, ypixel?: number): void;
	/**
	 * Send a signal to the program ("SIGTERM" or "TERM"; default SIGHUP).
	 * `ended` then reports how it ended. Ordered with write(); a no-op once
	 * the pty has ended. Throws a RangeError for an unknown name.
	 */
	kill(signal?: string): void;
	/** Hang up (the session gets SIGHUP): closes the connection both ways. Resolves once the connection is gone. */
	close(): Promise<void>;
	/**
	 * How the session ended. Settles once `output` has been read up to the
	 * end (EXIT comes behind the shell's last output), or at close().
	 * Rejects with a PtyError (EREMOTE, EPROTO) if the session failed.
	 */
	readonly ended: Promise<PtyEnd>;
	/** `await using`: close(). */
	[Symbol.asyncDispose](): Promise<void>;
}

/** A program on pipes: spawn(file, args, { pty: false }). */
export interface Subprocess extends AsyncDisposable {
	/** The program's pid in the guest, the leader of its own session. */
	readonly pid: number;
	/** The exit status once `ended` settled with an exit, else null. */
	readonly exitCode: number | null;
	/** The protocol version both sides agreed on. */
	readonly version: number;
	/** The guest's feature bits (TTY_FEATURE_PIPES). */
	readonly features: number;
	/**
	 * The program's stdin. Strings are UTF-8, sent in DATA frames of at most
	 * 4096 bytes. close() sends EOF (the program reads end of file); a write
	 * after the session ended rejects with EPIPE.
	 */
	readonly stdin: WritableStream<Uint8Array | string>;
	/**
	 * What the program writes to stdout and stderr, byte for byte. Pull
	 * streams on one connection: the connection is read while either is
	 * read, and output for the other is held until it is read, so read both,
	 * or cancel the one you do not want (that discards it). They end after
	 * EXIT, close() or a lost connection.
	 */
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	/** Send a signal to the program ("SIGINT" or "INT"; default SIGTERM). As Pty.kill(). */
	kill(signal?: string): void;
	/** Hang up: the program's process group gets SIGHUP, and the connection closes both ways. */
	close(): Promise<void>;
	/** How the session ended. Settles once stdout and stderr have been read (or cancelled) up to EXIT, or at close(). */
	readonly ended: Promise<PtyEnd>;
	/** `await using`: close(). */
	[Symbol.asyncDispose](): Promise<void>;
}

/** One frame as received. */
export interface TtyFrame {
	type: number;
	flags: number;
	payload: Uint8Array;
}

function u16(v: number | undefined, what: string): number {
	const n = v ?? 0;
	if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`kwtty: ${what} ${v} is not an integer from 0 to 65535`);
	return n;
}

/** A frame: header and payload (copied). */
export function encodeTtyFrame(type: number, payload: Uint8Array = EMPTY, flags = 0): Uint8Array {
	const n = payload.length;
	if (n > TTY_MAX_PAYLOAD) throw new RangeError(`kwtty: a frame payload of ${n} bytes (at most ${TTY_MAX_PAYLOAD})`);
	const f = new Uint8Array(TTY_HEADER_SIZE + n);
	f[0] = type;
	f[1] = flags;
	f[2] = n & 0xff;
	f[3] = n >> 8;
	f.set(payload, TTY_HEADER_SIZE);
	return f;
}

function sizeBytes(s: PtySize): Uint8Array {
	const b = new Uint8Array(8);
	const dv = new DataView(b.buffer);
	dv.setUint16(0, u16(s.rows, "rows"), true);
	dv.setUint16(2, u16(s.cols, "cols"), true);
	dv.setUint16(4, u16(s.xpixel, "xpixel"), true);
	dv.setUint16(6, u16(s.ypixel, "ypixel"), true);
	return b;
}

/** RESIZE's payload (on the wire rows come first, as in struct winsize). */
export function encodeTtyResize(s: PtySize): Uint8Array {
	return sizeBytes(s);
}

/**
 * OPEN's payload: max_version, the size, then TERM, one ENV option per
 * entry, ARG options (`file`, then `args`), CWD, PIPES, CONNECT, USER
 * (always but with `connect`: empty for the default user) and DETACH. With
 * `pipes` or `connect`, TERM goes only when `term` is given. Throws a
 * RangeError for values the guest would refuse.
 */
export function encodeTtyOpen(opts: PtySize & { term?: string; env?: Record<string, string>; cwd?: string; file?: string; args?: readonly string[]; pipes?: boolean; connect?: number; user?: string | number; detach?: { id: string; timeout?: number } }): Uint8Array {
	const enc = new TextEncoder();
	const { parts, opt } = openParts(opts);
	const term = opts.term ?? (opts.pipes || opts.connect !== undefined ? undefined : DEFAULT_TERM);
	if (term !== undefined) {
		if (!/^[\x20-\x7e]{1,64}$/.test(term)) throw new RangeError(`kwtty: TERM ${JSON.stringify(term)} is not 1 to 64 printable ASCII characters`);
		opt(TTY_OPT_TERM, enc.encode(term));
	}
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		if (!k || k.includes("=") || k.includes("\0") || String(v).includes("\0")) throw new RangeError(`kwtty: environment variable ${JSON.stringify(k)}: a name must be non-empty without "=", and neither may contain NUL`);
		const kv = enc.encode(`${k}=${v}`);
		if (kv.length > TTY_MAX_PAYLOAD) throw new RangeError(`kwtty: environment variable ${k} is too long`);
		opt(TTY_OPT_ENV, kv);
	}
	if (opts.file !== undefined) {
		for (const a of [opts.file, ...(opts.args ?? [])]) {
			if (a.includes("\0")) throw new RangeError(`kwtty: argument ${JSON.stringify(a)} contains NUL`);
			opt(TTY_OPT_ARG | TTY_OPT_CRITICAL, enc.encode(a));
		}
		if (!opts.file) throw new RangeError("kwtty: the program name is empty");
	} else if (opts.args?.length) throw new RangeError("kwtty: args without a program (file)");
	if (opts.cwd !== undefined) {
		if (!opts.cwd || opts.cwd.includes("\0")) throw new RangeError(`kwtty: cwd ${JSON.stringify(opts.cwd)} is empty or contains NUL`);
		opt(TTY_OPT_CWD | TTY_OPT_CRITICAL, enc.encode(opts.cwd));
	}
	if (opts.pipes) opt(TTY_OPT_PIPES | TTY_OPT_CRITICAL, EMPTY);
	if (opts.connect !== undefined) {
		const port = opts.connect;
		if (!Number.isInteger(port) || port < 1 || port > 0xffff) throw new RangeError(`kwtty: TCP port ${port} is not an integer from 1 to 65535`);
		opt(TTY_OPT_CONNECT | TTY_OPT_CRITICAL, Uint8Array.of(port & 0xff, port >> 8));
	} else {
		const u = opts.user === undefined ? "" : String(opts.user);
		if (typeof opts.user === "number" ? !Number.isInteger(opts.user) || opts.user < 0 || opts.user > 0xffffffff : !/^[^\0:\n]{0,64}$/.test(u) || (opts.user !== undefined && !u))
			throw new RangeError(`kwtty: user ${JSON.stringify(opts.user)} is not a uid or a name of 1 to 64 characters without ":", newline or NUL`);
		// A guest from before USER runs every session as root: it may ignore a request for root or for its default.
		opt(TTY_OPT_USER | (u === "" || u === "root" || u === "0" ? 0 : TTY_OPT_CRITICAL), enc.encode(u));
	}
	if (opts.detach) {
		if (opts.pipes || opts.connect !== undefined) throw new RangeError("kwtty: only a session on a pty can be detachable");
		const t = opts.detach.timeout ?? 0;
		if (!Number.isInteger(t) || t < 0 || t > 0xffffffff) throw new RangeError(`kwtty: detachTimeout ${t} is not an integer number of ms from 0 to 2^32 - 1`);
		const id = sessionIdBytes(opts.detach.id);
		const v = new Uint8Array(4 + id.length);
		new DataView(v.buffer).setUint32(0, t, true);
		v.set(id, 4);
		opt(TTY_OPT_DETACH, v); // not critical: a guest without it opens an ordinary session
	}
	return joinParts(parts);
}

/** ATTACH's OPEN payload: max_version, the size, ATTACH (critical) and REPLAY. */
export function encodeTtyAttach(opts: PtySize & { id: string; replay?: boolean }): Uint8Array {
	const { parts, opt } = openParts(opts);
	opt(TTY_OPT_ATTACH | TTY_OPT_CRITICAL, sessionIdBytes(opts.id));
	if (opts.replay) opt(TTY_OPT_REPLAY, EMPTY);
	return joinParts(parts);
}

function sessionIdBytes(id: string): Uint8Array {
	if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new RangeError(`kwtty: session id ${JSON.stringify(id)} is not 1 to 64 of A-Z a-z 0-9 . _ -`);
	return new TextEncoder().encode(id);
}

/** OPEN's head (max_version, the size) and a function adding a TLV option. */
function openParts(size: PtySize) {
	const parts: Uint8Array[] = [];
	const head = new Uint8Array(2);
	new DataView(head.buffer).setUint16(0, TTY_VERSION, true);
	parts.push(head, sizeBytes(size));
	const opt = (tag: number, value: Uint8Array) => {
		const h = new Uint8Array(3);
		h[0] = tag;
		h[1] = value.length & 0xff;
		h[2] = value.length >> 8;
		parts.push(h, value);
	};
	return { parts, opt };
}

function joinParts(parts: Uint8Array[]): Uint8Array {
	let n = 0;
	for (const p of parts) n += p.length;
	if (n > TTY_MAX_PAYLOAD) throw new RangeError(`kwtty: the OPEN frame would be ${n} bytes (at most ${TTY_MAX_PAYLOAD}); pass less environment`);
	const out = new Uint8Array(n);
	n = 0;
	for (const p of parts) {
		out.set(p, n);
		n += p.length;
	}
	return out;
}

/**
 * Splits a byte stream into frames, however it is chunked. push() what
 * arrives, then take whole frames with next(). A payload within one chunk
 * is a view of it, else a copy.
 */
export class TtyFrameParser {
	#chunks: Uint8Array[] = [];
	/** Offset into #chunks[0]. */
	#head = 0;
	#len = 0;
	#frames: TtyFrame[] = [];

	/** Bytes held that do not make a whole frame yet. */
	get buffered(): number {
		return this.#len;
	}

	push(chunk: Uint8Array): void {
		if (!chunk.length) return;
		this.#chunks.push(chunk);
		this.#len += chunk.length;
		while (this.#len >= TTY_HEADER_SIZE) {
			const h = this.#read(TTY_HEADER_SIZE, false);
			const n = h[2]! | (h[3]! << 8);
			if (this.#len < TTY_HEADER_SIZE + n) break;
			this.#read(TTY_HEADER_SIZE, true);
			this.#frames.push({ type: h[0]!, flags: h[1]!, payload: this.#read(n, true) });
		}
	}

	/** The next whole frame, without taking it. */
	peek(): TtyFrame | undefined {
		return this.#frames[0];
	}

	/** Take the next whole frame. */
	next(): TtyFrame | undefined {
		return this.#frames.shift();
	}

	/** Take every byte held, frames not taken yet included, as they arrived (for a switch to raw bytes). */
	rest(): Uint8Array {
		const parts: Uint8Array[] = [];
		for (const f of this.#frames) parts.push(encodeTtyFrame(f.type, f.payload, f.flags));
		if (this.#len) parts.push(this.#read(this.#len, true));
		this.#frames = [];
		this.#chunks = [];
		this.#head = 0;
		this.#len = 0;
		let n = 0;
		for (const p of parts) n += p.length;
		if (parts.length === 1) return parts[0]!.slice();
		const out = new Uint8Array(n);
		n = 0;
		for (const p of parts) {
			out.set(p, n);
			n += p.length;
		}
		return out;
	}

	#read(n: number, consume: boolean): Uint8Array {
		if (!n) return EMPTY;
		const first = this.#chunks[0]!;
		let out: Uint8Array;
		if (first.length - this.#head >= n) {
			out = first.subarray(this.#head, this.#head + n);
			if (consume) {
				this.#head += n;
				if (this.#head === first.length) {
					this.#chunks.shift();
					this.#head = 0;
				}
			}
		} else {
			out = new Uint8Array(n);
			let at = 0, i = 0, off = this.#head;
			while (at < n) {
				const c = this.#chunks[i]!;
				const k = Math.min(n - at, c.length - off);
				out.set(c.subarray(off, off + k), at);
				at += k;
				off += k;
				if (off === c.length) {
					i++;
					off = 0;
				}
			}
			if (consume) {
				this.#chunks.splice(0, i);
				this.#head = off;
			}
		}
		if (consume) this.#len -= n;
		return out;
	}
}

type Opened = { version: number; features: number; pid: number; pts: number };

/** An output stream of a session: the frames of one type. */
interface Output {
	rc: ReadableStreamDefaultController<Uint8Array>;
	/** Cancelled: drop what comes. */
	discard: boolean;
	/** A read is waiting (or the stream is cancelled and the session must still be read to its end). */
	want: boolean;
}

/** One connection to kwtty: the frame pump, the outputs, sending, and the end. Pty and Subprocess build on it. */
class Session {
	readonly pid: number;
	readonly version: number;
	readonly features: number;
	exitCode: number | null = null;
	readonly ended: Promise<PtyEnd>;
	#conn: VsockConnection;
	#reader: ReadableStreamDefaultReader<Uint8Array>;
	#writer: WritableStreamDefaultWriter<Uint8Array | string>;
	#parser: TtyFrameParser;
	#outputs = new Map<number, Output>();
	#resolve!: (end: PtyEnd) => void;
	#reject!: (e: PtyError) => void;
	#done = false;
	#running = false;
	#pumping: Promise<void> = Promise.resolve();
	#encoder: TextEncoder | undefined;

	constructor(conn: VsockConnection, reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array | string>,
		parser: TtyFrameParser, opened: Opened) {
		this.#conn = conn;
		this.#reader = reader;
		this.#writer = writer;
		this.#parser = parser;
		this.pid = opened.pid;
		this.version = opened.version;
		this.features = opened.features;
		this.ended = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		this.ended.catch(() => {}); // a session nobody awaits is no unhandled rejection
	}

	protected get done(): boolean {
		return this.#done;
	}

	/** A pull stream of the payloads of `type` frames. */
	protected stream(type: number): ReadableStream<Uint8Array> {
		let out!: Output;
		return new ReadableStream<Uint8Array>({
			start: (rc) => {
				out = { rc, discard: false, want: false };
				this.#outputs.set(type, out);
			},
			pull: () => {
				out.want = true;
				return this.#pull();
			},
			cancel: () => {
				// Discard the rest, but keep reading so that EXIT (and the credit) still arrive.
				out.discard = out.want = true;
				void this.#pull();
			},
		}, { highWaterMark: 0 });
	}

	#pull(): Promise<void> {
		if (!this.#running) {
			this.#running = true;
			this.#pumping = this.#pump();
		}
		return this.#pumping;
	}

	#wanted(): boolean {
		for (const o of this.#outputs.values()) if (o.want) return true;
		return false;
	}

	/**
	 * Read the connection until every output with a waiting read got some,
	 * or the session ends. #running goes false where the pump decides to
	 * stop, in the same turn, so a pull that comes after starts a new pump.
	 */
	async #pump(): Promise<void> {
		try {
			for (;;) {
				let queued = false;
				for (let f = this.#parser.peek(); f && !this.#done; f = this.#parser.peek()) {
					const out = this.#outputs.get(f.type);
					if (out) {
						this.#parser.next();
						if (f.payload.length && !out.discard) {
							out.rc.enqueue(f.payload);
							out.want = false;
							queued = true;
						}
						continue;
					}
					// Whatever comes after output waits until the reader took that output.
					if (queued && !this.#wanted()) break;
					this.#parser.next();
					this.#frame(f);
				}
				if (this.#done || !this.#wanted()) break;
				let r: ReadableStreamReadResult<Uint8Array>;
				try {
					r = await this.#reader.read();
				} catch {
					this.#finish({ type: "lost" });
					break;
				}
				if (this.#done) break;
				if (r.done) {
					this.#finish({ type: "lost" });
					break;
				}
				this.#parser.push(r.value);
			}
		} catch (e) {
			this.#finish(new PtyError("EPROTO", `kwtty: ${(e as Error)?.message ?? e}`, e));
		}
		this.#running = false;
	}

	/** A frame other than output. */
	#frame(f: TtyFrame): void {
		switch (f.type) {
		case TTY_EXIT: {
			if (f.payload.length < 3) throw new Error(`an EXIT frame of ${f.payload.length} bytes`);
			const [how, code, core] = f.payload;
			if (how === 0) this.#finish({ type: "exit", code: code! });
			else if (how === 1) this.#finish({ type: "signal", signal: code!, coreDumped: core === 1 });
			else throw new Error(`EXIT with how ${how}`);
			return;
		}
		case TTY_ERROR:
			this.#finish(new PtyError("EREMOTE", `kwtty: ${new TextDecoder().decode(f.payload)}`));
			return;
		case TTY_OPENED:
			throw new Error("a second OPENED");
		default:
			if (f.flags & TTY_FLAG_CRITICAL) throw new Error(`an unknown critical frame (type ${f.type})`);
		}
	}

	/** The session is over: settle `ended`, end the outputs, and hang up. */
	#finish(end: PtyEnd | PtyError): void {
		if (this.#done) return;
		this.#done = true;
		if (!(end instanceof PtyError) && end.type === "exit") this.exitCode = end.code;
		if (end instanceof PtyError) this.#reject(end);
		else this.#resolve(end);
		for (const o of this.#outputs.values()) {
			try {
				if (end instanceof PtyError) o.rc.error(end);
				else o.rc.close();
			} catch {}
		}
		this.#conn.close();
	}

	protected send(frame: Uint8Array): Promise<void> {
		return this.#writer.write(frame).catch((e) => {
			throw new PtyError("EPIPE", `kwtty: ${this.#done ? "the session has ended" : "the connection failed"}`, e);
		});
	}

	/** DATA frames of at most TTY_MAX_WRITE bytes. */
	protected sendData(data: Uint8Array | string): Promise<void> {
		const bytes = typeof data === "string" ? (this.#encoder ??= new TextEncoder()).encode(data) : data;
		if (this.#done) return Promise.reject(new PtyError("EPIPE", "kwtty: the session has ended"));
		const sent: Promise<void>[] = [];
		for (let i = 0; i < bytes.length; i += TTY_MAX_WRITE) sent.push(this.send(encodeTtyFrame(TTY_DATA, bytes.subarray(i, i + TTY_MAX_WRITE))));
		return Promise.all(sent).then(() => {});
	}

	protected sendSignal(signal: string): void {
		const name = signal.startsWith("SIG") ? signal.slice(3) : signal;
		if (!(TTY_SIGNALS as readonly string[]).includes(name)) throw new RangeError(`kwtty: unknown signal ${JSON.stringify(signal)}`);
		if (!this.#done) this.send(encodeTtyFrame(TTY_SIGNAL, new TextEncoder().encode(name), TTY_FLAG_CRITICAL)).catch(() => {});
	}

	async close(): Promise<void> {
		this.#finish({ type: "closed" });
		this.#conn.close();
		await this.#conn.closed;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

/** The detachable sessions open on each Vsock (ttySessions(), for a snapshot). */
const detachables = new WeakMap<Vsock, Set<PtySession>>();

/**
 * The detachable sessions open on `vsock` now (live Ptys with a sessionId),
 * as a snapshot records them (KernelSnapshot.ttys).
 */
export function ttySessions(vsock: Vsock | undefined): TtySessionSnapshot[] {
	const set = vsock && detachables.get(vsock);
	if (!set) return [];
	return [...set].filter((s) => s.live).map((s) => ({ id: s.sessionId!, pid: s.pid, pts: s.pts, cols: s.cols, rows: s.rows }));
}

class PtySession extends Session implements Pty {
	readonly pts: number;
	cols: number;
	rows: number;
	readonly output: ReadableStream<Uint8Array>;
	readonly sessionId: string | undefined;
	/** @internal `ended` has not settled yet. */
	live = true;

	constructor(conn: VsockConnection, reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array | string>,
		parser: TtyFrameParser, opened: Opened, size: PtySize, vsock: Vsock, sessionId?: string) {
		super(conn, reader, writer, parser, opened);
		this.pts = opened.pts;
		this.cols = size.cols;
		this.rows = size.rows;
		this.output = this.stream(TTY_DATA);
		this.sessionId = sessionId;
		if (sessionId !== undefined) {
			let set = detachables.get(vsock);
			if (!set) detachables.set(vsock, (set = new Set()));
			set.add(this);
			const gone = () => {
				this.live = false;
				set.delete(this);
			};
			this.ended.then(gone, gone);
		}
	}

	write(data: Uint8Array | string): Promise<void> {
		return this.sendData(data);
	}

	resize(cols: number, rows: number, xpixel?: number, ypixel?: number): void {
		const frame = encodeTtyFrame(TTY_RESIZE, encodeTtyResize({ cols, rows, xpixel, ypixel }));
		this.cols = cols;
		this.rows = rows;
		if (!this.done) this.send(frame).catch(() => {});
	}

	kill(signal = "SIGHUP"): void {
		this.sendSignal(signal);
	}
}

class PipeSession extends Session implements Subprocess {
	readonly stdin: WritableStream<Uint8Array | string>;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;

	constructor(conn: VsockConnection, reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array | string>,
		parser: TtyFrameParser, opened: Opened) {
		super(conn, reader, writer, parser, opened);
		this.stdout = this.stream(TTY_DATA);
		this.stderr = this.stream(TTY_STDERR);
		// EOF once the writes before it are sent; nothing to close once the session is over.
		const eof = () => (this.done ? Promise.resolve() : this.send(encodeTtyFrame(TTY_EOF)).catch(() => {}));
		this.stdin = new WritableStream<Uint8Array | string>({
			write: (chunk) => this.sendData(chunk),
			close: eof,
			abort: eof,
		});
	}

	kill(signal = "SIGTERM"): void {
		this.sendSignal(signal);
	}
}

/** Settle with `p`, or reject at `deadline` (performance.now()) or when `signal` aborts; `late` gets a value that comes after that. */
function guard<T>(p: Promise<T>, deadline: number, timedOut: () => PtyError, signal?: AbortSignal, late?: (v: T) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let over = false;
		const stop = () => {
			over = true;
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			stop();
			reject(aborted());
		};
		const timer = deadline === Infinity ? undefined : setTimeout(() => {
			stop();
			reject(timedOut());
		}, Math.max(0, deadline - performance.now()));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort);
		p.then((v) => {
			if (over) late?.(v);
			else {
				stop();
				resolve(v);
			}
		}, (e) => {
			if (!over) {
				stop();
				reject(e);
			}
		});
	});
}

const aborted = () => new PtyError("ABORTED", "kwtty: aborted while opening the session");
const errCode = (e: unknown) => (e as { code?: unknown } | null)?.code;

async function connectRetry(vsock: Vsock, port: number, deadline: number, timedOut: () => PtyError, signal?: AbortSignal): Promise<VsockConnection> {
	for (;;) {
		if (signal?.aborted) throw aborted();
		const left = deadline - performance.now();
		if (left <= 0) throw timedOut();
		try {
			return await guard(vsock.connect(port, { timeout: Math.max(1, Math.ceil(left)) }), deadline, timedOut, signal, (c) => c.reset());
		} catch (e) {
			if (e instanceof PtyError) throw e;
			const code = errCode(e);
			if (code === "ECONNREFUSED") {
				// The guest server is not listening yet (still booting, or respawning).
				const wait = Math.min(RETRY_MS, deadline - performance.now());
				if (wait > 0) await guard(new Promise((r) => setTimeout(r, wait)), Infinity, timedOut, signal);
				continue;
			}
			if (code === "ETIMEDOUT") throw timedOut();
			if (code === "ECONNABORTED") throw new PtyError("ECONNABORTED", "kwtty: the kernel exited", e);
			throw e;
		}
	}
}

async function readOpened(reader: ReadableStreamDefaultReader<Uint8Array>, parser: TtyFrameParser) {
	for (;;) {
		for (let f = parser.next(); f; f = parser.next()) {
			if (f.type === TTY_OPENED) {
				if (f.payload.length < OPENED_SIZE) throw new PtyError("EPROTO", `kwtty: an OPENED frame of ${f.payload.length} bytes`);
				const dv = new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.length);
				const version = dv.getUint16(0, true);
				if (version < 1 || version > TTY_VERSION) throw new PtyError("EPROTO", `kwtty: the guest chose version ${version} (this client speaks 1 to ${TTY_VERSION})`);
				return { version, features: dv.getUint32(2, true), pid: dv.getUint32(6, true), pts: dv.getUint32(10, true) };
			}
			if (f.type === TTY_ERROR) throw new PtyError("EREMOTE", `kwtty: ${new TextDecoder().decode(f.payload)}`);
			if (f.type === TTY_DATA || f.type === TTY_EXIT || f.flags & TTY_FLAG_CRITICAL)
				throw new PtyError("EPROTO", `kwtty: frame type ${f.type} before OPENED`);
		}
		let r: ReadableStreamReadResult<Uint8Array>;
		try {
			r = await reader.read();
		} catch (e) {
			throw new PtyError("ECONNRESET", "kwtty: the connection was reset before OPENED", e);
		}
		if (r.done) throw new PtyError("ECONNRESET", "kwtty: the guest closed the connection before OPENED");
		parser.push(r.value);
	}
}

/** Connect (retrying while the guest server is not up yet), send OPEN, and wait for OPENED. */
async function openSession(vsock: Vsock, payload: Uint8Array, opts: SpawnOptions) {
	const open = encodeTtyFrame(TTY_OPEN, payload);
	const port = opts.port ?? TTY_PORT;
	const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
	const signal = opts.signal;
	const deadline = performance.now() + timeout;
	const timedOut = () => new PtyError("ETIMEDOUT", `kwtty: no terminal server on vsock port ${port} within ${timeout} ms (is /usr/bin/kwtty running in the guest?)`);
	const conn = await connectRetry(vsock, port, deadline, timedOut, signal);
	try {
		const reader = conn.readable.getReader();
		const writer = conn.writable.getWriter();
		const parser = new TtyFrameParser();
		writer.write(open).catch(() => {}); // a failure shows as the reader's end
		const opened = readOpened(reader, parser);
		opened.catch(() => {});
		return { conn, reader, writer, parser, opened: await guard(opened, deadline, timedOut, signal) };
	} catch (e) {
		conn.reset();
		throw e;
	}
}

/**
 * Run `file` with `args` on a new pty in the guest (no file: the user's login
 * shell; a file without "/" is looked up in PATH): connect to the guest's
 * kwtty server (retrying while it is not up yet), send OPEN, and wait for
 * OPENED. Rejects with a PtyError (ETIMEDOUT, EREMOTE with the guest's
 * message, e.g. a failed exec or chdir, EPROTO, ABORTED, ECONNRESET,
 * ECONNABORTED), or a RangeError for bad options.
 */
export async function spawnPty(vsock: Vsock, file?: string, args: readonly string[] = [], opts: PtyOptions = {}): Promise<Pty> {
	const size: PtySize = { cols: opts.cols ?? DEFAULT_COLS, rows: opts.rows ?? DEFAULT_ROWS, xpixel: opts.xpixel, ypixel: opts.ypixel };
	const { detachable, detachTimeout, ...rest } = opts;
	const detach = detachable ? { id: newSessionId(), timeout: detachTimeout } : undefined;
	const s = await openSession(vsock, encodeTtyOpen({ ...rest, ...size, file, args, detach }), opts);
	// A guest without DETACH ignored the option: an ordinary session.
	const id = detach && s.opened.features & TTY_FEATURE_DETACH ? detach.id : undefined;
	return new PtySession(s.conn, s.reader, s.writer, s.parser, s.opened, size, vsock, id);
}

/** 128 random bits as 32 hex digits: a session id nobody can guess. */
function newSessionId(): string {
	const b = crypto.getRandomValues(new Uint8Array(16));
	let id = "";
	for (const x of b) id += x.toString(16).padStart(2, "0");
	return id;
}

/**
 * Take over a detachable session (PtyOptions.detachable) by its id, or as
 * a snapshot recorded it (KernelSnapshot.ttys), typically in a machine
 * restored from a snapshot, where the restore detached it. Resolves with a
 * live Pty (the same pid and pts; with `replay`, the default, its output
 * starts with the session's recent output) once the guest took it over; a
 * connection that still had the session is closed (its Pty ends "lost").
 * Rejects with PtyError ENOENT when there is no such session (never
 * spawned in this machine, ended, or hung up after its timeout) or the
 * guest's kwtty cannot reattach (an image from before ATTACH), and
 * otherwise as spawnPty().
 */
export async function attachPty(vsock: Vsock, session: string | TtySessionSnapshot, opts: AttachOptions = {}): Promise<Pty> {
	const saved = typeof session === "string" ? undefined : session;
	const id = typeof session === "string" ? session : session.id;
	const size: PtySize = { cols: opts.cols ?? saved?.cols ?? DEFAULT_COLS, rows: opts.rows ?? saved?.rows ?? DEFAULT_ROWS, xpixel: opts.xpixel, ypixel: opts.ypixel };
	const payload = encodeTtyAttach({ ...size, id, replay: opts.replay ?? true });
	let s: Awaited<ReturnType<typeof openSession>>;
	try {
		s = await openSession(vsock, payload, { port: opts.port, timeout: opts.timeout, signal: opts.signal });
	} catch (e) {
		if (e instanceof PtyError && e.code === "EREMOTE") {
			if (e.message.startsWith("kwtty: ENOENT:")) throw new PtyError("ENOENT", e.message);
			if (e.message === "kwtty: unknown critical OPEN option")
				throw new PtyError("ENOENT", "kwtty: the guest's kwtty cannot reattach sessions (it is older than ATTACH)", e);
		}
		throw e;
	}
	return new PtySession(s.conn, s.reader, s.writer, s.parser, s.opened, size, vsock, id);
}

/**
 * Run `file` with `args` in the guest on pipes (stdin, stdout and stderr;
 * no file: the user's login shell, reading stdin), as spawnPty() otherwise. A
 * guest without PIPES (a kernel from before them) refuses it: EREMOTE.
 */
export async function spawnSubprocess(vsock: Vsock, file?: string, args: readonly string[] = [], opts: SpawnOptions = {}): Promise<Subprocess> {
	const s = await openSession(vsock, encodeTtyOpen({ ...opts, cols: 0, rows: 0, file, args, pipes: true }), opts);
	return new PipeSession(s.conn, s.reader, s.writer, s.parser, s.opened);
}

/**
 * Run `file` with `args` on pipes, feed it `input`, and resolve with what
 * it printed on stdout and stderr and how it ended, once it ended. A
 * non-zero exit or a signal resolves too. Rejects with a PtyError as
 * spawnSubprocess(), or ENOBUFS (output over `maxBuffer`), ABORTED (the
 * signal; the program gets SIGKILL), ECONNRESET (the session was lost:
 * the kernel exited).
 */
export function execSubprocess(vsock: Vsock, file: string, args?: readonly string[], opts?: ExecOptions & { encoding?: "utf8" }): Promise<ExecResult<string>>;
export function execSubprocess(vsock: Vsock, file: string, args: readonly string[] | undefined, opts: ExecOptions & { encoding: "buffer" }): Promise<ExecResult<Uint8Array>>;
export function execSubprocess(vsock: Vsock, file: string, args?: readonly string[], opts?: ExecOptions): Promise<ExecResult<string | Uint8Array>>;
export async function execSubprocess(vsock: Vsock, file: string, args: readonly string[] = [], opts: ExecOptions = {}): Promise<ExecResult<string | Uint8Array>> {
	const { input, encoding = "utf8", maxBuffer = DEFAULT_MAX_BUFFER, ...spawnOpts } = opts;
	if (!file) throw new RangeError("kwtty: exec() needs a program (file)");
	const p = await spawnSubprocess(vsock, file, args, spawnOpts);
	const signal = opts.signal;
	let failure: PtyError | undefined;
	const fail = (e: PtyError) => {
		if (failure) return;
		failure = e;
		p.kill("KILL");
	};
	const onAbort = () => fail(new PtyError("ABORTED", "kwtty: exec() was aborted; the program got SIGKILL"));
	signal?.addEventListener("abort", onAbort);
	if (signal?.aborted) onAbort();
	const collect = async (stream: ReadableStream<Uint8Array>, name: string) => {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let n = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (failure) continue; // read on to the end, so that EXIT arrives
			n += value.length;
			if (n > maxBuffer) fail(new PtyError("ENOBUFS", `kwtty: ${name} went over maxBuffer (${maxBuffer} bytes); the program got SIGKILL`));
			else chunks.push(value);
		}
		const out = new Uint8Array(failure ? 0 : n);
		if (!failure) {
			let at = 0;
			for (const c of chunks) {
				out.set(c, at);
				at += c.length;
			}
		}
		return out;
	};
	const feed = async () => {
		const w = p.stdin.getWriter();
		// EPIPE: the program ended (or closed stdin) before taking it all.
		if (input !== undefined && input.length) await w.write(input).catch(() => {});
		await w.close().catch(() => {});
	};
	try {
		const [stdout, stderr] = await Promise.all([collect(p.stdout, "stdout"), collect(p.stderr, "stderr"), feed()]);
		const end = await p.ended;
		if (failure) throw failure;
		if (end.type === "exit" || end.type === "signal") {
			const decode = (b: Uint8Array) => (encoding === "buffer" ? b : new TextDecoder().decode(b));
			return {
				stdout: decode(stdout), stderr: decode(stderr),
				exitCode: end.type === "exit" ? end.code : null,
				signal: end.type === "signal" ? end.signal : null,
			};
		}
		throw new PtyError("ECONNRESET", "kwtty: the session was lost before the program exited (did the kernel exit?)");
	} catch (e) {
		await p.close().catch(() => {});
		throw failure ?? e;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

/** What connectGuest() takes. */
export interface ConnectOptions {
	/** How long to wait, in ms: for the guest server (connect retries), its TCP connect and the handshake together. Default 30000. */
	timeout?: number;
	/** Aborts connecting (PtyError ABORTED). It has no effect once connected: cancel `readable` or call close(). */
	signal?: AbortSignal;
	/** The guest server's (kwtty's) vsock port. Default TTY_PORT (1022). */
	ttyPort?: number;
}

/**
 * A raw byte stream to a TCP server in the guest (connectGuest()). It has
 * the shape of a ByteDuplex (http.ts), so fetchOver() can use it.
 */
export interface GuestSocket extends AsyncDisposable {
	/** The guest's TCP port. */
	readonly port: number;
	/**
	 * What the server sends. A pull stream: vsock credit follows what is
	 * read. It ends when the server shuts down its sending side (or
	 * closes), and errors with a VsockError on a reset. Cancelling it tells
	 * the guest the host no longer reads, which ends the connection.
	 */
	readonly readable: ReadableStream<Uint8Array>;
	/**
	 * Bytes for the server; a write resolves once its bytes are sent.
	 * close() is a half-close: the server reads EOF and may still send.
	 * abort() resets the connection.
	 */
	readonly writable: WritableStream<Uint8Array>;
	/** Close both ways (what was written is still sent; what was not read is dropped). Resolves once the connection is gone. */
	close(): Promise<void>;
	/** Settles once the connection is gone: "closed" (both sides shut down) or "reset". */
	readonly closed: Promise<"closed" | "reset">;
	/** `await using`: close(). */
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * Connect to TCP `port` on the guest's 127.0.0.1 through the guest's kwtty
 * server (CONNECT; retrying while kwtty is not up yet). The guest connects
 * before it answers, so the promise resolves with a connected GuestSocket,
 * or rejects with a PtyError: ECONNREFUSED (nothing listens on the port),
 * EREMOTE (another connect error, with the guest's message, or a guest
 * without CONNECT), ETIMEDOUT, ABORTED, ECONNRESET, ECONNABORTED, EPROTO;
 * a RangeError for a port outside 1 to 65535.
 */
export async function connectGuest(vsock: Vsock, port: number, opts: ConnectOptions = {}): Promise<GuestSocket> {
	const payload = encodeTtyOpen({ cols: 0, rows: 0, connect: port });
	let s: Awaited<ReturnType<typeof openSession>>;
	try {
		s = await openSession(vsock, payload, { port: opts.ttyPort, timeout: opts.timeout, signal: opts.signal });
	} catch (e) {
		if (e instanceof PtyError && e.code === "EREMOTE" && e.message.startsWith("kwtty: ECONNREFUSED:"))
			throw new PtyError("ECONNREFUSED", e.message);
		throw e;
	}
	const { conn, reader, writer, parser, opened } = s;
	if (!(opened.features & TTY_FEATURE_CONNECT)) {
		conn.reset();
		throw new PtyError("EPROTO", "kwtty: the guest opened a session without the CONNECT feature");
	}
	// Bytes that came with OPENED belong to the stream: hand them out first.
	// A stream of its own also because the connection's has been read
	// (disturbed), which `new Response(readable)` refuses.
	let rest: Uint8Array | undefined = parser.rest();
	if (!rest.length) rest = undefined;
	writer.releaseLock();
	const readable = new ReadableStream<Uint8Array>({
		pull: async (c) => {
			if (rest) {
				c.enqueue(rest);
				rest = undefined;
				return;
			}
			const r = await reader.read();
			if (r.done) c.close();
			else c.enqueue(r.value);
		},
		cancel: (reason) => reader.cancel(reason),
	}, { highWaterMark: 0 });
	const close = async () => {
		conn.close();
		await conn.closed;
	};
	return {
		port,
		readable,
		writable: conn.writable,
		closed: conn.closed,
		close,
		[Symbol.asyncDispose]: close,
	};
}

const noDevice = (what: string) => new PtyError("ENODEV", `${what} needs the vsock device, which this instance has not: it was created with vsock: false (or vsock.raw)`);

/** spawnPty() or spawnSubprocess() (`pty: false`) for an instance's `vsock`, with a clear error when the instance has none. */
export function spawnOn(vsock: Vsock | undefined, file?: string, args?: readonly string[], opts?: PtyOptions | PipeOptions): Promise<Pty | Subprocess> {
	if (!vsock) return Promise.reject(noDevice("spawn()"));
	if (opts?.pty === false) {
		const { pty: _, ...rest } = opts;
		return spawnSubprocess(vsock, file, args, rest);
	}
	return spawnPty(vsock, file, args, opts);
}

/** attachPty() for an instance's `vsock`, with a clear error when the instance has none. */
export function attachOn(vsock: Vsock | undefined, session: string | TtySessionSnapshot, opts?: AttachOptions): Promise<Pty> {
	if (!vsock) return Promise.reject(noDevice("attach()"));
	return attachPty(vsock, session, opts);
}

/** execSubprocess() for an instance's `vsock`, with a clear error when the instance has none. */
export function execOn(vsock: Vsock | undefined, file: string, args?: readonly string[], opts?: ExecOptions): Promise<ExecResult<string | Uint8Array>> {
	if (!vsock) return Promise.reject(noDevice("exec()"));
	return execSubprocess(vsock, file, args, opts);
}

/** connectGuest() for an instance's `vsock`, with a clear error when the instance has none. */
export function connectOn(vsock: Vsock | undefined, port: number, opts?: ConnectOptions): Promise<GuestSocket> {
	if (!vsock) return Promise.reject(noDevice("connect()"));
	return connectGuest(vsock, port, opts);
}
