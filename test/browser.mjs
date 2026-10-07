#!/usr/bin/env node
/**
 * browser.mjs — the auditability demo is the reader, and this proves it.
 *
 * The demo claims that the code which runs in the browser is the code a reviewer
 * audits: the real `src/macho.mjs`, `src/instruction.mjs` and `src/api.mjs`,
 * linked by `demo/link.mjs` with a small host shim. A claim like that is worth
 * exactly as much as the check behind it, so this suite does four things:
 *
 *   1. **No drift.** Re-derives the bundle and requires it to equal the committed
 *      `demo/macho.browser.mjs`, and requires the bundle to contain no `node:`
 *      import — a generated file that has quietly fallen behind the source is a
 *      demo that lies about what it ran.
 *   2. **The shim is faithful.** Holds `demo/runtime.mjs`'s `Buffer` and SHA-256
 *      to Node's own, method by method, because the reader is written against
 *      Node's `Buffer` and a shim that returns a plausible wrong number would
 *      corrupt every fact downstream without throwing.
 *   3. **Same answer, both hosts.** Loads the bundle and requires `describe` and
 *      `overview` to produce **byte-for-byte identical JSON** to the Node build
 *      on all 22 fixtures. This is the whole demonstration: not that a browser
 *      can parse a Mach-O, but that *this* reader parses it the same way in both.
 *   4. **The `.app` drop resolves.** Drives the directory walk that turns a
 *      dropped `.app` bundle into its executable, including the multi-batch
 *      case whose first version looped forever rather than failing.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'demo', 'macho.browser.mjs');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  PASS  ${m}`); };
const bad = (m) => { failed++; console.log(`  FAIL  ${m}`); };
const eq = (a, b, m) => (a === b ? ok(m) : bad(`${m}\n        expected ${JSON.stringify(b)}\n        got      ${JSON.stringify(a)}`));

console.log('\nbrowser — the demo bundle is the reader, and answers the same\n');

/* ------------------------------------------------------------------ *
 * 1. no drift
 * ------------------------------------------------------------------ */

console.log('bundle');

const { build } = await import(pathToFileURL(path.join(ROOT, 'demo', 'link.mjs')).href);
const generated = build();
const onDisk = fs.existsSync(BUNDLE) ? fs.readFileSync(BUNDLE, 'utf8') : null;

if (onDisk === generated) ok('demo/macho.browser.mjs matches the sources (node demo/link.mjs)');
else bad('demo/macho.browser.mjs is stale — run `node demo/link.mjs`');

