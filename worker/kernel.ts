/**
 * The kernel factory: the specialized SDK fork in sdk/, bound to this Worker.
 *
 * The fork (sdk/) is unkernel's host runtime with everything this app does
 * not use removed: no display, input, sound, virtio-gpu, shm, disks,
 * network stack, mounts, commands, snapshots, profiler, JIT or worker mode.
 * What is left is the kernel's own runtime (WASI clocks, randomness,
 * console, idle, task switching), the console ring's single-threaded path
 * and vsock with kwtty (spawn, connect) and HTTP/1.1 (fetch).
 *
 * The bundled kernel still imports every device driver's entry point, so the
 * fork answers those imports like the SDK's disabled hosts did (init
 * -ENODEV, the rest benign 0). The guest registers no device and never
 * reaches them. sdk/kernel.ts names each one.
 */
import type { CreateKernelOptions, KernelInstance, Platform } from "../sdk/index.ts";
import { createKernelOn } from "../sdk/index.ts";
import kernelWasm from "../assets/unkernel.wasm";

const platform: Platform = {
  // The bundled kernel module: wrangler compiles it at build time (Workers
  // disallows compiling wasm at runtime).
  defaultKernel: () => kernelWasm,
  // The guest image is tiny, so is the RAM it needs; the fallbacks cover a
  // host that cannot map 64 MiB.
  defaultMemoryMiB: () => 64,
  defaultMemoryFallbackMiB: [48, 32],
};

/** Boot a kernel from the platform defaults (the same contract as the SDK). */
export function createKernel(opts: CreateKernelOptions = {}): Promise<KernelInstance> {
  return createKernelOn(platform, opts);
}
