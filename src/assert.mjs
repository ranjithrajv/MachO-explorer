#!/usr/bin/env node
/**
 * assert.mjs — a CI policy: these facts must hold about this binary.
 *
 *   node src/assert.mjs <binary|bundle> \
 *       [--has-symbol=NAME] [--no-symbol=NAME] \
 *       [--has-string=TEXT] [--no-string=TEXT] ... [--arch=<name>] [--json]
 *
 *   node src/assert.mjs build/Contents/MacOS/app \
 *       --has-symbol=_main --no-symbol=_NSLog --has-string="https://"
 *
 * `audit` gates a file on its *internal* consistency; this gates it on facts the
 * caller supplies. A release build usually wants both: audit says the file is
 * well-formed, and an assertion says it still exports the entry point and still
 * does not carry the debug string someone forgot to compile out.
 *
 * ## Four predicates, two matching rules
 *
 *   --has-symbol  a symbol with exactly this name is present (defined or imported)
 *   --no-symbol   no symbol has this name
 *   --has-string  some NUL-terminated string contains this text
 *   --no-string   no NUL-terminated string contains this text
 *
 * `--has-symbol`/`--no-symbol` match the *whole* name: a CI policy names a
 * symbol, and a substring would pass on `_main_helper` when asked about `_main`.
 * `--has-string`/`--no-string` match a *substring*, because the useful claim is
 * that a URL or an error message is present and the string around it is not the
 * point.
 *
 * ## The exit status is the product
 *
 *   0  every assertion held
 *   1  at least one did not — a *negative answer*, not an error. A build gate
 *      needs to branch on "the policy failed", and a caller that reads that as a
 *      crash will switch the gate off within a week
 *   2  usage error
 *   3  the file could not be read
 *
 * A failed assertion is data, not an error: `errors` stays empty and `data.passed`
 * is the verdict, the same shape `audit` returns.
 */
import { requireBinary } from './target.mjs';
import { assertBinary } from './api.mjs';
import { parseArgs, emitJSON, usage, EXIT, rejectUnknownFlags, count } from './output.mjs';

const { flags, opts, positional, valued } = parseArgs(process.argv.slice(2));

const KINDS = ['has-symbol', 'no-symbol', 'has-string', 'no-string'];

const HELP = [
  'usage: node src/assert.mjs <binary|bundle> [assertions...] [--arch=<name>] [--json] [-b <binary>]',
  '',
  '  a CI policy: each assertion is checked against the binary and the exit',
  '  status is 0 only when every one holds.',
  '',
  'assertions (repeatable):',
  '  --has-symbol=NAME  a symbol of exactly this name must be present',
  '  --no-symbol=NAME   no symbol of this name may be present',
  '  --has-string=TEXT  some NUL-terminated string must contain TEXT',
  '  --no-string=TEXT   no NUL-terminated string may contain TEXT',
  '',
  'options:',
  '  --arch=<name>      check one architecture (x86_64, arm64, arm64e, arm64_32, ppc, ppc64, arm, i386)',
  '  -b, --binary <p>   the binary to read',
  '  --json             one JSON object on stdout; prose to stderr',
  '  -h, --help         this message',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set([...KINDS, 'json', 'arch']), flags, HELP);

const assertions = valued
  .filter(([name]) => KINDS.includes(name))
  .map(([kind, value]) => ({ kind, value }));

// A flag with no value, or an empty one, is rejected rather than run. `--has-string ""`
// is true of every binary — the empty string is a substring of everything — so
// accepting it would install a gate that can never fail, which is worse than no
// gate because it reports success.
const empty = assertions.filter((a) => a.value === '');
const missing = KINDS.filter((k) => flags.has(k) && !assertions.some((a) => a.kind === k));
if (missing.length || empty.length) {
  usage([
    ...HELP,
    '',
    ...missing.map((k) => `--${k} needs a value, e.g. --${k}=_main`),
    ...empty.map((a) => `--${a.kind} was given an empty value; an assertion that is true of everything is not an assertion`),
  ]);
}

if (assertions.length === 0) {
  usage([...HELP, '', 'no assertions given. Pass at least one --has-symbol, --no-symbol, --has-string or --no-string.']);
}

const binary = requireBinary({ argv: opts.b || opts.binary || positional[0] });
const arch = opts.arch;

let r;
try {
  r = assertBinary(binary, assertions, { arch });
} catch (e) {
  if (flags.has('json')) {
    emitJSON({ tool: 'assert', binary, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(e.message);
  process.exit(EXIT.fail);
}

const status = r.passed ? EXIT.ok : EXIT.empty;

if (flags.has('json')) {
  emitJSON({
    tool: 'assert',
    binary,
    ok: true,
    notes: [
      'a failed assertion is an answer, not an error: pass is in data.passed and in each assertion',
      '--has-symbol/--no-symbol match the whole name; --has-string/--no-string match a substring',
      ...(r.passed ? [] : [`${r.failed} of ${r.count} assertion(s) failed`]),
    ],
    data: r,
  }, status);
}

console.log(`${binary}${r.arch ? `  [${r.arch}]` : ''}`);
console.log(`\n  ${r.passed ? 'PASS' : 'FAIL'}  ${count(r.count - r.failed)} of ${count(r.count)} assertion(s) held`);
for (const a of r.assertions) {
  console.log(`    ${a.pass ? 'PASS' : 'FAIL'}  ${a.kind.padEnd(11)} ${JSON.stringify(a.value)}${a.detail ? `  — ${a.detail}` : ''}`);
}

process.exit(status);
