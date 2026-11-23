// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// HTTP/1.1 into the guest: fetchOver(connect, input, init) sends one
// request over a byte stream to a server on the guest's 127.0.0.1:<port>
// and returns a real Response whose body streams. It knows nothing about
// the transport: `connect` gives a pair of web streams (vm.connect(port),
// kwtty splicing a guest TCP connection with vsock, in the SDK).
//
// One connection per request (`Connection: close`), no redirects followed,
// no keep-alive, no TLS. The URL's host goes only into the Host header; the
// connection always goes to the guest's loopback port. A body of known
// length goes with Content-Length, a stream body chunked. The host never
// half-closes before the response is in, since the far side may take EOF
// as the end of the connection. The response body is pulled from the
// connection only as the consumer reads it, so vsock credit follows the
// reader.

/** A byte stream to a server in the guest. */
export interface ByteDuplex {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}

/** Open a byte stream to the guest's 127.0.0.1:<port>. */
export type GuestConnect = (port: number, opts: { signal?: AbortSignal }) => Promise<ByteDuplex>;

/** The largest status line plus header block accepted, interim responses included. */
export const HTTP_MAX_HEADER_BYTES = 64 * 1024;

const MAX_CHUNK_LINE = 4096;
const NO_BODY_STATUS = new Set([204, 205, 304]);
/** Request headers fetchOver sets itself, or that would break its framing. */
const SKIP_REQUEST = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "content-length", "upgrade", "te", "trailer"]);
/** Hop-by-hop response headers that do not belong on a Response. */
const SKIP_RESPONSE = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "trailer", "upgrade"]);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REASON = /^[\t\x20-\x7e\x80-\xff]*$/;
const EMPTY = new Uint8Array(0);
const noop = () => {};

const malformed = (what: string) => new TypeError(`fetchOver: malformed response: ${what}`);

/** Bytes to a string, one char per byte (headers are byte strings). */
function latin1(b: Uint8Array): string {
	let s = "";
	for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
	return s;
}

