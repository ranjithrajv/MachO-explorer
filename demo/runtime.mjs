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
export class ByteBuffer extends Uint8Array {
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
export const Buffer = {
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
export function sha256(bytes) {
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
export function createHash(algorithm) {
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
export const memoryFs = {
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
export function openSync(path) {
  if (!memoryFs.files.has(path)) throw enoent(path);
  return { path };
}
export function closeSync() { /* the registry owns the bytes; nothing to release */ }
export function fstatSync(handle) {
  const bytes = memoryFs.files.get(handle.path);
  if (!bytes) throw enoent(handle.path);
  return { size: bytes.length };
}
export function readSync(handle, buffer, offset, length, position) {
  const bytes = memoryFs.files.get(handle.path);
  if (!bytes) throw enoent(handle.path);
  const start = position ?? 0;
  if (start >= bytes.length) return 0;
  const n = Math.min(length, bytes.length - start);
  buffer.set(bytes.subarray(start, start + n), offset);
  return n;
}

/** The `fs` default export `api.mjs` uses for its directory walk and error path. */
export const fs = {
  statSync(path) {
    const bytes = memoryFs.files.get(path);
    if (!bytes) throw enoent(path);
    return { size: bytes.length, isDirectory: () => false, isFile: () => true };
  },
  realpathSync(path) { return path; },
  readdirSync() { throw new Error('demo runtime: directory reads are not supported in the browser'); },
};

/** The slice of `node:path` the reader touches. */
export const pathModule = {
  join: (...parts) => parts.filter((p) => p !== '').join('/').replace(/\/+/g, '/'),
  dirname: (p) => p.replace(/\/[^/]*$/, '') || '/',
  basename: (p) => p.replace(/^.*\//, ''),
  resolve: (...parts) => parts.filter((p) => p !== '').join('/').replace(/\/+/g, '/'),
};
