#!/usr/bin/env node
/**
 * Run a command in the guest image, in Node (not in Workers).
 *
 * The default image has no userland besides the server, so this needs the
 * debug image: `WITH_SHELL=1 ./build.sh`. Then:
 *
 *   node scripts/guest-exec.mjs uname -a
 *   node scripts/guest-exec.mjs sh -c "ls -l /hello; cat /proc/meminfo"
 *
 * The process exits with the guest command's exit code. UNKERNEL_KERNEL=path
 * boots another image (e.g. one built beside the assets).
 */
import { createKernel } from "unkernel";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/guest-exec.mjs PROGRAM [ARG]...");
  process.exit(2);
}

const vm = await createKernel({
  kernel: process.env.UNKERNEL_KERNEL ?? join(repo, "assets", "unkernel.wasm"),
  jit: false,
  memoryMiB: 64,
  memoryFallbackMiB: [48, 32],
});
// The guest console is the kernel log; keep it quiet unless something fails.
vm.onOutput(() => {});

try {
  const [file, ...rest] = args;
  const res = await vm.exec(file, rest);
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  if (res.exitCode !== 0) console.error(`[guest] ${file} exited ${res.exitCode}${res.signal ? " (" + res.signal + ")" : ""}`);
  await vm.stop();
  process.exit(res.exitCode ?? 1);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[guest-exec] ${message}`);
  if (/ENOENT|no such|kwtty/i.test(message)) {
    console.error("[guest-exec] this image has no userland: build the debug one with `WITH_SHELL=1 ./build.sh`");
  }
  await vm.stop().catch(() => {});
  process.exit(1);
}
