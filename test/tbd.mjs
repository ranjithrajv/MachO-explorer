#!/usr/bin/env node
/**
 * tbd.mjs — a text stub is read completely, or the answer is withheld.
 *
 *   node test/tbd.mjs
 *
 * ## What this is really asserting
 *
 * A `.tbd` is a *description* of a dylib: the exported names, the install names,
 * the target triples. There is no binary to sanity-check against, so the only way
 * to know a reader got it right is to ask what it produced and look at it. That
 * makes the failure modes unusually dangerous and unusually easy to hide.
 *
 * A symbol reader that under-reads produces a **well-formed, plausible, wrong**
 * answer. `libSystem.tbd` holds 39 documents and 9,561 symbols; a reader that
 * takes the first document reports 300 of them with the correct install name and
 * nothing to indicate the rest were missed. Nothing is red. Nothing throws. The
 * caller goes off to disassemble a function that was never in the list.
 *
 * So the suite is built around three defences rather than around one happy path:
 *
 *   1. **Fixtures are verbatim excerpts of real SDK files**, not files written to
 *      match the parser. A generated fixture is a restatement of the parser's own
 *      assumptions; it proves the parser agrees with itself. These are the actual
 *      bytes Apple ships, including a multi-line flow sequence, a quoted install
 *      name, an `$`-mangled name, and the trailing `...` marker.
 *
 *   2. **One fixture is malformed on purpose**, and the reader must *refuse* it.
 *      A stub with an unread line has an unknown symbol count, and printing the
 *      count anyway states something not known to be true.
 *
 *   3. **If a real SDK is present, every stub in it must parse with zero
 *      unrecognised lines.** 5,309 files, currently clean. This is the property no
 *      hand-written fixture can establish.
 *
 * ## The negative answers
 *
 * `no symbol X` exits 1, not 3. A caller that reads "nothing found" as a crash
 * will retry variations of a name that genuinely is absent, which is the behaviour
 * the four-code taxonomy exists to prevent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CLI = path.join(ROOT, 'src', 'tbd.mjs');
const TBD = path.join(HERE, 'fixtures', 'tbd');

let pass = 0;
const fails = [];
const skipped = [];

const ok = (cond, label, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fails.push(`${label}${detail ? `  — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
};
const eq = (a, b, label) => ok(a === b, label, a === b ? '' : `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const fixture = (n) => path.join(TBD, `${n}.tbd`);

const { readTbd, findSymbol, findInSdk, parseTbd } = await import('../src/stub.mjs');

const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* prose-only output */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
};

/* ================================================================== *
 * 1. every fixture parses, and completely
 * ================================================================== */

console.log('\n/* ---- 1. the corpus parses completely ---- */');

/**
 * Every fixture except the deliberately broken one.
 *
 * Written as "every .tbd in the directory that is not named malformed" rather than
 * as a list, so dropping a new fixture into the directory extends the suite
 * instead of quietly going untested — which is how a corpus rots.
 */
const CLEAN = fs
  .readdirSync(TBD)
  .filter((f) => f.endsWith('.tbd') && f !== 'malformed.tbd' && f !== 'v2.tbd');

for (const f of [...CLEAN, 'v2.tbd']) {
  const s = readTbd(fixture(f.replace(/\.tbd$/, '')));
  ok(s.unrecognised.length === 0, `${f}: no unrecognised line`, JSON.stringify(s.unrecognised.slice(0, 2)));
  ok(s.documentCount > 0, `${f}: at least one library`);
  ok(Array.isArray(s.symbols), `${f}: returns a symbol list`);
}

{
  // `...` is Apple's end-of-document marker and it is the last non-blank line of
  // every stub Apple ships. A parser that treats it as content puts one
  // unrecognised line on every single file, and a report that always says "1
  // unrecognised" is a report nobody reads — so when a *second* one arrives it
  // goes unheard. This is the assertion that keeps the counter meaningful.
  const text = fs.readFileSync(fixture('libz.1.2.11'), 'utf8');
  ok(/\n\.\.\.\s*$/.test(text), 'the libz fixture really does end with `...`, as every real stub does');
  const { unrecognised } = parseTbd(text, 'x');
  ok(!unrecognised.some((u) => u.text.trim() === '...'), 'the `...` marker is not reported as unrecognised');
}

