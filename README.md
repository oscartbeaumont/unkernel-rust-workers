# unkernel-rust-workers

> **Built on [unkernel](https://github.com/pithings/unkernel)** by
> [Pooya Parsa (@pi0)](https://github.com/pi0): the Linux kernel compiled to
> WebAssembly, kwemu, the vsock/kwtty stack and the host runtime under `sdk/`
> are unkernel's work, not this repo's. This project vendors a fork of that
> runtime, builds the kernel from a pinned fork commit, and adds the Rust +
> Axum guest, the guest init and the Cloudflare Worker around it.

A real Rust + Axum server running inside a Linux kernel compiled to
WebAssembly, in a Cloudflare Worker. The app is an ordinary
`aarch64-unknown-linux-musl` binary: nothing in it knows about Workers, wasm
or the edge.

**Live:** https://unkernel-rust-workers.oscartbeaumont.workers.dev

```sh
curl https://unkernel-rust-workers.oscartbeaumont.workers.dev/health
# ok
```

## Why this exists

Workers run JavaScript and WebAssembly. Most services are neither: they are
normal Linux programs built on Tokio, Hyper, threads, `epoll`, files and TCP.
Porting one to `wasm32-unknown-unknown` is a rewrite: the OS disappears, and
its pieces have to be rebuilt.

This project takes the other route: the wasm module is **Linux itself**. The
kernel boots in the isolate, the unmodified server runs inside it, and the
Worker forwards HTTP to the server's loopback port. The app crosses no wasm
boundary; the kernel does.

What that buys:

- **Any static Linux binary runs.** No wasm build, no Tokio/Axum shims, no
  `cfg(target_arch = "wasm32")` in the app.
- **Real Linux behaviour.** `epoll`, `futex`, threads, `/proc`, `/dev`, TCP
  loopback and ELF loading are the kernel's own, not a reimplementation.
- **One boot per isolate.** The kernel takes ~60–85 ms to come up, then
  requests take milliseconds.
- **Small enough to ship.** 3.49 MB raw / 1.58 MB gzip in one bundle, down
  from 11.55 MB.
- **Self-contained.** No external VMs, containers or network backends: the
  Worker, the kernel and the app are the whole system.

The honest costs are in [Limits](#limits): one CPU, one VM, no inbound network,
and an interpreted guest.

## How it works

```
client ──► Worker (TypeScript, one isolate)
              │  first request: boot the kernel once
              ▼
        Linux kernel (WebAssembly)
              │  initrd: /init, kwtty, /hello/axum-hello
              ▼
        axum-hello (aarch64 musl, unmodified)
              │
              └─ 127.0.0.1:3000 ◄── vm.fetch() ── HTTP/1.1 over vsock
```

1. The first request boots the kernel. It cannot happen at module scope:
   Workers forbids async work, timers and random values there, and the kernel
   needs `random_get()` to boot.
2. The kernel mounts a tiny initrd, brings up loopback, and starts the server
   through kwtty.
3. Each Worker request opens an HTTP/1.1 connection to the guest's loopback
   port and returns the guest's response.
4. Every request in the isolate shares that one VM (see
   [Concurrency](#concurrency)).

### The kernel

The kernel is unkernel's Linux 7.x port, rebuilt from a pinned fork commit
with `KWEMU_JIT=0`, `KW_SMP=0` and a config fragment
(`kernel/kw_worker.config`) that keeps only what this app uses.

Kept: MMU, ELF loading, TCP loopback, vsock, pty, `proc`/`sys`/`devtmpfs`/
`tmpfs`. Removed: cgroups, namespaces, POSIX IPC, the block layer, ext4,
erofs, 9p, packet sockets, virtio, display, sound, input, modules, BTF and
debug info.

The guest userland is `/init` (mounts, loopback, kwtty, reaping) plus the
server. There is no busybox and no distro by default.

### The host runtime (`sdk/`)

`unkernel/web` is the browser page API: display, downloads, IndexedDB, HTTP
disk images, every device host. The fork in `sdk/` keeps only what a Worker
needs: WASI clocks and randomness, console, task switching, vsock, kwtty and
HTTP/1.1. Every removed device import is answered the way unkernel's disabled
hosts answer it (`-ENODEV` or a benign 0), so the guest registers no device and
never calls them.

The script went from ~205 KB to ~59 KB, and the isolate has nothing to
construct at boot.

### The Worker (`worker/index.ts`)

It boots the kernel once, queues requests, drives the guest, bounds a guest
that stops answering (3 s to first byte, then recycle and replay once), and
adds `Server-Timing` headers.

## Concurrency

One VM per isolate, one boot. But only one **request context** at a time may
drive it: the kernel is a single suspended wasm stack, and workerd ties the
continuations that resume it to the request that created them. Two requests
driving at once is not slow, it is invalid — workerd aborts the batch with
*"Promise will never complete"*.

So the unit of scheduling is a **turn**. The request at the head of the queue
drives the VM; when it is a safe request (GET/HEAD/OPTIONS without a body) it
runs up to 16 guest connections at once in its own context, buffers their
responses (256 KiB each), and hands them to the waiting requests. The VM is
released as soon as the turn's bodies are read, so a slow client no longer
holds it while it reads.

- POST/PUT/PATCH/DELETE keep the exclusive lane: an oversized response cannot
  be replayed without duplicating the effect.
- A safe response larger than the buffer cap is deferred to its own turn,
  where it streams.
- A large streamed body still holds the VM until the client is done. With one
  VM there is no way to run two turns at once.

Local `cf dev`, 800 requests each, `GET /health`, zero failures:

| concurrency | p50 | p99 | max |
| --- | --- | --- | --- |
| 1 | 1.7 ms | 7.3 ms | 22 ms |
| 8 | 7.1 ms | 15.6 ms | 22 ms |
| 16 | 12.9 ms | 27.8 ms | 30 ms |
| 32 | 23 ms | 47 ms | 48 ms |
| 64 | 44 ms | 71 ms | 72 ms |

The same runs with the old per-request lease were 21 ms and 82 ms at 8- and
32-deep: every request paid a handoff, and no request could share a turn.

Every response carries a standard `Server-Timing` header:
`unkernel-queue` (waiting for a turn), `unkernel-ttfb` (turn start to the
guest's response head), `unkernel-body` (head to buffered body end) and
`unkernel-batch` (requests in that turn). Chrome DevTools shows them under
Network → Timing → Server Timing.

## Making it small and fast

The deployed bundle is one wasm module plus the Worker script:
**3,490 KiB raw / 1,583 KiB gzip**. It started at 11.55 MB.

| step | size |
| --- | --- |
| stock `unkernel.wasm` from the npm package | 10,165,321 B |
| kernel rebuilt for this app | 4,969,494 B |
| sections, exports and initrd trimmed | 4,159,756 B |
| `wasm-opt -Oz --closed-world` | 3,517,686 B |
| Worker script (forked host) | 59,320 B |

What actually moved the needle:

- **The JIT tier: 317 KB.** The Worker can never call kwemu's JIT, so it is
  compiled out.
- **The kernel config: 2.27 MB.** `CONFIG_BLOCK=n` alone is 202 KB; the rest
  is the list above. The kernel is also built with `-Os` and a 16 KiB printk
  ring instead of 128 KiB.
- **The initrd.** No busybox, no distro: `init`, kwtty and the server.
- **`wasm-opt`.** 4.16 MB → 3.52 MB after dropping sections the kernel never
  reads and keeping only the 9 exports the host uses.
- **A forked host runtime.** 205 KB → 59 KB, and nothing constructed at boot.

Boot went from ~320 ms to ~60–70 ms. A big part of that was a fixed 100 ms
retry in kwtty: the first connection races the guest, and the fork retries
every 5 ms (`sdk/tty.ts`) instead. The readiness probe backs off 2 → 100 ms
rather than polling at a fixed 150 ms.

Things that did **not** work, so they are not here:

- Replacing the JIT with AOT-compiled hot blocks (byte-keyed and PC-keyed).
  Both reached parity at best and made p99 worse.
- Booting at module scope. Workerd refuses it, and the kernel needs randomness.
- The built-in `node:wasi`. It is an unimplemented stub in workerd;
  `@cloudflare/workers-wasi` works but costs 167 KiB and is ~3× slower per
  call, and it covers none of sockets, epoll or futex.

## The AOT path

The kernel path is what ships. The same binary can instead be **translated to
wasm at build time**, dropping the kernel and kwemu entirely. A separate
prototype (aarch64 → wasm translator, Linux ABI shim, Worker harness) runs
this exact `axum-hello.bin` — musl, Tokio, Hyper and all — with no kernel and
no interpreter:

| | kernel + kwemu (shipped) | AOT prototype |
| --- | --- | --- |
| module | 3.52 MB | 3.32 MB after `wasm-opt` |
| gzip | 1.58 MB | 1.14 MB |
| boot to "listening" | ~60–85 ms | **~11 ms** |
| warm `/health` p50 | 1.7 ms | **0.86 ms** |
| app changes | none | none |

The translator covers this binary completely: 162,759 instructions and 41,801
basic blocks, with no unsupported operations, and a differential corpus of 19
guests came out byte-identical. Raw size is roughly a wash (3.32 MB against
3.52 MB; gzip is ~28% smaller), but the real wins are boot (~6×) and p50
(~2×). p99 is unchanged, because that is workerd's HTTP pipeline, not the
guest.

It is narrower than a kernel: no threads (`clone` is `-ENOSYS`), a synthetic
socket layer instead of TCP, a stub file system, and one request per
connection.

That is why the kernel remains the general path and the fallback: a binary is
only runnable through AOT if it fits that shape. This one does.

## Repo layout

```
worker/index.ts       boot, turns, timeouts, Server-Timing
worker/kernel.ts      the kernel factory bound to this Worker
sdk/                  the forked host runtime (vsock, kwtty, HTTP, WASI, console)
rust/src/main.rs      the Axum server
guest/init/init.c     mounts, loopback, kwtty, reaping
kernel/               the fork build, config fragment and build image
scripts/              kernel prep, guest exec, benchmark
build.sh              guest builds + kernel prep + wasm-opt
cloudflare.config.ts  the Worker (name, entrypoint, compat flags)
wrangler.config.ts    the bundler (minified, no source maps)
```

`assets/` holds build artifacts and is gitignored.

## Build and run

Requires Node 24+, Docker with the `linux/arm64` platform, and
[binaryen](https://github.com/WebAssembly/binaryen) (`brew install binaryen`).

```sh
git clone https://github.com/oscartbeaumont/unkernel-rust-workers
cd unkernel-rust-workers
npm install

npm run kernel          # the specialized kernel -> assets/unkernel.fork.wasm
./build.sh              # guest binaries + kernel prep + wasm-opt
npm run build           # ./build.sh + cf build
```

The kernel build runs in Docker (Ubuntu 26.04, clang/lld 22, Zig 0.16). The
first run compiles a patched `wasm-ld` and takes 10–60 minutes; later runs are
seconds because the toolchain and checkout live in a Docker volume. A rebuild
reproduces the size and config, not necessarily the bytes: codegen depends on
the exact LLVM patch release. One non-obvious requirement: the pinned SDK does
not provide the virtio imports, so the kernel must be built with
`KWVIRTIO=n`; otherwise it traps on the first call.

`./build.sh` uses `assets/unkernel.fork.wasm` when present and the npm
package's kernel otherwise; `KERNEL=path` overrides both.

For local development:

```sh
npx cf dev
```

```sh
curl http://localhost:8787/
curl http://localhost:8787/health
curl -X POST --data 'hi' http://localhost:8787/echo
```

To deploy:

```sh
npx cf auth login   # once
npx cf deploy
```

### The shell image (opt-in)

The default image has no busybox and no shell; the Worker only needs
`createKernel`, `spawn`, `connect` and `fetch`. When debugging is worth
~760 KB of upload and some cold start:

```sh
WITH_SHELL=1 ./build.sh
node scripts/guest-exec.mjs uname -a
node scripts/guest-exec.mjs sh -c 'ls -l /hello; cat /proc/meminfo'
```

## Limits

- One kernel per isolate, booted on the first request. Eviction means a fresh
  boot next time.
- The guest has **one CPU**. Workers has no shared-memory wasm threads, so
  unkernel's SMP kernel cannot run here and Tokio's multi-thread runtime gets
  one worker. `current_thread` is the right shape. (Details in
  [issue #1](https://github.com/oscartbeaumont/unkernel-rust-workers/issues/1).)
- Only one request context drives the guest at a time. Batched turns make that
  cheap for small requests; a response over 256 KiB streams from its own turn
  and holds the VM until the client is done.
- The guest has no inbound network: loopback only, and the Worker is its only
  client. Connections cannot be pooled across requests.
- The guest runs on the interpreter: Workers does not allow dynamic wasm
  compilation. Startup and the server are well inside the CPU budget.
- `no_handle_cross_request_promise_resolution` is required. The kernel boots
  in the first request that runs it, and its JSPI chains settle in later
  requests; the default handling would drop them once the boot request ends.
  A turn keeps its own continuations inside one request, so the legacy
  behavior is safe here.

## Credits and licenses

- [unkernel](https://github.com/pithings/unkernel) by Pooya Parsa and
  contributors: the kernel, kwemu, vsock/kwtty and the host runtime this repo
  forks. MIT.
- The Linux kernel in the image: GPL-2.0-only.
- `worker/`, `sdk/`, `rust/`, `guest/`, `scripts/` and `build.sh`: MIT,
  same as unkernel.
