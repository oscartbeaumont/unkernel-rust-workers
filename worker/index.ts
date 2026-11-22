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
import type { KernelInstance } from "unkernel/web";

/** Where scripts/kernel-prep.mjs packs the binary into the guest's initrd. */
const GUEST_FILE = "/hello/axum-hello";
/** The port the guest server listens on (rust/src/main.rs). */
const GUEST_PORT = 3000;
/** How long the server may take to bind before boot is considered failed. */
const READY_TIMEOUT_MS = 10000;

let bootPromise: Promise<KernelInstance> | undefined;

/**
 * The one boot of this isolate. Every caller gets the same promise; a boot
 * that fails is dropped so the next request tries again instead of awaiting
 * a failure forever.
 */
function ensureBoot(): Promise<KernelInstance> {
  let p = bootPromise;
  if (!p) {
    p = boot();
    bootPromise = p;
    // Handle the rejection so a boot that fails before a caller awaits it
    // does not surface as an unhandled rejection.
    p.catch(() => {
      if (bootPromise === p) bootPromise = undefined;
    });
  }
  return p;
}

async function boot(): Promise<KernelInstance> {
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
    return vm;
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
  async fetch(request: Request): Promise<Response> {
    let vm: KernelInstance;
    try {
      vm = await ensureBoot();
    } catch (e) {
      // A failed boot must not poison the isolate: retry on the next request.
      return error(500, e);
    }

    try {
      // The guest runs the server on its loopback port; forward the path and
      // query, and let the guest see a normal Host header.
      const url = new URL(request.url);
      const guestUrl = `http://localhost:${GUEST_PORT}${url.pathname}${url.search}`;
      const headers = new Headers(request.headers);
      headers.delete("host");
      return await vm.fetch(guestUrl, {
        method: request.method,
        headers,
        body: request.body,
      });
    } catch (e) {
      return error(502, e);
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
