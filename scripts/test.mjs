#!/usr/bin/env node
/** Smoke-test a running deployment. Start `npm run dev` first. */
const base = (process.env.TEST_URL ?? "http://localhost:8787").replace(/\/$/, "");
const get = async (path) => {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text;
};
const cpu = async (query) => JSON.parse(await get(`/cpu?${query}`));

if ((await get("/health")) !== "ok\n") throw new Error("/health failed");
if (!(await get("/")).includes("Hello from unkernel-rust-workers")) throw new Error("/ failed");
const echo = await fetch(`${base}/echo`, { method: "POST", body: "hello" });
if ((await echo.text()) !== "hello") throw new Error("/echo failed");

const invalidUtf8 = await fetch(`${base}/echo`, {
  method: "POST",
  body: new Uint8Array([0x41, 0xff, 0xc3, 0x28, 0xe2, 0x82]),
});
if ((await invalidUtf8.text()) !== "A\ufffd\ufffd(\ufffd") throw new Error("/echo did not preserve UTF-8-lossy semantics");

const largeEcho = "a".repeat(1024 * 1024);
const largeResponse = await fetch(`${base}/echo`, { method: "POST", body: largeEcho });
// The guest deadline bounds response headers, not a slow body consumer.
await new Promise((resolve) => setTimeout(resolve, 3500));
if ((await largeResponse.text()) !== largeEcho) throw new Error("/echo did not round-trip 1 MiB after the header deadline");

const tooLarge = await fetch(`${base}/echo`, { method: "POST", body: new Uint8Array(8 * 1024 * 1024 + 1) });
if (tooLarge.status !== 413) throw new Error(`expected 413 for an oversized request, got ${tooLarge.status}`);

const checksums1m = [
  "4500339045783072515",
  "15764537756342361424",
  "7555302438740333613",
  "10740750840383687616",
];
for (let jobs = 1; jobs <= 4; jobs++) {
  const result = await cpu(`jobs=${jobs}&iterations=1000000&shards=4`);
  if (result.parallelism !== jobs) throw new Error(`expected ${jobs} shards, got ${result.parallelism}`);
  if (result.guestParallelism !== 1) throw new Error(`expected one guest worker per shard, got ${result.guestParallelism}`);
  if (result.guestSamples?.length !== jobs) throw new Error(`expected ${jobs} guest samples, got ${result.guestSamples?.length}`);
  if (result.checksum !== checksums1m[jobs - 1]) throw new Error(`unexpected ${jobs}-job checksum ${result.checksum}`);
}

const defaultCpu = await cpu("iterations=1000000");
if (defaultCpu.jobs !== 4 || defaultCpu.parallelism !== 4) throw new Error(`four-job/four-shard default changed: ${JSON.stringify(defaultCpu)}`);
if (defaultCpu.checksum !== checksums1m[3]) throw new Error(`unexpected default checksum ${defaultCpu.checksum}`);
for (let shards = 1; shards <= 4; shards++) {
  const result = await cpu(`jobs=4&iterations=1000000&shards=${shards}`);
  if (result.parallelism !== shards) throw new Error(`expected ${shards} shards, got ${result.parallelism}`);
  if (result.checksum !== checksums1m[3]) throw new Error(`checksum changed on ${shards} shards: ${result.checksum}`);
}

const unevenOneShard = await cpu("jobs=10&iterations=1000000&shards=1");
const unevenFourShards = await cpu("jobs=10&iterations=1000000&shards=4");
if (unevenOneShard.checksum !== "12538923296120618574" || unevenFourShards.checksum !== unevenOneShard.checksum) {
  throw new Error(`uneven partitioning changed the workload: ${JSON.stringify({ unevenOneShard, unevenFourShards })}`);
}

const checksums8m = [
  "14595511096202555493",
  "8433008453168744658",
  "10495732057881909187",
  "1008772232173616828",
];
for (let jobs = 1; jobs <= 4; jobs++) {
  const result = await cpu(`jobs=${jobs}&iterations=8000000&shards=4`);
  if (result.parallelism !== jobs || result.checksum !== checksums8m[jobs - 1]) {
    throw new Error(`unexpected 8M ${jobs}-job CPU result: ${JSON.stringify(result)}`);
  }
}
console.log(JSON.stringify({ ok: true, url: base, cpus: defaultCpu.parallelism, checksum: defaultCpu.checksum, largeEchoBytes: largeEcho.length }));
