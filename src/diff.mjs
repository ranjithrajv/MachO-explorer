#!/usr/bin/env node
/**
 * diff.mjs — what changed between two binaries, ignoring what a rebuild moves.
 *
 *   macho-explorer diff <a> <b> [--json] [--arch=<name>] [--max=<n>]
 *
 * ## Why not `cmp`
 *
 * `cmp` between two builds of one source reports that every byte from the load base
 * onwards differs, because PIE and ASLR move every address, a dependency bump moves a
 * dylib's version fields, and a rebuild moves any timestamp. "Everything changed"
 * cannot distinguish a rebuilt binary from a different program, and cannot tell a
 * reviewer that the one thing they cared about did not move.
 *
 * This diff is over structural facts: which architectures are present, which header
 * flags are set, which load commands and sections exist, which symbols are defined.
 * None of those move on a rebuild, and all of them change when the program does.
 *
 * ## Three lists, and why the verdict only reads one
 *
 *   differences     structural changes — the verdict is computed from these alone
 *   buildMetadata   UUIDs, and the presence of signing/provenance commands
 *   sizeChanges     section sizes, reported because they matter and counted
 *                   separately because a recompiled dependency moves them
 *
 * Build metadata is reported rather than hidden, and kept out of the verdict for the
 * same reason `fingerprint` excludes it: a tool that called every rebuilt pair
 * "changed" would be `cmp` with better manners.
 *
 * ## Exit status
 *
 *   0  no structural differences
 *   1  there are structural differences — a negative answer, not a failure
 *   2  usage error
 *   3  a file could not be read
 *
 * Note that two builds of one program exit 0 with `buildMetadata` full: that is the
 * case this tool exists for, and it would be absurd to fail it.
 */
import { requireBinary } from './target.mjs';
import { diffBinaries } from './api.mjs';
import { parseArgs, emitJSON, usage, EXIT, rejectUnknownFlags, isQuiet, isVerbose, colorEnabled, colorize, quietLog, verboseLog } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: macho-explorer diff <binary> <binary> [--json] [--arch=<name>] [--max=<n>]',
  '',
  '  structural differences only: architectures, header flags, load commands,',
  '  sections and symbols. Addresses, sizes, offsets and the build UUID are not',
  '  counted as differences — a rebuilt binary should not read as a different one.',
  '',
  'options:',
  '  --arch=<name>      compare only this architecture',
  '  --max=<n>          cap on symbol names listed per direction (default 20)',
  '  --json             one JSON object on stdout; prose to stderr',
  '  -q, --quiet        suppress non-essential output',
  '  --color            force color output',
  '  --no-color         disable color output',
  '  -v, --verbose      diagnostic output',
  '  -h, --help         this message',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set(['arch', 'max', 'json']), flags, HELP);

if (positional.length !== 2) {
  usage([
    ...HELP,
    '',
    `  expected exactly two binaries, got ${positional.length}`,
  ]);
}

// Both paths are resolved the same way as every other tool, so the first can come
// from `$MACHO_EXPLORER_BINARY` while the second is named. Reading them as a pair and
// nothing else means a mistyped count is a usage error rather than a diff of one file
// against nothing.
const first = requireBinary({ argv: opts.b || opts.binary || positional[0] });
const second = positional[1];

const maxNames = opts.max === undefined ? 20 : Number(opts.max);
if (!Number.isInteger(maxNames) || maxNames < 1) {
  usage(['--max must be a whole number of at least 1']);
}

let result;
try {
  result = diffBinaries(first, second, { arch: opts.arch, maxNames });
} catch (e) {
  if (flags.has('json')) {
    emitJSON({ tool: 'diff', binary: first, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(e.message);
  process.exit(EXIT.fail);
}

// The verdict follows the structural differences only. A pair that differs solely in
// its UUIDs is the same program rebuilt, and must not fail a gate.
const status = result.differences.length === 0 ? EXIT.ok : EXIT.empty;

if (flags.has('json')) {
  emitJSON({
    tool: 'diff',
    binary: first,
    ok: true,
    notes: [
      'differences are structural; addresses, sizes, offsets and the UUID are not counted',
      'buildMetadata records the changes a rebuild makes, which is why a rebuilt pair can have differences: [] and still differ',
    ],
    data: { ...result, other: second },
  }, status);
}

console.log(first);
console.log(second);
console.log(`\n  ${result.verdict}  —  ${result.counts.differences} structural difference(s), ` +
  `${result.counts.buildMetadata} build-metadata change(s), ${result.counts.sizeChanges} size change(s)`);

for (const row of result.perArch) {
  console.log(`\n  ${row.arch}  symbols ${row.symbols.a} -> ${row.symbols.b} ` +
    `(+${row.symbols.added}/-${row.symbols.removed}), sections ${row.sections.a} -> ${row.sections.b}`);
}

if (result.differences.length) {
  console.log('\n  differences:');
  for (const d of result.differences) {
    console.log(`    [${d.category}] ${d.detail}`);
  }
} else {
  console.log('\n  no structural differences');
}

if (result.buildMetadata.length) {
  console.log('\n  build metadata (not counted as differences):');
  for (const m of result.buildMetadata) console.log(`    ${m.detail}`);
}

if (result.sizeChanges.length) {
  console.log('\n  size changes (not counted as differences — a recompiled dependency moves these):');
  for (const s of result.sizeChanges.slice(0, 10)) {
    console.log(`    ${s.section}: ${s.a} -> ${s.b} (${s.delta >= 0 ? '+' : ''}${s.delta})`);
  }
  if (result.sizeChanges.length > 10) {
    console.log(`    ... and ${result.sizeChanges.length - 10} more`);
  }
}

process.exit(status);