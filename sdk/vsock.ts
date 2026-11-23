// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// AF_VSOCK between the host and the guest: the host side of kwvsock
// (net/vmw_vsock/kwvsock.c), a virtio-vsock transport without virtio.
//
// The guest is CID 3 (the kernel says so at init) and the host CID 2
// (VMADDR_CID_HOST). Packets are virtio-vsock's: a 44-byte little-endian
// header (src_cid u64, dst_cid u64, src_port u32, dst_port u32, len u32,
// type u16, op u16, flags u32, buf_alloc u32, fwd_cnt u32), then `len`
// payload bytes. Only stream sockets (no SEQPACKET, no datagrams).
//
// Two layers:
//  - VsockDevice is the kernel's end, a packet pipe on the kernel's thread:
//    the wasm_driver_vsock_* imports and IRQ 6. The guest's packets go to
//    `onPacket` (copied out during the import); deliver() queues a packet
//    for the guest and raises the IRQ. It knows nothing about connections,
//    except the set a restored snapshot keeps (`keep`). No import suspends.
//  - VsockHost is the host's end of the protocol (CID 2): connections,
//    credit flow control, shutdown and reset, and the API (listen(),
//    connect(), VsockConnection with web streams). It only needs a way to
//    send packets and to be given the guest's, so it runs wherever the API
//    is: on the kernel's thread inline, and on the owner's thread in worker
//    mode, where the packets cross as messages (worker-serve.ts,
//    worker-host.ts).
//
// Flow control is virtio-vsock's credit: each side advertises its receive
// buffer (buf_alloc) and how much of it the reader has consumed (fwd_cnt)
// in every packet, and a sender never has more than buf_alloc - (tx_cnt -
// fwd_cnt) bytes in flight. Linux drops data beyond that, so VsockHost
// keeps to the guest's credit exactly; the guest keeps to ours, which grows
// only as the host's reader takes data from `readable`. So neither side
// queues more than a window per connection, and a slow reader slows the
// writer at the other end.
//
// Snapshots: connections end at a restore (the kernel resets them), except
// the host file systems' (mounts.ts), whose counters the snapshot keeps
// (Connection.saveState(), VsockHost.adopt()).

import { errorText } from "./output.ts";

// The fork has no 9p mounts (core/mounts.ts): a snapshot's host file systems
// are the only thing this type carries, and this instance cannot take one.
type MountsSnapshot = { mounts: Array<{ path: string; readOnly: boolean }> };

/** The host's CID (VMADDR_CID_HOST). */
export const VSOCK_HOST_CID = 2;
/** The guest's CID with kwvsock (KWVSOCK_GUEST_CID). */
export const VSOCK_GUEST_CID = 3;
/** Size of the packet header (struct virtio_vsock_hdr). */
export const VSOCK_HEADER_SIZE = 44;

export const VSOCK_TYPE_STREAM = 1;
export const VSOCK_OP_REQUEST = 1;
export const VSOCK_OP_RESPONSE = 2;
export const VSOCK_OP_RST = 3;
export const VSOCK_OP_SHUTDOWN = 4;
export const VSOCK_OP_RW = 5;
export const VSOCK_OP_CREDIT_UPDATE = 6;
export const VSOCK_OP_CREDIT_REQUEST = 7;
/** SHUTDOWN flags: the sender will receive no more, send no more. */
export const VSOCK_SHUTDOWN_RCV = 1;
export const VSOCK_SHUTDOWN_SEND = 2;

/** EAGAIN, as wasm_driver_vsock_send() returns it when the host refuses a packet. */
const EAGAIN = 11;
const ENODEV = 19;
/** Ports at or above this are free for connect()'s host side. */
const FIRST_HOST_PORT = 49152;
/** How long after a full shutdown the guest gets to answer with RST before the host resets (Linux's VSOCK_CLOSE_TIMEOUT). */
const CLOSE_TIMEOUT_MS = 8000;
/** While the guest's credit stays exhausted, how often to send CREDIT_REQUEST again. */
const CREDIT_RETRY_MS = 500;
/** Connections waiting in a listener for accept() before further requests are refused. */
const BACKLOG = 128;

/** A packet header, decoded. CIDs fit a double (they are 32-bit in practice). */
export interface VsockHeader {
	srcCid: number;
	dstCid: number;
	srcPort: number;
	dstPort: number;
	len: number;
	type: number;
	op: number;
	flags: number;
	bufAlloc: number;
	fwdCnt: number;
}

/** Decode the header at the start of a packet (at least VSOCK_HEADER_SIZE bytes). */
export function decodeVsockHeader(pkt: Uint8Array): VsockHeader {
	const dv = new DataView(pkt.buffer, pkt.byteOffset, VSOCK_HEADER_SIZE);
	return {
		srcCid: dv.getUint32(0, true) + dv.getUint32(4, true) * 2 ** 32,
		dstCid: dv.getUint32(8, true) + dv.getUint32(12, true) * 2 ** 32,
		srcPort: dv.getUint32(16, true),
		dstPort: dv.getUint32(20, true),
		len: dv.getUint32(24, true),
		type: dv.getUint16(28, true),
		op: dv.getUint16(30, true),
		flags: dv.getUint32(32, true),
		bufAlloc: dv.getUint32(36, true),
		fwdCnt: dv.getUint32(40, true),
	};
}

