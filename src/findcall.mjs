#!/usr/bin/env node
/**
 * findcall.mjs — locate direct call/jmp sites targeting a given vaddr.
 *
 *   macho-explorer findcall <hex-vaddr> [binary|bundle] [--json] [--arch=<name>]
 *   macho-explorer findcall --list [binary|bundle] [max] [--include-data]
 *
 * `objdump` in Command Line Tools silently ignores `--start-address` on a fat
 * binary, so this scans code sections directly for the rel32 of a direct `call`
 * (0xe8) or `jmp` (0xe9) that resolves to the target, and for arm64 `BL`.
 *
 * ## The scan is typed, and that changes what the output means
 *
 * Only sections whose attributes mark them as instructions are scanned:
 * `__text`, `__stubs`, and whatever else the linker flagged
 * `S_ATTR_PURE_INSTRUCTIONS`. This is a behaviour change from the previous
 * version, which swept the whole of `__text`.
 *
 * `__text` is not entirely code. It also carries `__cstring`, `__const`,
 * `__literal4`, jump tables and alignment padding, and a byte pattern in any of
 * them can decode as a `call rel32` pointing at the address you asked about. The
 * old scan reported each of those as a call site, so its output read as a caller
 * list and was partly fiction — indistinguishable from a real caller list, which
 * is what made it dangerous. `--include-data` restores the old sweep for when
 * the data sections are exactly what you are hunting.
 *
 * `__stubs` is kept in the typed scan deliberately: PLT stubs are code and do
 * contain direct `jmp rel32` and `call rel32` instructions, so they are
 * legitimate results and dropping them would hide real edges.
 *
 * ## Three bugs this had, all invisible until it ran on a second binary
 *
 * **It never parsed the fat header.** It read `ncmds` at file offset 32, which
 * is correct only for a *thin* Mach-O. On a universal binary — which is what
 * every real macOS game ships — offset 32 lands inside the fat header, the
 * section walk finds nothing, and the code falls back to a hardcoded 512 MB
 * window at the base of the file. On a 476 MB universal binary that window
 * covers no real code, so it reported "0 direct call/jmp sites" and looked like
 * a legitimate negative result. It had never actually worked on the binary it
 * was written for.
 *
 * **The chunk loop could not terminate.** It advanced with `pos += len - 5`,
 * which is the right idea for overlapping a call that straddles a chunk
 * boundary, but on the final partial chunk `len` drops below 5 and `pos` stops
 * advancing. On a section whose size leaves a remainder of 1..4 bytes the tool
 * hangs forever. Neither is hypothetical: a Go toolchain binary is a thin
 * Mach-O with a `__text` of 5,880,564 bytes, 5 short of the 16 MB chunk
 * boundary, and it hung on the first run.
 *
 * **The arm64 path was dead.** It knew only the x86 `rel32` encoding, and its
 * arm64 mask compared a *signed* int32 against a constant above 2^31, so the
 * comparison never matched and it reported "0 call sites" on any arm64 binary —
 * for `runtime.gopanic`, which is called constantly.
 *
 * ## What still will not be found
 *
 * Only *direct* calls. Indirect ones (`call [rip+disp]`, a register call, a jump
 * through a thunk) do not encode their target in the instruction, so a call into
 * a shared library or through a PLT stub does not appear here. Every hit is a
 * site *worth disassembling*, not a proven call-graph edge.
 */
import { requireBinary } from './target.mjs';
import { findCalls, findCallsIn, listCallTargets } from './api.mjs';
import { parseArgs, emitJSON, usage, EXIT, rejectUnknownFlags, isQuiet, isVerbose, colorEnabled, colorize, quietLog, verboseLog } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: macho-explorer findcall <hex-vaddr> [binary|bundle] [--json] [--arch=<name>] [-b <binary>] [--include-data]',
  '       macho-explorer findcall --in <dir> <text-offset> [--json] [--arch=<name>] [--per-file=<n>]',
  '       macho-explorer findcall --list [binary|bundle] [max] [--json] [--include-data]',
  '',
  '  direct call/jmp sites targeting an address, or with --list the distinct',
  '  targets a binary calls, most-called first.',
  '',
  'options:',
  '  --in=<dir>         search every Mach-O under a directory. The query becomes an',
  '                     OFFSET INTO __TEXT, not a vaddr: every file maps __TEXT at',
  '                     its own base, so one address means different functions in',
  '                     different files. Each file is asked at its own base + offset,',
  '                     and the answer reports which base it used.',
  '  --per-file=<n>     call sites listed per file (default 50; 0 for counts only)',
  '  --max-files=<n>    stop after n files; the answer is marked truncated',
  '  --list             list distinct call targets instead of querying one',
  '  --include-data     widen the scan from code sections to every section,',
  '                     accepting false positives from data that decodes as a call',
  '  --arch=<name>      read one architecture (x86_64, arm64, arm64e, arm64_32, ppc, ppc64, arm, i386)',
  '  -b, --binary <p>   the binary to read',
  '  -q, --quiet        suppress non-essential output',
  '  --color            force color output',
  '  --no-color         disable color output',
  '  -v, --verbose      diagnostic output',
  '  --json             one JSON object on stdout; prose to stderr',
  '  -h, --help         this message',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set(['list', 'include-data', 'arch', 'json', 'in', 'per-file', 'max-files']), flags, HELP);

