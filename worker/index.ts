/**
 * A Rust + Axum hello world running in Cloudflare Workers.
 *
 * The Axum server is a fully static aarch64 musl binary that runs inside a
 * real Linux kernel compiled to WebAssembly (unkernel, pithings/unkernel).
 * The kernel boots once per isolate; then every request is proxied to the
 * guest's loopback port 3000 over the kernel's vsock channel. The binary is
 * packed into the guest's initrd by scripts/kernel-prep.mjs, so the isolate
 * only has to boot the kernel and exec the server: no mount, no data module.
 *
 * Boot runs from the first request, not from the module body: Workerd forbids
 * async work, timers and random values in global scope ("Disallowed operation
 * called within global scope"), and the kernel needs random_get() to boot, so
 * an isolate cannot start the VM until a handler is running.
 *
 * One VM serves every request in the isolate, but only one request at a time
 * may drive it: the kernel is one suspended wasm stack, and workerd ties the
 * continuations that resume it to the request that created them. The unit of
 * scheduling is therefore a turn, not a request. A turn's driver (the request
 * at the head of the queue) runs a batch of guest connections concurrently in
 * its own context, the way the guest's own async server would; the requests
 * behind it poll for the buffered answers instead of driving the VM. That is
 * both faster (one turn drains many requests) and safer (no continuation ever
 * crosses a request boundary except the VM's own, which the compatibility
 * flag covers). See README.md, "Concurrency".
 */

import { createKernel } from "./kernel";
import type { KernelInstance } from "../sdk/index.ts";

/** Where scripts/kernel-prep.mjs packs the binary into the guest's initrd. */
const GUEST_FILE = "/hello/axum-hello";
/** The port the guest server listens on (rust/src/main.rs). */
const GUEST_PORT = 3000;
/** How long the server may take to bind before boot is considered failed. */
const READY_TIMEOUT_MS = 10000;
/** No response head by then marks this VM dead (see recycle()). Bodies are not bounded. */
const GUEST_TIMEOUT_MS = 3000;
/** Requests one turn may serve at once, all driven from the same context. */
const MAX_BATCH = 16;
/** A response larger than this cannot be handed to another request, so it streams. */
const MAX_BATCH_BYTES = 256 * 1024;

interface Guest {
  vm: KernelInstance;
}

/** The part of Cloudflare's ExecutionContext this Worker uses. */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** A response the guest produced for one job. */
interface Served {
  status: number;
  statusText: string;
  headers: Headers;
  /** The buffered body, or null when `stream` carries it instead. */
  bytes: Uint8Array<ArrayBuffer> | null;
  /** The driver's own response body, still coming from the guest. */
  stream?: ReadableStream<Uint8Array> | null;
  /** Time from the turn starting to the response head (diagnostics). */
  ttfbMs: number;
}

/** What runJob() decided for one job. */
type RunResult =
  | { kind: "buffered"; served: Served }
  | { kind: "stream"; served: Served }
  | { kind: "defer" }
  | { kind: "aborted" };

interface JobResult extends Served {
  /** Time from enqueueing to the turn that served it starting (diagnostics). */
  queueMs: number;
  /** How many requests that turn carried (diagnostics). */
  batch: number;
}

interface Job {
  id: number;
  method: string;
  /** The guest URL (loopback, path and query from the client). */
  url: string;
  headers: Headers;
  body?: ArrayBuffer;
  /** The client's request signal: an abort drops the job from the queue. */
  signal: AbortSignal;
  queuedAt: number;
  /** GET/HEAD/OPTIONS without a body: safe to batch and to retry. */
  batchable: boolean;
  attempts: number;
  done: boolean;
  result?: JobResult;
  error?: unknown;
}

let guest: Guest | undefined;
let bootPromise: Promise<Guest> | undefined;

/**
 * The turn queue. Only the head may drive, and only while no turn is active;
 * everyone else polls its own job with a short timer (a promise resolved by
 * another request's turn is exactly what workerd cancels).
 */
let queue: Job[] = [];
let leaseOwner: number | null = null;
let nextJobId = 0;
const turnStats = { turns: 0, batched: 0, requests: 0 };

/**
 * A request that only reads: running it with others is safe, and if its
 * response cannot be buffered it can be replayed in its own turn. Unsafe
 * methods keep the exclusive lane so a response that does not fit is never
 * produced twice.
 */
