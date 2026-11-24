#!/bin/sh
# Builds the two pieces the Worker deploys as one module:
#
#   assets/axum-hello.bin - the static aarch64 musl hello world (panic=abort,
#                           so its unused unwind tables are removed)
#   assets/kw-init        - the guest's init (guest/init/init.c), static
#   assets/unkernel.wasm  - the unkernel kernel, prepared for the Worker by
#                           scripts/kernel-prep.mjs: sections the Worker does
#                           not read are dropped, only the exports the SDK
#                           uses are kept (the rest are a symbol table that
#                           makes dead code look live), and the initrd is
#                           built from just init + kwtty + the server binary
#                           instead of the package's busybox base image.
#                           wasm-opt -Oz plus zero-memory/flow passes then
#                           removes the code the dropped exports kept alive.
#
# The result boots a Linux kernel whose only userland is the guest server: no
# busybox, no overlay, no 9p mount, no data module. (vm.exec() needs a shell
# this image does not have; createKernel/spawn/connect/fetch are all it needs.)
#
# Shell image (opt-in, for debugging): WITH_SHELL=1 keeps the SDK's base userland
# (busybox, the kw tools, a shell on the console, so vm.exec() works) and adds
# the server at /hello/axum-hello. It costs ~760 KB of upload and boots slower
# (the base init does more work: ~390 ms cold instead of ~85 ms). The
# size-focused kernel config omits sysfs/tmpfs, so full shell debugging needs a
# kernel rebuilt with those filesystems enabled.
#
# Usage: ./build.sh              (from the repository root; needs Docker and binaryen)
#        INITRD_COMPRESSION=zstd ./build.sh (smallest image; specialized kernel only)
#        WITH_SHELL=1 ./build.sh (debug image: base userland + the server)
set -eu

cd "$(dirname "$0")"

echo "==> installing npm dependencies"
npm install --no-audit --no-fund

mkdir -p assets

# Which kernel to prepare: KERNEL=path, else the specialized kernel in
# assets/unkernel.fork.wasm (built from the unkernel fork, see the README),
# else the published package's.
kernel_src="${KERNEL:-}"
specialized_kernel=0
if [ -z "$kernel_src" ] && [ -f assets/unkernel.fork.wasm ]; then
  kernel_src=assets/unkernel.fork.wasm
  specialized_kernel=1
  echo "==> using the specialized kernel (assets/unkernel.fork.wasm)"
fi
case "$kernel_src" in
  assets/unkernel.fork.wasm|./assets/unkernel.fork.wasm|"$PWD/assets/unkernel.fork.wasm") specialized_kernel=1 ;;
esac
if [ -z "$kernel_src" ]; then
  echo "==> copying the kernel from the published unkernel package"
  cp node_modules/unkernel/dist/unkernel.wasm assets/unkernel.src.wasm
  kernel_src=assets/unkernel.src.wasm
fi

# Pick the format the selected kernel supports: the specialized kernel has
# zstd (another ~88 KiB saved), while the published-package fallback keeps the
# universally supported gzip image. INITRD_COMPRESSION can override this.
if [ -z "${INITRD_COMPRESSION:-}" ]; then
  if [ "$specialized_kernel" = 1 ]; then initrd_compression=zstd; else initrd_compression=gzip; fi
fi
initrd_compression=${INITRD_COMPRESSION:-$initrd_compression}
case "$initrd_compression" in
  gzip|zstd) ;;
  *) echo "INITRD_COMPRESSION must be gzip or zstd" >&2; exit 1 ;;
esac
if [ "$initrd_compression" = zstd ] && [ "$specialized_kernel" != 1 ]; then
  echo "zstd initrd requires the specialized assets/unkernel.fork.wasm kernel; use INITRD_COMPRESSION=gzip for other kernels" >&2
  exit 1
fi

echo "==> building the guest binaries (aarch64-unknown-linux-musl, static)"
docker run --rm --platform linux/arm64 \
  -v "$PWD/rust:/src" \
  -v "$PWD/guest/init:/init" \
  -v "$PWD/assets:/out" \
  -w /src \
  rust:1-alpine \
  sh -c "cargo build --release --target aarch64-unknown-linux-musl &&
         cp target/aarch64-unknown-linux-musl/release/axum-hello /out/axum-hello.bin &&
         objcopy --remove-section=.eh_frame --remove-section=.eh_frame_hdr --remove-section=.gcc_except_table /out/axum-hello.bin /out/axum-hello.bin.tmp &&
         mv /out/axum-hello.bin.tmp /out/axum-hello.bin &&
         gcc -static -Os -s -o /out/kw-init /init/init.c"

if [ "${WITH_SHELL:-0}" = 1 ]; then
  # Debug image: the package's base userland (busybox, a shell on the console,
  # the kw tools) plus the server. The Worker boots no distro disk, so the base
  # init keeps the initramfs as its root and /hello/axum-hello is there; the
  # Worker spawns the same path in both images.
  echo "==> preparing the kernel (sections, exports, initrd: base image + shell, $initrd_compression)"
  node scripts/kernel-prep.mjs \
    --in "$kernel_src" \
    --out assets/unkernel.prep.wasm \
    --binary assets/axum-hello.bin \
    --guest-path /hello/axum-hello \
    --initrd-compression "$initrd_compression"
else
  echo "==> preparing the kernel (sections, exports, initrd: init + kwtty + server, $initrd_compression)"
  node scripts/kernel-prep.mjs \
    --in "$kernel_src" \
    --out assets/unkernel.prep.wasm \
    --binary assets/axum-hello.bin \
    --guest-path /hello/axum-hello \
    --minimal-initrd \
    --add /init=assets/kw-init \
    --add-from-initrd /usr/bin/kwtty=kw/layer/usr/bin/kwtty \
    --initrd-compression "$initrd_compression"
fi

echo "==> optimizing the kernel with wasm-opt (binaryen)"
if ! command -v wasm-opt >/dev/null 2>&1; then
  echo "wasm-opt not found; install binaryen (brew install binaryen). Keeping the prepared kernel."
  mv assets/unkernel.prep.wasm assets/unkernel.wasm
else
  # Imported WebAssembly.Memory is zero-initialized by specification. GUFA,
  # flatten and rereloop then shrink the kernel's control flow without changing
  # its imports or the five exports the UP SDK reads.
  wasm-opt -Oz -c --strip-debug --closed-world --remove-unused-module-elements \
    --zero-filled-memory --gufa --flatten --rereloop -Oz \
    assets/unkernel.prep.wasm -o assets/unkernel.wasm
  rm -f assets/unkernel.prep.wasm
fi

rm -f assets/unkernel.src.wasm

echo "==> done"
ls -la assets/
