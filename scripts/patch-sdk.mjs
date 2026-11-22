#!/usr/bin/env node
/**
 * Patch the SDK's terminal-client retry interval.
 *
 * The kernel's boot and kwtty's start are asynchronous: by the time the
 * Worker asks for the first spawn, the guest is usually mid-boot, so the
 * first kwtty connect is refused. The SDK retries every 100 ms
 * (crates... js/core/tty.ts: RETRY_MS = 100), which throws away up to 100 ms
 * of every cold start. 5 ms polls the same deadline: the first spawn lands
 * within a few milliseconds of kwtty listening.
 *
 * The package is pinned exactly (package.json), so the replacement is exact
 * and fails loudly when a version bump moves it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../node_modules/unkernel/dist/_chunks/core.mjs", import.meta.url).pathname;
const from = "const RETRY_MS$2 = 100;";
const to = "const RETRY_MS$2 = 5;";

const source = readFileSync(file, "utf8");
if (source.includes(to)) {
  console.log("patch-sdk: already patched");
  process.exit(0);
}
const hits = source.split(from).length - 1;
if (hits !== 1) {
  console.error("patch-sdk: expected exactly one \"" + from + "\", found " + hits + "; the SDK moved, review the patch");
  process.exit(1);
}
writeFileSync(file, source.replace(from, to));
console.log("patch-sdk: kwtty retry 100 ms -> 5 ms");
