/**
 * The kernel factory, without the browser page.
 *
 * The SDK's "unkernel/web" entry is the browser page API: it pulls in the
 * kernels that run in a Worker with a display, IndexedDB stores, HTTP disk
 * images, downloads and a WASI worker (~270 KB of the ~480 KB script). A
 * Worker that boots one kernel and proxies HTTP needs none of it:
 * createKernelOn() is the same factory createKernel() calls, with the
 * platform capabilities a Cloudflare Worker has.
 *
 * The package pins an exact unkernel version (package.json), so the internal
 * module path is part of the pinned artifact; the export map just does not
 * expose it.
 */
import type { CreateKernelOptions, KernelInstance } from "unkernel/web";
// @ts-expect-error the SDK does not export its internal module or its types.
import { createKernelOn } from "../node_modules/unkernel/dist/_chunks/core.mjs";
import kernelWasm from "../assets/unkernel.wasm";

/** What createKernelOn() reads off a platform (see the SDK's web/node entries). */
interface Platform {
  defaultKernel: () => WebAssembly.Module;
  defaultMemoryMiB: () => number;
  defaultMemoryFallbackMiB: number[];
  whyNoCpus: () => string;
}

const platform: Platform = {
  // The bundled kernel module: wrangler compiles it at build time (Workers
  // disallows compiling wasm at runtime).
  defaultKernel: () => kernelWasm,
  // The guest image is tiny, so is the RAM it needs; the fallbacks cover a
  // host that cannot map 64 MiB.
  defaultMemoryMiB: () => 64,
  defaultMemoryFallbackMiB: [48, 32],
  // One CPU: this kernel is the UP build and a Worker has no threads for a
  // second one anyway.
  whyNoCpus: () => "Cloudflare Workers has no CPU threads",
};

const create = createKernelOn as (platform: Platform, opts?: CreateKernelOptions) => Promise<KernelInstance>;

/** Boot a kernel from the platform defaults (the same contract as the SDK). */
export function createKernel(opts: CreateKernelOptions = {}): Promise<KernelInstance> {
  return create(platform, opts);
}