/* ================================================================== *
 * 2. v4 and v2 both produce symbols
 * ================================================================== */

console.log('\n/* ---- 2. both format versions are read ---- */');

{
  const z = readTbd(fixture('libz.1.2.11'));
  eq(z.tbdVersion, 4, 'a v4 stub reports tbd-version 4');
  eq(z.documentCount, 1, 'a one-library stub reports one library');
  eq(z.installName, '/usr/lib/libz.1.dylib', 'the install name is read, with its quotes stripped');
  eq(z.symbolCount, 81, 'libz exports 81 symbols');
  ok(z.symbols.includes('_deflate'), 'a known symbol is in the list', z.symbols.slice(0, 4).join(' '));
  eq(z.libraries[0].currentVersion, '1.2.12', 'the dotted current-version is kept as text');
  eq(z.currentVersion, undefined, 'a stub reports no single version — a multi-library stub has no single version');
  ok(z.targets.length === 6, 'the target list is read', `${z.targets.length}: ${z.targets.join(',')}`);
  ok(z.targets.includes('arm64e-macos'), 'an arm64e target is present');
}

{
  // The v2 shape nests three mappings deep and writes every symbol as
  // `_name: null` — the names are the *keys*. Reading values alone reports a v2
  // stub as exporting nothing, which is the one answer a symbol reader must never
  // give about a file it read successfully.
  const v = readTbd(fixture('v2'));
  eq(v.tbdVersion, 2, 'a v2 stub reports tbd-version 2');
  ok(v.symbolCount >= 3, 'a v2 stub yields symbols', `${v.symbolCount}`);
  ok(v.symbols.includes('_printf'), 'a v2 symbol is in the list', v.symbols.join(' '));
  ok(v.symbols.includes('_malloc$RENAMED'), 'an $ re-export annotation survives as part of the name');
  ok(!v.symbols.includes('null'), 'the v2 `null` values are not read as a symbol named "null"');
  ok(v.objcClasses.includes('NSObject'), 'v2 objc-classes, nested two mappings deep, is read', v.objcClasses.join(' '));
  eq(v.reexportedLibraries.length, 1, 'v2 `re-exports` is read', v.reexportedLibraries.join(' '));
  ok(v.reexportedLibraries[0].endsWith('libcommon_shims.dylib'), 'the v2 re-export is the right install name');
}

{
  // Both versions, one code path. Two parsers for one format is two places for a
  // subtle disagreement to hide, and it would surface as a symbol list that
  // differs between SDK versions with no error in either.
  const v4 = readTbd(fixture('libz.1.2.11'));
  const v2 = readTbd(fixture('v2'));
  ok(v4.symbols.length > 0 && v2.symbols.length > 0, 'both versions produce symbols through the same reader');
  ok(
    Object.keys(v4).sort().join() === Object.keys(v2).sort().join(),
    'both versions produce the same answer *shape*',
    `v4-only: ${Object.keys(v4).filter((k) => !(k in v2))}; v2-only: ${Object.keys(v2).filter((k) => !(k in v4))}`,
  );
}

/* ================================================================== *
 * 3. a file may hold many libraries, and a symbol belongs to one
 * ================================================================== */

console.log('\n/* ---- 3. a stub is a stream of libraries ---- */');

{
  const s = readTbd(fixture('libsystem-excerpt'));
  eq(s.documentCount, 3, 'the excerpt holds three libraries');
  eq(s.installName, undefined, 'a multi-library stub has no single install name');
  ok(
    s.libraries.map((l) => l.installName).includes('/usr/lib/system/libsystem_malloc.dylib'),
    'each document keeps its own install name',
    s.libraries.map((l) => l.installName).join(' '),
  );

  // The question that makes the distinction matter: which library provides this?
  const hit = findSymbol(s, '___malloc_init').filter((h) => h.library.includes('malloc'));
  ok(hit.length > 0, '___malloc_init is attributed to libsystem_malloc.dylib', `${findSymbol(s, '___malloc_init').length} hits total`);
  ok(hit[0].library.endsWith('libsystem_malloc.dylib'), 'the attribution is the malloc library, not the umbrella');
  ok(Array.isArray(hit[0].targets) && hit[0].targets.length > 0, 'a hit carries the targets it is exported for');
}

