#!/bin/sh
# build-kernel.sh - build unkernel's Linux kernel specialized for the
# unkernel-rust-workers Worker, in Docker, and write the BUNDLED kernel module the repo's
# build.sh wants at assets/unkernel.fork.wasm.
#
# What it produces: vmlinux32.wasm (the UP kernel, kwemu without its JIT tier,
# this lab's config fragment) + the published SDK package's base initrd, byte
# for byte + "console=hvc0 rdinit=/init". No SMP patch, no data disk. The
# repo's build.sh then cuts the minimal or the shell image out of it with
# scripts/kernel-prep.mjs and runs wasm-opt.
#
# Cost: ~10 minutes the first run on this machine (the LLVM 22.1.8 + patched
# wasm-ld build is ~6 of them at JOBS=8; Zig, kwemu, the Linux tree fetch and
# the kernel are the rest); ~8 seconds after that when nothing changed, a minute
# or two when the kernel has to rebuild. The LLVM source and build, Zig, kwemu,
# the kernel tree and its build all live in the docker volume $CACHE_VOLUME and
# make/zig/ninja are incremental.
#
# Needs only Docker: ubuntu:26.04 + clang/lld 22 (from apt) + Zig 0.16 (from
# ziglang.org) are set up by image/Dockerfile and this script. No macOS host
# tool is used. The container writes only $CACHE_VOLUME and ./out; the one file
# it writes into the checkout is $OUT (assets/unkernel.fork.wasm by default).
#
# Env:
#   REPO=<path>            the unkernel-rust-workers checkout (default: this file's repo);
#                          its node_modules/unkernel/dist/unkernel.wasm supplies
#                          the base initrd (npm install it first)
#   OUT=<path>             where to write the bundled module
#                          (default $REPO/assets/unkernel.fork.wasm)
#   CACHE_VOLUME=<name>    docker volume for the toolchain/kernels
#                          (default unkernel-kwbuild-cache; a new name builds
#                          from scratch: ~10-15 min)
#   JOBS=<n>               parallelism in the container (default 8; the kernel
#                          build needs about 0.8 GiB per job)
#   KW_FRAGS="a b"         config fragments after kw_defconfig
#                          (default "kw_defconfig kw_worker.config")
#   FORCE_CONFIG=1         wipe the kernel build dir first (reconfigure)
#   DOCKER_IMAGE=<tag>     build image tag (default unkernel-kwbuild:22)
#   UNKERNEL_REPO / UNKERNEL_COMMIT   pin (default pithings/unkernel @ 2abdc59)
#   BASE_INITRD_WASM=<path in REPO>   default node_modules/unkernel/dist/unkernel.wasm
#
# Examples:
#   ./build-kernel.sh
#   OUT=/tmp/unkernel.fork.wasm ./build-kernel.sh
#   CACHE_VOLUME=kw-cache-fresh ./build-kernel.sh     # prove a from-scratch build
#   FORCE_CONFIG=1 ./build-kernel.sh                  # after editing kw_worker.config
set -eu

here=$(cd "$(dirname "$0")" && pwd)

REPO=${REPO:-$(cd "$here/.." && pwd)}
OUT=${OUT:-$REPO/assets/unkernel.fork.wasm}
CACHE_VOLUME=${CACHE_VOLUME:-unkernel-kwbuild-cache}
JOBS=${JOBS:-8}
DOCKER_IMAGE=${DOCKER_IMAGE:-unkernel-kwbuild:22}
KW_FRAGS=${KW_FRAGS:-kw_defconfig kw_worker.config}
BASE_INITRD_WASM=${BASE_INITRD_WASM:-node_modules/unkernel/dist/unkernel.wasm}

UNKERNEL_REPO=${UNKERNEL_REPO:-https://github.com/pithings/unkernel}
UNKERNEL_COMMIT=${UNKERNEL_COMMIT:-2abdc598e2d08c2a4d673254ae4581703d33a7a8}

# Zig 0.16.0 (https://ziglang.org/download/index.json), checksums pinned.
ZIG_VERSION=0.16.0
ZIG_URL_AARCH64=https://ziglang.org/download/0.16.0/zig-aarch64-linux-0.16.0.tar.xz
ZIG_SHA_AARCH64=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17
ZIG_URL_X86_64=https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz
ZIG_SHA_X86_64=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00

command -v docker >/dev/null 2>&1 || { echo "build-kernel.sh: docker is not on PATH" >&2; exit 1; }
[ -d "$REPO" ] || { echo "build-kernel.sh: no repo at $REPO (set REPO=)" >&2; exit 1; }
[ -f "$REPO/$BASE_INITRD_WASM" ] || {
	echo "build-kernel.sh: $REPO/$BASE_INITRD_WASM is missing; run npm install in $REPO" >&2
	echo "  (its unkernel.initrd section is the base userland both images are cut from)" >&2
	exit 1
}

echo "== image $DOCKER_IMAGE"
docker build -q -t "$DOCKER_IMAGE" "$here/image" >/dev/null
docker volume create "$CACHE_VOLUME" >/dev/null

if [ "${FORCE_CONFIG:-0}" = 1 ] && docker run --rm -v "$CACHE_VOLUME:/cache" "$DOCKER_IMAGE" test -f /cache/kout/.config; then
	echo "== FORCE_CONFIG=1: clearing /cache/kout"
	docker run --rm -v "$CACHE_VOLUME:/cache" "$DOCKER_IMAGE" rm -rf /cache/kout
fi

mkdir -p "$here/out"
echo "== building (cache volume $CACHE_VOLUME, jobs $JOBS)"
docker run --rm \
	-v "$CACHE_VOLUME:/cache" \
	-v "$here:/work:ro" \
	-v "$here/out:/out" \
	-v "$REPO:/repo:ro" \
	-e UNKERNEL_REPO="$UNKERNEL_REPO" \
	-e UNKERNEL_COMMIT="$UNKERNEL_COMMIT" \
	-e ZIG_VERSION="$ZIG_VERSION" \
	-e ZIG_URL_AARCH64="$ZIG_URL_AARCH64" -e ZIG_SHA_AARCH64="$ZIG_SHA_AARCH64" \
	-e ZIG_URL_X86_64="$ZIG_URL_X86_64" -e ZIG_SHA_X86_64="$ZIG_SHA_X86_64" \
	-e KW_FRAGS="$KW_FRAGS" -e JOBS="$JOBS" \
	-e BASE_INITRD_WASM="/repo/$BASE_INITRD_WASM" \
	"$DOCKER_IMAGE" bash /work/image/build-in-container.sh

out_dir=$(cd "$(dirname "$OUT")" && pwd -P)
out_abs="$out_dir/$(basename "$OUT")"
if [ "$out_abs" != "$here/out/unkernel.fork.wasm" ]; then
	mkdir -p "$out_dir"
	cp "$here/out/unkernel.fork.wasm" "$out_abs"
fi

echo
echo "== $OUT"
ls -l "$out_abs"
(cd "$out_dir" && { shasum -a 256 "$(basename "$out_abs")" 2>/dev/null || sha256sum "$(basename "$out_abs")"; })
echo
echo "Next: in $REPO, ./build.sh (minimal image) or WITH_SHELL=1 ./build.sh (debug image)."
