/**
 * symbolicate.mjs — resolve the addresses in a crash report to functions.
 *
 * ## The question this answers
 *
 * A crash report is a stack of addresses. Turning it into a stack of *names* is the
 * first thing anyone does with one, and on a machine with no Xcode the usual answer
 * is that you cannot — `atos` needs the binaries, and since macOS 11 the system
 * libraries are not on disk at all.
 *
 * This reads the report, resolves what it can from binaries that *are* present, and
 * says precisely why each frame it could not resolve was not resolved. That last
 * part is the point: "this frame is inside a function I cannot name" and "there is no
 * file on this machine to name it from" send you to different places, and a report
 * that shows a bare `0x…` for both makes you go looking at the wrong one.
 *
 * ## What it will not do
 *
 * It does not read the dyld shared cache, so frames in modern Apple frameworks stay
 * unresolved with that reason spelled out. It does not invent a symbol from a nearby
 * one, and it does not present a symbol the report already carried as if this package
 * had computed it — `--json` labels each with `symbolSource`.
 */
import { symbolicate } from './api.mjs';
import { parseArgs, emitJSON, usage, EXIT, rejectUnknownFlags, isQuiet, quietLog, colorEnabled, colorize } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: macho-explorer symbolicate <report.ips|report.crash> [--json] [--arch=<name>] [--no-resolve]',
  '',
  '  resolve the addresses in an Apple crash report to functions, using the',
  '  binaries on this machine. Handles both the modern `.ips` JSON format and the',
  '  legacy text `.crash` format, and says which it read.',
  '',
  'options:',
  '  --arch=<name>      prefer one architecture when an image is universal',
  '  --no-resolve       parse the report and skip reading binaries; every address is',
  '                     reported with the image it lands in but no symbol',
  '  --json             one JSON object on stdout; prose to stderr',
  '  -q, --quiet        suppress non-essential output',
  '  --color            force color output',
  '  --no-color         disable color output',
  '  -h, --help         this message',
  '',
  'exit codes:',
  '  0  ran, at least one frame resolved',
  '  1  ran, resolved nothing',
  '  2  usage error',
  '  3  could not read the report',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set(['arch', 'no-resolve', 'json', 'quiet', 'color', 'verbose', 'help', 'h']), flags, HELP);

if (positional.length === 0) usage(HELP.slice(0, 2));
if (positional.length > 1) usage(['symbolicate reads one report at a time', ...HELP.slice(0, 2)]);

const report = positional[0];
const json = flags.has('json');
const arch = opts.arch ?? null;
const resolve = !flags.has('no-resolve');

let r;
try {
  r = symbolicate(report, { arch, resolve });
} catch (e) {
  if (json) {
    emitJSON({ tool: 'symbolicate', binary: report, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(e.message);
  process.exit(EXIT.fail);
}

const notes = [];
if (r.format === 'legacy') {
  notes.push('legacy text format — frame addresses are absolute and were used as given');
} else {
  notes.push('.ips format — frame offsets were added to each image base');
}
if (r.totals.unresolved) {
  notes.push(`${r.totals.unresolved} frame(s) could not be resolved; each names why in its reason field`);
}
if (r.unrecognised && r.unrecognised.length) {
  notes.push(`${r.unrecognised.length} line(s) in the report matched no known pattern and were not read`);
}

const resolved = r.totals.fromBinary + r.totals.fromReport;
if (json) {
  emitJSON({
    tool: 'symbolicate',
    binary: report,
    ok: resolved > 0,
    errors: resolved > 0 ? [] : ['no-symbols'],
    notes,
    data: r,
  }, resolved > 0 ? EXIT.ok : EXIT.empty);
}

/* ---- text ------------------------------------------------------------ */

const dim = (s) => (colorEnabled(flags) ? colorize(s, 'dim') : s);

quietLog(flags, `\n${report}  —  ${r.format}${r.app ? `, ${r.app}` : ''}${r.os ? `, ${r.os}` : ''}`);
if (r.bugType) quietLog(flags, `  ${dim('bug type')} ${r.bugType}${r.incidentId ? `  ${dim('incident')} ${r.incidentId}` : ''}`);
if (r.exception) quietLog(flags, `  ${dim('exception')} ${r.exception.type ?? ''}${r.exception.signal ? ` (${r.exception.signal})` : ''}`);
console.log();

for (const t of r.threads) {
  const head = `Thread ${t.id ?? t.index}${t.triggered ? '  (crashed)' : ''}${t.name ? `  "${t.name}"` : ''}`;
  quietLog(flags, `  ${head}`);
  for (const f of t.frames) {
    const where = f.symbol ?? dim('(unresolved)');
    // The source is shown, not implied. `_foo [report]` and `_foo [binary]` are
    // different claims: one is what Apple's reporter recorded, the other is what
    // this package read out of a file that may since have been rebuilt.
    const src = f.symbol ? ` [${f.symbolSource}]` : '';
    const off = f.offset && f.offset !== '0x0' ? ` + ${f.offset}` : '';
    console.log(`    ${String(f.index).padStart(2)}  ${where}${src}${off}`);
    if (f.reason) console.log(`        ${dim(`why not: ${f.reason}`)}`);
  }
  console.log();
}

const summary = `${r.totals.frames} frame(s): ${r.totals.fromBinary} from a binary, ` +
  `${r.totals.fromReport} from the report, ${r.totals.unresolved} unresolved`;
quietLog(flags, summary);
if (r.format === 'ips') {
  quietLog(flags, dim('  .ips offsets are added to the image base the report records'));
}
if (r.unrecognised && r.unrecognised.length) {
  console.log(`\n  ${r.unrecognised.length} line(s) matched no known pattern — the report may be a newer format:`);
  for (const u of r.unrecognised.slice(0, 5)) console.log(`    ${u.why}: ${u.line.trim().slice(0, 70)}`);
}

process.exit(resolved > 0 ? EXIT.ok : EXIT.empty);
