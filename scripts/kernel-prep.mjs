#!/usr/bin/env node
/**
 * Prepare the kernel module the Worker ships:
 *
 *   1. drop custom sections the Worker never reads: "name" (debug names),
 *      "producers", "unkernel.kernel.smp.kwpatch" (the UP -> SMP patch; the
 *      Worker boots one CPU) and "unkernel.datadisk" (no disks are attached);
 *   2. keep only the exports the SDK reads (the rest are the kernel's symbol
 *      table, ~250 KB of names that make thousands of functions look live);
 *      see EXPORTS;
 *   3. pack the guest binary into the initrd as <guest-path>, recompressed
 *      with gzip -9, so the Worker has no 9p mount (and no data module);
 *
 * then run wasm-opt -Oz --closed-world --remove-unused-module-elements, which
 * can delete the functions the dropped exports kept alive.
 *
 *   node scripts/kernel-prep.mjs --in KERNEL.wasm --out KERNEL.wasm --binary BIN --guest-path /hello/axum-hello
 *
 * Everything here is the same module, byte for byte reproducible: the initrd
 * entries are copied verbatim, the new ones appended before the trailer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The exports the SDK reads: Kernel.boot() (globals, entry), JitHost.attach
 * (the function table; the JIT stays off, but attach reads it), the SMP entry
 * points (a one-CPU boot never calls them, kept as the module's API says) and
 * nothing else. Removing the other ~11k is what lets the DCE pass run.
 */
const EXPORTS = new Set([
  "__indirect_function_table",
  "__stack_pointer",
  "__wasm_call_ctors",
  "__wasm_init_memory_flag",
  "_end",
  "_start",
  "kw_resume",
  "kw_secondary_entry",
  "kw_secondary_resume",
  "linux_banner",
  "ret_from_fork",
  "wasm_host_irqs",
]);

const DROP_SECTIONS = new Set([
  "name",
  "producers",
  "unkernel.kernel.smp.kwpatch",
  "unkernel.datadisk",
]);

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const inPath = arg("in");
const outPath = arg("out");
const binPath = arg("binary");
const guestPath = arg("guest-path", "/hello/axum-hello").replace(/^\/+/, "");
const minimal = argv.includes("--minimal-initrd");

/** --add GUEST=HOST / --add-from-initrd GUEST=PATH, in order. */
function specs(name) {
  const out = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "--" + name) continue;
    const spec = argv[i + 1];
    const eq = spec.indexOf("=");
    if (eq < 1) {
      console.error("kernel-prep: --" + name + " wants GUEST_PATH=SOURCE, got " + spec);
      process.exit(1);
    }
    out.push({ guest: spec.slice(0, eq).replace(/^\/+/, ""), source: spec.slice(eq + 1) });
  }
  return out;
}
const add = specs("add");
const addFromInitrd = specs("add-from-initrd");
if (!inPath || !outPath || !binPath) {
  console.error("usage: kernel-prep.mjs --in KERNEL.wasm --out KERNEL.wasm --binary BIN [--guest-path /hello/axum-hello]");
  process.exit(1);
}

// --- LEB128 / section helpers ------------------------------------------------

function readU32(b, p) {
  let v = 0, s = 0;
  for (;;) { const x = b[p++]; v |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; }
  return [v >>> 0, p];
}

function readName(b, p) {
  const [len, q] = readU32(b, p);
  return [b.subarray(q, q + len).toString("utf8"), q + len];
}

function leb(n) {
  const out = [];
  do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; out.push(x); } while (n);
  return Buffer.from(out);
}

/** Every section: { id, start, payloadStart, end }. */
function* sections(buf) {
  let p = 8; // \0asm + version
  while (p < buf.length) {
    const start = p;
    const id = buf[p++];
    let size = 0, s = 0;
    for (;;) { const x = buf[p++]; size |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; }
    yield { id, start, payloadStart: p, end: p + size };
    p += size;
  }
}

// --- cpio (newc: "070701", 110-byte header) ---------------------------------

const CPIO_HDR = 110;

function parseCpio(buf) {
  const entries = [];
  let p = 0;
  for (;;) {
    if (p + CPIO_HDR > buf.length) throw new Error("cpio: truncated header");
    if (buf.toString("ascii", p, p + 6) !== "070701") throw new Error("cpio: not a newc archive");
    const fields = [];
    for (let i = 0; i < 13; i++) {
      fields.push(parseInt(buf.toString("ascii", p + 6 + i * 8, p + 14 + i * 8), 16));
    }
    const [, , , , , , filesize, , , , , namesize] = fields;
    const nameStart = p + CPIO_HDR;
    const name = buf.toString("utf8", nameStart, nameStart + namesize - 1);
    let q = nameStart + namesize;
    q = (q + 3) & ~3;
    const data = buf.subarray(q, q + filesize);
    q = (q + filesize + 3) & ~3;
    entries.push({ fields, name, data });
    p = q;
    if (name === "TRAILER!!!") return entries;
  }
}

