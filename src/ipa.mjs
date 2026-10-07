/**
 * ipa.mjs — read the Mach-O executable inside an .ipa file.
 *
 * ## What an .ipa is
 *
 * An .ipa is a ZIP archive with a fixed structure:
 *
 *   MyApp.ipa
 *   └── Payload/
 *       └── MyApp.app/
 *           ├── MyApp              ← the Mach-O executable
 *           ├── Info.plist
 *           └── ...
 *
 * The executable name matches the .app directory name (minus the .app extension).
 * This is the same convention as a bare .app bundle on disk.
 *
 * ## Why a minimal ZIP reader
 *
 * Node has no built-in ZIP parser. A full ZIP implementation is ~500 lines
 * and supports features IPAs never use (encryption, multi-volume, data
 * descriptors). This module implements only what an .ipa needs:
 *
 * - Locate the End of Central Directory record
 * - Walk the central directory to find entries
 * - Read local file headers to get data offsets
 * - Decompress deflate-compressed entries (stored entries pass through)
 *
 * It is deliberately incomplete: it does not handle encryption, ZIP64,
 * or data descriptors. A file that needs those will fail loudly rather
 * than silently produce wrong output.
 *
 * ## Why not extract to disk
 *
 * The alternative is to unzip the .ipa to a temp directory and point
 * the existing tools at the extracted .app. That is simpler but leaves
 * artifacts on disk and requires cleanup. Reading the executable directly
 * from the ZIP central directory is cleaner: the bytes are already in
 * memory, and the existing `executableIn` logic can work on a virtual
 * filesystem.
 *
 * ## Integration
 *
 * `target.mjs` calls `resolveIpa` when it sees an .ipa path. That function
 * returns the path to a temporary file containing the extracted Mach-O
 * executable, or null if the .ipa is malformed or contains no executable.
 * The caller is responsible for deleting the temporary file.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { bundleLayout } from './bundle.mjs';

/** Mach-O magic numbers (little-endian). */
const MACHO_MAGICS_32 = [0xfeedface, 0xcefaedfe];
const MACHO_MAGICS_64 = [0xfeedfacf, 0xcffaedfe];
const FAT_MAGICS = [0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca];

/**
 * Check if a byte buffer starts with a Mach-O magic number.
 *
 * This is the buffer-based equivalent of `isMachOFile` in macho.mjs, which
 * reads from a file path. We need this because the .ipa reader works with
 * in-memory buffers extracted from the ZIP archive.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isMachOBuffer(buf) {
  if (buf.length < 4) return false;
  const magic = buf.readUInt32LE(0);
  return (
    MACHO_MAGICS_32.includes(magic) ||
    MACHO_MAGICS_64.includes(magic) ||
    FAT_MAGICS.includes(magic)
  );
}

/** ZIP signatures. */
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Compression methods. */
const COMP_STORED = 0;
const COMP_DEFLATED = 8;

/**
 * Find the End of Central Directory record.
 *
 * The EOCD is at the end of the file, but its exact position depends on
 * the comment length. We search backwards from the end for the signature.
 *
 * @param {Buffer} buf
 * @returns {number} offset of the EOCD record, or -1 if not found
 */
function findEocd(buf) {
  // Minimum EOCD size is 22 bytes (no comment). Search backwards.
  const min = Math.max(0, buf.length - 22 - 65535); // max comment is 64KB
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Parse the central directory and return all entries.
 *
 * @param {Buffer} buf
 * @returns {Array<{name:string, compressedSize:number, uncompressedSize:number, compressionMethod:number, localHeaderOffset:number}>}
 */
function parseCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('ipa: not a ZIP file (no end of central directory)');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length) throw new Error('ipa: central directory truncated');
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error(`ipa: bad central directory signature at offset ${offset}`);
    }

    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Read a file entry's data from the ZIP.
 *
 * @param {Buffer} buf
 * @param {{name:string, compressedSize:number, compressionMethod:number, localHeaderOffset:number}} entry
 * @returns {Buffer}
 */
function readEntry(buf, entry) {
  const { localHeaderOffset, compressedSize, compressionMethod } = entry;

  if (localHeaderOffset + 30 > buf.length) {
    throw new Error(`ipa: local header for ${entry.name} is out of bounds`);
  }
  if (buf.readUInt32LE(localHeaderOffset) !== LOCAL_SIG) {
    throw new Error(`ipa: bad local header signature for ${entry.name}`);
  }

  const nameLength = buf.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buf.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;

  if (dataOffset + compressedSize > buf.length) {
    throw new Error(`ipa: data for ${entry.name} is out of bounds`);
  }

  const compressed = buf.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === COMP_STORED) {
    return Buffer.from(compressed);
  }
  if (compressionMethod === COMP_DEFLATED) {
    return Buffer.from(zlib.inflateRawSync(compressed));
  }
  throw new Error(`ipa: unsupported compression method ${compressionMethod} for ${entry.name}`);
}

