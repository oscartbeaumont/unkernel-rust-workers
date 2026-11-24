# unkernel-rust-workers

> Built on [unkernel](https://github.com/pithings/unkernel) by
> [Pooya Parsa (@pi0)](https://github.com/pi0). The Linux kernel, kwemu,
> vsock/kwtty stack and host runtime are unkernel's work. This project builds a
> specialized kernel and adds the Rust + Axum guest and Cloudflare Worker.

A static aarch64-unknown-linux-musl Rust + Axum server runs inside a real Linux
kernel compiled to WebAssembly. CPU jobs are sharded across four Cloudflare
Durable Objects, each with its own persistent kernel and guest.

**Live:** https://unkernel-rust-workers.oscartbeaumont.workers.dev

    curl https://unkernel-rust-workers.oscartbeaumont.workers.dev/health
    # ok

## Why Workers cannot host SMP directly

Workers has one thread per isolate. It does not support Web Workers,
WebAssembly threads or a useful shared-memory threading facility. Separate
isolates cannot share unkernel's linear memory, page tables or IPIs. Service
bindings usually run on the same thread, so they are not a CPU fan-out primitive.

Upstream unkernel uses one nested Web Worker per vCPU for browser SMP. Node uses
worker_threads for the same shared-memory CPU host. Neither thread model exists
in Workers, and Containers are deliberately not used by this project.

The Workers/DO alternative is horizontal: four independent UP kernels process
four independent job partitions. This can use multiple hosts/cores, but
Cloudflare does not guarantee a separate core for each Durable Object. The full
analysis is in docs/multithreading.md.

## How it works

    client
      -> Worker (edge coordinator)
      -> Durable Objects 0, 1, 2, 3
           -> one persistent UP Linux kernel per object
           -> /init + kwtty + axum-hello (aarch64 musl)
           -> 127.0.0.1:3000 <-- HTTP/1.1 over vsock

Normal requests use round-robin shards. A CPU request is split into up to four partitions,
sent concurrently to distinct Durable Object IDs, and reduced by the edge
Worker. Each partition uses a different deterministic workload offset; the edge
sums exact u64 checksums returned as decimal strings.

Each Durable Object owns its GuestManager. This is intentional: multiple objects
can share an isolate, so module-level VM or queue state would make them interfere.

## The guest

The guest is an ordinary static Linux binary. It knows nothing about Workers,
Durable Objects, Wasm or the edge.

- Tokio uses the multi-thread runtime with four worker threads and a four-thread blocking pool.
- Axum serves /, /health, POST /echo and GET /cpu.
- /cpu accepts jobs, iterations, shards and offset. Jobs and iterations are capped.
- The xorshift workload is unrolled without changing its recurrence, and black_box prevents dead-code elimination.
- /echo preserves the original UTF-8-lossy text behavior.
- /__debug reports every shard's kernel, queue and turn statistics.

The /cpu endpoint is a public benchmark, not an authenticated API. Add rate
limiting or authentication before exposing an untrusted CPU workload.

## CPU benchmarks

Eight million iterations per job, warmed Durable Objects, exact checksums.
Deployed Workers runtime, nine runs:

| jobs | shards | fanout median | request p50 | request p99 |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 1 | 597 ms | 614.1 ms | 709.4 ms |
| 4 | 4 | 264 ms | 294.0 ms | 305.5 ms |

The same four-job workload is 2.26x faster in fanout time and 52.1% lower
end-to-end latency with four Durable Objects. The checksum is identical. This
exceeds the 20% optimization target, but remains best-effort placement rather
than guaranteed core affinity.

Production stress, 200 requests per concurrency level, completed with zero
failures. Health p50 ranged from 75 to 124 ms across concurrency 1–64, and an
aborted four-job CPU request released every shard queue in about 1.7 seconds.

Local workerd serializes CPU-bound Durable Object calls on one event-loop thread.
It is useful for correctness and protocol overhead, but not for multicore
scaling. Production placement is the only meaningful speed test.

Reproduce:

    npm run bench:cpu -- --url https://unkernel-rust-workers.oscartbeaumont.workers.dev --jobs 4 --shards 1,4 --runs 9
    npm run stress -- --url https://unkernel-rust-workers.oscartbeaumont.workers.dev --requests 800

## Turns and request safety

Only one request context may drive a kernel's suspended Wasm stack at a time.
Each Durable Object therefore has one turn queue:

- Safe GET/HEAD/OPTIONS requests can share a turn, up to 16 connections.
- Mutations are exclusive.
- Read-only batches buffer up to 256 KiB per job; exclusive responses buffer up to 8 MiB. Larger responses fail rather than holding a VM across request contexts.
- Request bodies are capped at 8 MiB before queueing.
- Waiters poll completed job state instead of awaiting a promise another request resolves.
- A failed response-header wait recycles the kernel and replays eligible jobs once. Body failures never trigger a replay.
- CPU cancellation is signalled to the active turn owner, which sends the guest cancellation from the same request context. Clients never receive the internal cancellation tokens.
- no_handle_cross_request_promise_resolution retains the VM's own JSPI continuations across requests.

## Kernel and bundle

The kernel is unkernel's Linux 7.x port, rebuilt from a pinned commit with
KWEMU_JIT=0, KW_SMP=0 and kernel/kw_worker.config. Kept: MMU, ELF loading, TCP
loopback, vsock, pty, proc/devtmpfs and futex. Removed: cgroups,
namespaces, POSIX IPC, block layer, ext4, erofs, 9p, packet sockets, virtio,
display, sound, input, sysfs, tmpfs, shmem, modules, BTF and debug info. The
initramfs is already the root filesystem, and failed /sys or /tmp mounts are
non-fatal.

The optimized Worker upload is 3,096.96 KiB raw / 1,506.71 KiB gzip, 12.5%
smaller than the first DO implementation. The specialized kernel uses a Zstandard
initrd; the stock-package fallback stays on gzip.

The host runtime in sdk/ is a specialized fork of unkernel's browser runtime:
WASI clocks/randomness, console, task switching, vsock, kwtty and HTTP/1.1.
Unused device imports answer -ENODEV or a benign zero.

## Build and run

Requires Node 26.12+, Docker with linux/arm64 emulation for the guest build, and
binaryen (brew install binaryen).

    npm install
    npm run kernel       # optional specialized kernel; otherwise the npm kernel is used
    npm run build
    npm run dev

    curl http://localhost:8787/health
    curl http://localhost:8787/
    curl -X POST --data 'hi' http://localhost:8787/echo
    curl 'http://localhost:8787/cpu?jobs=4&iterations=8000000'
    curl http://localhost:8787/__debug

In another terminal:

    npm test
    npm run stress
    npm run bench
    npm run bench:cpu

Deploy:

    npx cf auth login
    npm run deploy

WITH_SHELL=1 ./build.sh keeps busybox and a shell in the Worker fallback image
for debugging. It costs about 760 KiB more and boots more slowly. The
size-focused kernel omits sysfs/tmpfs, so full shell debugging needs a kernel
rebuilt with those filesystems enabled.

## Limits

- Each guest has one vCPU. Tokio threads inside one guest time-slice that CPU.
- Four Durable Objects provide best-effort horizontal CPU parallelism, not shared-memory SMP.
- Cloudflare does not guarantee separate isolates, threads or physical cores for the four objects.
- Each shard needs a 64 MiB kernel, with 48/32 MiB fallbacks. Four shards must be placed across isolates within the 128 MiB per-isolate limit.
- Object eviction loses the warm kernel; the next request pays a fresh boot.
- Normal requests use round-robin shards because this demo guest is stateless. Send x-unkernel-route: shard0 when a future route needs affinity.
- Client abort cancels queued CPU work immediately and asks active turn owners to stop the guest workload. Cancellation is best effort if the runtime evicts the driver.
- The guest has loopback only; the Worker is its sole network client.

## Repo layout

    worker/do.ts          edge fan-out plus one GuestManager per Durable Object
    worker/index.ts       original single-kernel Worker implementation
    rust/src/main.rs      Tokio multi-thread + Axum guest
    kernel/               kernel build, config fragment and build image
    scripts/kernel-prep.mjs  initrd packing, export trimming, section cleanup
    scripts/bench-cpu.mjs  CPU scaling benchmark with checksum verification
    scripts/stress.mjs     concurrency and correctness stress test
    docs/multithreading.md  platform constraint and upstream SMP mapping
    sdk/                  specialized Workers host runtime
    assets/               gitignored build artifacts

## Credits and licenses

- [unkernel](https://github.com/pithings/unkernel) by Pooya Parsa and contributors: kernel, kwemu, vsock/kwtty and host runtime. MIT.
- The Linux kernel in the image: GPL-2.0-only.
- worker/, rust/, guest/, scripts/, kernel/ and build.sh: MIT, same as unkernel.
