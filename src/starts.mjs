#!/usr/bin/env node
/**
 * starts.mjs — where functions begin, from the linker's own list.
 *
 *   node src/starts.mjs [binary|bundle] [--symbols] [--max=<n>] [--arch=<name>] [--json]
 *
 * `LC_FUNCTION_STARTS` is a list of every function's entry address that the
 * linker wrote into the binary. It is the only such list a stripped binary
 * carries: the symbol table is gone, but the command survives because the
 * unwinder needs it at runtime. On a shipped build it is the difference between
 * a column of addresses and no structure at all; on a symballed one it is a
 * cross-check on the symbol values.
 *
 * ## Every address gets a name
 *
 * A function start with no symbol on it is labeled `sub_<hex>`. That is a name
 * for the address, not a claim about what the function does — but it is what
 * turns a list of numbers into something a person can scan, and what lets a
 * report say "0x100000f50" and "sub_100000f50" and mean the same site.
 *
 * ## Present, empty, and absent are three things
 *
 *   0  the linker recorded function starts
 *   1  there are none — the blob is empty, or the file carries no
 *      LC_FUNCTION_STARTS at all. A negative answer, not an error
 *   2  usage error
 *   3  the file could not be read
 *
 * An object file and a hand-built binary are the usual reasons for the second,
 * and a caller that reads "nothing" as a crash will not look again.
 */
import { requireBinary } from './target.mjs';
import { listFunctionStarts } from './api.mjs';
import { parseArgs, emitJSON, usage, EXIT, rejectUnknownFlags, count } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: node src/starts.mjs [binary|bundle] [--symbols] [--max=<n>] [--arch=<name>] [--json] [-b <binary>]',
  '',
  '  every function entry the linker recorded, read from LC_FUNCTION_STARTS,',
  '  one address per line, each labeled sub_<hex> and named where a symbol',
  '  sits on it.',
  '',
  'options:',
  '  --symbols          add the defined symbol sitting on each start, when there is one',
  '  --max=<n>          cap the list (default: all); the count stays exact',
  '  --arch=<name>      read one architecture (x86_64, arm64, arm64e, arm64_32, ppc, ppc64, arm, i386)',
  '  -b, --binary <p>   the binary to read',
  '  --json             one JSON object on stdout; prose to stderr',
  '  -h, --help         this message',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set(['json', 'symbols', 'max', 'arch']), flags, HELP);

const max = opts.max === undefined ? 0 : Number(opts.max);
if (!Number.isInteger(max) || max < 0) {
  usage([`--max must be a whole number >= 0 (0 means all)`, `  got: ${opts.max}`]);
}

const binary = requireBinary({ argv: opts.b || opts.binary || positional[0] });
const arch = opts.arch;

let r;
try {
  r = listFunctionStarts(binary, { arch, symbols: flags.has('symbols'), max });
} catch (e) {
  if (flags.has('json')) {
    emitJSON({ tool: 'starts', binary, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(`${binary}: ${e.message}`);
  process.exit(EXIT.fail);
}

// A negative answer is a value: `ok` stays true, the note says why, and the exit
// status is what a script branches on.
const notes = [];
if (!r.present) {
  notes.push('this file carries no LC_FUNCTION_STARTS — an object file or a hand-built binary usually has none, and the linker recorded no function starts to read');
} else if (r.count === 0) {
  notes.push('LC_FUNCTION_STARTS is present but empty — the linker recorded no functions');
}
if (r.blobTruncated) {
  notes.push('the LC_FUNCTION_STARTS blob ends mid-value, so the last delta was dropped — the file is damaged or was clipped');
}
if (r.capped) {
  notes.push(`showing ${r.functions.length} of ${r.count} function start(s); the count is exact`);
}
if (r.named !== null && r.present) {
  notes.push(`${count(r.named)} of ${count(r.count)} start(s) carry a defined symbol; the rest are labeled sub_<hex>`);
}

const status = r.present && r.count > 0 ? EXIT.ok : EXIT.empty;

if (flags.has('json')) {
  emitJSON({
    tool: 'starts',
    binary,
    ok: true,
    notes: [
      'a start address is where the linker says a function begins; it is not a boundary derived from disassembly',
      ...notes,
    ],
    data: r,
  }, status);
}

console.log(`${binary}${r.arch ? `  [${r.arch}]` : ''}`);
if (!r.present) {
  console.log('\n  no LC_FUNCTION_STARTS: the linker recorded no function starts in this file');
} else {
  console.log(`\n  base ${r.base}  ${count(r.count)} function start(s)${r.named !== null ? `, ${count(r.named)} named` : ''}`);
  for (const fn of r.functions) {
    console.log(`    ${fn.address}  ${fn.label}${fn.symbol ? `  ${fn.symbol}` : ''}`);
  }
  if (r.capped) console.log(`    ...and ${count(r.count - r.functions.length)} more (raise --max)`);
  if (r.blobTruncated) console.log('    the blob ends mid-value; the last delta was dropped');
}

process.exit(status);
