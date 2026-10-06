#!/usr/bin/env node
/**
 * audit.mjs — is this file internally consistent?
 *
 *   macho-explorer audit [binary|bundle] [--json] [--sarif] [--strict] [--arch=<name>]
 *   macho-explorer audit --strict build/Contents/MacOS/app
 *   macho-explorer audit --sarif build/Contents/MacOS/app > audit.sarif
 *
 * Every structural check this reader knows about, in one call, with an exit status
 * a build can gate on. `describe` already reports abnormalities per slice; this
 * exists because a report is not a gate.
 *
 * ## The exit status is the product
 *
 *   0  sound — no findings at the requested strictness
 *   1  unsound — at least one finding. A *negative answer*, not an error
 *   2  usage error
 *   3  could not read the file at all
 *
 * 1 rather than 3 is the important one, and it follows the taxonomy every other
 * tool here uses: exit 1 means "the tool ran and its answer was no". An audit that
 * found something wrong has done its job, and a caller that treats that as a crash
 * will switch the gate off within a week.
 *
 * The distinction from 3 is load-bearing in the other direction too: an unreadable
 * file is *not* a passing audit. `audit /nope` exits 3, so a typo in a CI script
 * cannot be mistaken for a clean bill of health.
 *
 * ## Strictness, and why the default is not the strict one
 *
 * Findings carry `severity`, on one question: can the reader's answers still be
 * trusted?
 *
 *   error    the file disagrees with itself — a size or extent points at bytes
 *            that are not there, so anything computed from it may be wrong
 *   warning  the file parsed and the answers are probably right, but something
 *            is unfamiliar or explicitly heuristic
 *
 * By default only errors fail. `--strict` fails on warnings too, which is the right
 * setting for a release gate you control the toolchain for, and the wrong one
 * otherwise: a binary built by an Xcode newer than this reader sets a flag bit the
 * header has no name for, and failing every build over that trains people to pass
 * `--no-audit`. A gate that only fires on genuine damage is a gate people leave on.
 *
 * ## What is deliberately not a finding
 *
 * Unknown *load commands*. `describe --loads` names those by number on purpose —
 * an unfamiliar-but-valid command is present, not broken — so grading it as damage
 * here would contradict that and fire on every binary from a newer linker.
 *
 * Overlapping fat slices *are* a finding, and the reason is worth stating: both
 * slices parse cleanly and no per-slice check can see it, because each is
 * internally consistent. What it costs is visible in the `bent` fixture — the second
 * slice's bytes overwrite the first's string table, so that slice reports six symbol
 * entries and no names, a shape otherwise indistinguishable from a stripped binary.
 */
import { requireBinary } from './target.mjs';
import { audit } from './api.mjs';
import { auditSarif } from './sarif.mjs';
import { parseArgs, emitJSON, usage, toJSON, writeAllSync, EXIT, rejectUnknownFlags, isQuiet, isVerbose, colorEnabled, colorize, quietLog, verboseLog } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: macho-explorer audit [binary|bundle] [--json] [--sarif] [--strict] [--arch=<name>] [-b <binary>]',
  '',
  '  checks every structural claim a Mach-O makes about itself, and exits',
  '  non-zero when the file does not hold together. 0 = sound, 1 = unsound',
  '  (a negative answer, not an error), 2 = usage, 3 = could not read the file.',
  '',
  'options:',
  '  --strict           fail on warnings too, not only on errors',
  '  --sarif            SARIF 2.1.0 on stdout, for GitHub Code Scanning and any',
  '                     other SARIF consumer. Findings are rules named by their',
  '                     own `kind`, so a second run matches the first run rather',
  '                     than filing a new alert. Implies no prose on stdout.',
  '  --arch=<name>      audit only this slice of a universal binary; container',
  '                     findings are still reported, since they are about the file',
  '  --json             one JSON object on stdout; prose to stderr',
  '  -b, --binary <p>   the binary to audit',
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

rejectUnknownFlags(new Set(['strict', 'arch', 'json', 'sarif']), flags, HELP);

// `--sarif` and `--json` are two renderings of one answer, not two answers, so
// this is a usage error rather than a precedence rule. Silently preferring one
// means a CI script that added `--sarif` to a `--json` command line gets JSON,
// writes it to a `.sarif` file, and the Code Scanning upload fails much later
// with a parse error that names nothing about which of two flags was dropped.
if (flags.has('sarif') && flags.has('json')) {
  usage([...HELP, '', '--sarif and --json cannot both be given: they are two formats for one answer.']);
}

const sarif = flags.has('sarif');

const binary = requireBinary({ argv: opts.b || opts.binary || positional[0] });
const arch = opts.arch;
const strict = flags.has('strict');