function emitCpio(entries) {
  const parts = [];
  let maxIno = 0;
  for (const e of entries) maxIno = Math.max(maxIno, e.fields[0]);
  let nextIno = maxIno + 1;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name + "\0");
    const f = e.fields.slice();
    if (e.ino === undefined) e.ino = f[0] === 0 ? nextIno++ : f[0]; // TRAILER has ino 0
    f[0] = e.ino;
    f[6] = e.data.length;
    f[11] = nameBuf.length;
    const hex = f.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
    const hdr = Buffer.concat([Buffer.from("070701" + hex, "ascii"), nameBuf]);
    parts.push(hdr, Buffer.alloc((4 - (hdr.length & 3)) & 3), e.data, Buffer.alloc((4 - (e.data.length & 3)) & 3));
  }
  return Buffer.concat(parts);
}

/** The directory entries <guestPath> needs, as one entry per component. */
function addFile(entries, path, data) {
  const parts = path.split("/");
  const trailer = entries.pop(); // "TRAILER!!!"
  const have = new Set(entries.map((e) => e.name));
  const mtime = 1700000000;
  let dir = "";
  for (const part of parts.slice(0, -1)) {
    dir = dir ? dir + "/" + part : part;
    if (have.has(dir)) continue;
    const fields = [0, 0o040755, 0, 0, 2, mtime, 0, 0, 0, 0, 0, 0, 0];
    entries.push({ fields, name: dir, data: Buffer.alloc(0) });
    have.add(dir);
  }
  const name = parts.join("/");
  if (have.has(name)) throw new Error("initrd: " + name + " already exists");
  entries.push({ fields: [0, 0o100755, 0, 0, 1, mtime, 0, 0, 0, 0, 0, 0, 0], name, data });
  entries.push(trailer);
}

// --- the module --------------------------------------------------------------

const wasm = readFileSync(inPath);
const binary = readFileSync(binPath);
const out = [];
let dropped = 0, keptExports = 0, droppedExports = 0;

for (const s of sections(wasm)) {
  const raw = wasm.subarray(s.start, s.end);

  if (s.id === 0) {
    const [name] = readName(wasm, s.payloadStart);
    if (DROP_SECTIONS.has(name)) { dropped++; continue; }

    if (name === "unkernel.initrd") {
      const nameLen = rawNameLength(wasm, s.payloadStart);
      const gz = wasm.subarray(s.payloadStart + nameLen, s.end);
      const base = parseCpio(gunzipSync(gz));
      // --minimal-initrd keeps only the trailer and what is added below.
      const entries = minimal ? [base[base.length - 1]] : base.slice();
      addFile(entries, guestPath, binary);
      for (const a of add) addFile(entries, a.guest, readFileSync(a.source));
      for (const a of addFromInitrd) {
        const wanted = a.source.replace(/^\/+/, "");
        const found = base.find((e) => e.name === wanted && e.data.length > 0);
        if (!found) throw new Error("initrd: " + a.source + " is not a file in the base image");
        addFile(entries, a.guest, found.data);
      }
      const packed = gzipSync(emitCpio(entries), { level: 9 });
      const payload = Buffer.concat([wasm.subarray(s.payloadStart, s.payloadStart + nameLen), packed]);
      out.push(Buffer.from([0]), leb(payload.length), payload);
      console.log("kernel-prep: initrd " + gz.length + " -> " + packed.length + " bytes (" + (minimal ? "minimal" : "base") + " image)");
      continue;
    }
    out.push(raw);
    continue;
  }

  if (s.id === 7) {
    // Export section: vec { name, kind, index }.
    let p = s.payloadStart;
    const [count, afterCount] = readU32(wasm, p);
    p = afterCount;
    const kept = [];
    for (let i = 0; i < count; i++) {
      const start = p;
      const [name, afterName] = readName(wasm, p);
      p = afterName + 1; // kind
      const [, afterIdx] = readU32(wasm, p);
      p = afterIdx;
      if (EXPORTS.has(name)) { kept.push(wasm.subarray(start, p)); keptExports++; }
      else droppedExports++;
    }
    const body = Buffer.concat([leb(kept.length), ...kept]);
    out.push(Buffer.from([7]), leb(body.length), body);
    continue;
  }

  out.push(raw);
}

function rawNameLength(buf, payloadStart) {
  const [len, q] = readU32(buf, payloadStart);
  return q - payloadStart + len;
}

const result = Buffer.concat([wasm.subarray(0, 8), ...out]);
writeFileSync(outPath, result);
console.log(
  `kernel-prep: ${wasm.length} -> ${result.length} bytes (` +
  `${dropped} sections dropped, exports ${keptExports} kept / ${droppedExports} dropped, ` +
  `initrd + ${binary.length} bytes at /${guestPath})`,
);