/** A packet: the header (its len is the payload's) and the payload. */
export function encodeVsockPacket(h: Omit<VsockHeader, "len">, payload?: Uint8Array): Uint8Array {
	const n = payload?.length ?? 0;
	const pkt = new Uint8Array(VSOCK_HEADER_SIZE + n);
	const dv = new DataView(pkt.buffer);
	dv.setUint32(0, h.srcCid >>> 0, true);
	dv.setUint32(4, Math.floor(h.srcCid / 2 ** 32), true);
	dv.setUint32(8, h.dstCid >>> 0, true);
	dv.setUint32(12, Math.floor(h.dstCid / 2 ** 32), true);
	dv.setUint32(16, h.srcPort, true);
	dv.setUint32(20, h.dstPort, true);
	dv.setUint32(24, n, true);
	dv.setUint16(28, h.type, true);
	dv.setUint16(30, h.op, true);
	dv.setUint32(32, h.flags, true);
	dv.setUint32(36, h.bufAlloc, true);
	dv.setUint32(40, h.fwdCnt, true);
	if (payload) pkt.set(payload, VSOCK_HEADER_SIZE);
	return pkt;
}

// ---------------------------------------------------------------------------
// The kernel's end: a packet pipe.

export interface VsockDeviceOptions {
	/** Offer the device (the kernel registers its transport only then). Default false. */
	enabled?: boolean;
	/** The kernel's memory, read at call time. */
	memory: () => WebAssembly.Memory;
	/** Set IRQ_VSOCK and wake the kernel. */
	raise: () => void;
	/** A packet from the guest (a copy; header and payload). */
	onPacket?: (pkt: Uint8Array) => void;
	/** The kernel's driver started: the guest's CID and the largest packet it takes (header and payload). */
	onInit?: (guestCid: number, rxMax: number) => void;
}

/** What a machine snapshot keeps of kwvsock (VsockDevice.saveState()). */
export interface VsockSnapshot {
	guestCid: number;
	rxMax: number;
	/**
	 * Host file systems (inline mode): each mount's 9p session and the
	 * vsock connection it runs on, which a restore takes over; the kernel
	 * keeps exactly these connections and resets every other.
	 */
	mounts?: MountsSnapshot;
}

/** @internal A connection a snapshot keeps: its ports and credit counters (Connection.saveState()). */
export interface VsockConnSnapshot {
	localPort: number;
	remotePort: number;
	rxCnt: number;
	fwdCnt: number;
	sentFwd: number;
	peerBufAlloc: number;
	peerFwdCnt: number;
	txCnt: number;
}

export interface VsockDeviceStats {
	/** Packets and bytes (headers included) from the guest. */
	fromGuest: number;
	fromGuestBytes: number;
	/** Packets and bytes taken by the guest. */
	toGuest: number;
	toGuestBytes: number;
	/** Guest packets the host refused for now (the kernel sends them again). */
	refused: number;
}

/**
 * The host side of kwvsock's imports. The guest's packets go to
 * `onPacket`, packets for the guest are queued with deliver(). The queue
 * for the guest has no limit of its own: VsockHost keeps it to the guest's
 * credit for data, and control packets are small.
 */
export class VsockDevice {
	readonly enabled: boolean;
	/** Did the kernel ask (wasm_driver_vsock_init)? False for a kernel without kwvsock. */
	probed = false;
	/** The guest's CID and largest packet it takes, from the kernel's init (0 before). */
	guestCid = 0;
	rxMax = 0;
	onPacket: ((pkt: Uint8Array) => void) | undefined;
	onInit: ((guestCid: number, rxMax: number) => void) | undefined;
	/**
	 * Test hook: return true to refuse the guest's packet for now. The
	 * kernel keeps it, with everything after it, and sends it again after
	 * the next IRQ, which is raised from a timer.
	 */
	refuse: (() => boolean) | undefined;
	/**
	 * Connections (`guestPort:hostPort`) the kernel keeps after a restore;
	 * it resets every other connected socket (wasm_driver_vsock_keep, asked
	 * by kwvsock's park restore notifier). Set by the host's restore of
	 * its mounts before the kernel runs; undefined resets them all.
	 */
	keep: Set<string> | undefined;
	/** Saved with the device at the snapshot point: the host file systems (inline mode). */
	onSave: (() => MountsSnapshot | undefined) | undefined;
	/** Why the host's end cannot be saved at the snapshot point (a 9p request in flight), or "". */
	hostBusy: (() => string) | undefined;
	stats: VsockDeviceStats = { fromGuest: 0, fromGuestBytes: 0, toGuest: 0, toGuestBytes: 0, refused: 0 };
	#queue: Uint8Array[] = [];
	#head = 0;
	#memory: () => WebAssembly.Memory;
	#raise: () => void;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#closed = false;

	constructor(opts: VsockDeviceOptions) {
		this.enabled = !!opts.enabled;
		this.#memory = opts.memory;
		this.#raise = opts.raise;
		this.onPacket = opts.onPacket;
		this.onInit = opts.onInit;
	}

	/** Packets queued for the guest. */
	get queued(): number {
		return this.#queue.length - this.#head;
	}

	/** At the snapshot point: what keeps it from being saved now ("vsock packets", a mount's request), or "". */
	blocker(): string {
		if (this.queued) return "vsock packets";
		return this.hostBusy?.() ?? "";
	}