if (!/^\s*import[\s{]/m.test(generated)) ok('the bundle contains no import statement — every boundary was stripped');
else bad('the bundle still contains an import statement, so it is not one scope');

if (!/from\s+['"]node:/.test(generated)) ok('the bundle imports no node: builtin — the host is the shim');
else bad('the bundle still references a node: builtin');

/* ------------------------------------------------------------------ *
 * 2. the shim is faithful to Node
 * ------------------------------------------------------------------ */

console.log('\nruntime shim');

const b = await import(pathToFileURL(BUNDLE).href);
const B = b.Buffer;

// Fixed bytes so a failure is reproducible.
const raw = Uint8Array.from([0xef, 0xbe, 0xad, 0xde, 0x01, 0x02, 0x03, 0x04, 0xff, 0x80, 0x7f, 0x00]);
const nBuf = Buffer.from(raw);
const bBuf = B.from(raw);

eq(bBuf.readUInt32LE(0), nBuf.readUInt32LE(0), 'readUInt32LE matches Node');
eq(bBuf.readUInt32BE(0), nBuf.readUInt32BE(0), 'readUInt32BE matches Node');
eq(bBuf.readInt32LE(0), nBuf.readInt32LE(0), 'readInt32LE matches Node');
eq(bBuf.readUInt16LE(0), nBuf.readUInt16LE(0), 'readUInt16LE matches Node');
eq(bBuf.readInt8(0), nBuf.readInt8(0), 'readInt8 matches Node (signed)');
eq(bBuf.readBigUInt64LE(0).toString(), nBuf.readBigUInt64LE(0).toString(), 'readBigUInt64LE matches Node');

const w = B.alloc(8);
const nw = Buffer.alloc(8);
w.writeBigUInt64LE(0xdeadbeefcafef00dn, 0);
nw.writeBigUInt64LE(0xdeadbeefcafef00dn, 0);
eq(w.toString('hex'), nw.toString('hex'), 'writeBigUInt64LE matches Node');

eq(B.from([1, 2, 3]).equals(B.from([1, 2, 3])), true, 'equals: identical buffers are equal');
eq(B.from([1, 2, 3]).equals(B.from([1, 2, 4])), false, 'equals: differing buffers are not equal');
eq(B.isBuffer(B.from([1])), true, 'isBuffer: a shim buffer is a buffer');

eq(B.concat([B.from([1, 2]), B.from([3])]).toString('hex'), '010203', 'concat joins in order');

const hay = B.from('the quick brown fox');
eq(hay.indexOf(B.from('brown')), 10, 'indexOf finds a buffer needle');
eq(hay.indexOf(B.from('brown'), 11), -1, 'indexOf honours byteOffset');
eq(hay.indexOf(0x20), 3, 'indexOf still finds a number needle');
eq(hay.includes(B.from('fox')), true, 'includes finds a buffer needle');

eq(B.from('hello').toString('hex'), '68656c6c6f', 'toString(hex) matches Node');
eq(B.from('hello world').toString('latin1', 6, 11), 'world', 'toString(latin1, start, end) honours the range');
eq(B.from([0xc3, 0xa9]).toString('utf8'), 'é', 'toString(utf8) decodes multibyte');

const sub = B.from([0x01, 0x02, 0x03, 0x04]).subarray(0, 4);
eq(typeof sub.readUInt32LE, 'function', 'subarray returns a buffer, not a bare Uint8Array');
eq(sub.readUInt32LE(0), 0x04030201, 'a subarray still reads');

// SHA-256 across every padding-length class.
for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 4096]) {
  const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
  const mine = b.sha256(bytes).toString('hex');
  const theirs = crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  eq(mine, theirs, `sha256 matches Node at length ${n}`);
}

// And through the reader's own digest, which is what `fingerprint` calls.
const { digestOf: nodeDigest } = await import(pathToFileURL(path.join(ROOT, 'src', 'macho.mjs')).href);
const sets = [
  [], ['a'], ['a', 'b'], ['ab', 'c'], ['a', 'bc'],
  ['runtime.main', 'runtime.goexit', '_main'],
  Array.from({ length: 500 }, (_, i) => `sym_${i}`),
];
for (const set of sets) eq(b.digestOf(set), nodeDigest(set), `digestOf matches Node for ${set.length} name(s)`);

/* ------------------------------------------------------------------ *
 * 3. same answer, both hosts
 * ------------------------------------------------------------------ */

console.log('\nequivalence');

const api = await import(pathToFileURL(path.join(ROOT, 'src', 'api.mjs')).href);
const fixtures = fs.readdirSync(path.join(ROOT, 'test', 'fixtures')).filter((f) => f.endsWith('.macho')).sort();

// BigInt does not survive JSON.stringify, and the reader's addresses are BigInt,
// so both sides are canonicalised the same way before comparison.
const canon = (v) => JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? `#${val.toString(16)}` : val));

let identical = 0;
for (const fx of fixtures) {
  const rel = path.join('test', 'fixtures', fx);
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, rel)));
  b.memoryFs.clear();
  b.memoryFs.register(rel, bytes);

  const mine = canon(b.describe(rel));
  const theirs = canon(api.describe(rel));
  if (mine === theirs) { identical++; } else {
    bad(`describe differs from Node on ${fx}`);
    // Point at the first differing character rather than dumping two objects.
    let i = 0;
    while (i < mine.length && i < theirs.length && mine[i] === theirs[i]) i++;
    console.log(`        first difference at char ${i}:`);
    console.log(`          node:    …${theirs.slice(Math.max(0, i - 40), i + 60)}…`);
    console.log(`          browser: …${mine.slice(Math.max(0, i - 40), i + 60)}…`);
  }
}
if (identical === fixtures.length) ok(`describe is identical on all ${fixtures.length} fixtures`);

