#!/usr/bin/env node
/** Exercise a running guest through the Worker/Durable Object HTTP boundary. */
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const get = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const base = get("url", "http://localhost:8787").replace(/\/$/, "");
const requests = Number(get("requests", "800"));
const levels = get("concurrency", "1,8,16,32,64").split(",").map(Number);
const route = get("route", "");
const prewarm = get("prewarm", "0") === "1";
const headers = {};
if (route) headers["x-unkernel-route"] = route;
if (prewarm) headers["x-unkernel-prewarm"] = "1";
const round = (value) => Math.round(value * 10) / 10;
const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

async function request(path, init) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`);
  return { text, ms: performance.now() - started };
}

const root = await request("/");
if (!root.text.includes("Hello from unkernel-rust-workers")) throw new Error("unexpected root response");
const echo = await request("/echo", { method: "POST", body: "threaded guest" });
if (echo.text !== "threaded guest") throw new Error("echo did not round-trip");

const results = [];
for (const concurrency of levels) {
  const latencies = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= requests) return;
      const result = await request("/health");
      if (result.text !== "ok\n") throw new Error(`unexpected health response: ${JSON.stringify(result.text)}`);
      latencies.push(result.ms);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((a, b) => a - b);
  results.push({
    concurrency,
    requests: latencies.length,
    p50Ms: round(percentile(latencies, 0.5)),
    p99Ms: round(percentile(latencies, 0.99)),
    maxMs: round(latencies.at(-1)),
  });
}

const abortController = new AbortController();
const abortStarted = performance.now();
// Warm the RPC path and all four kernels first. A debug RPC cannot run while a
// Durable Object is executing synchronous Wasm, so active-turn observation is
// not a reliable start signal on the deployed runtime.
await request("/cpu?jobs=4&iterations=1000000&shards=4");
const abortedCpu = fetch(`${base}/cpu?jobs=4&iterations=50000000&shards=4`, {
  signal: abortController.signal,
  headers,
}).then(async (response) => {
  if (response.ok) await response.text();
}).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 250));
abortController.abort();
await abortedCpu;
const afterAbort = await request("/health", { headers: { "x-unkernel-route": "shard0" } });
if (afterAbort.text !== "ok\n") throw new Error("guest did not recover after an aborted CPU request");
let debug;
const cleanupDeadline = performance.now() + 5000;
for (;;) {
  debug = JSON.parse((await request("/__debug")).text);
  if (debug.every((shard) => !shard.queue.length && !shard.active.length)) break;
  if (performance.now() >= cleanupDeadline) throw new Error(`aborted CPU job retained a queue lease: ${JSON.stringify(debug)}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const cpu = await Promise.all(Array.from({ length: 4 }, () => request("/cpu?jobs=4&iterations=1000000")));
const parsed = cpu.map((result) => JSON.parse(result.text));
if (parsed.some((result) => result.parallelism !== 4)) throw new Error(`CPU request did not use four shards: ${JSON.stringify(parsed)}`);
if (parsed.some((result) => result.checksum !== parsed[0].checksum)) throw new Error("concurrent CPU checksums differ");
console.log(JSON.stringify({
  url: base,
  route: route || "default",
  prewarm,
  results,
  abortedCpuCleanupMs: round(performance.now() - abortStarted),
  concurrentCpu: { requests: cpu.length, checksum: parsed[0].checksum },
}, null, 2));
