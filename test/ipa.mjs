/**
 * ipa.mjs — test the .ipa reader.
 *
 * Creates a minimal ZIP archive containing a fake .app bundle with a
 * Mach-O executable, then verifies that resolveIpa extracts it correctly.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveIpa, cleanupIpa, isIpa } from '../src/ipa.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ok: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

/** Compute CRC32. */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Build a minimal ZIP file. */
function makeZip(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localHeaders.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt16LE(0, 38);
    ch.writeUInt32LE(0, 42);
    centralHeaders.push(ch, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const centralSize = centralHeaders.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

/** Create a minimal arm64 Mach-O header. */
function makeMachO() {
  const macho = Buffer.alloc(32);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeInt32LE(0x0100000c, 4);
  macho.writeInt32LE(0, 8);
  macho.writeUInt32LE(2, 12);
  macho.writeUInt32LE(0, 16);
  macho.writeUInt32LE(0, 20);
  macho.writeUInt32LE(0, 24);
  macho.writeUInt32LE(0, 28);
  return macho;
}

console.log('ipa:');

// Test isIpa
assert(isIpa('test.ipa'), 'isIpa detects .ipa extension');
assert(isIpa('test.IPA'), 'isIpa is case-insensitive');
assert(!isIpa('test.app'), 'isIpa rejects .app');
assert(!isIpa('test.dmg'), 'isIpa rejects .dmg');
assert(!isIpa(null), 'isIpa handles null');

// Test resolveIpa with a valid IPA
const macho = makeMachO();
const ipa = makeZip([
  { name: 'Payload/TestApp.app/', data: Buffer.alloc(0) },
  { name: 'Payload/TestApp.app/Contents/', data: Buffer.alloc(0) },
  { name: 'Payload/TestApp.app/Contents/MacOS/', data: Buffer.alloc(0) },
  { name: 'Payload/TestApp.app/Contents/MacOS/TestApp', data: macho },
  { name: 'Payload/TestApp.app/Info.plist', data: Buffer.from('<?xml version="1.0"?><plist></plist>') },
]);

const tmpIpa = path.join(os.tmpdir(), `test-ipa-${process.pid}.ipa`);
fs.writeFileSync(tmpIpa, ipa);

const result = resolveIpa(tmpIpa);
assert(result !== null, 'resolveIpa returns a path for a valid IPA');

if (result) {
  const buf = fs.readFileSync(result);
  assert(buf.length === 32, 'extracted file has correct size');
  assert(buf.readUInt32LE(0) === 0xfeedfacf, 'extracted file has Mach-O magic');
  cleanupIpa(result);
  assert(!fs.existsSync(result), 'cleanupIpa removes the temp file');
}

// Test resolveIpa with a non-IPA file
const notIpa = path.join(os.tmpdir(), `test-not-ipa-${process.pid}.txt`);
fs.writeFileSync(notIpa, Buffer.from('hello'));
assert(resolveIpa(notIpa) === null, 'resolveIpa returns null for non-IPA');

// Test resolveIpa with a malformed ZIP
const badZip = path.join(os.tmpdir(), `test-bad-zip-${process.pid}.ipa`);
fs.writeFileSync(badZip, Buffer.from('not a zip file at all'));
assert(resolveIpa(badZip) === null, 'resolveIpa returns null for malformed ZIP');

// Test resolveIpa with a ZIP that has no .app
const noApp = makeZip([
  { name: 'README.txt', data: Buffer.from('hello') },
]);
const noAppPath = path.join(os.tmpdir(), `test-no-app-${process.pid}.ipa`);
fs.writeFileSync(noAppPath, noApp);
assert(resolveIpa(noAppPath) === null, 'resolveIpa returns null when no .app found');

// Cleanup
for (const f of [tmpIpa, notIpa, badZip, noAppPath]) {
  try { fs.unlinkSync(f); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
