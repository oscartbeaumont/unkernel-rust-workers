# unkernel-rs

A Rust + Axum hello world running in Cloudflare Workers — as a real Linux
process, not as a wasm binary.

The Axum server is a fully static `aarch64-unknown-linux-musl` executable
that runs inside a real Linux kernel compiled to WebAssembly
([unkernel](https://github.com/pithings/unkernel), a Linux 7.x build with a
real MMU). The kernel and the binary are loaded by the Worker, the kernel
boots once per isolate, and every request is proxied to the guest's
loopback port 3000 over the kernel's vsock channel.

This is the point of the project: **the app needs no WASM support for Tokio
or Axum**. The kernel is a native wasm module that Cloudflare Workers is
allowed to run (it is bundled, not compiled at runtime), and the app is an
unmodified aarch64 Linux binary that runs exactly as it would on a Linux
host.

## How it works

```
request ──► worker (Cloudflare Workers, TS)
                 │   boot on the first request of the isolate
                 ▼
           unkernel kernel (WebAssembly, 3.52 MB, built from the fork)
                 │   init → kwtty, no busybox, no distro
                 ▼
           axum-hello (aarch64 musl binary, 790 KB, packed in the initrd)
                 │
                 └─ 127.0.0.1:3000 ──► vm.fetch() ──► HTTP response
```

- The kernel is loaded from `assets/unkernel.wasm`, imported as a
  wrangler-bundled `CompiledWasm` module (Workers disallows runtime wasm
  compilation, so no bytes are compiled in production). It is built from
  the unkernel fork with the JIT tier and most of the kernel's features
  turned off (see below).
- The guest binary is packed into the kernel's initrd by
  `scripts/kernel-prep.mjs`, so there is no data module and no 9p mount:
  the isolate boots the kernel and execs the server.
- Requests are forwarded with `vm.fetch()` (HTTP/1.1 over vsock), so the
  guest sees a normal localhost TCP connection. No network backends, no
  specialist host software: everything runs inside one isolate.
- The Worker runs a forked host runtime (`sdk/`): the kernel's WASI clock,
  randomness, console, task switching and vsock/kwtty/HTTP path, and
  nothing else (no display, sound, input, disks, network stack, mounts,
  snapshots, profiler or JIT hosts).

## Bundle size and startup

The deployed bundle is one wasm module (3.52 MB) plus the Worker script
(56 KB): **3,490 KiB raw / 1,583 KiB gzip** (`cf deploy --dry-run`).

| step | bytes |
| --- | --- |
| stock `unkernel.wasm` from the npm package | 10,165,321 |
| kernel fork: `KWEMU_JIT=0`, `-Os`, a 16 KiB printk ring, and a config trimmed to this app | 4,969,494 (bundled) |
| drop sections it never reads, keep only the 9 exports the host uses, and build the initrd from init + kwtty + the server (no busybox base image) | 4,159,756 |
| `wasm-opt -Oz --closed-world --remove-unused-module-elements` | 3,517,686 |
| Worker script: the forked host instead of the SDK | 56,545 |

That is **6.79 MB → 3.49 MB (−49%)** for this round and **11.55 MB →
3.49 MB (−70%)** from the first deployment. Boot (local `cf dev`,
`scripts/bench.mjs --cold`): **~320 ms → ~60–70 ms** (median); warm `GET /health`
p50 **~1.6 ms**, p99 ~7 ms (400 sequential, no stalls). Concurrent requests
share the one VM through a fair lease (see [Concurrency](#concurrency)).

### The specialized kernel

The kernel is rebuilt from the fork (`KWEMU_JIT=0`, `KW_SMP=0` and a config
fragment on top of `kw_defconfig`). What that buys, measured on the same
tree and toolchain:

- the kwemu JIT tier: **317 KB** (the Worker can never call it);
- the kernel config: **2.27 MB** — no cgroups/namespaces/POSIX IPC, no block
  layer, ext4 or erofs, no 9p, no AF_UNIX, no packet sockets, no virtio,
  display, sound or input, no modules, BTF or debug info. The guest is
  `/init` → devtmpfs/proc/sysfs/tmpfs + loopback, `/usr/bin/kwtty`, and the
  server; nothing else exists;
- `CONFIG_BLOCK=n` alone is another **202 KB**.

`KWVIRTIO=n` is not optional with the pinned SDK: the fork's defconfig kernel
imports `unkernel.wasm_driver_virtio_*`, which the SDK does not provide, and
the kernel traps on the first call.

Build it with `npm run kernel` (`kernel/build-kernel.sh`): Docker only —
Ubuntu 26.04 with clang/lld 22, Zig 0.16 from ziglang.org, and unkernel's own
`kernel/build.sh` builds the patched `wasm-ld` from LLVM 22 on the first run
(the LLVM build dominates: 10–60 minutes depending on the machine; ~8 s after
that, since the toolchain, the checkout and the kernel build live in a Docker
volume). It pins `pithings/unkernel@2abdc598e2d08c2a4d673254ae4581703d33a7a8`
and writes the bundled kernel (vmlinux32 + the package's base initrd +
cmdline, 6,069,048 B) to `assets/unkernel.fork.wasm`. The config fragment is
`kernel/kw_worker.config`.

A rebuild reproduces the kernel's size and config, not necessarily its bytes:
the shipped bundle is the recipe's output (`sha256 0a4705…`), and an
independent build here came out byte-different with the same size and config
(codegen depends on the exact LLVM patch release that apt's `clang-22`
resolves to).

`./build.sh` uses `assets/unkernel.fork.wasm` when it is present and the
published package's kernel otherwise (`KERNEL=path` overrides both).

### The Worker script

`unkernel/web` is the browser page API: it brings display, downloads,
IndexedDB stores, HTTP disk images, a WASI worker and every device host. The
fork in `sdk/` keeps the kernel's runtime (WASI clocks and randomness,
console, task switching, vsock, kwtty, HTTP/1.1) and answers the other device
imports like the SDK's *disabled* hosts do (`-ENODEV`, benign 0), so the guest
registers no device and never reaches them. The script goes from 205 KB to
~56 KB and the isolate has nothing to construct at boot.

### Startup

Boot is `createKernel` (~15–25 ms, Linux itself), then `spawn` waits for the
guest's kwtty, then the server binds (~7 ms). The Worker asks for the spawn
while the guest is still booting, so the first connection is refused: the
fork retries every 5 ms instead of the upstream 100 ms (`sdk/tty.ts`), which
is ~85 ms of the cold start. The readiness probe backs off 2 → 100 ms instead
of a fixed 150 ms poll.

### Concurrency

One VM is shared by every request in the isolate (one boot, not one VM per
request). Because the guest is a single-threaded Linux server, requests go
through a fair FIFO lease: a request owns the guest from just before its vsock
connection opens until its response body ends, and waiters poll with short
timers. That is not only a throughput choice. The kernel makes progress inside
whichever request is driving it, and the runtime's promise rules make a
request's continuation unsafe when another request's turn settles it: with
several requests driving one guest, workerd aborts the batch with *"Promise
will never complete"* as soon as a timer fires. The lease keeps every
suspension and continuation inside the request that owns the guest; waiters use
timers rather than a promise chain for the same reason (workerd cancels a
request that awaits a promise only another request can settle).

Measured locally (`cf dev`, 400–800 requests each, `GET /health`, zero
failures):

| concurrency | p50 | p99 | max |
| --- | --- | --- | --- |
| 1 (sequential) | 1.6 ms | 7.4 ms | 21 ms |
| 8 | 19 ms | 28 ms | 31 ms |
| 32 | 82 ms | 173 ms | 177 ms |

The guest serves one request in about 1.5–2 ms on the interpreter, so the
ceiling is ~500 requests/s per isolate; a 32-deep burst is spread over that
rate instead of failing. A request that streams a large body holds the lease
until the client finishes or disconnects, so a slow download delays the
requests behind it: with one VM, correctness wins over interleaving.

Every response carries `x-unkernel-queue-ms` (time waiting for the lease) and
`x-unkernel-ttfb-ms` (time from acquiring the guest to its response head), so
a client can separate the Worker's share from the edge's. At 400 requests,
8-deep, against the deployed Worker they were p99 **16 ms** and **0–5 ms**,
while the client saw 63 ms p50: most of that is TLS/edge/client, not the VM.

### Measured dead ends

- **AOT replacement for the JIT (byte-keyed):** the JIT emits wasm modules at
  runtime, which Workers forbids; capturing them offline and matching by
  content hash does not work — the emitted bytes embed run-specific block
  offsets (five captures of the same workload gave 5, 3, 1, 1 and 3 modules
  with different hashes).
- **AOT replacement (PC-keyed):** the fork emits single blocks, whose bytes
  *are* boot-independent, and 44 captured blocks were shipped as bundled
  modules and installed by guest PC with interpreter fallback. Measured in
  Node and in workerd: **no gain**. kwemu's own JIT with the same codegen is
  slower than the interpreter for these routes (0.865 vs 0.751 ms `/health`),
  so removing compile cost only reaches parity (0.601 vs 0.615 ms paired
  p50), and p99 got worse (6.5–7.9 ms vs 2.4–2.8 ms) from the per-instance
  first call. Cold was 11 ms worse just for carrying the modules.
- **Eager boot at module scope:** workerd refuses async work, timers and
  random values in global scope, and the kernel needs `random_get()` to
  boot — an isolate cannot start the VM until a request handler runs.

### The other path: AOT (works, not shipped)

The kernel path is what this repo ships and what runs in production. The
same binary can instead be **translated to wasm at build time**, dropping the
kernel and kwemu entirely. That project lives in
`~/gh/oscartbeaumont-labs/unkernel-aot` (aarch64 → wasm translator, Linux ABI
shim, Worker harness) and it now runs this exact `axum-hello.bin` — musl,
tokio, hyper and all — with no kernel and no interpreter:

| | kernel + kwemu (shipped) | AOT of this binary |
| --- | --- | --- |
| module | 3,517,686 B | 4,462,977 B → 3,318,937 B (wasm-opt) |
| upload raw / gzip | 3,490 KiB / 1,583 KiB | 4,436 KiB / **1,344 KiB** |
| boot to "listening" | ~65 ms | **~11 ms** (workerd, 200 boots; 6 ms Node) |
| warm `/health` p50 / p99 | ~1.9 / ~2.8 ms | **0.86 / 2.64 ms** |
| guest work per request | — | **~103 µs** |
| correctness evidence | real Linux kernel | 19/19 differential guests byte-identical, 2,000 requests 0 failures |
| body streaming | (whole request/response through vsock) | 64 KiB chunks both ways: a 64 MiB echo with 64 KiB buffered |

Honest read: the win is **boot (~6×) and per-request p50 (~2×)**, plus a much
smaller trusted computing base. It is **not** a raw-size win for a binary of
this size (4.46 MB against 4.44 MB; gzip is 23% smaller), and p99 is unchanged
because it is workerd's HTTP pipeline, not the guest. The AOT runtime is also
narrower than a kernel: no threads (`clone` is `-ENOSYS`), a synthetic socket
layer instead of TCP, a stub file system, and one request per connection. That
is why it is not the default here yet: a binary is only runnable if it fits
that shape (this one does), so this repo keeps the kernel as the general path
and the fallback.
## Repo layout

```
worker/
  index.ts         the Worker: boots the kernel once, proxies requests
  kernel.ts        the kernel factory bound to this Worker
  assets.d.ts      types for the wrangler-bundled .wasm import
sdk/               the forked host runtime (vsock, kwtty, HTTP, WASI, console)
rust/
  Cargo.toml       "unkernel-axum" crate
  src/main.rs      the Axum hello world
guest/init/
  init.c           the guest init: mounts, loopback, kwtty, reaping
kernel/
  build-kernel.sh  the fork build (Docker): vmlinux32 + base initrd + cmdline
  kw_worker.config the kernel config fragment (JIT off, this app only)
  image/           the build image, the in-container script and the bundler
scripts/
  kernel-prep.mjs  sections, exports and initrd for the deployed kernel
  guest-exec.mjs   run a command in the debug image (WITH_SHELL=1)
  bench.mjs        cold/warm benchmark (spawns `cf dev`)
  jit-capture-20.mjs, jit-ab.mjs  the AOT-JIT investigation (not in the build)
build.sh           npm install + Docker guest build + kernel prep + wasm-opt
cloudflare.config.ts  the Worker (name, entrypoint, compat flags)
wrangler.config.ts    the bundler (minified, no source maps)
```

The large files in `assets/` are build artifacts (gitignored) produced by
`./build.sh` (and by the kernel fork's build for `assets/unkernel.fork.wasm`).

## Prerequisites

- Node 24+
- Docker (with the `linux/arm64` platform)
- [binaryen](https://github.com/WebAssembly/binaryen) (`brew install binaryen`)
- A Cloudflare account for deploy (optional for local dev)

## Build

```sh
npm run kernel          # the specialized kernel -> assets/unkernel.fork.wasm
./build.sh              # guest binaries (Docker) + kernel prep + wasm-opt
WITH_SHELL=1 ./build.sh # the debug image (see below)
KERNEL=path ./build.sh  # prepare another kernel (default: the fork kernel)
npm run build           # ./build.sh + cf build (wrangler under the hood)
```

`./build.sh` builds the Axum server and the guest init in `rust:1-alpine` for
`aarch64-unknown-linux-musl` (static, stripped, LTO), then prepares the kernel
and optimizes it with `wasm-opt`. The artifacts in `assets/` are gitignored.

### The shell image (opt-in)

The default image's only userland is the init and kwtty: no busybox, no shell,
and `vm.exec()` would fail (the Worker never needs it). When debugging is
worth ~760 KB of upload (and some cold start), build the base image with:

```sh
WITH_SHELL=1 ./build.sh
node scripts/guest-exec.mjs uname -a
node scripts/guest-exec.mjs sh -c 'ls -l /hello; cat /proc/meminfo'
```

That image keeps the package's base userland (busybox, the kw tools, a shell
on the console) and adds the server at `/hello/axum-hello`, which is all the
Worker spawns either way. It is larger and boots slower; deploy the default
image unless you need the shell.

## Run locally

```sh
npx cf dev
```

then in another terminal:

```sh
curl http://localhost:8787/
# Hello from unkernel-rs (Rust + Axum on Cloudflare Workers)
curl http://localhost:8787/health
# ok
curl -X POST --data 'hi' http://localhost:8787/echo
# hi
```

The first request boots the kernel (~65 ms). Requests after that are a few
milliseconds. The guest's boot log goes to the Worker logs.

## Deploy

```sh
npx cf auth login   # once
npx cf deploy
```

The deploy uploads ~3.5 MB of wasm and ~0.06 MB of script (well within the)
Workers size limit); the kernel is an imported module, never served as a
static asset.

## Notes and limitations

- One kernel per isolate, booted on the first request. After the isolate is
  evicted, the next request boots a fresh one.
- **The 3 s stalls are fixed.** A rare stall came from resuming a JSPI
  stack synchronously inside another wasm import (`wasm_switch_to`'s
  `resume(prev)` and the poll wake in `sdk/kernel.ts`): under workerd, V8
  could lose the continuation, leaving the guest's scheduler parked with a
  vsock IRQ pending and no progress. Both resumes now run on a microtask.
  Measured: 0 stalls in 400 sequential and 2,000 concurrent requests (was a
  few per few hundred, each 3 s). The Worker still bounds a guest that stops
  answering: no first byte in 3 s recycles the VM and replays once, with a
  keepalive timer so the runtime does not treat the replay as hung. The
  timeout covers time to first byte, not the body.
- Connections cannot be pooled across requests: a stream opened in one
  request cannot be read in another (workerd cancels the request as hung),
  so every request opens its own kwtty/vsock connection. The lease means one
  connection is open at a time anyway. A reused connection is 4–5× cheaper in
  the guest (0.11 ms vs 0.55 ms for `/health`), but it is not available here.
- The default guest image has no shell (`vm.exec()` would fail); the Worker
  only needs `createKernel`, `spawn`, `connect` and `fetch`. `WITH_SHELL=1`
  builds the debugging image that has one.
- The guest runs on the interpreter (`jit: false`), since Workers does not
  allow dynamic wasm compilation. Startup and the axum server are well
  within the 30 s per-request CPU budget.
- `compatibilityFlags: ["no_handle_cross_request_promise_resolution"]`
  is required: the kernel boots in the first request that runs it, and its
  JSPI promise chains settle in later requests. The default handling would
  drop those continuations once the boot request ends. The lease keeps every
  request's own continuations inside its turn, so the legacy behavior is safe
  here; it is what lets the shared kernel outlive its first request.
- The guest runs the usual unkernel limitations (e.g. no SMP, no inbound
  connections); nothing more is done here than the SDK supports.

## Licenses

- `worker/`, `sdk/`, `rust/`, `guest/`, `scripts/`, `build.sh`: MIT (same as
  the unkernel SDK)
- `assets/unkernel.wasm`: Linux kernel + unkernel guest, GPL-2.0-only /
  MIT mix — see https://github.com/pithings/unkernel for the full text
