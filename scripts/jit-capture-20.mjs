#!/usr/bin/env node
/**
 * Capture the JIT modules the kernel compiles at runtime (offline, in Node).
 *
 * Boots the guest in Node with the real unkernel SDK with the JIT ENABLED
 * (Node has no restrictions; Cloudflare Workers blocks runtime wasm
 * compilation). Monkey-patches the WebAssembly.Module constructor — the only
 * one the SDK's JitHost uses — to record every module it compiles.
 *
 * The guest binary is emitted exactly like the Worker does: mounted read-only,
 * spawned on pipes, and poked with /health + POST /echo requests.
 *
 * Writes (derived from the captured bytes — nothing hand-edited):
 *   assets/jit/<hash>.wasm   - the captured module bytes, one per unique module
 *   assets/jit/manifest.json - { "<hash>": "<hash>.wasm", ... }
 *   assets/jit/meta.json     - capture metadata (count, bytes, jit stats)
 *   worker/jit-aot.ts        - generated loader: imports the .wasm modules and
 *                              serves them by content hash at runtime
 *
 * The kernel itself is compiled via WebAssembly.compile() (not the Module
 * constructor), and the JSPI probe (a ~50 byte module) is filtered out by size,
 * so only JIT-emitted modules are captured.
 *
 * Run it from the repo root. It is NOT part of the deploy path.
 *
 * Caveat (measured 2026-11-22): the JIT emission is NOT byte-deterministic
 * across runs for this binary. Identical captures (same requests, same
 * workload) yielded 5, 3, 1, 1 and 3 modules with different hashes and
 * different module sizes; same-size modules differed in a handful of
 * embedded LE constants (i64.const) at identical offsets — the regions
 * that kwemu emits embed per-boot block indices (`blocks_off + idx *
 * sizeof(Block)`), so identical code produces different bytes. That
 * makes an offline capture unreliable for the worker (a different isolate
 * boot that produces yet more different bytes): a byte-hash lookup would
 * miss everything and fall back to the interpreter. See the report for
 * the full evidence. The capture script stays as a working diagnostic.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, MemoryFs } from "unkernel";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(repo, "assets", "axum-hello.bin");
const KERNEL = join(repo, "assets", "unkernel.wasm");
const OUT_DIR = join(repo, "assets", "jit");
const WORKER_JIT_AOT = join(repo, "worker", "jit-aot.ts");
const SDK = join(repo, "node_modules", "unkernel", "dist", "_chunks", "core.mjs");
const MIN_MODULE_BYTES = 100;
const MAX_MODULE_BYTES = 1 << 20; // JitHost's MAX_MODULE
const GUEST_MOUNT = "/hello";
const GUEST_FILE = "/hello/axum-hello";

/** FNV-1a 64-bit, one hash per content. The same algorithm as worker/jit-aot.ts. */
function fnv1a64(bytes) {
  const offset = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let h = offset;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

const log = (msg) => console.log("[jit-capture]", msg);

// Refuse to capture while the SDK is AOT-patched: the patched JitHost would
// serve stale modules from the manifest instead of compiling fresh ones, and
// the recorder would never see them (the patched compile does not call
// new WebAssembly.Module on a hit).
const sdkSource = readFileSync(SDK, "utf8");
if (sdkSource.includes("AOT-JIT: injected by scripts/apply-jit-aot.mjs")) {
  console.error("[jit-capture] the SDK is AOT-patched; unpatch it first: node scripts/apply-jit-aot.mjs --unpatch");
  process.exit(1);
}

// Record every module the kernel's JIT compiles (and nothing else).
const RealModule = WebAssembly.Module;
const captured = new Map(); // hash -> Uint8Array
WebAssembly.Module = class extends RealModule {
  constructor(...args) {
    try {
      const src = args[0];
      const bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : src;
      if (bytes instanceof Uint8Array && bytes.length > MIN_MODULE_BYTES && bytes.length <= MAX_MODULE_BYTES) {
        const copy = bytes.slice();
        const h = fnv1a64(copy);
        if (!captured.has(h)) captured.set(h, copy);
      }
    } catch {}
    super(...args);
  }
};

/** Drain a stream to the void (the guest must not wait on a full pipe). */
async function drain(stream) {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

/** Poll the guest's loopback port until the server accepts, or throw. */
async function waitForServer(vm, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
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

const binary = readFileSync(BIN);
log("loading the axum binary:", BIN, "(" + binary.byteLength + " bytes)");
log("loading the kernel:", KERNEL);

const helloFs = new MemoryFs();
const file = helloFs.create("/axum-hello", 0o755);
const written = await file.write(0, binary);
if (written !== binary.byteLength) throw new Error("the guest filesystem took " + written + " of " + binary.byteLength + " bytes");

const vm = await createKernel({
  kernel: KERNEL,
  jit: true,
  memoryMiB: 64,
  memoryFallbackMiB: [48, 32],
});

let logLines = 0;
vm.onOutput((bytes) => {
  const text = new TextDecoder().decode(bytes);
  if (text && logLines++ < 60) console.log("[guest] " + text.trimEnd());
});

await vm.mount(GUEST_MOUNT, helloFs, { readOnly: true });
const server = await vm.spawn(GUEST_FILE, [], { pty: false });
void drain(server.stdout);
void drain(server.stderr);

await waitForServer(vm, 20000);
log("the guest is up (listening on 127.0.0.1:3000)");

// Poke the guest with the endpoints the Worker proxies.
const pokes = [
  ["GET", "/", undefined],
  ["GET", "/health", undefined],
  ["POST", "/echo", "ping-1"],
];
for (let round = 0; round < (Number(process.argv[2]) || 3); round++) {
  for (const [method, path, body] of pokes) {
    const t0 = performance.now();
    const res = await vm.fetch("http://localhost:3000" + path, {
      method,
      body,
    });
    await res.text();
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(path + " answered " + res.status);
    process.stdout.write("[poke] " + method + " " + path + " -> " + res.status + " in " + ms.toFixed(1) + " ms\n");
  }
}

const stats = vm.stats();
const jit = stats.jit ?? {};
log("jit stats:", JSON.stringify(jit));
log("captured modules:", captured.size, "total bytes:", [...captured.values()].reduce((a, b) => a + b.length, 0));

// Fail loudly: a capture with zero modules means the JIT never ran.
if (captured.size === 0) {
  console.error("[jit-capture] no JIT modules captured; the kernel never asked the host to compile anything (is the binary the same one the Worker runs?)");
  process.exitCode = 1;
}

// Write the artifacts from the captured bytes.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const manifest = {};
const sizes = {};
for (const [hash, bytes] of captured) {
  const fileName = hash + ".wasm";
  writeFileSync(join(OUT_DIR, fileName), bytes);
  manifest[hash] = fileName;
  sizes[hash] = bytes.length;
}
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(OUT_DIR, "meta.json"), JSON.stringify({
  capturedWith: "node (the real unkernel SDK, jit: true)",
  capturedAt: new Date().toISOString(),
  platform: process.platform + " " + process.arch,
  kernel: "assets/unkernel.wasm",
  binary: "assets/axum-hello.bin",
  memoryMiB: 64,
  memoryFallbackMiB: [48, 32],
  modules: captured.size,
  totalBytes: Object.values(sizes).reduce((a, b) => a + b, 0),
  sizes,
  jit: {
    compiled: jit.compiled ?? 0,
    live: jit.live ?? 0,
    maxLive: jit.maxLive ?? 0,
    freed: jit.freed ?? 0,
    failed: jit.failed ?? 0,
    bytes: jit.bytes ?? 0,
    compileMs: jit.compileMs ?? 0,
    maxCompileMs: jit.maxCompileMs ?? 0,
  },
}, null, 2) + "\n");

// The generated loader (worker/jit-aot.ts).
const imports = [...captured.keys()].sort().map((hash, i) => "import m" + (i + 1) + " from \"../assets/jit/" + hash + ".wasm\";");
const entries = [...captured.keys()].sort().map((hash, i) => '  "' + hash + '": m' + (i + 1) + ",");
const loader = [
  "/**",
  " * AOT-JIT loader (generated by scripts/jit-capture-20.mjs — do not edit by hand).",
  " *",
  " * The kernel's kwemu JIT compiles hot blocks at runtime (a few KiB each);",
  " * Cloudflare Workers forbids runtime wasm compilation, so the kernel's",
  " * kw_host_jit_compile is patched (scripts/apply-jit-aot.mjs) to serve these",
  " * precompiled modules instead. The kernel still emits the module bytes every",
  " * run; only the host's instantiation changes. The loader below is the single",
  " * manifest-driven import point: one .wasm import per captured module.",
  " *",
  " * Re-run the capture to regenerate this file (and assets/jit/*.wasm + manifest.json).",
  " */",
  ...imports,
  "",
  "export const AOT_MODULES: Readonly<Record<string, WebAssembly.Module>> = {",
  ...entries,
  "};",
  "",
  "/** FNV-1a 64-bit content hash (sync; Workers has only async crypto). */",
  "export function moduleHash(bytes: Uint8Array): string {",
  "  let h = 0xcbf29ce484222325n;",
  "  const prime = 0x100000001b3n;",
  "  const mask = 0xffffffffffffffffn;",
  "  for (let i = 0; i < bytes.length; i++) {",
  "    h ^= BigInt(bytes[i]);",
  "    h = (h * prime) & mask;",
  "  }",
  "  return h.toString(16).padStart(16, \"0\");",
  "}",
  "",
  "/** Serve the precompiled module for the given runtime-emitted bytes, if captured. */",
  "export function lookupAot(bytes: Uint8Array): WebAssembly.Module | undefined {",
  "  return AOT_MODULES[moduleHash(bytes)];",
  "}",
  "",
].join("\n");
writeFileSync(WORKER_JIT_AOT, loader);

log("wrote", OUT_DIR, "(" + captured.size + " modules) and", WORKER_JIT_AOT);
for (const [hash, bytes] of [...captured.entries()].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))) {
  process.stdout.write("  " + hash + "  " + bytes.length + " bytes\n");
}

try {
  await vm.stop();
} catch {}