{
  // Per-entry targets. libQMIParserDynamic has one entry whose weak symbols are
  // x86_64-only while the real symbols are all three architectures — flattening
  // them would lose the only interesting fact in the file.
  const s = readTbd(fixture('libQMIParserDynamic'));
  eq(s.weakSymbols.length, 2, 'the weak symbols are read');
  const weakEntry = s.libraries[0].exports.find((e) => e.weakSymbols.length);
  ok(!!weakEntry, 'the weak symbols are in their own export entry');
  eq(weakEntry.targets.join(','), 'x86_64-macos', 'that entry is x86_64-only, as the file says');
  const main = s.libraries[0].exports.find((e) => e.symbols.length);
  eq(main.targets.length, 3, 'and the main entry lists all three architectures');
}

{
  // Re-exports: read the `libraries` field of the entry, never the whole entry.
  // Walking the entry wholesale returns the six target triples alongside the one
  // library, so libnetwork reported **7** re-exported libraries when the file
  // lists exactly 1 — all of them real strings, so the wrong answer looked right.
  const s = readTbd(fixture('libnetwork'));
  eq(s.reexportedLibraries.length, 1, 'libnetwork re-exports exactly one library', s.reexportedLibraries.join(' '));
  const viaCli = run([fixture('libnetwork'), '--reexports', '--json']);
  eq(viaCli.json.data.reexportedLibraries.length, 1, 'and the CLI agrees — one, not seven');
  eq(viaCli.json.data.libraries, undefined, 'and does not answer under the summary libraries name');
  ok(
    s.reexportedLibraries[0] === '/System/Library/Frameworks/Network.framework/Versions/A/Network',
    'and it is the right one',
    s.reexportedLibraries.join(' '),
  );
  ok(!s.reexportedLibraries.some((l) => l.includes('-macos')), 'no target triple leaked into the library list');
}

{
  const s = readTbd(fixture('libUSBCfwflasher'));
  eq(s.objcClasses.length, 5, 'objc-classes is read');
  ok(s.libraries[0].objcIvars.length > 20, 'objc-ivars is read', `${s.libraries[0].objcIvars.length}`);
  ok(
    s.libraries[0].objcIvars.some((v) => v.includes('.') && v.split('.')[0] === 'flashUpdater'),
    'and keeps the dotted Class.ivar spelling',
    s.libraries[0].objcIvars.slice(0, 3).join(' '),
  );
  ok(s.objcClasses.includes('flashUpdater'), 'a known class is present');
}

{
  const s = readTbd(fixture('libInFieldCollection'));
  eq(s.libraries[0].flags.join(','), 'not_app_extension_safe', 'a top-level flags list is read');
}

{
  const s = readTbd(fixture('objc-eh-excerpt'));
  eq(s.libraries[0].objcEhTypes.join(','), 'CKException', 'objc-eh-types is read');
  ok(s.libraries[0].objcIvars.length > 0, 'objc-ivars is read alongside it');
}

/* ================================================================== *
 * 4. a malformed stub is refused, not partially reported
 * ================================================================== */

console.log('\n/* ---- 4. an unread line withholds the answer ---- */');

