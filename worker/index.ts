/**
 * A Rust + Axum hello world running in Cloudflare Workers.
 *
 * The Axum server is a fully static aarch64 musl binary that runs inside a
 * real Linux kernel compiled to WebAssembly (unkernel, pithings/unkernel).
 * The kernel boots once per isolate; then every request is proxied to the
 * guest's loopback port 3000 over the kernel's vsock channel. The binary is
 * mounted read-only into the guest and runs as a plain Linux process.
 */

import { createKernel, MemoryFs } from "unkernel/web";
import type { KernelInstance } from "unkernel/web";
import kernelWasm from "../assets/unkernel.wasm";
import axumHelloData from "../assets/axum-hello.bin";

const GUEST_MOUNT = "/hello";
const GUEST_FILE = "/hello/axum-hello";

let bootPromise: Promise<KernelInstance> | undefined;

async function boot(): Promise<KernelInstance> {
  // The server binary, as raw bytes. The wrangler "Data" module import gives
  // either an ArrayBuffer or a Uint8Array depending on the runtime; accept both.
  const binary =
    axumHelloData instanceof ArrayBuffer
      ? new Uint8Array(axumHelloData)
      : new Uint8Array(axumHelloData);

  // The guest's only file: the server binary, read-only and executable.
  const helloFs = new MemoryFs();
  const file = helloFs.create("/axum-hello", 0o755);
  if (!file.write) throw new Error("the guest filesystem cannot hold the server binary");
  const written = await file.write(0, binary);
  if (written !== binary.byteLength) {
    throw new Error(`the guest filesystem took ${written} of ${binary.byteLength} bytes`);
  }

  let vm: KernelInstance | undefined;
  try {
    // The guest runs on the interpreter: Cloudflare Workers disallows dynamic
    // wasm compilation (jit), so the kernel's JIT is disabled and the kernel
    // log stays clean.
    vm = await createKernel({
      kernel: kernelWasm,
      jit: false,
      memoryMiB: 64,
      memoryFallbackMiB: [48, 32],
    });

    // The guest's console goes to the worker logs; it is usually just the boot log.
    const decoder = new TextDecoder();
    vm.onOutput((bytes) => {
      const text = decoder.decode(bytes);
      if (text) console.log(`[guest] ${text.trimEnd()}`);
    });

    await vm.mount(GUEST_MOUNT, helloFs, { readOnly: true });

    // The app runs forever: spawn it on pipes and keep reading both streams,
    // or the guest will wait while nobody drains them.
    const server = await vm.spawn(GUEST_FILE, [], { pty: false });
    void drain(server.stdout, "out");
    void drain(server.stderr, "err");

    // The server takes a moment to bind: poll it until it accepts, or the
    // first request would race the boot and get a connection refused.
    await waitForServer(vm, 10000);

    return vm;
  } catch (e) {
    // Never leak a half-booted kernel into the next request.
    if (vm) vm.stop().catch(() => {});
    throw e;
  }
}

/** Poll the guest's loopback port until the server accepts, or throw. */
async function waitForServer(vm: KernelInstance, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const socket = await vm.connect(3000);
      await socket.close();
      return;
    } catch (e) {
      lastError = e;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
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
      if (line && logged < 64) {
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
      bootPromise ??= boot();
      vm = await bootPromise;
    } catch (e) {
      // A failed boot must not poison the isolate: retry on the next request.
      bootPromise = undefined;
      return error(500, e);
    }

    try {
      // The guest runs the server on its loopback port 3000; forward the
      // path and query, and let the guest see a normal Host header.
      const url = new URL(request.url);
      const guestUrl = `http://localhost:3000${url.pathname}${url.search}`;
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
