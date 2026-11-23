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
 */

import { createKernel } from "./kernel";
import type { KernelInstance } from "../sdk/index.ts";

/** Where scripts/kernel-prep.mjs packs the binary into the guest's initrd. */
const GUEST_FILE = "/hello/axum-hello";
/** The port the guest server listens on (rust/src/main.rs). */
const GUEST_PORT = 3000;
/** How long the server may take to bind before boot is considered failed. */
const READY_TIMEOUT_MS = 10000;

interface Guest {
  vm: KernelInstance;
}

/** The part of Cloudflare's ExecutionContext this Worker uses. */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** No response head by then marks this VM dead (see recycle()). Bodies are not bounded. */
const GUEST_TIMEOUT_MS = 3000;

let guest: Guest | undefined;
let bootPromise: Promise<Guest> | undefined;

/**
 * The one VM is a single-threaded Linux guest, and (more importantly) its
 * progress is driven by whichever request is running the kernel. A request
 * whose promise is resolved while *another* request drives the guest can have
 * its continuation dropped by the runtime ("Promise will never complete"), so
 * exactly one request owns the guest at a time: from before its connection is
 * opened until its response body has ended.
 *
 * Waiters poll with a short timer rather than awaiting a promise another
 * request resolves: the runtime cancels a request that waits on a promise only
 * another request can settle (and the waiter stays in its own request context).
 */
let nextTicket = 0;
let serving = 0;
let leaseOwner: number | null = null;

async function acquireGuest(): Promise<() => void> {
  const ticket = nextTicket++;
  for (;;) {
    const ahead = ticket - serving;
    if (leaseOwner === null && ahead === 0) break;
    // The next in line checks at once; the ones behind it back off (a
    // handoff is then at most a couple of milliseconds, and a 32-deep queue
    // does not spin 32 timers).
    const delay = ahead <= 0 ? 1 : Math.min(1 << Math.min(ahead, 3), 8);
    await new Promise<void>((r) => setTimeout(r, delay));
  }
  serving++;
  leaseOwner = ticket;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    leaseOwner = null;
  };
}

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
 * GUEST_TIMEOUT_MS is replaced: the timed-out request is replayed on the new
 * kernel (~85 ms), and the queued requests wait for that instead of failing.
 */
function recycle(g: Guest, why: string): void {
  if (guest !== g) return; // already replaced by another request
  guest = undefined;
  bootPromise = undefined;
  console.error(`[unkernel-rs] recycling the guest VM: ${why}`);
  void g.vm.stop().catch(() => {});
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
      return Response.json(guest ? guest.vm.debug() : { guest: null }, { headers: { "cache-control": "no-store" } });
    }
    // The guest runs the server on its loopback port; forward the path and
    // query, and let the guest see a normal Host header. One connection per
    // request: a stream opened in one request cannot be read in another (the
    // runtime cancels the request as hung), so connections cannot be pooled.
    const url = new URL(request.url);
    const guestUrl = `http://localhost:${GUEST_PORT}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    headers.delete("host");
    // Buffered so a request that found the guest unresponsive can be replayed.
    const body = request.body ? await request.arrayBuffer() : undefined;

    // Armed only when an attempt times out; it outlives that attempt so the
    // runtime has a pending event while the VM is recycled and replayed.
    let keepalive: ReturnType<typeof setTimeout> | undefined;
    const stopKeepalive = () => {
      if (keepalive !== undefined) {
        clearTimeout(keepalive);
        keepalive = undefined;
      }
    };

    for (let attempt = 0; ; attempt++) {
      const queuedAt = Date.now();
      const release = await acquireGuest();
      const acquiredAt = Date.now();
      let ttfbAt = 0;
      const noteSlow = (how: string) => {
        const total = Date.now() - queuedAt;
        if (total < 200) return;
        console.log(`[slow] ${how} ` + JSON.stringify({ queue: acquiredAt - queuedAt, ttfb: ttfbAt ? ttfbAt - acquiredAt : null, total }));
      };
      let g: Guest;
      try {
        g = await ensureBoot(ctx);
      } catch (e) {
        // A failed boot must not poison the isolate: the next request tries
        // again (it holds the lease, so only one boot runs at a time).
        release();
        return error(500, e);
      }

      // The timeout bounds time to first byte, not the body: a large download
      // may take as long as its client needs. While the timeout's abort,
      // recycle and replay run, a second timer keeps the runtime from
      // declaring the request hung (no pending I/O is left once the first
      // one fires).
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        keepalive = setTimeout(() => {}, 2 * GUEST_TIMEOUT_MS);
        controller.abort();
      }, GUEST_TIMEOUT_MS);
      let released = false;
      const releaseOnce = () => {
        clearTimeout(timer);
        if (released) return;
        released = true;
        release();
      };

      try {
        const r = await g.vm.fetch(guestUrl, {
          method: request.method,
          headers,
          body,
          signal: AbortSignal.any([request.signal, controller.signal]),
        }, {
          head: () => {
            ttfbAt = Date.now();
            clearTimeout(timer);
          },
          finished: () => {
            releaseOnce();
            noteSlow("done");
          },
        });
        stopKeepalive();
        // A response body holds the lease until it ends (fetchOver calls
        // finished); a body-less response is complete already.
        // The timings let a client tell queueing from the guest and from the
        // edge: both are milliseconds unless something is wrong.
        const outHeaders = new Headers(r.headers);
        outHeaders.set("x-unkernel-queue-ms", String(acquiredAt - queuedAt));
        outHeaders.set("x-unkernel-ttfb-ms", String((ttfbAt || Date.now()) - acquiredAt));
        const out = new Response(r.body, { status: r.status, statusText: r.statusText, headers: outHeaders });
        if (!out.body) releaseOnce();
        return out;
      } catch (e) {
        releaseOnce();
        noteSlow("error");
        // The guest stopped answering (a lost wakeup in the kernel/engine
        // pairing): replace the VM and replay once on the fresh one.
        if (!timedOut || request.signal.aborted || attempt > 0) {
          stopKeepalive();
          return error(502, e);
        }
        // The keepalive timer stays armed through the recycle and replay (it
        // is what keeps the runtime from abandoning the replay); the retry's
        // success or terminal error clears it.
        const s = g.vm.debug() as Record<string, unknown>;
        console.error("[unkernel-rs] guest timeout " + JSON.stringify({
          idle: s.idle, irqs: s.irqs, stats: s.stats,
          queued: (s.vsockDevice as { queued?: number } | undefined)?.queued,
          conns: (s.vsock as { connections?: Array<Record<string, unknown>> } | undefined)?.connections
            ?.map((c) => ({ k: c.key, s: c.state, rx: c.rx, tx: c.tx, want: c.wantRead, shut: c.shutSent, peer: c.peerShutSend })),
        }));
        recycle(g, `no response within ${GUEST_TIMEOUT_MS} ms`);
      }
    }
  },
};

function error(status: number, e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[unkernel-rs] ${message}`);
  return new Response(`unkernel-rs: ${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