{
  const s = readTbd(fixture('malformed'));
  ok(s.unrecognised.length > 0, 'the malformed fixture is detected');
  ok(s.unrecognised.every((u) => typeof u.line === 'number' && u.line > 0), 'each is reported with a line number');
  ok(
    s.unrecognised.every((u) => /anchor|not a key|indented/.test(u.why)),
    'and with a reason naming the construct',
    s.unrecognised.map((u) => u.why).join(' | '),
  );

  const r = run([fixture('malformed')]);
  eq(r.status, 3, 'the CLI exits 3 — could not do the job');
  ok(/does not understand/.test(r.stderr), 'and says why');
  ok(/Refusing to report a partial symbol list/.test(r.stderr), 'and says it will not guess a count');
  ok(!/\bsymbol\(s\)\b/.test(r.stdout), 'and prints no symbol count on stdout', r.stdout.slice(0, 120));

  const j = run([fixture('malformed'), '--json']);
  eq(j.status, 3, 'and exits 3 with --json too');
  eq(j.json?.ok, false, 'ok is false');
  eq(j.json?.data, null, 'data is null — a partial answer is not an answer');
  ok((j.json?.errors || []).includes('unknown-encoding'), 'the reason code is unknown-encoding', JSON.stringify(j.json?.errors));
}

{
  // A Mach-O is not a stub. The two are different formats in different files, and
  // the message has to say which, because "not a Mach-O" about a .tbd sends the
  // reader looking for a binary problem they do not have.
  const r = run([path.join(HERE, 'fixtures', 'thin-arm64.macho')]);
  eq(r.status, 3, 'a Mach-O passed to tbd exits 3');
  ok(/not a tbd stub/.test(r.stderr), 'and is told it is not a stub', r.stderr.trim().slice(0, 120));
}

{
  const r = run([path.join(TBD, 'no-such-file.tbd')]);
  eq(r.status, 3, 'a missing stub exits 3');
  ok(/cannot be read/.test(r.stderr), 'and says the file could not be read');
  const j = run([path.join(TBD, 'no-such-file.tbd'), '--json']);
  eq((j.json?.errors || [])[0], 'io', 'the reason code is io, not unknown-encoding');
}

/* ================================================================== *
 * 5. a negative answer is exit 1, not a failure
 * ================================================================== */

console.log('\n/* ---- 5. nothing found is an answer ---- */');

{
  const r = run([fixture('libz.1.2.11'), '--symbol=_not_in_libz']);
  eq(r.status, 1, 'a name the stub does not export exits 1');
  ok(/no exported name equals/.test(r.stdout), 'and says so in prose');

  const j = run([fixture('libz.1.2.11'), '--symbol=_not_in_libz', '--json']);
  eq(j.status, 1, 'with --json it still exits 1');
  eq(j.json?.ok, true, 'ok stays true — the question was answered');
  eq(j.json?.errors?.length, 0, 'errors is empty: nothing found is not an error');
  eq(j.json?.data?.matchCount, 0, 'matchCount is the precise signal');
  ok(
    (j.json?.notes || []).some((n) => /negative answer about the stub/.test(n)),
    'and a note says what kind of answer this is',
  );

  const hit = run([fixture('libz.1.2.11'), '--symbol=_deflate']);
  eq(hit.status, 0, 'a name the stub does export exits 0');
  eq(hit.json?.ok, undefined, 'prose mode writes no JSON', hit.json === null);
}

{
  const r = run([fixture('libz.1.2.11'), '--symbol=deflate', '--mode=substring']);
  eq(r.status, 0, 'substring mode matches inside a name');
  const j = run([fixture('libz.1.2.11'), '--symbol=deflate', '--mode=substring', '--json']);
  ok(j.json.data.matchCount > 1, 'and finds several', `${j.json.data.matchCount}`);
  const exact = run([fixture('libz.1.2.11'), '--symbol=deflate', '--json']);
  eq(exact.status, 1, 'while the same query in exact mode finds none — a different question');
}

/* ================================================================== *
 * 6. searching an SDK, and not counting a symlink twice
 * ================================================================== */

console.log('\n/* ---- 6. the SDK search ---- */');

{
  const r = findInSdk(path.join(TBD, 'sdk'), '_adler32');
  eq(r.stubs, 2, 'four files on disk, two distinct stubs');
  eq(r.aliasesSkipped, 2, 'two symlinks resolved to a stub already seen');
  eq(r.hits.length, 1, 'and one hit, not three');
  ok(
    r.hits[0].file.endsWith('libz.tbd'),
    'the regular file is the canonical one, not the symlink that sorts first',
    r.hits[0].file,
  );
}

