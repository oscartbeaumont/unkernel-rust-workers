#!/usr/bin/env node
/**
 * A small benchmark for the unkernel-rs worker.
 *
 * Modes:
 *   --cold          start a fresh dev server per run, time the first request
 *   (default)       one dev server: warm the isolate, then time N requests
 *
 * Usage:
 *   node scripts/bench.mjs [--port N] [--cold] [--warmup 3] [--requests 20] [--cold-runs 3]
 *
 * Prints a JSON summary to stdout.
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const get = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);
const PORT = Number(get("--port", "8787"));
const MODE = has("--cold") ? "cold" : "warm";
const WARMUP = Number(get("--warmup", "3"));
const REQUESTS = Number(get("--requests", "20"));
const COLD_RUNS = Number(get("--cold-runs", "3"));
const BASE = "http://localhost:" + PORT;
const url = (p) => BASE + p;

/** Spawn a fresh cf dev server; resolves when it prints Ready. */
function startServer() {
  return new Promise((resolve, reject) => {
    let server;
    try {
      server = spawn("cf", ["dev", "--port", String(PORT)], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (e) {
      return reject(new Error("could not start cf dev: " + e.message));
    }
    let readySent = false;
    const ready = () => {
      if (readySent) return;
      readySent = true;
      resolve(server);
    };
    server.stdout.on("data", (d) => {
      if (d.toString().includes("Ready")) ready();
    });
    server.stderr.on("data", (d) => {
      if (d.toString().includes("Ready")) ready();
    });
    server.on("error", reject);
    server.on("exit", (code) => {
      if (!readySent) reject(new Error("cf dev exited early with code " + code));
    });
    const timer = setTimeout(() => {
      if (!readySent) reject(new Error("cf dev did not become Ready within 60 s"));
    }, 60_000);
    server.on("exit", () => clearTimeout(timer));
  });
}

function stopServer(server) {
  if (!server) return;
  try { server.kill("SIGTERM"); } catch {}
}

async function timeRequest(path, body) {
  const t0 = performance.now();
  const res = await fetch(url(path), { method: body ? "POST" : "GET", body: body ?? undefined });
  const text = await res.text();
  const t1 = performance.now();
  if (!res.ok) throw new Error(path + " answered " + res.status + ": " + text.slice(0, 200));
  return t1 - t0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 10) / 10;

(async () => {
  if (MODE === "cold") {
    const coldMs = [];
    for (let i = 0; i < COLD_RUNS; i++) {
      const server = await startServer();
      try {
        const ms = await timeRequest("/");
        coldMs.push(ms);
      } finally {
        stopServer(server);
        await sleep(500);
      }
    }
    console.log(JSON.stringify({ mode: "cold", coldMs: coldMs.map(round), runs: coldMs.length }));
    process.exit(0);
  }

  const server = await startServer();
  try {
    for (let i = 0; i < WARMUP; i++) await timeRequest("/health");
    const latencies = [];
    for (let i = 0; i < REQUESTS; i++) {
      latencies.push(await timeRequest("/health"));
    }
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))];
    console.log(
      JSON.stringify({ mode: "warm", runs: latencies.length, p50Ms: round(p50), p99Ms: round(p99), minMs: round(latencies[0]), maxMs: round(latencies[latencies.length - 1]) }),
    );
  } finally {
    stopServer(server);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
