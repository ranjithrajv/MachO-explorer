#!/usr/bin/env node
/**
 * symbolicate.mjs — the addresses in a crash report are resolved, or the reason is
 * named.
 *
 *   node test/symbolicate.mjs
 *
 * ## What this is really asserting
 *
 * A crash report is the one input where the *format disagreement is the whole
 * problem*. A `.ips` frame carries an offset into an image and the base must be
 * added; a legacy `.crash` frame carries an address that is already absolute. A
 * reader that applies the wrong rule to either produces numbers that look like
 * addresses, land inside a real image, and name the wrong function — a confident
 * answer about the wrong instruction, which is the failure this package exists to
 * refuse.
 *
 * So the first thing asserted is not a symbol. It is that the two formats produce
 * the *same* answer from the same logical stack, and that the result says which
 * parser ran. A symbol resolved from the wrong base is worse than no symbol.
 *
 * ## The negative answers, which are the point
 *
 * Most frames in a real modern crash report cannot be resolved on the machine that
 * produced it: since macOS 11 the system libraries live in the dyld shared cache
 * with no file on disk. The suite asserts that case explicitly and asserts the
 * *reason* names it — because "this function is not known" and "there was no file
 * to ask" send a reader to different places, and a bare `0x…` says neither.
 *
 * Also asserted: a symbol the report already carried is reported as
 * `symbolSource: 'report'`, never as something this package computed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'src', 'symbolicate.mjs');

/**
 * The binary the reports point at.
 *
 * `populated.macho` because its symbols are pinned by the fixture generator and by
 * `smoke.mjs`, so this suite and that one cannot disagree about where `caller_a` is.
 * Its `__TEXT` base is `0x100000000`, `caller_a` is at `+0x160` and `target_fn` at
 * `+0x220`; the corpus check below re-derives those rather than trusting the
 * constants, so a fixture change fails here instead of quietly re-pointing the test.
 */
const BINARY = path.join(HERE, 'fixtures', 'populated.macho');

let pass = 0;
const fails = [];
const skipped = [];

const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fails.push(`${label}${detail ? `  — ${detail}` : ''}`); console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const eq = (a, b, label) => ok(
  a === b, label,
  a === b ? '' : `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`,
);

const { symbolicate, lookupAddress } = await import('../src/api.mjs');
const { parseCrash } = await import('../src/crash.mjs');

const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* prose-only */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macho-symbolicate-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('exit', cleanup);

/* ---- the two report shapes, built over one logical stack ------------- */

const SYSTEM_PATH = '/usr/lib/system/libsystem_c.dylib';
const ipsPath = path.join(tmp, 'sample.ips');
const legacyPath = path.join(tmp, 'sample.crash');

const ips = [
  {
    app_name: 'PopApp', app_version: '1.0', os_version: 'macOS 15.0',
    bug_type: '309', incident_id: 'ABC-123',
    timestamp: '2026-10-07 10:00:00.00 +0000', platform: 1,
  },
  {
    procName: 'PopApp',
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' },
    faultingThread: 0,
    usedImages: [
      { base: 0x100000000, size: 0x1000, name: 'populated', path: BINARY, uuid: 'A1B2C3D4-0000-0000-0000-000000000001', arch: 'x86_64' },
      { base: 0x180000000, size: 0x2000, name: 'libsystem_c.dylib', path: SYSTEM_PATH, uuid: 'FFEE0000-0000-0000-0000-000000000002', arch: 'x86_64' },
    ],
    threads: [{
      triggered: true, id: 1,
      frames: [
        { imageIndex: 0, imageOffset: 0x160 },
        { imageIndex: 0, imageOffset: 0x220, symbol: '_target_fn', symbolLocation: 0 },
        { imageIndex: 1, imageOffset: 0x10 },
      ],
    }],
  },
];
fs.writeFileSync(ipsPath, JSON.stringify(ips[0]) + '\n' + JSON.stringify(ips[1]));

