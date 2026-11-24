#!/usr/bin/env node
/** Compare guest CPU jobs on an already running server, optionally across shard counts. */
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const get = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const base = get("url", "http://localhost:8787").replace(/\/$/, "");
const iterations = Number(get("iterations", "8000000"));
const runs = Number(get("runs", "5"));
const shardValues = get("shards", "4").split(",").map(Number);
const jobCounts = get("jobs", "1,2,4").split(",").map(Number);
const route = get("route", "");
const prewarm = get("prewarm", "0") === "1";
const routeWarmup = Number(get("route-warmup", "0"));
const label = get("label", "");
const headers = {};
if (route) headers["x-unkernel-route"] = route;
if (prewarm) headers["x-unkernel-prewarm"] = "1";
const round = (value) => Math.round(value * 10) / 10;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const validate = (values, name) => {
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`invalid ${name}: ${values.join(",")}`);
  }
};
validate(shardValues, "shards");
validate(jobCounts, "jobs");
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error(`invalid runs: ${runs}`);
if (!Number.isSafeInteger(routeWarmup) || routeWarmup < 0) throw new Error(`invalid route-warmup: ${routeWarmup}`);

async function cpu(jobs, shards) {
  const started = performance.now();
  const response = await fetch(`${base}/cpu?jobs=${jobs}&iterations=${iterations}&shards=${shards}`, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return { ...JSON.parse(text), requestMs: performance.now() - started };
}

const health = await fetch(`${base}/health`, { headers });
if (!health.ok || (await health.text()) !== "ok\n") throw new Error(`health check failed: ${health.status}`);
for (let index = 0; index < routeWarmup; index++) {
  const response = await fetch(`${base}/health`, { headers });
  if (!response.ok || (await response.text()) !== "ok\n") throw new Error(`route warmup failed: ${response.status}`);
}

const groups = [];
for (const shards of shardValues) {
  const results = [];
  for (const jobs of jobCounts) {
    await cpu(jobs, shards); // warm the guest and HTTP/RPC path
    const samples = [];
    for (let run = 0; run < runs; run++) samples.push(await cpu(jobs, shards));
    const checksum = samples[0].checksum;
    if (samples.some((sample) => sample.checksum !== checksum)) throw new Error(`checksum changed for ${jobs} jobs on ${shards} shards`);
    const requestSamples = samples.map((sample) => sample.requestMs);
    const fanoutSamples = samples.map((sample) => sample.elapsedMs);
    results.push({
      jobs,
      parallelism: samples[0].parallelism,
      guestParallelism: samples[0].guestParallelism,
      guestSampleParallelism: samples[0].guestSamples?.map((sample) => sample.parallelism),
      fanoutMedianMs: round(median(fanoutSamples)),
      requestMedianMs: round(median(requestSamples)),
      requestP99Ms: round([...requestSamples].sort((a, b) => a - b)[Math.min(runs - 1, Math.floor(runs * 0.99))]),
      fanoutSamplesMs: fanoutSamples.map(round),
      requestSamplesMs: requestSamples.map(round),
      checksum,
    });
  }
  const one = results.find((result) => result.jobs === 1);
  for (const result of results) {
    result.speedup = one ? round((one.fanoutMedianMs * result.jobs) / result.fanoutMedianMs) : null;
    result.efficiencyPercent = one ? round((result.speedup / result.jobs) * 100) : null;
  }
  groups.push({ shards, results });
}

const output = {
  url: base,
  iterations,
  runs,
  route: route || "default",
  prewarm,
  routeWarmup,
};
if (label) output.label = label;
if (groups.length === 1) {
  output.shards = groups[0].shards;
  output.results = groups[0].results;
} else {
  output.shards = shardValues;
  output.results = groups;
}
console.log(JSON.stringify(output, null, 2));