/**
 * Find the `.app` directory inside an `.ipa`.
 *
 * The convention is `Payload/<AppName>.app/`. An explicit directory entry is the
 * cleanest evidence, so it is preferred — but many ZIP writers, including several
 * that Apple's own tooling has shipped, record **no** entry for a directory that
 * holds files. A reader that only matched directory entries would report "no .app
 * found" for a perfectly ordinary `.ipa`, which is the same confident negative the
 * rest of this package exists to avoid.
 *
 * So a file path under `Payload/<name>.app/` is taken as equally good evidence, and
 * the two tests run in one pass: the explicit entry wins where one exists, and the
 * file-derived name fills the gap where it does not.
 *
 * @param {Array} entries
 * @returns {string|null} the .app directory name, e.g. `Payload/MyApp.app`
 */
function findAppDirectory(entries) {
  let fromFile = null;
  for (const entry of entries) {
    const dir = entry.name.match(/^Payload\/([^/]+)\.app\/$/);
    if (dir) return `Payload/${dir[1]}.app`;
    if (!fromFile) {
      const file = entry.name.match(/^Payload\/([^/]+)\.app\//);
      if (file) fromFile = `Payload/${file[1]}.app`;
    }
  }
  return fromFile;
}

/**
 * Find the Mach-O executable inside an `.app` directory within an `.ipa`.
 *
 * ## Two layouts, because two platforms ship them
 *
 * An **iOS** `.app` is flat: the executable sits directly in the bundle, at
 * `Payload/<AppName>.app/<AppName>`. That is the shape of every `.ipa` on the App
 * Store, and it is the one the file format's own header describes.
 *
 * A **macOS** `.app` nests it under `Contents/MacOS/`. An `.ipa` only ever carries
 * the first, but this reader is also handed `.app` directories extracted from macOS
 * packages, and the shared `bundleLayout()` knows that convention. Searching only the
 * nested path — which is what the first version did — finds nothing in a real `.ipa`,
 * because `Payload/<AppName>.app/Contents/MacOS/` does not exist in one.
 *
 * The named path is tried first for each layout, then the largest Mach-O anywhere
 * under the bundle, because a bundle may carry frameworks and helper executables and
 * the one the user means is normally the largest. The name match is authoritative
 * when there is one.
 *
 * @param {Buffer} buf
 * @param {Array} entries
 * @param {string} appDir e.g. `Payload/MyApp.app`
 * @returns {Buffer|null} the executable bytes, or null if not found
 */
function findExecutableInApp(buf, entries, appDir) {
  const appName = path.basename(appDir).replace(/\.app$/, '');
  const macosDir = bundleLayout().macosDir.join('/');

  // iOS layout first: `Payload/MyApp.app/MyApp`.
  const flat = entries.find((e) => e.name === `${appDir}/${appName}`);
  if (flat) {
    const data = readEntry(buf, flat);
    if (isMachOBuffer(data)) return data;
  }

  // macOS layout: `Payload/MyApp.app/Contents/MacOS/MyApp`.
  const nested = entries.find((e) => e.name === `${appDir}/${macosDir}/${appName}`);
  if (nested) {
    const data = readEntry(buf, nested);
    if (isMachOBuffer(data)) return data;
  }

  // Fallback: any Mach-O in the bundle, largest first, so a helper that happens to
  // share the name does not shadow the main executable and a bundle with no name
  // match still answers.
  const prefix = `${appDir}/`;
  const candidates = entries.filter((e) => e.name.startsWith(prefix) && !e.name.endsWith('/'));
  candidates.sort((a, b) => b.uncompressedSize - a.uncompressedSize);

  for (const entry of candidates) {
    const data = readEntry(buf, entry);
    if (isMachOBuffer(data)) return data;
  }

  return null;
}

/**
 * Extract the Mach-O executable from an .ipa file.
 *
 * Returns the path to a temporary file containing the executable bytes.
 * The caller is responsible for deleting this file.
 *
 * @param {string} ipaPath
 * @returns {string|null} path to the extracted executable, or null
 */
export function resolveIpa(ipaPath) {
  let buf;
  try {
    buf = fs.readFileSync(ipaPath);
  } catch {
    return null;
  }

  let entries;
  try {
    entries = parseCentralDirectory(buf);
  } catch {
    return null;
  }

  const appDir = findAppDirectory(entries);
  if (!appDir) return null;

  const exeBytes = findExecutableInApp(buf, entries, appDir);
  if (!exeBytes) return null;

  // Write to a temp file so the existing tools can read it.
  const tmpDir = os.tmpdir();
  const tmpName = `macho-ipa-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.macho`;
  const tmpPath = path.join(tmpDir, tmpName);

  try {
    fs.writeFileSync(tmpPath, exeBytes);
  } catch {
    return null;
  }

  return tmpPath;
}

/**
 * Clean up a temporary file created by {@link resolveIpa}.
 *
 * @param {string|null} tmpPath
 */
export function cleanupIpa(tmpPath) {
  if (!tmpPath) return;
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // best effort
  }
}

/**
 * Check if a path is an .ipa file.
 *
 * @param {string} p
 * @returns {boolean}
 */
export const isIpa = (p) => typeof p === 'string' && p.toLowerCase().endsWith('.ipa');