let ovIdentical = 0;
for (const fx of fixtures) {
  const rel = path.join('test', 'fixtures', fx);
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, rel)));
  b.memoryFs.clear();
  b.memoryFs.register(rel, bytes);
  const mine = canon(b.overview(rel, { symbols: true, strings: true, max: 500 }));
  const theirs = canon(api.overview(rel, { symbols: true, strings: true, max: 500 }));
  if (mine === theirs) ovIdentical++;
  else bad(`overview differs from Node on ${fx}`);
}
if (ovIdentical === fixtures.length) ok(`overview (symbols + strings) is identical on all ${fixtures.length} fixtures`);

/* ------------------------------------------------------------------ *
 * 4. the .app drop path resolves a directory to its executable
 * ------------------------------------------------------------------ *
 * `demo/app.mjs` offers a `.app` bundle in its headline, and a bundle is a
 * directory — `dataTransfer.files[0]` is not the executable. The walk that
 * finds it lives in `demo/bundle-drop.mjs` precisely so it can be driven here
 * with fake entries, and the multi-batch case is the reason: a reader yields at
 * most ~100 entries per call, and the first version recreated it each call,
 * which restarts from the top and never terminates. That is a hang, not a
 * failing assertion, which is why it is tested at all.
 */

console.log('\nbundle drop');
{
  const { executableInBundle, walk } = await import(pathToFileURL(path.join(ROOT, 'demo', 'bundle-drop.mjs')).href);

  // A directory whose reader yields the given batches in order, then an empty
  // batch — the same contract the browser's FileSystemDirectoryReader has.
  // The cursor is per-reader, as a real FileSystemDirectoryReader's is: a fresh
  // `createReader()` restarts from the top, which is exactly why the drain loop
  // must reuse one reader rather than making a new one each pass.
  const dir = (name, batches) => ({
    isFile: false, isDirectory: true, name,
    createReader() {
      let i = 0;
      return { readEntries: (cb) => cb(i < batches.length ? batches[i++] : []) };
    },
  });
  const file = (name) => ({ isFile: true, isDirectory: false, name, file: (res) => res({ name }) });

  const app = dir('MyApp.app', [[ dir('Contents', [[ dir('MacOS', [[file('MyApp')]]) ]]) ]]);
  eq((await executableInBundle(app))?.name, 'MyApp', 'a .app bundle resolves to Contents/MacOS/<bundle>');

  const other = dir('Other.app', [[ dir('Contents', [[ dir('MacOS', [[file('actual-bin'), file('other')]]) ]]) ]]);
  eq((await executableInBundle(other))?.name, 'actual-bin', 'an executable not named like its bundle falls back to the first file in Contents/MacOS');

  const notApp = dir('Docs', [[file('readme.txt')]]);
  eq(await executableInBundle(notApp), null, 'a folder with no Contents/MacOS answers null, not a wrong file');

  const many = dir('Many.app', [[ dir('Contents', [[ dir('MacOS', [[file('f1'), file('f2')], [file('f3')]]) ]]) ]]);
  eq((await executableInBundle(many))?.name, 'f1', 'a directory spanning several readEntries batches is drained, not restarted');
  const paths = (await walk(many)).map((w) => w.path);
  eq(paths.join(','), 'Contents/MacOS/f1,Contents/MacOS/f2,Contents/MacOS/f3', 'walk returns every file across batches, with repo-relative paths');
}

console.log(
  failed === 0
    ? `\n${passed} passed. The demo runs the reader, and both hosts agree.\n`
    : `\n${passed} passed, ${failed} FAILED. The demo is not the reader it claims.\n`,
);
process.exit(failed === 0 ? 0 : 1);
