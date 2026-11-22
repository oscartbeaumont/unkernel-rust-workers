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
                 │   lazy boot (first request per isolate)
                 ▼
           unkernel kernel (WebAssembly, ~10 MB)
                 │   base shell (busybox + kw tools), no distro download
                 ▼
           axum-hello (aarch64 musl binary, ~1 MB, mounted read-only)
                 │
                 └─ 127.0.0.1:3000 ──► vm.fetch() ──► HTTP response
```

- The kernel is loaded from `assets/unkernel.wasm` — the same file the
  published `unkernel` npm package ships — imported as a wrangler-bundled
  `CompiledWasm` module (Workers disallows runtime wasm compilation, so no
  bytes are compiled in production).
- The binary is imported as a wrangler `Data` module, written into a
  read-only in-memory filesystem in the guest, and spawned with the SDK.
- Requests are forwarded with `vm.fetch()` (HTTP/1.1 over vsock), so the
  guest sees a normal localhost TCP connection. No network backends, no
  specialist host software: everything runs inside one isolate.

Because Workers disallows dynamic wasm compilation, the kernel's JIT is
disabled (`jit: false`); the guest interpreter is enough for a hello
world, and the kernel log stays clean.

## Repo layout

```
worker/
  index.ts         the Worker: boots the kernel once, proxies requests
  assets.d.ts      types for the wrangler-bundled .wasm / .bin imports
rust/
  Cargo.toml       "unkernel-axum" crate
  src/main.rs      the Axum hello world
build.sh           npm install + kernel copy + Docker Rust build
wrangler.toml      the Worker config (Data rule for the binary)
.github/
```

The two large files in `assets/` — `unkernel.wasm` (~10 MB) and
`axum-hello.bin` (~1 MB) — are build artifacts (gitignored) produced by
`./build.sh`. The kernel comes from the published `unkernel` npm package;
the binary is built in Docker from `rust/`.

The Worker is configured as `cloudflare.config.ts` (`cf/config`) plus
`wrangler.config.ts` (the Wrangler bundler holds the Data rule for the
binary). The documented flow is `cf dev` / `cf build` / `cf deploy`;
`wrangler dev` / `wrangler deploy` remain available for the parts that
read the Wrangler config.

## Prerequisites

- Node 24+
- Docker (with the `linux/arm64` platform)
- A Cloudflare account for deploy (optional for local dev)

## Build

```sh
npm run assets   # ./build.sh: npm install + kernel copy + Docker Rust build
npm run build    # assets + cf build (wrangler under the hood)
```

`./build.sh` installs dependencies, copies the published `unkernel.wasm` into
`assets/`, and builds the binary in `rust:1-alpine` for
`aarch64-unknown-linux-musl` (static, stripped, LTO). The build artifacts
in `assets/` are gitignored; `npm run build` regenerates them and then
builds the Worker bundle with `cf build`.

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

The first request boots the kernel (~0.3 s). Requests after that are a few
milliseconds. The guest's boot log goes to the Worker logs.

## Deploy

```sh
npx cf auth login   # once
npx cf deploy
```

Requires `npx cf auth whoami` to succeed. The deploy uploads ~11 MB of wasm and ~1 MB of binary (within the Workers size limit); both are imported as additional modules, never served as static assets.

## Notes and limitations

- One kernel per isolate, booted lazily on the first request. After the
  isolate is evicted, the next request boots a fresh one.
- The guest runs on the tree-shaken interpreter (`jit: false`), since
  Workers does not allow dynamic wasm compilation. Startup and the axum
  server are well within the 30 s per-request CPU budget.
- Requests go through the guest's single-threaded TCP stack — this is a
  hello world, not a high-throughput service.
- `compatibilityFlags: ["no_handle_cross_request_promise_resolution"]`
  is required: the kernel's promise chains (JSPI wakeups) must resolve
  across requests, not only inside the request that created them.
- The guest runs the usual unkernel limitations (e.g. no SMP, no inbound
  connections); nothing more is done here than the SDK supports.

## Licenses

- `worker/`, `rust/`, `build.sh`, `wrangler.toml`: MIT (same as the
  unkernel SDK)
- `assets/unkernel.wasm`: Linux kernel + unkernel guest, GPL-2.0-only /
  MIT mix — see https://github.com/pithings/unkernel for the full text
