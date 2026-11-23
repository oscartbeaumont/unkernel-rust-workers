#!/bin/sh
# Builds the two pieces the Worker deploys as one module:
#
#   assets/axum-hello.bin - the static aarch64 musl hello world
#   assets/kw-init        - the guest's init (guest/init/init.c), static
#   assets/unkernel.wasm  - the unkernel kernel, prepared for the Worker by
#                           scripts/kernel-prep.mjs: sections the Worker does
#                           not read are dropped, only the exports the SDK
#                           uses are kept (the rest are a symbol table that
#                           makes dead code look live), and the initrd is
#                           built from just init + kwtty + the server binary
#                           instead of the package's busybox base image.
#                           wasm-opt -Oz then removes the code the dropped
#                           exports kept alive.
#
# The result boots a Linux kernel whose only userland is the guest server: no
# busybox, no overlay, no 9p mount, no data module. (vm.exec() needs a shell
# this image does not have; createKernel/spawn/connect/fetch are all it needs.)
#
# Shell image (opt-in, for debugging): WITH_SHELL=1 keeps the SDK's base userland
# (busybox, the kw tools, a shell on the console, so vm.exec() works) and adds
# the server at /hello/axum-hello. It costs ~760 KB of upload and boots slower
# (the base init does more work: ~390 ms cold instead of ~85 ms).
#
# Usage: ./build.sh              (from the repository root; needs Docker and binaryen)
#        WITH_SHELL=1 ./build.sh (debug image: base userland + the server)
set -eu

cd "$(dirname "$0")"

echo "==> installing npm dependencies"
npm install --no-audit --no-fund

echo "==> patching the SDK's kwtty retry (100 ms -> 5 ms)"
node scripts/patch-sdk.mjs

echo "==> copying the kernel from the published unkernel package"
mkdir -p assets
cp node_modules/unkernel/dist/unkernel.wasm assets/unkernel.src.wasm

echo "==> building the guest binaries (aarch64-unknown-linux-musl, static)"
docker run --rm --platform linux/arm64 \
  -v "$PWD/rust:/src" \
  -v "$PWD/guest/init:/init" \
  -v "$PWD/assets:/out" \
  -w /src \
  rust:1-alpine \
  sh -c "cargo build --release --target aarch64-unknown-linux-musl &&
         cp target/aarch64-unknown-linux-musl/release/axum-hello /out/axum-hello.bin &&
         gcc -static -Os -s -o /out/kw-init /init/init.c"

if [ "${WITH_SHELL:-0}" = 1 ]; then
  # Debug image: the package's base userland (busybox, a shell on the console,
  # the kw tools) plus the server. The Worker boots no distro disk, so the base
  # init keeps the initramfs as its root and /hello/axum-hello is there; the
  # Worker spawns the same path in both images.
  echo "==> preparing the kernel (sections, exports, initrd: base image + shell)"
  node scripts/kernel-prep.mjs \
    --in assets/unkernel.src.wasm \
    --out assets/unkernel.prep.wasm \
    --binary assets/axum-hello.bin \
    --guest-path /hello/axum-hello
else
  echo "==> preparing the kernel (sections, exports, initrd: init + kwtty + server)"
  node scripts/kernel-prep.mjs \
    --in assets/unkernel.src.wasm \
    --out assets/unkernel.prep.wasm \
    --binary assets/axum-hello.bin \
    --guest-path /hello/axum-hello \
    --minimal-initrd \
    --add /init=assets/kw-init \
    --add-from-initrd /usr/bin/kwtty=kw/layer/usr/bin/kwtty
fi

echo "==> optimizing the kernel with wasm-opt (binaryen)"
if ! command -v wasm-opt >/dev/null 2>&1; then
  echo "wasm-opt not found; install binaryen (brew install binaryen). Keeping the prepared kernel."
  mv assets/unkernel.prep.wasm assets/unkernel.wasm
else
  wasm-opt -Oz -c --strip-debug --closed-world --remove-unused-module-elements \
    assets/unkernel.prep.wasm -o assets/unkernel.wasm
  rm -f assets/unkernel.prep.wasm
fi

rm -f assets/unkernel.src.wasm

echo "==> done"
ls -la assets/
