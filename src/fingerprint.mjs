#!/usr/bin/env node
/**
 * fingerprint.mjs — is this the same program as that one?
 *
 *   macho-explorer fingerprint <binary>            # what is it
 *   macho-explorer fingerprint <a> <b>             # are these the same program
 *   macho-explorer fingerprint <a> <b> --json
 *
 * ## Three questions, three answers
 *
 * "Are these the same file?", "is this the same build?" and "is this the same
 * program?" are different questions, and byte comparison answers all three badly.
 * Two builds of one source differ in every address (PIE and ASLR), in the
 * current-version fields of the dylibs they load, and in any timestamp — so `cmp`
 * calls them different. Two different programs built from one template with a
 * function renamed differ in almost nothing structural — so a loose structural diff
 * calls them the same.
 *
 * So all three answers are reported, and the caller picks by which they meant:
 *
 *   uuid         the same build. Exact, and useless the moment anything relinks.
 *   fingerprint  the same program. Survives a rebuild; changes if a symbol or a
 *                section does.
 *   structure    the same shape. Weaker, and all a stripped binary can offer.
 *
 * Nothing that a rebuild moves goes into the digest: no address, no size, no
 * offset, and no `LC_UUID` / `LC_CODE_SIGNATURE` / `LC_SOURCE_VERSION`, which record
 * the build rather than the program. Those are reported separately instead.
 *
 * ## Exit status
 *
 *   0  same program (or a single file, which always succeeds)
 *   1  different programs
 *   2  usage error
 *   3  a file could not be read
 *
 * Same shape as every other tool here: 1 is a negative *answer*, not a failure.
 * Note the consequence — a comparison where one side is stripped exits 0 on a
 * structural match, so `caveat` says so. A gate that needs more than shape should
 * compare UUIDs, which is what they are for.
 */
import { requireBinary } from './target.mjs';
import { fingerprint, compareFingerprints } from './api.mjs';
import { parseArgs, emitJSON, EXIT, rejectUnknownFlags, isQuiet, isVerbose, colorEnabled, colorize, quietLog, verboseLog } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: macho-explorer fingerprint <binary> [<other-binary>] [--json] [--arch=<name>]',
  '',
  '  with one binary, reports its fingerprint. With two, reports whether they are',
  '  the same program — which survives a rebuild, unlike a byte comparison.',
  '',
  'options:',
  '  --arch=<name>      fingerprint only this slice of a universal binary',
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

rejectUnknownFlags(new Set(['arch', 'json']), flags, HELP);

// Two positionals is a comparison, one is a lookup. Resolved through the same
// fallback chain as every other tool, so `$MACHO_EXPLORER_BINARY` supplies the
// first path and the second still has to be named.
if (positional.length === 0) {
  process.stderr.write(HELP.join('\n') + '\n');
  process.exit(EXIT.usage);
}
if (positional.length > 2) {
  process.stderr.write(`fingerprint: expected one or two binaries, got ${positional.length}\n`);
  process.stderr.write('  to compare many files, run it once per pair.\n');
  process.exit(EXIT.usage);
}

const arch = opts.arch;
const first = requireBinary({ argv: opts.b || opts.binary || positional[0] });

let result;
let comparing = false;
try {
  if (positional.length === 2) {
    comparing = true;
    // `--arch` narrows *both* sides, summary and rows together. It is the comparison
    // a caller wants when one side is a thin binary and the other universal.
    result = compareFingerprints(first, positional[1], { arch });
  } else {
    result = fingerprint(first, { arch });
  }
} catch (e) {
  const which = comparing && e.message.includes(positional[1]) ? positional[1] : first;
  if (flags.has('json')) {
    emitJSON({ tool: 'fingerprint', binary: which, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(e.message);
  process.exit(EXIT.fail);
}

if (!comparing) {
  if (flags.has('json')) {
    emitJSON({
      tool: 'fingerprint',
      binary: first,
      ok: true,
      notes: [
        'the digest excludes everything a rebuild moves: addresses, sizes, offsets, and the provenance commands LC_UUID / LC_CODE_SIGNATURE / LC_SOURCE_VERSION',
        'tier "structure-only" means the binary is stripped, so the match would rest on section and load-command shape alone',
      ],
      data: result,
    }, EXIT.ok);
  }
  console.log(`${first} — ${result.fingerprint ?? 'unreadable'}  ${result.tier ?? ''}`);
  for (const s of result.slices) {
    console.log(
      `  ${s.arch.padEnd(8)} ${s.fingerprint}  ${s.tier.padEnd(16)} ` +
        `${s.nsyms} symbol(s), ${s.nsects} section(s)  uuid ${s.uuid ?? '-'}`,
    );
  }
  if (result.uuid) console.log(`\n  uuid ${result.uuid}  — same build as anything carrying this value`);
  process.exit(EXIT.ok);
}

// A comparison: 0 when the programs match, 1 when they do not.
const status = result.sameProgram ? EXIT.ok : EXIT.empty;

if (flags.has('json')) {
  emitJSON({
    tool: 'fingerprint',
    binary: first,
    ok: true,
    notes: [
      'sameBuild compares UUIDs (same build); sameProgram compares fingerprints (same program, modulo rebuild)',
      'rebuilt is true only when differing UUIDs prove a rebuild happened',
    ],
    data: result,
  }, status);
}

const short = (v) => (v ? v.slice(0, 12) : '-');
console.log(`${result.a.path} — ${result.a.fingerprint ?? '-'}  ${result.a.tier ?? ''}`);
console.log(`${result.b.path} — ${result.b.fingerprint ?? '-'}  ${result.b.tier ?? ''}`);
for (const row of result.byArch) {
  const verdict = !row.presentInBoth
    ? 'absent on the other side'
    : row.match ? 'match' : 'differ';
  console.log(`  ${row.arch.padEnd(8)} ${short(row.fingerprint)} vs ${short(row.other)}  ${verdict}`);
}
console.log(`\n  ${result.verdict}`);
if (result.caveat) console.log(`  note: ${result.caveat}`);

process.exit(status);