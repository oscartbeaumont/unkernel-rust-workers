#!/bin/sh
# Builds the pieces the Worker deploys:
#   assets/unkernel.wasm  - the unkernel kernel (from the npm package)
#   assets/axum-hello.bin - the static aarch64 musl hello world (built in Docker)
#
# Usage: ./build.sh    (from the repository root)
set -eu

cd "$(dirname "$0")"

echo "==> installing npm dependencies"
npm install --no-audit --no-fund

echo "==> copying the kernel from the published unkernel package"
mkdir -p assets
cp node_modules/unkernel/dist/unkernel.wasm assets/unkernel.wasm
rm -f assets/axum-hello assets/axum-hello.bin

echo "==> building the Rust guest (aarch64-unknown-linux-musl, static)"
mkdir -p assets
docker run --rm --platform linux/arm64 \
  -v "$PWD/rust:/src" \
  -v "$PWD/assets:/out" \
  -w /src \
  rust:1-alpine \
  sh -c "cargo build --release --target aarch64-unknown-linux-musl && cp target/aarch64-unknown-linux-musl/release/axum-hello /out/axum-hello.bin"

echo "==> done"
ls -la assets/
