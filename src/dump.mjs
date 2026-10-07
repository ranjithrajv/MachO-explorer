#!/usr/bin/env node
/**
 * dump.mjs — the bytes at a virtual address, resolved through its section.
 *
 *   node src/dump.mjs <hex-vaddr> [binary|bundle] [--len=<n>] [--arch=<name>] [--json]
 *
 * `a2o` turns an address into a file offset and stops there. The next question is
 * always "what are the bytes", and the answer is not a plain `dd` window: the
 * address resolves to a section, the dump starts there and stops at that
 * section's own end. Reading past the boundary silently blends two sections —
 * `__cstring` into `__const`, or the tail of `__text` into whatever the linker
 * packed after it — and a reader comparing those bytes against a hex editor's
 * window would be looking at two different things without being told.
 *
 * ## Three answers, not two
 *
 * An address can reach a byte, be mapped with no byte (`__bss`, `__PAGEZERO`, the
 * tail of `__DATA` past `filesize`), or be in no slice at all. All three are
 * answers, and all three exit under the taxonomy every tool here uses:
 *
 *   0  bytes were dumped
 *   1  the address is mapped with no byte, or in no slice — a negative answer
 *   2  usage error
 *   3  the file could not be read
 *
 * `1` rather than `3` is the important one. `dump 0xdeadbeef` answered the
 * question; a caller that treats that as a crash will stop using the exit status,
 * and then a genuine failure reads the same as a miss.
 */
import { requireBinary } from './target.mjs';
import { dumpBytes } from './api.mjs';
import { parseArgs, emitJSON, usage, EXIT, rejectUnknownFlags } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: node src/dump.mjs <hex-vaddr> [binary|bundle] [--len=<n>] [--arch=<name>] [--json] [-b <binary>]',
  '',
  '  the bytes at a virtual address, resolved through the section that maps it',
  '  and stopped at that section\'s end. Reports the section, the file offset,',
  '  and one row per 16 bytes as address | hex | ascii.',
  '',
  'options:',
  '  --len=<n>          how many bytes to read, at most (default 64, max 1048576)',
  '  --arch=<name>      read one architecture (x86_64, arm64, arm64e, arm64_32, ppc, ppc64, arm, i386)',
  '  -b, --binary <p>   the binary to read',
  '  --json             one JSON object on stdout; prose to stderr',
  '  -h, --help         this message',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set(['json', 'len', 'arch']), flags, HELP);

if (positional.length === 0) usage(HELP);

// A path and an address are told apart by shape, never guessed at: a typo in an
// address that fell through as a path would produce a confident wrong answer.
const bad = positional[0];
if (!/^0x[0-9a-fA-F]+$/.test(bad)) {
  usage(['addresses must be hex with an 0x prefix, e.g. 0x100000c70', `  got: ${bad}`]);
}

// `--len` is parsed here rather than trusted, because `Number('abc')` is `NaN`
// and `Number('')` is 0, and a 0-byte dump that reported success would be the
// "checked nothing" failure this project keeps fixing.
const length = opts.len === undefined ? 64 : Number(opts.len);
if (!Number.isInteger(length) || length < 1) {
  usage([`--len must be a whole number of bytes >= 1`, `  got: ${opts.len}`]);
}

const binary = requireBinary({ argv: opts.b || opts.binary || positional[1] });
const arch = opts.arch;

let r;
try {
  r = dumpBytes(binary, BigInt(positional[0]), { arch, length });
} catch (e) {
  if (flags.has('json')) {
    emitJSON({ tool: 'dump', binary, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(`${binary}: ${e.message}`);
  process.exit(EXIT.fail);
}

// A negative answer is a value, not an error: `ok` stays true and the notes say
// which of the three no-byte cases it was. The exit status is where a script
// branches.
const notes = [];
if (!r.mapped) notes.push('this address is in no slice of the file — check the address, and --arch if it is universal');
else if (r.zerofill) notes.push(`${r.section} is zero-fill: mapped at this address, but no byte of it exists in the file`);
if (r.found && r.truncated) notes.push(`stopped at the end of ${r.section} after ${r.bytes} of ${r.requestedBytes} requested byte(s)`);

const status = r.found ? EXIT.ok : EXIT.empty;

if (flags.has('json')) {
  emitJSON({
    tool: 'dump',
    binary,
    ok: true,
    notes: [
      'the dump is bounded by the section that maps the address, so it never blends into the next section',
      ...notes,
    ],
    data: r,
  }, status);
}

const hex = (v) => (v === null || v === undefined ? '-' : `0x${v.toString(16)}`);

console.log(`${binary}${r.arch ? `  [${r.arch}]` : ''}`);
if (!r.found) {
  console.log(`\n  ${r.vaddr}  no bytes`);
  if (!r.mapped) console.log('    the address is in no slice of this file');
  else if (r.zerofill) console.log(`    ${r.section} is zero-fill — mapped in memory, absent from the file`);
  console.log(`    mapped ${r.mapped}, zerofill ${r.zerofill}`);
} else {
  console.log(
    `\n  ${r.vaddr}  ${r.section}  ` +
      `${r.bytes} byte(s)` +
      (r.truncated ? ` of ${r.requestedBytes} (stopped at the section end)` : ''),
  );
  console.log(`  file offset ${hex(r.offset)} (absolute ${hex(r.absoluteOffset)})`);
  for (const l of r.lines) {
    console.log(`    ${l.vaddr}  ${l.hex.padEnd(47)}  ${l.ascii}`);
  }
}

process.exit(status);