const listMode = flags.has('list');
const json = flags.has('json');
const includeData = flags.has('include-data');
const arch = opts.arch;
const corpusRoot = opts.in;
const corpusMode = typeof corpusRoot === 'string' && corpusRoot !== '';
const perFile = opts['per-file'] === undefined ? 50 : Number(opts['per-file']);
const maxFiles = opts['max-files'] === undefined ? 20000 : Number(opts['max-files']);
if (!Number.isFinite(perFile) || perFile < 0) usage(['--per-file takes a non-negative integer', ...HELP.slice(0, 2)]);
if (!Number.isFinite(maxFiles) || maxFiles <= 0) usage(['--max-files takes a positive integer', ...HELP.slice(0, 2)]);

let target = null;
let maxList = 40;
if (listMode) {
  // --list [binary] [max]
  maxList = Number(positional[1] || 40);
  if (!Number.isFinite(maxList) || maxList <= 0) {
    usage(['--list takes a positive count as its second argument', ...HELP.slice(0, 2)]);
  }
} else {
  if (!positional[0] || !/^0x/i.test(positional[0])) usage(HELP.slice(0, 2));
  target = BigInt(positional[0]);
}

// Corpus mode is answered before `requireBinary`, because `--in` names a directory
// and there is deliberately no single binary to resolve. Asking for one here would
// fall through to the system fallback and scan a file the caller never named — the
// exact mistake `binaryAt()` exists to prevent.
if (corpusMode) {
  if (listMode) usage(['--list reads one binary; --in searches many. Use one or the other.', ...HELP.slice(0, 2)]);
  const r = findCallsIn([corpusRoot], target, { arch, includeData, perFile, maxFiles });
  const notes = [];
  if (r.totals.skipped) notes.push(`${r.totals.skipped} file(s) in the tree were not Mach-O and were skipped`);
  if (r.truncated) notes.push(`stopped after ${maxFiles} file(s) or the depth limit — the answer covers only what was reached`);

  if (json) {
    emitJSON({
      tool: 'findcall',
      binary: corpusRoot,
      ok: r.totals.sites > 0,
      errors: r.totals.sites > 0 ? [] : ['no-call-sites'],
      notes,
      data: r,
    }, r.totals.sites > 0 ? EXIT.ok : EXIT.empty);
  }

  quietLog(flags, `\nfindcall --in ${corpusRoot}  —  __TEXT offset 0x${target.toString(16)}`);
  verboseLog(flags, `queryMode=text-relative (an offset into __TEXT, not a vaddr)`);
  if (r.truncated) quietLog(flags, `\n  stopped early: the answer covers only what was reached`);
  console.log();
  for (const f of r.files) {
    if (!f.ok) { console.log(`  ${f.path}  —  ${f.error}: ${f.message}`); continue; }
    if (f.count === 0) continue;
    const bases = f.bases.map((b) => `${b.arch} @ ${b.target}`).join(', ');
    console.log(`  ${f.path}  —  ${f.count} site(s)   ${bases}`);
    for (const s of f.sites) {
      console.log(`      0x${s.addr.toString(16).padStart(12, '0')}  ${s.kind} [${s.arch}] ${s.section}`);
    }
    if (f.sitesTruncated) console.log(`      ...and ${f.count - f.sites.length} more (raise --per-file)`);
  }
  console.log(
    `\n${r.totals.sites} call site(s) across ${r.totals.matchedFiles} of ${r.totals.looked} Mach-O ` +
    `(${r.totals.skipped} non-Mach-O skipped, ${r.totals.unreadable} unreadable)`,
  );
  console.log('the query was an offset into __TEXT; each file was asked at its own __TEXT base');
  process.exit(r.totals.sites > 0 ? EXIT.ok : EXIT.empty);
}

const binary = requireBinary({ argv: opts.b || opts.binary || positional[listMode ? 0 : 1] });
verboseLog(flags, `findcall: reading ${binary}`);
const notes = [];

