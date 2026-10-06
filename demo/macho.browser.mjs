/**
 * macho.browser.mjs — GENERATED. Do not edit; edit the sources and re-link.
 *
 *   node demo/link.mjs
 *
 * This is the real reader — `src/macho.mjs`, `src/instruction.mjs` and
 * `src/api.mjs` — with their module boundaries removed and `demo/runtime.mjs`
 * prepended so they run in a browser with no Node and no network. The reader
 * logic is unchanged: `test/browser.mjs` requires this bundle to produce the
 * same answers as the Node build on every fixture in the corpus.
 *
 * Sources, in order:
 *   - demo/runtime.mjs — the host shim (Buffer, node:fs, node:crypto, node:path)
 *   - src/notread.mjs — the omissions list every answer carries
 *   - src/container.mjs — what a user hands you versus what the reader parses
 *   - src/macho.mjs — the reader — fat headers, load commands, symbols, mapping
 *   - src/instruction.mjs — instruction lengths and direct branch edges
 *   - src/api.mjs — the supported programmatic interface
 */

/* ================================================================== *
 * demo/runtime.mjs
 * ================================================================== */

/**
 * runtime.mjs — the browser environment the reader runs in.
 *
 * ## What this file is, and what it is not
 *
 * It is **not** a second parser. It is the small set of host primitives that
 * `src/macho.mjs`, `src/instruction.mjs` and `src/api.mjs` expect from Node —
 * `Buffer`, `node:fs`, `node:crypto`, `node:path` — implemented over an
 * in-memory file registry so those three files run *unmodified* in a browser.
 *
 * That is the whole point of the demo: the audited reader is the reader that
 * runs, and the only browser-specific code is this file. `demo/link.mjs` links
 * the three source modules together and prepends this one; `test/browser.mjs`
 * asserts that the linked bundle produces byte-for-byte the same `describe` and
 * `overview` answers as the Node build on every fixture.
 *
 * ## Why a `Buffer` shim rather than a rewrite
 *
 * The reader is written against Node's `Buffer` (48 `readUInt32LE` calls, 10
 * `readBigUInt64LE`, `equals`, `indexOf` with a buffer needle, `toString` with
 * encodings and ranges). `Uint8Array` lacks the `read*` family and the
 * buffer-needle searches. Rewriting 2,000 lines of audited arithmetic to avoid
 * those would be a far larger change than the thing it demonstrates, so instead
 * the ~60 methods the reader actually uses are implemented here, on top of
 * `Uint8Array`, and a test holds this shim to Node's `Buffer` for each one.
 *
 * ## Why a SHA-256 rather than `crypto.subtle`
 *
 * `digestOf` in `macho.mjs` is synchronous and `crypto.subtle` is not, so the
 * fingerprint path needs a synchronous hash. A compact SHA-256 is included so
 * `fingerprint` and `diff` work in the browser too, and `test/browser.mjs`
 * checks it against Node's `crypto` on inputs of every length class.
 */

/* ------------------------------------------------------------------ *
 * byte buffer — the subset of Node's Buffer the reader uses
 * ------------------------------------------------------------------ */

const HEX = '0123456789abcdef';

/** True when `v` looks like a byte container this module can read. */
function isBytes(v) {
  return v instanceof Uint8Array || v instanceof ArrayBuffer || Array.isArray(v);
}

