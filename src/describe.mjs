#!/usr/bin/env node
/**
 * describe.mjs — what is in this binary?
 *
 *   macho-explorer describe [binary|bundle] [--json]
 *
 * Every slice, with its architecture, file extent, whether it is thin or part of
 * a fat file, symbol counts, where its `__TEXT` starts, and how many sections
 * are flagged as instructions.
 *
 * ## Why this tool exists
 *
 * It is the first thing to run on a binary you know nothing about, and it is the
 * answer to the question every one of the other five tools defers: which slice
 * will they actually read, and is there a symbol table to read?
 *
 * Before this existed, that information was scattered. `symgrep` printed its
 * choice in a trailing summary line, `findcall` printed one line per slice it
 * scanned, `mapliteral` printed its own, and `symfind` printed nothing at all.
 * Four tools, four formats, none of them machine-readable — so a script that
 * wanted to know what it had in front of it had to parse English from whichever
 * tool happened to mention it, or open the file itself and parse the fat header,
 * which is the very thing `macho.mjs` exists so nobody has to do twice.
 *
 * It is also the cheapest way to see the `__TEXT`-is-not-all-code point: the
 * `code sections` column is usually much smaller than the file, and the gap is
 * the data that an untyped scan used to report as call sites.
 */
import { requireBinary, FALLBACK_TARGET } from './target.mjs';
import { isCodeSection, archMatches } from './macho.mjs';
import { describe } from './api.mjs';
import { parseArgs, emitJSON, usage, count, EXIT, rejectUnknownFlags, isQuiet, isVerbose, colorEnabled, colorize, quietLog, verboseLog } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: macho-explorer describe [binary|bundle] [--json] [--arch=<name>]',
  '                             [--sections] [--segments] [--loads] [-b <binary>]',
  '',
  '  what is in this binary: every slice, its architecture, extent, symbol',
  '  counts and where __TEXT starts. Defaults to $MACHO_EXPLORER_BINARY, then $MACHO_EXPLORER_APP,',
  `  then ${FALLBACK_TARGET}`,
  '',
  'options:',
  '  --sections        list every section: segment, name, address, size, type',
  '  --segments        list every segment: name, vm range, file range',
  '  --loads           list every load command by name and size',
  '  --arch=<name>     read one slice of a universal binary (x86_64, arm64, arm64e, arm64_32, ppc, ppc64, arm, i386)',
  '  --json            one JSON object on stdout; prose to stderr',
  '  -b, --binary <p>  the binary to read',
  '  -q, --quiet       suppress non-essential output',
  '  --color           force color output',
  '  --no-color        disable color output',
  '  -v, --verbose     diagnostic output',
  '  -h, --help        this message',
];

// Handled before the unknown-flag check below, or `--help` would be reported as
// an unrecognised option — the one flag every tool must accept, rejected by the
// tool whose whole job is being the first thing you run.
if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set(['sections', 'segments', 'loads', 'arch', 'json']), flags, HELP);

const binary = requireBinary({ argv: opts.b || opts.binary || positional[0] });

// `-v/--verbose` and `-q/--quiet` are advertised as global flags and accepted by
// every tool through COMMON_FLAGS, but nothing acted on them here — the flags
// were parsed and ignored. That is the same defect `--version` had: a documented
// flag that changes nothing is a claim the tool does not keep. Diagnostics go to
// stderr so they cannot contaminate a `--json` stream.
const started = Date.now();
verboseLog(flags, `describe: reading ${binary}`);

