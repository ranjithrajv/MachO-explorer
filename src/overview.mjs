#!/usr/bin/env node
/**
 * overview.mjs — the whole structural picture of a binary, in one call.
 *
 *   macho-explorer overview [binary|bundle] [--json] [--symbols] [--strings]
 *
 * ## Why this tool exists
 *
 * Answering "what is this binary" completely costs four invocations today:
 * `describe` for the structure, `sym` for the names, `findliteral --strings` for
 * the strings, and the reader's own judgement about which of a universal binary's
 * slices each of those will pick. That last part is the real cost — four tools
 * choosing independently is how a caller ends up holding a symbol table from one
 * architecture and strings from another, with nothing in either output saying so.
 *
 * This reads the file once and answers once. The structure is `describe`'s own
 * shape, so `.data.slices[0].sections` means here exactly what it means there.
 *
 * ## What it does not do
 *
 * It is not a complete Mach-O parser, and this tool does not pretend to be one.
 * The load commands are named, not interpreted; there is no code signature, no
 * export trie, no ObjC or Swift metadata, no DWARF, and no disassembly. The full
 * list is printed at the end of every text run and travels in the JSON as
 * `notRead`, because a blob that looks exhaustive and is silent about what it
 * skipped is how a pipeline builds a fact out of a gap.
 *
 * That list is the difference between this and a "dump everything" tool, and it
 * is deliberate: see `README.md` § *What it will not do* for why, and
 * `CONTRIBUTING.md` § *Scope comes first* for the test that decides it.
 *
 * ## Why the inventories are opt-in
 *
 * Measured on a 14.5 MB Go binary: the structure is 9.2 KB of JSON, and its 19,526
 * defined symbols turn that into 422 KB once they are included. An overview that
 * included them by default would be 99% symbol table on every binary, and slowest
 * and largest on exactly the binaries where the structural half is what the caller
 * wanted. So structure is always present, and `--symbols` / `--strings` are asked
 * for by name and bounded by `--max`. Whatever the cap drops is reported as
 * `truncated`, never silently shortened.
 */
import { requireBinary, FALLBACK_TARGET } from './target.mjs';
import { overview } from './api.mjs';
import { parseArgs, emitJSON, usage, count, EXIT, rejectUnknownFlags, isQuiet, isVerbose, colorEnabled, colorize, quietLog, verboseLog } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: macho-explorer overview [binary|bundle] [--json] [--symbols] [--strings]',
  '                               [--max=<n>] [--min=<n>] [--compact] [--arch=<name>]',
  '                               [-b <binary>]',
  '',
  '  the whole structural picture of a binary in one call: every slice, its',
  '  segments, sections, load commands, flags and entry point, plus --symbols',
  `  and --strings on request. Defaults to $MACHO_EXPLORER_BINARY, then $MACHO_EXPLORER_APP, then ${FALLBACK_TARGET}`,
  '',
  'options:',
  '  --symbols         include the symbol table (defined names, deduplicated)',
  '  --strings         include the C-string section contents',
  '  --max=<n>         cap on each inventory (default 4000; 0 = unlimited)',
  '  --min=<n>         shortest string to report (default 4)',
  '  --compact         single-line JSON instead of indented (41% smaller)',
  '  --arch=<name>     read one slice of a universal binary (x86_64, arm64, arm64e, arm64_32, ppc, ppc64, arm, i386)',
  '  --json            one JSON object on stdout; prose to stderr',
  '  -b, --binary <p>  the binary to read',
  '  -q, --quiet       suppress non-essential output',
  '  --color           force color output',
  '  --no-color        disable color output',
  '  -v, --verbose     diagnostic output',
  '  -h, --help        this message',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set(['symbols', 'strings', 'max', 'min', 'compact', 'arch', 'json']), flags, HELP);

const binary = requireBinary({ argv: opts.b || opts.binary || positional[0] });