try {
  if (listMode) {
    const r = listCallTargets(binary, { arch, includeData });
    const shown = r.targets.slice(0, maxList);

    if (r.unsupported.length) {
      // An architecture whose encoding is unknown is an error, not an empty
      // result. Reporting "none" here would be a wrong answer.
      emitJSON({
        tool: 'findcall', binary, ok: false,
        errors: ['unknown-encoding'],
        messages: [`no direct-call encoding known for ${r.unsupported.join(', ')}`],
      }, EXIT.fail);
      console.error(
        `\nerror: no direct-call encoding known for ${r.unsupported.join(', ')}. ` +
          'Reporting "none" here would be a wrong answer, not an empty result.',
      );
      process.exit(EXIT.fail);
    }
    for (const s of r.slices) if (s.untypedFallback) notes.push(`${s.arch}: no section is flagged as instructions, so the scan is untyped`);
    if (r.total === 0) {
      notes.push('no direct call/jmp decoded anywhere — either the matcher is not recognising this architecture, or these sections hold no direct calls');
    }

    if (json) {
      emitJSON({
        tool: 'findcall', binary, ok: r.total > 0,
        errors: r.total ? [] : ['no-call-sites'],
        notes,
        data: { ...r, shown: shown.length, targets: shown, mode: 'list' },
      }, r.total ? EXIT.ok : EXIT.empty);
    }

    // Per-slice narration goes to stderr so stdout stays parseable in --json
    // mode, and is printed here so a reader can tell a working matcher from a
    // dead one: an empty target list from a scanner that matched nothing looks
    // exactly like a scanner that never ran.
    for (const s of r.slices) {
      process.stderr.write(
        `  ${s.arch}: [${s.encoding}] ${(s.scanned / 1048576).toFixed(1)} MB scanned` +
          `${s.untypedFallback ? ' (untyped: no section flagged as instructions)' : ''}\n`,
      );
    }
    console.log(
      `\n${r.total} distinct direct call/jmp target(s), most-called first` +
        `  (${(r.scanned / 1048576).toFixed(0)} MB of code scanned${includeData ? ', data sections included' : ''})`,
    );
    for (const t of shown) {
      console.log(`  0x${t.dest.toString(16).padStart(12, '0')}  ${t.sites} site(s)`);
    }
    if (r.total > shown.length) console.log(`  ... and ${r.total - shown.length} more`);
    if (r.total === 0) {
      console.log('  none. Either this binary makes no direct calls, or the matcher is not');
      console.log("  recognising this architecture's encoding — the lines above state which.");
    }
    for (const n of notes) console.log(`  note: ${n}`);
    process.exit(r.total ? EXIT.ok : EXIT.empty);
  }

  const r = findCalls(binary, target, { arch, includeData });
  if (r.unsupported.length) {
    if (json) {
      emitJSON({ tool: 'findcall', binary, ok: false, errors: ['unknown-encoding'],
        messages: [`no direct-call encoding known for ${r.unsupported.join(', ')}`] }, EXIT.fail);
    }
    console.error(
      `\nerror: no direct-call encoding known for ${r.unsupported.join(', ')}. ` +
        'Reporting "none" here would be a wrong answer, not an empty result.',
    );
    process.exit(EXIT.fail);
  }
  for (const s of r.slices) {
    if (s.untypedFallback) notes.push(`${s.arch}: no section is flagged as instructions, so the scan is untyped`);
    if (s.skipped) notes.push(`${s.arch}: ${s.skipped}`);
  }
  if (r.hits.length === 0) {
    notes.push('direct calls only — an indirect call or a PLT stub will not appear here');
  }

  // "Found nothing" and "could not look" must not share a reason code. On an
  // encrypted binary the scan genuinely did not run, so `no-call-sites` would
  // report the absence of an answer as the answer — the conflation this
  // package's exit codes exist to prevent, and the one a caller is least able
  // to detect on its own.
  const reason = r.hits.length > 0 ? null : (r.unreadable ? 'encrypted' : 'no-call-sites');
  const exit = r.hits.length > 0 ? EXIT.ok : (r.unreadable ? EXIT.fail : EXIT.empty);

  if (json) {
    emitJSON({
      tool: 'findcall', binary, ok: r.hits.length > 0,
      errors: reason ? [reason] : [],
      notes,
      data: { ...r, mode: 'callers' },
    }, exit);
  }

  for (const s of r.slices) {
    const sections = s.sections.map((x) => x.name).join(' ');
    console.log(
      `  ${s.arch}: [${s.encoding}]` +
        (sections ? ` ${sections}` : s.skipped || ' no code sections covering the target') +
        ` (${(s.scanned / 1048576).toFixed(1)} MB scanned)`,
    );
  }
  console.log(
    `\n${r.count} direct call/jmp candidate(s) -> 0x${r.target.toString(16)}` +
      `  (${(r.scanned / 1048576).toFixed(0)} MB scanned, ${includeData ? 'untyped: data sections included' : 'typed: instruction sections only'})`,
  );
  for (const h of r.hits) {
    console.log(`  0x${h.addr.toString(16).padStart(12, '0')}  ${h.kind.padEnd(4)} [${h.arch}] ${h.section}`);
  }
  if (r.hits.length === 0) {
    console.log('  none. Direct calls only — an indirect call or a PLT stub will not show here.');
    console.log('  To confirm the scanner works at all on this binary, run it with --list.');
  }
  for (const n of notes) console.log(`  note: ${n}`);
  process.exit(r.hits.length ? EXIT.ok : EXIT.empty);
} catch (e) {
  if (json) emitJSON({ tool: 'findcall', binary, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  console.error(`${binary}: ${e.message}`);
  process.exit(EXIT.fail);
}