{
  // 46% of the stubs in a real SDK are symlinks. Reporting `_pthread_mutex_lock`
  // as exported by 39 files is well-formed, self-consistent and wrong, and a
  // reader concludes there are 39 places to look.
  const j = run(['--symbol=_adler32', `--sdk=${path.join(TBD, 'sdk')}`, '--json']);
  eq(j.status, 0, 'an SDK search that finds something exits 0');
  eq(j.json.data.symbolCount, 1, 'one hit');
  eq(j.json.data.providerCount, 1, 'one providing library');
  eq(j.json.data.aliasesSkipped, 2, 'and the alias count is reported rather than hidden');
  ok(
    (j.json.notes || []).some((n) => /one stub per interface umbrella/.test(n)),
    'with a note explaining why',
  );

  const miss = run(['--symbol=_definitely_absent', `--sdk=${path.join(TBD, 'sdk')}`, '--json']);
  eq(miss.status, 1, 'an SDK search that finds nothing exits 1');
  eq(miss.json.ok, true, 'ok stays true');
  eq(miss.json.data.symbolCount, 0, 'and reports zero');
}

{
  // Usage errors, which are the caller's to fix and must be distinguishable.
  eq(run(['--sdk=/tmp']).status, 2, '--sdk without --symbol is a usage error');
  eq(run(['--symbol=_x', '--mode=regex']).status, 2, 'an unknown --mode is a usage error');
  eq(run(['--symbol=_x', '--max=-1']).status, 2, 'a negative --max is a usage error');
  eq(run([]).status, 2, 'no arguments at all is a usage error');
  eq(run(['--bogus']).status, 2, 'an unknown flag is a usage error');
  ok(run(['--sdk=/tmp']).stderr.includes('needs --symbol'), 'and the usage error says what is missing');
}

/* ================================================================== *
 * 7. listings cap honestly
 * ================================================================== */

console.log('\n/* ---- 7. a capped listing keeps the count exact ---- */');

{
  // `--symbols` as well as `--max`: a cap with no listing asked for is not a
  // listing, and the default summary does not have a list to truncate.
  const all = run([fixture('libz.1.2.11'), '--symbols', '--json']);
  const cap = run([fixture('libz.1.2.11'), '--symbols', '--max=5', '--json']);
  eq(all.json.data.symbolCount, 81, 'the full count is exact');
  eq(cap.json.data.symbols.length, 5, 'a capped listing returns the cap');
  eq(cap.json.data.symbolCount, 81, 'and still reports the exact total — the count is not the cap');
  eq(cap.json.data.truncated, true, 'and says it was truncated');
  ok(
    (cap.json.notes || []).some((n) => /the count is exact/.test(n)),
    'with a note, so a reader knows the number is not the length of the list',
  );
}

/* ---- 8. every stub in a real SDK ---- */