// The same stack written the legacy way. Note the frames carry absolute addresses
// here — that difference is the thing under test.
const legacy = `Incident Identifier: ABC-123
Process:         PopApp [123]
Path:            /Applications/PopApp.app/Contents/MacOS/PopApp
OS Version:      macOS 15.0 (24A335)
Code Type:       X86-64 (Native)
Date/Time:       2026-10-07 10:00:00.00
Exception Type:  EXC_BAD_ACCESS (SIGSEGV)
Exception Codes: KERN_INVALID_ADDRESS at 0x0000000000000000

Thread 0 Crashed:
0   populated          0x0000000100000160 0x100000000 + 352
1   populated          0x0000000100000220 _target_fn + 40
2   libsystem_c.dylib  0x0000000180000010 0x180000000 + 16

Binary Images:
0x100000000 - 0x100001000 populated x86_64 <A1B2C3D4-0000-0000-0000-000000000001> ${BINARY}
0x180000000 - 0x180002000 libsystem_c.dylib x86_64 <FFEE0000-0000-0000-0000-000000000002> ${SYSTEM_PATH}
`;
fs.writeFileSync(legacyPath, legacy);

/* ---- 1. the fixture's own answers are what this suite assumes ------- */

console.log('\nsymbolicate: the corpus answers the suite reuses');
{
  if (!fs.existsSync(BINARY)) {
    skipped.push({ name: 'the fixture exists', why: `${BINARY} is missing` });
  } else {
    const a = lookupAddress(BINARY, 0x100000160n);
    const b = lookupAddress(BINARY, 0x100000220n);
    eq(a.function, 'caller_a', 'the fixture still has caller_a at __TEXT+0x160 — this suite assumes it');
    eq(b.function, 'target_fn', 'and target_fn at __TEXT+0x220');
  }
}

/* ---- 2. both formats, same stack, same answers ---------------------- */

console.log('\nsymbolicate: .ips and legacy agree about one logical stack');
{
  const a = symbolicate(ipsPath);
  const b = symbolicate(legacyPath);

  eq(a.format, 'ips', '.ips is detected as `ips`');
  eq(b.format, 'legacy', 'the text report is detected as `legacy`');
  eq(a.totals.frames, b.totals.frames, 'both report the same number of frames');

  // The load-bearing assertion: the *same* logical frames resolve to the *same*
  // symbols, one having added a base and the other not. If the wrong rule were
  // applied to either, these diverge while both still look like addresses.
  const aSyms = a.threads[0].frames.map((f) => f.symbol);
  const bSyms = b.threads[0].frames.map((f) => f.symbol);
  eq(aSyms.join(','), bSyms.join(','), 'the same frames yield the same symbols in both formats');
  eq(aSyms[0], 'caller_a', 'frame 0 resolves to caller_a in the .ips');
  eq(bSyms[0], 'caller_a', 'frame 0 resolves to caller_a in the legacy report');

  // A base that was not added would land at 0x160, which no image covers — so this
  // is the check that fails loudly when the offset rule is dropped.
  ok(
    a.threads[0].frames[0].vaddr === '0x100000160',
    'the .ips offset is added to the image base, not used as an address',
    a.threads[0].frames[0].vaddr,
  );
  ok(
    b.threads[0].frames[0].vaddr === '0x100000160',
    'the legacy absolute address is used as given',
    b.threads[0].frames[0].vaddr,
  );
}

/* ---- 3. a symbol the report carried is not this package's work ------ */

console.log('\nsymbolicate: a pre-existing symbol is labelled as such');
{
  const a = symbolicate(ipsPath);
  const f = a.threads[0].frames[1];
  eq(f.symbol, '_target_fn', 'the symbol the report carried is reported');
  eq(f.symbolSource, 'report', 'and is marked as coming from the report, not from us');
  ok(
    !f.reason,
    'a frame the report already named carries no "why not resolved" reason',
    f.reason,
  );
  const g = a.threads[0].frames[0];
  eq(g.symbolSource, 'binary', 'a frame we resolved ourselves is marked `binary`');
}

/* ---- 4. the unresolvable frame says why, and it is the real reason -- */