let result;
try {
  result = audit(binary, { arch, strict });
} catch (e) {
  // Reason codes rather than one blanket `io`, because the two failures a CI script
  // makes most often need different responses: a mistyped path is a bug in the
  // script, a file that is not Mach-O is a bug in the pipeline feeding it.
  if (flags.has('json')) {
    emitJSON({ tool: 'audit', binary, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  // An unreadable file is *not* an audit finding. Reporting it as SARIF results
  // would put a finding on the commit for a typo in the workflow's own path, and
  // the finding would be indistinguishable from "this binary is damaged". So the
  // file is written as a run that executed and reported nothing, with the reason
  // in a notification, and the exit code carries the failure. A consumer shows
  // "the check did not run" rather than a red mark with no cause.
  if (sarif) {
    writeAllSync(1, toJSON(auditSarif({ path: binary, slices: [], containerAbnormalities: [], counts: { errors: 0, warnings: 0 } }, { path: binary }), 2) + '\n');
  }
  // `e.message` already names the path — `readerError` builds it that way — so the
  // binary is not prepended here. `a2o` prints it this way; `describe` prepends a
  // second copy and prints `/nope: /nope: cannot be read`. New code should not
  // reproduce that.
  console.error(e.message);
  process.exit(EXIT.fail);
}

// The exit status follows the *boolean*, not the three-valued verdict.
//
// This distinction is the whole reason `audit` carries both. `verdict` is a label
// for a person — `warnings` means "sound, with two things worth knowing" — and
// mapping it straight onto the exit code would fail a build over a binary that
// `clean: true` says is fine. The first version of this did exactly that, so the
// API reported `verdict: 'warnings', clean: true` while the process exited 1: the
// same file described as passing and failing, in the same breath.
//
// So the gate branches on `clean` / `strictClean`, which are defined to be the
// gate, and `verdict` is only ever printed.
const status = (strict ? result.strictClean : result.clean) ? EXIT.ok : EXIT.empty;

// SARIF first, and on its own. `--sarif` means "stdout is a SARIF document and
// nothing else", because the consumer is a file: `macho-explorer audit --sarif
// app > audit.sarif`. A human-readable summary printed into that file makes it
// invalid JSON, and Code Scanning's failure for that is a parse error naming
// nothing about the reader. The prose goes to stderr instead, so a person running
// it by hand still sees the verdict — and stderr cannot corrupt the artefact.
//
// The summary line is on stderr rather than omitted because the most common way to
// run this by hand is `audit --sarif <binary>` with no redirect, in which case
// stdout is a terminal and the run looks silent otherwise.
if (sarif) {
  writeAllSync(1, toJSON(auditSarif(result, { path: binary }), 2) + '\n');
  writeAllSync(
    2,
    `${binary} — ${result.verdict.toUpperCase()}  ${result.counts.errors} error(s), ` +
      `${result.counts.warnings} warning(s)  (SARIF on stdout)\n`,
  );
  process.exit(status);
}

if (flags.has('json')) {
  emitJSON({
    tool: 'audit',
    binary,
    ok: true,
    notes: [
      'verdict is ok / warnings / failed; findings carry severity error (the file disagrees with itself) or warning (unfamiliar or heuristic)',
      'an unreadable file exits 3, never 1 — a mistyped path must not read as a clean audit',
    ],
    data: result,
  }, status);
}

const worst = result.findings.some((a) => a.severity === 'error') ? 'FAILED' : 'WARN';
console.log(`${binary} — ${result.verdict.toUpperCase()}  ${result.counts.errors} error(s), ${result.counts.warnings} warning(s)`);

for (const s of result.slices) {
  if (s.abnormalities.length === 0) continue;
  console.log(`\n  ${s.arch}`);
  for (const a of s.abnormalities) {
    console.log(`    ${a.severity === 'error' ? 'error  ' : 'warning'} ${a.kind}`);
    console.log(`      ${a.detail}`);
  }
}

if (result.containerAbnormalities.length) {
  console.log(`\n  fat container`);
  for (const a of result.containerAbnormalities) {
    console.log(`    ${a.severity === 'error' ? 'error  ' : 'warning'} ${a.kind}`);
    console.log(`      ${a.detail}`);
  }
}

if (result.verdict === 'ok') {
  console.log('\n  no findings: every structural claim this file makes about itself checks out');
} else if (status === EXIT.ok) {
  // Reachable only in the default strictness: warnings that the gate deliberately
  // ignores. Saying so is the point — a build log that shows findings and a zero
  // exit with no explanation reads as a bug in one or the other.
  console.log(`\n  ${result.counts.warnings} warning(s) and no errors — passes by default; --strict would fail it`);
} else if (strict && result.counts.errors === 0) {
  console.log('\n  warnings only, and --strict counts them');
}

process.exit(status);