	/** Queue a packet (header and payload, at most rxMax bytes once known) for the guest and raise the IRQ. */
	deliver(pkt: Uint8Array): void {
		if (!this.enabled || this.#closed) return;
		this.#queue.push(pkt);
		this.#raise();
	}

	imports(): Record<string, unknown> {
		return {
			wasm_driver_vsock_init: (guestCid: number, rxMax: number): number => {
				this.probed = true;
				if (!this.enabled) return -ENODEV;
				this.guestCid = guestCid >>> 0;
				this.rxMax = rxMax >>> 0;
				try { this.onInit?.(this.guestCid, this.rxMax); } catch {}
				return 0;
			},
			wasm_driver_vsock_send: (hdr: bigint, data: bigint, len: number): number => {
				if (this.refuse?.()) {
					this.stats.refused++;
					this.#retry ??= setTimeout(() => {
						this.#retry = undefined;
						this.#raise();
					}, 0);
					return -EAGAIN;
				}
				const n = len >>> 0;
				const u8 = new Uint8Array(this.#memory().buffer);
				const pkt = new Uint8Array(VSOCK_HEADER_SIZE + n);
				pkt.set(u8.subarray(Number(hdr), Number(hdr) + VSOCK_HEADER_SIZE));
				if (n) pkt.set(u8.subarray(Number(data), Number(data) + n), VSOCK_HEADER_SIZE);
				this.stats.fromGuest++;
				this.stats.fromGuestBytes += pkt.length;
				this.onPacket?.(pkt);
				return 0;
			},
			wasm_driver_vsock_keep: (guestPort: number, hostPort: number): number => (this.keep?.has(`${guestPort >>> 0}:${hostPort >>> 0}`) ? 1 : 0),
			wasm_driver_vsock_rx_len: (): number => (this.#head < this.#queue.length ? this.#queue[this.#head]!.length : 0),
			wasm_driver_vsock_recv: (buf: bigint, max: number): number => {
				if (this.#head >= this.#queue.length) return 0;
				const pkt = this.#queue[this.#head]!;
				this.#queue[this.#head++] = undefined as unknown as Uint8Array;
				if (this.#head > 64 && this.#head * 2 > this.#queue.length) {
					this.#queue = this.#queue.slice(this.#head);
					this.#head = 0;
				}
				if (buf) {
					new Uint8Array(this.#memory().buffer).set(pkt.subarray(0, max >>> 0), Number(buf));
					this.stats.toGuest++;
					this.stats.toGuestBytes += pkt.length;
				}
				return pkt.length;
			},
		};
	}

	/**
	 * The state a snapshot keeps. Connections do not survive, except those
	 * of host file systems (`mounts`, inline mode): after a restore the
	 * kernel resets every connected socket that `keep` does not name.
	 */
	saveState(): VsockSnapshot {
		const mounts = this.onSave?.();
		return { guestCid: this.guestCid, rxMax: this.rxMax, ...(mounts ? { mounts } : {}) };
	}

	/**
	 * A restored snapshot: the kernel does not call init again, so take the
	 * saved values and tell onInit, as init would. The kernel resets every
	 * connected socket after the restore that `keep` does not name
	 * (kwvsock's restore notifier), and any packet for an old connection
	 * gets an RST from VsockHost.
	 */
	restoreState(s: VsockSnapshot): void {
		this.probed = true;
		this.guestCid = s.guestCid >>> 0;
		this.rxMax = s.rxMax >>> 0;
		try { this.onInit?.(this.guestCid, this.rxMax); } catch {}
	}

	/** Drop what is queued (the kernel exited). */
	close(): void {
		this.#closed = true;
		this.#queue = [];
		this.#head = 0;
		clearTimeout(this.#retry);
		this.#retry = undefined;
	}
}

// ---------------------------------------------------------------------------
// The host's end of the protocol.

/** @internal A snapshot of a connection VsockHost made (its counters), or why it cannot be kept now. */
export function saveVsockConnection(c: VsockConnection): VsockConnSnapshot | string {
	return c instanceof Connection ? c.saveState() : "not a connection of this host";
}

/** Why a vsock operation failed: `code` is the errno name. */
export class VsockError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "VsockError";
		this.code = code;
	}
}

export interface VsockStats {
	/** Connections open now (connecting, established or closing). */
	open: number;
	/** Connections established, in either direction. */
	accepted: number;
	connected: number;
	/** Connection requests refused (by the guest: connect(); by the host: no listener, or a full backlog). */
	refused: number;
	/** Connections reset (RST sent or received while established). */
	resets: number;
	/** Payload bytes received from and sent to the guest. */
	bytesIn: number;
	bytesOut: number;
	/** Packets the guest sent that broke the protocol (beyond the credit, unknown types). */
	violations: number;
}

/** The surface both inline and worker mode give as `vm.vsock`. */
export interface Vsock {
	/** The guest's CID (3). Connections from the host's side go to this CID. */
	readonly guestCid: number;
	/**
	 * Accept guest connections to host port `port` (a guest program
	 * connects to CID 2, `port`). Connections go to `onConnection` if given,
	 * else they wait for accept() (or the listener's async iterator).
	 * Throws a VsockError EADDRINUSE if the port is taken.
	 */
	listen(port: number, onConnection?: (conn: VsockConnection) => void): VsockListener;
	/**
	 * Connect to a guest program listening on `port` (bound to any CID or
	 * to 3). Rejects with a VsockError: ECONNREFUSED (nothing listens),
	 * ETIMEDOUT (no answer within `timeout` ms, default 10000) or
	 * ECONNABORTED (the kernel exited).
	 */
	connect(port: number, opts?: { timeout?: number }): Promise<VsockConnection>;
	readonly stats: VsockStats;
}

export interface VsockListener extends AsyncIterable<VsockConnection> {
	readonly port: number;
	/** The next connection, or null once the listener is closed (or the kernel exited). */
	accept(): Promise<VsockConnection | null>;
	/** Stop listening: connections not accepted yet are reset, and new requests are refused. */
	close(): void;
}

/**
 * One stream connection. `readable` gives what the guest sends and ends
 * when the guest shuts down its sending side (or closes); `writable`
 * sends, and closing it shuts down the host's sending side (a half-close:
 * the guest reads EOF and may still send). Data is acknowledged to the
 * guest (credit) only as `readable` is read.
 */
export interface VsockConnection {
	/** The host side's port (the listener's, or the one connect() picked). */
	readonly localPort: number;
	/** The guest side's port. */
	readonly remotePort: number;
	readonly readable: ReadableStream<Uint8Array>;
	/** Strings are sent as UTF-8. A write resolves once its bytes are sent (the guest gave credit for them). */
	readonly writable: WritableStream<Uint8Array | string>;
	/**
	 * Close both directions: what was written is still sent, then the
	 * guest is told that the host neither sends nor receives (its reads
	 * get EOF, its writes EPIPE). Data not read yet is dropped.
	 */
	close(): void;
	/** Reset now (RST): pending data is dropped, the guest's writes fail with EPIPE and its reads end. */
	reset(): void;
	/** Settles once the connection is gone: "closed" (both sides shut down) or "reset" (by either side, or the kernel exited). */
	readonly closed: Promise<"closed" | "reset">;
}

export interface VsockHostOptions {
	/** Send a packet to the guest (VsockDevice.deliver, or across to the worker). */
	send: (pkt: Uint8Array) => void;
	/** The host's receive buffer per connection, the credit the guest gets (default 256 KiB). */
	bufferSize?: number;
	log?: (msg: string) => void;
}

interface TxItem {
	data: Uint8Array;
	at: number;
	resolve: () => void;
	reject: (e: Error) => void;
}

type ConnState = "connecting" | "established" | "closing" | "closed";

class Connection implements VsockConnection {
	readonly localPort: number;
	readonly remotePort: number;
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array | string>;
	readonly closed: Promise<"closed" | "reset">;
	state: ConnState;
	// Receiving.
	#rx: Uint8Array[] = [];
	#rxBytes = 0;
	#rxCnt = 0;
	#fwdCnt = 0;
	#sentFwd = 0;
	#rc!: ReadableStreamDefaultController<Uint8Array>;
	#wantRead = false;
	#readDone = false;
	#readCancelled = false;
	#peerShutSend = false;
	// Sending.
	#peerBufAlloc = 0;
	#peerFwdCnt = 0;
	#txCnt = 0;
	#tx: TxItem[] = [];
	#peerShutRcv = false;
	#shutSent = 0;
	#closeWanted = false;
	#creditAsked = false;
	#creditTimer: ReturnType<typeof setTimeout> | undefined;
	#resetErr: VsockError | undefined;
	#closeTimer: ReturnType<typeof setTimeout> | undefined;
	#resolveClosed!: (how: "closed" | "reset") => void;
	#host: VsockHost;
	#encoder: TextEncoder | undefined;
	/** connect(): settled by RESPONSE or RST. */
	onEstablished: ((err?: VsockError) => void) | undefined;

	constructor(host: VsockHost, localPort: number, remotePort: number, state: ConnState) {
		this.#host = host;
		this.localPort = localPort;
		this.remotePort = remotePort;
		this.state = state;
		this.closed = new Promise((r) => (this.#resolveClosed = r));
		this.readable = new ReadableStream<Uint8Array>({
			start: (c) => { this.#rc = c; },
			pull: () => {
				this.#wantRead = true;
				this.#pump();
			},
			cancel: () => {
				this.#readCancelled = true;
				this.#readDone = true;
				this.#consume(this.#rxBytes);
				this.#rx = [];
				this.#rxBytes = 0;
				this.#shutdown(VSOCK_SHUTDOWN_RCV);
			},
		}, { highWaterMark: 0 });
		this.writable = new WritableStream<Uint8Array | string>({
			write: (chunk) => this.#write(typeof chunk === "string" ? (this.#encoder ??= new TextEncoder()).encode(chunk) : chunk),
			close: () => this.#shutdown(VSOCK_SHUTDOWN_SEND),
			abort: () => this.reset(),
		});
	}

	/** Debug: what this connection is waiting for (a snapshot of its counters). */
	debug(): Record<string, unknown> {
		return {
			key: this.key, state: this.state,
			rx: this.#rx.length, rxBytes: this.#rxBytes, wantRead: this.#wantRead, readDone: this.#readDone,
			tx: this.#tx.length, peerBufAlloc: this.#peerBufAlloc, peerFwdCnt: this.#peerFwdCnt, txCnt: this.#txCnt,
			credit: this.#credit(), shutSent: this.#shutSent, peerShutRcv: this.#peerShutRcv, peerShutSend: this.#peerShutSend,
			closeWanted: this.#closeWanted, creditAsked: this.#creditAsked, reset: this.#resetErr?.code,
		};
	}

	get key(): string {
		return `${this.localPort}:${this.remotePort}`;
	}

	/**
	 * A snapshot keeps this connection: its credit counters, or why it
	 * cannot be kept now (data or a shutdown on the way, which the guest's
	 * memory and these counters would not agree on).
	 */
	saveState(): VsockConnSnapshot | string {
		if (this.state !== "established") return `the connection is ${this.state}`;
		if (this.#rx.length || this.#tx.length) return "data on the way";
		if (this.#shutSent || this.#peerShutSend || this.#peerShutRcv || this.#closeWanted) return "a shutdown on the way";
		return {
			localPort: this.localPort, remotePort: this.remotePort, rxCnt: this.#rxCnt, fwdCnt: this.#fwdCnt, sentFwd: this.#sentFwd,
			peerBufAlloc: this.#peerBufAlloc, peerFwdCnt: this.#peerFwdCnt, txCnt: this.#txCnt,
		};
	}

	/** A restore: take the saved counters (the connection is established, nothing on the way). */
	loadState(s: VsockConnSnapshot): void {
		this.#rxCnt = s.rxCnt >>> 0;
		this.#fwdCnt = s.fwdCnt >>> 0;
		this.#sentFwd = s.sentFwd >>> 0;
		this.#peerBufAlloc = s.peerBufAlloc >>> 0;
		this.#peerFwdCnt = s.peerFwdCnt >>> 0;
		this.#txCnt = s.txCnt >>> 0;
	}

	/** The fields every packet on this connection carries. */
	header(op: number, flags = 0): Omit<VsockHeader, "len"> {
		this.#sentFwd = this.#fwdCnt;
		return {
			srcCid: VSOCK_HOST_CID, dstCid: this.#host.guestCid, srcPort: this.localPort, dstPort: this.remotePort,
			type: VSOCK_TYPE_STREAM, op, flags, bufAlloc: this.#host.bufferSize, fwdCnt: this.#fwdCnt,
		};
	}

	#send(op: number, flags = 0, payload?: Uint8Array): void {
		this.#host.sendPacket(encodeVsockPacket(this.header(op, flags), payload));
	}

	/** A packet from the guest on this connection. */
	receive(h: VsockHeader, pkt: Uint8Array): void {
		const before = this.#credit();
		this.#peerBufAlloc = h.bufAlloc;
		this.#peerFwdCnt = h.fwdCnt;
		switch (h.op) {
		case VSOCK_OP_RESPONSE:
			if (this.state === "connecting") {
				this.state = "established";
				this.onEstablished?.();
				this.onEstablished = undefined;
			} else this.#violation("an unexpected RESPONSE");
			break;
		case VSOCK_OP_RW:
			if (h.len) this.#data(pkt.subarray(VSOCK_HEADER_SIZE, VSOCK_HEADER_SIZE + h.len));
			break;
		case VSOCK_OP_SHUTDOWN:
			if (h.flags & VSOCK_SHUTDOWN_SEND) {
				this.#peerShutSend = true;
				this.#pump();
			}
			if (h.flags & VSOCK_SHUTDOWN_RCV && !this.#peerShutRcv) {
				this.#peerShutRcv = true;
				this.#failWrites(new VsockError("EPIPE", "the guest shut down its receiving side"));
			}
			// Both sides of the guest are shut: answer with RST, as Linux does.
			if (this.#peerShutSend && this.#peerShutRcv) {
				this.#send(VSOCK_OP_RST);
				this.#end(false);
			}
			break;
		case VSOCK_OP_RST:
			if (this.state === "connecting") {
				this.onEstablished?.(new VsockError("ECONNREFUSED", `vsock connect to port ${this.remotePort}: refused by the guest`));
				this.onEstablished = undefined;
				this.#end(true, true);
			} else this.#end(!(this.#peerShutSend && (this.#shutSent & VSOCK_SHUTDOWN_SEND) || this.state === "closing"), true);
			return;
		case VSOCK_OP_CREDIT_REQUEST:
			this.#send(VSOCK_OP_CREDIT_UPDATE);
			break;
		case VSOCK_OP_CREDIT_UPDATE:
			break;
		default:
			this.#violation(`op ${h.op}`);
			return;
		}
		// Every packet carries the guest's credit. Ask again only once it grew
		// (an unchanged answer to CREDIT_REQUEST must not start a ping-pong).
		if (this.#credit() > before) this.#stallDone();
		this.#flush();
	}

	/** Bytes the guest can take now. */
	#credit(): number {
		return this.#peerBufAlloc - ((this.#txCnt - this.#peerFwdCnt) >>> 0);
	}

	#stallDone(): void {
		this.#creditAsked = false;
		clearTimeout(this.#creditTimer);
		this.#creditTimer = undefined;
	}

	#violation(what: string): void {
		this.#host.stats.violations++;
		this.#host.log(`[vsock] port ${this.localPort}<-${this.remotePort}: ${what}; resetting`);
		this.reset();
	}

	#data(bytes: Uint8Array): void {
		if (this.state !== "established" && this.state !== "closing") return;
		if (this.#rxBytes + bytes.length > this.#host.bufferSize) {
			this.#violation(`${bytes.length} bytes beyond the credit given`);
			return;
		}
		this.#rxCnt = (this.#rxCnt + bytes.length) >>> 0;
		this.#host.stats.bytesIn += bytes.length;
		if (this.#readCancelled || this.#readDone) {
			this.#consume(bytes.length);
			return;
		}
		this.#rx.push(bytes.slice());
		this.#rxBytes += bytes.length;
		this.#pump();
	}

	/** Hand the reader one chunk if it waits; end the stream when the guest sends no more. */
	#pump(): void {
		if (this.#readDone || !this.#wantRead) return;
		const chunk = this.#rx.shift();
		if (chunk) {
			this.#wantRead = false;
			this.#rxBytes -= chunk.length;
			this.#rc.enqueue(chunk);
			this.#consume(chunk.length);
			return;
		}
		if (this.#peerShutSend || this.state === "closed") {
			this.#readDone = true;
			if (this.#resetErr && !this.#peerShutSend) this.#rc.error(this.#resetErr);
			else this.#rc.close();
			this.#maybeFinish();
		}
	}

	/** The reader took `n` bytes: more credit for the guest, told when its view runs low. */
	#consume(n: number): void {
		this.#fwdCnt = (this.#fwdCnt + n) >>> 0;
		if (this.state !== "established") return;
		// The guest's window is the smaller of our buffer and its own: Linux caps
		// what it sends to its local buf_alloc (256 KiB by default,
		// virtio_transport_tx_buf_size()) and never asks for credit, so with a
		// larger buffer here a threshold on ours alone was never reached and the
		// guest stalled for good after 256 KiB (2026-11-14).
		const buf = Math.min(this.#host.bufferSize, this.#peerBufAlloc || this.#host.bufferSize);
		const peerFree = buf - ((this.#rxCnt - this.#sentFwd) >>> 0);
		if (peerFree < buf / 2 && this.#fwdCnt !== this.#sentFwd) this.#send(VSOCK_OP_CREDIT_UPDATE);
	}

	#write(data: Uint8Array): Promise<void> {
		if (this.#resetErr) return Promise.reject(this.#resetErr);
		if (this.#peerShutRcv) return Promise.reject(new VsockError("EPIPE", "the guest shut down its receiving side"));
		if (this.state === "closed" || this.#shutSent & VSOCK_SHUTDOWN_SEND || this.#closeWanted)
			return Promise.reject(new VsockError("EPIPE", "the connection is closed"));
		if (!data.length) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.#tx.push({ data: data.slice(), at: 0, resolve, reject });
			this.#flush();
		});
	}

	/** Send what the guest's credit allows. */
	#flush(): void {
		if (this.state !== "established") return;
		while (this.#tx.length) {
			const credit = this.#credit();
			if (credit <= 0) {
				// Linux sends an update by itself as its reader frees space; ask
				// once, and again every CREDIT_RETRY_MS while still stalled.
				if (!this.#creditAsked) {
					this.#creditAsked = true;
					this.#send(VSOCK_OP_CREDIT_REQUEST);
					this.#creditTimer = setTimeout(() => {
						this.#creditAsked = false;
						this.#creditTimer = undefined;
						this.#flush();
					}, CREDIT_RETRY_MS);
				}
				return;
			}
			const item = this.#tx[0]!;
			const n = Math.min(credit, this.#host.maxPayload, item.data.length - item.at);
			this.#send(VSOCK_OP_RW, 0, item.data.subarray(item.at, item.at + n));
			this.#txCnt = (this.#txCnt + n) >>> 0;
			this.#host.stats.bytesOut += n;
			item.at += n;
			if (item.at === item.data.length) {
				this.#tx.shift();
				item.resolve();
			}
		}
		if (this.#closeWanted) this.#shutdown(VSOCK_SHUTDOWN_RCV | VSOCK_SHUTDOWN_SEND);
	}

	#failWrites(e: VsockError): void {
		const tx = this.#tx;
		this.#tx = [];
		for (const t of tx) t.reject(e);
	}

	/** Tell the guest about a shutdown (once the data written is out, for SEND). */
	#shutdown(flags: number): void {
		if (this.state === "closed") return;
		if (this.state === "connecting") {
			this.reset();
			return;
		}
		if (flags & VSOCK_SHUTDOWN_SEND && this.#tx.length) {
			this.#closeWanted = true; // #flush() comes back here
			return;
		}
		const add = flags & ~this.#shutSent;
		if (!add) return;
		this.#shutSent |= add;
		this.#send(VSOCK_OP_SHUTDOWN, this.#shutSent);
		this.#maybeFinish();
	}

	/** Both directions done: shut both down, and wait (a while) for the guest's RST. */
	#maybeFinish(): void {
		if (this.state !== "established") return;
		const sending = !(this.#shutSent & VSOCK_SHUTDOWN_SEND) && !this.#peerShutRcv;
		if (sending || !this.#readDone) return;
		if (this.#shutSent !== (VSOCK_SHUTDOWN_RCV | VSOCK_SHUTDOWN_SEND)) {
			this.#shutSent = VSOCK_SHUTDOWN_RCV | VSOCK_SHUTDOWN_SEND;
			this.#send(VSOCK_OP_SHUTDOWN, this.#shutSent);
		}
		this.state = "closing";
		this.#closeTimer = setTimeout(() => {
			if (this.state === "closing") this.reset();
		}, CLOSE_TIMEOUT_MS);
	}

	close(): void {
		if (this.state === "closed") return;
		if (!this.#readDone) {
			this.#readDone = true;
			this.#readCancelled = true;
			this.#consume(this.#rxBytes);
			this.#rx = [];
			this.#rxBytes = 0;
			try { this.#rc.close(); } catch {}
		}
		this.#closeWanted = true;
		this.#flush();
		if (!this.#tx.length) this.#shutdown(VSOCK_SHUTDOWN_RCV | VSOCK_SHUTDOWN_SEND);
	}

	reset(): void {
		if (this.state === "closed") return;
		this.#send(VSOCK_OP_RST);
		if (this.state === "connecting") {
			this.onEstablished?.(new VsockError("ECONNABORTED", "connect aborted"));
			this.onEstablished = undefined;
		}
		this.#end(true);
	}

	/** The kernel exited. */
	abort(): void {
		if (this.state === "closed") return;
		if (this.state === "connecting") {
			this.onEstablished?.(new VsockError("ECONNABORTED", "the kernel exited"));
			this.onEstablished = undefined;
		}
		this.#end(true, true, new VsockError("ECONNABORTED", "the kernel exited"));
	}

	/** The connection is gone: as a reset (data not read yet is still delivered first), or after an orderly close. */
	#end(reset: boolean, byPeer = false, err?: VsockError): void {
		if (this.state === "closed") return;
		const wasEstablished = this.state !== "connecting";
		this.state = "closed";
		clearTimeout(this.#closeTimer);
		this.#stallDone();
		this.#host.forget(this);
		if (reset && wasEstablished) this.#host.stats.resets++;
		if (reset) this.#resetErr = err ?? new VsockError("ECONNRESET", byPeer ? "the guest reset the connection" : "the connection was reset");
		this.#failWrites(this.#resetErr ?? new VsockError("EPIPE", "the connection is closed"));
		if (!this.#peerShutSend && !reset) this.#peerShutSend = true; // an orderly end: EOF after the data
		if (reset && !byPeer) {
			// Reset here: the reader gets the error at once.
			this.#rx = [];
			this.#rxBytes = 0;
			if (!this.#readDone) {
				this.#readDone = true;
				try { this.#rc.error(this.#resetErr); } catch {}
			}
		} else this.#pump();
		try { this.writable.abort?.(this.#resetErr).catch(() => {}); } catch {}
		this.#resolveClosed(reset ? "reset" : "closed");
	}
}

class Listener implements VsockListener {
	readonly port: number;
	#host: VsockHost;
	#queue: Connection[] = [];
	#waiters: Array<(c: Connection | null) => void> = [];
	#handler: ((conn: VsockConnection) => void) | undefined;
	closed = false;

	constructor(host: VsockHost, port: number, handler?: (conn: VsockConnection) => void) {
		this.#host = host;
		this.port = port;
		this.#handler = handler;
	}

	/** Room for one more connection? */
	get full(): boolean {
		return !this.#handler && !this.#waiters.length && this.#queue.length >= BACKLOG;
	}

	offer(conn: Connection): void {
		if (this.#handler) {
			const h = this.#handler;
			queueMicrotask(() => {
				try { h(conn); } catch (e) { this.#host.log(`[vsock] listener on port ${this.port} threw: ${errorText(e)}`); }
			});
			return;
		}
		const w = this.#waiters.shift();
		if (w) w(conn);
		else this.#queue.push(conn);
	}

	accept(): Promise<VsockConnection | null> {
		const c = this.#queue.shift();
		if (c) return Promise.resolve(c);
		if (this.closed) return Promise.resolve(null);
		return new Promise((r) => this.#waiters.push(r));
	}

	async *[Symbol.asyncIterator](): AsyncIterator<VsockConnection> {
		for (;;) {
			const c = await this.accept();
			if (!c) return;
			yield c;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.#host.unlisten(this);
		for (const c of this.#queue) c.reset();
		this.#queue = [];
		for (const w of this.#waiters) w(null);
		this.#waiters = [];
	}
}

/**
 * The host's end of the vsock protocol (CID 2): see the top of this file.
 * Give it the guest's packets with receive(); it sends through `send`.
 */
export class VsockHost implements Vsock {
	/** The guest's CID (from the kernel's init; 3 until then). */
	guestCid = VSOCK_GUEST_CID;
	/** The credit each connection gives the guest. */
	readonly bufferSize: number;
	/** Payload per packet to the guest (the kernel's limit, once known, less the header). */
	maxPayload = 16384;
	stats: VsockStats = { open: 0, accepted: 0, connected: 0, refused: 0, resets: 0, bytesIn: 0, bytesOut: 0, violations: 0 };
	readonly log: (msg: string) => void;
	#send: (pkt: Uint8Array) => void;
	#conns = new Map<string, Connection>();
	#listeners = new Map<number, Listener>();
	#nextPort = FIRST_HOST_PORT;
	#down: string | undefined;

	constructor(opts: VsockHostOptions) {
		this.#send = opts.send;
		this.bufferSize = Math.max(4096, Math.min(opts.bufferSize ?? 256 * 1024, 0x7fffffff)) >>> 0;
		this.log = opts.log ?? (() => {});
	}

	/** The kernel's driver started (VsockDevice onInit). */
	deviceReady(guestCid: number, rxMax: number): void {
		this.guestCid = guestCid;
		if (rxMax > VSOCK_HEADER_SIZE) this.maxPayload = Math.min(rxMax - VSOCK_HEADER_SIZE, 65536);
	}

	/** @internal */
	sendPacket(pkt: Uint8Array): void {
		if (!this.#down) this.#send(pkt);
	}

	/** @internal */
	forget(conn: Connection): void {
		if (this.#conns.get(conn.key) === conn) {
			this.#conns.delete(conn.key);
			this.stats.open = this.#conns.size;
		}
	}

	/** @internal */
	unlisten(l: Listener): void {
		if (this.#listeners.get(l.port) === l) this.#listeners.delete(l.port);
	}

	#check(port: number): void {
		if (!Number.isInteger(port) || port < 0 || port >= 0xffffffff) throw new VsockError("EINVAL", `vsock port ${port}: not a port (0 to 2^32 - 2)`);
	}

	listen(port: number, onConnection?: (conn: VsockConnection) => void): VsockListener {
		this.#check(port);
		if (this.#down) throw new VsockError("ECONNABORTED", this.#down);
		if (this.#listeners.has(port)) throw new VsockError("EADDRINUSE", `vsock port ${port} is already listening`);
		const l = new Listener(this, port, onConnection);
		this.#listeners.set(port, l);
		return l;
	}

	connect(port: number, opts: { timeout?: number } = {}): Promise<VsockConnection> {
		this.#check(port);
		if (this.#down) return Promise.reject(new VsockError("ECONNABORTED", this.#down));
		let local = this.#nextPort;
		while (this.#listeners.has(local) || this.#conns.has(`${local}:${port}`)) local = local >= 0xfffffffe ? FIRST_HOST_PORT : local + 1;
		this.#nextPort = local >= 0xfffffffe ? FIRST_HOST_PORT : local + 1;
		const conn = new Connection(this, local, port, "connecting");
		this.#conns.set(conn.key, conn);
		this.stats.open = this.#conns.size;
		const timeout = opts.timeout ?? 10000;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (conn.state !== "connecting") return;
				conn.onEstablished = undefined;
				conn.reset();
				reject(new VsockError("ETIMEDOUT", `vsock connect to port ${port}: no answer from the guest in ${timeout} ms`));
			}, timeout);
			conn.onEstablished = (err) => {
				clearTimeout(timer);
				if (err) {
					if (err.code === "ECONNREFUSED") this.stats.refused++;
					reject(err);
				} else {
					this.stats.connected++;
					resolve(conn);
				}
			};
			this.sendPacket(encodeVsockPacket(conn.header(VSOCK_OP_REQUEST)));
		});
	}

	/**
	 * @internal A restore (before the kernel runs): take over a connection
	 * the snapshot kept, with its counters. The restored kernel keeps it
	 * (VsockDevice.keep) and resets every other.
	 */
	adopt(s: VsockConnSnapshot): VsockConnection {
		if (this.#down) throw new VsockError("ECONNABORTED", this.#down);
		const c = new Connection(this, s.localPort >>> 0, s.remotePort >>> 0, "established");
		if (this.#conns.has(c.key)) throw new VsockError("EADDRINUSE", `vsock connection ${c.key} exists`);
		c.loadState(s);
		this.#conns.set(c.key, c);
		this.stats.open = this.#conns.size;
		return c;
	}

	/** RST in answer to a packet that has no connection. */
	#refuse(h: VsockHeader): void {
		if (h.op === VSOCK_OP_RST) return;
		this.sendPacket(encodeVsockPacket({
			srcCid: VSOCK_HOST_CID, dstCid: h.srcCid, srcPort: h.dstPort, dstPort: h.srcPort,
			type: h.type, op: VSOCK_OP_RST, flags: 0, bufAlloc: 0, fwdCnt: 0,
		}));
	}

	/** A packet from the guest. */
	receive(pkt: Uint8Array): void {
		if (this.#down || pkt.length < VSOCK_HEADER_SIZE) return;
		const h = decodeVsockHeader(pkt);
		if (h.dstCid !== VSOCK_HOST_CID || h.len !== pkt.length - VSOCK_HEADER_SIZE) {
			this.stats.violations++;
			return;
		}
		if (h.type !== VSOCK_TYPE_STREAM) {
			this.stats.violations++;
			this.#refuse(h);
			return;
		}
		const conn = this.#conns.get(`${h.dstPort}:${h.srcPort}`);
		if (conn) {
			if (h.op === VSOCK_OP_REQUEST) conn.reset();
			else conn.receive(h, pkt);
			return;
		}
		if (h.op !== VSOCK_OP_REQUEST) {
			this.#refuse(h);
			return;
		}
		const l = this.#listeners.get(h.dstPort);
		if (!l || l.full) {
			this.stats.refused++;
			this.#refuse(h);
			return;
		}
		const c = new Connection(this, h.dstPort, h.srcPort, "established");
		this.#conns.set(c.key, c);
		this.stats.open = this.#conns.size;
		this.stats.accepted++;
		c.receive({ ...h, op: VSOCK_OP_CREDIT_UPDATE }, pkt); // the guest's credit
		this.sendPacket(encodeVsockPacket(c.header(VSOCK_OP_RESPONSE)));
		l.offer(c);
	}

	/** Debug: every connection's state (nothing while the host is down). */
	debug(): unknown {
		return {
			guestCid: this.guestCid, maxPayload: this.maxPayload, down: this.#down,
			connections: [...this.#conns.values()].map((c) => c.debug()),
		};
	}

	/** The kernel exited: every connection ends (ECONNABORTED), listeners return null. */
	shutdown(reason = "the kernel exited"): void {
		if (this.#down) return;
		this.#down = reason;
		for (const c of [...this.#conns.values()]) c.abort();
		this.#conns.clear();
		this.stats.open = 0;
		for (const l of [...this.#listeners.values()]) l.close();
	}
}
