#!/usr/bin/env bash
# Patch the pinned unkernel checkout so kernel/build.sh takes extra config
# fragments (this lab's kw_worker.config) and nothing else changes:
#   1. frags=(kw_defconfig) -> frags=(${KW_FRAGS:-kw_defconfig})
#   2. install kernel/configs-extra/* into the kernel tree's
#      arch/wasm/configs before configuring (that directory exists only after
#      the kernel patch series is applied).
# Idempotent: a second run finds the marker and does nothing.
set -eu
p="${1:?usage: patch-build.sh /cache/unkernel/kernel/build.sh}"
python3 - "$p" <<\PY
import sys
path = sys.argv[1]
s = open(path).read()
if "kernel-fork-lab: extra config fragments" in s:
    print("patch-build: already patched")
    raise SystemExit(0)
old = "frags=(kw_defconfig)"
if old not in s:
    raise SystemExit("patch-build: no frags=(kw_defconfig) in " + path)
s = s.replace(old, "frags=(${KW_FRAGS:-kw_defconfig})", 1)
marker = "\tprepare_kernel_tree\n"
if marker not in s:
    raise SystemExit("patch-build: no prepare_kernel_tree in " + path)
block = marker + (
    "\t# kernel-fork-lab: extra config fragments to install after the patch series\n"
    "\tfor f in ${KW_FRAGS:-kw_defconfig}; do\n"
    '\t\tcase "$f" in kw_defconfig) ;; *) install -D -m644 "$root/kernel/configs-extra/$f" "$ksrc/arch/wasm/configs/$f" ;; esac\n'
    "\tdone\n"
)
s = s.replace(marker, block, 1)
open(path, "w").write(s)
print("patch-build: patched")
PY
