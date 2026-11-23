#!/usr/bin/env bash
# Runs inside the build image (image/Dockerfile), driven by build-kernel.sh.
# Mounts: /cache (the keep-forever volume), /work (this lab, read-only),
# /out (where the bundled kernel is written), /repo (the unkernel-rs checkout,
# read-only; its node_modules/unkernel/dist/unkernel.wasm has the base initrd).
set -euo pipefail

: "${UNKERNEL_REPO:?}" "${UNKERNEL_COMMIT:?}" "${ZIG_VERSION:?}" "${KW_FRAGS:?}" "${JOBS:?}"
: "${BASE_INITRD_WASM:?}"

src=/cache/unkernel
zig=/cache/zig/zig
export PATH=/usr/lib/llvm-22/bin:$PATH

echo "== host: $(uname -m), $(nproc) cpus; cache /cache; kernel $UNKERNEL_REPO@$UNKERNEL_COMMIT"

# ---- zig -------------------------------------------------------------------
if [ ! -x "$zig" ]; then
	case "$(uname -m)" in
	aarch64) url="$ZIG_URL_AARCH64"; sum="$ZIG_SHA_AARCH64"; zdir="zig-aarch64-linux-$ZIG_VERSION" ;;
	x86_64) url="$ZIG_URL_X86_64"; sum="$ZIG_SHA_X86_64"; zdir="zig-x86_64-linux-$ZIG_VERSION" ;;
	*) echo "no Zig $ZIG_VERSION for $(uname -m) at ziglang.org" >&2; exit 1 ;;
	esac
	echo "== zig $ZIG_VERSION"
	curl -fL --retry 3 -o /cache/zig.tar.xz "$url"
	echo "$sum  /cache/zig.tar.xz" | sha256sum -c --status || { echo "zig checksum mismatch" >&2; exit 1; }
	rm -rf /cache/zig /cache/zig-extract
	mkdir -p /cache/zig-extract
	tar xf /cache/zig.tar.xz -C /cache/zig-extract
	top=$(find /cache/zig-extract -mindepth 1 -maxdepth 1 -type d | head -1)
	[ -n "$top" ] || { echo "zig archive has no top-level directory" >&2; exit 1; }
	mv "$top" /cache/zig
	rm -rf /cache/zig-extract /cache/zig.tar.xz
	[ -x "$zig" ] || { echo "zig unpacked without $zig" >&2; exit 1; }
fi
"$zig" version

# ---- unkernel at the pinned commit ----------------------------------------
# git init in place, never rm -rf: a previous run's vendor/ (the LLVM source,
# the wasm-ld build, the kernel tree) is the expensive part and stays.
if [ ! -d "$src/.git" ]; then
	echo "== initialising the unkernel checkout"
	mkdir -p "$src"
	git init -q "$src"
fi
if ! git -C "$src" remote get-url origin >/dev/null 2>&1; then
	git -C "$src" remote add origin "$UNKERNEL_REPO"
fi
if ! git -C "$src" cat-file -e "$UNKERNEL_COMMIT^{commit}" 2>/dev/null; then
	echo "== fetching $UNKERNEL_COMMIT"
	git -C "$src" fetch --depth 1 origin "$UNKERNEL_COMMIT"
fi
if [ "$(git -C "$src" rev-parse HEAD 2>/dev/null || true)" != "$UNKERNEL_COMMIT" ]; then
	echo "== checking out $UNKERNEL_COMMIT"
	git -C "$src" checkout -q --detach "$UNKERNEL_COMMIT"
fi
echo "== unkernel $(git -C "$src" rev-parse --short HEAD)"

# ---- this lab's config fragment(s), and the one-line build.sh hook ---------
for f in $KW_FRAGS; do
	[ "$f" = kw_defconfig ] && continue
	# only touch the file when it changed: a newer fragment makes build.sh
	# reconfigure (and rebuild) the kernel, the point of the cache is not to
	cmp -s "/work/$f" "$src/kernel/configs-extra/$f" || install -D -m644 "/work/$f" "$src/kernel/configs-extra/$f"
done
bash /work/image/patch-build.sh "$src/kernel/build.sh"

# ---- kwemu (no JIT tier: a Worker cannot compile wasm at runtime) -----------
echo "== kwemu (-Dkwemu-jit=false)"
(cd "$src" && "$zig" build -Dkwemu-jit=false --prefix /cache/kwemu)

# ---- kernel (+ the patched wasm-ld, built from LLVM 22.1.8 on the first run) -
echo "== kernel ($KW_FRAGS)"
(cd "$src" && KW_SMP=0 KWEMU_JIT=0 KWEMU=/cache/kwemu/lib/libkwemu.a \
	KOUT=/cache/kout JOBS="$JOBS" KW_FRAGS="$KW_FRAGS" ./kernel/build.sh kernel)

cfg=/cache/kout/.config
echo "== config: $(grep -c '^CONFIG_' "$cfg") on, $(grep -c '^# CONFIG_.* is not set' "$cfg") off"
for k in BINFMT_SCRIPT BINFMT_ELF UNIX AF_UNIX_OOB UNIX98_PTYS VSOCKETS KWVSOCK KWNET BLOCK KWVIRTIO DRM EROFS_FS NET_9P CGROUPS SMP; do
	printf '   %-16s %s\n' "$k" "$(grep -E "^(CONFIG_$k=|# CONFIG_$k is not set)" "$cfg" | head -1)"
done

# ---- bundle: kernel + the SDK package's base initrd + the command line -----
echo "== bundle"
node /work/image/bundle.mjs \
	--kernel /cache/kout/vmlinux32.wasm \
	--initrd-wasm "$BASE_INITRD_WASM" \
	--out /out/unkernel.fork.wasm \
	--cmdline "console=hvc0 rdinit=/init"

echo "== kernel module sizes"
stat -c '   %s  %n' /cache/kout/vmlinux /cache/kout/vmlinux32.wasm /out/unkernel.fork.wasm