console.log('\nsymbolicate: an unresolvable frame names the reason');
{
  const a = symbolicate(ipsPath);
  const f = a.threads[0].frames[2];
  eq(f.symbol, null, 'a frame in a system library resolves to no symbol');
  ok(
    typeof f.reason === 'string' && /dyld shared cache|not on disk/.test(f.reason),
    'and says the system library is in the dyld shared cache, which is why',
    f.reason,
  );
  // The vaddr is still computed — "we cannot name it" is not "we do not know where
  // it was". Conflating those is the failure the reason field exists to prevent.
  const img = a.images.find((i) => i.name === 'libsystem_c.dylib');
  ok(!!img && img.base === '0x180000000', 'the image is still reported with its base', JSON.stringify(img));
}

/* ---- 5. --no-resolve withholds rather than guessing ----------------- */

console.log('\nsymbolicate: --no-resolve withholds and says so');
{
  const a = symbolicate(ipsPath, { resolve: false });
  const f = a.threads[0].frames[0];
  eq(f.symbol, null, 'no symbol is produced');
  ok(
    typeof f.reason === 'string' && /not requested/.test(f.reason),
    'and the reason names the flag rather than the file',
    f.reason,
  );
  eq(a.totals.fromBinary, 0, 'nothing is counted as resolved from a binary');
}

/* ---- 6. the totals separate three different answers ----------------- */

console.log('\nsymbolicate: the counts distinguish report, binary and unresolved');
{
  const a = symbolicate(ipsPath);
  eq(a.totals.fromBinary, 1, 'one frame resolved from a binary');
  eq(a.totals.fromReport, 1, 'one frame came from the report');
  eq(a.totals.unresolved, 1, 'one frame was not resolved');
  eq(a.totals.fromBinary + a.totals.fromReport + a.totals.unresolved, a.totals.frames,
    'the three counts add up to the frame total — no frame is counted twice or dropped');
}

/* ---- 7. the CLI: exit codes, the envelope, and text ---------------- */

console.log('\nsymbolicate CLI: exit status and the one envelope');
{
  const r = run([ipsPath]);
  eq(r.status, 0, 'a report that resolved something exits 0');

  const j = run(['--json', ipsPath]);
  ok(j.json !== null, '--json writes parseable JSON to stdout');
  if (j.json) {
    eq(j.json.tool, 'symbolicate', 'the envelope names the tool');
    eq(j.json.ok, true, 'and reports ok');
    eq(j.json.schemaVersion, '1.0', 'and carries the schema version');
    eq(j.json.errors.length, 0, 'with no reason codes on a good run');
    ok(Array.isArray(j.json.data.notRead), 'and the omissions list every answer carries');
    eq(j.json.data.format, 'ips', 'the format travels in the payload, not only the prose');
  }

  const none = run(['--no-resolve', ipsPath]);
  // `--no-resolve` still resolves nothing *by request*, but the report supplies one
  // symbol itself, so there is still an answer — exit 0, not 1.
  eq(none.status, 0, '--no-resolve still exits 0 when the report itself names a frame');

  const missing = run([path.join(tmp, 'nope.ips')]);
  eq(missing.status, 3, 'a report that cannot be read exits 3, not 1');
  const missingJson = run(['--json', path.join(tmp, 'nope.ips')]);
  ok(
    missingJson.json && missingJson.json.ok === false
      && Array.isArray(missingJson.json.errors)
      && missingJson.json.errors.includes('io'),
    'and reports it as `io` in the envelope, not as a resolved nothing',
    JSON.stringify(missingJson.json?.errors),
  );

  const usage = run([]);
  eq(usage.status, 2, 'no argument at all is a usage error');
  const tooMany = run([ipsPath, legacyPath]);
  eq(tooMany.status, 2, 'two reports is a usage error — one report at a time');
}

console.log('');
if (skipped.length) {
  console.log(`${skipped.length} skipped:`);
  for (const s of skipped) console.log(`  ${s.name}\n    ${s.why}`);
  console.log('  A skip means the input was unavailable, not that the check passed.');
}
if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass} passed. Every address resolved, or the reason named.`);
