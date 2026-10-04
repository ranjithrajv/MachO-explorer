#!/usr/bin/env node
/**
 * findliteral.mjs — find every occurrence of a byte literal in a binary.
 *
 *   macho-explorer findliteral <literal> [binary|bundle] [--text] [--json]
 *
 * Reports each hit's file offset, which architecture slice it falls in, its
 * vaddr where the slice maps one, and the surrounding bytes as printable
 * context. That combination is usually enough to tell a string literal from a
 * pointer table from bytes that happen to sit inside an instruction, without
 * opening a disassembler.
 *
 * The literal is an argument rather than a constant. A hardcoded one makes the
 * tool a one-off script with a misleading name: the searching is the reusable
 * part, not the thing being searched for.
 *
 * ## The whole file, not just __TEXT
 *
 * Most literals live in `__TEXT`, but a format magic can equally be compared
 * against a constant in `__DATA`, embedded in code, or present in only one
 * slice of a universal binary. So this scans the entire file by default and
 * attributes every hit to a slice. Pass `--text` to restrict the search to
 * `__TEXT` when you know it is there and want the scan to be cheap.
 *
 * ## Why the fat header is parsed
 *
 * A hit's file offset is meaningless without knowing which slice it came from —
 * two slices have different virtual address bases, so the same file offset in
 * each is a different address. An earlier version reimplemented the fat-header
 * walk and got it subtly wrong for thin binaries, reporting every hit as
 * belonging to an unnamed slice.
 */
import { requireBinary } from './target.mjs';
import { findLiteral, findStrings } from './api.mjs';
import { parseArgs, emitJSON, usage, EXIT, count, rejectUnknownFlags, isQuiet, isVerbose, colorEnabled, colorize, quietLog, verboseLog } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: macho-explorer findliteral <literal> [binary|bundle] [--text] [--json]',
  '                              [--arch=<name>] [-b <binary>]',
  '       macho-explorer findliteral --strings [binary|bundle] [--json]',
  '                              [--arch=<name>] [--min=<n>] [--filter=<s>] [-b <binary>]',
  '',
  '  <literal> is matched as raw latin1 bytes, so escapes work:',
  '    macho-explorer findliteral LZ4 /Applications/Some.app',
  '    macho-explorer findliteral \\x1f\\x8b --text',
  '',
  '  --strings              list the strings in the binary instead of searching',
  '                         for one. Each carries its file offset, address and',
  '                         section, so it can be fed to symlookup or mapliteral.',
  '  --min=<n>              with --strings, shortest string to report (4)',
  '  --filter=<s>           with --strings, only strings containing this',
  '',
  'options:',
  '  --text                 search __TEXT only, rather than the whole file',
  '  --arch=<name>          read one slice of a universal binary (x86_64, arm64, arm64e, arm64_32, ppc, ppc64, arm, i386)',
  '  -b, --binary <p>       the binary to read',
  '  -q, --quiet            suppress non-essential output',
  '  --color                force color output',
  '  --no-color             disable color output',
  '  -v, --verbose          diagnostic output',
  '  --json                 one JSON object on stdout; prose to stderr',
  '  -h, --help             this message',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(
  new Set(['text', 'json', 'arch', 'strings', 'min', 'filter']),
  flags,
  HELP,
);

// `--strings` is a mode rather than a tool of its own: same file, same slice
// logic, same envelope, and the two share the code that maps an offset to a
// section. A separate `strings` binary would have been a seventh
// executable for a question this one already opens the file to answer.
const listStrings = flags.has('strings');

if (!listStrings && !positional[0]) usage(HELP);

const binary = requireBinary({ argv: opts.b || opts.binary || positional[listStrings ? 0 : 1] });
const textOnly = flags.has('text');
const needle = listStrings ? null : Buffer.from(positional[0], 'latin1');

