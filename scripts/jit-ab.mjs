#!/usr/bin/env node
/**
 * A/B measurement: the guest in Node with the JIT on vs off, same workload.
 * Prints JSON: median/overall per phase.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, MemoryFs } from "unkernel";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(repo, "assets", "axum-hello.bin");
const KERNEL = join(repo, "assets", "unkernel.wasm");

async function boot(jit) {
  const binary = readFileSync(BIN);
  const helloFs = new MemoryFs();
  const file = helloFs.create("/axum-hello", 0o755);
  const written = await file.write(0, binary);
  const vm = await createKernel({ kernel: KERNEL, jit, memoryMiB: 64, memoryFallbackMiB: [48, 32] });
  await vm.mount("/hello", helloFs, { readOnly: true });
  const server = await vm.spawn("/hello/axum-hello", [], { pty: false });
  drain(server.stdout); drain(server.stderr);
  const deadline = Date.now() + 20000;
  for (;;) {
    try { const s = await vm.connect(3000); await s.close(); break; } catch (e) {
      if (Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { vm };
}

async function drain(stream) { const reader = stream.getReader(); for (;;) { const { done } = await reader.read(); if (done) return; } }

async function run(jit, rounds, echo) {
  const { vm } = await boot(jit);
  const times = [];
  const doFetch = (i) => echo
    ? vm.fetch("http://localhost:3000/echo", { method: "POST", body: "ping-" + i.toString().padStart(40, "x") })
    : vm.fetch("http://localhost:3000/health");
  for (let i = 0; i < rounds; i++) {
    // 10 warmups untimed: enough to let the JIT compile its hot blocks
    await (await doFetch(i)).text();
    if (i >= 10) {
      const t0 = performance.now();
      await (await doFetch(i)).text();
      times.push(performance.now() - t0);
    }
  }
  const stats = vm.stats();
  try { await vm.stop(); } catch {}
  const jitStats = stats?.jit ?? {};
  return { times, jitStats, compiled: jitStats.compiled ?? 0, live: jitStats.live ?? 0, bytes: jitStats.bytes ?? 0 };
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

const rounds = Number(process.argv[2] ?? 60);
const echo = process.argv[3] === "echo";
const on = await run(true, rounds, echo);
const off = await run(false, rounds, echo);
console.log(JSON.stringify({
  rounds,
  jitOn: { medianMs: median(on.times), minMs: Math.min(...on.times), maxMs: Math.max(...on.times), compiled: on.compiled, live: on.live, bytes: on.bytes },
  jitOff: { medianMs: median(off.times), minMs: Math.min(...off.times), maxMs: Math.max(...off.times), compiled: off.compiled, bytes: off.bytes },
}));
