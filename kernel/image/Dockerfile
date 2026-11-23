# The kernel-build image for build-kernel.sh: Ubuntu 26.04 ships clang/lld 22
# for arm64 and amd64 (the kernel needs clang >= 21 with a wasm64 target), and
# the kernel only needs the usual build tools on top. Zig comes from
# ziglang.org at build time, and the patched wasm-ld is built from LLVM 22.1.8
# source by unkernel's own kernel/build.sh (the ~10 minute first step).
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential git ca-certificates curl xz-utils zstd \
      cmake ninja-build flex bison bc libelf-dev python3 perl \
      patch file coreutils \
      clang-22 lld-22 llvm-22 \
      nodejs \
 && rm -rf /var/lib/apt/lists/*

# kernel/build.sh links its tools into vendor/toolchain/bin from LLVM's bin;
# the PATH puts the 22 tools ahead of anything else.
ENV PATH=/usr/lib/llvm-22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /cache
