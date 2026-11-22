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
           unkernel kernel (WebAssembly, 6.4 MB)
                 │   init → kwtty, no busybox, no distro
                 ▼
           axum-hello (aarch64 musl binary, 790 KB, packed in the initrd)
                 │
                 └─ 127.0.0.1:3000 ──► vm.fetch() ──► HTTP response
```

- The kernel is loaded from `assets/unkernel.wasm`, imported as a
  wrangler-bundled `CompiledWasm` module (Workers disallows runtime wasm
  compilation, so no bytes are compiled in production).
- The guest binary is packed into the kernel's initrd by
  `scripts/kernel-prep.mjs`, so there is no data module and no 9p mount:
  the isolate boots the kernel and execs the server.
- Requests are forwarded with `vm.fetch()` (HTTP/1.1 over vsock), so the
  guest sees a normal localhost TCP connection. No network backends, no
  specialist host software: everything runs inside one isolate.

Because Workers disallows dynamic wasm compilation, the kernel's JIT is
disabled (`jit: false`); the interpreter is enough for a hello world, and the
kernel log stays clean. (Measured in Node, where the JIT is allowed: it is
not faster for these routes — `/health` 0.58 ms with the JIT vs 0.51 ms
without, `POST /echo` ~8% slower with it. `scripts/jit-ab.mjs` reproduces
that.)

## Bundle size

The deployed bundle is one wasm module (6.4 MB) plus the Worker script
(0.2 MB). `./build.sh` gets the kernel there from the stock 10.2 MB one:

| step | bytes |
| --- | --- |
| stock `unkernel.wasm` from the npm package | 10,165,321 |
| drop unused sections (`name`, `producers`, the SMP patch, the data disk) | |
| keep only the exports the SDK reads (the other 11k are a symbol table) | |
| build the initrd from init + kwtty + the server (no busybox base image) | 7,723,325 |
| `wasm-opt -Oz --closed-world --remove-unused-module-elements` | 6,744,890 |

The Worker script also lost the SDK's browser page (`unkernel/web` pulls in
display, downloads, IndexedDB, HTTP disks and a WASI worker): `worker/kernel.ts`
calls the same factory it does with the platform a Worker actually has, which
takes it from 503 KB to 205 KB.

In total: **9.03 MB → 6.79 MB for the upload (−25%)**, and 11.55 MB → 6.79 MB
(−41%) from the first deployment (`cf deploy --dry-run`: 6,787 KiB raw,
2,593 KiB gzip). Boot (local `cf dev`, `scripts/bench.mjs --cold`): ~320 ms →
~85 ms; warm `GET /health` p50 ~2 ms.

Half of the remaining boot is a plain SDK bug worth knowing about: the
terminal client retries a refused kwtty connection every 100 ms, so the first
spawn (issued while the guest is still booting) throws away most of a poll
interval. `scripts/patch-sdk.mjs` retries every 5 ms instead — that alone is
~85 ms of the cold start.

Two things are deliberately *not* in the bundle:

- **An AOT replacement for the JIT.** The JIT emits wasm modules at runtime,
  which Workers forbids; the natural workaround is to capture them offline
  and ship them. That does not survive measurement: the emitted bytes embed
  run-specific block offsets (five captures of the same workload gave 5, 3,
  1, 1 and 3 modules with different hashes), the Worker boots a different
  kernel instantiation anyway, and the JIT is slower than the interpreter
  for these routes. `scripts/jit-capture-20.mjs` is the capture tool and
  documents the evidence.
- **Eager boot at module scope.** Workerd refuses async work, timers and
  random values in global scope, and the kernel needs `random_get()` to
  boot, so an isolate cannot start the VM until a request handler runs. What
  *is* available — a 2 ms → 100 ms backoff on the readiness probe instead of
  a fixed 150 ms poll — is in `worker/index.ts`.

## Repo layout

```
worker/
  index.ts         the Worker: boots the kernel once, proxies requests
  kernel.ts        createKernel without the SDK's browser page (205 KB less)
  assets.d.ts      types for the wrangler-bundled .wasm import
rust/
  Cargo.toml       "unkernel-axum" crate
  src/main.rs      the Axum hello world
guest/init/
  init.c           the guest init: mounts, loopback, kwtty, reaping
scripts/
  kernel-prep.mjs  sections, exports and initrd for the deployed kernel
  patch-sdk.mjs    the kwtty retry interval (100 ms -> 5 ms)
  bench.mjs        cold/warm benchmark (spawns `cf dev`)
  jit-capture-20.mjs, jit-ab.mjs  the AOT-JIT investigation (not in the build)
build.sh           npm install + Docker guest build + kernel prep + wasm-opt
cloudflare.config.ts  the Worker (name, entrypoint, compat flags)
wrangler.config.ts    the bundler (minified, no source maps)
```

The large files in `assets/` are build artifacts (gitignored) produced by
`./build.sh`.

## Prerequisites

- Node 24+
- Docker (with the `linux/arm64` platform)
- [binaryen](https://github.com/WebAssembly/binaryen) (`brew install binaryen`)
- A Cloudflare account for deploy (optional for local dev)

## Build

```sh
./build.sh       # guest binaries (Docker) + kernel prep + wasm-opt
npm run build    # ./build.sh + cf build (wrangler under the hood)
```

`./build.sh` builds the Axum server and the guest init in `rust:1-alpine` for
`aarch64-unknown-linux-musl` (static, stripped, LTO), then prepares the kernel
and optimizes it with `wasm-opt`. The artifacts in `assets/` are gitignored.

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

The first request boots the kernel (~0.09 s). Requests after that are a few
milliseconds. The guest's boot log goes to the Worker logs.

## Deploy

```sh
npx cf auth login   # once
npx cf deploy
```

The deploy uploads ~6.4 MB of wasm and ~0.2 MB of script (within the Workers
size limit); the kernel is an imported module, never served as a static asset.

## Notes and limitations

- One kernel per isolate, booted on the first request. After the isolate is
  evicted, the next request boots a fresh one.
- The guest image has no shell (`vm.exec()` would fail); the Worker only
  needs `createKernel`, `spawn`, `connect` and `fetch`.
- The guest runs on the interpreter (`jit: false`), since Workers does not
  allow dynamic wasm compilation. Startup and the axum server are well
  within the 30 s per-request CPU budget.
- Requests go through the guest's single-threaded TCP stack — this is a
  hello world, not a high-throughput service.
- `compatibilityFlags: ["no_handle_cross_request_promise_resolution"]`
  is required: the kernel's promise chains (JSPI wakeups) must resolve
  across requests, not only inside the request that created them.
- The guest runs the usual unkernel limitations (e.g. no SMP, no inbound
  connections); nothing more is done here than the SDK supports.

## Licenses

- `worker/`, `rust/`, `guest/`, `scripts/`, `build.sh`: MIT (same as the
  unkernel SDK)
- `assets/unkernel.wasm`: Linux kernel + unkernel guest, GPL-2.0-only /
  MIT mix — see https://github.com/pithings/unkernel for the full text