function isBatchable(method: string, body: ArrayBuffer | undefined): boolean {
  return (
    (method === "GET" || method === "HEAD" || method === "OPTIONS") &&
    (!body || body.byteLength === 0)
  );
}

/** Polling backoff for waiters (ms): the head checks at once, the rest back off. */
function pollDelay(polls: number): number {
  return Math.min(1 + (polls >> 2), 4);
}

const noop = () => {};

/**
 * The one boot of this isolate. Every caller gets the same promise; a boot
 * that fails is dropped so the next request tries again instead of awaiting
 * a failure forever.
 */
function ensureBoot(ctx: ExecutionContextLike): Promise<Guest> {
  if (guest) return Promise.resolve(guest);
  if (!bootPromise) {
    const p = boot().then((g) => {
      guest = g;
      return g;
    });
    bootPromise = p;
    // A boot is ~60-85 ms, but keep it alive if this request is cancelled:
    // otherwise its continuations are dropped and bootPromise never settles.
    ctx.waitUntil(p.then(() => {}, () => {}));
    // Handle the rejection so a boot that fails before a caller awaits it
    // does not surface as an unhandled rejection.
    p.catch(() => {
      if (bootPromise === p) bootPromise = undefined;
    });
  }
  return bootPromise;
}

/**
 * Drop a VM that stopped answering. A guest that has not started a response in
 * GUEST_TIMEOUT_MS is replaced: the turn is replayed once on the new kernel
 * (~85 ms), and the queued requests wait for that instead of failing.
 */
function recycle(g: Guest, why: string): void {
  if (guest !== g) return; // already replaced by another request
  guest = undefined;
  bootPromise = undefined;
  console.error(`[unkernel-rs] recycling the guest VM: ${why}`);
  void g.vm.stop().catch(() => {});
}

/**
 * Drive the head of the queue, and the batchable requests behind it, in this
 * request's context.
 *
 * Every guest call here belongs to the same request, which is what workerd
 * allows: one context may run many guest connections, two contexts may not
 * share the VM. Jobs are answered with a plain value and their waiters poll
 * for it; only the driver's own streaming body keeps the VM past this return.
 */
async function driveTurn(self: Job, ctx: ExecutionContextLike): Promise<void> {
  leaseOwner = self.id;
  // The driver's own body may still be streaming when the turn ends: hold the
  // VM until its trace says the body ended (or the client went away).
  const streamTrace = { hold: false, finished: false, released: false };
  const release = () => {
    if (streamTrace.released) return;
    streamTrace.released = true;
    leaseOwner = null;
  };
  let holdsLease = false;

  try {
    let g: Guest;
    try {
      g = await ensureBoot(ctx);
    } catch (e) {
      self.error = e;
      self.done = true;
      return;
    }

    const taken: Job[] = [self];
    if (self.batchable) {
      // Incoming requests reach the isolate one event-loop turn at a time, so
      // the first job of a burst usually becomes the head alone. When others
      // are already queued behind us, give the rest of the burst a millisecond
      // to arrive: the head pays it once, and the batch serves them all. A
      // lone request never waits.
      if (queue.length > 1) await new Promise<void>((r) => setTimeout(r, 1));
      for (let i = 1; i < queue.length && taken.length < MAX_BATCH; i++) {
        const j = queue[i];
        // Strict FIFO: an unsafe request ends the batch rather than being
        // overtaken by the safe ones behind it.
        if (!j.batchable || j.signal.aborted) break;
        taken.push(j);
      }
    }
    queue = queue.filter((j) => !taken.includes(j));

    const startedAt = Date.now();
    const settled = await Promise.allSettled(
      taken.map((j) =>
        runJob(j, g, j === self, startedAt, () => {
          streamTrace.finished = true;
          if (streamTrace.hold) release();
        }),
      ),
    );
    turnStats.turns++;
    turnStats.requests += taken.length;
    if (taken.length > 1) turnStats.batched++;

    const failures = settled.filter((r) => r.status === "rejected");
    if (failures.length === taken.length && !taken.every((j) => j.signal.aborted)) {
      // Nothing in the turn answered: the VM is gone. Replace it and replay
      // the turn once on the fresh kernel (the old per-request safety net).
      if (self.attempts === 0) {
        for (const j of taken) j.attempts++;
        recycle(g, `no response within ${GUEST_TIMEOUT_MS} ms`);
        queue.unshift(...taken.filter((j) => !j.signal.aborted));
        if (self.signal.aborted) {
          self.error = new Error("client disconnected");
          self.done = true;
        }
        return;
      }
    }

    const retry: Job[] = [];
    for (let i = 0; i < taken.length; i++) {
      const job = taken[i];
      const r = settled[i];
      if (r.status === "rejected") {
        job.error = r.reason;
        job.done = true;
        continue;
      }
      const v = r.value;
      if (v.kind === "aborted") {
        job.error = new Error("client disconnected");
        job.done = true;
      } else if (v.kind === "defer") {
        retry.push(job);
      } else {
        job.result = {
          ...v.served,
          queueMs: startedAt - job.queuedAt,
          batch: taken.length,
        };
        job.done = true;
        if (v.kind === "stream") {
          // Only the driver's own job can stream; it keeps the VM until the
          // body ends rather than buffering an arbitrarily large response.
          holdsLease = true;
        }
      }
    }
    if (retry.length) queue.unshift(...retry);

    if (holdsLease) {
      streamTrace.hold = true;
      // A short chunked body may already have ended while the batch ran.
      if (streamTrace.finished) release();
    }
  } finally {
    if (!holdsLease) release();
  }
}