let r;
try {
  r = describe(binary);
} catch (e) {
  if (flags.has('json')) {
    emitJSON({ tool: 'describe', binary, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(`${binary}: ${e.message}`);
  process.exit(EXIT.fail);
}

const notes = [];
if (r.slices.some((s) => s.note)) {
  notes.push('a slice with a note carries no symbol table — nothing can grep it');
}
const stripped = r.slices.filter((s) => s.readable && s.defined === 0);
if (stripped.length && r.slices.length > 1) {
  notes.push(`${stripped.map((s) => s.arch).join(', ')}: stripped, or a dyld-cache stub — findcall and findliteral still work, since they read bytes rather than names`);
}

// `--arch` narrows a universal binary to one slice. Applied here rather than
// inside `describe` so the fat header is still walked and the other slices are
// still *counted* — reporting "this is a universal binary, here is the arm64
// half" is a different and more useful answer than pretending it is thin.
const wantArch = opts.arch;
if (wantArch && r.slices.length > 1) {
  const all = r.slices.map((s) => s.arch).join(', ');
  // `archMatches`, not `===`. Naming arm64e as its own architecture made this
  // `===` a live bug: `--arch=arm64` against a binary whose arm64 slice is
  // arm64e reported "matched none of the slices" and then showed all of them,
  // which is worse than the old silent-wrong-slice answer because it looks like
  // it checked. `archMatches` is the same rule every other `--arch` path uses.
  const match = r.slices.find((s) => archMatches(s.arch, wantArch));
  if (!match) {
    notes.push(`--arch=${wantArch} matched none of the slices (${all}); showing all ${r.slices.length}`);
  } else {
    r = { ...r, slices: [match] };
    notes.push(`--arch=${wantArch}: showing 1 of ${all.length ? all.split(', ').length : r.slices.length} slices — drop the flag for all`);
  }
}

verboseLog(flags, `parsed ${r.slices.length} slice(s) in ${Date.now() - started}ms`);

if (flags.has('json')) {
  emitJSON({ tool: 'describe', binary, ok: true, notes, data: r });
}

console.log(`${binary} — ${(r.size / 1048576).toFixed(1)} MB, ${r.fat ? 'universal' : 'thin'}, ${r.slices.length} slice(s)\n`);
for (const s of r.slices) {
  const text = s.textAddr !== null ? ` __text 0x${s.textAddr.toString(16)}+${count(s.textSize)}` : '';
  // The platform and filetype go on the summary line because they are what the
  // file *is*: an iOS app and a macOS tool otherwise print identical lines, and
  // "which am I holding" is the first question a Mach-O raises. Each is printed
  // exactly once: `filetypeName` is the flat mirror of `filetype.name`, and
  // `platformName` of `buildVersion.platform`, so naming both spellings put the
  // same two words on this line twice — `MH_EXECUTE  macos  macos MH_EXECUTE`.
  //
  // An unnamed value shows as its number rather than being dropped, because
  // "this is not a filetype I know" and "this file does not say" differ.
  console.log(
    `  ${s.arch.padEnd(8)} file ${s.offset}..${s.offset + s.size}` +
      `  ${s.bits || '?'}-bit` +
      `  ${s.filetypeName ?? (s.filetype ? `filetype ${s.filetype.raw}` : 'filetype ?')}` +
      `  ${s.platformName ?? 'platform ?'}` +
      `  ${count(s.defined)} defined / ${count(s.nsyms)} symbols` +
      `  ${s.codeSections} code section(s)${text}`,
  );
  // Stated as a warning rather than as another field, because it changes what
  // every other line means: on an encrypted slice the addresses are real and the
  // bytes behind them are ciphertext.
  if (s.encrypted) {
    console.log(
      `           ENCRYPTED (cryptid=${s.cryptid}) — __TEXT is ciphertext, an App Store build;` +
        ` findcall, findliteral and --strings cannot read it`,
    );
  }
  // `minos`/`sdk` are printed once, below with the rest of `LC_BUILD_VERSION` —
  // `s.minos` is the flat mirror of `buildVersion.minos.text`, so emitting both
  // here and there put the same line on screen twice.
  // The UUID identifies a *build*, which is the one thing a describe tool is
  // uniquely placed to answer: two binaries with identical sizes and symbol
  // counts can still be different builds, and this is what tells them apart.
  // Printed on its own line because it is long and it is per-slice, and inline
  // it would push the `__text` address out of view on a narrow terminal.
  if (s.uuid) console.log(`           uuid ${s.uuid}`);

  // The header `flags`, named. `MH_PIE` and `MH_TWOLEVEL` are the two a reader
  // actually acts on — they decide whether the binary is position-independent and
  // whether its imports are two-level namespaced — and neither is visible as a
  // number. A bit the table cannot name is printed on its own line rather than
  // folded into the list, because "unrecognised" and "not set" are different
  // claims and only one of them is true.
  if (s.flagsNamed.length) {
    console.log(`           flags ${s.flagsNamed.join(' ')}`);
  }
  if (s.flagsUnknown) {
    console.log(`           flags 0x${s.flagsUnknown.toString(16)} set but unnamed in <mach-o/loader.h> — newer than this reader, or not a header we can trust`);
  }

  // `LC_MAIN`. The raw offset is printed and no address is, deliberately: the
  // header calls `entryoff` a `__TEXT` offset, and on the binaries measured that
  // is not what it is — it lands past `__TEXT`, in `__LINKEDIT`. See
  // `resolveEntryPoint` for the measurements. Printing `__TEXT.vmaddr + entryoff`
  // would produce a plausible address that is wrong, which is worse than none.
  if (s.entryPoint) {
    const stack = s.entryPoint.stacksize === null
      ? ''
      : ` stack ${s.entryPoint.stacksize}`;
    console.log(`           entry entryoff ${s.entryPoint.entryoff}${stack}  (no address derived; see --json entryPoint.note)`);
  }

  // `LC_RPATH`. `@rpath` resolution walks these in order, so the order is the
  // meaning and the list is printed in the order the binary declares it.
  for (const rp of s.rpaths) console.log(`           rpath ${rp}`);

  // The `dylib_command` family, in the order the linker recorded it. `linkage`
  // is printed rather than dropped because it changes what an absent library
  // means, and a list that showed five identical-looking paths would lose the one
  // fact that distinguishes them. Marked on the weak/reexport/lazy/upward cases
  // only, so the common case reads like `otool -L` and stays scannable.
  if (s.installName) console.log(`           install name ${s.installName.name}`);
  for (const d of s.dylibs) {
    const tag = d.linkage === 'load' ? '' : `  (${d.linkage})`;
    console.log(`           dylib ${d.name}${tag}`);
  }

  if (s.sourceVersion) {
    console.log(`           source version ${s.sourceVersion.text}`);
  }

  // The platform the binary was built for, and the OS and SDK it declares. Before
  // this was decoded the command was named in `--loads` and nothing said what it
  // said, so `describe` could tell you the binary carried an `LC_BUILD_VERSION` and
  // not what the binary was — which is the whole question the command exists to
  // answer.
  if (s.buildVersion) {
    const bv = s.buildVersion;
    console.log(`           minos ${bv.minos.text}  sdk ${bv.sdk.text}`);
    // A build version with tool records carries 8 more bytes per tool past the 24
    // this reader reads. Saying so beats reporting a value that silently omits them.
    if (bv.ntools) console.log(`           (${bv.ntools} tool record(s) not read)`);
  }

  // FairPlay. This is the line that changes what every other answer on this screen
  // means: an App Store binary's `__TEXT` is ciphertext, so a zero from `findcall`,
  // `findliteral` or `--strings` is "not readable", not "not there".
  if (s.encryption) {
    const e = s.encryption;
    console.log(
      e.encrypted
        ? `           ENCRYPTED (cryptid=${e.cryptid}) — __TEXT is ciphertext; findcall, findliteral and --strings cannot read it`
        : `           not encrypted (cryptid=${e.cryptid})`,
    );
  }

  if (s.note) console.log(`           note: ${s.note}`);
}

// Abnormalities, after every slice rather than under one.
//
// Reported alongside the parse and never instead of it: a damaged file still
// answers every other question, and conflating "this file is broken" with "this
// file does not have that" is the mistake `a2o` was fixed for. A healthy binary
// reports none, so the section is silent in the common case rather than printing
// "0 abnormalities" on every run.
const abnormal = r.slices.flatMap((s) => s.abnormalities.map((a) => ({ arch: s.arch, ...a })));
const container = (r.containerAbnormalities || []).map((a) => ({ arch: 'fat container', ...a }));
const allAbnormal = [...abnormal, ...container];
if (allAbnormal.length) {
  console.log('');
  console.log(`${allAbnormal.length} abnormality(ies) — the file parsed, but these parts do not add up:`);
  for (const a of allAbnormal) {
    console.log(`  ${a.arch}  ${a.kind}\n      ${a.detail}`);
  }
}

const hex = (v) => `0x${v.toString(16)}`;

// The three listings. Each prints only what was asked for, because the default
// view above is the "what is this file" answer and a wall of section names
// buries it — but the data was always parsed, so asking costs nothing now.
if (flags.has('segments')) {
  console.log('');
  for (const s of r.slices) {
    if (!s.readable || !s.segments.length) continue;
    console.log(`segments in ${s.arch}:`);
    for (const g of s.segments) {
      console.log(
        `  ${g.segname.padEnd(16)} vm ${hex(g.vmaddr)}..${hex(g.vmaddr + g.vmsize)}` +
          `  file ${g.fileoff}..${g.fileoff + g.filesize}`,
      );
    }
  }
}

if (flags.has('sections')) {
  console.log('');
  for (const s of r.slices) {
    if (!s.readable || !s.sections.length) continue;
    console.log(`sections in ${s.arch}:`);
    for (const sec of s.sections) {
      // The instruction flag is called out because it is the one attribute that
      // changes what a byte scan means — the same signal `findcall` types its
      // scan by, shown here so the two can be checked against each other.
      // `isCodeSection` is imported rather than re-tested inline, because a
      // second copy of that predicate is a second thing to keep correct, and
      // this project has already shipped a bug from exactly that.
      const kind = isCodeSection(sec) ? 'code' : 'data';
      // The section *type* beside it, because `code`/`data` and the type answer
      // different questions and a section can be both at once: `__text` is `code`
      // because of `S_ATTR_PURE_INSTRUCTIONS`, and `S_REGULAR` because that is
      // what its type byte says. Reading only the attributes calls a `__cstring`
      // and a `__symbol_stub` both "data", which is true and useless.
      const type = sec.type || `0x${(sec.flags & 0xff).toString(16)}`;
      // An attribute or type bit with no name in the header is appended rather
      // than hidden, for the same reason the header-flag line above is.
      const odd = sec.attributesUnknown
        ? `  +0x${sec.attributesUnknown.toString(16)}?`
        : '';
      console.log(
        `  ${(sec.segname + ',' + sec.sectname).padEnd(34)} ${hex(sec.addr)}..${hex(sec.addr + BigInt(sec.size))}` +
          `  ${count(sec.size).padStart(12)}  file ${String(sec.offset).padStart(9)}  ${kind}  ${type}${odd}`,
      );
    }
  }
}

if (flags.has('loads')) {
  console.log('');
  for (const s of r.slices) {
    if (!s.readable || !s.loadCommands.length) continue;
    console.log(`load commands in ${s.arch}: ${s.loadCommands.length}`);
    for (const c of s.loadCommands) {
      console.log(`  ${c.name.padEnd(26)} ${String(c.cmdsize).padStart(7)} bytes  at ${hex(BigInt(c.offset))}`);
    }
  }
}

// The trailing notes are commentary about the parse, not the parse — suppress
// them under `--quiet`, which is what that flag is documented to do.
quietLog(flags, '');
for (const n of notes) quietLog(flags, `  note: ${n}`);