// A number in the wrong flag is a usage error rather than a silent default,
// because `--max=abc` falling back to 4000 would answer a different question
// than the one asked — the same defect `--regexx` used to be.
const number = (name, fallback) => {
  if (opts[name] === undefined) return fallback;
  const n = Number(opts[name]);
  if (!Number.isInteger(n) || n < 0) {
    usage([...HELP, '', `--${name} must be a whole number of 0 or more: got ${JSON.stringify(opts[name])}`]);
  }
  return n;
};

let r;
try {
  r = overview(binary, {
    arch: opts.arch ?? null,
    symbols: flags.has('symbols'),
    strings: flags.has('strings'),
    max: number('max', 4000),
    min: number('min', 4),
  });
} catch (e) {
  if (flags.has('json')) {
    emitJSON({ tool: 'overview', binary, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(`${binary}: ${e.message}`);
  process.exit(EXIT.fail);
}

const notes = [...(r.notes || [])];
if (r.symbols?.note) notes.push(r.symbols.note);
if (r.strings?.note) notes.push(r.strings.note);
if (r.symbols?.arch && r.strings?.arch && r.symbols.arch !== r.strings.arch) {
  // Should be unreachable — both inventories are pinned to one slice — and
  // asserted in the suite. Reported rather than thrown because a warning the
  // reader can act on beats a crash over an inconsistency that would mean the
  // pin itself is broken.
  notes.push(`symbols came from ${r.symbols.arch} but strings from ${r.strings.arch} — the two disagree, which is a bug`);
}

if (flags.has('json')) {
  emitJSON({
    tool: 'overview',
    binary,
    ok: true,
    notes,
    data: r,
    indent: flags.has('compact') ? 0 : 2,
  });
}

const hex = (v) => `0x${v.toString(16)}`;

console.log(`${binary} — ${(r.size / 1048576).toFixed(1)} MB, ${r.fat ? 'universal' : 'thin'}, ${r.slices.length} slice(s)`);
for (const s of r.slices) {
  const sections = s.sections?.length ?? 0;
  const loads = s.loadCommands?.length ?? 0;
  console.log(`  ${s.arch.padEnd(8)} ${s.readable === false ? 'unreadable' : `${sections} section(s), ${loads} load command(s)`}`);
}

// Deliberately not a second copy of `describe`'s per-slice rendering. That output
// is already the right answer to "what is in this binary" and re-printing it here
// would be a second thing to keep correct — the reason `describe.mjs` imports
// `isCodeSection` rather than re-testing it, which this package has shipped a bug
// from before. So the structure is summarised and `describe` is named for detail.
console.log('');
console.log('  structure: every segment, section, load command, header flag and UUID is in --json.');
console.log('  run `describe` for the human-readable listing of the same data.');

if (r.symbols) {
  console.log('');
  console.log(`symbols (${r.symbols.arch}): ${count(r.symbols.count)} defined name(s), ${count(r.symbols.imports)} imported`);
  for (const e of r.symbols.symbols) console.log(`  ${hex(e.addr)}  ${e.name}`);
  if (r.symbols.truncated) {
    console.log(`  … ${count(r.symbols.count - r.symbols.symbols.length)} more not shown — --max=${r.symbols.max}`);
  }
}

if (r.strings) {
  console.log('');
  console.log(`strings (${r.strings.arch}): ${count(r.strings.count)} found in ${count(r.strings.scanned)} scanned byte(s)`);
  for (const s of r.strings.strings) console.log(`  ${hex(s.vaddr)}  ${String(s.section).padEnd(28)}  ${JSON.stringify(s.text)}`);
  if (r.strings.truncated) {
    console.log(`  … not all shown — --max=${r.strings.max}`);
  }
}

// The gap list, every run, in both modes. It is the reason this tool is not
// called `dump`, and it is printed where a reader cannot miss it rather than left
// to a README: a consumer who does not know these were skipped will read an absent
// field as an absent fact.
console.log('');
console.log(`not read by this package (${r.notRead.length}):`);
for (const n of r.notRead) console.log(`  - ${n}`);

console.log('');
for (const n of notes) console.log(`  note: ${n}`);