/**
 * Run one job in the driver's context and decide how its response is handed
 * over: buffered (a follower or a small body), streamed (the driver's own
 * response), deferred (a safe request whose body is too large to buffer) or
 * aborted.
 */
async function runJob(
  job: Job,
  g: Guest,
  isSelf: boolean,
  startedAt: number,
  onFinished: () => void,
): Promise<RunResult> {
  const timeout = AbortSignal.timeout(GUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([job.signal, timeout]);
  let r: Response;
  try {
    // A trace belongs to the driver's own job: it is the only body that can
    // outlive the turn. Followers are read to the end here.
    r = await g.vm.fetch(
      job.url,
      { method: job.method, headers: job.headers, body: job.body, signal },
      isSelf ? { finished: onFinished } : undefined,
    );
  } catch (e) {
    if (job.signal.aborted) return { kind: "aborted" };
    throw e;
  }

  const ttfbMs = Date.now() - startedAt;
  const headers = new Headers(r.headers);
  const served = (bytes: Uint8Array<ArrayBuffer> | null, stream?: ReadableStream<Uint8Array>): RunResult => ({
    kind: stream ? "stream" : "buffered",
    served: { status: r.status, statusText: r.statusText, headers, bytes, stream, ttfbMs },
  });

  // HEAD has no body; 204/304 responses have none either.
  if (job.method === "HEAD" || r.body === null) {
    return served(new Uint8Array(0));
  }

  const length = r.headers.get("content-length");
  const declared = length === null ? null : Number(length);
  if (isSelf && (declared === null || declared > MAX_BATCH_BYTES)) {
    // The driver's client can take a stream; a body that does not fit cannot
    // be handed to anyone else, so the turn keeps the VM until it ends.
    return served(null, r.body);
  }
  if (declared === null || declared > MAX_BATCH_BYTES) {
    // Safe by construction (only GET/HEAD/OPTIONS are batched), so this job
    // is replayed in a turn of its own, where it can stream to its client.
    await r.body.cancel().catch(noop);
    return { kind: "defer" };
  }
  const bytes = await readCapped(r.body, MAX_BATCH_BYTES);
  if (!bytes) {
    if (isSelf) throw new Error("response exceeded the batch cap despite Content-Length");
    return { kind: "defer" };
  }
  return served(bytes);
}

/** Read a body up to `cap` bytes; null (and cancel) if it is larger. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  cap: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(noop);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function boot(): Promise<Guest> {
  const start = Date.now();
  let vm: KernelInstance | undefined;
  try {
    // The guest runs on the interpreter: Cloudflare Workers disallows dynamic
    // wasm compilation (jit), so the kernel's JIT is disabled and the kernel
    // log stays clean.
    vm = await createKernel({ jit: false });

    // The guest's console goes to the worker logs; it is the boot log plus
    // whatever the server writes (bounded by drain()).
    const decoder = new TextDecoder();
    vm.onOutput((bytes) => {
      const text = decoder.decode(bytes);
      if (text) console.log(`[guest] ${text.trimEnd()}`);
    });

    // The app runs forever: spawn it on pipes and keep reading both streams,
    // or the guest will block on a full pipe while nobody drains it.
    const server = await vm.spawn(GUEST_FILE, [], { pty: false });
    void drain(server.stdout, "out");
    void drain(server.stderr, "err");

    // The server takes a moment to bind: poll it until it accepts, or the
    // first request would race the boot and get a connection refused.
    await waitForServer(vm);

    console.log(`[unkernel-rs] booted in ${Date.now() - start} ms`);
    return { vm };
  } catch (e) {
    // Never leak a half-booted kernel into the next request.
    if (vm) vm.stop().catch(() => {});
    throw e;
  }
}

/**
 * Poll the guest's loopback port until the server accepts, or throw.
 *
 * The poll starts at a few milliseconds and backs off: the server binds
 * within a few milliseconds of the spawn, so a coarse fixed interval (150 ms)
 * threw away most of a boot on an unlucky phase.
 */
async function waitForServer(vm: KernelInstance): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let delay = 2;
  let lastError: unknown;
  for (;;) {
    try {
      const socket = await vm.connect(GUEST_PORT);
      await socket.close();
      return;
    } catch (e) {
      lastError = e;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Console-log the binary's output while draining it (bounded). */
async function drain(stream: ReadableStream<Uint8Array>, name: string): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";
  let logged = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line && logged < 16) {
        logged += 1;
        console.log(`[axum-hello:${name}] ${line}`);
      }
    }
  }
}

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContextLike): Promise<Response> {
    const url0 = new URL(request.url);
    // Diagnostics: the VM's state, answered by the Worker (never by the guest),
    // so it works while the guest is stalled.
    if (url0.pathname === "/__debug") {
      return Response.json(
        {
          guest: guest ? guest.vm.debug() : null,
          queue: queue.map((j) => ({
            id: j.id,
            method: j.method,
            batchable: j.batchable,
            ageMs: Date.now() - j.queuedAt,
            attempts: j.attempts,
          })),
          leaseOwner,
          turns: turnStats,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    // The guest runs the server on its loopback port; forward the path and
    // query, and let the guest see a normal Host header. One connection per
    // request: a stream opened in one request cannot be read in another (the
    // runtime cancels the request as hung), so connections cannot be pooled.
    const url = new URL(request.url);
    const guestUrl = `http://localhost:${GUEST_PORT}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    headers.delete("host");
    // Buffered so a turn that finds the guest unresponsive can replay it, and
    // so no request body is half-sent across a retry.
    const body = request.body ? await request.arrayBuffer() : undefined;

    const job: Job = {
      id: nextJobId++,
      method: request.method,
      url: guestUrl,
      headers,
      body,
      signal: request.signal,
      queuedAt: Date.now(),
      batchable: isBatchable(request.method, body),
      attempts: 0,
      done: false,
    };
    queue.push(job);
    // A client that goes away must not leave a dead head blocking the queue.
    job.signal.addEventListener(
      "abort",
      () => {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        if (!job.done) {
          job.error = new Error("client disconnected");
          job.done = true;
        }
      },
      { once: true },
    );

    for (let polls = 0; ; polls++) {
      if (job.done) break;
      const atHead = queue[0] === job;
      if (atHead && leaseOwner === null) {
        await driveTurn(job, ctx);
        continue;
      }
      // The next driver checks at once (the VM is idle or about to be); the
      // ones behind it back off so a deep queue does not spin timers.
      await new Promise<void>((r) => setTimeout(r, atHead ? 0 : pollDelay(polls)));
    }
    return respond(job);
  },
};

/** Turn one job's result into the client's Response. */
function respond(job: Job): Response {
  const r = job.result;
  if (!r || job.error) return error(502, job.error ?? new Error("empty response"));

  const headers = new Headers(r.headers);
  headers.set("x-unkernel-queue-ms", String(r.queueMs));
  headers.set("x-unkernel-ttfb-ms", String(r.ttfbMs));
  headers.set("x-unkernel-batch", String(r.batch));

  if (r.stream) {
    // A streamed body keeps the VM until it ends (driveTurn's trace).
    return new Response(r.stream, { status: r.status, statusText: r.statusText, headers });
  }
  headers.delete("transfer-encoding");
  if (job.method === "HEAD") {
    // Keep the guest's Content-Length: it describes the body we did not read.
  } else if (r.status === 204 || r.status === 205) {
    headers.delete("content-length");
  } else {
    headers.set("content-length", String(r.bytes?.byteLength ?? 0));
  }
  const body = r.bytes && r.bytes.byteLength ? r.bytes : null;
  return new Response(body, { status: r.status, statusText: r.statusText, headers });
}

function error(status: number, e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[unkernel-rs] ${message}`);
  return new Response(`unkernel-rs: ${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
