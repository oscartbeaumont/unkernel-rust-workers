# Workers/Durable Object CPU sharding

## Platform constraint

Cloudflare Workers does not support WebAssembly threads, Web Workers or a useful shared-memory threading facility. Each isolate has one execution thread. Separate isolates never share a WebAssembly.Memory, and Cloudflare does not guarantee that two Durable Object instances run on different threads or physical cores.

References:

- [Workers WebAssembly support — threading](https://developers.cloudflare.com/workers/runtime-apis/webassembly/#threading)
- [Workers security model](https://developers.cloudflare.com/workers/reference/security-model/#step-1-disallow-timers-and-multi-threading)
- [Durable Objects concurrency](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/#single-threaded-concurrency)

This means a Workers/DO deployment cannot run unkernel's shared-memory SMP kernel faster than one physical core. Tokio's multi-thread runtime can schedule guest threads, but the kernel still has one vCPU. Containers would provide real threads, but are explicitly outside this project's deployment constraint.

## What upstream does in a browser

Unkernel's browser worker mode and SMP mode are separate:

- worker: true moves the whole kernel into a Web Worker. It can be UP or SMP.
- cpus > 1 starts one nested Web Worker per secondary vCPU, all against one shared WebAssembly.Memory.
- CPU 0 owns devices and JSPI scheduling. Secondary CPUs enter kw_secondary_entry and wait with memory.atomic.wait32.
- Node implements the same CPU host with node:worker_threads.

The SMP bundle contains a UP module plus a hash-bound UP-to-SMP patch. The runtime applies it before compiling shared memory. Neither threads nor that shared memory model is available in Workers.

Upstream CPU host: [js/node/cpu.ts](https://github.com/pithings/unkernel/blob/2abdc598e2d08c2a4d673254ae4581703d33a7a8/js/node/cpu.ts).

## This project's Workers/DO design

The public Worker owns four named Durable Objects: 0, 1, 2 and 3. Each object boots and retains one UP kernel plus one Axum guest. A GuestManager instance belongs to the Durable Object, not to the module, because multiple objects can share an isolate.

Normal HTTP requests use round-robin shards. CPU requests are split into independent jobs, sent concurrently to up to four objects, and reduced in the edge Worker:

- Each shard receives a job count and an offset into the deterministic xorshift workload.
- Offsets are global job bases, so uneven splits neither duplicate nor skip work.
- Each guest runs its jobs with Tokio's four-thread runtime and spawn_blocking.
- The edge sums the exact u64 checksums, returned as decimal strings.
- The response reports the number of shards used separately from each guest's one-CPU parallelism.

This is horizontal CPU parallelism, not shared-memory SMP. It works for independent jobs. It cannot accelerate a single guest task that requires shared memory or synchronous communication between CPUs.

## Scheduling reality

Distinct Durable Object IDs are the supported unit of independent scheduling. Concurrent RPC calls can run concurrently, but Cloudflare may pack objects into one isolate. Local workerd results are useful for correctness and protocol overhead, not proof of physical-core parallelism. The deployed Worker must be benchmarked before claiming a specific speedup.

If DO packing serializes the workload, the next Workers-only experiment is four separately named backend Workers reached through public fetch, which gives the edge more opportunities to select separate isolates. That adds network latency and still has no placement guarantee.

For sustained batch throughput rather than a synchronous response, Queues or
Workflows can fan out independent Worker invocations more aggressively. They
still do not provide shared memory or per-request core affinity.

## Memory and lifecycle

Each shard allocates a 64 MiB kernel, with 48/32 MiB fallbacks. Four shards require four successful placements; they must not be assumed to fit in one 128 MiB isolate. Object eviction loses the warm kernel and the next request boots it again.

A shard has one turn queue. Only one request context drives its suspended Wasm
stack at a time. The lease is claimed synchronously before boot or batching
awaits, and the head is removed from the queue at the same time. Safe
GET/HEAD/OPTIONS requests can share a turn; mutations are exclusive. Waiters
poll completed job state rather than awaiting a promise another request
resolves. The compatibility flag retains the VM's own cross-request JSPI
continuations.

CPU cancellation follows the same rule. A cancel RPC only signals the active
turn owner; the owner sends the guest cancellation while its original CPU fetch
is still pending. Request bodies are capped at 8 MiB, read-only batch responses
at 256 KiB and exclusive responses at 8 MiB.

Normal HTTP requests use round-robin shards because the demo guest is
stateless. The x-unkernel-route: shard0 header preserves an affinity escape
hatch for stateful routes.