function latin1Bytes(s: string): Uint8Array {
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return b;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/** A buffered reader over the connection's readable. */
class Input {
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
	#buf: Uint8Array = EMPTY;
	eof = false;
	/** Bytes consumed by readLine(). */
	lineBytes = 0;

	constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
		this.#reader = reader;
	}

	get buffered(): number {
		return this.#buf.length;
	}

	/** Read one more chunk from the connection; false at EOF. */
	async more(): Promise<boolean> {
		while (!this.eof) {
			const { done, value } = await this.#reader.read();
			if (done) {
				this.eof = true;
				break;
			}
			if (!value.length) continue;
			this.#buf = this.#buf.length ? concat(this.#buf, value) : value;
			return true;
		}
		return false;
	}

	/** Up to n buffered bytes. */
	take(n: number): Uint8Array {
		const b = this.#buf;
		if (n >= b.length) {
			this.#buf = EMPTY;
			return b;
		}
		this.#buf = b.subarray(n);
		return b.subarray(0, n);
	}

	/** The next line without its LF or CRLF, or null at EOF; throws past `max` bytes. */
	async readLine(max: number): Promise<string | null> {
		let from = 0;
		for (;;) {
			const i = this.#buf.indexOf(10, from);
			if (i > max || (i < 0 && this.#buf.length > max)) throw new TypeError(`fetchOver: response header block over ${HTTP_MAX_HEADER_BYTES} bytes, or a line too long`);
			if (i >= 0) {
				const line = this.take(i + 1);
				this.lineBytes += line.length;
				const end = line.length >= 2 && line[line.length - 2] === 13 ? line.length - 2 : line.length - 1;
				return latin1(line.subarray(0, end));
			}
			from = this.#buf.length;
			if (!(await this.more())) return null;
		}
	}
}

interface Head {
	status: number;
	statusText: string;
	headers: Array<[string, string]>;
}

/** One response head: status line and header lines. */
async function readHead(input: Input): Promise<Head> {
	const left = () => HTTP_MAX_HEADER_BYTES - input.lineBytes;
	let line = await input.readLine(left());
	while (line === "") line = await input.readLine(left()); // stray CRLFs before a status line
	if (line === null) throw new TypeError("fetchOver: the connection closed before a response");
	const m = /^HTTP\/1\.[01] ([1-9]\d\d)(?: (.*))?$/.exec(line);
	if (!m) throw malformed(`status line ${JSON.stringify(line.slice(0, 80))}`);
	const status = Number(m[1]);
	const reason = m[2] ?? "";
	const head: Head = { status, statusText: REASON.test(reason) ? reason : "", headers: [] };
	for (;;) {
		line = await input.readLine(left());
		if (line === null) throw new TypeError("fetchOver: the connection closed inside the response headers");
		if (line === "") return head;
		const colon = line.indexOf(":");
		const name = colon > 0 ? line.slice(0, colon) : "";
		if (!TOKEN.test(name)) throw malformed(`header line ${JSON.stringify(line.slice(0, 80))}`);
		head.headers.push([name.toLowerCase(), line.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/g, "")]);
	}
}

/** Is `body` (from RequestInit) of a length known up front? */
function knownLength(body: unknown): boolean {
	return typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams
		|| (typeof Blob !== "undefined" && body instanceof Blob) || (typeof FormData !== "undefined" && body instanceof FormData);
}

/** The response body's framing. */
type Framing = { kind: "none" } | { kind: "length"; length: number } | { kind: "chunked" } | { kind: "eof" };

function framing(method: string, status: number, headers: Array<[string, string]>): Framing {
	if (method === "HEAD" || NO_BODY_STATUS.has(status)) return { kind: "none" };
	const te = headers.filter(([n]) => n === "transfer-encoding").map(([, v]) => v).join(",");
	if (te) {
		const codings = te.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
		return codings[codings.length - 1] === "chunked" ? { kind: "chunked" } : { kind: "eof" };
	}
	const cl = headers.filter(([n]) => n === "content-length").flatMap(([, v]) => v.split(",").map((x) => x.trim()));
	if (cl.length) {
		if (!cl.every((v) => /^\d{1,15}$/.test(v) && v === cl[0])) throw malformed(`Content-Length ${JSON.stringify(cl.join(", "))}`);
		return { kind: "length", length: Number(cl[0]) };
	}
	return { kind: "eof" };
}

function signalReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * Fetch from a server in the guest: always connects to the guest's
 * 127.0.0.1:<port>, the URL's port (default 80). Only http: URLs. The
 * hostname goes only into the Host header. Takes what fetch() takes; a
 * Request's own body is read in full first and sent with Content-Length,
 * a ReadableStream (or other streaming) `init.body` is sent chunked.
 * Redirects are returned, not followed. Rejects 101 Switching Protocols.
 */
export async function fetchOver(connect: GuestConnect, input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const streaming = init?.body != null && !knownLength(init.body);
	const req = new Request(input, streaming && !("duplex" in init!) ? ({ ...init, duplex: "half" } as RequestInit) : init);
	const url = new URL(req.url);
	if (url.protocol !== "http:") throw new TypeError(`fetchOver: only http: URLs are supported, not ${url.protocol}`);
	const port = url.port ? Number(url.port) : 80;
	const method = req.method;
	const signal = req.signal;
	if (signal.aborted) throw signalReason(signal);

	// Body: bytes of known length, or a stream to send chunked.
	let bodyBytes: Uint8Array | null = null;
	let bodyStream: ReadableStream<Uint8Array> | null = null;
	if (req.body) {
		if (streaming) bodyStream = req.body;
		else bodyBytes = new Uint8Array(await req.arrayBuffer());
	}

	let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${req.headers.get("host") ?? url.host}\r\n`;
	for (const [name, value] of req.headers) {
		if (name === "host" || SKIP_REQUEST.has(name)) continue;
		head += `${name}: ${value}\r\n`;
	}
	if (!req.headers.has("accept-encoding")) head += "Accept-Encoding: identity\r\n";
	if (bodyStream) head += "Transfer-Encoding: chunked\r\n";
	else if (bodyBytes) head += `Content-Length: ${bodyBytes.length}\r\n`;
	else if (method === "POST" || method === "PUT" || method === "PATCH") head += "Content-Length: 0\r\n";
	head += "Connection: close\r\n\r\n";
	const headBytes = latin1Bytes(head);

	// Connect, unless aborted first (a connect that ignores the signal is closed when it lands).
	if (signal.aborted) throw signalReason(signal);
	let onConnectAbort = noop;
	const aborted = new Promise<never>((_, reject) => {
		onConnectAbort = () => reject(signalReason(signal));
		signal.addEventListener("abort", onConnectAbort, { once: true });
	});
	const pending = connect(port, { signal });
	let duplex: ByteDuplex;
	try {
		duplex = await Promise.race([pending, aborted]);
	} catch (e) {
		pending.then((d) => { d.writable.abort(e).catch(noop); d.readable.cancel(e).catch(noop); }, noop);
		throw e;
	} finally {
		signal.removeEventListener("abort", onConnectAbort);
	}

	const writer = duplex.writable.getWriter();
	const reader = duplex.readable.getReader();
	const conn = new Input(reader);
	let failure: unknown;
	let finished = false;
	let uploadDone = false;
	let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let failBody: (e: unknown) => void = noop;

	/** Close the connection: in order once the response is in, else (an error, an abort, a cancel) at once. */
	const finish = (error?: unknown) => {
		if (finished) return;
		finished = true;
		signal.removeEventListener("abort", onAbort);
		source?.cancel(error).catch(noop);
		if (error === undefined && uploadDone) writer.close().catch(noop);
		else writer.abort(error).catch(noop);
		reader.cancel(error).catch(noop);
	};
	const fail = (e: unknown) => {
		if (finished) return;
		failure ??= e;
		failBody(e);
		finish(e);
	};
	const onAbort = () => fail(signalReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });

	// Send the request while the response is read, so an early response is not stuck behind the upload.
	void (async () => {
		try {
			if (bodyBytes && bodyBytes.length <= 65536) await writer.write(concat(headBytes, bodyBytes));
			else {
				await writer.write(headBytes);
				if (bodyBytes) await writer.write(bodyBytes);
			}
			if (bodyStream) {
				source = bodyStream.getReader();
				if (finished) source.cancel(failure).catch(noop);
				for (;;) {
					let r: ReadableStreamReadResult<Uint8Array>;
					try {
						r = await source.read();
					} catch (e) {
						fail(e); // the caller's body stream failed: the request cannot complete
						return;
					}
					if (r.done) break;
					if (!r.value.length) continue;
					const size = latin1Bytes(`${r.value.length.toString(16)}\r\n`);
					const frame = new Uint8Array(size.length + r.value.length + 2);
					frame.set(size);
					frame.set(r.value, size.length);
					frame.set([13, 10], frame.length - 2);
					await writer.write(frame);
				}
				await writer.write(latin1Bytes("0\r\n\r\n"));
			}
			uploadDone = true;
		} catch {
			// A failed write: the server closed early. Reading the response tells what happened.
		}
	})();

	let res!: Head;
	let body!: Framing;
	try {
		for (;;) {
			res = await readHead(conn);
			if (res.status === 101) throw new TypeError("fetchOver: 101 Switching Protocols (an upgrade) is not supported");
			if (res.status >= 200) break;
		}
		if (res.status > 599) throw malformed(`status ${res.status}`);
		body = framing(method, res.status, res.headers);
	} catch (e) {
		fail(e);
		throw failure;
	}
	if (finished) throw failure;

	const headers = new Headers();
	const connectionTokens = new Set(res.headers.filter(([n]) => n === "connection").flatMap(([, v]) => v.split(",").map((t) => t.trim().toLowerCase())));
	try {
		for (const [name, value] of res.headers) {
			if (SKIP_RESPONSE.has(name) || connectionTokens.has(name)) continue;
			if (name === "content-length" && body.kind !== "length") continue;
			headers.append(name, value);
		}
	} catch {
		const e = malformed("a header value Headers does not accept");
		fail(e);
		throw e;
	}

	if (body.kind === "none") {
		finish();
		return new Response(null, { status: res.status, statusText: res.statusText, headers });
	}

	let left = body.kind === "length" ? body.length : 0;
	let chunkState: "size" | "data" | "crlf" | "trailers" = "size";
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const truncated = () => new TypeError("fetchOver: the connection closed before the end of the response body");
	const done = () => {
		finish();
		try { controller.close(); } catch {}
	};

	const pull = async (): Promise<void> => {
		for (;;) {
			if (finished) return;
			switch (body.kind) {
				case "eof":
					if (!conn.buffered && !(await conn.more())) return done();
					return controller.enqueue(conn.take(Infinity));
				case "length":
					if (!left) return done();
					if (!conn.buffered && !(await conn.more())) throw truncated();
					{
						const piece = conn.take(left);
						left -= piece.length;
						controller.enqueue(piece);
					}
					if (!left) done();
					return;
				case "chunked":
					if (chunkState === "size") {
						const line = await conn.readLine(MAX_CHUNK_LINE);
						if (line === null) throw truncated();
						const m = /^([0-9a-fA-F]{1,13})[\t ]*(?:;.*)?$/.exec(line);
						if (!m) throw malformed(`chunk size line ${JSON.stringify(line.slice(0, 80))}`);
						left = parseInt(m[1]!, 16);
						chunkState = left ? "data" : "trailers";
						continue;
					}
					if (chunkState === "data") {
						if (!conn.buffered && !(await conn.more())) throw truncated();
						const piece = conn.take(left);
						left -= piece.length;
						if (!left) chunkState = "crlf";
						return controller.enqueue(piece);
					}
					if (chunkState === "crlf") {
						const line = await conn.readLine(2);
						if (line === null) throw truncated();
						if (line !== "") throw malformed("no CRLF after a chunk");
						chunkState = "size";
						continue;
					}
					{
						// Trailers: skipped up to the empty line (or EOF, tolerated after the last chunk).
						const line = await conn.readLine(HTTP_MAX_HEADER_BYTES);
						if (line === null || line === "") return done();
						continue;
					}
			}
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		start: (c) => {
			controller = c;
			failBody = (e) => { try { c.error(e); } catch {} };
		},
		pull: async () => {
			try {
				await pull();
			} catch (e) {
				fail(e);
			}
		},
		cancel: (reason) => {
			failBody = noop;
			finish(reason ?? new DOMException("The response body was cancelled", "AbortError"));
		},
	}, { highWaterMark: 0 });

	return new Response(stream, { status: res.status, statusText: res.statusText, headers });
}
