#!/usr/bin/env node
// Bundle a kernel module the way unkernel's kernel/tools/bundle.mjs does for
// the pieces the Worker reads, minus the SMP patch (one CPU) and the data disk
// (no disks are attached):
//
//   out = kernel + "unkernel.initrd" (the published package's base initrd,
//                   byte for byte) + "unkernel.cmdline"
//
// The initrd is taken from the published SDK package's own bundle, because that
// is the base userland the deployed SDK pairs with (minimal and shell images
// are both cut from it by the repo's scripts/kernel-prep.mjs).
//
//   node bundle.mjs --kernel vmlinux32.wasm --initrd-wasm dist/unkernel.wasm \
//        --out unkernel.fork.wasm [--cmdline "console=hvc0 rdinit=/init"]
import { readFileSync, writeFileSync, statSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const kernelPath = arg("kernel");
const initrdWasm = arg("initrd-wasm");
const outPath = arg("out");
const cmdline = arg("cmdline", "console=hvc0 rdinit=/init");
if (!kernelPath || !initrdWasm || !outPath) {
  console.error("usage: bundle.mjs --kernel K.wasm --initrd-wasm SDK.wasm --out OUT.wasm [--cmdline C]");
  process.exit(2);
}

const uleb = (n) => {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
};
const custom = (name, payload) => {
  const nm = Buffer.from(name);
  const body = Buffer.concat([uleb(nm.length), nm, payload]);
  return Buffer.concat([Buffer.from([0]), uleb(body.length), body]);
};

// The package's bundle is a valid module; its custom sections are what we need.
const pkg = new WebAssembly.Module(readFileSync(initrdWasm));
const initrd = WebAssembly.Module.customSections(pkg, "unkernel.initrd")[0];
const pkgCmdline = WebAssembly.Module.customSections(pkg, "unkernel.cmdline")[0];
if (!initrd || initrd.byteLength === 0) {
  console.error("bundle: " + initrdWasm + " has no unkernel.initrd section");
  process.exit(1);
}

const kernel = readFileSync(kernelPath);
const km = new WebAssembly.Module(kernel);
for (const name of ["unkernel.initrd", "unkernel.cmdline", "unkernel.kernel.smp.kwpatch", "unkernel.datadisk"]) {
  if (WebAssembly.Module.customSections(km, name).length !== 0) {
    console.error("bundle: " + kernelPath + " already has an " + name + " section");
    process.exit(1);
  }
}

const out = Buffer.concat([
  kernel,
  custom("unkernel.initrd", Buffer.from(initrd)),
  custom("unkernel.cmdline", Buffer.from(cmdline)),
]);
writeFileSync(outPath, out);

// Check what we wrote: exactly one initrd and one command line, nothing else.
const m = new WebAssembly.Module(out);
const got = (n) => WebAssembly.Module.customSections(m, n);
const ok =
  got("unkernel.initrd").length === 1 && got("unkernel.initrd")[0].byteLength === initrd.byteLength &&
  got("unkernel.cmdline").length === 1 &&
  Buffer.from(got("unkernel.cmdline")[0]).toString() === cmdline &&
  got("unkernel.kernel.smp.kwpatch").length === 0 && got("unkernel.datadisk").length === 0;
if (!ok) {
  console.error("bundle: verification failed");
  process.exit(1);
}
console.log(
  "bundle: kernel " + kernel.length + " + initrd " + initrd.byteLength +
  " (SDK package base image" + (pkgCmdline ? ", its cmdline was " + JSON.stringify(Buffer.from(pkgCmdline).toString()) : "") +
  ") + cmdline " + JSON.stringify(cmdline) + " -> " + statSync(outPath).size + " bytes; imports " +
  WebAssembly.Module.imports(m).length + ", exports " + WebAssembly.Module.exports(m).length,
);