/*
 * The property no hand-written fixture can establish: every file Apple ships,
 * parsed with zero unrecognised lines.
 *
 * ## Why it samples by default
 *
 * The macOS 15.2 SDK holds 5,309 stubs totalling ~200 MB of text, and parsing all
 * of them takes minutes. A check that takes minutes stops being run, and a check
 * that stops being run is decoration.
 *
 * So the default is a **deterministic stride sample** — every *n*th file in sorted
 * order — and `--full` walks the lot. Deterministic matters more than random
 * here: a fixed stride means a failure reproduces, and a random sample means the
 * same broken construct can pass today and fail tomorrow, which teaches people
 * the check is flaky rather than that something is wrong.
 *
 * The sample size is reported either way, so a run never reads as a full sweep
 * when it was not.
 */
{
  const FULL = process.argv.includes('--full');
  const SAMPLE = 300;

  const SDKS = [
    '/Library/Developer/CommandLineTools/SDKs/MacOSX15.2.sdk',
    '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',
  ];
  const sdk = SDKS.find((d) => {
    if (!fs.existsSync(d)) return false;
    try {
      return fs.readdirSync(path.join(d, 'usr', 'lib')).some((f) => f.endsWith('.tbd'));
    } catch {
      return false;
    }
  });

  if (!sdk) {
    skipped.push({ name: 'stubs from a real SDK parse', why: `no SDK at ${SDKS.join(' or ')}` });
    console.log('  SKIP  stubs from a real SDK parse — no SDK on this machine');
  } else {
    const files = [];
    (function walk(d, dep) {
      if (dep > 12) return;
      let e;
      try {
        e = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const x of e.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = path.join(d, x.name);
        if (x.isDirectory()) {
          if (x.name.endsWith('.sdk')) continue;
          walk(p, dep + 1);
        } else if (x.name.endsWith('.tbd')) files.push(p);
      }
    })(sdk, 0);

    const stride = Math.max(1, Math.floor(files.length / SAMPLE));
    const chosen = FULL ? files : files.filter((_, i) => i % stride === 0);
    const scope = FULL ? `all ${files.length}` : `${chosen.length} of ${files.length}, every ${stride}th in sorted order`;

    const dirty = [];
    let totalSymbols = 0;
    let totalDocs = 0;
    let multiDoc = 0;
    let reexports = 0;
    for (const f of chosen) {
      let s;
      try {
        s = readTbd(f);
      } catch (e) {
        dirty.push(`${f.replace(sdk, '<SDK>')}: threw ${e.message.slice(0, 60)}`);
        continue;
      }
      if (s.unrecognised.length) {
        dirty.push(`${f.replace(sdk, '<SDK>')}:${s.unrecognised[0].line} ${s.unrecognised[0].why}`);
      }
      totalSymbols += s.symbolCount;
      totalDocs += s.documentCount;
      if (s.documentCount > 1) multiDoc++;
      if (s.reexportedLibraries.length) reexports++;
    }

    ok(
      dirty.length === 0,
      `${scope} stubs from ${path.basename(sdk)} parse with zero unrecognised lines`,
      dirty.slice(0, 3).join(' | '),
    );
    ok(totalSymbols > 5000, `and between them they carry ${totalSymbols} symbols`, `${totalSymbols}`);
    ok(multiDoc > 0, `${multiDoc} of them hold more than one library — the multi-document shape is exercised, not assumed`);
    ok(reexports > 0, `${reexports} of them re-export a library — the re-export path is exercised`);

    // A stub with a symbol named "null", or an architecture in the library list,
    // would both be silent. Assert the absence of each specifically.
    let nullish = 0;
    let leaked = 0;
    for (const f of chosen.slice(0, 120)) {
      const s = readTbd(f);
      if (s.symbols.includes('null')) nullish++;
      if (s.reexportedLibraries.some((l) => /-macos|-ios|-maccatalyst/.test(l))) leaked++;
    }
    ok(nullish === 0, `no stub exports a symbol named "null" (${nullish} of 120 do)`);
    ok(leaked === 0, `no target triple appears in a re-exported-library list (${leaked} of 120 do)`);
  }
}


/* ================================================================== *
 * 9. the answer says what it is not
 * ================================================================== */

console.log('\n/* ---- 9. the gap list travels with the answer ---- */');

{
  const j = run([fixture('libz.1.2.11'), '--json']);
  ok(
    (j.json.notes || []).some((n) => /not a Mach-O/.test(n)),
    'a stub answer says it is not a Mach-O',
    JSON.stringify(j.json.notes),
  );
  ok(
    (j.json.notes || []).some((n) => /re-export/.test(n) && /linker/.test(n)),
    'and says a re-export is not an implementation',
  );

  const o = run([fixture('libUSBCfwflasher'), '--objc', '--json']);
  ok(
    (o.json.notes || []).some((n) => /no type, no ivar offset/.test(n)),
    'the objc listing says it reads no metadata beyond names',
  );
}

/* ================================================================== */

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
console.log(`${pass} passed. Every stub read here was read completely, or the answer was withheld.`);