/** Encode a JS string into a `ByteBuffer` under one of the reader's encodings. */
function encodeString(str, encoding = 'utf8') {
  const enc = String(encoding).toLowerCase();
  if (enc === 'latin1' || enc === 'binary') {
    const out = new ByteBuffer(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
  if (enc === 'hex') {
    const n = Math.floor(str.length / 2);
    const out = new ByteBuffer(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return new ByteBuffer(new TextEncoder().encode(str));
}

/**
 * A `Uint8Array` with the `Buffer` surface the reader calls.
 *
 * `Symbol.species` is pinned so `subarray`/`slice`/`filter` return a
 * `ByteBuffer` rather than a bare `Uint8Array` — without it, `f.read(...)` would
 * hand the parser a value with no `readUInt32LE`, and every read would fail at
 * the first load command.
 */
class ByteBuffer extends Uint8Array {
  static get [Symbol.species]() { return ByteBuffer; }

  /** A `DataView` over exactly this view's bytes, not the whole backing buffer. */
  #view() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }

  readUInt8(o = 0) { return this[o]; }
  readInt8(o = 0) { const v = this[o]; return v > 127 ? v - 256 : v; }
  readUInt16LE(o = 0) { return this.#view().getUint16(o, true); }
  readUInt16BE(o = 0) { return this.#view().getUint16(o, false); }
  readInt16LE(o = 0) { return this.#view().getInt16(o, true); }
  readInt16BE(o = 0) { return this.#view().getInt16(o, false); }
  readUInt32LE(o = 0) { return this.#view().getUint32(o, true); }
  readUInt32BE(o = 0) { return this.#view().getUint32(o, false); }
  readInt32LE(o = 0) { return this.#view().getInt32(o, true); }
  readInt32BE(o = 0) { return this.#view().getInt32(o, false); }
  readBigUInt64LE(o = 0) { return this.#view().getBigUint64(o, true); }
  readBigUInt64BE(o = 0) { return this.#view().getBigUint64(o, false); }
  readBigInt64LE(o = 0) { return this.#view().getBigInt64(o, true); }
  readBigInt64BE(o = 0) { return this.#view().getBigInt64(o, false); }
  readFloatLE(o = 0) { return this.#view().getFloat32(o, true); }
  readDoubleLE(o = 0) { return this.#view().getFloat64(o, true); }

  writeUInt8(v, o = 0) { this[o] = v & 0xff; return o + 1; }
  writeUInt16LE(v, o = 0) { this.#view().setUint16(o, v, true); return o + 2; }
  writeUInt32LE(v, o = 0) { this.#view().setUint32(o, v, true); return o + 4; }
  writeUInt32BE(v, o = 0) { this.#view().setUint32(o, v, false); return o + 4; }
  writeBigUInt64LE(v, o = 0) { this.#view().setBigUint64(o, BigInt(v), true); return o + 8; }

  /** Byte equality. Length mismatch is `false`, never a throw. */
  equals(other) {
    if (other == null || other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }

  /** Lexicographic order, the contract `Buffer.compare` publishes. */
  compare(other) {
    const n = Math.min(this.length, other.length);
    for (let i = 0; i < n; i++) {
      if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
    }
    return this.length === other.length ? 0 : (this.length < other.length ? -1 : 1);
  }

  /**
   * `indexOf` with Node's needle types: a byte, a string, or a byte sequence.
   *
   * The buffer-needle form is load-bearing: `searchRange` and the call scanner
   * search for multi-byte opcodes with `hay.indexOf(needle, i)`, and a
   * `Uint8Array`'s own `indexOf` only accepts a number, so it would silently
   * return -1 for every opcode and report "no calls found" as a fact.
   */
  indexOf(value, byteOffset = 0) {
    if (typeof value === 'number') {
      return Uint8Array.prototype.indexOf.call(this, value, byteOffset);
    }
    const needle = toBytes(value);
    if (needle.length === 0) return Math.min(Math.max(0, byteOffset), this.length);
    const last = this.length - needle.length;
    for (let i = Math.max(0, byteOffset); i <= last; i++) {
      let j = 0;
      while (j < needle.length && this[i + j] === needle[j]) j++;
      if (j === needle.length) return i;
    }
    return -1;
  }

  includes(value, byteOffset = 0) { return this.indexOf(value, byteOffset) !== -1; }

  /** `toString` with the encodings and the optional `start`/`end` the reader uses. */
  toString(encoding = 'utf8', start = 0, end = this.length) {
    const from = Math.max(0, start);
    const to = Math.min(this.length, end);
    const bytes = from === 0 && to === this.length ? this : this.subarray(from, to);
    const enc = String(encoding).toLowerCase();
    if (enc === 'latin1' || enc === 'binary') {
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
      return out;
    }
    if (enc === 'hex') {
      let out = '';
      for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
      return out;
    }
    if (enc === 'base64') {
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return typeof btoa === 'function' ? btoa(bin) : '';
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Coerce anything `Buffer.from` accepts into a `ByteBuffer` (copying, as Node does). */
function toBytes(value) {
  if (value instanceof ByteBuffer) return value;
  if (value instanceof Uint8Array) return new ByteBuffer(value);
  if (value instanceof ArrayBuffer) return new ByteBuffer(value);
  if (Array.isArray(value)) return new ByteBuffer(value);
  return new ByteBuffer(value);
}

/**
 * The `Buffer` the reader sees. A namespace, not a subclass, so `Buffer.from`
 * and `Buffer.alloc` return `ByteBuffer` exactly as Node's return `Buffer`.
 */
const Buffer = {
  from(value, encoding) {
    return typeof value === 'string' ? encodeString(value, encoding) : toBytes(value);
  },
  alloc(n) { return new ByteBuffer(n); },
  allocUnsafe(n) { return new ByteBuffer(n); },
  isBuffer(v) { return v instanceof ByteBuffer; },
  concat(list) {
    let total = 0;
    for (const x of list) total += x.length;
    const out = new ByteBuffer(total);
    let at = 0;
    for (const x of list) { out.set(x, at); at += x.length; }
    return out;
  },
  byteLength(value, encoding) {
    return typeof value === 'string' ? encodeString(value, encoding).length : value.byteLength;
  },
};

/* ------------------------------------------------------------------ *
 * node:crypto — synchronous SHA-256, for `digestOf`
 * ------------------------------------------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 of a byte sequence, as a 32-byte `ByteBuffer`. */
function sha256(bytes) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = bytes.length;
  const padded = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(padded);
  msg.set(bytes);
  msg[len] = 0x80;
  const dv = new DataView(msg.buffer);
  // Message length in bits, 64-bit big-endian. Split so a >512 MB input does not
  // lose its high word to a 32-bit shift.
  dv.setUint32(padded - 8, Math.floor(len / 0x20000000), false);
  dv.setUint32(padded - 4, (len * 8) >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new ByteBuffer(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i], false);
  return out;
}

/** `createHash` for the one algorithm the reader asks for. */
function createHash(algorithm) {
  const alg = String(algorithm).toLowerCase();
  if (alg !== 'sha256') throw new Error(`demo runtime: only sha256 is implemented, not ${algorithm}`);
  const chunks = [];
  return {
    update(data, encoding) {
      chunks.push(typeof data === 'string' ? encodeString(data, encoding || 'utf8') : toBytes(data));
      return this;
    },
    digest(encoding) {
      const hash = sha256(Buffer.concat(chunks));
      return String(encoding).toLowerCase() === 'hex' ? hash.toString('hex') : hash;
    },
  };
}

/* ------------------------------------------------------------------ *
 * node:fs over an in-memory registry
 * ------------------------------------------------------------------ */

/**
 * The files the browser build can "open".
 *
 * The demo registers a dropped file under a synthetic path and then calls the
 * ordinary `describe(path)` / `overview(path)` — so the API the demo exercises is
 * the API the CLI exposes, reached through the same `isMachOFile`/`opener` pair,
 * with only the host file table swapped out.
 */
const memoryFs = {
  files: new Map(),
  register(path, bytes) {
    const view = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
    this.files.set(path, view);
    return path;
  },
  clear() { this.files.clear(); },
  has(path) { return this.files.has(path); },
};

const enoent = (path) => Object.assign(new Error(`ENOENT: no such file, '${path}'`), { code: 'ENOENT' });

/** `openSync` — returns a handle, since the reader only passes it back to `readSync`. */
function openSync(path) {
  if (!memoryFs.files.has(path)) throw enoent(path);
  return { path };
}
function closeSync() { /* the registry owns the bytes; nothing to release */ }
function fstatSync(handle) {
  const bytes = memoryFs.files.get(handle.path);
  if (!bytes) throw enoent(handle.path);
  return { size: bytes.length };
}
function readSync(handle, buffer, offset, length, position) {
  const bytes = memoryFs.files.get(handle.path);
  if (!bytes) throw enoent(handle.path);
  const start = position ?? 0;
  if (start >= bytes.length) return 0;
  const n = Math.min(length, bytes.length - start);
  buffer.set(bytes.subarray(start, start + n), offset);
  return n;
}

/** The `fs` default export `api.mjs` uses for its directory walk and error path. */
const fs = {
  statSync(path) {
    const bytes = memoryFs.files.get(path);
    if (!bytes) throw enoent(path);
    return { size: bytes.length, isDirectory: () => false, isFile: () => true };
  },
  realpathSync(path) { return path; },
  readdirSync() { throw new Error('demo runtime: directory reads are not supported in the browser'); },
};

/** The slice of `node:path` the reader touches. */
const pathModule = {
  join: (...parts) => parts.filter((p) => p !== '').join('/').replace(/\/+/g, '/'),
  dirname: (p) => p.replace(/\/[^/]*$/, '') || '/',
  basename: (p) => p.replace(/^.*\//, ''),
  resolve: (...parts) => parts.filter((p) => p !== '').join('/').replace(/\/+/g, '/'),
};

/* ================================================================== *
 * src/notread.mjs
 * ================================================================== */

/**
 * notread.mjs — what this package does not parse, as data.
 *
 * ## Why this is its own file with no imports
 *
 * Three doors emit an answer: the CLI (`output.mjs`), the library (`api.mjs`), and
 * the MCP server (`mcp-tools.mjs`). All three must carry the same list, or an agent
 * that learned to read it from one door would be told by another that an answer was
 * complete when it was not.
 *
 * The obvious way to share one constant is for the other two to import it from
 * `api.mjs`. That is wrong here, and specifically so: `src/mcp-tools.mjs` states
 * that everything in that layer is deliberately self-contained, because the MCP
 * server is what an agent loads first and every module it has to resolve is one
 * more thing that can fail to load before a single tool is reachable.
 * `SCHEMA_VERSION` is the documented single exception — one literal, because a
 * *version* is only a version if there is exactly one of it.
 *
 * So the list lives here instead: a module with no imports at all, which the MCP
 * door can reach without pulling `api.mjs` and its transitive graph behind it. That
 * is the same reasoning as `SCHEMA_VERSION`, generalised — the things that must be
 * identical across doors are the ones that live where no door can disagree.
 *
 * ## The rule this list is held to
 *
 * It is kept in step with `README.md`'s "What it will not do" by hand, and asserted
 * against it by `test/smoke.mjs`. A gap list that drifts from the refusal list is
 * worse than none, because it is a gap list that is confidently wrong: it says
 * precisely what was not looked at, and a consumer reads the absence of a warning as
 * evidence there was nothing to warn about.
 */

const NOT_READ = [
  'code signature, entitlements or designated requirements',
  'the export trie and chained fixups',
  'Objective-C and Swift metadata',
  'dSYM and DWARF',
  'FAT32 containers',
  'disassembly, and the mnemonics behind an instruction length',
];
/* ================================================================== *
 * src/container.mjs
 * ================================================================== */

/**
 * container.mjs — what a user actually hands you, and what this package reads.
 *
 * ## Why this is its own file with no imports
 *
 * The same sentence has to reach three doors, and the reason codes have to agree:
 *
 *   - the library and the CLIs, through `api.mjs`'s `readerError`
 *   - the CLIs' own resolution failure, through `target.mjs`'s `requireBinary`
 *   - the MCP server, through `mcp-tools.mjs`
 *
 * `mcp-tools.mjs` is deliberately self-contained — it is what an agent loads first,
 * and every module it has to resolve is one more thing that can fail to load before
 * a tool is reachable. So the table cannot live in `api.mjs`, which is exactly the
 * argument `notread.mjs` makes for the same reason. This file is that argument again:
 * a module with no imports at all, which any door can reach without pulling a graph
 * behind it.
 *
 * It also must not import `bundle.mjs`, which is where the `.app` convention comes
 * from. That convention is configurable, and a message that named a hardcoded
 * `.app`/`Contents/MacOS` would contradict a deployment that changed it. The bundle
 * is therefore passed in by the one caller that already knows it (`target.mjs`), and
 * everything else matches on extensions alone.
 *
 * ## What the message is for
 *
 * A person who downloads an app has a `.ipa` or a `.dmg`, not a Mach-O. Told "not a
 * Mach-O binary" about either, the reasonable reading is that the file is damaged or
 * the wrong file was picked. Neither is likely: the file is fine, it is simply one
 * layer of packaging above what this reader parses. So the message names the
 * packaging, says what to do about it, and lists what *is* accepted — because the
 * question behind "not a Mach-O binary" is almost always "then what do you take?",
 * and an error that does not answer it leaves the user to guess from a filename.
 *
 * The accepted list is stated as prose rather than as extensions, and deliberately
 * says "any filename": the overwhelmingly common case is a binary with no extension
 * at all, and an error that listed only extensions would read as "mine is not one of
 * those" about `/usr/libexec/something`.
 */

/**
 * Apple ecosystem containers that wrap a Mach-O inside an archive, a disk image or a
 * bundle. These are the files a user is most likely to have on disk and most likely
 * to mistake for a binary.
 *
 * `containsMachO: false` marks the ones that hold no Mach-O to find — an asset
 * catalog and a result bundle are Apple containers a person may well hand over, but
 * extracting them does not produce a binary, and sending them down the same
 * "extract it and try again" road would be advice that cannot work.
 */
const APPLE_CONTAINERS = [
  { ext: '.ipa', hint: 'an iOS app archive — a ZIP holding Payload/<App>.app, which the CLIs extract for you', containsMachO: true },
  { ext: '.dmg', hint: 'a disk image — mount it (`hdiutil attach`) and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.pkg', hint: 'an installer package — expand it (`pkgutil --expand`) and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.mpkg', hint: 'a multi-package installer — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.xip', hint: 'a compressed Xcode package — expand it (`xip -x`) and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.zip', hint: 'a ZIP archive — unzip it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.tar', hint: 'a tar archive — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.gz', hint: 'a gzip archive — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.bz2', hint: 'a bzip2 archive — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.xz', hint: 'an xz archive — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.ipsw', hint: 'an iOS firmware image — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.xcarchive', hint: 'an Xcode archive — the Mach-O is under Products/ or the .app bundle inside', containsMachO: true },
  { ext: '.dSYM', hint: 'a debug-symbol bundle — the Mach-O is under Contents/Resources/DWARF/', containsMachO: true },
  { ext: '.simruntime', hint: 'a simulator runtime — the Mach-O files are under the platform library directories', containsMachO: true },
  { ext: '.car', hint: 'a compiled asset catalog — it holds no Mach-O; extract the assets with `assetutil` instead', containsMachO: false },
  { ext: '.xcresult', hint: 'an Xcode result bundle — it holds no Mach-O; read it with `xcrun xcresulttool` instead', containsMachO: false },
];

/**
 * What this package will read, in the words a user needs to pick a file.
 *
 * A list rather than a sentence because the answers are not one sentence: a bundle
 * and an `.ipa` are both accepted, and neither is accepted because of its extension
 * — what is read is the executable inside.
 *
 * `.tbd` is listed with its own caveat because it is the one entry that is not a
 * Mach-O at all: `tbd` reads it, and every other tool refuses it. A list that said
 * only "a .tbd stub" would send a user to `describe`, which answers "not a Mach-O
 * binary" — correctly, and confusingly, because the list above it said yes.
 */
const ACCEPTED = [
  'a Mach-O binary, thin or universal (fat) — any filename, extension or none',
  'an application bundle — the executable inside it is found for you',
  'an .ipa archive — the executable inside Payload/ is extracted for you',
  'a .tbd text stub — but only for `macho-explorer tbd`, which reads what it exports',
];

/** The accepted list as one indented block, for appending to a message. */
function acceptedBlock(indent = '  ') {
  return ACCEPTED.map((a) => `${indent}${a}`).join('\n');
}

/**
 * The container a path names, or null.
 *
 * Matched on the lowercased path, because these extensions are conventionally
 * capitalised on Apple platforms (`.dSYM`) and a case-sensitive match would miss
 * exactly the ones a macOS user is most likely to have.
 *
 * @param {string} path
 * @param {string} [bundleExt] the configured bundle extension, when the caller knows
 *   it. Passed rather than imported so this module stays free of `bundle.mjs`; see
 *   the header.
 * @returns {object|null}
 */
function containerFor(path, bundleExt) {
  if (typeof path !== 'string' || !path) return null;
  const lower = path.toLowerCase();
  if (bundleExt && lower.endsWith(bundleExt.toLowerCase())) {
    return {
      ext: bundleExt,
      hint: 'an application bundle — a directory, not a file; the executable is inside it',
      containsMachO: true,
      isBundle: true,
    };
  }
  const hit = APPLE_CONTAINERS.find((c) => lower.endsWith(c.ext.toLowerCase()));
  return hit ? { ...hit } : null;
}

/**
 * The message for a file that is packaging rather than a binary, or null when the
 * path names nothing this module recognises.
 *
 * The reason code is `unknown-encoding` throughout, because the file *is* readable —
 * it just is not what this reader parses. Reporting `io` would send a caller looking
 * for a permissions problem with a file it can open perfectly well.
 *
 * @param {string} path
 * @param {string} [bundleExt]
 * @returns {string|null}
 */
function containerMessage(path, bundleExt) {
  const c = containerFor(path, bundleExt);
  if (!c) return null;
  const action = c.containsMachO
    ? c.isBundle
      ? 'Point this tool at the bundle and it will find the executable inside, or pass that executable directly.'
      : 'Extract the Mach-O executable and pass that file to this tool.'
    : 'Nothing inside it is a Mach-O, so extracting it will not help.';
  return (
    `${path}: this is ${c.hint}. ${action}\n` +
    `  accepted instead:\n${acceptedBlock('    ')}`
  );
}
/* ================================================================== *
 * src/macho.mjs
 * ================================================================== */

/**
 * macho.mjs — a Mach-O reader.
 *
 * Fat-header parsing, load commands, symbol tables, `__TEXT` literal search and
 * file-offset-to-vaddr mapping. It knows nothing about any application; it knows
 * about the file format.
 *
 * ## Why this is one module
 *
 * These tools were written one at a time and each grew its own reader. They
 * diverged, and the divergence produced bugs that no amount of testing on the
 * binary the tools were written for would have found:
 *
 *   - one tool hardcoded `const SLICE = 0x4000` — one binary's x86_64 slice
 *     offset inside its own fat header, correct for exactly one file on earth.
 *     Against any other universal binary it read load commands out of the middle
 *     of a data section and returned a confident, wrong answer.
 *   - another read the architecture list at a fixed offset, which is only right
 *     for a *thin* Mach-O, so on a universal binary its section walk silently
 *     failed and it scanned a default window containing nothing.
 *   - a third treated an absent architecture as fatal rather than a preference,
 *     so it failed outright on an arm64-only binary.
 *
 * Every one of those is a *parse* bug, and they were only reachable by pointing
 * a tool at a binary it was not written for. Centralising the parsing is what
 * makes them fixable once.
 *
 * ## Why the fat header is parsed rather than assumed
 *
 * A universal binary's slices sit at offsets given by the fat header, and those
 * offsets depend on the order and number of architectures in the build. There
 * is no default, and the numbers vary far enough to matter: in one measured
 * pair the slices sat at 0x4000 and 0xf16c000. A reader that assumed 0x4000
 * would work on that binary and nowhere else.
 *
 * ## Which slice to use
 *
 * Not "the first one". A universal binary can be stripped on one architecture
 * and not the other, so `richestSlice` takes the one with the most symbols and
 * `preferredSlice` treats a requested architecture as a preference that falls
 * back to the richest rather than a requirement that returns null.
 */


/** Mach-O and fat-header magics, big- and little-endian. */
const MH_MAGIC_64 = 0xfeedfacf;
const MH_MAGIC_32 = 0xfeedface;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;

const LC_SEGMENT = 0x1;
const LC_SYMTAB = 0x2;
const LC_SEGMENT_64 = 0x19;
const LC_UUID_CMD = 0x1b;
const LC_RPATH_CMD = 0x1c;

/**
 * The commands that record which platform a binary was built for.
 *
 * `LC_BUILD_VERSION` is the current form and the only one a modern linker emits; the
 * four `LC_VERSION_MIN_*` commands are its predecessor, still emitted by older
 * toolchains for the platforms that predate it. All five are decoded, because a
 * `LC_VERSION_MIN_IPHONEOS` in the wild means the binary's platform is knowable and a
 * reader that only understood `LC_BUILD_VERSION` would report nothing for it — the
 * "recognised but silent" failure this project treats as worse than a refusal.
 *
 * The `LC_VERSION_MIN_*` commands name their platform in the *command* rather than in
 * a field, which is why they need a map instead of a comparison against one value.
 */
const LC_BUILD_VERSION_CMD = 0x32;
/** The pair that records FairPlay encryption state. Same 20-byte struct in both. */
const LC_ENCRYPTION_INFO_CMD = 0x21;
const LC_ENCRYPTION_INFO_64_CMD = 0x2c;
const VERSION_MIN_COMMANDS = new Map([
  [0x24, 'macos'],
  [0x25, 'ios'],
  [0x2f, 'tvos'],
  [0x30, 'watchos'],
]);


/**
 * `LC_REQ_DYLD`, the bit that marks a command the loader must understand.
 *
 * Several commands are *defined* with this bit set — `LC_MAIN` is `0x28 |
 * LC_REQ_DYLD`, not `0x28` — and the bit is part of the command's identity rather
 * than a decoration on it. A reader that matches the bare `0x28` misses the only
 * form a real binary emits. See {@link LC_MAIN_CMD}.
 */
const LC_REQ_DYLD = 0x80000000;

/**
 * The commands whose payload is a `struct dylib_command`.
 *
 * All six share one layout, so they are one entry in the decoder rather than six:
 *
 *     struct dylib_command {
 *         uint32_t cmd;                 // one of the six below
 *         uint32_t cmdsize;
 *         union lc_str dylib;           // lc_str = a uint32 *offset* from cmd
 *         uint32_t timestamp;
 *         uint32_t current_version;
 *         uint32_t compatibility_version;
 *     };
 *
 * The last four differ only in what the loader does with the name, and that
 * difference is the reason they cannot be collapsed into one value: a
 * `LC_LOAD_WEAK_DYLIB` that is absent is fine, a missing `LC_LOAD_DYLIB` is a
 * broken install, and `LC_REEXPORT_DYLIB` also re-exports the named image's
 * symbols into the client. Reporting all three as "linked against" would be the
 * kind of flattening this reader exists to avoid, so the linkage is carried
 * through as its own value.
 *
 * `LC_ID_DYLIB` is in {@link DYLIB_ID_CMD}, not here: it names *this* image
 * rather than a dependency, so it is the install name rather than a link.
 *
 * The `LC_REQ_DYLD` forms are the ones a real binary emits for the four marked
 * commands, and the bare values name different commands entirely — `0x18` is
 * `LC_LOAD_WEAK_DYLIB` in `<mach-o/loader.h>`'s *enumeration*, but only the
 * `0x80000018` form is a dylib command on disk. Both are listed in
 * {@link loadCommandName}; only the `0x80000000` ones are decoded here, because
 * accepting the bare value would decode a command the linker never emits.
 *
 * `>>> 0` on the three `LC_REQ_DYLD` keys is load-bearing and not decoration. `|`
 * is a *signed* 32-bit operation in JavaScript, so `0x18 | 0x80000000` evaluates
 * to `-2147483624`, not `2147483640` — and `cmd` arrives from `readUInt32LE` as an
 * unsigned value, so the lookup would miss every weak and re-export dylib in the
 * file while appearing to work for `LC_LOAD_DYLIB` itself, which needs no mask.
 * The same idiom is already used for {@link LC_MAIN_CMD}.
 */
const DYLIB_COMMANDS = new Map([
  [0x0c, { linkage: 'load' }],
  [(0x18 | LC_REQ_DYLD) >>> 0, { linkage: 'weak' }],
  [(0x1f | LC_REQ_DYLD) >>> 0, { linkage: 'reexport' }],
  [0x20, { linkage: 'lazy' }],
  [(0x23 | LC_REQ_DYLD) >>> 0, { linkage: 'upward' }],
]);

/**
 * `LC_ID_DYLIB`, which names this image's own install name.
 *
 * Separate from {@link DYLIB_COMMANDS} because it answers a different question.
 * A dependency is "what must be present for this to load"; an install name is
 * "what this file calls itself", which is what a dylib's own `LC_ID_DYLIB`
 * records so that clients linking against it record the right name. It is the
 * same struct and therefore the same decoder, and it is what `otool -D` prints.
 */
const DYLIB_ID_CMD = 0x0d;

/**
 * The entry point, in the form a compiled binary actually declares.
 *
 * `<mach-o/loader.h>` defines `LC_MAIN` as `(0x28 | LC_REQ_DYLD)`. This constant
 * is that value, and it is the value the comparison in `parseThin` must use: the
 * bare `0x28` names nothing, and the command that *does* sit at bare `0x29` is
 * `LC_DATA_IN_CODE`, a `linkedit_data_command` whose `dataoff` is a file offset
 * into `__LINKEDIT`. Reading that as an entry point yields an `entryoff` that
 * looks like an offset and is not one.
 */
const LC_MAIN = 0x28;
// `>>> 0` because `|` is a signed 32-bit operation in JavaScript: `0x28 | 0x80000000`
// is the negative number -2147483608, while `readUInt32LE` hands back the unsigned
// 2147483688. Comparing the two would never match.
const LC_MAIN_CMD = (LC_MAIN | LC_REQ_DYLD) >>> 0;

/** `LC_SOURCE_VERSION`: the source revision, packed `a24.b10.c10.d10.e10`. */
const LC_SOURCE_VERSION_CMD = 0x2a;

/** `LC_FUNCTION_STARTS`: ULEB128 deltas of function start addresses. */
const LC_FUNCTION_STARTS_CMD = 0x26;

/** `LC_DATA_IN_CODE`: file ranges that are data rather than instructions. */
const LC_DATA_IN_CODE_CMD = 0x29;
const LC_ENCRYPTION_INFO = 0x21;
const LC_ENCRYPTION_INFO_64 = 0x2d;
const LC_BUILD_VERSION = 0x32;

/**
 * `LC_VERSION_MIN_*`, the pre-`LC_BUILD_VERSION` way of naming a platform.
 *
 * Mapped to the same `PLATFORM_*` numbers so the two forms produce one shape —
 * iOS binaries from before Xcode 10 carry these instead, and a caller should not
 * have to know which spelling it got to find out the binary is for iOS.
 */
const VERSION_MIN_CMDS = {
  0x24: 1,  // LC_VERSION_MIN_MACOSX  -> PLATFORM_MACOS
  0x25: 2,  // LC_VERSION_MIN_IPHONEOS -> PLATFORM_IOS
  0x2f: 3,  // LC_VERSION_MIN_TVOS     -> PLATFORM_TVOS
  0x30: 4,  // LC_VERSION_MIN_WATCHOS  -> PLATFORM_WATCHOS
};

/*
 * `PLATFORMS` is defined once, below, beside `decodePlatform`. The `ios-coverage`
 * and mainline branches each carried a copy of the table and the merge kept both,
 * which is a redeclaration rather than a merge; the copy kept is the superset, so
 * every name this file is asked for is still present. `platformName` below reads
 * it, and because that function is only called after the module has finished
 * evaluating, the definition order is not a problem.
 */

/** `MH_*` filetypes from `<mach-o/loader.h>`, by value. */
const FILETYPES = {
  0x1: 'MH_OBJECT', 0x2: 'MH_EXECUTE', 0x3: 'MH_FVMLIB', 0x4: 'MH_CORE',
  0x5: 'MH_PRELOAD', 0x6: 'MH_DYLIB', 0x7: 'MH_DYLINKER', 0x8: 'MH_BUNDLE',
  0x9: 'MH_DYLIB_STUB', 0xa: 'MH_DSYM', 0xb: 'MH_KEXT_BUNDLE', 0xc: 'MH_FILESET',
};

/** A filetype's `MH_*` name, or the raw number when it is not one we know. */
function filetypeName(n) {
  if (n == null) return null;
  return FILETYPES[n] ?? `filetype=${n}`;
}

/** A platform number's name, or the raw number when it is not one we know. */
function platformName(n) {
  if (n == null) return null;
  return PLATFORMS[n] ?? `platform=${n}`;
}

/**
 * Unpack the `xxxx.yy.zz` nibble encoding used by `minos` and `sdk`.
 *
 * The three fields are not a decimal fraction and not a bitfield; they are
 * fixed-width nibble groups, so `0x0d0300` is 13.3.0 and string concatenation
 * would produce 13.30. `minor` and `patch` are two nibbles each, which is why
 * this cannot be done by dividing.
 */
function unpackVersion(v) {
  if (v == null) return null;
  const major = (v >> 16) & 0xffff;
  const minor = (v >> 8) & 0xff;
  const patch = v & 0xff;
  return `${major}.${minor}.${patch}`;
}

/**
 * Load-command names, for `describe --loads`.
 *
 * A *description* table, deliberately. It exists so `parseThin` can print what a
 * binary declares without this reader having to understand what any of it means
 * — the line between "this file says it links libSystem" and "this reader can
 * resolve libSystem" is the project's own "will not do" boundary, and naming the
 * commands does not cross it. `LC_ENCRYPTION_INFO` is in here for the same
 * reason: knowing a binary is encrypted is a fact about it.
 *
 * Keys are the numeric commands; the `0x80000000` bit is stripped first, because
 * `LC_REQ_DYLD` only ever *adds* to a base command and every consumer here wants
 * the base name. An unmapped command is reported by number rather than dropped,
 * so an unrecognised load command is visible instead of silently absent.
 */
const LOAD_COMMANDS = {
  0x1: 'LC_SEGMENT',
  0x2: 'LC_SYMTAB',
  0x3: 'LC_SYMSEG',
  0x4: 'LC_THREAD',
  0x5: 'LC_UNIXTHREAD',
  0x6: 'LC_LOADFVMLIB',
  0x7: 'LC_IDFVMLIB',
  0x8: 'LC_IDENT',
  0x9: 'LC_FVMFILE',
  0xa: 'LC_PREPAGE',
  0xb: 'LC_DYSYMTAB',
  0xc: 'LC_LOAD_DYLIB',
  0xd: 'LC_ID_DYLIB',
  0xe: 'LC_LOAD_DYLINKER',
  0xf: 'LC_ID_DYLINKER',
  0x10: 'LC_PREBOUND_DYLIB',
  0x11: 'LC_ROUTINES',
  0x12: 'LC_SUB_FRAMEWORK',
  0x13: 'LC_SUB_UMBRELLA',
  0x14: 'LC_SUB_CLIENT',
  0x15: 'LC_SUB_LIBRARY',
  0x16: 'LC_TWOLEVEL_HINTS',
  0x17: 'LC_PREBIND_CKSUM',
  0x18: 'LC_LOAD_WEAK_DYLIB',
  0x19: 'LC_SEGMENT_64',
  0x1a: 'LC_ROUTINES_64',
  0x1b: 'LC_UUID',
  0x1c: 'LC_RPATH',
  0x1d: 'LC_CODE_SIGNATURE',
  0x1e: 'LC_SEGMENT_SPLIT_INFO',
  0x1f: 'LC_REEXPORT_DYLIB',
  0x20: 'LC_LAZY_LOAD_DYLIB',
  0x21: 'LC_ENCRYPTION_INFO',
  0x22: 'LC_DYLD_INFO',
  0x23: 'LC_LOAD_UPWARD_DYLIB',
  0x24: 'LC_VERSION_MIN_MACOSX',
  0x25: 'LC_VERSION_MIN_IPHONEOS',
  0x26: 'LC_FUNCTION_STARTS',
  0x27: 'LC_DYLD_ENVIRONMENT',
  0x28: 'LC_MAIN',
  0x29: 'LC_DATA_IN_CODE',
  0x2a: 'LC_SOURCE_VERSION',
  0x2b: 'LC_DYLIB_CODE_SIGN_DRS',
  0x2c: 'LC_ENCRYPTION_INFO_64',
  0x2d: 'LC_LINKER_OPTION',
  0x2e: 'LC_LINKER_OPTIMIZATION_HINT',
  0x2f: 'LC_VERSION_MIN_TVOS',
  0x30: 'LC_VERSION_MIN_WATCHOS',
  0x31: 'LC_NOTE',
  0x32: 'LC_BUILD_VERSION',
  0x33: 'LC_DYLD_EXPORTS_TRIE',
  0x34: 'LC_DYLD_CHAINED_FIXUPS',
  0x35: 'LC_FILESET_ENTRY',
  0x36: 'LC_ATOM_INFO',
  0x37: 'LC_FUNCTION_VARIANTS',
  0x38: 'LC_FUNCTION_VARIANT_FIXUPS',
  0x39: 'LC_TARGET_TRIPLE',
};

/**
 * Commands whose `LC_REQ_DYLD` form has a *different* name from the bare value.
 *
 * Stripping the `0x80000000` bit is right for `LC_RPATH` (`0x1c` and
 * `0x8000001c` are the same command), but wrong for these: `LC_MAIN` is *defined*
 * as `0x28 | LC_REQ_DYLD`, and the bare `0x28` names nothing. Without this map,
 * `0x80000028` strips to `0x28` and the reader either prints a number or — if the
 * table also carried a `0x28` entry — would name it by the wrong command.
 */
const REQ_DYLD_NAMES = {
  0x80000018: 'LC_LOAD_WEAK_DYLIB',
  0x8000001f: 'LC_REEXPORT_DYLIB',
  0x80000022: 'LC_DYLD_INFO_ONLY',
  0x80000023: 'LC_LOAD_UPWARD_DYLIB',
  0x80000028: 'LC_MAIN',
  0x80000033: 'LC_DYLD_EXPORTS_TRIE',
  0x80000034: 'LC_DYLD_CHAINED_FIXUPS',
  0x80000035: 'LC_FILESET_ENTRY',
};

/** Name a load command, or report its number when no table has an entry. */
function loadCommandName(cmd) {
  // The exact `LC_REQ_DYLD` form is checked first, because for the commands in
  // REQ_DYLD_NAMES the bit is part of the name rather than decoration on it. Only
  // then is the bit stripped, which is the right rule for everything else and for
  // `LC_RPATH` in particular (`0x8000001c` is LC_RPATH, not a distinct command).
  return REQ_DYLD_NAMES[cmd] || LOAD_COMMANDS[cmd & 0x7fffffff] || `0x${(cmd >>> 0).toString(16)}`;
}

/** nlist_64 type field: N_STAB and N_TYPE masks. */
const N_STAB = 0xe0;
const N_TYPE = 0x0e;
const N_SECT = 0x0e;

const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
const CPU_ARM64_32 = 0x0200000c;
const CPU_POWERPC = 0x00000012;
const CPU_POWERPC64 = 0x01000012;

/**
 * Section attribute bits that mark a section as containing instructions.
 *
 * These are the flags a linker sets on `__text` and `__stubs`, and *only* on
 * those. They are what makes a scan typed: everything else in `__TEXT` is data
 * or literals, and a byte pattern that happens to decode as a call inside
 * `__cstring` is not a call site no matter how plausible it looks.
 */
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;

/* ------------------------------------------------------------------ *
 * header flags
 * ------------------------------------------------------------------ */

/**
 * The `flags` word of `mach_header`/`mach_header_64`, byte 24, as `[bit, name]`.
 *
 * Transcribed from `<mach-o/loader.h>` in the macOS SDK rather than from memory,
 * and the header is a worse source of assumptions than it looks. Four of these
 * are newer than the "28 flags" usually quoted for `MH_*`: `MH_NLIST_OUTOFSYNC_
 * WITH_DYLDINFO`, `MH_SIM_SUPPORT`, `MH_IMPLICIT_PAGEZERO` and `MH_DYLIB_IN_CACHE`.
 * A table that stopped at `MH_APP_EXTENSION_SAFE` would report those four as
 * unknown bits on real binaries — which is precisely the false alarm the
 * abnormality check in {@link detectAbnormalities} must not be able to raise.
 *
 * The bits are *not* contiguous: 0x20000000 has no name in the header at all,
 * so a binary that sets it produces a genuinely unknown bit. That gap is the
 * reason {@link decodeHeaderFlags} reports `unknown` bits separately from
 * undecoded ones rather than folding them together.
 */
const MH_FLAGS = [
  [0x00000001, 'MH_NOUNDEFS'],
  [0x00000002, 'MH_INCRLINK'],
  [0x00000004, 'MH_DYLDLINK'],
  [0x00000008, 'MH_BINDATLOAD'],
  [0x00000010, 'MH_PREBOUND'],
  [0x00000020, 'MH_SPLIT_SEGS'],
  [0x00000040, 'MH_LAZY_INIT'],
  [0x00000080, 'MH_TWOLEVEL'],
  [0x00000100, 'MH_FORCE_FLAT'],
  [0x00000200, 'MH_NOMULTIDEFS'],
  [0x00000400, 'MH_NOFIXPREBINDING'],
  [0x00000800, 'MH_PREBINDABLE'],
  [0x00001000, 'MH_ALLMODSBOUND'],
  [0x00002000, 'MH_SUBSECTIONS_VIA_SYMBOLS'],
  [0x00004000, 'MH_CANONICAL'],
  [0x00008000, 'MH_WEAK_DEFINES'],
  [0x00010000, 'MH_BINDS_TO_WEAK'],
  [0x00020000, 'MH_ALLOW_STACK_EXECUTION'],
  [0x00040000, 'MH_ROOT_SAFE'],
  [0x00080000, 'MH_SETUID_SAFE'],
  [0x00100000, 'MH_NO_REEXPORTED_DYLIBS'],
  [0x00200000, 'MH_PIE'],
  [0x00400000, 'MH_DEAD_STRIPPABLE_DYLIB'],
  [0x00800000, 'MH_HAS_TLV_DESCRIPTORS'],
  [0x01000000, 'MH_NO_HEAP_EXECUTION'],
  // `0x02000000`, not `0x00200000` — the bit above `MH_NO_HEAP_EXECUTION`, with a
  // leading zero in the header. Reading it as 24 would report a real flag as
  // unknown and invent a different one alongside it.
  [0x02000000, 'MH_APP_EXTENSION_SAFE'],
  [0x04000000, 'MH_NLIST_OUTOFSYNC_WITH_DYLDINFO'],
  [0x08000000, 'MH_SIM_SUPPORT'],
  [0x10000000, 'MH_IMPLICIT_PAGEZERO'],
  [0x80000000, 'MH_DYLIB_IN_CACHE'],
];

/** Every named header-flag bit, as one mask. The complement is what may be unknown. */
const MH_FLAG_MASK = MH_FLAGS.reduce((a, [bit]) => a | bit, 0);

/**
 * Decode a header `flags` word into names, plus any bits this table cannot name.
 *
 * `unknown` is the whole point of the return value. A flag bit that is set and
 * unnamed is either a format newer than this reader or a corrupted header, and
 * those two deserve very different reactions — so it is reported rather than
 * dropped. Dropping it would make a file that declares something unfamiliar look
 * exactly like one that does not, which is the shape of a wrong answer.
 *
 * @param {number} flags the `flags` word, as read unsigned
 * @returns {{flags: number, names: string[], unknown: number}}
 */
function decodeHeaderFlags(flags) {
  const names = [];
  for (const [bit, name] of MH_FLAGS) {
    if ((flags & bit) !== 0) names.push(name);
  }
  // `~MH_FLAG_MASK` is negative in two's complement, so it is masked back to 32
  // bits before use. `flags` is already unsigned, so this cannot go negative.
  const unknown = (flags & ~MH_FLAG_MASK) >>> 0;
  return { flags, names, unknown };
}

/* ------------------------------------------------------------------ *
 * section types and attributes
 * ------------------------------------------------------------------ */

/** `SECTION_TYPE`, the low byte of a section's `flags`. */
const SECTION_TYPE_MASK = 0x000000ff;

/**
 * Section types, the low byte of a section's `flags`.
 *
 * Transcribed from `<mach-o/loader.h>`, and complete through
 * `S_INIT_FUNC_OFFSETS` (0x16) — including the five thread-local types, which a
 * 22-entry table copied from an older header omits, and which appear on any
 * binary built with C++ static destructors or `thread_local` variables.
 */
const SECTION_TYPES = {
  0x00: 'S_REGULAR',
  0x01: 'S_ZEROFILL',
  0x02: 'S_CSTRING_LITERALS',
  0x03: 'S_4BYTE_LITERALS',
  0x04: 'S_8BYTE_LITERALS',
  0x05: 'S_LITERAL_POINTERS',
  0x06: 'S_NON_LAZY_SYMBOL_POINTERS',
  0x07: 'S_LAZY_SYMBOL_POINTERS',
  0x08: 'S_SYMBOL_STUBS',
  0x09: 'S_MOD_INIT_FUNC_POINTERS',
  0x0a: 'S_MOD_TERM_FUNC_POINTERS',
  0x0b: 'S_COALESCED',
  0x0c: 'S_GB_ZEROFILL',
  0x0d: 'S_INTERPOSING',
  0x0e: 'S_16BYTE_LITERALS',
  0x0f: 'S_DTRACE_DOF',
  0x10: 'S_LAZY_DYLIB_SYMBOL_POINTERS',
  0x11: 'S_THREAD_LOCAL_REGULAR',
  0x12: 'S_THREAD_LOCAL_ZEROFILL',
  0x13: 'S_THREAD_LOCAL_VARIABLES',
  0x14: 'S_THREAD_LOCAL_VARIABLE_POINTERS',
  0x15: 'S_THREAD_LOCAL_INIT_FUNCTION_POINTERS',
  0x16: 'S_INIT_FUNC_OFFSETS',
};

/**
 * Section attributes, the top 24 bits of a section's `flags`, as `[bit, name]`.
 *
 * `S_ATTR_PURE_INSTRUCTIONS` and `S_ATTR_SOME_INSTRUCTIONS` are here as entries
 * rather than kept only as the two constants {@link isCodeSection} tests, because
 * a section's attributes are now *reported* and the two lists must not be able
 * to disagree about which bits those are. {@link isCodeSection} still tests the
 * constants — the single source of truth for the code/data decision — and this
 * table is the single source of truth for the names.
 *
 * Note the hole in the numbering: `S_ATTR_DEBUG` is 0x02000000 and the bits below
 * it are 0x00000400 downward, so 0x01000000 through 0x00800000 and 0x00008000
 * downward have no name. Those become `attributesUnknown`, and are reported.
 */
const SECTION_ATTRIBUTES = [
  [0x80000000, 'S_ATTR_PURE_INSTRUCTIONS'],
  [0x40000000, 'S_ATTR_NO_TOC'],
  [0x20000000, 'S_ATTR_STRIP_STATIC_SYMS'],
  [0x10000000, 'S_ATTR_NO_DEAD_STRIP'],
  [0x08000000, 'S_ATTR_LIVE_SUPPORT'],
  [0x04000000, 'S_ATTR_SELF_MODIFYING_CODE'],
  [0x02000000, 'S_ATTR_DEBUG'],
  [0x00000400, 'S_ATTR_SOME_INSTRUCTIONS'],
  [0x00000200, 'S_ATTR_EXT_RELOC'],
  [0x00000100, 'S_ATTR_LOC_RELOC'],
];

const SECTION_ATTRIBUTE_MASK = SECTION_ATTRIBUTES.reduce((a, [bit]) => a | bit, 0);

/**
 * The attribute *region* of a section's `flags`: `SECTION_ATTRIBUTES`, the top 24.
 *
 * Separate from {@link SECTION_ATTRIBUTE_MASK}, which is only the bits this table
 * can name — and the two are not interchangeable. Masking with the complement of
 * the named bits and calling the remainder "unknown attributes" also catches the
 * section *type* in the low byte, so every `S_CSTRING_LITERALS` section reported
 * `0x2` as an unknown attribute and every real binary came back with a wall of
 * spurious warnings. The region has to be bounded first, and only then compared
 * against the names.
 */
const SECTION_ATTRIBUTE_REGION = 0xffffff00;

/**
 * Split a section's `flags` word into its type and its attributes.
 *
 * The two occupy disjoint parts of one word — `SECTION_TYPE` is the low 8 bits,
 * `SECTION_ATTRIBUTES` the top 24 — and they answer different questions. Type
 * says what the bytes are (`S_CSTRING_LITERALS`, `S_SYMBOL_STUBS`);
 * attributes say how the linker may treat them (`S_ATTR_PURE_INSTRUCTIONS`,
 * `S_ATTR_NO_DEAD_STRIP`). `code`/`data` in the section listing comes from the
 * attributes, and the type is printed beside it, so a section can be read as
 * "code" and `S_REGULAR` at once — which is what `__text` is.
 *
 * @param {number} flags the section's `flags` word, as read unsigned
 * @returns {{type: string, typeRaw: number, attributes: string[], attributesUnknown: number}}
 */
function decodeSectionFlags(flags) {
  const typeRaw = flags & SECTION_TYPE_MASK;
  const attributes = [];
  for (const [bit, name] of SECTION_ATTRIBUTES) {
    if ((flags & bit) !== 0) attributes.push(name);
  }
  const attributesUnknown = (flags & SECTION_ATTRIBUTE_REGION & ~SECTION_ATTRIBUTE_MASK) >>> 0;
  return {
    type: SECTION_TYPES[typeRaw] || `S_UNKNOWN_0x${typeRaw.toString(16)}`,
    typeRaw,
    attributes,
    attributesUnknown,
  };
}

/* ------------------------------------------------------------------ *
 * LC_SOURCE_VERSION
 * ------------------------------------------------------------------ */

/**
 * Decode an `LC_SOURCE_VERSION` word into its five components.
 *
 * The header documents this as `A.B.C.D.E packed as a24.b10.c10.d10.e10`, which
 * is not five equal fields — `A` is 24 bits and the rest are 10. Decoding it as
 * five 10-bit fields, which is the obvious reading and the one most tools get
 * wrong, silently mangles every component: a real `A` of 0x1000000 would lose its
 * high bits and the whole version would come out as `0.0.0.x.y`. So the shifts
 * are taken from that comment rather than derived.
 *
 * @param {bigint} v the packed `version` word
 * @returns {{raw: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, text: string}}
 */
function decodeSourceVersion(v) {
  const a = (v >> 40n) & 0xffffffn;
  const b = (v >> 30n) & 0x3ffn;
  const c = (v >> 20n) & 0x3ffn;
  const d = (v >> 10n) & 0x3ffn;
  const e = v & 0x3ffn;
  return { raw: v, a, b, c, d, e, text: `${a}.${b}.${c}.${d}.${e}` };
}

/**
 * `platform`, as `LC_BUILD_VERSION` records it.
 *
 * Transcribed from `<mach-o/loader.h>` in the installed SDK — read, not recalled.
 * That matters more here than for most of these tables, because **the numbering has
 * changed**. `PLATFORM_MACOS` was `6` before 2017 and is `1` now; `PLATFORM_IOS` was
 * `7` and is `2`. The first table written here used the old numbering, and it was
 * caught by running it rather than by reading it back: every macOS binary on the
 * machine reports `1`, and the table confidently called that `v1`. A table recalled
 * from memory is worse than no table, because a missing name at least announces
 * itself.
 *
 * The modern numbering is contiguous from 1 to 12, so the early values are a plain
 * list — but they are still a table, because 13 onward are not contiguous: `PLATFORM_FIRMWARE`
 * is 13, `PLATFORM_SEPOS` is 14, and then sixteen `EXCLAVECORE`/`EXCLAVEKIT` pairs
 * run to 24. The pairs are generated rather than written out, and the generation is
 * visible so that a reader can see what it is derived from.
 *
 * `PLATFORM_ANY` (0xFFFFFFFF) is a wildcard a *client* records rather than a platform
 * a binary is built for. It is named, and `decodePlatform` marks it unrecognised as a
 * platform even though it has a name — see below.
 */
const PLATFORMS = {
  0: 'unknown',
  1: 'macos',
  2: 'ios',
  3: 'tvos',
  4: 'watchos',
  5: 'bridgeos',
  6: 'maccatalyst',
  7: 'ios-simulator',
  8: 'tvos-simulator',
  9: 'watchos-simulator',
  10: 'driverkit',
  11: 'visionos',
  12: 'visionos-simulator',
  13: 'firmware',
  14: 'sepos',
  ...Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => i * 2 + 15).flatMap((n, i) => [
      [n, ['macos', 'ios', 'tvos', 'watchos', 'visionos'][i] + '-exclavecore'],
      [n + 1, ['macos', 'ios', 'tvos', 'watchos', 'visionos'][i] + '-exclavekit'],
    ]),
  ),
  0xffffffff: 'any',
};

const MH_TYPES = {
  0x1: 'MH_OBJECT',
  0x2: 'MH_EXECUTE',
  0x3: 'MH_FVMLIB',
  0x4: 'MH_CORE',
  0x5: 'MH_PRELOAD',
  0x6: 'MH_DYLIB',
  0x7: 'MH_DYLINKER',
  0x8: 'MH_BUNDLE',
  0x9: 'MH_DYLIB_STUB',
  0xa: 'MH_DSYM',
  0xb: 'MH_KEXT_BUNDLE',
  0xc: 'MH_FILESET',
  0xd: 'MH_GPU_EXECUTE',
  0xe: 'MH_GPU_DYLIB',
};

/**
 * Name a `filetype`, or report it as an unnamed number.
 *
 * An unrecognised value comes back `null` rather than a guess, because the
 * difference between "an executable" and "a file whose second word is 2" is the
 * difference between an answer and an invention.
 */
function decodeFiletype(raw) {
  const named = MH_TYPES[raw];
  return { raw, name: named ?? null, named: named !== undefined };
}

/**
 * A stable string for a filetype, whichever form it arrives in.
 *
 * Exists because two call sites interpolate a filetype into a comparison, and both
 * got it wrong the same way when `parseThin` started returning the decoded object
 * instead of a number:
 *
 *   - {@link sliceShape} template-interpolated it, producing
 *     `filetype:[object Object]` — so every executable and every dylib hashed to the
 *     same value and the digest could no longer tell them apart, with no test failing
 *     because a digest that collapses two values into one still returns a digest;
 *   - the `diff` path compared with `!==`, and two freshly-decoded objects are never
 *     `===`, so **every** pair of binaries reported `filetype-changed`.
 *
 * One helper, two callers, because the second bug was the first bug copied. The name
 * is preferred and the raw word is the fallback, so an unrecognised filetype still
 * contributes its number rather than collapsing to the same value as every other
 * unrecognised one.
 *
 * @param {number | {raw: number, name: string | null}} ft
 * @returns {string}
 */
function filetypeKey(ft) {
  if (ft === null || ft === undefined) return 'unknown';
  if (typeof ft === 'object') return ft.name ?? String(ft.raw);
  return String(ft);
}

/**
 * Name a `platform` word, or report it as an unnamed number.
 *
 * `PLATFORM_ANY` is the one entry that is named but not a platform: it is what a
 * *client* records when it will accept anything, and a binary carrying it was built
 * for something in particular. So it comes back `named: false` with the name
 * attached, and a caller counting "which platform is this for" does not count it.
 */
function decodePlatform(raw) {
  const known = PLATFORMS[raw];
  if (!known) return { name: null, named: false };
  return { name: known, named: raw !== 0xffffffff && raw !== 0 };
}

/**
 * A packed `X.Y.Z` version, the form `minos` and `sdk` take.
 *
 * Three fields of unequal width — 16, 8 and 8 bits — and the top one is the one that
 * identifies a major release. Reading it as three equal bytes is the obvious mistake
 * and it is silent: `0x000E0000` is 14.0.0, and the three-equal-bytes reading of it
 * produces components that all look like plausible versions.
 *
 * The raw word is kept alongside the components, for the same reason
 * {@link decodeSourceVersion} keeps its own: the packed form is what the file holds
 * and what other readers report, so a value compared against another reader matches
 * without either side converting.
 *
 * @param {number} v the packed `uint32` version
 * @returns {{raw: number, x: number, y: number, z: number, text: string}}
 */
function decodePackedVersion(v) {
  const x = (v >>> 16) & 0xffff;
  const y = (v >>> 8) & 0xff;
  const z = v & 0xff;
  return { raw: v, x, y, z, text: `${x}.${y}.${z}` };
}

/**
 * Mach-O and fat-header magics, as raw byte sequences.
 *
 * Compared as bytes rather than as integers, and that is not fussiness. A thin
 * little-endian Mach-O begins `cf fa ed fe`; read as a big-endian integer that
 * is 0xcffaedfe, which is in neither the fat nor the 64-bit-thin list, so a
 * reader written the obvious way accepts every universal binary and silently
 * rejects every thin one. Two copies of that check existed in this project at
 * one point and the test suite carried the correct version while the library
 * carried the broken one — so the check now lives here, once, and everything
 * imports it.
 */
const MACHO_MAGICS = [
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // fat
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]), // fat, byte-swapped
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // 64-bit thin
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]), // 32-bit thin
];

/** True when `p` is a readable file whose first four bytes are a Mach-O magic. */
function isMachOFile(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) !== 4) return false;
    return MACHO_MAGICS.some((m) => head.equals(m));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A human name for a CPU type, falling back to its raw value.
 *
 * The fallback is a real fallback and not a placeholder: `sliceName` is the
 * only place an architecture is turned into text, so an unmapped cputype still
 * *reports* correctly — as `cputype=0x12` — where a name guessed from the magic
 * would report something false.
 *
 * Coverage is ordered by who actually hands us these files, not by whether the
 * Darwin headers list them. `ppc` is here because GameCube and Wii binaries
 * are Mach-O and a large, expert user base analyses them weekly; `ppc64` is one
 * more line for the same ecosystem. `arm64_32` is here because watchOS ships it,
 * and it is emphatically *not* a subtype of arm64 — see {@link archMatches}.
 */
function sliceName(cputype) {
  if (cputype === CPU_X86_64) return 'x86_64';
  if (cputype === CPU_ARM64) return 'arm64';
  if (cputype === CPU_ARM64_32) return 'arm64_32';
  if (cputype === CPU_POWERPC64) return 'ppc64';
  if (cputype === CPU_POWERPC) return 'ppc';
  if (cputype === 0x0000000c) return 'arm';
  if (cputype === 0x00000007) return 'i386';
  if (cputype == null) return 'thin';
  return `cputype=0x${cputype.toString(16)}`;
}

/*
 * The `arm64e` constants and `sliceArchName` are defined once, below. Both merged
 * branches added them; the copy kept is the one that also knows
 * `CPU_SUBTYPE_ARM64E_V8` and masks the full 24-bit subtype, which is the more
 * correct of the two — the discarded copy compared only the low byte and would
 * miss the v8 subtype.
 */

/**
 * The subtypes that distinguish an architecture without changing its cputype.
 *
 * `arm64e` is not a separate `cputype` — it is `CPU_TYPE_ARM64` with a
 * different *subtype* — so {@link sliceName} cannot see it, and every arm64e
 * slice was reported as plain `arm64`. On iOS that is the difference between a
 * binary that uses pointer authentication and one that does not, which is the
 * first question anything PAC-related asks.
 *
 * Masked before comparison because the high byte carries capability flags
 * rather than subtype: `CPU_SUBTYPE_LIB64` is `0x80000000` and
 * `CPU_SUBTYPE_PTRAUTH_ABI` reuses the same bit, so a raw compare works on the
 * binaries seen so far and fails on one that set a flag — the kind of bug that
 * only appears on someone else's machine.
 */
const CPU_SUBTYPE_ARM64E = 2;
/** `CPU_SUBTYPE_ARM64E | 8`, the arm64e variant advertising the v8 ISA. */
const CPU_SUBTYPE_ARM64E_V8 = 10;

/**
 * A slice's architecture name, including the arm64e distinction.
 *
 * Takes the subtype and degrades to {@link sliceName} when it is absent, which
 * is a real case rather than a hypothetical: a thin slice's subtype may not have
 * been read, and `arm64` is a better answer than a fabricated `arm64e`. Every
 * call site therefore passes whatever it has, and an unknown subtype falls back
 * to the plain name rather than guessing.
 */
function sliceArchName(cputype, cpusubtype) {
  if (cputype === CPU_ARM64) {
    const st = cpusubtype == null ? null : cpusubtype & 0x00ffffff;
    if (st === CPU_SUBTYPE_ARM64E || st === CPU_SUBTYPE_ARM64E_V8) return 'arm64e';
  }
  return sliceName(cputype);
}

/**
 * Open a file and return a bounded reader with a small read cache.
 *
 * The cache matters: walking load commands and the symbol table re-reads the
 * same few pages many times, and without it a 476 MB universal binary turns
 * into hundreds of thousands of syscalls.
 */
function opener(p) {
  const fd = openSync(p, 'r');
  const size = fstatSync(fd).size;
  const cache = new Map();
  return {
    fd,
    size,
    path: p,
    /** Read `len` bytes at `off`. Short reads are returned as-is, never padded. */
    read(off, len) {
      if (off < 0 || len <= 0) return Buffer.alloc(0);
      if (off >= size) return Buffer.alloc(0);
      const want = Math.min(len, size - off);
      const key = `${off}:${want}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const b = Buffer.alloc(want);
      const n = readSync(fd, b, 0, want, off);
      const out = b.subarray(0, n);
      // Bounded rather than unbounded: the pointer-hunting tools sweep the
      // whole file and would otherwise pin hundreds of MB.
      if (cache.size > 4096) cache.clear();
      cache.set(key, out);
      return out;
    },
    close() {
      closeSync(fd);
    },
  };
}

/**
 * Parse a fat header into its slices, or null when this is not a fat binary.
 *
 * Returns `[]` rather than null for a fat file with no readable slice table,
 * so callers can tell "not fat" from "fat but unreadable".
 */
function parseFat(f) {
  const head = f.read(0, 8);
  if (head.length < 8) return null;
  const magic = head.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_CIGAM) return null;
  const n = head.readUInt32BE(4);
  const slices = [];
  for (let i = 0; i < n; i++) {
    const o = f.read(8 + i * 20, 20);
    if (o.length < 20) break;
    slices.push({
      cputype: o.readUInt32BE(0),
      // Byte 4 of the 20-byte `fat_arch`. Skipped until arm64e needed it, which
      // is the shape of most gaps here: the subtype is only meaningful for a few
      // architectures, but a reader that does not carry it cannot name them at
      // all, and naming is what `--arch` matches on.
      // Read so a fat slice's architecture can be named without opening it —
      // `arm64e` is a subtype, so the fat header's own record is enough to say
      // it. A thin file has no fat header and takes the subtype from its own
      // `mach_header` instead.
      cpusubtype: o.readUInt32BE(4),
      offset: o.readUInt32BE(8),
      size: o.readUInt32BE(12),
    });
  }
  return slices;
}

/**
 * Parse the load commands of the thin Mach-O at `base`.
 *
 * Returns null when there is no Mach-O header there, which is the normal
 * result for a non-binary file and must not throw.
 */
function parseThin(f, base = 0) {
  const hdr = f.read(base, 32);
  if (hdr.length < 28) return null;
  const magic = hdr.readUInt32LE(0);
  const is64 = magic === MH_MAGIC_64;
  if (!is64 && magic !== MH_MAGIC_32) return null;

  const cputype = hdr.readUInt32LE(4);
  // Read for one reason: `arm64e` is `CPU_TYPE_ARM64` with a different *subtype*,
  // not a different type, so the type alone cannot tell a pointer-authenticated
  // slice from a plain one. On iOS that distinction is the whole question for
  // anything PAC-related, and reporting `arm64` for an `arm64e` binary is a
  // confident answer to a question nobody asked.
  const cpusubtype = hdr.readUInt32LE(8);
  const filetype = hdr.readUInt32LE(12);
  const ncmds = hdr.readUInt32LE(16);
  const sizeofcmds = hdr.readUInt32LE(20);
  // Byte 24 in both header forms. `mach_header` and `mach_header_64` agree here
  // because the field precedes `reserved` and the only difference between the two
  // is that trailing 4 bytes plus the wider `n_value`s further in — so this one
  // is *not* a place the 32-bit/64-bit offset trap applies, and it is read
  // before `is64` is ever consulted rather than inside a `wide ?` ternary.
  const flags = hdr.readUInt32LE(24);
  let off = base + (is64 ? 32 : 28);
  const segments = [];
  const sections = [];
  const loadCommands = [];
  let symtab = null;
  let uuid = null;
  let functionStarts = null;
  let entryPoint = null;
  let sourceVersion = null;
  let buildVersion = null;
  let platform = null;
  let encryption = null;
  const rpaths = [];
  const dylibs = [];
  let installName = null;

  for (let i = 0; i < ncmds; i++) {
    const lc = f.read(off, 8);
    if (lc.length < 8) break;
    const cmd = lc.readUInt32LE(0);
    const cmdsize = lc.readUInt32LE(4);
    if (cmdsize < 8) break; // a zero cmdsize would loop forever

    // Recorded before any decoding, so every command appears even when nothing
    // here knows what it means. A reader that silently dropped the ones it did
    // not recognise would make an unfamiliar binary look simpler than it is,
    // which is the shape of a wrong answer rather than a partial one.
    loadCommands.push({ cmd, name: loadCommandName(cmd), cmdsize, offset: off - base });

    if (cmd === LC_UUID_CMD) {
      // 16 bytes at offset 8. A UUID is a value rather than an interpretation,
      // which is why it is read here and `LC_CODE_SIGNATURE` is not: reading the
      // bytes of an identifier is the same class of act as reading a section's
      // size, whereas following a code signature is decoding a structure. The
      // two differ by whether answering correctly requires understanding
      // something else's format.
      const s = f.read(off, 24);
      if (s.length >= 24) {
        uuid = s.toString('hex', 8, 24).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      }
    } else if (cmd === LC_SYMTAB) {
      const s = f.read(off, 24);
      if (s.length >= 24) {
        symtab = {
          symoff: s.readUInt32LE(8),
          nsyms: s.readUInt32LE(12),
          stroff: s.readUInt32LE(16),
          strsize: s.readUInt32LE(20),
        };
      }
    } else if (cmd === LC_FUNCTION_STARTS_CMD) {
      // `struct linkedit_data_command`: two `uint32_t`s after the header.
      // `dataoff` is a file offset into `__LINKEDIT` — relative to the slice, the
      // same basis every other offset in a load command uses — and `datasize` is
      // how many bytes the blob occupies, terminator and any padding included.
      // The bytes are decoded lazily by `functionStartAddresses`, because a slice
      // that is never asked about function starts should not pay to read them.
      const s = f.read(off, 16);
      if (s.length >= 16) {
        functionStarts = { dataoff: s.readUInt32LE(8), datasize: s.readUInt32LE(12), cmdsize };
      }
    } else if (cmd === LC_MAIN_CMD || cmd === LC_MAIN) {
      // `struct entry_point_command`: `cmdsize` 24, with `entryoff` and
      // `stacksize` both `uint64_t`. That is the form a real binary emits, and it
      // is matched on the `LC_REQ_DYLD` value (`0x80000028`) because that — not a
      // bare `0x28` — is how `<mach-o/loader.h>` defines `LC_MAIN`.
      //
      // This reader previously matched the bare `0x29` and concluded that every
      // binary shipped a 16-byte command. `0x29` is `LC_DATA_IN_CODE`, a
      // `linkedit_data_command` carrying `dataoff`/`datasize`; its `dataoff` is a
      // file offset into `__LINKEDIT`, which is why `describe` used to report an
      // entry offset that landed outside `__TEXT`. The `cmdsize` bound below is
      // kept as defence against a malformed file, not because a shorter form is
      // expected. `entryoff` stays a BigInt: narrowing a genuine 64-bit offset to
      // a Number would lose precision above 2^53.
      const want = Math.min(cmdsize, 24);
      const s = f.read(off, want);
      if (s.length >= 16) {
        const raw = s.readBigUInt64LE(8);
        const wide = cmdsize >= 24;
        entryPoint = {
          entryoff: wide ? raw : (raw & 0xffffffffn),
          rawHigh32: Number((raw >> 32n) & 0xffffffffn),
          // `null`, not 0, when the command is too short to carry it: "this
          // command declared no stack size" and "this command declared a stack
          // size of zero" are different claims, and only one is true.
          stacksize: wide ? s.readBigUInt64LE(16) : null,
          cmdsize,
          valueBasis: wide
            ? 'LC_MAIN.entryoff read as uint64 — the documented 24-byte layout'
            : `LC_MAIN.entryoff read as its low 32 bits — this command declares cmdsize ${cmdsize}, ` +
              'shorter than the documented 24 bytes',
        };
      }
    } else if (cmd === LC_RPATH_CMD) {
      // `struct rpath_command` ends in `union lc_str path`, which is an *offset*
      // — measured from the start of this load command — not a string stored
      // inline. Reading eight bytes in as if it were the first characters of the
      // path yields a string that looks like a path: a little-endian length-like
      // value, and it will pass a "does it look sane" check while naming a
      // directory that does not exist. The offset is taken literally, and
      // bounds-checked against this command's own `cmdsize`.
      const s = f.read(off, 12);
      if (s.length >= 12) {
        const rel = s.readUInt32LE(8);
        if (rel >= 12 && rel < cmdsize) {
          const body = f.read(off + rel, cmdsize - rel);
          const z = body.indexOf(0);
          const path = body.toString('latin1', 0, z < 0 ? body.length : z);
          if (path) rpaths.push(path);
        }
      }
    } else if (DYLIB_COMMANDS.has(cmd) || cmd === DYLIB_ID_CMD) {
      // `struct dylib_command`, the one load command that says *what this binary
      // needs to run* — the answer to the most-asked question about any
      // executable, and the one `otool -L` exists to print.
      //
      // The `dylib` field is a `union lc_str`, so it is an offset from the start
      // of this command for the same reason `LC_RPATH`'s is: reading the eight
      // bytes in as if they were the first characters of the name yields a string
      // that looks like a path and passes a plausibility check while naming a
      // library that does not exist. The offset is taken literally.
      //
      // `cmdsize >= 24` is the floor rather than a nicety: below it the version
      // fields are not present, and reading them would take bytes from the
      // *next* load command. A truncated command is reported by `audit`; here it
      // yields no name rather than a fabricated one.
      const s = f.read(off, 24);
      if (s.length >= 24 && cmdsize >= 24) {
        const rel = s.readUInt32LE(8);
        if (rel >= 24 && rel < cmdsize) {
          const body = f.read(off + rel, cmdsize - rel);
          const z = body.indexOf(0);
          const name = body.toString('latin1', 0, z < 0 ? body.length : z);
          if (name) {
            const decoded = {
              name,
              cmd,
              cmdName: loadCommandName(cmd),
              timestamp: s.readUInt32LE(12),
              currentVersion: s.readUInt32LE(16),
              compatVersion: s.readUInt32LE(20),
            };
            if (cmd === DYLIB_ID_CMD) installName = decoded;
            else dylibs.push({ ...decoded, linkage: DYLIB_COMMANDS.get(cmd).linkage });
          }
        }
      }
    } else if (cmd === LC_ENCRYPTION_INFO_CMD || cmd === LC_ENCRYPTION_INFO_64_CMD) {
      // `struct encryption_info_command`, 20 bytes, identical in both forms —
      // `LC_ENCRYPTION_INFO_64` differs only in that the encrypted range it names is
      // a 64-bit one, which is already true because the offsets are 32-bit words into
      // a 64-bit file's address space. `cryptid` is the one field that matters:
      //
      //   0  the binary is not encrypted, or has been decrypted in place
      //   1  __TEXT is ciphertext — an App Store build, not yet run once
      //   >1  encrypted with a key whose sub-version this is (FairPlay)
      //
      // This is the single fact that decides whether a zero result from `findcall`,
      // `findliteral` or `--strings` means "not present" or "not readable", and
      // reporting it is the difference between those two being distinguishable. A
      // command naming encryption is *not* enough — a decrypted binary keeps the
      // command with `cryptid` 0, and reading presence rather than value would call
      // a decrypted App Store binary still encrypted.
      const s = f.read(off, 20);
      if (s.length >= 20) {
        encryption = {
          command: loadCommandName(cmd),
          cryptoff: s.readUInt32LE(8),
          cryptsize: s.readUInt32LE(12),
          cryptid: s.readUInt32LE(16),
          /** True only for a positive `cryptid` — see above. */
          encrypted: s.readUInt32LE(16) > 0,
        };
      }
    } else if (cmd === LC_BUILD_VERSION_CMD) {
      // `struct build_version_command`: `cmdsize` 24 for a binary with no tool
      // records, then 8 bytes per tool. The three fields that matter are read and the
      // tool records are not — they are a list of `{tool, version}` pairs whose tools
      // are identified by the SDK's own enum, which is a second table to transcribe
      // and a second thing to get subtly wrong. So the command is decoded for the
      // platform it names and the tools are left alone rather than reported wrongly.
      const s = f.read(off, 24);
      if (s.length >= 24) {
        const raw = s.readUInt32LE(8);
        buildVersion = {
          command: 'LC_BUILD_VERSION',
          platform: decodePlatform(raw).name,
          platformRaw: raw,
          minos: decodePackedVersion(s.readUInt32LE(12)),
          sdk: decodePackedVersion(s.readUInt32LE(16)),
          // Reported rather than acted on: a reader that stops at 24 bytes on a
          // command with `ntools > 0` would silently ignore the rest of it, and a
          // caller deserves to know that is what happened.
          ntools: s.readUInt32LE(20),
        };
      }
    } else if (VERSION_MIN_COMMANDS.has(cmd)) {
      // `struct version_min_command`, `cmdsize` 16: a packed version and the SDK
      // that built it, with the platform implied by the command. This is the form
      // `LC_BUILD_VERSION` replaced, and it is why `describe` reports `platform`
      // from either.
      const s = f.read(off, 16);
      if (s.length >= 16) {
        const platform = VERSION_MIN_COMMANDS.get(cmd);
        buildVersion = {
          command: loadCommandName(cmd),
          platform,
          platformRaw: null,
          minos: decodePackedVersion(s.readUInt32LE(8)),
          sdk: decodePackedVersion(s.readUInt32LE(12)),
          ntools: 0,
        };
      }
    } else if (cmd === LC_SOURCE_VERSION_CMD) {
      // `struct source_version_command`, `cmdsize` 16. The packing is
      // `a24.b10.c10.d10.e10`; see {@link decodeSourceVersion}.
      const s = f.read(off, 16);
      if (s.length >= 16) sourceVersion = decodeSourceVersion(s.readBigUInt64LE(8));
    } else if (cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT) {
      const wide = cmd === LC_SEGMENT_64;
      const need = wide ? 72 : 56;
      const s = f.read(off, need);
      if (s.length >= need) {
        const segname = s.toString('latin1', 8, 24).replace(/\0.*$/, '');
        segments.push({
          segname,
          vmaddr: wide ? s.readBigUInt64LE(24) : BigInt(s.readUInt32LE(24)),
          vmsize: wide ? s.readBigUInt64LE(32) : BigInt(s.readUInt32LE(28)),
          fileoff: wide ? s.readBigUInt64LE(40) : BigInt(s.readUInt32LE(32)),
          filesize: wide ? s.readBigUInt64LE(48) : BigInt(s.readUInt32LE(36)),
          // The two protection masks and the segment flags, read from the same
          // transcribed offsets as the sizes above rather than by scaling: `maxprot`
          // sits at 56 in `segment_command_64` and 40 in `segment_command`, which is
          // the same 16-byte gap the address fields open and not a multiple of it.
          //
          // These answer "may the loader write here, and did the linker say this
          // segment must be zero-filled and protected until used" — which is what
          // distinguishes `__PAGEZERO` (maxprot 0, entirely unwritable) from a
          // segment that merely happens to be mapped read-only. A reader that
          // reports only vmaddr and vmsize cannot tell those apart, and would call
          // `__PAGEZERO` a 4 GiB writable mapping.
          maxprot: s.readUInt32LE(wide ? 56 : 40),
          initprot: s.readUInt32LE(wide ? 60 : 44),
          flags: s.readUInt32LE(wide ? 68 : 52),
        });
        // Section entries follow the segment command. Both forms carry them —
        // this used to read only the 64-bit one, which meant a 32-bit slice
        // reported zero sections and every address lookup in it came back "not
        // in a section".
        //
        // The offsets below are transcribed from `<mach-o/loader.h>` in the macOS
        // SDK rather than derived from the 64-bit form, because the two layouts
        // are not related by a scale factor:
        //
        //   field       section_64   section
        //   addr            32          32
        //   size            40          36
        //   offset          48          40
        //   flags           64          56
        //   entry size      80          68
        //
        // `addr` is the only field at the same offset in both, because the two
        // 16-byte name fields above it are the same size in both. Every 32-bit
        // field after it shifts the next one 4 bytes earlier, so `flags` ends up
        // 8 bytes apart and the entries differ in length by 12 rather than by a
        // factor. Scaling 48 by 68/80 happens to give 40 — the right answer by
        // luck, and the wrong way to arrive at one.
        const sectsAt = wide ? 64 : 48;          // nsects, in the segment command
        const sectSize = wide ? 80 : 68;
        const sectBase = off + (wide ? 72 : 56);  // the segment command's own size
        const nsects = s.readUInt32LE(sectsAt);
        for (let k = 0; k < nsects; k++) {
          const sc = f.read(sectBase + k * sectSize, sectSize);
          if (sc.length < sectSize) break;
          const secFlags = sc.readUInt32LE(wide ? 64 : 56);
          sections.push({
            sectname: sc.toString('latin1', 0, 16).replace(/\0.*$/, ''),
            segname: sc.toString('latin1', 16, 32).replace(/\0.*$/, ''),
            addr: wide ? sc.readBigUInt64LE(32) : BigInt(sc.readUInt32LE(32)),
            size: Number(wide ? sc.readBigUInt64LE(40) : sc.readUInt32LE(36)),
            offset: sc.readUInt32LE(wide ? 48 : 40),
            // `align`, `reloff` and `nreloc`, from the same two transcribed layouts.
            // These are the three fields that describe *how* the section is laid out
            // rather than where it is, and they are what a reader needs to rebuild a
            // section's byte range by hand:
            //
            //   field       section_64   section
            //   align           52          44
            //   reloff          56          48
            //   nreloc          60          52
            //
            // `align` is a power of *two*, not a byte count — `2` means 4-byte
            // alignment, `0` means "no alignment constraint recorded". It is reported
            // raw rather than expanded, because the raw form is what the file holds
            // and what every other reader reports, so a value cross-checked against
            // one of them compares equal without a conversion on either side.
            align: sc.readUInt32LE(wide ? 52 : 44),
            reloff: sc.readUInt32LE(wide ? 56 : 48),
            nreloc: sc.readUInt32LE(wide ? 60 : 52),
            // Section attributes. Read because S_ATTR_*_INSTRUCTIONS is the only
            // in-file signal that separates code from data, and a byte scanner
            // that cannot tell them apart reports data as call sites — see
            // `instructionSections`. Offset 64 in `section_64`, 56 in `section`.
            //
            // `flags` stays the raw word and stays authoritative; the decoded
            // `type`/`attributes` are spread in beside it rather than replacing
            // it, so a caller that needs the undecoded value — and the abnormality
            // check does, to notice attribute bits this table cannot name — does
            // not have to recompute it.
            flags: secFlags,
            ...decodeSectionFlags(secFlags),
          });
        }
      }
    }
    off += cmdsize;
  }
  return {
    is64, cputype, cpusubtype, filetype: decodeFiletype(filetype), ncmds, sizeofcmds, flags,
    // `filetypeName` is computed here so every consumer names MH_EXECUTE,
    // MH_DYLIB and MH_BUNDLE the same way. On macOS those are usually one binary
    // each; an iOS `.app` contains all three, and "which one is this" is the
    // first question a bundle raises.
    filetypeName: filetypeName(filetype),
    segments, sections, loadCommands, symtab, uuid,
    entryPoint, sourceVersion, buildVersion, encryption, rpaths, dylibs, installName,
    functionStarts, platform,
  };
}

/**
 * Every slice of a binary, as `{ cputype, offset, size, thin }`.
 *
 * A thin binary comes back as a single slice with `thin: true` and a null
 * cputype, so callers can treat both shapes identically.
 */
function slicesOf(f) {
  const fat = parseFat(f);
  if (fat) return fat.map((s) => ({ ...s, thin: false }));
  return [{ cputype: null, cpusubtype: null, offset: 0, size: f.size, thin: true }];
}

/** The `__TEXT` section of a parsed slice, which is where literals live. */
function textSection(thin) {
  return (
    thin.sections.find((s) => s.segname === '__TEXT' && s.size > 0) ||
    thin.sections.find((s) => s.segname === '__TEXT') ||
    null
  );
}

/** True when a section's attributes say it contains instructions. */
function isCodeSection(sec) {
  return (sec.flags & (S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS)) !== 0;
}

/**
 * The sections of a slice that hold code, ordered as they appear in the file.
 *
 * This is what turns an untyped byte scan into a typed one. The previous
 * approach scanned `__text` end to end, and `__text` is not entirely code: it
 * also carries the `__cstring`/`__const`/`__literal*` sections, jump tables and
 * alignment padding. Any of those can contain bytes that decode as a `call
 * rel32` pointing at the address you asked about, and each such byte was
 * reported as a call site. The output looked like a list of callers and was
 * partly fiction.
 *
 * `__stubs` is included deliberately: PLT stubs are code and do contain direct
 * `jmp rel32` and `call rel32` instructions, so they are legitimate results and
 * filtering them out would hide real edges.
 *
 * Falls back to every non-empty section when the slice carries no
 * instruction-flagged section at all. That is a rare and slightly worrying
 * input — a hand-built or unusual binary — and the alternative (report zero
 * call sites) would be the confident-wrong-answer failure this project has
 * already produced several of. `fallback: true` in the result tells the caller
 * which answer it got.
 */
function codeSections(thin) {
  const code = thin.sections.filter((s) => s.size > 0 && isCodeSection(s));
  if (code.length) return { sections: code, fallback: false };
  return {
    sections: thin.sections.filter((s) => s.size > 0),
    fallback: true,
  };
}

/**
 * Read every symbol name in a slice.
 *
 * Both defined symbols (N_SECT) and imported ones are kept and counted apart:
 * a family satisfied only by an import is weaker evidence than one satisfied
 * by the engine's own definition, so `entries` exposes the distinction rather
 * than flattening it. Debugging entries (N_STAB) are skipped — they are not
 * symbols.
 *
 * `names` is the convenient form for substring matching. `entries` carries
 * each symbol's vaddr and defined/imported flag, which the address-oriented
 * tools (`sym`, `symlookup`) need and which a name-only
 * projection would throw away.
 */
function readSymbols(f, base, thin) {
  const { symtab } = thin;
  // Every return path carries the same keys. The two early ones used to omit
  // `entries`, so a caller that destructured uniformly — which is what the test
  // suite did — got `undefined` and threw on a binary with no symbol table. That
  // is the worst shape for a reader whose whole job is to handle binaries that
  // lack things: the case where the fields are missing is exactly the case
  // nobody exercises until they hit it in the wild.
  if (!symtab || symtab.nsyms === 0) {
    return {
      names: [], entries: [], defined: 0,
      total: symtab ? symtab.nsyms : 0,
      note: symtab ? 'empty symbol table' : 'no LC_SYMTAB',
    };
  }

  const str = f.read(base + symtab.stroff, symtab.strsize);
  if (str.length === 0) {
    return { names: [], entries: [], defined: 0, total: symtab.nsyms, note: 'empty string table' };
  }

  const nameAt = (x) => {
    if (x >= str.length) return '';
    const z = str.indexOf(0, x);
    return str.toString('latin1', x, z < 0 ? str.length : z);
  };

  const names = [];
  const entries = [];
  let defined = 0;
  const BATCH = 20000;
  // `nlist` is 16 bytes in the 64-bit form and 12 in the 32-bit one, and its
  // `n_value` is a `uint64_t` in the first and a `uint32_t` in the second. This
  // used to read 16-byte entries with a 64-bit value unconditionally, so every
  // symbol in a 32-bit slice was read at the wrong stride: names came from the
  // wrong place in the string table, `n_type` from what was actually another
  // entry's `n_strx`, and the address from bytes that were never an address. The
  // symptom was not an error — it was plausible-looking wrong symbols, which is
  // why the stride is taken from the parse rather than written as a constant.
  const nlistSize = thin.is64 ? 16 : 12;
  for (let b = 0; b < symtab.nsyms; b += BATCH) {
    const cnt = Math.min(BATCH, symtab.nsyms - b);
    const blk = f.read(base + symtab.symoff + b * nlistSize, cnt * nlistSize);
    if (blk.length < cnt * nlistSize) break;
    for (let i = 0; i < cnt; i++) {
      const at = i * nlistSize;
      const info = blk[at + 4];
      if (info & N_STAB) continue;
      const strx = blk.readUInt32LE(at);
      if (strx >= str.length) continue;
      const isDefined = (info & N_TYPE) === N_SECT;
      if (isDefined) defined++;
      const nm = nameAt(strx);
      if (!nm) continue;
      names.push(nm);
      entries.push({
        name: nm,
        addr: thin.is64 ? blk.readBigUInt64LE(at + 8) : BigInt(blk.readUInt32LE(at + 8)),
        defined: isDefined,
      });
    }
  }
  return { names, entries, defined, total: symtab.nsyms, note: null };
}

/**
 * The function start addresses of a slice, decoded from `LC_FUNCTION_STARTS`.
 *
 * ## The format
 *
 * `LC_FUNCTION_STARTS` names a blob in `__LINKEDIT`: a sequence of ULEB128
 * values. The first is a delta from the image base — the `__TEXT` segment's
 * `vmaddr`, which is also the address of the Mach header — and every later one is
 * a delta from the address before it. A zero value ends the list; anything after
 * it is alignment padding.
 *
 * ## Why the base is `__TEXT.vmaddr` and not zero
 *
 * Every measured binary puts its first function a little after `__TEXT.vmaddr`,
 * and the deltas are small. Treating them as absolute would report that function
 * at `0x1f8` rather than `0x1000001f8` — an address plausible enough to be passed
 * to another tool and looked up, which is why the base is read rather than
 * assumed. This is the same reasoning that keeps `entryoff` a raw offset: a
 * derived address that is wrong is worse than an offset that is honest.
 *
 * ## Truncation is reported, not hidden
 *
 * A blob whose last value still has its continuation bit set is damaged or
 * clipped. The partial value is dropped and `truncated` is true, because a
 * silently dropped value turns "the list ends here" into a complete-looking list
 * that is one short.
 *
 * @param {Opener} f
 * @param {Thin} thin
 * @param {number} [sliceOffset=0] the slice's position in the file
 */
function functionStartAddresses(f, thin, sliceOffset = 0) {
  const fs = thin.functionStarts;
  if (!fs || fs.datasize === 0) {
    return { base: null, addresses: [], truncated: false, present: false };
  }
  const text = thin.segments.find((s) => s.segname === '__TEXT');
  const base = text ? text.vmaddr : thin.segments[0]?.vmaddr ?? 0n;
  const buf = f.read(sliceOffset + fs.dataoff, fs.datasize);
  const addresses = [];
  let addr = base;
  let i = 0;
  let truncated = false;
  while (i < buf.length) {
    let value = 0n;
    let shift = 0n;
    let more = true;
    while (more) {
      if (i >= buf.length) {
        truncated = true;
        break;
      }
      const byte = buf[i++];
      value |= BigInt(byte & 0x7f) << shift;
      more = (byte & 0x80) !== 0;
      shift += 7n;
    }
    if (truncated) break;
    if (value === 0n) break; // the terminator
    addr += value;
    addresses.push(addr);
  }
  return { base, addresses, truncated, present: true };
}

/**
 * Pick the slice most worth probing: the one with the most symbols.
 *
 * A universal binary can be stripped on one architecture and not the other, so
 * "first slice" is the wrong rule. Falls back to the first parseable slice so
 * a fully stripped binary still gets its string scan run.
 */
function richestSlice(f) {
  let best = null;
  for (const s of slicesOf(f)) {
    const thin = parseThin(f, s.offset);
    if (!thin) continue;
    const syms = readSymbols(f, s.offset, thin);
    const entry = {
      ...s,
      arch: s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype),
      thin,
      names: syms.names,
      nsyms: syms.total,
      ndefined: syms.defined,
      stripped: syms.note || syms.total === 0,
      symNote: syms.note,
    };
    if (!best || entry.names.length > best.names.length) best = entry;
  }
  return best;
}

/**
 * The byte offset of the slice a tool should read.
 *
 * This is the one number the old tools got wrong by hardcoding. It reads only
 * the load commands and the symbol *count*, not the symbol names, so it is
 * cheap enough to call before deciding what else to do — the address-oriented
 * tools need the offset and then walk the symtab themselves.
 *
 * @param {object} f        an `opener()` handle
 * @param {string} [prefer] architecture to prefer, e.g. 'x86_64'
 * @returns {{offset:number, arch:string, nsyms:number, thin:object}|null}
 *
 * `prefer` is a preference, not a requirement. The first version treated it as
 * a requirement and returned null whenever the named slice was absent, which
 * made every caller fail outright on an arm64-only binary — including on a
 * thin arm64 Go toolchain, where there is no x86_64 slice to find. The right
 * behaviour is "use this one if it exists, otherwise take the richest", and
 * reporting which slice was actually chosen is the caller's job.
 */
function preferredSlice(f, prefer) {
  let best = null;
  for (const s of slicesOf(f)) {
    const thin = parseThin(f, s.offset);
    if (!thin) continue;
    const arch = s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype);
    const nsyms = thin.symtab ? thin.symtab.nsyms : 0;
    const entry = { offset: s.offset, arch, nsyms, thin, size: s.size };
    // `archMatches`, not `===`. Naming arm64e as its own architecture turned this
    // comparison into a real bug: on an Apple-silicon system binary whose slice
    // is `arm64e`, `--arch=arm64` stopped matching, the preference was ignored,
    // and the caller got whichever slice happened to be richest — silently the
    // wrong answer to a question that had been asked precisely.
    if (prefer && archMatches(arch, prefer)) return entry;
    if (!best || nsyms > best.nsyms) best = entry;
  }
  return best;
}

/**
 * True when a slice's architecture name satisfies a requested one.
 *
 * The comparison is by name because that is what `--arch` takes, and names are
 * what every tool already reports. A caller asking for `arm64` against an
 * `arm64e` slice is asking for the same instruction set, so the `e` suffix is
 * ignored — otherwise `--arch=arm64` would read nothing from an Apple-silicon
 * system binary whose slice is named `arm64e`, and report the file as empty.
 *
 * The suffix rule is deliberately narrow, and the names added since say why it
 * has to stay that way. `arm64e` differs from `arm64` only in capability bits on
 * the same 64-bit instruction set, so collapsing them is safe. `arm64_32` and
 * `ppc`/`ppc64` are a different thing entirely: `arm64_32` is 32-bit pointers
 * under a distinct ABI, and the two PowerPC types differ in pointer width. None
 * of them ends in `e`, so none of them collapse, and that is the property worth
 * asserting rather than assuming — a name that later gained a trailing `e`
 * would silently start matching an architecture it is not.
 */
function archMatches(sliceArch, want) {
  if (!want) return true;
  if (sliceArch === want) return true;
  return String(sliceArch).replace(/e$/, '') === String(want).replace(/e$/, '');
}

/**
 * True when a section occupies bytes in the file, as opposed to being zero-fill.
 *
 * `__bss` and `__noptrbss` have a real `addr` and a real `size` but no bytes
 * anywhere: the loader supplies zeros. The linker records their file `offset` as
 * 0, and their address range usually extends past the end of the segment's
 * `filesize`, so a `size > 0` test does not exclude them.
 *
 * This distinction decides whether an address can be read from the file at all,
 * and getting it wrong is not a small error. In `go`, `__DATA,__bss` covers
 * file offsets 0 through 180,760 — which are the Mach-O header and its load
 * commands. A `o2a` that treated it as backed by the file reported file offset
 * 0x1000 as being inside `__bss`, when it is the first byte of `__text`.
 *
 * The test is containment in the owning segment's file range rather than a
 * comparison against the section's own `offset`, because `offset` is the field
 * that is *not* meaningful for these sections.
 */
function isBackedByFile(thin, sec) {
  if (sec.size === 0) return false;
  const seg = thin.segments.find((g) => g.segname === sec.segname);
  if (!seg) return sec.offset !== 0;
  // A section's file range is only real if it lies within the segment's.
  return sec.offset >= Number(seg.fileoff)
    && sec.offset + sec.size <= Number(seg.fileoff) + Number(seg.filesize);
}

/**
 * An `LC_MAIN` entry point, reported as the file offset the header declares.
 *
 * ## Why there is still no address here
 *
 * `<mach-o/loader.h>` calls `entryoff` the "file (__TEXT) offset of main()".
 * Now that `parseThin` matches the command that actually carries it
 * (`0x80000028`), that offset is a genuine file offset — the earlier note about it
 * "landing in `__LINKEDIT`" was an artefact of reading `LC_DATA_IN_CODE` instead.
 *
 * `vaddr` is nevertheless `null`, and deliberately: the value this function
 * returns is the *raw* field, and an address is one derivation away from it, via
 * `a2o`. Deriving it here would put a second, independently-computed answer for
 * the same fact next to `a2o`'s, and two answers that can disagree is the failure
 * mode this package exists to avoid. A caller that wants the address passes
 * `entryoff` to `a2o`; a caller that wants the symbol passes it to `symlookup`.
 *
 * `entryoffLandsInText` is reported because it is checkable and it is a useful
 * integrity signal — a valid entry offset lies inside `__TEXT` — without being an
 * abnormality, since a dyld shared-cache stub legitimately has no `__TEXT` bytes
 * of its own.
 *
 * @param {object} thin a `parseThin()` result
 * @returns {null|{entryoff: bigint, stacksize: bigint|null, cmdsize: number,
 *   vaddr: null, entryoffLandsInText: boolean|null, note: string}}
 */
function resolveEntryPoint(thin) {
  if (!thin.entryPoint) return null;
  const { entryoff, stacksize, cmdsize, rawHigh32, valueBasis } = thin.entryPoint;
  const text = thin.segments.find((g) => g.segname === '__TEXT') || null;
  const inText = text
    ? entryoff >= text.fileoff && entryoff < text.fileoff + text.filesize
    : null;
  return {
    entryoff,
    stacksize,
    cmdsize,
    rawHigh32,
    valueBasis,
    vaddr: null,
    entryoffLandsInText: inText,
    note: 'raw file (__TEXT) offset; no address is derived from it — pass entryoff ' +
      'to a2o for the vaddr, or to symlookup for the symbol'
      + (inText === false ? ', and this one falls outside __TEXT' : ''),
  };
}

/**
 * Shannon entropy of a buffer, in bits per byte (0..8).
 *
 * Sampled over at most `maxBytes` rather than the whole buffer. The only consumer
 * is the packing heuristic in {@link detectAbnormalities}, and "is this blob
 * compressed" is answered by its first megabyte as reliably as by its last —
 * whereas a 200 MB string table read in full on every `describe` would make the
 * cheapest tool in the package the slowest one. Sampling a prefix also keeps the
 * measurement cheap for the fixture-sized files the suite runs on.
 */
/* ------------------------------------------------------------------ *
 * fingerprint
 * ------------------------------------------------------------------ */

/**
 * A short, stable digest of a list of strings, order-independent.
 *
 * Sorted before hashing, because the same program produces these lists in whatever
 * order the linker happened to emit them and a fingerprint that changed when the
 * linker changed its mind would be useless for the only question it is asked.
 *
 * A digest rather than the list itself, for two reasons: the lists run to tens of
 * thousands of entries, and the value is meant to be comparable at a glance and
 * quotable in a bug report.
 *
 * Separated by a byte that cannot occur in a symbol name, so `["ab","c"]` and
 * `["a","bc"]` cannot collide. Without the separator those two hash identically —
 * which is not a theoretical concern, since C++ mangled names are built from exactly
 * those pieces.
 */
function digestOf(items, length = 12) {
  const h = createHash('sha256');
  for (const s of [...items].sort()) {
    h.update(s, 'latin1');
    h.update('\0');
  }
  return h.digest('hex').slice(0, length);
}

/**
 * Load commands excluded from a slice's shape digest, because they record *this
 * build's provenance* rather than what the program is.
 *
 * This list was not guessed. Comparing a fixture against a copy of itself with an
 * `LC_UUID` appended reported "different programs", which is absurd: `LC_UUID`
 * says which build produced a file, not what is in it, and the fingerprint already
 * reports the UUID separately and exactly. Leaving it in the shape made the digest
 * sensitive to precisely the kind of change the digest exists to ignore.
 *
 * Each entry, with the reason it earns its place:
 *
 *   LC_UUID              the build id. Already reported as `uuid`, exactly.
 *   LC_CODE_SIGNATURE    present only once the file has been signed, so a build
 *                        that skipped signing differs from one that did not while
 *                        containing identical code.
 *   LC_DYLIB_CODE_SIGN_DRS  the same, for the signature's own resource directory.
 *   LC_SOURCE_VERSION    the source revision, which moves with the VCS state rather
 *                        than with the program.
 *
 * Deliberately *not* excluded, because they are properties of the program rather
 * than of the build: the version-minimum and build-version commands (what the
 * binary requires), every dylib load (which library it needs), and everything else.
 * A digest that ignored those would call two genuinely different binaries the same,
 * which is the failure this whole feature is meant to avoid.
 */
const PROVENANCE_COMMANDS = new Set([
  'LC_UUID',
  'LC_CODE_SIGNATURE',
  'LC_DYLIB_CODE_SIGN_DRS',
  'LC_SOURCE_VERSION',
]);

/**
 * A structural digest of one slice: what it *is*, with nothing that a rebuild moves.
 *
 * ## What goes in, and what is deliberately left out
 *
 * In: the architecture, the word size, the filetype, every section's name, every
 * load command's *name* except the provenance ones, and every defined symbol's
 * name.
 *
 * Out: every address, every size, every offset, the UUID, and the version numbers
 * and paths inside `LC_LOAD_DYLIB`. All of those change between two builds of the
 * same source — ASLR and a PIE base move every address, a dependency bump moves a
 * dylib's current version, a rebuild moves a timestamp — so including any of them
 * would make the fingerprint answer "were these built by the same invocation",
 * which is a question the UUID already answers better.
 *
 * The one judgement call worth naming is section *sizes*, which are excluded for
 * the same reason: a rebuild that changes a dependency's version changes a size
 * without changing the program. That does make a stripped binary's fingerprint
 * weaker, which is why {@link sliceShape} reports a `tier` rather than presenting
 * a structure-only digest as though it were as strong as a full one.
 *
 * ## Pure, and deliberately so
 *
 * Takes its inputs rather than a file handle, so it is testable without a binary
 * and cannot be confused with a function that reads anything.
 *
 * @param {object} p
 * @param {string} p.arch      architecture name
 * @param {number} p.bits      64 or 32
 * @param {number} p.filetype  the `MH_*` value
 * @param {Array<{segname: string, sectname: string}>} p.sections
 * @param {Array<{name: string}>} p.loadCommands
 * @param {Array<{name: string}>} p.definedSymbols  names only
 * @returns {{structure: string, symbols: string|null, fingerprint: string, tier: 'full'|'structure-only', nsyms: number}}
 */
function sliceShape({ arch, bits, filetype, sections, loadCommands, definedSymbols }) {
  // Interpolated straight into the digest, so it has to be a stable string — see
  // {@link filetypeKey} for what went wrong here and in `diff` when it was a number.
  const ftKey = filetypeKey(filetype);
  const structure = digestOf([
    `arch:${arch}`,
    `bits:${bits}`,
    `filetype:${ftKey}`,
    ...sections.map((s) => `sect:${s.segname},${s.sectname}`),
    // Names only. A dylib's path and version live inside the command and change on
    // every dependency bump; the fact that the binary loads a dylib does not.
    // Names only, and provenance excluded — see `PROVENANCE_COMMANDS`. A dylib's
    // path and version live inside the command and change on every dependency bump;
    // the fact that the binary loads a dylib does not.
    ...loadCommands.filter((c) => !PROVENANCE_COMMANDS.has(c.name)).map((c) => `lc:${c.name}`),
  ]);

  const nsyms = definedSymbols.length;
  if (nsyms === 0) {
    // No names to work with, so the digest is structural only — and says so. A
    // stripped binary is not a weaker *program*, but the fingerprint of one is a
    // weaker claim, and presenting the two identically would overstate it.
    return { structure, symbols: null, fingerprint: structure, tier: 'structure-only', nsyms: 0 };
  }
  const symbols = digestOf(definedSymbols.map((s) => `sym:${s.name}`));
  // Both digests are folded in, so the result changes if *either* the structure or
  // the symbol set does — including the case where a binary gains or loses symbols
  // without gaining or losing sections.
  const fingerprint = digestOf([`structure:${structure}`, `symbols:${symbols}`]);
  return { structure, symbols, fingerprint, tier: 'full', nsyms };
}

/**
 * A structural digest for a whole file, across every slice.
 *
 * Per-slice digests are combined rather than pooled, because a universal binary's
 * slices are independently meaningful: two builds of the same program that gained
 * an architecture should match on the slices they share and differ on the one that
 * is new. Pooling would report "different" for both and hide which.
 *
 * @param {Array<{arch: string, fingerprint: string}>} slices
 */
function fileShape(slices) {
  return digestOf(slices.map((s) => `slice:${s.arch}:${s.fingerprint}`));
}

function shannonEntropy(f, offset, length, maxBytes = 1 << 20) {
  const n = Math.min(length, maxBytes);
  if (n <= 0) return 0;
  const buf = f.read(offset, n);
  if (buf.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (const b of buf) freq[b]++;
  let h = 0;
  for (const c of freq) {
    if (c === 0) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Above this many bits per byte, a string table is treated as probably packed. */
const PACKED_ENTROPY = 6.4;

/**
 * Structural problems in one slice, reported rather than thrown.
 *
 * ## Why this exists
 *
 * Every other function in this reader answers a question about a well-formed
 * binary. This one answers a question about a *malformed* one, which is the
 * case where the confident-wrong-answer failure this project keeps fighting is
 * most likely: a truncated file, a hand-patched header or a packed binary all
 * produce bytes that parse without error and describe as something real.
 *
 * It is deliberately separate from parsing. A reader that reported a problem by
 * returning null would make "this binary is damaged" indistinguishable from "this
 * binary does not have that", which is the same conflation `a2o` was fixed for.
 * So parsing stays permissive and this reports alongside it.
 *
 * ## What is checked, and what is not
 *
 * Only things that can be decided from the bytes alone, and only where being
 * wrong would change a tool's answer:
 *
 *   - header flag bits with no name in `loader.h`;
 *   - fewer readable load commands than the header's `ncmds` claims, which means
 *     the walk was cut short and the section and symbol tables may be incomplete;
 *   - a section or segment claiming bytes past the end of its slice;
 *   - a symbol or string table reaching past the slice;
 *   - the symbol and string tables overlapping each other, which no legitimate
 *     linker output does;
 *   - a string table whose byte distribution is too flat to be text.
 *
 * Deliberately not checked: an `LC_MAIN` entry point outside `__TEXT`. That is the
 * normal state of a dyld shared-cache stub and, measured, also true of a
 * fully-symbolled 113 MB `node` — so the check fired on essentially every correct
 * binary this package is pointed at. A warning that is always true teaches a
 * reader to skip warnings; the raw offset is reported in `entryPoint` instead, and
 * whether it lands in `__TEXT` is disclosed there as a fact rather than a verdict.
 *
 * Deliberately *not* checked: unknown load commands. Those are already surfaced
 * by `loadCommandName` as a number rather than a name, which is this project's
 * chosen line for "present but not understood", and listing them a second time
 * as abnormalities would grade an unfamiliar-but-valid command as damage.
 *
 * ## On the packing heuristic
 *
 * Entropy is a heuristic and is labelled as one. Printable text sits around
 * 4.5-5.2 bits per byte and compressed or encrypted data near 8, so the
 * threshold sits in the empty gap between them — but obfuscated-but-not-compressed
 * data lands above it, and a legitimately compressed string table would land
 * above it too. It says "look at this", never "this is packed".
 *
 * @param {object} f an `opener()` handle
 * @param {object} thin a `parseThin()` result
 * @param {object} [opts]
 * @param {number} [opts.sliceOffset=0] the slice's offset within the file
 * @param {number} [opts.sliceSize] the slice's size; defaults to the rest of the file
 * @returns {Array<{kind: string, detail: string}>}
 */
function detectAbnormalities(f, thin, { sliceOffset = 0, sliceSize = null } = {}) {
  const out = [];
  const sliceEnd = sliceSize == null ? f.size - sliceOffset : sliceSize;
  /**
   * Record one finding.
   *
   * `severity` is the distinction that lets this be used as a build gate rather
   * than only as a report, and it is drawn on one question: **can the reader's
   * answers still be trusted?**
   *
   *   `error`   — the file disagrees with itself. A size or an extent points at
   *               bytes that are not there, so anything computed from it may be
   *               wrong. A build should fail on these.
   *   `warning` — the file parsed and the answers are probably right, but
   *               something is unfamiliar (a flag or attribute bit this header
   *               does not name) or explicitly heuristic (the entropy probe).
   *
   * The two unfamiliar-bit checks are warnings rather than errors on purpose. A
   * binary built by a newer Xcode than this reader knows about sets a flag bit
   * that has no name yet, and failing a build over that would make the gate
   * useless within one toolchain release. The caller who wants the stricter
   * reading asks for it — `audit --strict` — and a gate that only ever fires on
   * genuine damage is a gate people leave switched on.
   */
  const add = (kind, detail, severity = 'error') => out.push({ kind, detail, severity });

  // Header flags this table cannot name. A real binary can set a bit added after
  // this reader was written, so the detail says "unrecognised" rather than
  // "corrupt" — it is a claim about the names, not about the file.
  const hdr = decodeHeaderFlags(thin.flags);
  if (hdr.unknown !== 0) {
    add(
      'unknown-header-flags',
      `header sets flag bits with no name in <mach-o/loader.h>: 0x${hdr.unknown.toString(16)}`,
      'warning',
    );
  }

  if (thin.loadCommands.length < thin.ncmds) {
    add(
      'load-commands-truncated',
      `header declares ${thin.ncmds} load command(s), only ${thin.loadCommands.length} were readable — ` +
        'the segment, section and symbol tables below may be incomplete',
    );
  }

  // Sections past the slice. Gated on `isBackedByFile`, which is what separates
  // "claims bytes that are not there" from "__bss legitimately occupies no bytes":
  // a zero-fill section carries a real address range and a `size` that can easily
  // exceed the file, and flagging it would be flagging every ordinary binary.
  for (const sec of thin.sections) {
    if (sec.size === 0) continue;
    if (!isBackedByFile(thin, sec)) continue;
    if (sec.offset + sec.size > sliceEnd) {
      add(
        'section-past-slice-end',
        `${sec.segname},${sec.sectname} claims bytes ${sec.offset}..${sec.offset + sec.size}, ` +
          `past the end of the slice at ${sliceEnd}`,
      );
    }
    if (sec.attributesUnknown !== 0) {
      add(
        'unknown-section-attributes',
        `${sec.segname},${sec.sectname} sets attribute bits with no name in <mach-o/loader.h>: ` +
          `0x${sec.attributesUnknown.toString(16)}`,
        'warning',
      );
    }
    if (sec.type.startsWith('S_UNKNOWN_')) {
      add(
        'unknown-section-type',
        `${sec.segname},${sec.sectname} has section type 0x${sec.typeRaw.toString(16)}, ` +
          'which <mach-o/loader.h> does not define',
        'warning',
      );
    }
  }

  for (const seg of thin.segments) {
    const hi = seg.fileoff + seg.filesize;
    if (hi > sliceEnd) {
      add(
        'segment-past-slice-end',
        `${seg.segname} claims file bytes ${seg.fileoff}..${hi}, past the end of the slice at ${sliceEnd}`,
      );
    }
  }

  const st = thin.symtab;
  if (st) {
    // The stride differs between `nlist` (12) and `nlist_64` (16), so it is taken
    // from the parse rather than written as a constant — the same trap that once
    // read every symbol in a 32-bit slice one entry off.
    const stride = thin.is64 ? 16 : 12;
    const symEnd = st.symoff + st.nsyms * stride;
    if (st.nsyms > 0 && symEnd > sliceEnd) {
      add(
        'symtab-past-slice-end',
        `LC_SYMTAB claims ${st.nsyms} symbol(s) in bytes ${st.symoff}..${symEnd}, ` +
          `past the end of the slice at ${sliceEnd}`,
      );
    }
    const strEnd = st.stroff + st.strsize;
    if (st.strsize > 0 && strEnd > sliceEnd) {
      add(
        'strtab-past-slice-end',
        `LC_SYMTAB claims a string table in bytes ${st.stroff}..${strEnd}, ` +
          `past the end of the slice at ${sliceEnd}`,
      );
    }
    if (st.nsyms > 0 && st.strsize > 0
      && st.symoff < strEnd && st.stroff < symEnd) {
      add(
        'symtab-strtab-overlap',
        `the symbol table (${st.symoff}..${symEnd}) and the string table (${st.stroff}..${strEnd}) ` +
          'overlap — no linker emits this, and a reader cannot trust either extent',
      );
    }
    if (st.strsize > 0) {
      const h = shannonEntropy(f, sliceOffset + st.stroff, st.strsize);
      if (h > PACKED_ENTROPY) {
        add(
          'strtab-high-entropy',
          `the string table averages ${h.toFixed(2)} bits/byte over its first ` +
            `${Math.min(st.strsize, 1 << 20)} bytes — above the ~6.4 threshold, ` +
            'so it may be compressed or obfuscated rather than plain text',
          'warning',
        );
      }
    }
  }

  return out;
}

/**
 * Structural problems with the *fat container* — the table of slices, rather than
 * anything inside a slice.
 *
 * ## Why this is separate from {@link detectAbnormalities}
 *
 * That function answers "does this slice hold together?", and every check in it is
 * about bytes reachable from one Mach-O header. None of them can see a slice that
 * overlaps its neighbour, because each slice is perfectly self-consistent in
 * isolation — two slices claiming the same file range are individually fine and
 * jointly a lie, and a per-slice check structurally cannot notice.
 *
 * So the fat table gets its own pass. It is small, and the three things that
 * matter are all cross-slice:
 *
 *   - **overlapping slices.** Two slices claiming the same bytes means a reader
 *     that maps an address through "the richest slice" can silently pick either,
 *     and which one it picked depends on symbol counts rather than on anything the
 *     file says. This is the check that most changes what a tool reports, because
 *     it makes an existing ambiguity *visible* rather than resolving it silently.
 *   - **a slice reaching past the end of the file.** Truncation, the usual cause.
 *   - **a misaligned slice offset.** dyld requires slices to start on a 16 KiB
 *     boundary. A file that violates it still parses — this reader reads slice
 *     offsets from the table rather than assuming them — so it is a warning about
 *     the producer, not a claim that the bytes are unreadable.
 *
 * Alignment is deliberately a *warning* and overlap a *error*, for the same
 * reason the unfamiliar-bit checks are warnings: only one of them means a reader's
 * answers cannot be trusted. A misaligned slice is read correctly by this reader
 * and by every other that reads the table; overlapping slices mean two different
 * answers are equally available.
 *
 * @param {object} f an `opener()` handle
 * @returns {Array<{kind: string, detail: string, severity: string}>} empty for a
 *   well-formed container, and also empty for a thin binary — a thin file has no
 *   fat table to be inconsistent with, and reporting nothing is the honest answer
 *   rather than reporting "0 slices".
 */
function detectContainerAbnormalities(f) {
  const out = [];
  const fat = parseFat(f);
  if (!fat) return out;
  const add = (kind, detail, severity = 'error') => out.push({ kind, detail, severity });

  for (const s of fat) {
    if (s.offset + s.size > f.size) {
      add(
        'slice-past-file-end',
        `the ${sliceArchName(s.cputype, s.cpusubtype)} slice claims bytes ${s.offset}..${s.offset + s.size}, ` +
          `past the end of a ${f.size}-byte file`,
      );
    }
    if (s.offset % FAT_SLICE_ALIGN !== 0) {
      add(
        'slice-misaligned',
        `the ${sliceArchName(s.cputype, s.cpusubtype)} slice starts at 0x${s.offset.toString(16)}, ` +
          `which is not a ${FAT_SLICE_ALIGN / 1024} KiB boundary — dyld requires alignment, ` +
          'so this file was not produced by a current linker',
        'warning',
      );
    }
  }

  // Overlap, by pairwise extent comparison rather than by sorting. A fat table has
  // a handful of slices, so the quadratic form is not worth optimising and keeps
  // the reporting order the same as the table's own order, which is what a reader
  // comparing two files wants to see.
  for (let i = 0; i < fat.length; i++) {
    for (let j = i + 1; j < fat.length; j++) {
      const a = fat[i];
      const b = fat[j];
      const lo = Math.max(a.offset, b.offset);
      const hi = Math.min(a.offset + a.size, b.offset + b.size);
      if (lo < hi) {
        add(
          'slices-overlap',
          `the ${sliceArchName(a.cputype, a.cpusubtype)} slice (${a.offset}..${a.offset + a.size}) and the ` +
            `${sliceArchName(b.cputype, b.cpusubtype)} slice (${b.offset}..${b.offset + b.size}) both claim ` +
            `bytes ${lo}..${hi} — which slice a reader used would change the answer`,
        );
      }
    }
  }

  return out;
}

/**
 * dyld's required alignment for a fat slice's starting offset: 2^14.
 *
 * A named constant rather than a literal at the use site, because the value is a
 * property of the loader's contract rather than of this check, and the next reader
 * to need it should not have to re-derive it.
 */
const FAT_SLICE_ALIGN = 1 << 14;

/**
 * Map a file offset to a vaddr within a parsed slice, or null if unmapped.
 * Used to turn a literal's file offset into the address a tool must cite.
 *
 * Zero-fill sections are skipped. They are listed first-and-foremost as sections
 * but have no bytes, so a file offset inside one belongs to whatever actually
 * occupies that range — usually the header. See `isBackedByFile`.
 */
function toVaddr(thin, fileOff) {
  for (const s of thin.sections) {
    if (!isBackedByFile(thin, s)) continue;
    if (fileOff >= s.offset && fileOff < s.offset + s.size) {
      return {
        vaddr: s.addr + BigInt(fileOff - s.offset),
        section: `${s.segname},${s.sectname}`,
      };
    }
  }
  for (const s of thin.segments) {
    if (fileOff >= Number(s.fileoff) && fileOff < Number(s.fileoff) + Number(s.filesize)) {
      return {
        vaddr: s.vmaddr + BigInt(fileOff - Number(s.fileoff)),
        section: `${s.segname} (segment)`,
      };
    }
  }
  return null;
}

/**
 * Map a vaddr to a file offset within a parsed slice, or null.
 *
 * The inverse of `toVaddr`, and the half that needs the zero-fill check more
 * urgently: `__bss` has an address and a size, so a vaddr inside it *looks*
 * mappable, but no byte of it exists in the file. Returned as
 * `{ zerofill: true }` rather than null, because "this address exists but is not
 * in the file" and "this address is not in this binary" are different answers
 * and a caller patching a file needs to tell them apart.
 *
 * Sections first, then segments, mirroring `toVaddr`: a section is the tighter
 * answer, and the segment range is what covers the padding between them.
 */
function toFileOffset(thin, vaddr) {
  for (const s of thin.sections) {
    if (vaddr < s.addr || vaddr >= s.addr + BigInt(s.size)) continue;
    if (!isBackedByFile(thin, s)) {
      return {
        offset: null,
        zerofill: true,
        section: `${s.segname},${s.sectname}`,
        segname: s.segname,
      };
    }
    return {
      offset: s.offset + Number(vaddr - s.addr),
      zerofill: false,
      section: `${s.segname},${s.sectname}`,
      segname: s.segname,
    };
  }
  for (const s of thin.segments) {
    if (vaddr < s.vmaddr || vaddr >= s.vmaddr + s.vmsize) continue;
    const delta = vaddr - s.vmaddr;
    // Past `filesize` the segment is mapped but absent from the file: the tail of
    // a `__DATA` that runs into `__bss`, or all of `__PAGEZERO`.
    if (delta >= s.filesize) {
      return {
        offset: null,
        zerofill: true,
        section: `${s.segname} (segment)`,
        segname: s.segname,
      };
    }
    return {
      offset: Number(s.fileoff) + Number(delta),
      zerofill: false,
      section: `${s.segname} (segment)`,
      segname: s.segname,
    };
  }
  return null;
}

/** The section containing a file offset, or null. */
function sectionOf(thin, fileOff) {
  return thin.sections.find(
    (s) => isBackedByFile(thin, s) && fileOff >= s.offset && fileOff < s.offset + s.size,
  ) || null;
}

/**
 * Find a byte string inside a section, stopping early per needle.
 *
 * Scoped to `__TEXT` rather than the whole file: literals live there, and a
 * whole-file sweep of a 476 MB universal binary is slow enough that tools end
 * up not being run. The `overlap` window carries a match that straddles a
 * chunk boundary, which a naive chunked scan silently drops.
 *
 * `sliceBase` is the slice's file offset within the file. A section's `offset`
 * is slice-relative, so on a universal binary this reads the wrong bytes without
 * it — see `scanSection` in `api.mjs` for the full account of how that stayed
 * hidden. Returns absolute file offsets and vaddrs.
 */
function findInSection(
  f,
  sec,
  needles,
  { perNeedle = 4, chunk = 1 << 24, overlap = 64, sliceBase = 0 } = {},
) {
  const found = new Map();
  if (!sec || sec.size === 0) return { hits: found, scanned: 0, available: false };
  const enc = needles.map((n) => Buffer.from(n, 'latin1'));
  const start = sliceBase + sec.offset;
  const end = start + sec.size;
  let pos = start;
  let carry = Buffer.alloc(0);
  let carryBase = start;
  let scanned = 0;

  while (pos < end) {
    const buf = f.read(pos, Math.min(chunk, end - pos));
    if (buf.length === 0) break;
    scanned += buf.length;
    const hay = Buffer.concat([carry, buf]);
    const base = carryBase;

    for (let i = 0; i < enc.length; i++) {
      const key = needles[i];
      const list = found.get(key) || [];
      if (list.length >= perNeedle) continue;
      let from = 0;
      while (list.length < perNeedle) {
        const at = hay.indexOf(enc[i], from);
        if (at < 0) break;
        const abs = base + at;
        const pre = hay.subarray(Math.max(0, at - 16), at);
        list.push({
          off: abs,
          vaddr: sec.addr + BigInt(abs - start),
          section: sec.sectname,
          ctx: pre.toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(-16),
        });
        from = at + 1;
      }
      found.set(key, list);
    }

    if (needles.every((n) => (found.get(n) || []).length >= perNeedle)) break;
    carry = hay.subarray(Math.max(0, hay.length - overlap));
    carryBase = base + hay.length - carry.length;
    pos += buf.length;
  }
  return { hits: found, scanned, available: true };
}


/* ================================================================== *
 * src/instruction.mjs
 * ================================================================== */

/**
 * disasm.mjs — instruction length decoding, branch target resolution, and
 * linear sweep, for ARM64 and x86_64 Mach-O slices.
 *
 *   node -e "import('./src/disasm.mjs').then(m => console.log(m.arm64Length(Buffer.alloc(4))))"
 *
 * ## Why this exists
 *
 * Every other tool in this package answers "where is the code" and stops there.
 * `findcall` reports sites *worth* disassembling. `findliteral` reports
 * pointers. Nothing answers "what does the code at this address do", because
 * nothing in this package has ever decoded an instruction.
 *
 * That boundary was deliberate — see `COMPETITIVE-LANDSCAPE.md` — and it is
 * still mostly right. But "we never decode instructions" is different from
 * "we cannot decode instructions". `findcall` can only ever report a
 * *candidate* caller, because it finds the bytes `e8 xx xx xx xx` and never
 * establishes that those five bytes start an instruction. This module is what
 * lets it say "and this is a real call edge" instead.
 *
 * ## Scope, and the line drawn around it
 *
 * This is NOT a disassembler in the usual sense. There is no operand decoding,
 * no mnemonic table, no control flow graph, no decompiler. It does exactly
 * three things:
 *
 *   1. `instructionLength` — how many bytes is the instruction at this address
 *   2. `branchTarget`     — where does this instruction branch to, if it does
 *   3. `linearSweep`      — apply 1 and 2 across a range, in address order
 *
 * The line is drawn at *what can be done correctly in a few hundred lines that a
 * reader can check*. A full disassembler is a large project with a large
 * surface for silent error; the length decoder is small, total, and testable
 * against an independent implementation of the same question (`findcall`).
 *
 * ## Why length decoding is the whole ballgame
 *
 * On ARM64 every instruction is 4 bytes, so a sweep is trivial and always
 * aligned. On x86_64 instruction length is variable and the decoder's job is to
 * find where each instruction *ends* so the next one can start in the right
 * place. Get one length wrong and every subsequent boundary in the sweep is
 * wrong too — the output stops being "somewhat wrong instructions" and becomes
 * "fabricated addresses".
 *
 * That is why this module is fussier about the x86_64 opcode table than the
 * feature strictly needs. A table with holes looks fine in a unit test with
 * three instructions in it and produces confident nonsense on a real binary.
 *
 * ## Known limits, stated rather than hidden
 *
 * ### Opcode-table gaps
 *
 *   - `0F 0F` (3DNow!) is decoded as ModRM-only; the trailing opcode byte and
 *     imm8 are not consumed, so the instruction is short by 2 bytes.
 *   - `0F 78`/`0F 79` (AMD `extrq`/`insertq`) take a variable imm16 that depends
 *     on the ModRM reg field; only the ModRM is consumed.
 *   - **EVEX (`0x62`) opcodes that take an imm8** are decoded as ModRM-only, so
 *     they come out 1 byte short. `vpternlogd` (`25`), `vcmpps` (`c2`), `vshufps`
 *     (`c6`), `vpalignr` under `0F3A` and about a dozen others are affected. The
 *     immediate's presence is a property of the *opcode*, and unlike the `0F 3A`
 *     map there is no bit in the prefix that announces it — EVEX carries the map
 *     in P2 bits [2:0] and nothing else that means "an imm8 follows". Encoding
 *     this would need a per-opcode EVEX table, guessed at from documentation
 *     rather than checked against a compiler, and a wrong entry there produces
 *     the same confident 1-byte error as no entry at all. Left as a stated gap
 *     instead.
 *   - No support for `APX` (0xD5).
 *
 * All four are *length* errors, and all four are AVX-512-era or AMD-only. That
 * bounds the practical damage: Apple's own arm64e code contains none of them, and
 * macOS x86_64 system binaries use EVEX only incidentally. On a binary that does
 * use them, the effect is the desynchronisation described next, starting at that
 * instruction — not a fabricated address, because every length error here is
 * short rather than long.
 *
 * Each is a *length* error, so each can desynchronise a sweep that walks into
 * one. They are listed here because a documented limit is one a caller can
 * check for, and an undocumented one is a wrong answer.
 *
 * ### Linear sweep loses sync on embedded data — measured, not assumed
 *
 * `__text` is not only code. It also carries jump tables, and a 4-byte jump
 * table entry is indistinguishable from a 4-byte instruction to a decoder that
 * has no types. A linear sweep therefore walks into one and every boundary
 * after it is shifted.
 *
 * This was measured rather than assumed, on `/usr/lib/dyld` (x86_64 slice,
 * 606,251 bytes of `__TEXT,__text`, 3,346 defined symbols):
 *
 *   - sweeping the **whole section** puts an instruction boundary on 3,045 of
 *     3,346 symbols (91.0%);
 *   - sweeping **from each symbol to the next** covers the span exactly, with
 *     no gaps, in **3,196 of 3,196** cases.
 *
 * The second number is the one that says the length decoder is right: started at
 * a known instruction boundary, it consumes every byte up to the next known
 * boundary exactly. The first number says the sweep is not a *discovery* tool —
 * it needs a starting point it can trust.
 *
 * The practical consequence, and the reason `linearSweep` takes a `start`:
 * sweeping a whole section is fine for *coverage* — every byte is classified —
 * but not for locating anything. Sweep from a symbol, a `findcall` site, or an
 * address you already have. This is the same relationship recursive descent has
 * with entry points, arrived at from the other direction.
 */

/* ================================================================== *
 * ARM64 (A64)
 * ================================================================== */

/**
 * Length of the A64 instruction at `offset`. Always 4.
 *
 * This is not a shortcut — it is the architecture. A64 has no variable-length
 * instructions, so a "length decoder" for ARM64 is the constant 4 or an error
 * at the end of the buffer. The function exists so that callers have one
 * `instructionLength` to call regardless of slice architecture, and so that the
 * asymmetry with x86_64 is visible in the code rather than in a comment.
 *
 * @returns {number|null} 4, or null when fewer than 4 bytes remain.
 */
function arm64Length(bytes, offset = 0) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return 4;
}

/**
 * Decode the A64 instruction at `offset` as a PC-relative branch.
 *
 * `pc` is the address of the instruction *itself* — not of `bytes[0]` — because
 * every A64 PC-relative branch is expressed relative to the instruction's own
 * address, and conflating the two produces targets that are wrong by exactly the
 * distance between the buffer and the instruction. Callers that pass a window
 * starting before the instruction will silently get wrong answers, which is why
 * every call site in this file passes an `addr` it has already added.
 *
 * ## The encodings, from the ARM Architecture Reference Manual
 *
 * All nine are `imm`-based PC-relative forms whose displacement is scaled and
 * then added to the instruction address:
 *
 *   B     imm26      26 bits, scaled x4   ±128 MB
 *   BL    imm26      26 bits, scaled x4   ±128 MB
 *   B.cond imm19     19 bits, scaled x4   ±1 MB
 *   CBZ   imm19      19 bits, scaled x4   ±1 MB
 *   CBNZ  imm19      19 bits, scaled x4   ±1 MB
 *   TBZ   imm14      14 bits, scaled x4   ±32 KB
 *   TBNZ  imm14      14 bits, scaled x4   ±32 KB
 *   ADR   imm21      21 bits, unscaled   ±1 MB, byte granularity
 *   ADRP  imm21      21 bits, shifted x12 page granularity
 *
 * The scale factors are the reason these cannot share one code path with x86:
 * ADR is *unscaled*, every other form is x4, and ADRP is a page-relative
 * encode-decode pair rather than an addition. Collapsing them into one helper
 * would mean a table of "which form has which scale", which is less code than
 * the explicit forms and much less checkable.
 *
 * @returns {{target: bigint, kind: string}|null} null when not a branch.
 */
function arm64BranchTarget(bytes, pc, offset = 0) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const insn = bytes.readUInt32LE(offset);

  /**
   * Does this instruction match `mask`/`value`?
   *
   * The `>>> 0` is not cosmetic, and without it the failure is silent and total
   * for half the instruction set. JavaScript's bitwise operators coerce both
   * operands to **signed** 32-bit, so for a `BL` (0x94…, bit 31 set) the
   * expression `insn & 0xfc000000` yields a negative number, which never equals
   * the positive literal `0x94000000`. Every encoding that sets bit 31 therefore
   * fails to match — which is `BL`, `ADRP`, and every `CBZ`/`CBNZ`/`TBZ`/`TBNZ`
   * on an X register — while `B`, `B.cond` and the W-register forms work fine and
   * look entirely healthy in a spot check.
   *
   * The `>>> 0` in `test/fixtures.mjs`'s encoder is the same hazard approached
   * from the writing side, and is commented there for the same reason.
   */
  const is = (mask, value) => ((insn & mask) >>> 0) === value;

  /** Sign-extend a `bits`-wide field taken from bit 0 upwards. */
  const sext = (v, bits) => {
    const sign = 1 << (bits - 1);
    return (v & (sign - 1)) - (v & sign);
  };

  // BL: 100101 imm26 — branch with link, i.e. the call instruction.
  if (is(0xfc000000, 0x94000000)) {
    return { target: pc + BigInt(sext(insn & 0x03ffffff, 26) * 4), kind: 'BL' };
  }
  // B: 000101 imm26
  if (is(0xfc000000, 0x14000000)) {
    return { target: pc + BigInt(sext(insn & 0x03ffffff, 26) * 4), kind: 'B' };
  }
  // B.cond: 0101010 imm19 0 cond. Bit 4 is fixed at 0, which is what separates
  // B.cond from the system-branch space that shares the top 8 bits.
  if (is(0xff000010, 0x54000000)) {
    return { target: pc + BigInt(sext((insn >>> 5) & 0x7ffff, 19) * 4), kind: 'B.cond' };
  }
  // CBZ/CBNZ on W and X registers: `sf op 0110100 imm19 Rt`.
  // CBNZ W is 0x35 and CBZ X is 0xb4, so both the `sf` bit and the `op` bit
  // have to be inside the mask: with 0x7e000000 — the obvious choice, masking
  // the top 7 bits — `op` falls outside it, CBZ and CBNZ land on the same
  // value, and every conditional branch in the binary is reported as `CBZ`.
  // The mask is 0x7f000000 for that reason, and not for tidiness.
  if (is(0x7f000000, 0x34000000) || is(0x7f000000, 0x35000000)) {
    return {
      target: pc + BigInt(sext((insn >>> 5) & 0x7ffff, 19) * 4),
      kind: is(0x7f000000, 0x35000000) ? 'CBNZ' : 'CBZ',
    };
  }
  // TBZ/TBNZ on W and X registers: `sf op 0110110 imm14 b5 0 Rt`. The `op` bit
  // is bit 24 here too, so the same mask separates TBZ (0x36 from w0, 0xb6 from
  // x0) from TBNZ (0x37 from w0, 0xb7 from x0). `imm14` occupies the same bits
  // [18:5] that `imm19` does above; only the field width differs, so the range
  // is a quarter of CBZ's at ±32 KB.
  if (is(0x7f000000, 0x36000000) || is(0x7f000000, 0x37000000)) {
    return {
      target: pc + BigInt(sext((insn >>> 5) & 0x3fff, 14) * 4),
      kind: is(0x7f000000, 0x37000000) ? 'TBNZ' : 'TBZ',
    };
  }
  // ADR: 0 immlo 10000 immhi Rd
  if (is(0x9f000000, 0x10000000)) {
    const imm = sext((((insn >>> 5) & 0x7ffff) << 2) | ((insn >>> 29) & 0x3), 21);
    // Unscaled: ADR names a byte address, so there is no << 2 here.
    return { target: pc + BigInt(imm), kind: 'ADR' };
  }
  // ADRP: 1 immlo 10000 immhi Rd — the same field layout, bit 31 set.
  if (is(0x9f000000, 0x90000000)) {
    const imm = sext((((insn >>> 5) & 0x7ffff) << 2) | ((insn >>> 29) & 0x3), 21);
    // Page-relative encode-decode: the page base is the instruction's own page,
    // and the displacement is in pages. Adding the shifted immediate to the
    // unshifted instruction address would be wrong in two independent ways.
    return { target: (pc & ~0xfffn) + (BigInt(imm) << 12n), kind: 'ADRP' };
  }
  return null;
}

/* ================================================================== *
 * x86_64
 * ================================================================== */

/**
 * Category codes for the one-byte opcode map. One character each so the table
 * below reads as the Intel opcode map it is transcribed from, rather than as
 * 256 prose descriptions.
 *
 *   n    no ModRM byte, no immediate
 *   m    ModRM byte, no immediate
 *   i8   imm8
 *   i16  imm16
 *   iz   imm16 under an operand-size prefix, else imm32
 *   iv   imm16 under 0x66, imm64 under REX.W, else imm32
 *   i32  imm32 always (rel32 displacements)
 *   o    address-size-dependent memory offset: 8 bytes, or 4 under 0x67
 *   ii   imm16 then imm8 (ENTER)
 *   g    ModRM byte, immediate decided by the ModRM reg field
 *
 * The single-letter codes are load-bearing in one specific way: `m` is the
 * marker for "this opcode has a ModRM byte", detected as `cat[0] === 'm'`. A
 * bare category that happens to start with `m` is therefore read as ModRM-
 * bearing and loses its ModRM byte's worth of length, which is why the memory
 * offset code is `o` rather than the more obvious `moff`.
 */
const N = 'n', M = 'm', I8 = 'i8', I16 = 'i16', IZ = 'iz', IV = 'iv', I32 = 'i32',
  MOFF = 'o', II = 'ii', G = 'g';

/** Fill `[lo, hi]` inclusive with one category. */
function fill(table, lo, hi, cat) {
  for (let i = lo; i <= hi; i++) table[i] = cat;
}

/**
 * One-byte opcode map: opcode byte -> category.
 *
 * Transcribed from Intel SDM Vol. 2 Table 2-2, restricted to 64-bit mode. The
 * two deviations from the printed table are both deliberate:
 *
 *   - `0x06`, `0x07`, `0x0e`, `0x16`, `0x17`, `0x1e`, `0x1f`, `0x27`, `0x2f`,
 *     `0x37`, `0x3f`, `0x60`, `0x61`, `0x82`, `0x9a`, `0xc4`, `0xc5`, `0xce`,
 *     `0xd4`, `0xd5`, `0xd6`, `0xea` are invalid in 64-bit mode. They are
 *     mapped as if they existed rather than flagged invalid, because a sweep
 *     that has lost alignment will land on them, and a decoder that returns
 *     "invalid" there would make the sweep restart every byte and report
 *     nothing at all. Their *length* is what the sweep needs; it is not
 *     checking validity.
 *   - `0x0f`, `0x27`… are handled before this table is consulted.
 */
const ONE_BYTE = (() => {
  const t = new Array(256).fill(N);
  // ALU groups: six opcodes each, "Eb,Gb / Ev,Gv / Gb,Eb / Gv,Ev / AL,Ib / eAX,Iz".
  for (const base of [0x00, 0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38]) {
    fill(t, base, base + 3, M);
    t[base + 4] = I8;
    t[base + 5] = IZ;
  }
  fill(t, 0x62, 0x63, M);           // 0x62 is EVEX; 0x63 MOVSXD
  t[0x68] = IZ; t[0x69] = 'm' + IZ; t[0x6a] = I8; t[0x6b] = 'm' + I8;
  fill(t, 0x70, 0x7f, I8);          // Jcc rel8
  fill(t, 0x80, 0x83, 'm' + I8);
  t[0x81] = 'm' + IZ;
  fill(t, 0x84, 0x8f, M);           // 0x8f POP Ev is ModRM-bearing despite the /0
  fill(t, 0xa0, 0xa3, MOFF);        // MOV AL/eAX, moffs
  t[0xa8] = I8; t[0xa9] = IZ;
  fill(t, 0xb0, 0xb7, I8);          // MOV r8, imm8
  fill(t, 0xb8, 0xbf, IV);          // MOV r, imm16/32/64
  t[0xc0] = 'm' + I8; t[0xc1] = 'm' + I8;
  t[0xc2] = I16; t[0xc3] = N;
  t[0xc6] = G; t[0xc7] = G;        // MOV Eb/Ev, imm — imm only for /0
  t[0xc8] = II;                     // ENTER imm16, imm8
  fill(t, 0xd0, 0xd3, M);           // shifts by 1 / by CL
  t[0xd4] = I8; t[0xd5] = I8;       // AAM/AAD, invalid in 64-bit
  fill(t, 0xd8, 0xdf, M);           // x87
  fill(t, 0xe0, 0xe7, I8);          // LOOP/JRCXZ/IN/OUT imm8
  t[0xe8] = I32; t[0xe9] = I32;     // CALL rel32, JMP rel32
  t[0xeb] = I8;                     // JMP rel8
  t[0xf6] = G; t[0xf7] = G;         // group 3 — TEST takes an immediate
  fill(t, 0xfe, 0xff, M);           // group 4/5
  return t;
})();

/**
 * Two-byte opcode map (`0F xx`): second byte -> category.
 *
 * Defaults to `m` rather than `n` because almost every `0F` opcode has a ModRM
 * byte, and a table that defaults to "no ModRM" turns every omission into a
 * silent length error. The no-ModRM entries are therefore listed explicitly,
 * which also makes them auditable — an entry here is a claim, not a default.
 *
 * `0F 80`-`0F 8F` are `i32` with no ModRM: Jcc rel32. Getting that wrong is the
 * single most common way a two-byte decoder desynchronises, because it turns a
 * 6-byte instruction into a 2-byte one.
 */
const TWO_BYTE = (() => {
  const t = new Array(256).fill(M);
  for (const b of [
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0b, 0x0e, 0x30, 0x31, 0x32, 0x33, 0x34,
    0x35, 0x37, 0x77, 0xa0, 0xa1, 0xa2, 0xa8, 0xa9, 0xaa,
  ]) t[b] = N;
  fill(t, 0xc8, 0xcf, N);           // BSWAP
  fill(t, 0x80, 0x8f, I32);         // Jcc rel32, no ModRM
  t[0x70] = 'm' + I8; t[0x71] = 'm' + I8; t[0x72] = 'm' + I8; t[0x73] = 'm' + I8;
  t[0xa4] = 'm' + I8; t[0xa5] = 'm' + IZ;   // SHLD
  t[0xac] = 'm' + I8; t[0xad] = 'm' + IZ;   // SHRD
  t[0xba] = G;                      // group 8 — BT/BTS imm8 for /4-/7
  t[0xc2] = 'm' + I8;               // CMPPS
  return t;
})();

/**
 * Immediate width for the group opcodes whose immediate depends on the ModRM
 * `reg` field, which is how the ISA signals which member of a group is meant.
 *
 * Only five opcodes are in this category: `C6`/`C7` (MOV, immediate for /0
 * only), `F6`/`F7` (group 3, immediate for TEST /0 and /1 only) and `0F BA`
 * (group 8, immediate for /4-/7). Every other group opcode has either an
 * immediate for all members or for none, and is expressed in the tables above.
 *
 * `0xBA` is the two-byte `0F BA`; it needs no separate table because the
 * dispatch is on the opcode byte itself and `0xBA` appears exactly once.
 *
 * Returning `0` rather than a size means "ModRM only", which is the correct
 * answer for the non-immediate members and the reason a decoder must consult
 * the ModRM byte *before* deciding the immediate.
 */
function groupImmediateSize(op, reg, operandSize) {
  switch (op) {
    case 0xc6: return reg === 0 ? 1 : 0;
    case 0xc7: return reg === 0 ? (operandSize === 16 ? 2 : 4) : 0;
    case 0xf6: return reg <= 1 ? 1 : 0;
    case 0xf7: return reg <= 1 ? (operandSize === 16 ? 2 : 4) : 0;
    case 0xba: return reg >= 4 && reg <= 7 ? 1 : 0;
    default: return 0;
  }
}

/** Legacy prefixes legal in 64-bit mode. Set, because it is consulted per byte. */
const LEGACY_PREFIXES = new Set([
  0xf0, // LOCK
  0xf2, // REPNE
  0xf3, // REP/REPE
  0x2e, 0x36, 0x3e, 0x26, // CS SS DS ES segment overrides
  0x64, 0x65, // FS GS segment overrides
  0x66, // operand size
  0x67, // address size
]);

/** Map selector, so the immediate rules for `0F 38`/`0F 3A` are explicit. */
const MAP_0F38 = 3, MAP_0F3A = 4;

/**
 * Decode one x86_64 instruction far enough to know its length and, if it is a
 * branch, where it goes.
 *
 * ## Why one function and not two
 *
 * The obvious design is a length decoder plus a separate branch decoder, both
 * walking the same prefixes and opcode. That is how the two can disagree: the
 * length decoder can count `0F 8x` as ModRM-bearing and the branch decoder as
 * not, or the branch decoder can forget that a `66` prefix shifts the immediate,
 * and the result is a target computed from a different instruction length than
 * the one the sweep advanced by. A branch target that is off by the prefix bytes
 * is not a rounding error — it is a fabricated address in the output.
 *
 * So there is one walk, and it returns both facts from the same parse. Every
 * exported per-architecture function below is a thin projection of this.
 *
 * ## The walk
 *
 *   prefixes (legacy, then REX) -> opcode (1-3 bytes, or VEX/EVEX)
 *     -> ModRM -> SIB -> displacement -> immediate(s)
 *
 * Two prefix rules are easy to get wrong and are handled explicitly:
 *
 *   - A legacy prefix *after* REX is ignored for decoding, but still part of the
 *     instruction. REX must be immediately before the opcode. `rexSeen` gates
 *     the prefix effects rather than the prefix bytes, which is what makes
 *     `48 66 89 c0` (MOV rax,rax) differ from `66 48 89 c0` — same bytes, and
 *     the SDM says the second one has the 0x66 ignored.
 *   - At most 15 bytes of prefix. Past that the byte is not a prefix, it is an
 *     opcode, and an unbounded prefix loop will happily consume the entire rest
 *     of a section while looking for one that never comes.
 *
 * @param {Buffer} bytes  the instruction and whatever follows it, for lookahead
 * @param {number} offset index of the instruction's first byte in `bytes`
 * @returns {{length:number, kind:string|null, rel:bigint|null}|null}
 *   `length` counts from `offset`. `rel` is a branch displacement measured from
 *   the end of the instruction and is null when `kind` is. Null overall only
 *   when the buffer ends inside the instruction: there is no such thing as an
 *   invalid x86-64 instruction to reject.
 */
function decodeX86(bytes, offset) {
  const end = bytes.length;
  if (offset < 0 || offset >= end) return null;

  let pos = offset;
  let op66 = false, addr67 = false, rex = 0, rexSeen = false;
  let prefixBytes = 0;

  // ---- prefixes -----------------------------------------------------
  for (;;) {
    if (pos >= end || prefixBytes >= 15) break;
    const b = bytes[pos];
    if (LEGACY_PREFIXES.has(b)) {
      // Ignored if a REX has already been seen, per the REX-must-be-last rule.
      if (!rexSeen) {
        if (b === 0x66) op66 = true;
        else if (b === 0x67) addr67 = true;
      }
      pos++; prefixBytes++;
      continue;
    }
    if (b >= 0x40 && b <= 0x4f) {
      rex = b;
      rexSeen = true;
      pos++; prefixBytes++;
      continue;
    }
    break;
  }
  const operandSize = (rex & 0x08) ? 64 : (op66 ? 16 : 32);
  const addressSize = addr67 ? 32 : 64;

  // ---- opcode -------------------------------------------------------
  // The buffer can end after the prefixes: a section's last few bytes, or the
  // short window a sweep hands over when fewer than 15 bytes remain. Reading
  // `bytes[pos]` there yields `undefined`, `ONE_BYTE[undefined]` is `undefined`,
  // and `cat[0]` throws. So a truncated tail was a crash rather than a null, and
  // it surfaced as a stack trace from inside a sweep on a real binary — on the
  // *last* section read, which is the one place a caller is least likely to look
  // for a length failure.
  if (pos >= end) return null;
  let op = bytes[pos++];
  let op2 = -1;
  let map = 1;
  // VEX/EVEX: 0 = none. The escape bytes 0xC4/0xC5/0x62 are *not* LES/LDS/
  // BOUND in 64-bit mode — that reassignment is the most consequential
  // difference between decoding 32-bit and 64-bit code, and a decoder that
  // treats them as the legacy instructions will desynchronise within a few
  // instructions of the first AVX instruction in the function.
  let vexBytes = 0;
  let vexPp = 0;
  if (op === 0xc5) {
    vexBytes = 2;
    if (pos + 1 > end) return null;
    vexPp = bytes[pos] & 0x03;
    pos += 1;
    op = bytes[pos++];
    map = vexPp + 1;                 // pp 1/2/3 -> 0F / 0F38 / 0F3A
  } else if (op === 0xc4) {
    vexBytes = 3;
    // Three payload bytes follow `0xc4`, not two: the 3-byte form exists precisely
    // because the five-bit opcode-map field (`mmmmmm`) is real rather than implied,
    // so `C4 P0 P1 P2 opcode modrm`. Consuming two puts `P2` where the opcode
    // belongs and the *opcode* where the ModRM belongs, which makes every 3-byte
    // VEX instruction come out exactly one byte short — and, worse, one the
    // length looks individually plausible for. The 2-byte `0xc5` form genuinely
    // has only one payload byte, so it must not be "fixed" the same way.
    if (pos + 3 > end) return null;
    vexPp = bytes[pos + 1] & 0x03;
    pos += 3;
    op = bytes[pos++];
    map = vexPp + 1;
  } else if (op === 0x62) {
    vexBytes = 4;
    if (pos + 3 > end) return null;
    // EVEX carries the opcode map in P2 bits [2:0]; 3 means an imm8 follows.
    vexPp = bytes[pos + 2] & 0x07;
    pos += 3;
    op = bytes[pos++];
    map = vexPp + 1;
  } else if (op === 0x0f) {
    if (pos >= end) return null;
    map = 2;                         // the 0F escape selects the two-byte map
    op2 = bytes[pos++];
    if (op2 === 0x38 || op2 === 0x3a) {
      map = op2 === 0x38 ? MAP_0F38 : MAP_0F3A;
      if (pos >= end) return null;
      op = bytes[pos++];
      op2 = -1;
    }
  }

  // ---- ModRM, SIB, displacement, immediate ---------------------------
  // `cat` is the category code from the maps above; `hasModrm`/`immSizes` are
  // derived from it. Doing the derivation in one place is what keeps the
  // length and the branch target from drifting apart.
  let cat;
  if (vexBytes) {
    // Every VEX/EVEX-encoded instruction has a ModRM byte, and the only map
    // that takes an immediate is 0F3A.
    cat = map === 4 ? M + I8 : M;
  } else if (map === 1) {
    cat = ONE_BYTE[op];
  } else if (map === 2) {
    cat = TWO_BYTE[op2];
  } else if (map === MAP_0F38) {
    cat = M;
  } else {
    cat = M + I8;                    // 0F 3A xx — always ModRM + imm8
  }

  // `g` counts as ModRM-bearing. It is the one category that carries a ModRM
  // without starting with `m`, because the letter `m` is taken by the ModRM-free
  // prefix used to build the combined entries. Testing only `cat[0] === M` here
  // silently drops the ModRM byte for C6/C7/F6/F7/0F BA, every one of which is
  // an immediate-bearing group instruction, so each loses 1-5 bytes.
  const hasModrm = cat[0] === M || cat === G;
  let reg = 0;
  if (hasModrm) {
    if (pos >= end) return null;
    const modrm = bytes[pos++];
    const mod = modrm >> 6;
    const rm = modrm & 0x07;
    reg = (modrm >> 3) & 0x07;

    // Displacement. Two of the four `mod` values do not mean what they look
    // like, and both of them are the common cases in 64-bit code rather than
    // the exotic ones — which is why getting them wrong desynchronises a sweep
    // almost immediately and why this is spelled out rather than compressed
    // into a lookup:
    //
    //   mod=00 rm=101  RIP-relative disp32. In 64-bit mode this is *the* normal
    //                  way to reach memory: every global access, every call
    //                  through a GOT slot, every PLT stub (`ff 25` = `jmp
    //                  *disp(%rip)`, 6 bytes). Reading it as "no displacement"
    //                  makes every such instruction 4 bytes too short.
    //   mod=00 rm=100 + SIB base=101  disp32 with no base register.
    //
    // Note the second has no `rip` and the first has no SIB byte at all, so the
    // SIB test must come first: with rm=100 the ModRM field means "a SIB
    // follows", and only that SIB's base field can mean "no base register".
    let sibBase = -1;
    if (mod !== 3 && rm === 4) {
      if (pos >= end) return null;
      const sib = bytes[pos++];
      sibBase = sib & 0x07;
      if (mod === 0 && sibBase === 5) pos += 4;
    } else if (mod === 0 && rm === 5) {
      pos += 4;
    }
    if (mod === 1) pos += 1;
    else if (mod === 2) pos += 4;
    // mod = 00 with rm = 000/001/010/011/110/111 is a base register and
    // contributes no displacement. mod = 11 is register-direct, likewise.
  }

  // Immediate. The order matters: `groupImmediateSize` needs `reg`, which is
  // only known once the ModRM has been read.
  let immSizes = 0;
  let immStart = -1;
  if (cat === G) {
    // For a two-byte group opcode the byte to dispatch on is `op2`: `op` is
    // still the 0x0F escape, so switching on it matches nothing and the
    // immediate is dropped. That silently costs `0F BA` (BT/BTS/BTR/BTC with an
    // immediate) its imm8.
    immSizes = groupImmediateSize(map === 2 ? op2 : op, reg, operandSize);
    if (immSizes) { immStart = pos; pos += immSizes; }
  } else if (cat === II) {
    immStart = pos;
    pos += 3;                        // imm16 then imm8, as one fixed group
  } else {
    // The immediate category is the whole code when there is no ModRM marker and
    // everything after it when there is. Reading it as "cat minus its first
    // character" unconditionally is what a bare `i32` — `CALL rel32` — turns
    // into `'32'`, which matches no branch below, so the immediate is never
    // recorded and the branch target is then read from offset -1.
    const immCat = hasModrm ? cat.slice(1) : cat;
    if (immCat) {
      const immAt = pos;
      if (immCat === I8) pos += 1;
      else if (immCat === I16) pos += 2;
      else if (immCat === I32) pos += 4;
      else if (immCat === IZ) pos += operandSize === 16 ? 2 : 4;
      else if (immCat === IV) pos += operandSize === 16 ? 2 : (operandSize === 64 ? 8 : 4);
      else if (immCat === MOFF) pos += addressSize === 32 ? 4 : 8;
      if (pos > immAt) { immStart = immAt; immSizes = pos - immAt; }
    }
  }

  // The architecture caps an instruction at 15 bytes. Exceeding that means the
  // bytes are not an instruction, so null is the honest answer — and a sweep
  // that stops here has stopped on garbage rather than skipped over it.
  if (pos > end) return null;        // buffer ended inside the instruction
  const length = pos - offset;
  if (length > 15) return null;

  // ---- branch ---------------------------------------------------------
  // Computed from the *total* length, so a target is correct under any prefix
  // combination without this function needing to know what those prefixes were.
  let kind = null;
  if (!vexBytes) {
    if (map === 1) {
      if (op === 0xe8) kind = 'CALL';
      else if (op === 0xe9 || op === 0xeb) kind = 'JMP';
      else if (op >= 0x70 && op <= 0x7f) kind = 'Jcc';
      else if (op >= 0xe0 && op <= 0xe2) kind = 'LOOP';
      else if (op === 0xe3) kind = 'JRCXZ';
    } else if (map === 2 && op2 >= 0x80 && op2 <= 0x8f) {
      kind = 'Jcc';
    }
  }
  // A branch with no recorded immediate is impossible in the printed opcode map,
  // so reaching it means a table entry says "no immediate" for an opcode that
  // has one. The length is still believed; the branch is dropped rather than
  // read from a bogus offset, because a wrong target is a fabricated address and
  // a missing one is a gap the caller can see.
  if (!kind || immStart < 0) return { length, kind: null, rel: null };

  // `rel` is measured from the end of the instruction, so it carries no address
  // of its own. Callers add `pc + offset`. Keeping the base out of here is what
  // lets `x86_64Length` and `x86_64BranchTarget` share one parse.
  const raw = immSizes === 1
    ? BigInt(bytes.readInt8(immStart))
    : BigInt(bytes.readInt32LE(immStart));
  return { length, kind, rel: BigInt(length) + raw };
}

/**
 * Length of the x86_64 instruction at `offset`, in bytes, or null if the buffer
 * ends inside it.
 */
function x86_64Length(bytes, offset = 0) {
  const d = decodeX86(bytes, offset);
  return d ? d.length : null;
}

/**
 * Branch target of the x86_64 instruction at `offset`, relative to `pc`.
 *
 * `pc` is the address of the instruction, for the same reason as in
 * `arm64BranchTarget`. Returns `{ target, kind }` with a BigInt target, or null
 * when the instruction is not a direct relative branch.
 *
 * Direct relative branches only. `call [rip+disp]`, `call rax`, `jmp [rip+disp]`
 * and `jmp *rax` are not reported: the first two do not encode a target at all,
 * and the RIP-relative ones do not name a destination code address. Reporting
 * the *contents* of a RIP-relative slot would require reading a pointer and
 * deciding whether it is code, which is `mapliteral`'s job and not this one's.
 */
function x86_64BranchTarget(bytes, pc, offset = 0) {
  const d = decodeX86(bytes, offset);
  if (!d || !d.kind) return null;
  return { target: pc + BigInt(offset) + d.rel, kind: d.kind };
}

/* ================================================================== *
 * Architecture dispatch
 * ================================================================== */

/**
 * Architectures whose instruction encoding this module knows.
 *
 * Reported rather than assumed. A caller that sweeps a slice whose architecture
 * is not in this list must be told "cannot decode", not handed an empty list —
 * the project's rule is that a negative answer has to be distinguishable from a
 * tool that did not run. `arm64e` is `arm64` with extra capability bits on the
 * same base encoding, so it decodes; `arm64_32` is 32-bit pointers under a
 * different ABI and is deliberately not treated as a synonym.
 */
function supportedArch(arch) {
  return archMatches(String(arch), 'arm64') || archMatches(String(arch), 'x86_64');
}

/**
 * Length of the instruction at `offset` for `arch`, or null if unknown or
 * truncated.
 */
function instructionLength(arch, bytes, offset = 0) {
  if (archMatches(String(arch), 'arm64')) return arm64Length(bytes, offset);
  if (archMatches(String(arch), 'x86_64')) return x86_64Length(bytes, offset);
  return null;
}

/**
 * Branch target of the instruction at `offset` for `arch`, or null.
 */
function branchTarget(arch, bytes, pc, offset = 0) {
  if (archMatches(String(arch), 'arm64')) return arm64BranchTarget(bytes, pc, offset);
  if (archMatches(String(arch), 'x86_64')) return x86_64BranchTarget(bytes, pc, offset);
  return null;
}

/* ================================================================== *
 * Linear sweep
 * ================================================================== */

/**
 * Windows larger than this are not needed: the longest x86_64 instruction is 15
 * bytes, so this is a one-instruction lookahead with enormous slack, and the
 * only cost of a small window is more `read` calls on a small section.
 */
const READ_AHEAD = 16;

/**
 * Linear sweep over a byte range: decode one instruction, record it, advance by
 * its length, repeat.
 *
 * `f` is an open handle, `sec` a section record, `sliceBase` the slice's file
 * offset. All three are required and none may be defaulted: a section's `offset`
 * is relative to its slice, so on a fat binary omitting `sliceBase` reads the
 * right number of bytes from the wrong place — the same class of bug
 * `scanSection`'s comment describes.
 *
 * ## Why linear sweep and not recursive descent
 *
 * Recursive descent follows control flow from known entry points and so never
 * decodes data as code. That is strictly better *when you know the entry points*.
 * On a stripped binary you often do not, and the usual answer — sweep
 * everything — is what recursive descent would do anyway, without its ability
 * to stop when it goes wrong.
 *
 * ## What it guarantees, and what it does not
 *
 * It guarantees **coverage**: every byte of the range is consumed by exactly one
 * instruction record, so no address is silently skipped and the sum of the
 * lengths always equals the span.
 *
 * It does not guarantee that every record is *code*. A `__text` section carries
 * jump tables and alignment padding, and a linear sweep decodes those as
 * instructions — then stays out of step for the rest of the section, because one
 * wrong boundary makes the next one wrong too. On `dyld` that is the difference
 * between 91% of symbols being instruction boundaries when the whole section is
 * swept from its start, and 100% when each is swept from its own start. See the
 * measurement in this file's header.
 *
 * So the sweep needs a `start` it can trust, which is why `start` is a
 * parameter rather than something derived. A whole-section sweep is a coverage
 * report; a sweep from a symbol is a decoding.
 *
 * ## Chunking
 *
 * The range is read in windows and a window is re-read whenever fewer than 15
 * usable bytes remain after `pos`, because an instruction may straddle the end
 * of a window. The first version advanced `pos` by the window length, which
 * dropped any instruction straddling a boundary *and* then re-decoded the bytes
 * after it from the wrong position — on a large section, quietly.
 *
 * @returns {Array<{addr: bigint, bytes: Buffer, length: number, kind: string|null,
 *   target: bigint|null}>} `max` stops the sweep at that many instructions.
 */
function linearSweep(f, sec, arch, sliceBase, { start = 0, end = sec.size, max = 0 } = {}) {
  const out = [];
  const stride = archMatches(String(arch), 'arm64') ? 4 : 0;
  const WINDOW = 1 << 16;
  const limit = Math.min(end, sec.size);

  let pos = Math.max(0, start);
  let buf = Buffer.alloc(0);
  let bufAt = pos;                     // section-relative offset of buf[0]

  // The window is bounded by the end of the *section*, not the end of the
  // requested range. An instruction that begins inside `range` can extend past
  // it, and its length cannot be determined without those bytes — so reading
  // only up to `limit` makes the decoder return null at the boundary and the
  // sweep stop one instruction early. It looks like a decode failure; it is a
  // truncated lookahead, and it cost 1 byte per sweep until it was fixed.
  //
  // Instructions are still only *emitted* while `pos < limit`, so a request for
  // a 32-instruction window does not return a 33rd half-instruction.
  while (pos < limit && (max <= 0 || out.length < max)) {
    if (pos < bufAt || pos - bufAt + READ_AHEAD > buf.length) {
      const want = Math.min(WINDOW, sec.size - pos);
      if (want <= 0) break;
      buf = f.read(sliceBase + sec.offset + pos, want);
      bufAt = pos;
      if (buf.length === 0) break;     // truncated file: report what was read
    }

    const slice = buf.subarray(pos - bufAt);
    let length = instructionLength(arch, slice, 0);
    // A fixed-stride architecture has no decoder to disagree with, so a short
    // tail is a truncated final instruction rather than a decoding failure —
    // record it as such instead of dropping the bytes.
    if (length === null && stride && slice.length > 0) length = Math.min(stride, slice.length);
    if (!length) {
      // x86_64 has no "invalid instruction", so `length === null` here means the
      // buffer ended mid-instruction. Stepping one byte would let the next
      // window's bytes be decoded from an arbitrary offset; stopping is honest.
      break;
    }

    const addr = sec.addr + BigInt(pos);
    // Recorded clipped to the requested range. The decoded length is kept in
    // `fullLength` when it differs, because a caller asking "what is at this
    // address" wants the real instruction and a caller asking "what is in this
    // window" wants the bytes that are in the window — and silently handing
    // over either one is how a range query starts reporting bytes outside
    // itself.
    const within = Math.min(length, limit - pos);
    const insn = slice.subarray(0, within);
    const branch = branchTarget(arch, insn, addr, 0);
    const rec = {
      addr,
      bytes: insn,
      length: within,
      kind: branch ? branch.kind : null,
      target: branch ? branch.target : null,
    };
    if (within !== length) rec.fullLength = length;
    out.push(rec);

    pos += length;
  }

  return out;
}

/**
 * Every direct branch in a range, as `{ source, target, kind }`.
 *
 * A convenience projection of `linearSweep` for callers that want edges and do
 * not want instructions — which is the shape that turns `findcall`'s shortlist
 * of candidate call sites into resolved edges.
 */
function findBranchTargets(f, sec, arch, sliceBase, opts = {}) {
  return linearSweep(f, sec, arch, sliceBase, opts)
    .filter((i) => i.target !== null)
    .map((i) => ({ source: i.addr, target: i.target, kind: i.kind }));
}

/* ================================================================== *
 * High level API
 * ================================================================== */

/**
 * Disassemble a range of a Mach-O, across every slice that matches `arch`.
 *
 * With no `addr`, the sweep starts at the first byte of the first code section
 * of each matching slice. With an `addr`, it starts there and must fall inside
 * a code section of a matching slice; an address that is inside the file but
 * inside `__cstring` is reported as `outside-code`, because decoding a string
 * as instructions would produce addresses that look real.
 *
 * @returns {{arch, offset, section, sectionAddr, instructions, branches, notes}[]}
 *   one entry per slice that produced a sweep. `unsupported` on the result names
 *   slices whose architecture has no decoder here, so a caller can tell "this
 *   binary's ppc64 slice was skipped" from "this binary has no code".
 */
function disassemble(path, { addr = null, arch = null, count = 32, bytes = 0 } = {}) {
  return withFile(path, (f) => {
    const slices = [];
    const unsupported = [];
    const notes = [];

    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      if (!thin) continue;
      const name = s.thin
        ? sliceArchName(thin.cputype, thin.cpusubtype)
        : sliceArchName(s.cputype, s.cpusubtype);
      if (arch && !archMatches(name, arch)) continue;

      if (!supportedArch(name)) {
        unsupported.push(name);
        continue;
      }

      const pool = codeSections(thin);
      if (pool.fallback) {
        notes.push(`${name}: no section is flagged as instructions, so the sweep is untyped`);
      }

      // With no address, take the first code section. With one, take the
      // section that covers it, and only that section: sweeping every section
      // and filtering afterwards would decode the whole file to answer a
      // question about one address.
      let chosen = null;
      let start = 0;
      if (addr === null) {
        chosen = pool.sections[0];
        if (chosen) start = 0;
      } else {
        if (!coversAddress(thin, addr)) continue;
        for (const sec of pool.sections) {
          if (addr >= sec.addr && addr < sec.addr + BigInt(sec.size)) {
            chosen = sec;
            start = Number(addr - sec.addr);
            break;
          }
        }
      }
      if (!chosen) continue;

      const instructions = linearSweep(f, chosen, name, s.offset, {
        start,
        end: bytes > 0 ? Math.min(start + bytes, chosen.size) : chosen.size,
        max: count,
      });
      slices.push({
        arch: name,
        offset: s.offset,
        section: `${chosen.segname},${chosen.sectname}`,
        sectionAddr: chosen.addr,
        sectionSize: chosen.size,
        startAddr: chosen.addr + BigInt(start),
        instructions,
        branches: instructions.filter((i) => i.target !== null)
          .map((i) => ({ source: i.addr, target: i.target, kind: i.kind })),
      });
    }

    return { slices, unsupported, notes };
  });
}
/* ================================================================== *
 * src/api.mjs
 * ================================================================== */

/**
 * api.mjs — the supported programmatic interface.
 *
 * ## Why this exists
 *
 * The six CLIs were the only interface. Each reimplemented what it needed from
 * the file format, and they diverged in ways that were not merely inelegant:
 *
 *   - `symfind.mjs` and `symlookup.mjs` each parsed `LC_SYMTAB` by hand rather
 *     than calling `readSymbols`, so `symgrep` filtered to defined symbols while
 *     they reported imports alongside them.
 *   - `mapliteral.mjs` reimplemented the fat-header walk *and* hardcoded
 *     `if (cputype === 0x01000007)`, then threw `'x86_64 slice not found'` on an
 *     arm64-only binary — the exact "absent architecture is fatal" defect the
 *     rest of the project fixed and the smoke test guards against. It escaped
 *     because it did not share the reader, which is precisely the argument for
 *     sharing it.
 *
 * The README has always said this reader is meant to be imported or vendored,
 * and MPL-2.0's file-level copyleft exists so that embedding it does not infect the embedding
 * application. None of that is usable while the only way in is to spawn a
 * subprocess and parse English. This module makes the licence rationale and the
 * "it is a reader, not a script" claim the same thing.
 *
 * ## Shape of every result
 *
 * Each function returns a plain object and throws nothing for ordinary
 * negative answers: no match is `{ matches: [] }`, not an exception. A caller
 * asking "does this binary call X" wants `false`, not a stack trace. Genuine
 * I/O failures do throw, because a caller that cannot distinguish "no result"
 * from "could not look" has the problem this project keeps fixing.
 *
 * Addresses come back as BigInt, matching `macho.mjs`. They do not fit in a
 * JSON number and must not be silently truncated; `output.mjs` renders them as
 * hex strings when a caller asks for JSON.
 *
 * ## Stability
 *
 * The exports here are the package's public surface and follow semver.
 * `macho.mjs` is also importable, but new format support lands there first, so
 * it is treated as lower-level: stable within a major version, more likely to
 * grow.
 */


// Text stubs are a different format in a different file, so they get their own
// reader rather than a branch in the Mach-O one. What they share is the shape of
// the answer: plain objects, nothing thrown for a negative answer, a thrown error
// only when the file could not be read. See `stub.mjs`.

/* ------------------------------------------------------------------ *
 * opening
 * ------------------------------------------------------------------ */

/**
 * An error that names its reason code, so a caller does not have to read it.
 *
 * These are the same codes the JSON envelope publishes as `errors`, which is
 * what makes the contract usable from a program rather than a person: an agent
 * asking for `/nope` and for `/etc/hosts` gets two different codes and can act
 * on that, where before both arrived as `io` with the message "not a Mach-O
 * binary" — two unrelated problems reported as one, sending a caller looking in
 * the wrong place.
 *
 * @param {string} path
 * @returns {Error & { code: string }}
 */
function readerError(path) {
  // Known Apple ecosystem containers — an `.ipa`, a `.dmg`, a `.pkg` and the rest —
  // get a specific, actionable message instead of the generic "not a Mach-O binary",
  // and the message names what *is* accepted. Both halves matter: the first explains
  // why the file was refused, the second answers the question the refusal raises.
  //
  // No bundle extension is passed. `withFile` is given a file, and `target.mjs`
  // resolves a bundle to the executable inside before it gets here; a deployment
  // with a non-default bundle layout therefore cannot produce a message that
  // contradicts its own convention.
  const container = containerMessage(path);
  if (container) return Object.assign(new Error(container), { code: 'unknown-encoding' });

  // `statSync` rather than `existsSync` because the interesting case is a path
  // that is *there* and still unreadable — a directory, a dangling symlink, a
  // permissions problem — which `existsSync` reports as simply absent and so
  // would mislabel as a missing file rather than an unreadable one.
  let readable = true;
  try {
    if (fs.statSync(path).isDirectory()) readable = false;
  } catch {
    readable = false;
  }

  return Object.assign(
    new Error(
      readable
        ? `${path}: not a Mach-O binary`
        : `${path}: cannot be read (no such file, not a regular file, or not permitted)`,
    ),
    { code: readable ? 'unknown-encoding' : 'io' },
  );
}

/**
 * Open a binary, hand it to `fn`, close it afterwards.
 *
 * A handle per call is the whole lifecycle. The alternative — an object with an
 * explicit `close()` — is a handle that leaks whenever a caller forgets, and
 * every consumer of this package is a short script. Callers that genuinely want
 * one open can use `macho.mjs`'s `opener` directly.
 *
 * @param {string} path
 * @param {(f: object) => T} fn
 * @returns {T} whatever `fn` returns
 * @throws if the path cannot be opened or is not a Mach-O. The thrown error
 *   carries `.code`, one of the reason codes the JSON envelope documents —
 *   `io` for a path that cannot be read, `unknown-encoding` for a file that
 *   reads fine but is not Mach-O — so a caller can branch without matching
 *   English.
 */
function withFile(path, fn) {
  if (typeof path !== 'string' || !path) throw new TypeError('withFile: a path is required');
  if (!isMachOFile(path)) throw readerError(path);
  const f = opener(path);
  try {
    return fn(f);
  } finally {
    f.close();
  }
}

/**
 * What is in this file: every slice, with architecture, extent and symbol
 * counts. The first thing to call on an unknown binary.
 *
 * `thin` means "this file is a single-architecture Mach-O", which is a different
 * statement from "this slice has one architecture". The two are routinely
 * confused, and confusing them is how the fixed-offset reader bug happened.
 */
function describe(path) {
  return withFile(path, (f) => {
    const slices = [];
    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      const arch = s.thin
        ? sliceArchName(thin?.cputype, thin?.cpusubtype)
        : sliceArchName(s.cputype, s.cpusubtype);
      if (!thin) {
        slices.push({
          arch, offset: s.offset, size: s.size, thin: s.thin, readable: false,
          nsyms: 0, defined: 0, codeSections: 0, textAddr: null, textSize: 0,
          uuid: null, segments: [], sections: [], loadCommands: [],
          flags: 0, flagsNamed: [], flagsUnknown: 0,
          entryPoint: null, rpaths: [], dylibs: [], installName: null,
          sourceVersion: null, buildVersion: null, encryption: null,
          filetype: null, filetypeName: null, platform: null, platformName: null,
          minos: null, sdk: null, cpusubtype: null, cryptid: null, encrypted: null,
          abnormalities: [],
          note: 'no Mach-O header at this offset',
        });
        continue;
      }
      const syms = readSymbols(f, s.offset, thin);
      const text = textSection(thin);
      const hdr = decodeHeaderFlags(thin.flags);
      // The fat table is checked here too, not only in `audit`. Every per-slice
      // check is blind to a container defect by construction — two slices claiming
      // the same bytes are each internally consistent — so a `describe` that omitted
      // this would report a file with overlapping slices as entirely unremarkable,
      // which is the confident-wrong-answer shape rather than a partial one.
      // `cryptid` is 0 on a binary that was never encrypted, and null when there
      // is no LC_ENCRYPTION_INFO at all. Those are different facts — a simulator
      // build has no such command, an App Store build has one saying 1 — so they
      // stay distinct rather than collapsing into a boolean.
      const cryptid = thin.encryption ? thin.encryption.cryptid : null;
      slices.push({
        arch,
        offset: s.offset,
        size: s.size,
        thin: s.thin,
        readable: true,
        bits: thin.is64 ? 64 : 32,
        // The iOS-facing facts. A Mach-O from an iPhone and one from a Mac are
        // byte-compatible everywhere this reader used to look, so without these
        // nothing here could tell you which you were holding.
        filetype: thin.filetype,
        filetypeName: thin.filetypeName,
        platform: thin.platform ? thin.platform.platform : null,
        platformName: thin.platform ? thin.platform.name : null,
        minos: thin.platform ? thin.platform.minos : null,
        sdk: thin.platform ? thin.platform.sdk : null,
        cpusubtype: thin.cpusubtype,
        cryptid,
        encrypted: cryptid == null ? null : cryptid !== 0,
        nsyms: syms.total,
        defined: syms.defined,
        note: syms.note,
        textAddr: text ? text.addr : null,
        textSize: text ? text.size : 0,
        codeSections: codeSections(thin).sections.length,
        // The three lists the reader already parsed and nothing surfaced. A
        // caller asking "what is in this file" wants the sections, not a count
        // of how many are code — and `ipsw macho info --section` answers the
        // same question, so leaving these out meant being unable to do something
        // a competitor's dump does in one line.
        segments: thin.segments,
        sections: thin.sections,
        loadCommands: thin.loadCommands,
        uuid: thin.uuid,
        // The header `flags` word, its decoded names, and — kept separate — any
        // bits this reader cannot name. Folding "unrecognised" into "not set"
        // would let a newer binary describe as an ordinary one, which is the
        // quiet wrong answer this package exists to avoid.
        flags: thin.flags,
        flagsNamed: hdr.names,
        flagsUnknown: hdr.unknown,
        // `entryPoint` carries the resolved vaddr plus the segment it was derived
        // from, so a caller can see the arithmetic rather than trust a bare
        // number. `null` when the slice has no LC_MAIN.
        entryPoint: resolveEntryPoint(thin),
        // Runtime search paths, in the order the binary declares them. Order is
        // load order, and `@rpath` resolution depends on it.
        rpaths: thin.rpaths,
        // What this binary must be able to find to load, in the order the linker
        // recorded it — the question `otool -L` answers. `linkage` is kept per
        // entry because the five commands differ in what a *missing* library means:
        // an absent `weak` dylib is normal, an absent `load` dylib is a broken
        // install, and a `reexport` also republishes that image's symbols here.
        // The install name is separate because it names this image, not a
        // dependency, and a dylib's own `LC_ID_DYLIB` is the only record of what
        // clients are supposed to link against.
        dylibs: thin.dylibs,
        installName: thin.installName,
        // The five-part source version, or null when the binary declares none.
        sourceVersion: thin.sourceVersion,
        // Which platform this slice was built for, and the minimum OS and SDK it
        // declares — from `LC_BUILD_VERSION`, or from the older
        // `LC_VERSION_MIN_*` command that names its platform implicitly. Null when
        // the binary declares neither, which is a real answer rather than a gap:
        // an `MH_OBJECT` and a pre-10.14 build both look like this.
        buildVersion: thin.buildVersion,
        // FairPlay state, or null for a binary that declares no encryption
        // command at all. `encrypted` is `cryptid > 0`, not "the command is
        // present" — a decrypted App Store binary keeps the command with
        // `cryptid` 0, and reading presence would call it still encrypted. This
        // is the one field that decides whether a zero result from `findcall` or
        // `findliteral` means "not present" or "not readable".
        encryption: thin.encryption,
        // What kind of Mach-O this is. Fourteen `MH_*` values, named; an
        // unrecognised one is null rather than a guess, because "an executable"
        // and "a file whose second word is 2" are not the same claim.
        filetype: thin.filetype,
        // Flat mirrors of the nested `buildVersion`/`filetype`/`encryption`
        // objects, because the iOS tests and `describe --json` consumers read
        // `platformName`/`minos`/`encrypted` directly rather than reaching into
        // the command object. The nested forms are kept for callers that want
        // the whole command; these are the one-fact-at-a-time view.
        filetypeName: thin.filetypeName,
        platform: thin.buildVersion ? thin.buildVersion.platformRaw : null,
        platformName: thin.buildVersion ? thin.buildVersion.platform : null,
        minos: thin.buildVersion && thin.buildVersion.minos ? thin.buildVersion.minos.text : null,
        sdk: thin.buildVersion && thin.buildVersion.sdk ? thin.buildVersion.sdk.text : null,
        cpusubtype: thin.cpusubtype,
        cryptid: thin.encryption ? thin.encryption.cryptid : null,
        encrypted: thin.encryption ? thin.encryption.encrypted : null,
        // Structural problems, reported alongside the parse rather than instead
        // of it. Empty on a healthy binary, which is the common case.
        abnormalities: detectAbnormalities(f, thin, { sliceOffset: s.offset, sliceSize: s.size }),
      });
    }
    return {
      path,
      size: f.size,
      fat: slices.length > 1 || slices.every((s) => !s.thin),
      slices,
      // Findings about the fat table itself, kept beside the slices rather than
      // merged into them: "this slice is broken" and "these two slices contradict
      // each other" are different claims about different things.
      containerAbnormalities: detectContainerAbnormalities(f),
    };
  });
}

/* ------------------------------------------------------------------ *
 * overview
 * ------------------------------------------------------------------ */

/**
 * What this package does not read, named in the answer rather than left to be
 * discovered.
 *
 * ## Why a list of gaps travels inside the result
 *
 * There is a project that formats a Mach-O into "one JSON blob" and calls that
 * completeness. Copying that framing here would mean a consumer could not tell
 * the difference between a field that is empty because the binary has none and a
 * field that is empty because this reader does not implement it — and those two
 * look identical in JSON. `strings: []` on a binary with no `__cstring` section
 * and `strings: []` from a reader that never looked are the same 18 characters,
 * and a pipeline that trusts one of them builds a fact out of the other.
 *
 * So the omissions are named, in the payload, on every call. A consumer reads
 * `notRead` and knows which fields are evidence and which are silence. This is
 * the whole argument for the tool existing in this shape: it is a summary of what
 * *this* package can see, and the list of what it cannot is part of that summary
 * rather than a caveat in a README four screens away.
 *
 * Kept in step with `README.md`'s "What it will not do" by hand, and asserted
 * against it in the suite — a gap list that drifts from the refusal list is
 * worse than none, because it is a gap list that is confidently wrong.
 *
 * Re-exported rather than declared: `notread.mjs` holds the single copy so the CLI
 * door, this one and the MCP door cannot disagree, and so the MCP door can reach it
 * without importing `api.mjs` — which that layer deliberately avoids. See that file
 * for the argument.
 */

/**
 * The structural picture and, on request, two inventories — in one call.
 *
 * ## What this is for
 *
 * Answering "what is this binary" completely costs four round trips today:
 * `describe` for the structure, `sym` for the names, `findliteral --strings` for
 * the strings, and the reader's own judgement about which slice each will pick.
 * That last part is the real cost — four tools each choose a slice, and they can
 * choose differently, so a caller that wants a consistent picture has to check.
 * This reads the file once and reports one answer.
 *
 * ## What it is deliberately not
 *
 * It is not a complete Mach-O parser, and `notRead` says so in the result rather
 * than leaving a consumer to infer completeness from an object that looks
 * exhaustive. Most load commands are named, not interpreted — the `dylib_command`
 * family is the exception, because its name is the single most-asked fact about
 * an executable. The strings come from C-string sections only; there is no
 * disassembly, because a linear sweep of a whole binary is not a disassembly of
 * anything.
 *
 * ## Why the shape is `describe`'s
 *
 * `slices` is byte-for-byte `describe`'s own slice objects, so
 * `.slices[0].sections` means the same thing here as it does there and a caller
 * can switch between the two tools without relearning a field. The inventories
 * are *additions*, never replacements — a consumer that wants only structure gets
 * exactly what `describe` would have given it.
 *
 * ## Why the inventories are opt-in and capped
 *
 * Measured on a 14.5 MB Go binary: `describe` is 9.2 KB of JSON, and its 19,526
 * defined symbols are the difference between a 9 KB structural answer and a
 * 422 KB one with them included. An aggregate that defaulted to including them
 * would be 99% symbol table on every binary, which is the opposite of an
 * overview — and it would be slowest and largest on exactly the binaries where
 * the structural half is what the caller wanted. So structure is always present
 * and cheap, and the two lists that scale with the file are asked for by name and
 * bounded by `max`.
 *
 * `truncated` is reported whenever the cap bites. A silently shortened list reads
 * as a complete one, and "this binary has 4,000 symbols" when it has 19,657 is
 * the confident wrong answer this package treats as a defect.
 *
 * @param {string} path
 * @param {object}  [opts]
 * @param {string}  [opts.arch]    narrow a universal binary to one slice
 * @param {boolean} [opts.symbols] include the symbol table
 * @param {boolean} [opts.strings] include C-string section contents
 * @param {number}  [opts.max]     cap on each inventory (default 4000, 0 = unlimited)
 * @param {number}  [opts.min]     shortest string to report (default 4)
 */
function overview(path, { arch = null, symbols = false, strings = false, max = 4000, min = 4 } = {}) {
  const d = describe(path);

  // `--arch` narrows the *answer*, not the read: the fat header is still walked so
  // `fat` and `containerAbnormalities` stay true of the file. Same rule and same
  // reason as `describe`'s, and `archMatches` rather than `===` because naming
  // arm64e as its own architecture made that a live bug there.
  let slices = d.slices;
  const notes = [];
  if (arch && slices.length > 1) {
    const match = slices.find((s) => archMatches(s.arch, arch));
    if (match) {
      const all = slices.map((s) => s.arch).join(', ');
      slices = [match];
      notes.push(`${arch}: showing 1 of ${all.split(', ').length} slices — drop the flag for all`);
    } else {
      notes.push(`${arch} matched none of the slices (${slices.map((s) => s.arch).join(', ')}); showing all ${slices.length}`);
    }
  }

  const out = {
    path: d.path,
    size: d.size,
    fat: d.fat,
    slices,
    containerAbnormalities: d.containerAbnormalities,
    // Always present, so "this is the whole of what we can tell you" is a field
    // rather than an inference from the absence of something else.
    notRead: NOT_READ,
    ...notes.length ? { notes } : {},
  };

  // One slice is asked, because a symbol table and a string table are per-slice
  // and "the symbols of a universal binary" is not a question with one answer.
  //
  // Picked by `symbolSlice`, which is `sym`'s own rule — the named architecture
  // if the caller gave one, else the richest — and then *pinned by offset* for the
  // symbol read rather than re-derived from the name. That is the whole reason
  // this function exists: four tools each choosing a slice independently is how a
  // caller ends up with a symbol table from one architecture and strings from
  // another. Both inventories below name their `arch` in the result as well, so a
  // consumer can see which slice answered rather than infer it.
  const chosen = (() => {
    try {
      return withFile(path, (f) => {
        const s = symbolSlice(f, arch);
        const syms = readSymbols(f, s.offset, s.thin);
        return { arch: s.arch, offset: s.offset, syms };
      });
    } catch {
      // No readable slice. Reported as an empty inventory with a note, not
      // thrown: the structure above still parsed, and a file with one broken
      // slice out of two should not lose the answer for the other.
      return null;
    }
  })();

  if (symbols) {
    if (!chosen) {
      out.symbols = { count: 0, symbols: [], truncated: false, note: 'no slice in this file could be parsed' };
    } else {
      // Defined names only, deduplicated by name and sorted by address — the three
      // rules `searchSymbols` applies, restated rather than reused. Going through
      // `searchSymbols` with an empty pattern would have been the obvious way to
      // share them, and it throws on an empty pattern precisely because "match
      // everything" is not a search; so the rules are applied here and asserted
      // against `sym`'s in the suite, which is what keeps two copies from drifting.
      //
      // Imports are dropped because they carry `n_value == 0` and an overview that
      // listed them would put thousands of address-zero rows ahead of the real
      // ones. They are not silently dropped: `imports` below counts them, so the
      // consumer can see that the table held more than this list does.
      const defs = chosen.syms.entries.filter((e) => e.defined);
      const imports = chosen.syms.entries.length - defs.length;
      const names = [...new Map(defs.map((e) => [e.name, e])).values()].sort(byAddr);
      const capped = max > 0 ? names.slice(0, max) : names;
      out.symbols = {
        arch: chosen.arch,
        count: names.length,
        defined: defs.length,
        imports,
        truncated: capped.length < names.length,
        max,
        symbols: capped.map((e) => ({ name: e.name, addr: e.addr })),
        note: names.length === 0
          ? (chosen.syms.note || 'this slice has no defined symbols — stripped, or a dyld-cache stub')
          : (capped.length < names.length ? `showing ${capped.length} of ${names.length} — raise --max for the rest` : null),
      };
    }
  }

  if (strings) {
    if (!chosen) {
      out.strings = { count: 0, strings: [], truncated: false, note: 'no slice in this file could be parsed' };
    } else {
      // `chosen.arch` rather than `null`, so this reads the slice the symbols came
      // from rather than re-running its own preference. Two inventories in one
      // object that disagree about which slice they read would be worse than two
      // separate calls.
      const r = findStrings(path, { arch: chosen.arch, min, max });
      // The distinction that matters most in this whole function: zero strings
      // because the slice has no C-string section is a fact about the file, and
      // zero strings because a reader looked and found none is a different fact.
      // Both serialise as `[]`, so `note` is what carries it — a binary whose
      // toolchain packs strings into a blob has nothing here to read, and saying
      // "no strings" about it without that would be a wrong answer wearing a
      // true-looking shape.
      const noSections = r.count === 0 && r.scanned === 0;
      out.strings = {
        arch: r.arch,
        min: r.min,
        count: r.count,
        scanned: r.scanned,
        truncated: r.truncated,
        max,
        sections: r.sections,
        strings: r.strings,
        note: noSections
          ? `no C-string section in this slice (looked for ${r.sections.join(', ')}) — a toolchain that packs string data into one blob has nothing here to read`
          : (r.count === 0
            ? `no string of ${r.min}+ printable bytes in ${count2(r.scanned)} scanned bytes`
            : (r.truncated ? `showing ${r.count} of the strings found — raise --max for the rest` : null)),
      };
    }
  }

  return out;
}

/** `count()` from output.mjs, without importing the CLI layer into the API. */
function count2(n) {
  return String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ------------------------------------------------------------------ *
 * address <-> file offset
 * ------------------------------------------------------------------ */

/** A file position or address as a hex string, for the wire. */
const hex = (v) => `0x${v.toString(16)}`;

/**
 * Which slice an address or offset query should read.
 *
 * `symbolSlice` is the wrong choice here even though the fallback logic matches:
 * it picks the slice with the most *symbols*, and a stripped slice can be the one
 * whose layout you are asking about. An address is a question about a
 * particular slice's mapping, so `--arch` selects it when given and otherwise the
 * first slice that parses — the order the fat header lists, which is the order
 * the file itself declares. For a thin binary both agree.
 */
function layoutSlice(f, arch) {
  return layoutSlices(f, arch)[0];
}

/**
 * Every slice an address or offset query should consider.
 *
 * `symbolSlice` is the wrong choice here even though the fallback logic looks
 * similar: it picks the slice with the most *symbols*, and a stripped slice can
 * be the one whose layout you are asking about. Layout is a question about a
 * particular slice, so all of them are returned and the caller reports a single
 * answer only when exactly one slice agrees.
 */
function layoutSlices(f, arch) {
  if (arch) {
    const named = preferredSlice(f, arch);
    // A preference, not a requirement, matching every other tool here: an absent
    // architecture falls through to the whole file rather than failing.
    if (named) return [named];
  }
  const out = [];
  for (const s of slicesOf(f)) {
    const thin = parseThin(f, s.offset);
    if (thin) {
      out.push({
        offset: s.offset,
        arch: s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype),
        thin,
        size: s.size,
      });
    }
  }
  if (out.length === 0) throw new Error('no Mach-O slice could be parsed');
  return out;
}

/**
 * The shape both directions report, so one row means the same thing either way.
 *
 * `query`, `vaddr` and `offset` are hex strings, not numbers. A 64-bit file
 * position does not survive a `Number` and a BigInt does not survive
 * `JSON.stringify`, so a caller reading the envelope would otherwise get either a
 * thrown error or a silent precision loss — and this package already emits every
 * other address this way for the same reason.
 */
function mappingRow(slice, query, m) {
  return {
    arch: slice.arch,
    query: hex(query),
    // Taken from the mapping rather than echoed from the query: in one direction
    // the query *is* the vaddr and in the other it is a file offset, and a row
    // whose `vaddr` silently reported whichever was asked about would be wrong
    // half the time.
    vaddr: m.vaddr === null || m.vaddr === undefined ? hex(query) : hex(m.vaddr),
    offset: m.offset ?? null,
    // Absolute, for a file with more than one slice: a section's `offset` is
    // relative to its slice, so reporting it unqualified would send a reader to
    // the wrong bytes in every slice but the first.
    absoluteOffset: m.offset === null || m.offset === undefined ? null : slice.offset + m.offset,
    section: m.section,
    zerofill: m.zerofill === true,
    mapped: true,
    note: null,
  };
}

function unmappedRow(slice, query, note) {
  return {
    arch: slice.arch, query: hex(query), vaddr: null, offset: null, absoluteOffset: null,
    section: null, zerofill: false, mapped: false, note,
  };
}

/**
 * Virtual address to file offset: which byte of the file is this address?
 *
 * `offset` is slice-relative — the same basis the section table uses — and
 * `absoluteOffset` adds the slice's own position in the file. Both are reported
 * because a reader patching a file needs the absolute one and a reader
 * comparing against `otool -l` output needs the relative one, and guessing which
 * was meant is how the wrong bytes get edited.
 *
 * `zerofill` is true for an address that is mapped but has no bytes: `__bss`,
 * `__noptrbss`, `__PAGEZERO`, and the tail of a segment past `filesize`. Those
 * are separate answers from `mapped: false`, and a caller that wants to read or
 * write the byte has to treat them differently.
 */
function addressToOffset(path, vaddr, { arch } = {}) {
  const want = typeof vaddr === 'bigint' ? vaddr : BigInt(vaddr);
  return withFile(path, (f) => {
    const slices = layoutSlices(f, arch);
    const per = [];
    for (const slice of slices) {
      const m = toFileOffset(slice.thin, want);
      if (!m) {
        per.push(unmappedRow(slice, want, 'address is not mapped by this slice'));
        continue;
      }
      const row = mappingRow(slice, want, m);
      row.note = m.zerofill
        ? `${m.section} is zero-fill — mapped at this address, but no byte of it exists in the file`
        : null;
      per.push(row);
    }

    const mapped = per.filter((r) => r.mapped);
    if (mapped.length === 1) return mapped[0];

    // More than one slice maps the address, or none does. Both are reported
    // rather than resolved, because picking a slice is a choice about which
    // binary you meant, and a fat binary's slices share an address space by
    // construction — `__TEXT` starts at 0x100000000 in every one of them.
    if (mapped.length === 0) {
      return {
        ...unmappedRow(per[0], want, 'address is not mapped by any slice'),
        slices: per,
      };
    }
    return {
      arch: null,
      query: hex(want),
      vaddr: hex(want),
      offset: null,
      absoluteOffset: null,
      section: null,
      zerofill: false,
      mapped: true,
      ambiguous: true,
      slices: per,
      note: `${mapped.length} slices map this address — pass --arch to choose one`,
    };
  });
}

/**
 * File offset to virtual address: which address does this byte have?
 *
 * `query` is reported as the slice-relative offset, since that is the basis
 * `toVaddr` uses; an absolute offset is accepted and converted when it falls in
 * this slice. Offsets in no slice are reported per slice rather than rejected, so
 * a fat binary answers for all of them in one call.
 *
 * A file offset can belong to more than one slice's *layout* only if the slices
 * overlap, which a well-formed fat binary does not do. Where they do, every
 * slice that maps the offset is reported, because picking one would be a guess.
 */
function offsetToAddress(path, offsets, { arch } = {}) {
  const list = Array.isArray(offsets) ? offsets : [offsets];
  return withFile(path, (f) => {
    const candidates = layoutSlices(f, arch);

    const queries = list.map((raw) => {
      const abs = typeof raw === 'bigint' ? raw : BigInt(raw);
      // Offsets are absolute positions in the file. Each slice's row also carries
      // its own slice-relative offset, because a `section_64`'s `offset` is
      // relative to the slice and the two differ on every slice but the first.
      const per = [];
      for (const s of candidates) {
        // `s.offset` is a Number (a file position) and `abs` a BigInt (an
        // address-shaped quantity), so the subtraction is done in BigInt and
        // narrowed after. Mixing them directly throws.
        const rel = abs >= BigInt(s.offset) ? Number(abs - BigInt(s.offset)) : null;
        if (rel === null) {
          per.push(unmappedRow(s, abs, 'offset is before this slice in the file'));
          continue;
        }
        const m = toVaddr(s.thin, rel);
        if (!m) {
          per.push(unmappedRow(s, abs, 'no section or segment in this slice maps that offset'));
          continue;
        }
        // `m.vaddr` is the address this offset resolves to; `query` is the offset
        // that was asked about. Both are carried, and they differ on every slice
        // but the first.
        per.push(mappingRow(s, abs, { ...m, offset: rel }));
      }
      const mapped = per.filter((r) => r.mapped);
      return {
        query: hex(abs),
        basis: 'absolute',
        slices: per,
        // The one mapping, when there is exactly one. More than one is reported
        // rather than picked, and so is none.
        vaddr: mapped.length === 1 ? mapped[0].vaddr : null,
        ambiguous: mapped.length > 1,
      };
    });

    return { path, queries, slices: candidates.map((s) => ({ arch: s.arch, offset: s.offset })) };
  });
}

/**
 * The bytes at an address, resolved through the section that maps it.
 *
 * `a2o` answers "which byte of the file is this address"; this answers "what are
 * the bytes there", and it is deliberately not a `dd` window. The *section* is
 * the unit: an address resolves to a section, the dump starts at the address and
 * stops at that section's own end, and the section is named in the answer.
 * Reading past the boundary would silently blend two sections — `__cstring` into
 * `__const`, or the tail of `__text` into whatever the linker packed after it —
 * and a reader comparing those bytes with a hex editor's window would be looking
 * at two different things without being told.
 *
 * ## Three answers, not two
 *
 * An address can be mapped to a byte, mapped with no byte (`__bss`,
 * `__PAGEZERO`), or in no slice at all. All three come back as values:
 * `mapped` and `zerofill` tell them apart, which is the same three-valued shape
 * `addressToOffset` returns and exists for the same reason. A caller that wants
 * "no bytes here" to be distinguishable from "wrong address" needs both fields.
 *
 * ## Why the length is clamped twice
 *
 * `length` is a request, not an override. The dump stops at the section's end
 * and at the slice's own extent, because on a universal binary the bytes after a
 * slice belong to the *next* slice and reading them would report another
 * architecture's data as this one's. `truncated` says the request was not met in
 * full, so a short answer cannot be mistaken for the whole one.
 *
 * @param {string} path
 * @param {bigint|string} vaddr  the address to start at
 * @param {object} [opts]
 * @param {string} [opts.arch]    preferred architecture; falls through if absent
 * @param {number} [opts.length=64] how many bytes to read, at most
 */
function dumpBytes(path, vaddr, { arch = null, length = 64 } = {}) {
  const want = typeof vaddr === 'bigint' ? vaddr : BigInt(vaddr);
  // A cap, because a mis-typed `--len` should not ask this tool to materialise a
  // gigabyte of hex into a JSON envelope. The section end clamps far below this
  // for nearly every real call; this is the backstop for the ones where it does
  // not.
  const capped = Math.max(1, Math.min(Number(length) || 0, 1 << 20));
  return withFile(path, (f) => {
    const slice = layoutSlice(f, arch);
    const thin = slice.thin;
    const m = toFileOffset(thin, want);
    if (!m) {
      return {
        path, arch: slice.arch, mode: 'address', vaddr: hex(want),
        section: null, offset: null, absoluteOffset: null,
        mapped: false, zerofill: false, found: false,
        requestedBytes: capped, bytes: 0, truncated: false, lines: [],
      };
    }
    if (m.zerofill) {
      return {
        path, arch: slice.arch, mode: 'address', vaddr: hex(want),
        section: m.section, offset: null, absoluteOffset: null,
        mapped: true, zerofill: true, found: false,
        requestedBytes: capped, bytes: 0, truncated: false, lines: [],
      };
    }
    // The tighter of the two bounds. `sectionOf` is null when the address landed
    // in a segment's padding rather than a section, in which case the slice's own
    // extent is the only honest limit.
    const sec = sectionOf(thin, m.offset);
    const startRel = m.offset;
    const startAbs = slice.offset + startRel;
    const endRel = sec ? sec.offset + sec.size : slice.size;
    const hi = Math.min(slice.offset + endRel, slice.offset + slice.size, f.size, startAbs + capped);
    const buf = f.read(startAbs, Math.max(0, hi - startAbs));
    const lines = [];
    for (let i = 0; i < buf.length; i += 16) {
      const chunk = buf.subarray(i, i + 16);
      lines.push({
        offset: startRel + i,
        absoluteOffset: startAbs + i,
        // The address is derived from the request rather than the section, so an
        // address in a segment's padding still reports the addresses it asked
        // about rather than snapping to a section start that is not there.
        vaddr: hex(want + BigInt(i)),
        hex: chunk.toString('hex').replace(/(..)(?=.)/g, '$1 '),
        ascii: chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
      });
    }
    return {
      path, arch: slice.arch, mode: 'address', vaddr: hex(want),
      section: m.section, offset: startRel, absoluteOffset: startAbs,
      mapped: true, zerofill: false, found: true,
      requestedBytes: capped, bytes: buf.length,
      truncated: buf.length < capped,
      lines,
    };
  });
}

/**
 * The function start addresses a slice declares, with optional symbol names.
 *
 * `LC_FUNCTION_STARTS` is the linker's own list of where functions begin, and it
 * is the only such list a *stripped* binary carries: the symbol table is gone,
 * but the command survives because the unwinder needs it at runtime. That makes
 * it the difference between a list of addresses and no structure at all on a
 * shipped build, and a cross-check on the symbol values of a symballed one.
 *
 * ## Labels, not names
 *
 * A function start is an address first. Where a defined symbol sits exactly on
 * one, the symbol's name is reported beside it; where none does, the row carries
 * a synthetic `sub_<hex>` label — a *name for the address*, not a claim about
 * what the function does. Naming every address is what turns a column of numbers
 * into something a person can scan and a pipeline can key on.
 *
 * ## The list can be absent, and that is an answer
 *
 * An object file, a hand-built binary or a very old one can carry no
 * `LC_FUNCTION_STARTS` at all. `present: false` says so, rather than returning an
 * empty list: "the linker recorded no function starts" and "the linker recorded
 * a list that happens to be empty" are different facts.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {string} [opts.arch]      preferred architecture; falls through if absent
 * @param {boolean} [opts.symbols]  annotate each start with the symbol on it
 * @param {number} [opts.max=0]     cap the returned list (0 means all)
 */
function listFunctionStarts(path, { arch = null, symbols = false, max = 0 } = {}) {
  return withFile(path, (f) => {
    const slice = layoutSlice(f, arch);
    const thin = slice.thin;
    const decoded = functionStartAddresses(f, thin, slice.offset);
    let byAddr = null;
    if (symbols) {
      byAddr = new Map();
      for (const e of readSymbols(f, slice.offset, thin).entries) {
        // Imports carry `n_value` 0, so including them would make an unnamed start
        // at a low address resolve to an import's name. A function start is a
        // defined address or it is unnamed.
        if (!e.defined || e.addr === 0n) continue;
        const k = e.addr.toString(16);
        if (!byAddr.has(k)) byAddr.set(k, e.name);
      }
    }
    const rows = decoded.addresses.map((a, i) => {
      const row = { index: i, address: hex(a), label: `sub_${a.toString(16)}` };
      if (byAddr) row.symbol = byAddr.get(a.toString(16)) ?? null;
      return row;
    });
    const capped = max > 0 && max < rows.length;
    return {
      path,
      arch: slice.arch,
      present: decoded.present,
      base: decoded.base === null ? null : hex(decoded.base),
      count: rows.length,
      // Two truncations, kept apart: the linker's blob was clipped, or this
      // tool's own `max` cut the list short. Only one is a fact about the file.
      blobTruncated: decoded.truncated,
      capped,
      functions: capped ? rows.slice(0, max) : rows,
      named: byAddr ? rows.filter((r) => r.symbol).length : null,
    };
  });
}

/* ------------------------------------------------------------------ *
 * symbols
 * ------------------------------------------------------------------ */

/** Which slice a symbol query should read: a named arch, else the richest. */
function symbolSlice(f, arch) {
  if (arch) {
    const named = preferredSlice(f, arch);
    if (named) return named;
    // A preference, not a requirement: falling through to the richest is the
    // behaviour that stopped an arm64-only binary from failing outright.
  }
  const rich = richestSlice(f);
  if (!rich) throw new Error('no Mach-O slice could be parsed');
  return { offset: rich.offset, arch: rich.arch, thin: rich.thin, size: rich.size };
}

/** The chosen slice plus its symbols, read once. Shared by every symbol query. */
function symbolsFor(f, arch) {
  const slice = symbolSlice(f, arch);
  return { slice, syms: readSymbols(f, slice.offset, slice.thin) };
}

/**
 * Search a symbol table by substring or regex, with one coherent set of rules.
 *
 * This is the primitive behind the `sym` CLI, which replaced `symgrep`
 * and `symfind` — two tools that answered the same question with different
 * defaults. `symgrep` matched regexes, defaulted to defined symbols and returned
 * one row per table entry; `symfind` matched substrings, included imports and
 * deduplicated by name. Neither default was a mistake, and a tool with two
 * contradictory notions of "a symbol" is the kind of thing this project has been
 * deleting bugs out of — so the rules are now stated once:
 *
 *   - `mode: 'substring'` (default) matches literally; `'regex'` matches
 *     `/pattern/i`. Substring is the default because the name is usually known
 *     but not its exact spelling, and a pattern that accidentally compiles as a
 *     bad regex is a worse failure than one that matches too much.
 *   - `definedOnly` defaults to true: an imported name carries no address and no
 *     implementation, so it is not an answer to "where is this implemented".
 *   - `dedupe` defaults to true: one name is one row, because a symbol table
 *     routinely carries a name at several addresses (aliases, thunks, per-arch
 *     copies) and nine rows saying `memcpy` is harder to read than one.
 *
 * The two narrower functions this absorbed were removed rather than kept as
 * aliases: at 0.1.0 there are no external consumers to strand, and leaving two
 * superseded exports would recreate the ambiguity the merge exists to end.
 *
 * @param {string} path
 * @param {string} pattern
 * @param {object} [opts]
 * @param {string} [opts.arch] preferred architecture; falls back to the richest
 * @param {'substring'|'regex'} [opts.mode='substring']
 * @param {string} [opts.flags='i'] regex flags, ignored in substring mode
 * @param {boolean} [opts.definedOnly=true] exclude imported (N_EXT) names
 * @param {boolean} [opts.dedupe=true] one row per distinct name
 * @param {number} [opts.max=4000] row cap; only applied when deduplicating
 * @returns {object}
 * @throws if the pattern is not a valid regex, or the file is not a Mach-O
 */
function searchSymbols(path, pattern, {
  arch, mode = 'substring', flags = 'i', definedOnly = true, dedupe = true, max = 4000,
} = {}) {
  if (typeof pattern !== 'string' || !pattern) throw new TypeError('searchSymbols: a pattern is required');
  // Built before the file is opened so an invalid regex is a usage error about
  // the pattern, not a confusing failure from deep inside a read.
  const re = mode === 'regex' ? new RegExp(pattern, flags) : null;

  return withFile(path, (f) => {
    const { slice, syms } = symbolsFor(f, arch);
    const hits = syms.entries.filter(
      (e) => (definedOnly ? e.defined : true) && (re ? re.test(e.name) : e.name.includes(pattern)),
    );
    const matches = dedupe
      ? [...new Map(hits.map((e) => [e.name, e])).values()].sort(byAddr).slice(0, max)
      : hits.slice(0, max);
    return {
      arch: slice.arch,
      pattern,
      mode,
      flags: mode === 'regex' ? flags : null,
      matches,
      count: hits.length,
      uniqueCount: new Set(hits.map((e) => e.name)).size,
      truncated: hits.length > matches.length,
      deduped: dedupe,
      definedOnly,
      defined: syms.defined,
      total: syms.total,
      note: syms.note,
    };
  });
}

/**
 * Which function contains a virtual address.
 *
 * Only defined, address-bearing symbols are considered. Imported symbols carry
 * `n_value == 0`, so including them makes any low address resolve to an import
 * sitting at zero — a confident, plausible, wrong answer, and the single worst
 * failure mode this project has produced.
 */
function lookupAddress(path, vaddr, { arch } = {}) {
  const target = typeof vaddr === 'bigint' ? vaddr : BigInt(vaddr);
  return withFile(path, (f) => {
    const slice = symbolSlice(f, arch);
    const syms = readSymbols(f, slice.offset, slice.thin);
    const defs = syms.entries.filter((e) => e.defined && e.addr !== 0n).sort(byAddr);

    if (defs.length === 0) {
      return {
        arch: slice.arch, vaddr: target, function: null, start: null, next: null,
        offset: null, size: null, aliases: null,
        note: 'no defined symbols in this slice — stripped, or a dyld-cache stub',
      };
    }

    // Last defined symbol at or below the target. Note that this alone cannot tell
    // a real answer from a fabricated one; the coverage guard below is what makes
    // the result trustworthy outside the mapped range.
    let lo = 0;
    let hi = defs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (defs[mid].addr <= target) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) {
      return {
        arch: slice.arch, vaddr: target, function: null, start: null, next: null,
        offset: null, size: null, aliases: null,
        note: 'no defined symbol at or below this address',
      };
    }

    // Walk back over aliases sharing this name, so the reported start is the
    // real function entry rather than whichever alias the table ordered first.
    let at = best;
    while (at > 0 && defs[at - 1].name === defs[best].name) at--;
    const start = defs[at].addr;
    const next = defs[best + 1] ? defs[best + 1].addr : null;

    // Whether this slice maps the target at all — checked here, after the
    // search, because the search alone cannot tell a real answer from a
    // fabricated one.
    //
    // A symbol table records where code *starts*, not where the slice *ends*, so
    // "the last symbol at or below the target" is a real answer only while the
    // target is inside the mapped range. Past the end it is a guess: every
    // address above the last symbol resolved to that last symbol, so
    // `0xffffffffffffffff` came back as `_runtime.enoptrbss` at an offset of
    // `0xfffffffefd35fc3f`. A wrong offset is worse than a missing one, because
    // it looks like a measurement. `findCalls` and `mapLiteral` already ask this
    // question, so skipping it here made the three disagree about one address in
    // one binary.
    //
    // `target === start` is exempt, and the exemption is load-bearing. A BSS
    // symbol can sit exactly at the end of its segment — in Go's `go`,
    // `_runtime.enoptrbss` is at `0x102ca03c0`, which is precisely
    // `__DATA.vmaddr + __DATA.vmsize` and therefore one past the last mapped
    // byte. That address is a real function entry and must still resolve;
    // guarding before the search rejected it and turned a correct answer into a
    // negative one. So: a symbol's own entry point always resolves, and coverage
    // only decides the addresses *between* and *beyond* symbols.
    if (target !== start && !coversAddress(slice.thin, target)) {
      return {
        arch: slice.arch, vaddr: target, function: null, start: null, next: null,
        offset: null, size: null, aliases: null,
        note: 'address is not mapped by this slice — nothing here to resolve',
      };
    }

    // Other symbols starting at exactly this address, when the answer is not the
    // only one.
    const aliases = symbolsStartingAt(defs, target, defs[at].name);

    return {
      arch: slice.arch, vaddr: target, function: defs[at].name, start, next,
      offset: target - start, size: next === null ? null : next - start,
      aliases: aliases.length ? aliases : null, note: null,
    };
  });
}

/**
 * Distinct names, other than `chosen`, that start at exactly `target`.
 *
 * Several symbols sharing one address is ordinary, not exotic. Go's linker
 * writes zero-size region markers next to real symbols — in `go`,
 * `_go:buildid` and `_runtime.text` both sit at `0x100001000`, and four symbols
 * share `0x10091ac0`-style addresses — and a C library may alias an implementation
 * under several names.
 *
 * `nlist_64` carries no size field, so nothing in the symbol table distinguishes
 * a zero-size marker from a real function. Picking one name and reporting a
 * `size` derived from the next unrelated symbol therefore presents a linker
 * bookkeeping entry as a function of 112 bytes. That is the same defect as a
 * fabricated offset: a number shaped like a measurement that no one measured.
 * So the answer keeps its choice — deterministic, and a symbol that genuinely
 * starts here — and discloses the alternatives rather than implying it is the
 * only one.
 *
 * `defs` is sorted by address, so equal addresses are contiguous and the run is
 * found by a lower-bound search plus a walk. Bounded by the size of the run, not
 * by the table.
 */
function symbolsStartingAt(defs, target, chosen) {
  let lo = 0;
  let hi = defs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (defs[mid].addr < target) lo = mid + 1;
    else hi = mid;
  }
  const names = [];
  for (let i = lo; i < defs.length && defs[i].addr === target; i++) {
    const name = defs[i].name;
    if (name !== chosen && names[names.length - 1] !== name) names.push(name);
  }
  return names;
}

const byAddr = (a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0);

/* ------------------------------------------------------------------ *
 * call sites
 * ------------------------------------------------------------------ */

/** The direct-call encoding for an architecture, or null if unknown. */
function callEncoding(arch) {
  if (arch.startsWith('x86_64') || arch.startsWith('i386')) return 'x86 rel32';
  if (arch.startsWith('arm64') || arch === 'arm') return 'arm64 BL';
  return null;
}

/**
 * Direct `call`/`jmp` sites resolving to `target`, across every slice.
 *
 * ## Typed by default, and that is the whole point
 *
 * The scan covers only sections whose attributes mark them as instructions. The
 * earlier version swept all of `__text`, which is not entirely code — it also
 * carries `__cstring`, `__const`, `__literal4`, jump tables and padding. Any of
 * those can hold four bytes that decode as a `call rel32` aimed at the address
 * you asked about, and each was reported as a call site. The output read as a
 * caller list and was partly fiction.
 *
 * `includeData: true` restores the old sweep, for when the data sections are
 * exactly what you are hunting. `typed` in the result says which you got, and
 * `untypedFallback` says the slice marked no section as instructions at all —
 * a rare and slightly worrying input, where reporting zero call sites would be
 * the confident-wrong-answer failure this project keeps producing.
 *
 * ## What is still not found
 *
 * Indirect calls, register calls and jumps through a PLT stub do not encode
 * their target in the instruction, so they cannot appear here. Every hit is a
 * site *worth disassembling*, not a proven call-graph edge.
 */
function findCalls(path, target, { arch, includeData = false, max = 0, __textRelative = false } = {}) {
  const given = typeof target === 'bigint' ? target : BigInt(target);
  return withFile(path, (f) => {
    const hits = [];
    const slices = [];
    const unsupported = [];
    // Named separately from `slices[].skipped` so a caller can branch on
    // "there was code here I could not read" without walking the per-slice
    // records — the same reason `unsupported` exists for architectures.
    const encryptedSlices = [];
    let scanned = 0;

    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      if (!thin) continue;
      const name = s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype);
      if (arch && name !== arch) continue;

      const enc = callEncoding(name);
      if (!enc) { unsupported.push(name); continue; }

      const pool = sectionPool(thin, includeData);
      // The slice's `__TEXT` base. In corpus mode this is what the caller's offset is
      // measured from, and it is reported so a resolved address can be read against
      // the base it came from rather than in isolation.
      //
      // The *segment's* `vmaddr`, not `textSection().addr` — `__text` is the first
      // thing after the header inside `__TEXT`, and those differ by the header size.
      // A corpus offset has to be measured from the same origin in every file, and
      // the segment is what the loader maps at a fixed address.
      const textSeg = thin.segments?.find((g) => g.segname === '__TEXT') ?? null;
      const textBase = textSeg ? textSeg.vmaddr : null;
      // `__textRelative` rebases the caller's offset onto *this* slice, because a
      // single number has to mean the same function in every file of a corpus. Each
      // slice rebases independently, so a fat binary's two slices can have different
      // answers for the same offset and both are reported.
      const want = __textRelative && textBase !== null ? textBase + given : given;
      const record = {
        arch: name,
        encoding: enc,
        typed: !pool.widened,
        untypedFallback: pool.fallback,
        textBase,
        target: want,
        sections: [],
        scanned: 0,
        skipped: null,
      };

      // An encrypted slice is not a slice with no callers. App Store binaries
      // ship with `__TEXT` encrypted, so every byte this would scan is
      // ciphertext: the scan returns zero, and zero reads as "nothing calls
      // this". That is a claim about code that was never readable, which is the
      // exact failure this project treats as worse than an error.
      //
      // Checked before the target-mapping test, because "encrypted" explains the
      // result on its own and a caller should not have to distinguish it from a
      // target that happens to be unmapped.
      if (thin.encryption && thin.encryption.cryptid !== 0) {
        record.skipped =
          `slice is encrypted (cryptid=${thin.encryption.cryptid}, ` +
          `${thin.encryption.cryptsize} bytes of ciphertext from file offset ` +
          `${thin.encryption.cryptoff}) — code sections are not readable, so no ` +
          `scan result here is meaningful`;
        encryptedSlices.push(name);
        slices.push(record);
        continue;
      }

      // Whether the *target* is in this slice at all — a slice that cannot
      // contain the destination cannot hold a call to it, and saying so is not
      // the same as scanning and finding nothing.
      //
      // Note what this check is NOT: filtering the scanning sections by whether
      // they contain the target. A caller and its callee usually live in
      // different places, so that reading skips every section that could hold a
      // real call site and reports zero for a function that is demonstrably
      // called thousands of times.
      if (!coversAddress(thin, want)) {
        record.skipped =
          `target 0x${want.toString(16)} is not mapped in this slice — skipped`;
        slices.push(record);
        continue;
      }

      for (const sec of pool.sections) {
        record.sections.push({
          name: `${sec.segname},${sec.sectname}`, addr: sec.addr, size: sec.size,
        });
        record.scanned += scanSection(f, sec, name, enc, want, hits, s.offset);
      }
      scanned += record.scanned;
      if (record.sections.length === 0) {
        record.skipped = 'this slice has no non-empty code section to scan';
      }
      slices.push(record);
    }

    hits.sort(byAddr);
    return {
      target: given,
      // What was actually asked, per slice. Equal to `target` outside corpus mode;
      // in corpus mode each slice rebased the offset onto its own `__TEXT`, so there
      // is no single answer to report and `slices[].target` is the honest place for it.
      queryMode: __textRelative ? 'text-relative' : 'vaddr',
      hits: max > 0 ? hits.slice(0, max) : hits,
      count: hits.length,
      truncated: max > 0 && hits.length > max,
      scanned,
      slices,
      unsupported,
      encryptedSlices,
      // True when every slice that could have held an answer was unreadable. The
      // distinction matters at the exit code: zero hits from a slice that was
      // scanned is "found nothing", and zero from an encrypted one is "could not
      // look", which the contract says must not be reported the same way.
      unreadable: encryptedSlices.length > 0 && scanned === 0,
      typed: !includeData,
    };
  });
}

/**
 * The distinct addresses a binary calls or jumps to directly.
 *
 * This inverts `findCalls`, and it is also the only honest way to tell a working
 * scanner from a dead one: a broken scanner and a scanner that legitimately
 * found no caller of *one* address look identical, but only one of them
 * produces an empty *target* list for a whole binary.
 */
function listCallTargets(path, { arch, includeData = false, minSites = 0 } = {}) {
  return withFile(path, (f) => {
    const counts = new Map();
    const slices = [];
    const unsupported = [];
    let scanned = 0;

    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      if (!thin) continue;
      const name = s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype);
      if (arch && name !== arch) continue;
      const enc = callEncoding(name);
      if (!enc) { unsupported.push(name); continue; }

      const pool = sectionPool(thin, includeData);
      let sliceScanned = 0;
      // The same mapped-range gate `findCalls` applies. A `rel32` is signed, so
      // from a high address it can decode to a destination that falls in no
      // section and no segment at all — pure arithmetic on bytes that were never
      // an instruction. Counting those makes the target list look busy and
      // disagrees with what `findCalls` reports for the same binary, which is
      // the kind of disagreement a caller cannot reason about.
      const mapped = (v) => coversAddress(thin, v);
      for (const sec of pool.sections) sliceScanned += tallySection(f, sec, enc, counts, s.offset, mapped);
      scanned += sliceScanned;
      slices.push({
        arch: name, encoding: enc, typed: !pool.widened,
        untypedFallback: pool.fallback, scanned: sliceScanned,
      });
    }

    const targets = [...counts.entries()]
      .filter(([, n]) => n >= minSites)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([dest, sites]) => ({ dest, sites }));
    return { targets, total: targets.length, scanned, slices, unsupported, typed: !includeData };
  });
}

/**
 * The sections a call scan should cover.
 *
 * `includeData` deliberately widens to *every* non-empty section, data included.
 * That is the old behaviour and it is available on request, not on by default.
 */
function sectionPool(thin, includeData) {
  if (includeData) {
    return { sections: thin.sections.filter((s) => s.size > 0), fallback: false, widened: true };
  }
  return codeSections(thin);
}

/**
 * True when `vaddr` falls inside anything this slice maps.
 *
 * Sections first, then segments, because a section is a subset of a segment and
 * the segment is what covers the gaps — `__PAGEZERO`, and the tail of a segment
 * past its last section. A target in the former is unreachable by a direct
 * branch; one in the latter might be.
 */
function coversAddress(thin, vaddr) {
  for (const s of thin.sections) {
    if (vaddr >= s.addr && vaddr < s.addr + BigInt(s.size)) return true;
  }
  for (const s of thin.segments) {
    if (vaddr >= s.vmaddr && vaddr < s.vmaddr + s.vmsize) return true;
  }
  return false;
}

/**
 * Scan one section for direct calls to `want`. Returns bytes scanned.
 *
 * `sliceBase` is the slice's file offset, and it is required. A `section_64`'s
 * `offset` is relative to the start of its *slice*, not to the start of the
 * file — so on a universal binary every read has to add the slice base. Omitting
 * it does not crash and does not return nothing: it reads the right *number* of
 * bytes from the wrong place, and finds whatever call encodings happen to sit
 * there. The system binaries this project was tested against were thin or had
 * their first slice near enough to the file start to make the mistake hard to
 * notice, which is why a generated fat fixture with slices at known offsets
 * found it and `/usr/bin/true` never did.
 */
function scanSection(f, sec, arch, enc, want, hits, sliceBase) {
  const CHUNK = 1 << 24;
  const label = `${sec.segname},${sec.sectname}`;
  let scanned = 0;
  let pos = 0;

  while (pos < sec.size) {
    const buf = f.read(sliceBase + sec.offset + pos, Math.min(CHUNK, sec.size - pos));
    if (buf.length === 0) break;
    scanned += buf.length;
    const base = sec.addr + BigInt(pos);

    if (enc === 'x86 rel32') {
      for (const op of [0xe8, 0xe9]) {
        let i = buf.indexOf(op);
        while (i !== -1 && i + 5 <= buf.length) {
          const rel = BigInt(buf.readInt32LE(i + 1));
          if (base + BigInt(i) + 5n + rel === want) {
            hits.push({ addr: base + BigInt(i), kind: op === 0xe8 ? 'call' : 'jmp', arch, section: label });
          }
          i = buf.indexOf(op, i + 1);
        }
      }
    } else {
      // 4 bytes at a time, so only aligned `BL`s are considered.
      for (let i = 0; i + 4 <= buf.length; i += 4) {
        const insn = buf.readUInt32LE(i);
        // `>>> 0`: `&` alone yields a *signed* int32 and 0x94000000 is above 2^31,
        // so both sides go negative and the mask never matches. That bug kept
        // the arm64 path a confident zero for its entire life.
        if (((insn & 0xfc000000) >>> 0) !== 0x94000000) continue;
        let imm = insn & 0x03ffffff;
        if (imm & 0x02000000) imm -= 0x04000000; // sign-extend from 26 bits
        const site = base + BigInt(i);
        if (site + (BigInt(imm) << 2n) === want) {
          // `BL` is branch-with-link: it *calls*, unlike the x86 `jmp` sharing
          // its opcode byte.
          hits.push({ addr: site, kind: 'BL', arch, section: label });
        }
      }
    }

    // Four displacement bytes follow the opcode, so a 4-byte overlap catches a
    // straddling instruction. Unlike `len - 5` this cannot exceed `len`, so it
    // cannot stop advancing on a short final chunk and hang the tool.
    const advance = buf.length - 4;
    pos += advance > 0 ? advance : buf.length;
    if (advance <= 0) break;
  }
  return scanned;
}

/**
 * Tally every direct-call destination in one section. Returns bytes scanned.
 *
 * `sliceBase` for the same reason as `scanSection`: a section's file offset is
 * slice-relative, and reading without the base reads the wrong bytes while
 * looking like it worked.
 *
 * `mapped` is the predicate deciding whether a decoded destination is an address
 * this slice maps at all.
 */
function tallySection(f, sec, enc, counts, sliceBase, mapped) {
  const CHUNK = 1 << 24;
  let scanned = 0;
  let pos = 0;
  while (pos < sec.size) {
    const buf = f.read(sliceBase + sec.offset + pos, Math.min(CHUNK, sec.size - pos));
    if (buf.length === 0) break;
    scanned += buf.length;
    const base = sec.addr + BigInt(pos);
    if (enc === 'x86 rel32') {
      for (const op of [0xe8, 0xe9]) {
        let i = buf.indexOf(op);
        while (i !== -1 && i + 5 <= buf.length) {
          const dest = base + BigInt(i) + 5n + BigInt(buf.readInt32LE(i + 1));
          if (mapped(dest)) counts.set(dest, (counts.get(dest) || 0) + 1);
          i = buf.indexOf(op, i + 1);
        }
      }
    } else {
      for (let i = 0; i + 4 <= buf.length; i += 4) {
        const insn = buf.readUInt32LE(i);
        if (((insn & 0xfc000000) >>> 0) !== 0x94000000) continue;
        let imm = insn & 0x03ffffff;
        if (imm & 0x02000000) imm -= 0x04000000;
        const dest = base + BigInt(i) + (BigInt(imm) << 2n);
        if (mapped(dest)) counts.set(dest, (counts.get(dest) || 0) + 1);
      }
    }
    const advance = buf.length - 4;
    pos += advance > 0 ? advance : buf.length;
    if (advance <= 0) break;
  }
  return scanned;
}

/* ------------------------------------------------------------------ *
 * literals
 * ------------------------------------------------------------------ */

/**
 * Find a byte literal, in the whole file by default.
 *
 * The whole file, not `__TEXT`: a format magic can just as easily sit in
 * `__DATA` or be embedded in code, and can exist in one slice of a universal
 * binary but not the other. `textOnly: true` restricts the sweep to `__TEXT`,
 * which is far cheaper when you already know it is there.
 *
 * Each hit carries its slice, its vaddr where the slice maps one, its section
 * and the bytes around it. That combination usually distinguishes a string from
 * a pointer table from bytes that happen to sit inside an instruction, without
 * opening a disassembler.
 */
function findLiteral(path, literal, { textOnly = false, arch, max = 0 } = {}) {
  const needle = Buffer.isBuffer(literal) ? literal : Buffer.from(String(literal), 'latin1');
  return withFile(path, (f) => {
    const slices = [];
    const hits = [];
    // Slices carrying an `LC_ENCRYPTION_INFO` with a non-zero `cryptid`, and the
    // subset of those whose ciphertext actually overlaps the searched range.
    // Kept apart because "this slice is encrypted" and "the bytes I searched
    // were ciphertext" are different facts, and only the second one qualifies a
    // zero result.
    const encryptedSlices = [];
    const searchedCiphertext = [];
    let scanned = 0;
    // `--arch` bookkeeping. `matched` is whether any slice satisfied the request;
    // `fallback` is the first slice that did not, kept so an unsatisfiable
    // request still produces a real answer. Both are needed and they are
    // different questions — a universal binary with `--arch=arm64` has one
    // matching and one non-matching slice, and recording "wanted = true" for the
    // second would report the request as unsatisfied.
    let matched = false;
    let fallback = null;

    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      if (!thin) continue;
      const name = s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype);
      // `arch` is a preference, not a filter, and this tool now matches the
      // other five: a named slice wins if present, otherwise the richest slice is
      // read anyway. Filtering instead would report a usage mistake — an absent
      // architecture — as "the magic is not in this file", which is a claim
      // about the bytes that happens to be false. Verified: `--arch=riscv`
      // against /bin/ls searches a slice, and says which.
      if (arch && !archMatches(name, arch)) {
        if (!fallback) fallback = { s, thin, name }; // first non-matching slice
        continue;
      }
      if (arch) matched = true;
      const text = textSection(thin);
      const textLo = text ? s.offset + text.offset : 0;
      const textHi = text ? textLo + text.size : 0;

      const from = textOnly && text ? textLo : s.offset;
      const to = textOnly && text ? textHi : s.offset + s.size;

      // An App Store binary encrypts the whole of `__TEXT`, which is where
      // `__cstring` lives, so a literal search over an encrypted slice is a
      // search over ciphertext. The bytes are still scanned — they are what is
      // in the file, and a caller may legitimately be looking for a signature or
      // a ciphertext marker — but the *result* is qualified, because zero hits
      // from encrypted bytes does not mean the string is absent.
      const crypt = thin.encryption && thin.encryption.cryptid !== 0 ? thin.encryption : null;
      if (crypt) {
        encryptedSlices.push(name);
        // Whether the encrypted range actually overlaps what will be searched.
        // Stating the overlap rather than the mere presence of the command keeps
        // the note honest for a binary whose ciphertext is elsewhere.
        const lo = s.offset + crypt.cryptoff;
        const hi = lo + crypt.cryptsize;
        if (hi > from && lo < to) searchedCiphertext.push(name);
      }

      const found = searchRange(f, needle, from, to);
      scanned += to - from;
      slices.push({
        arch: name, offset: s.offset, size: s.size, from, to, hits: found.length,
        encrypted: crypt ? true : null,
      });

      for (const off of found) {
        const inText = text && off >= textLo && off < textHi;
        const sec = sectionOf(thin, off - s.offset);
        hits.push({
          off,
          slice: name,
          inText,
          vaddr: inText
            ? text.addr + BigInt(off - textLo)
            : toVaddr(thin, off - s.offset)?.vaddr ?? null,
          section: sec ? `${sec.segname},${sec.sectname}` : null,
          context: contextAround(f, off, 16, 8),
        });
      }
    }
    hits.sort((a, b) => a.off - b.off);
    // No slice matched `--arch`: read one anyway rather than report nothing, and
    // say so. Refusing would turn a mistyped architecture into "the magic is not
    // in this file", which is a statement about the bytes and is false.
    if (arch && !matched && fallback && !slices.length) {
      const { s, thin, name } = fallback;
      const text = textSection(thin);
      const textLo = text ? s.offset + text.offset : 0;
      const textHi = text ? textLo + text.size : 0;
      const from = textOnly && text ? textLo : s.offset;
      const to = textOnly && text ? textHi : s.offset + s.size;
      const found = searchRange(f, needle, from, to);
      scanned += to - from;
      slices.push({ arch: name, offset: s.offset, size: s.size, from, to, hits: found.length });
      for (const off of found) {
        const inText = text && off >= textLo && off < textHi;
        const sec = sectionOf(thin, off - s.offset);
        hits.push({
          off, slice: name, inText,
          vaddr: inText ? text.addr + BigInt(off - textLo) : toVaddr(thin, off - s.offset)?.vaddr ?? null,
          section: sec ? `${sec.segname},${sec.sectname}` : null,
          context: contextAround(f, off, 16, 8),
        });
      }
      hits.sort((a, b) => a.off - b.off);
    }
    return {
      literal: needle.toString('latin1'),
      hex: needle.toString('hex'),
      hits: max > 0 ? hits.slice(0, max) : hits,
      count: hits.length,
      truncated: max > 0 && hits.length > max,
      scanned,
      slices,
      textOnly,
      // `arch` is what was asked for. `archHonoured` is that value when a slice
      // satisfied it and `null` when none did — so a caller can tell "you got the
      // slice you asked for" from "you got a slice anyway, and it was not this
      // one" without re-deriving it from `archRead`. `archRead` is the ground
      // truth: what actually answered.
      arch: arch ?? null,
      archHonoured: arch && matched ? arch : null,
      archRead: slices.map((x) => x.arch),
      // Which slices carry ciphertext, and which of those had it inside the
      // range actually searched. A zero count over `searchedCiphertext` is not
      // evidence the literal is absent, and the caller cannot work that out from
      // the count alone.
      encryptedSlices,
      searchedCiphertext,
    };
  });
}

/**
 * NUL-terminated strings in the C-string sections, with where each one loads.
 *
 * ## Why this is not `findLiteral` with a different argument
 *
 * `findliteral` searches for bytes the caller already knows. This finds strings
 * nobody has to know in advance, which is the other direction: the __cstring
 * section of a binary is a table of things it says, and reading it needs no
 * prior hypothesis. `ipsw macho info --strings` prints cstrings too, so this is
 * not a capability it lacks — the difference is that every string here carries
 * its **file offset, virtual address and owning section**, which is what makes a
 * string actionable rather than merely visible. A string you cannot address is
 * a string you cannot hand to `symlookup` or `mapliteral`.
 *
 * ## What counts as a string
 *
 * A run of at least `min` printable bytes terminated by NUL. Deliberately not
 * UTF-8 validation: a C string is a byte sequence between NULs, and rejecting
 * anything that is not valid UTF-8 would silently drop the Swift and ObjC
 * material that lives in `__cstring` and is full of non-ASCII.
 *
 * @param {string} path
 * @param {object}  [opts]
 * @param {string}  [opts.arch]    prefer this slice of a universal binary
 * @param {number}  [opts.min]     shortest string to report (default 4)
 * @param {number}  [opts.max]     cap on results (default unlimited)
 * @param {string}  [opts.filter]  substring a string must contain
 */
function findStrings(path, { arch, min = 4, max = 0, filter = null } = {}) {
  return withFile(path, (f) => {
    const slices = [];
    const strings = [];
    // The string sections whose bytes are ciphertext on this binary. A zero
    // count over these is not a binary with no strings.
    const encryptedSections = [];
    let scanned = 0;

    // `layoutSlices` rather than `slicesOf`, and this is a fix rather than a
    // preference: the loop used to walk `slicesOf(f)`, so `--arch` narrowed
    // nothing while the returned `arch` field echoed the request straight back.
    // `findStrings(bin, {arch:'arm64'})` reported `arch: 'arm64'` having read
    // *every* slice — a caller asking one architecture's strings could not tell
    // that from having been given them. `findLiteral` already reports
    // `archHonoured`/`archRead` for this and gets it right; these are the same
    // two fields for the same reason.
    const layouts = layoutSlices(f, arch);
    const honoured = arch && layouts.some((l) => l.arch === arch) ? arch : null;

    for (const l of layouts) {
      const s = { offset: l.offset, thin: l.thin, cputype: l.thin.cputype };
      const thin = l.thin;
      const name = l.arch;

      // The C-string sections. `__cstring` is the real one; `__cfstring` is
      // CFString literals, whose pointers are 32 bytes of structure rather than
      // text, so including it would report addresses as if they were strings.
      // `__objc_methname` and `__swift5_reflstr` *are* NUL-terminated text and
      // are exactly what someone reversing a binary wants, so they are included
      // and labelled, not filtered out.
      const wanted = CSTRING_SECTIONS.filter((n) => thin.sections.some((x) => x.sectname === n));

      // An App Store binary encrypts the `__TEXT` segment, and `__cstring` lives
      // inside it — so the string sections are ciphertext, and scanning them
      // returns zero for a binary that is full of strings. Recorded per slice and
      // checked against the sections actually read, so the note is only raised
      // when the encryption really does cover them.
      const crypt = thin.encryption && thin.encryption.cryptid !== 0 ? thin.encryption : null;
      const cryptRange = crypt
        ? [s.offset + crypt.cryptoff, s.offset + crypt.cryptoff + crypt.cryptsize]
        : null;

      if (!wanted.length) {
        slices.push({ arch: name, offset: s.offset, size: s.size, sections: [], strings: 0, scanned: 0 });
        continue;
      }

      let found = 0;
      for (const sec of thin.sections) {
        if (!CSTRING_SECTIONS.includes(sec.sectname) || sec.size === 0) continue;
        const lo = s.offset + sec.offset;
        // A section's bytes can run past the end of the file when the linker
        // recorded a size it did not write — zero-fill tail, or a truncated
        // binary. Clamped rather than trusted, because reading past the end
        // here would throw in the middle of an otherwise good answer.
        const hi = Math.min(lo + sec.size, f.size);
        if (hi <= lo) continue;
        const buf = f.read(lo, hi - lo);
        scanned += buf.length;
        // Does the ciphertext cover this section? Stated per section rather than
        // per slice, because "the binary is encrypted" and "these strings were
        // unreadable" are different claims and only the second explains a zero.
        if (cryptRange && cryptRange[1] > lo && cryptRange[0] < hi) {
          encryptedSections.push(`${sec.segname},${sec.sectname}`);
        }

        const label = `${sec.segname},${sec.sectname}`;
        // Walk NUL-delimited runs rather than regexing the whole buffer, so the
        // offset of each string is known exactly instead of inferred from a
        // match index plus the preceding terminator.
        let start = 0;
        while (start < buf.length) {
          const end = buf.indexOf(0, start);
          const stop = end === -1 ? buf.length : end;
          if (stop - start >= min) {
            const raw = buf.subarray(start, stop);
            const text = raw.toString('latin1');
            if (printable(raw) && (!filter || text.includes(filter))) {
              strings.push({
                off: lo + start,
                slice: name,
                vaddr: sec.addr + BigInt(start),
                section: label,
                length: stop - start,
                text,
              });
              found++;
            }
          }
          if (end === -1) break;
          start = end + 1;
        }
        slices.push({ arch: name, offset: s.offset, size: s.size, sections: wanted, strings: found, scanned: buf.length });
      }
    }

    strings.sort((a, b) => a.off - b.off);
    const capped = max > 0 ? strings.slice(0, max) : strings;
    return {
      arch: arch ?? null,
      // Same pair, same meaning as `findLiteral`: `arch` is what was asked for,
      // `archHonoured` is that value only when a slice satisfied it, and
      // `archRead` is the ground truth of what actually answered.
      archHonoured: honoured,
      archRead: slices.map((x) => x.arch),
      min,
      count: strings.length,
      truncated: capped.length < strings.length,
      strings: capped,
      scanned,
      slices,
      sections: CSTRING_SECTIONS,
      // Non-empty when a string section was ciphertext. `--strings` on an
      // encrypted App Store binary must not read as "this binary has no
      // strings", which is what a bare zero says.
      encryptedSections,
    };
  });
}


/**
 * Section names whose contents are NUL-terminated text.
 *
 * A list rather than a hardcoded `__cstring` check because a Go binary keeps
 * its strings in `__cstring` but Swift and Objective-C put method names and
 * reflection records in their own named sections, and a tool that only looked at
 * `__cstring` would report an ObjC binary as having no strings in it — which is
 * the kind of wrong-looking-right answer this project keeps refusing to give.
 */
const CSTRING_SECTIONS = ['__cstring', '__objc_methname', '__swift5_reflstr', '__objc_classname'];

/** Every byte printable or tab/newline — the check that keeps binary noise out. */
function printable(b) {
  for (const c of b) {
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return b.length > 0;
}

/**
 * Map a literal to its addresses, then find what *points at* those addresses.
 *
 * This is the tool with a purpose rather than a mechanism. A magic in read-only
 * data is only a label; the pointer tables hanging off it are the handler
 * table, and locating those is how you find the code that dispatches on a
 * format without disassembling anything.
 *
 * `offsets` overrides the literal search, for when the magic is assembled at
 * runtime and so never appears contiguously — the same reason `findCalls`
 * cannot see indirect calls. Slice choice is by symbol richness or `arch`, and
 * an absent architecture is a preference rather than a requirement, so this no
 * longer fails outright on an arm64-only binary.
 */
function mapLiteral(path, literal, { arch, offsets = null, maxPointers = 40 } = {}) {
  const needle = Buffer.from(String(literal), 'latin1');
  return withFile(path, (f) => {
    const parsed = [];
    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      if (!thin) continue;
      const name = s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype);
      if (arch && name !== arch) continue;
      const text = textSection(thin);
      const inText = text
        ? searchRange(f, needle, s.offset + text.offset, s.offset + text.offset + text.size)
        : [];
      // Search all sections, not just __TEXT — a literal in __cstring is still a
      // literal, and the pointers to it are what the caller wants. The section
      // name is reported per hit so the caller can tell a code immediate from
      // a string in __cstring.
      const inAllSections = [];
      for (const sec of thin.sections || []) {
        const hits = searchRange(f, needle, s.offset + sec.offset, s.offset + sec.offset + sec.size);
        for (const hit of hits) inAllSections.push({ offset: hit, section: `${sec.segname},${sec.sectname}` });
      }
      const syms = readSymbols(f, s.offset, thin);
      parsed.push({
        name, s, thin, text, nsyms: syms.total, inText, inAllSections,
        report: { arch: name, offset: s.offset, size: s.size, inText: inText.length, inAllSections: inAllSections.length, nsyms: syms.total },
      });
    }
    if (parsed.length === 0) throw new Error('no Mach-O slice could be parsed');

    let best = parsed[0];
    for (const p of parsed) if (p.nsyms > best.nsyms) best = p;

    const given = offsets && offsets.length ? offsets.map(Number) : null;
    let abs;
    if (given) {
      // Offsets are file-absolute. Someone recording one by hand from
      // `findliteral` output has an absolute offset, and normalising a relative
      // one here would be a guess about which they meant.
      abs = given;
    } else {
      // Search all sections, not just __TEXT. A literal in __cstring is still a
      // literal, and the pointers to it are what the caller wants.
      abs = [];
      for (const sec of best.thin.sections || []) {
        const hits = searchRange(f, needle, best.s.offset + sec.offset, best.s.offset + sec.offset + sec.size);
        abs.push(...hits);
      }
    }

    const locations = abs.map((o) => mapOne(best, o, f));
    const mapped = locations.filter((l) => l.vaddr !== null);
    for (const m of mapped) {
      const ptr = Buffer.alloc(8);
      ptr.writeBigUInt64LE(m.vaddr);
      m.pointers = [];
      // The pointer search is whole-file while the literal search is per-slice,
      // so a pointer has to be attributed through *its own* slice's section
      // table. Resolving it against the chosen slice instead makes every pointer
      // in another slice unmapped — which is what an early version of this did,
      // and it reported the universal fixture's second descriptor table as
      // having no location at all.
      for (const off of searchRange(f, ptr, 0, f.size)) {
        const owner = parsed.find((p) => off >= p.s.offset && off < p.s.offset + p.s.size);
        const rel = off - (owner ? owner.s.offset : best.s.offset);
        const sec = (owner || best).thin.sections.find(
          (x) => rel >= x.offset && rel < x.offset + x.size,
        );
        m.pointers.push({
          off,
          slice: owner ? owner.name : null,
          vaddr: (owner || best).thin.segments.length
            ? toVaddr((owner || best).thin, rel)?.vaddr ?? null
            : null,
          section: sec ? `${sec.segname},${sec.sectname}` : null,
        });
        if (m.pointers.length >= maxPointers) break;
      }
      m.pointerCount = m.pointers.length;
      m.pointersTruncated = m.pointerCount >= maxPointers;
    }

    return {
      literal: needle.toString('latin1'),
      hex: needle.toString('hex'),
      arch: best.name,
      sliceOffset: best.s.offset,
      explicit: Boolean(given),
      locations: mapped,
      unmapped: locations.filter((l) => l.vaddr === null),
      slices: parsed.map((p) => p.report),
    };
  });
}

/** One literal occurrence resolved to a vaddr and its section. */
function mapOne(best, abs, f) {
  const sec = sectionOf(best.thin, abs - best.s.offset);
  const m = toVaddr(best.thin, abs - best.s.offset);
  return {
    off: abs,
    vaddr: m ? m.vaddr : null,
    section: m ? m.section : null,
    context: contextAround(f, abs, 64, 24),
    fileExtent: sec ? { offset: sec.offset, size: sec.size } : null,
    pointers: null,
  };
}

/* ------------------------------------------------------------------ *
 * assert
 * ------------------------------------------------------------------ */

/**
 * Evaluate a policy of "this must be here" and "this must not be" claims.
 *
 * `audit` gates a file on its *internal* consistency; this gates it on facts a
 * caller supplies. They answer different questions and a build usually wants
 * both: audit says the file is well-formed, and an assertion says it still
 * exports `_main` and still refuses to contain `__debugSummary`.
 *
 * ## Four predicates, one shape
 *
 *   has-symbol  a symbol with exactly this name is present (defined or imported)
 *   no-symbol   no symbol has this name
 *   has-string  some NUL-terminated string contains this text
 *   no-string   no NUL-terminated string contains this text
 *
 * `has-symbol`/`no-symbol` match the *whole* name, because a CI policy names a
 * symbol rather than a fragment of one, and a substring there would pass on
 * `_main_helper` when it was asked about `_main`. `has-string`/`no-string` match a
 * *substring*, because the useful claim is that a URL, an error message or a
 * format marker is present, and its surrounding string is not the point. Both
 * reads are the same ones `findliteral --strings` performs, over the same
 * sections, so a string the listing shows is a string this can assert.
 *
 * ## A failed assertion is an answer, not an error
 *
 * Every assertion returns pass/fail and the result carries `passed`. Nothing here
 * throws for a claim that did not hold: "the symbol is absent" is the answer the
 * caller asked for, and it belongs in `data`, not in `errors`. Only an unreadable
 * file is an error.
 *
 * @param {string} path
 * @param {Array<{kind: 'has-symbol'|'no-symbol'|'has-string'|'no-string', value: string}>} assertions
 * @param {object} [opts]
 * @param {string} [opts.arch]  evaluate only this slice of a universal binary
 */
function assertBinary(path, assertions, { arch = null } = {}) {
  return withFile(path, (f) => {
    const slice = layoutSlice(f, arch);
    const thin = slice.thin;
    const wantsSymbols = assertions.some((a) => a.kind === 'has-symbol' || a.kind === 'no-symbol');
    const wantsStrings = assertions.some((a) => a.kind === 'has-string' || a.kind === 'no-string');

    // Each source is read only when something asks about it. A policy made only
    // of string checks should not parse a symbol table, and on a large binary that
    // is the difference between a fast check and a slow one.
    let entries = null;
    if (wantsSymbols) entries = readSymbols(f, slice.offset, thin).entries;

    let strings = null;
    if (wantsStrings) {
      strings = [];
      for (const sec of thin.sections) {
        if (!CSTRING_SECTIONS.includes(sec.sectname) || sec.size === 0) continue;
        const lo = slice.offset + sec.offset;
        // A declared section can run past the file; clamped as in `findStrings`,
        // because reading past the end would throw in the middle of an otherwise
        // good answer.
        const hi = Math.min(lo + sec.size, f.size);
        if (hi <= lo) continue;
        const buf = f.read(lo, hi - lo);
        let start = 0;
        while (start < buf.length) {
          const end = buf.indexOf(0, start);
          const stop = end === -1 ? buf.length : end;
          if (stop > start) {
            const raw = buf.subarray(start, stop);
            if (printable(raw)) strings.push(raw.toString('latin1'));
          }
          if (end === -1) break;
          start = end + 1;
        }
      }
    }

    const results = assertions.map((a) => {
      if (a.kind === 'has-symbol' || a.kind === 'no-symbol') {
        const hit = entries.find((e) => e.name === a.value) ?? null;
        const pass = a.kind === 'has-symbol' ? hit !== null : hit === null;
        return {
          kind: a.kind,
          value: a.value,
          pass,
          detail: hit
            ? `${a.value} is ${hit.defined ? 'defined' : 'imported'}`
            : `${a.value} is not in the symbol table`,
        };
      }
      const hits = strings.filter((s) => s.includes(a.value));
      const pass = a.kind === 'has-string' ? hits.length > 0 : hits.length === 0;
      return {
        kind: a.kind,
        value: a.value,
        pass,
        detail: hits.length
          ? `found in ${hits.length} string(s)`
          : 'not found in any NUL-terminated string',
      };
    });

    const failed = results.filter((r) => !r.pass);
    return {
      path,
      arch: slice.arch,
      passed: failed.length === 0,
      count: results.length,
      failed: failed.length,
      assertions: results,
    };
  });
}

/* ------------------------------------------------------------------ *
 * audit
 * ------------------------------------------------------------------ */

/**
 * Is this file internally consistent? Every structural check, in one call.
 *
 * ## Why this is a function and not a report
 *
 * `describe` already carries per-slice `abnormalities`, but a report is not a
 * gate. The difference matters commercially as well as technically: `describe`
 * answers "what is in this file" for a person, while this answers "may I ship
 * this" for a build — and a build needs an exit status, a single verdict, and the
 * ability to choose how strict to be. Reporting three warnings on every binary
 * built by a newer Xcode is fine for a log and useless for a gate, which is why
 * severity is a first-class field rather than something the caller has to infer
 * from the `kind` string.
 *
 * ## The three outcomes
 *
 * `verdict` is one of:
 *
 *   `ok`       — no findings at the requested strictness
 *   `warnings` — warnings only, and `strict` was not asked for
 *   `failed`   — at least one error, or any finding at all under `strict`
 *
 * Both non-`ok` verdicts are *negative answers*, not errors, which is what lets the
 * CLI map them to exit 1 rather than to the "could not do the job" code. An audit
 * that found nothing wrong is a successful run; an audit that found something
 * wrong is also a successful run, and reports it.
 *
 * ## What is deliberately not a finding
 *
 * Unknown *load commands*. `describe --loads` already names those by number, on
 * purpose: an unfamiliar-but-valid command is present, not broken. Grading it as
 * damage would make this gate fire on every binary from a newer linker, which is
 * how gates get switched off.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {string} [opts.arch]    audit only this slice of a universal binary
 * @param {boolean} [opts.strict] treat warnings as failures too
 * @returns {object} always succeeds for a readable Mach-O; throws only when the
 *   file cannot be read at all, so "unreadable" stays distinguishable from
 *   "unsound"
 */
function audit(path, { arch = null, strict = false } = {}) {
  return withFile(path, (f) => {
    const slices = [];
    const containerAbnormalities = detectContainerAbnormalities(f);

    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      const name = s.thin
        ? sliceArchName(thin?.cputype, thin?.cpusubtype)
        : sliceArchName(s.cputype, s.cpusubtype);
      // `--arch` is a filter here rather than the preference it is everywhere else,
      // and the difference is deliberate: the other tools answer a question about
      // a *slice*, where falling back to another architecture would be wrong. This
      // one answers "is this file sound", and a fat binary's soundness is a
      // property of the whole file — so an `--arch` request selects which slices
      // contribute, and the container findings are still reported because they are
      // about the file rather than about a slice. The result says which slices
      // were considered, so a caller cannot mistake a narrow audit for a whole-file
      // one.
      if (arch && !archMatches(name, arch)) continue;
      if (!thin) {
        slices.push({
          arch: name,
          offset: s.offset,
          size: s.size,
          readable: false,
          // A slice with no header is not merely unreadable, it is a container
          // claiming bytes that are not a Mach-O. That is a finding, not a skip:
          // silently omitting it would let `audit` pass a file whose fat table
          // points at nothing.
          abnormalities: [{
            kind: 'no-mach-o-header',
            severity: 'error',
            detail: `no Mach-O header at file offset ${s.offset} — the fat table points at bytes that are not a Mach-O`,
          }],
        });
        continue;
      }
      slices.push({
        arch: name,
        offset: s.offset,
        size: s.size,
        readable: true,
        ncmds: thin.ncmds,
        nsects: thin.sections.length,
        nsyms: thin.symtab ? thin.symtab.nsyms : 0,
        abnormalities: detectAbnormalities(f, thin, { sliceOffset: s.offset, sliceSize: s.size }),
      });
    }

    // Counts computed from the findings rather than accumulated alongside them, so
    // they cannot disagree with what is reported.
    const all = [
      ...containerAbnormalities.map((a) => ({ slice: null, ...a })),
      ...slices.flatMap((s) => s.abnormalities.map((a) => ({ slice: s.arch, ...a }))),
    ];
    const errors = all.filter((a) => a.severity === 'error').length;
    const warnings = all.length - errors;

    let verdict = 'ok';
    if (errors > 0) verdict = 'failed';
    else if (strict && all.length > 0) verdict = 'failed';
    else if (all.length > 0) verdict = 'warnings';

    return {
      path,
      size: f.size,
      fat: slices.length > 1,
      strict,
      slices,
      // Named `containerAbnormalities` rather than folded into the slices: these
      // are properties of the fat table, and a caller that merged them would lose
      // the distinction between "this slice is broken" and "these two slices
      // contradict each other".
      containerAbnormalities,
      findings: all,
      counts: { total: all.length, errors, warnings },
      verdict,
      // The two booleans a caller actually branches on. `clean` is the default
      // gate; `strictClean` is the gate with `--strict`.
      clean: errors === 0,
      strictClean: all.length === 0,
    };
  });
}

/* ------------------------------------------------------------------ *
 * fingerprint
 * ------------------------------------------------------------------ */

/**
 * What is this binary, ignoring everything a rebuild moves?
 *
 * ## The question this answers
 *
 * "Is this the same program as that one?" — which is a different question from
 * "are these the same file?", and the one you actually have when comparing a
 * build against a baseline, a shipped binary against a rebuild, or two copies of
 * an app that came out of two machines.
 *
 * Every existing answer is byte comparison, and byte comparison answers it wrong
 * in both directions. Two builds of the same source differ in every address (PIE
 * and ASLR), in the current-version fields of the dylibs they load, and in any
 * timestamp — so `cmp` reports them different. Two *different* programs that were
 * built from the same template with one function renamed differ in almost nothing
 * structural — so a loose structural diff can report them the same. A UUID
 * answers a third question, "same build", which is exact and useless the moment
 * anything is rebuilt.
 *
 * So there are three answers, and the caller picks by which one they meant:
 *
 *   `uuid`         the same build. Exact. Changes if anything is relinked.
 *   `fingerprint`  the same program. Survives a rebuild; changes if a symbol or a
 *                  section does.
 *   `structure`    the same shape. Weaker, and the only one available for a
 *                  stripped binary.
 *
 * ## Why `tier` is reported
 *
 * A stripped binary has no symbol names, so its fingerprint is structural. That is
 * not a worse program, but it *is* a weaker claim: two different stripped binaries
 * with the same sections and load commands share a fingerprint. Reporting that
 * digest as though it were as strong as a full one would overstate it, so
 * `tier` says `structure-only` and the caller can decide whether that is enough.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {string} [opts.arch] fingerprint only this slice of a universal binary
 * @returns {object}
 */
function fingerprint(path, { arch = null } = {}) {
  return withFile(path, (f) => {
    const slices = [];
    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      if (!thin) continue;
      const name = s.thin
        ? sliceArchName(thin.cputype, thin.cpusubtype)
        : sliceArchName(s.cputype, s.cpusubtype);
      if (arch && !archMatches(name, arch)) continue;

      const defined = readSymbols(f, s.offset, thin).entries
        .filter((e) => e.defined)
        .map((e) => ({ name: e.name }));
      const shape = sliceShape({
        arch: name,
        bits: thin.is64 ? 64 : 32,
        filetype: thin.filetype,
        sections: thin.sections,
        loadCommands: thin.loadCommands,
        definedSymbols: defined,
      });
      slices.push({
        arch: name,
        fingerprint: shape.fingerprint,
        structure: shape.structure,
        symbols: shape.symbols,
        tier: shape.tier,
        nsyms: shape.nsyms,
        uuid: thin.uuid,
        nsects: thin.sections.length,
        ncmds: thin.loadCommands.length,
      });
    }

    // Combined across slices, so one number answers "same program?" for the file.
    // Null when nothing parsed: there is no shape to report, and reporting a digest
    // of nothing would be a value that matches every other unreadable file.
    const combined = slices.length ? fileShape(slices) : null;
    // Every slice agreeing is a stronger claim than one file-level digest, so it is
    // reported separately rather than inferred from the combined value.
    const uuids = slices.map((s) => s.uuid).filter((u) => u !== null);
    const uuid = uuids.length === 1 && new Set(uuids).size === 1 ? uuids[0] : null;

    return {
      path,
      size: f.size,
      fat: slices.length > 1,
      slices,
      fingerprint: combined,
      uuid,
      // The weakest tier present, so a caller gating on this learns about the
      // stripped slice rather than being reassured by the symbol-bearing ones.
      tier: slices.length === 0
        ? null
        : slices.every((s) => s.tier === 'full') ? 'full' : 'structure-only',
    };
  });
}

/**
 * Compare two binaries by fingerprint, and say *which* question the answer settles.
 *
 * Reporting the three answers separately is the whole point. Two files with the
 * same UUID and different fingerprints have diverged since signing; the same
 * fingerprint with different UUIDs are the same program rebuilt; and different
 * fingerprints with different UUIDs are simply different programs. Collapsing
 * those into one yes/no would throw away the distinction the caller needs most.
 *
 * @param {string} a
 * @param {string} b
 * @param {object} [opts]
 * @param {string} [opts.arch] compare only this architecture of each side
 * @returns {object} both fingerprints, plus the three verdicts
 */
function compareFingerprints(a, b, { arch = null } = {}) {
  // `arch` is applied here rather than by the caller filtering afterwards. A caller
  // that recomputed `a` and `b` but left `byArch` alone would produce a result whose
  // summary describes one comparison and whose rows describe another — which is the
  // kind of internal disagreement this package treats as a defect rather than a
  // presentation detail.
  const fa = fingerprint(a, arch ? { arch } : {});
  const fb = fingerprint(b, arch ? { arch } : {});

  // Per-arch rather than whole-file, because the useful case is "arm64 matches,
  // x86_64 does not" — which a single boolean would report as a flat no.
  const byArch = [];
  for (const sa of fa.slices) {
    const sb = fb.slices.find((x) => x.arch === sa.arch);
    byArch.push({
      arch: sa.arch,
      presentInBoth: Boolean(sb),
      fingerprint: sa.fingerprint,
      other: sb ? sb.fingerprint : null,
      match: sb ? sb.fingerprint === sa.fingerprint : null,
      tier: sb && sa.tier !== 'full' ? 'structure-only' : sa.tier,
    });
  }
  for (const sb of fb.slices) {
    if (!fa.slices.some((x) => x.arch === sb.arch)) {
      byArch.push({ arch: sb.arch, presentInBoth: false, fingerprint: null, other: sb.fingerprint, match: null, tier: sb.tier });
    }
  }

  const shared = byArch.filter((x) => x.presentInBoth);
  const sameBuild = fa.uuid !== null && fa.uuid === fb.uuid;
  // Nothing comparable is not the same as "different". Two files with no
  // architecture in common — which is what `--arch` on two disjoint binaries gives
  // — have not been shown to be different programs; the question was not put to them.
  // Saying "different programs" there would report a comparison that did not happen
  // as a comparison that came out negative, which is the shape of a wrong answer
  // rather than an unhelpful one.
  const comparable = shared.length > 0;
  const sameProgram = comparable && shared.every((x) => x.match);
  // "Was it rebuilt?" is answerable only when both sides carry a UUID and they
  // differ. Two UUIDs that match mean the same build; two files with no UUID at all
  // that fingerprint alike mean the same program, and nothing more — they may be two
  // copies of one identical file, which is not a rebuild. The first version of this
  // reported "rebuilt" unconditionally and so claimed a rebuild when comparing a file
  // with itself.
  const rebuilt = sameProgram && fa.uuid !== null && fb.uuid !== null && fa.uuid !== fb.uuid;

  return {
    a: fa,
    b: fb,
    byArch,
    /** False when the two share no architecture, so nothing was actually compared. */
    comparable,
    // The three answers, kept apart.
    sameBuild,
    sameProgram,
    /** True only when differing UUIDs *prove* a rebuild happened. */
    rebuilt,
    // The one-line summary, and it names which question it settled rather than
    // asserting more than the bytes support.
    verdict: !comparable
      ? 'no shared architecture to compare'
      : sameBuild
        ? 'same build — identical UUID'
        : rebuilt
          ? 'same program, rebuilt (UUIDs differ)'
          : sameProgram
            ? 'same program'
            : 'different programs',
    // Disclosed because it bounds the claim: a structure-only match is a weaker
    // statement, and a caller gating a release should see that before relying on it.
    caveat: fa.tier === 'structure-only' || fb.tier === 'structure-only'
      ? 'at least one side is stripped, so the match rests on section and load-command shape alone'
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * corpus
 * ------------------------------------------------------------------ */

/** How deep a `--in` directory walk goes before it stops descending. */
const CORPUS_MAX_DEPTH = 6;

/**
 * Every file under `root`, breadth-first, bounded in both depth and count.
 *
 * Returns absolute paths. Depth-limited and count-limited rather than exhaustive,
 * because the one thing a corpus walk must never do is appear to hang: pointed at a
 * home directory or a `node_modules` tree it would otherwise read tens of thousands
 * of files, most of them not Mach-O.
 *
 * Symlinked directories are **not** followed. A symlink cycle would make the walk
 * non-terminating, and a corpus search that silently re-visits the same tree is
 * worse than one that misses a corner of it — the counts would not mean what they
 * appear to mean. Symlinked *files* are fine and are included, since they are just
 * files.
 */
function walkCorpus(roots, { maxDepth = CORPUS_MAX_DEPTH, maxFiles = 20000 } = {}) {
  const out = [];
  const seenDirs = new Set();
  let truncated = false;

  const push = (p) => {
    if (out.length >= maxFiles) { truncated = true; return false; }
    out.push(p);
    return true;
  };

  for (const root of roots) {
    let st;
    try {
      st = fs.statSync(root);
    } catch {
      // A path that does not exist is reported by the caller, not here: this
      // function's job is to enumerate what it can, and a missing root is a
      // different kind of problem from an unreadable file inside a real tree.
      out.push({ missing: root });
      continue;
    }

    if (!st.isDirectory()) {
      push(root);
      continue;
    }

    const queue = [[root, 0]];
    while (queue.length) {
      const [dir, depth] = queue.shift();
      // `realpath` rather than the literal path, so a tree reached twice by two
      // different roots is walked once. Without it, `--in . --include=./sub`
      // double-counts everything in `sub`.
      let key;
      try {
        key = fs.realpathSync(dir);
      } catch {
        continue;
      }
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        // An unreadable directory is skipped rather than fatal. A corpus is
        // routinely a build output tree with a permission hole in it, and failing
        // the whole search over one directory answers a question the caller did not
        // ask.
        continue;
      }
      entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const e of entries) {
        const p = pathModule.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth + 1 <= maxDepth) queue.push([p, depth + 1]);
          continue;
        }
        if (e.isSymbolicLink()) {
          // Resolve to decide file-vs-directory without following a directory link.
          let target;
          try {
            target = fs.statSync(p);
          } catch {
            continue; // dangling
          }
          if (target.isDirectory()) continue; // deliberately not followed
          if (!push(p)) break;
          continue;
        }
        if (e.isFile() && !push(p)) break;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { files: out, truncated };
}

/**
 * Search the symbol tables of many binaries, in one call.
 *
 * ## The contract this is really about
 *
 * The point is not the search — `searchSymbols` does that. The point is that the
 * *answer shape* is the same whether the caller passed one binary or four thousand,
 * so a pipeline does not need a second code path for scale. A caller asking "which
 * of these artifacts import `CCCrypt`" gets `data.files[]` with the same envelope,
 * the same exit taxonomy and the same error handling as every other tool here.
 *
 * That is the whole advantage, and it is a contract advantage rather than a
 * capability one: the same question is answerable over a directory by tools with far
 * more capability, but not by any of them through one uniform door.
 *
 * ## Non-Mach-O files are skipped, not failed
 *
 * Pointed at a build directory, a walk finds plists, headers, dSYMs-as-text and
 * Mach-O-shaped nothing. Treating those as errors would make the tool unusable for
 * its actual use case, so they are counted in `skipped` and nothing else. A file
 * that *is* a Mach-O but cannot be read is different: that is recorded per file with
 * its reason code, because silently dropping a file the caller named is exactly the
 * failure mode this project keeps refusing.
 *
 * @param {string[]|string} roots files and/or directories
 * @param {string} pattern
 * @param {object} [opts]
 * @param {string} [opts.arch]
 * @param {'substring'|'regex'} [opts.mode='substring']
 * @param {string} [opts.flags='i']
 * @param {boolean} [opts.definedOnly=true]
 * @param {boolean} [opts.dedupe=true]
 * @param {number} [opts.max=4000]      cap per file
 * @param {number} [opts.perFile=10]    match names kept per file
 * @param {boolean} [opts.matchedOnly=false] omit files with no matches from `files`
 * @param {number} [opts.maxFiles=20000]
 * @param {number} [opts.maxDepth=6]
 * @returns {object}
 */
function searchSymbolsIn(roots, pattern, {
  arch, mode = 'substring', flags = 'i', definedOnly = true, dedupe = true,
  max = 4000, perFile = 10, matchedOnly = false, maxFiles = 20000, maxDepth = CORPUS_MAX_DEPTH,
} = {}) {
  if (typeof pattern !== 'string' || !pattern) throw new TypeError('searchSymbolsIn: a pattern is required');
  const list = Array.isArray(roots) ? roots : [roots];
  if (list.length === 0) throw new TypeError('searchSymbolsIn: at least one path is required');
  // Built before any file is opened, so an invalid regex is a usage error about the
  // pattern rather than a confusing failure partway through four thousand files.
  const re = mode === 'regex' ? new RegExp(pattern, flags) : null;

  const { files: walked, truncated } = walkCorpus(list, { maxFiles, maxDepth });
  const files = [];
  let skipped = 0;
  let unreadable = 0;
  let totalMatches = 0;
  let matchedFiles = 0;

  for (const entry of walked) {
    // The missing-root marker is an *object*, not a string path. The first version
    // of this test read `typeof entry === 'string' && entry.missing`, which is
    // never true, so a path the caller named and that did not exist fell through to
    // the non-Mach-O filter and was counted as "skipped" — reported as absent
    // content rather than as a typo. Silently dropping a path the caller named is
    // the exact failure this project keeps refusing, so it gets its own row.
    if (entry !== null && typeof entry === 'object' && entry.missing) {
      unreadable++;
      files.push({
        path: entry.missing,
        ok: false,
        error: 'io',
        message: 'no such file or directory',
        arch: null,
        count: 0,
        matches: [],
      });
      continue;
    }
    // `isMachOFile` opens the file, so this is the one filter that must happen
    // before anything expensive. It is also why a non-Mach-O costs a 4-byte read
    // rather than a full parse.
    if (!isMachOFile(entry)) { skipped++; continue; }

    try {
      const r = searchSymbols(entry, pattern, { arch, mode, flags, definedOnly, dedupe, max });
      if (r.count > 0) { matchedFiles++; totalMatches += r.count; }
      if (matchedOnly && r.count === 0) continue;
      files.push({
        path: entry,
        ok: true,
        error: null,
        arch: r.arch,
        count: r.count,
        uniqueCount: r.uniqueCount,
        defined: r.defined,
        total: r.total,
        note: r.note,
        // Names are capped per file by default: 4,000 files × 4,000 symbols is a
        // 16-million-row answer, and the question "which files" is answered by the
        // file list. `perFile: 0` keeps counts only.
        matches: perFile > 0 ? r.matches.slice(0, perFile) : [],
        matchesTruncated: r.matches.length > perFile,
      });
    } catch (e) {
      // A named file that cannot be read is a per-file error, not a whole-run
      // failure: one corrupt artifact in a build tree must not hide the other 3,999.
      unreadable++;
      files.push({
        path: entry,
        ok: false,
        error: e.code ?? 'io',
        message: e.message,
        arch: null,
        count: 0,
        matches: [],
      });
    }
  }

  // Sorted by path, so two runs over the same tree produce byte-identical output.
  // A corpus result that reorders between runs cannot be diffed, cached or cached
  // against a baseline.
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  return {
    pattern,
    mode,
    flags: mode === 'regex' ? flags : null,
    definedOnly,
    dedupe,
    roots: list,
    files,
    totals: {
      files: files.length,
      // How many of those were actually *read*. `files` includes rows for paths
      // that could not be read, because dropping them would hide a path the caller
      // named — but a summary that says "N Mach-O read" when N of them failed is a
      // count that lies, so the two are separate fields and the distinction travels
      // with the answer rather than being recomputed by each caller.
      looked: files.filter((x) => x.ok).length,
      matchedFiles,
      matches: totalMatches,
      skipped,
      unreadable,
      considered: walked.length,
    },
    // Disclosed rather than silent: a walk that stopped early would otherwise look
    // identical to a tree that genuinely contained nothing else.
    truncated,
    note: truncated
      ? `stopped after ${maxFiles} file(s) or depth ${maxDepth} — the answer covers only what was reached`
      : null,
  };
}

/**
 * Direct call/jmp xrefs across a *set* of binaries, keyed by a portable address.
 *
 * ## Why the query is not a vaddr
 *
 * A virtual address is meaningless across files. Every slice maps `__TEXT` at its
 * own base — `0x100000000` in one binary, `0x100000120` in another, `0x180000000`
 * in a third — so asking "who calls `0x100085c30`" of a whole build tree asks each
 * file a question about an address that file may not even map. Worse, it is not
 * merely wrong, it is *quietly* wrong: a file that happens to map that address
 * answers confidently about an unrelated function.
 *
 * So the corpus query is an **offset into `__TEXT`**, and every file is asked at
 * `its own __TEXT base + that offset`. The alternative — silently switching what a
 * vaddr means between one-binary and many-binary mode — is precisely the failure
 * this package refuses elsewhere, so the change is declared rather than implied:
 * `queryMode` is in the result, the text output says so, and
 * `textRelative` carries the offset back.
 *
 * This is the portable form of the question. "Who calls the function that starts
 * 0x85c30 into `__TEXT`?" survives a rebuild, a rebase and a universal-to-thin
 * change, which a raw address does not.
 *
 * ## What it costs
 *
 * Two files whose `__TEXT` layout differs at that offset answer about different
 * functions, and nothing here can know that — the format does not record what a
 * build was built from. So each row reports the address it actually asked about,
 * and a caller that cares should confirm the two binaries are the same program,
 * which is what `fingerprint` is for.
 *
 * @param {string[]} roots files or directories to walk
 * @param {bigint}   offset  bytes into `__TEXT`
 * @param {object}   [opts]  as {@link findCalls}, plus `maxFiles`/`maxDepth`/`perFile`
 * @returns {object} one row per file, sorted by path, with the same
 *   `files`/`totals`/`skipped`/`unreadable` shape {@link searchSymbolsIn} uses, so a
 *   corpus answer is one shape whichever corpus tool produced it
 */
function findCallsIn(roots, offset, {
  arch, includeData = false, max = 0, perFile = 50,
  maxFiles = 20000, maxDepth = CORPUS_MAX_DEPTH,
} = {}) {
  const rel = typeof offset === 'bigint' ? offset : BigInt(offset);
  if (rel < 0n) throw new TypeError('findCallsIn: the __TEXT offset cannot be negative');
  const list = Array.isArray(roots) ? roots : [roots];
  if (list.length === 0) throw new TypeError('findCallsIn: at least one path is required');

  const { files: walked, truncated } = walkCorpus(list, { maxFiles, maxDepth });
  const files = [];
  let skipped = 0;
  let unreadable = 0;
  let totalHits = 0;
  let matchedFiles = 0;

  for (const entry of walked) {
    // A path the caller named that is not there is reported, not dropped — the same
    // rule `searchSymbolsIn` follows, and for the same reason: a silently skipped
    // path is indistinguishable from a tree that held nothing.
    if (entry !== null && typeof entry === 'object' && entry.missing) {
      unreadable++;
      files.push({
        path: entry.missing, ok: false, error: 'io', message: 'no such file or directory',
        arch: null, base: null, vaddr: null, count: 0, sites: [],
      });
      continue;
    }
    if (!isMachOFile(entry)) { skipped++; continue; }

    try {
      // The base is per file and per slice, so it is resolved inside and the rows
      // carry it: "called 0x100085c30" is only meaningful next to the base it was
      // computed from.
      const r = findCalls(entry, rel, { arch, includeData, max, __textRelative: true });
      // A slice contributes hits only if some hit names its architecture — the hit
      // records carry `arch`, and the slice records do not carry a hit count, so
      // grouping by the hits is the honest way to know which slices answered rather
      // than which ones merely existed. A fat binary's two slices have different
      // bases, so collapsing them onto one address would be a fabricated answer.
      const hitArches = new Set((r.hits ?? []).map((h) => h.arch));
      const answered = (r.slices ?? []).filter((s) => hitArches.has(s.arch));
      if (r.count > 0) { matchedFiles++; totalHits += r.count; }
      files.push({
        path: entry,
        ok: true,
        error: null,
        arch: answered.length === 1 ? answered[0].arch : null,
        // Per-arch: the `__TEXT` base each answer was computed from, so a resolved
        // address can be read against its origin.
        bases: answered.map((s) => ({
          arch: s.arch,
          textBase: s.textBase !== null ? `0x${s.textBase.toString(16)}` : null,
          target: `0x${s.target.toString(16)}`,
        })),
        count: r.count,
        // Sites are capped per file for the same reason names are capped in
        // `searchSymbolsIn`: a whole tree of call sites is not a list anyone reads,
        // and the per-file count is the part that answers "which files".
        sites: perFile > 0 ? (r.hits ?? []).slice(0, perFile) : [],
        sitesTruncated: (r.hits ?? []).length > perFile,
        skipped: r.skipped ?? [],
        unsupported: r.unsupported ?? [],
        encrypted: r.encryptedSlices ?? [],
      });
    } catch (e) {
      unreadable++;
      files.push({
        path: entry, ok: false, error: e.code ?? 'io', message: e.message,
        arch: null, bases: [], count: 0, sites: [],
      });
    }
  }

  // Sorted by path, for the reason `searchSymbolsIn` sorts: two runs over one tree
  // must produce byte-identical output or the result cannot be diffed or cached.
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  return {
    textRelative: `0x${rel.toString(16)}`,
    queryMode: 'text-relative',
    roots: list,
    files,
    totals: {
      files: files.length,
      looked: files.filter((x) => x.ok).length,
      matchedFiles,
      sites: totalHits,
      skipped,
      unreadable,
      considered: walked.length,
    },
    truncated,
    note: truncated
      ? `stopped after ${maxFiles} file(s) or depth ${maxDepth} — the answer covers only what was reached`
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * diff
 * ------------------------------------------------------------------ */

/**
 * What changed between two binaries — and, just as importantly, what did not.
 *
 * ## Why not `cmp`
 *
 * A byte comparison between two builds of one source reports a difference in every
 * byte from the load base onwards, because PIE and ASLR move every address, a
 * dependency bump moves a dylib's version fields, and a rebuild moves any
 * timestamp. The output is "everything changed", which is worse than useless: it
 * cannot distinguish a rebuilt binary from a different program, and it cannot tell a
 * reviewer that the one thing they cared about did not move.
 *
 * So this diff is over *structural facts* — which architectures are present, which
 * header flags are set, which load commands and sections exist, which symbols are
 * defined. None of those move when a binary is rebuilt, and all of them change when
 * the program does.
 *
 * ## Two lists, not one
 *
 *   `differences`     structural changes. This is what the verdict is computed from.
 *   `buildMetadata`   UUIDs and the presence of signing/provenance commands, which
 *                     change on every rebuild and say nothing about the program.
 *
 * Reporting build metadata as a difference would make this tool report the same
 * thing `cmp` does, more slowly. Reporting it as *nothing* would hide it, and a
 * caller comparing a shipped binary against a baseline wants to know the build
 * changed. So it is reported, in its own list, and kept out of the verdict —
 * the same split the fingerprint makes, for the same reason.
 *
 * ## Sizes and addresses are deliberately absent
 *
 * A section that grew by 400 bytes is a real change, and it is also what a
 * recompiled dependency does. Including sizes would put every rebuilt pair into the
 * "different" bucket, so they are reported as `sizeChanges` — visible, counted
 * separately from the verdict, and honest about being a weaker signal than a symbol
 * appearing or a section appearing.
 *
 * @param {string} a
 * @param {string} b
 * @param {object} [opts]
 * @param {string} [opts.arch]    compare only this architecture
 * @param {number} [opts.maxNames=20] cap on symbol names listed per direction
 * @returns {object}
 */
function diffBinaries(a, b, { arch = null, maxNames = 20 } = {}) {
  const fa = fingerprint(a, arch ? { arch } : {});
  const fb = fingerprint(b, arch ? { arch } : {});
  const differences = [];
  const buildMetadata = [];
  const sizeChanges = [];
  const add = (category, archName, kind, detail, av, bv) =>
    differences.push({ category, arch: archName, kind, detail, a: av ?? null, b: bv ?? null });

  // Which architectures each side has. Reported first because it bounds everything
  // else: a slice present on one side only makes every per-slice comparison for it
  // meaningless rather than different.
  const archA = new Set(fa.slices.map((s) => s.arch));
  const archB = new Set(fb.slices.map((s) => s.arch));
  for (const archName of archA) {
    if (!archB.has(archName)) add('slices', null, 'slice-only-in-a', `${archName} is present only in ${a}`, archName, null);
  }
  for (const archName of archB) {
    if (!archA.has(archName)) add('slices', null, 'slice-only-in-b', `${archName} is present only in ${b}`, null, archName);
  }

  const perArch = [];
  for (const archName of archA) {
    if (!archB.has(archName)) continue;
    const before = readSide(a, archName);
    const after = readSide(b, archName);
    if (!before || !after) continue;
    const d0 = differences.length;

    // Compared and reported through `filetypeKey`, never as the raw value. `parseThin`
    // returns the decoded object, and two of those are never `===`, so comparing them
    // directly reported `filetype-changed` for *every* pair of binaries — including a
    // file against itself. Interpolating them printed `filetype [object Object] ->
    // [object Object]` in the message, so the report was both universal and useless.
    const beforeFt = filetypeKey(before.filetype);
    const afterFt = filetypeKey(after.filetype);
    if (beforeFt !== afterFt) {
      add('header', archName, 'filetype-changed', `${archName}: filetype ${beforeFt} -> ${afterFt}`,
        beforeFt, afterFt);
    }
    if (before.bits !== after.bits) {
      add('header', archName, 'bits-changed', `${archName}: ${before.bits}-bit -> ${after.bits}-bit`,
        before.bits, after.bits);
    }

    // Flags, both directions, so a cleared flag is as visible as a set one.
    for (const f of before.flagsNamed.filter((x) => !after.flagsNamed.includes(x))) {
      add('flags', archName, 'flag-removed', `${archName}: ${f} is no longer set`, f, null);
    }
    for (const f of after.flagsNamed.filter((x) => !before.flagsNamed.includes(x))) {
      add('flags', archName, 'flag-added', `${archName}: ${f} is now set`, null, f);
    }

    // Load commands, by name. Provenance commands are routed to `buildMetadata`
    // instead — see the note on the function's own comment.
    const namesOf = (s) => new Set(s.loadCommands.map((c) => c.name));
    const na = namesOf(before);
    const nb = namesOf(after);
    // "Loads X" is only true of the dylib commands. Every other command is a
    // *declaration* — LC_MAIN is the entry point and LC_RPATH a search path, and
    // describing either as something the binary "loads" is a small falsehood in a
    // tool whose whole claim is that it reports facts.
    const phrased = (name) => (DYLIB_COMMAND_NAMES.has(name)
      ? `loads ${name.slice('LC_'.length)}`
      : `declares ${name}`);
    for (const name of na) {
      if (nb.has(name)) continue;
      if (PROVENANCE.has(name)) {
        buildMetadata.push({ arch: archName, kind: 'provenance-removed', detail: `${archName}: ${name} is no longer present`, name });
      } else {
        add('load-commands', archName, 'load-command-removed', `${archName}: no longer ${phrased(name)}`, name, null);
      }
    }
    for (const name of nb) {
      if (na.has(name)) continue;
      if (PROVENANCE.has(name)) {
        buildMetadata.push({ arch: archName, kind: 'provenance-added', detail: `${archName}: now carries ${name}`, name });
      } else {
        add('load-commands', archName, 'load-command-added', `${archName}: now ${phrased(name)}`, null, name);
      }
    }

    // Sections, by identity and then by type. A section that is still there but has
    // become a different kind is the interesting case, so it is not folded into
    // remove+add.
    const byName = (s) => new Map(s.sections.map((x) => [`${x.segname},${x.sectname}`, x]));
    const sa = byName(before);
    const sb = byName(after);
    for (const [name, sec] of sa) {
      const other = sb.get(name);
      if (!other) {
        add('sections', archName, 'section-removed', `${archName}: ${name} is gone`, name, null);
        continue;
      }
      if (sec.type !== other.type) {
        add('sections', archName, 'section-type-changed', `${archName}: ${name} is ${sec.type} -> ${other.type}`, sec.type, other.type);
      }
      const attrA = sec.attributes.join(',');
      const attrB = other.attributes.join(',');
      if (attrA !== attrB) {
        add('sections', archName, 'section-attributes-changed', `${archName}: ${name} attributes [${attrA}] -> [${attrB}]`, attrA, attrB);
      }
      if (sec.size !== other.size) {
        sizeChanges.push({ arch: archName, section: name, a: sec.size, b: other.size, delta: other.size - sec.size });
      }
    }
    for (const name of sb.keys()) {
      if (!sa.has(name)) add('sections', archName, 'section-added', `${archName}: ${name} is new`, null, name);
    }

    // Symbols. Counts always, names capped — a 19,000-symbol binary would otherwise
    // produce a diff nobody reads, and a diff nobody reads is a diff nobody reads
    // past the first line.
    const symA = new Set(before.symbolNames);
    const symB = new Set(after.symbolNames);
    const added = [...symB].filter((x) => !symA.has(x));
    const removed = [...symA].filter((x) => !symB.has(x));
    if (added.length) {
      add('symbols', archName, 'symbols-added',
        `${archName}: ${added.length} symbol(s) added${added.length > maxNames ? `, first ${maxNames}: ${added.slice(0, maxNames).join(', ')}` : `: ${added.join(', ')}`}`,
        null, added.length);
    }
    if (removed.length) {
      add('symbols', archName, 'symbols-removed',
        `${archName}: ${removed.length} symbol(s) removed${removed.length > maxNames ? `, first ${maxNames}: ${removed.slice(0, maxNames).join(', ')}` : `: ${removed.join(', ')}`}`,
        removed.length, null);
    }

    // Literal strings, by content. A string that appears or disappears is a change
    // to the program — a new error message, a removed URL, a branch that now
    // compiles out — and unlike an address it does not move on a rebuild, so it
    // belongs in `differences` rather than beside the UUID. Matched by text, since
    // the whole point is that the addresses differ.
    //
    // Quoted in the detail so a string whose content is a number or a `-` cannot
    // read as a count or a flag. The list is capped like the symbol lists, for the
    // same reason: a Go binary with 200,000 strings otherwise produces a diff nobody
    // reads past the first line.
    const litA = before.literalTexts;
    const litB = after.literalTexts;
    const litAdded = [...litB].filter((x) => !litA.has(x));
    const litRemoved = [...litA].filter((x) => !litB.has(x));
    const quote = (xs) => xs.slice(0, maxNames).map((x) => JSON.stringify(x)).join(', ');
    if (litAdded.length) {
      add('literals', archName, 'literals-added',
        `${archName}: ${litAdded.length} string(s) added${litAdded.length > maxNames ? `, first ${maxNames}: ${quote(litAdded)}` : `: ${quote(litAdded)}`}`,
        null, litAdded.length);
    }
    if (litRemoved.length) {
      add('literals', archName, 'literals-removed',
        `${archName}: ${litRemoved.length} string(s) removed${litRemoved.length > maxNames ? `, first ${maxNames}: ${quote(litRemoved)}` : `: ${quote(litRemoved)}`}`,
        litRemoved.length, null);
    }

    perArch.push({
      arch: archName,
      differenceCount: differences.length - d0,
      symbols: { a: symA.size, b: symB.size, added: added.length, removed: removed.length },
      sections: { a: sa.size, b: sb.size },
      literals: { a: litA.size, b: litB.size, added: litAdded.length, removed: litRemoved.length },
    });
  }

  // The UUID, kept out of `differences` for the same reason the commands are.
  if (fa.uuid !== fb.uuid) {
    buildMetadata.push({
      arch: null,
      kind: 'uuid-differs',
      detail: fa.uuid && fb.uuid
        ? 'the two builds carry different UUIDs, so they are different builds of whatever they are'
        : `only one side carries a UUID (${fa.uuid ?? 'none'} vs ${fb.uuid ?? 'none'})`,
      name: null,
    });
  }

  const sameShape = fa.fingerprint !== null && fa.fingerprint === fb.fingerprint;
  const identical = differences.length === 0 && sameShape && buildMetadata.length === 0;
  return {
    a: fa,
    b: fb,
    perArch,
    differences,
    buildMetadata,
    sizeChanges,
    counts: {
      differences: differences.length,
      buildMetadata: buildMetadata.length,
      sizeChanges: sizeChanges.length,
    },
    // The three questions again, so a caller does not have to correlate this with a
    // separate fingerprint call to know what kind of difference it is looking at.
    sameBuild: fa.uuid !== null && fa.uuid === fb.uuid,
    sameShape,
    verdict: identical
      ? 'identical'
      : sameShape
        ? 'same program, rebuilt'
        : differences.length === 0
          ? 'same structure, different symbol set'
          : 'different structure',
  };
}

/**
 * Load commands whose *presence* records the build rather than the program.
 *
 * Deliberately the same set the fingerprint excludes, and for the same reason — two
 * lists that disagreed would mean `macho-diff` reported a rebuilt pair as changed
 * while `macho-fingerprint` reported it as the same program, in the same breath.
 */
const PROVENANCE = new Set([
  'LC_UUID',
  'LC_CODE_SIGNATURE',
  'LC_DYLIB_CODE_SIGN_DRS',
  'LC_SOURCE_VERSION',
]);

/**
 * The commands that genuinely mean "this binary needs something at link time".
 *
 * Named `..._NAMES` rather than `DYLIB_COMMANDS` because `macho.mjs` exports a
 * `DYLIB_COMMANDS` map of the same commands to their decoded payloads, and the
 * browser bundle in `demo/` links these three modules into one scope — where two
 * top-level `const`s sharing a name is a redeclaration error, not a shadow.
 */
const DYLIB_COMMAND_NAMES = new Set([
  'LC_LOAD_DYLIB',
  'LC_LOAD_WEAK_DYLIB',
  'LC_REEXPORT_DYLIB',
  'LC_LAZY_LOAD_DYLIB',
  'LC_LOAD_UPWARD_DYLIB',
  'LC_ID_DYLIB',
]);

/**
 * The distinct NUL-terminated strings in a slice's C-string sections.
 *
 * The same sections `findStrings` reports and the same `printable` filter, so a
 * string that `findliteral` can find is a string `diff` can diff — the alternative
 * is two tools disagreeing about what a literal is, which is the failure this
 * package treats as a defect rather than a coin toss. A `Set` rather than a list
 * because the question here is set membership ("did this string appear or
 * disappear"), and a binary that happens to hold `"error"` four hundred times
 * changed once when it stops holding it.
 *
 * Bounded by each section's own size and clamped to the file, exactly as
 * `findStrings` does, because a linker can record a section that runs past the end
 * and reading it would throw in the middle of an otherwise good answer.
 */
function literalTextsOf(f, s, thin, min = 4) {
  const out = new Set();
  for (const sec of thin.sections) {
    if (!CSTRING_SECTIONS.includes(sec.sectname) || sec.size === 0) continue;
    const lo = s.offset + sec.offset;
    const hi = Math.min(lo + sec.size, f.size);
    if (hi <= lo) continue;
    const buf = f.read(lo, hi - lo);
    let start = 0;
    while (start < buf.length) {
      const end = buf.indexOf(0, start);
      const stop = end === -1 ? buf.length : end;
      if (stop - start >= min) {
        const raw = buf.subarray(start, stop);
        if (printable(raw)) out.add(raw.toString('latin1'));
      }
      if (end === -1) break;
      start = end + 1;
    }
  }
  return out;
}

/** Everything a per-slice comparison needs, read once. */
function readSide(path, arch) {
  const f = opener(path);
  try {
    for (const s of slicesOf(f)) {
      const thin = parseThin(f, s.offset);
      if (!thin) continue;
      const name = s.thin
        ? sliceArchName(thin.cputype, thin.cpusubtype)
        : sliceArchName(s.cputype, s.cpusubtype);
      if (name !== arch) continue;
      return {
        filetype: thin.filetype,
        bits: thin.is64 ? 64 : 32,
        flagsNamed: decodeHeaderFlags(thin.flags).names,
        loadCommands: thin.loadCommands,
        sections: thin.sections,
        symbolNames: readSymbols(f, s.offset, thin).entries
          .filter((e) => e.defined)
          .map((e) => e.name),
        literalTexts: literalTextsOf(f, s, thin),
      };
    }
    return null;
  } finally {
    f.close();
  }
}

/* ------------------------------------------------------------------ *
 * byte helpers
 * ------------------------------------------------------------------ */

/**
 * Find every occurrence of `needle` in `[from, to)`.
 *
 * Chunked with a carry window, because these literals get searched inside
 * multi-hundred-megabyte binaries and slurping a whole slice is how the tools
 * became too slow for anyone to run. The overlap is at least 64 bytes and
 * always longer than the needle, so a match straddling a chunk boundary is not
 * dropped — a naive chunked scan loses exactly those, silently.
 */
function searchRange(f, needle, from, to) {
  if (to <= from || needle.length === 0) return [];
  const CHUNK = 1 << 24;
  const OVERLAP = Math.max(64, needle.length * 2);
  const found = [];
  let pos = from;
  let carry = Buffer.alloc(0);
  let carryBase = from;

  while (pos < to) {
    const buf = f.read(pos, Math.min(CHUNK, to - pos));
    if (buf.length === 0) break;
    const hay = Buffer.concat([carry, buf]);
    let i = 0;
    while (true) {
      const at = hay.indexOf(needle, i);
      if (at < 0) break;
      // `>= from` drops the duplicate a hit inside the carry produces twice.
      if (carryBase + at >= from) found.push(carryBase + at);
      i = at + 1;
    }
    carry = hay.subarray(Math.max(0, hay.length - OVERLAP));
    carryBase = carryBase + hay.length - carry.length;
    pos += buf.length;
  }
  return found;
}

/** Printable context around a file offset, as `pre` and `hit`. */
function contextAround(f, off, preLen = 16, hitLen = 8) {
  const printable = (b) => b.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  const lo = Math.max(0, off - preLen);
  const pre = f.read(lo, off - lo);
  return { pre: printable(pre), preFrom: lo, hit: printable(f.read(off, hitLen)) };
}


/**
 * Instruction decoding, re-exported from `instruction.mjs`.
 *
 * Exported rather than left behind a CLI because the question these answer —
 * "how long is the instruction at this address, and where does it branch" — is
 * the same *kind* of question as `addressToOffset` and `findCalls`, and a caller
 * holding a buffer should not have to spawn a process to get the answer.
 *
 * What they deliberately do not do is decode *operands* or print mnemonics. They
 * answer "where are the boundaries, and where do the direct edges go", which is a
 * fact about the byte stream; anything past that is a claim about what the program
 * does. The sweep's limits and the opcode table's documented gaps carry over
 * unchanged.
 */

/* ================================================================== *
 * public surface
 * ================================================================== */

export {
  memoryFs, ByteBuffer, Buffer, sha256, createHash, describe, overview, searchSymbols, findLiteral, findStrings, mapLiteral, addressToOffset, offsetToAddress, lookupAddress, findCalls, listCallTargets, audit, fingerprint, compareFingerprints, diffBinaries, coversAddress, withFile, isMachOFile, sliceName, sliceArchName, textSection, codeSections, sectionOf, toVaddr, toFileOffset, loadCommandName, decodeFiletype, decodePlatform, decodeHeaderFlags, decodeSectionFlags, decodeSourceVersion, decodePackedVersion, filetypeKey, detectAbnormalities, detectContainerAbnormalities, resolveEntryPoint, sliceShape, fileShape, digestOf, slicesOf, parseFat, parseThin, readSymbols, richestSlice, preferredSlice, archMatches, isBackedByFile, shannonEntropy, findInSection
};