let r;
try {
  r = listStrings
    ? findStrings(binary, {
        arch: opts.arch,
        min: opts.min ? Number(opts.min) : 4,
        filter: opts.filter || null,
      })
    : findLiteral(binary, needle, { textOnly, arch: opts.arch });
} catch (e) {
  if (flags.has('json')) {
    emitJSON({ tool: 'findliteral', binary, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(`${binary}: ${e.message}`);
  process.exit(EXIT.fail);
}

const notes = [];

// Encryption is stated before any "no match" prose, because it changes what a
// zero means. An App Store binary encrypts `__TEXT`, and `__cstring` lives
// inside it, so a miss here is a miss over ciphertext — the literal may be
// present and simply unreadable. Without this, `--strings` on an encrypted
// binary reports "0 strings" with the confident tone of a real answer.
if (listStrings && r.encryptedSections?.length) {
  notes.push(
    `${r.encryptedSections.join(', ')}: encrypted (App Store build) — these sections are ` +
      `ciphertext, so a zero result does not mean the binary has no strings`,
  );
} else if (r.searchedCiphertext?.length) {
  notes.push(
    `${r.searchedCiphertext.join(', ')}: the searched range is encrypted (App Store build) — ` +
      `these bytes are ciphertext, so a zero result does not mean the literal is absent`,
  );
} else if (r.encryptedSlices?.length) {
  notes.push(
    `${r.encryptedSlices.join(', ')}: encrypted (cryptid != 0), but the ciphertext does not ` +
      `overlap the range searched`,
  );
}

if (r.count === 0) {
  if (listStrings) {
    notes.push('no NUL-terminated strings found in __cstring, __objc_methname, __swift5_reflstr or __objc_classname');
    // Verified on a real Go toolchain binary rather than assumed: its strings are
    // length-prefixed inside __gopclntab, so there is no terminator to scan for
    // and a C-string reader legitimately finds none. Saying which is which stops
    // "0 strings" reading as "this binary has nothing to say".
    notes.push('a Go binary keeps its strings length-prefixed in __gopclntab, not NUL-terminated — use findliteral with a known substring, or mapliteral, instead');
  } else {
    notes.push('a magic built at runtime from parts never appears as a contiguous literal');
    notes.push('a stripped binary still contains its read-only data — search the whole file, not just __TEXT, if unsure');
  }
}

// Same rule as findcall: a zero over ciphertext is "could not look", not "found
// nothing", so it takes a distinct reason code and the failure exit. A positive
// count from an encrypted binary is still a real answer — the hits came from
// bytes that were readable — so encryption only downgrades the zero case.
const unreadable = r.count === 0
  && ((r.searchedCiphertext?.length ?? 0) > 0 || (listStrings && (r.encryptedSections?.length ?? 0) > 0));
const reason = r.count > 0 ? null : (unreadable ? 'encrypted' : 'no-match');
const exit = r.count > 0 ? EXIT.ok : (unreadable ? EXIT.fail : EXIT.empty);

if (flags.has('json')) {
  emitJSON({
    tool: 'findliteral', binary, ok: r.count > 0,
    errors: reason ? [reason] : [], notes, data: r,
  }, exit);
}

const hex = (v) => `0x${v.toString(16)}`;

if (listStrings) {
  console.log(
    `${binary} — ${count(r.count)} string(s) of ${r.min}+ bytes in ` +
      `${r.sections.join(', ')}, ${(r.scanned / 1024).toFixed(0)} KB scanned\n`,
  );
  for (const s of r.strings) {
    console.log(`  ${hex(s.vaddr)}  ${s.section.padEnd(28)} ${JSON.stringify(s.text)}`);
  }
} else {
  console.log(
    `binary: ${(r.scanned / 1048576).toFixed(0)} MB scanned, ${r.slices.length} slice(s), ` +
      `literal ${JSON.stringify(positional[0])} (${needle.length} bytes)`,
  );
  for (const s of r.slices) {
    console.log(`  ${s.arch}: file ${s.offset}..${s.offset + s.size} (${s.hits} hit(s))`);
  }

  console.log(`\n${r.count} occurrence(s) of ${JSON.stringify(positional[0])}`);
  for (const h of r.hits) {
    console.log(
      `  file 0x${h.off.toString(16).padStart(8, '0')} [${h.slice}]` +
        (h.vaddr !== null ? `  vaddr 0x${h.vaddr.toString(16)}` : '  unmapped') +
        (h.section ? `  ${h.section}` : '') +
        `\n      pre="${h.context.pre}"  hit="${h.context.hit}"`,
    );
  }
}
if (r.count === 0) for (const n of notes) console.log(`  note: ${n}`);

// Exit 1 for "ran, found nothing" — the same negative-result code --json
// reports. The JSON path set this and the text path did not, so the two
// interfaces disagreed about the same query, which is worse than either choice.
process.exit(r.count ? EXIT.ok : EXIT.empty);
