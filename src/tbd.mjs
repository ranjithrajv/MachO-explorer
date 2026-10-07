#!/usr/bin/env node
/**
 * tbd.mjs — read a text-based stub, and answer what it exports.
 *
 *   node src/tbd.mjs <stub.tbd> [--symbol=<name>] [--symbols] [--reexports] [--objc] [--max=<n>] [--json]
 *   node src/tbd.mjs --symbol=<name> --sdk=<dir>
 *
 * ## Why this is in a Mach-O tool
 *
 * Since macOS 11 the system dylibs do not exist as files. `/usr/lib/libSystem.B.dylib`
 * is inside the dyld shared cache, so `nm`, `otool` and this package's own symbol
 * tools have nothing to open — the question is not slow on a modern machine, it
 * is unanswerable by anything that reads binaries.
 *
 * The answer is in the SDK, as text. A `.tbd` is what Apple would have shipped if
 * the symbol table had been a file: install names, target triples, and every
 * exported name. Reading one needs no Mach-O parser at all, which is why this
 * tool works on a stub and on nothing else.
 *
 * ## `--find` is the reason to install it
 *
 * `--symbol X --sdk <dir>` answers *which library provides X* — across an entire
 * SDK, in a second, with no binary anywhere. That question has no other answer on
 * a current macOS, and it is the first thing anyone reverse-engineering a modern
 * Apple binary needs: you cannot call `malloc` usefully without knowing it is
 * `libsystem_malloc.dylib` and not `libSystem.B.dylib`.
 *
 * ## The stub is a stream of libraries, and this says so
 *
 * `libSystem.tbd` is **39 documents** in one file — one per constituent dylib.
 * A reader that took only the first would report the umbrella's own metadata and a
 * fraction of its symbols with nothing in the answer indicating that. So the
 * summary always states the document count, and `--symbol` attributes every hit to
 * the document that exports it.
 *
 * ## Exit codes
 *
 *   0  ran, found something
 *   1  ran, found nothing — this stub does not export that name. A negative
 *      answer, not an error, and a caller that retries variations is wasting time
 *   2  usage error
 *   3  could not do the job — unreadable file, or a file that is not a stub
 */
import { readTbd, findSymbol, findInSdk } from './stub.mjs';
import { parseArgs, emitJSON, usage, EXIT, rejectUnknownFlags, count, isVerbose, verboseLog } from './output.mjs';

const { flags, opts, positional } = parseArgs(process.argv.slice(2));

const HELP = [
  'usage: node src/tbd.mjs <stub.tbd> [options]',
  '       node src/tbd.mjs --symbol=<name> --sdk=<dir>',
  '',
  '  Read a .tbd text stub: the exported symbols, install names and target',
  '  triples of a dylib. Since macOS 11 the system libraries exist only in the',
  '  dyld shared cache, so this is the only readable record of what they export.',
  '',
  '  A .tbd may hold many libraries — libSystem.tbd holds 39 — so a symbol is',
  '  always attributed to the library that exports it, not to the file.',
  '',
  'queries:',
  '  --symbol=<name>     is this name exported, by which library, for which targets',
  '  --symbols           list every exported symbol',
  '  --reexports         list the libraries and symbols this stub re-exports',
  '  --objc              list Objective-C classes and ivars',
  '  --sdk=<dir>         search a whole SDK (needs --symbol)',
  '',
  'options:',
  '  --mode=<m>          exact (default) or substring, for --symbol',
  '  --max=<n>           cap a listing (default: all); the count stays exact',
  '  --json              one JSON object on stdout; prose to stderr',
  '  -h, --help          this message',
  '',
  'exit codes:',
  '  0  ran, found something',
  '  1  ran, found nothing (this stub does not export it)',
  '  2  usage error',
  '  3  could not do the job',
];

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(EXIT.ok);
}

rejectUnknownFlags(new Set(['json', 'symbols', 'reexports', 'objc', 'symbol', 'sdk', 'mode', 'max']), flags, HELP);

const mode = opts.mode ?? 'exact';
if (mode !== 'exact' && mode !== 'substring') {
  usage([`--mode must be exact or substring`, `  got: ${mode}`]);
}

const max = opts.max === undefined ? 0 : Number(opts.max);
if (!Number.isInteger(max) || max < 0) {
  usage([`--max must be a whole number >= 0 (0 means all)`, `  got: ${opts.max}`]);
}

const wantsList = flags.has('symbols') || flags.has('reexports') || flags.has('objc');
const symbol = opts.symbol;
const sdk = opts.sdk;
verboseLog(flags, sdk
  ? `tbd: searching ${sdk} for ${symbol}`
  : `tbd: reading ${positional.join(', ') || '(no target yet)'}`);

if (!symbol && !sdk && !wantsList && positional.length === 0) {
  usage(HELP.slice(2, 8));
}

if (sdk && !symbol) {
  usage([
    `--sdk needs --symbol: an SDK search answers "which library exports this name".`,
    `  got: --sdk ${sdk} with no --symbol`,
  ]);
}

if (symbol && sdk && positional.length) {
  usage([
    `--sdk searches a directory, so a positional stub path would be ambiguous.`,
    `  drop one of them: ${positional[0]}`,
  ]);
}

/* ------------------------------------------------------------------ *
 * SDK search — the question with no other answer on a modern macOS
 * ------------------------------------------------------------------ */

if (sdk) {
  let r;
  try {
    r = findInSdk(sdk, symbol, { mode, maxFiles: max });
  } catch (e) {
    if (flags.has('json')) {
      emitJSON({ tool: 'tbd', binary: sdk, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
    }
    console.error(e.message);
    process.exit(EXIT.fail);
  }

  // The same name in 39 files is one library reached by 39 names, and saying so
  // is the difference between a correct answer and one that sends a reader
  // looking through 39 files that are all the same bytes.
  const providers = [...new Set(r.hits.map((h) => h.library))];
  const notes = [
    `a .tbd is text; this tool reads stubs and not Mach-O, so it is the only reader here that answers from an SDK`,
    r.aliasesSkipped
      ? `${r.aliasesSkipped} of the stubs under this root are symlinks to the same file and were resolved once — an SDK ships one stub per interface umbrella, so several names reach one file`
      : 'no symlinked stubs under this root',
  ];
  if (r.truncated) notes.push(`--max=${max} stopped the walk after ${r.scanned} stub(s); raise it to search all ${r.stubs}`);
  if (r.unreadable) notes.push(`${r.unreadable} stub(s) could not be read and are not counted as absences`);

  const status = r.hits.length ? EXIT.ok : EXIT.empty;

  if (flags.has('json')) {
    emitJSON({
      tool: 'tbd',
      binary: sdk,
      ok: true,
      notes,
      data: {
        query: symbol,
        mode,
        symbolCount: r.hits.length,
        // `providers`, not `libraries`: the summary answers with library
        // *objects* under `libraries`, and one field cannot be both a list of
        // objects and a list of strings. The collision was found by the schema
        // suite — `$.data.libraries[0]: expected string, got object` — which is
        // exactly what it is for.
        providers,
        providerCount: providers.length,
        scanned: r.scanned,
        stubs: r.stubs,
        aliasesSkipped: r.aliasesSkipped,
        truncated: r.truncated,
        hits: r.hits,
      },
    }, status);
  }

  console.log(`${symbol}  —  ${r.hits.length} hit(s) in ${providers.length} librar${providers.length === 1 ? 'y' : 'ies'}, from ${r.stubs} stub(s)`);
  for (const p of providers) console.log(`  ${p}`);
  for (const h of r.hits.slice(0, 20)) {
    const via = h.reexported ? '  (re-exported)' : h.weak ? '  (weak)' : '';
    console.log(`    ${h.symbol}${via}   ${h.file}#${h.document}${h.targets ? `  [${h.targets.join(', ')}]` : ''}`);
  }
  if (r.hits.length > 20) console.log(`    ...and ${count(r.hits.length - 20)} more`);
  if (!r.hits.length) console.log(`\n  no stub under ${sdk} exports ${mode === 'exact' ? '' : 'anything containing '}${symbol}`);
  process.exit(status);
}

/* ------------------------------------------------------------------ *
 * a single stub
 * ------------------------------------------------------------------ */

const file = positional[0];

let stub;
try {
  stub = readTbd(file);
} catch (e) {
  if (flags.has('json')) {
    emitJSON({ tool: 'tbd', binary: file, ok: false, errors: [e.code ?? 'io'], messages: [e.message] }, EXIT.fail);
  }
  console.error(e.message);
  process.exit(EXIT.fail);
}

/**
 * Unrecognised lines are fatal, not a note.
 *
 * A stub with a line this reader did not understand has an *unknown* symbol count.
 * Printing the count anyway — even alongside a warning — states something not
 * known to be true, and "this stub exports 4,100 symbols" is exactly the kind of
 * confident answer that sends someone down the wrong path. So the tool exits 3
 * with the lines named, which is also the only way anyone finds out the parser
 * needs extending.
 */
if (stub.unrecognised.length) {
  const lines = stub.unrecognised.slice(0, 5).map((u) => `  ${file}:${u.line}  ${u.why}`);
  const more = stub.unrecognised.length > 5 ? `\n  ...and ${count(stub.unrecognised.length - 5)} more` : '';
  const msg =
    `${file}: ${count(stub.unrecognised.length)} line(s) this reader does not understand, so its symbol count is unknown\n` +
    lines.join('\n') +
    more +
    `\n\n  Refusing to report a partial symbol list. Every line is parsed or the answer is withheld.`;
  if (flags.has('json')) {
    emitJSON({ tool: 'tbd', binary: file, ok: false, errors: ['unknown-encoding'], messages: [msg] }, EXIT.fail);
  }
  console.error(msg);
  process.exit(EXIT.fail);
}

const notes = [
  'a .tbd is text describing a dylib; this is not a Mach-O and nothing here is read from a binary',
  'these are the names the *linker* sees, not what is in the shared cache: a re-export is recorded where it passes through, and the implementation may live in another library entirely',
];

/* ---- --symbol ---- */

if (symbol) {
  const hits = findSymbol(stub, symbol, { mode });
  const libraries = [...new Set(hits.map((h) => h.library))];
  const status = hits.length ? EXIT.ok : EXIT.empty;

  if (flags.has('json')) {
    emitJSON({
      tool: 'tbd',
      binary: file,
      ok: true,
      notes: [
        ...notes,
        ...(hits.length ? [] : [`no exported name ${mode === 'exact' ? 'equals' : 'contains'} ${symbol} in this stub — a negative answer about the stub, not about the library at runtime`]),
      ],
      data: {
        query: symbol,
        mode,
        matchCount: hits.length,
        providers: libraries,
        providerCount: libraries.length,
        reexported: hits.every((h) => h.reexported),
        weak: hits.length > 0 && hits.every((h) => h.weak),
        hits,
      },
    }, status);
  }

  console.log(`${file}  —  ${stub.documentCount} librar${stub.documentCount === 1 ? 'y' : 'ies'}, ${count(stub.symbolCount)} symbol(s)`);
  if (!hits.length) {
    console.log(`\n  no exported name ${mode === 'exact' ? 'equals' : 'contains'} ${symbol}`);
  } else {
    console.log(`\n  ${symbol}  —  exported by ${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'}`);
    for (const h of hits.slice(0, max || 20)) {
      const tags = [h.reexported ? 're-exported' : h.weak ? 'weak' : h.threadLocal ? 'thread-local' : null].filter(Boolean);
      console.log(`    ${h.library}${tags.length ? `  (${tags.join(', ')})` : ''}${h.targets ? `\n      targets: ${h.targets.join(', ')}` : ''}`);
    }
    if (max && hits.length > max) console.log(`    ...and ${count(hits.length - max)} more (raise --max)`);
  }
  process.exit(status);
}

/* ---- listings ---- */

if (flags.has('symbols')) {
  const shown = max ? stub.symbols.slice(0, max) : stub.symbols;
  const status = stub.symbolCount ? EXIT.ok : EXIT.empty;

  if (flags.has('json')) {
    emitJSON({
      tool: 'tbd',
      binary: file,
      ok: true,
      notes: [...notes, ...(max && stub.symbolCount > max ? [`showing ${max} of ${stub.symbolCount}; the count is exact`] : [])],
      data: {
        symbolCount: stub.symbolCount,
        symbols: shown,
        truncated: max > 0 && stub.symbolCount > max,
        weakSymbols: stub.weakSymbols,
      },
    }, status);
  }

  console.log(`${file}  —  tbd v${stub.tbdVersion ?? stub.tbdVersions.join('/')}, ${stub.documentCount} librar${stub.documentCount === 1 ? 'y' : 'ies'}`);
  console.log(`  targets: ${stub.targets.join(', ') || '(none recorded)'}`);
  console.log(`\n  ${count(stub.symbolCount)} exported symbol(s)`);
  for (const s of shown) console.log(`    ${s}`);
  if (max && stub.symbolCount > max) console.log(`    ...and ${count(stub.symbolCount - max)} more (raise --max)`);
  process.exit(status);
}

if (flags.has('reexports')) {
  const libs = stub.reexportedLibraries;
  const syms = [...new Set(stub.libraries.flatMap((l) => l.reexportedSymbols))];
  const status = libs.length || syms.length ? EXIT.ok : EXIT.empty;

  if (flags.has('json')) {
    emitJSON({
      tool: 'tbd',
      binary: file,
      ok: true,
      notes,
      // `reexportedLibraries`, not `libraries`: the summary's `libraries` is a list
      // of library objects. One name, two types, found by the schema suite.
      data: { reexportedLibraries: libs, reexportedLibraryCount: libs.length, reexportedSymbols: syms, reexportedSymbolCount: syms.length },
    }, status);
  }

  console.log(`${file}  —  ${stub.documentCount} librar${stub.documentCount === 1 ? 'y' : 'ies'}`);
  console.log(`\n  re-exported libraries (${count(libs.length)}):`);
  for (const l of libs) console.log(`    ${l}`);
  if (syms.length) {
    console.log(`\n  re-exported symbols (${count(syms.length)}):`);
    for (const s of syms.slice(0, max || 30)) console.log(`    ${s}`);
    if (max && syms.length > max) console.log(`    ...and ${count(syms.length - max)} more (raise --max)`);
  }
  if (!libs.length && !syms.length) console.log(`\n  nothing is re-exported by this stub`);
  process.exit(status);
}

if (flags.has('objc')) {
  const classes = stub.objcClasses;
  const status = classes.length ? EXIT.ok : EXIT.empty;
  const ivars = [...new Set(stub.libraries.flatMap((l) => l.objcIvars))];
  const eh = [...new Set(stub.libraries.flatMap((l) => l.objcEhTypes))];

  if (flags.has('json')) {
    emitJSON({
      tool: 'tbd',
      binary: file,
      ok: true,
      notes: [
        ...notes,
        'class and ivar *names* only: the stub records which exist, and this reads no Objective-C metadata — so there is no type, no ivar offset and no method list',
      ],
      data: { classes, classCount: classes.length, ivars, ivarCount: ivars.length, ehTypes: eh, ehTypeCount: eh.length },
    }, status);
  }

  console.log(`${file}  —  ${stub.documentCount} librar${stub.documentCount === 1 ? 'y' : 'ies'}`);
  console.log(`\n  ${count(classes.length)} Objective-C class(es), ${count(ivars.length)} ivar(s)`);
  for (const c of classes.slice(0, max || 30)) console.log(`    ${c}`);
  if (max && classes.length > max) console.log(`    ...and ${count(classes.length - max)} more (raise --max)`);
  if (!classes.length) console.log(`\n  this stub declares no Objective-C classes`);
  process.exit(status);
}

/* ---- the default: describe the stub ---- */

{
  const status = stub.documentCount ? EXIT.ok : EXIT.empty;
  const withSymbols = stub.libraries.reduce(
    (a, l) => {
      for (const ex of l.exports) a.push(...ex.symbols);
      return a;
    },
    [],
  ).length;

  if (flags.has('json')) {
    emitJSON({
      tool: 'tbd',
      binary: file,
      ok: true,
      notes: [
        ...notes,
        ...(stub.documentCount > 1
          ? [`this file holds ${stub.documentCount} libraries, one per document — --symbol attributes a hit to the one that exports it, and a summary that flattened them would name only the first`]
          : []),
      ],
      data: {
        path: stub.path,
        size: stub.size,
        tbdVersion: stub.tbdVersion,
        tbdVersions: stub.tbdVersions,
        documentCount: stub.documentCount,
        targets: stub.targets,
        symbolCount: stub.symbolCount,
        objcClassCount: stub.objcClasses.length,
        weakSymbolCount: stub.weakSymbols.length,
        reexportedLibraryCount: stub.reexportedLibraries.length,
        libraries: stub.libraries.map((l) => ({
          index: l.index,
          installName: l.installName,
          targets: l.targets,
          currentVersion: l.currentVersion,
          compatibilityVersion: l.compatibilityVersion,
          swiftAbiVersion: l.swiftAbiVersion,
          flags: l.flags,
          symbolCount: l.exports.reduce((a, e) => a + e.symbols.length, 0),
          objcClassCount: l.objcClasses.length,
          reexportedLibraries: l.reexportedLibraries,
        })),
      },
    }, status);
  }

  console.log(`${file}  —  tbd v${stub.tbdVersion ?? stub.tbdVersions.join('/')}, ${stub.size} bytes`);
  console.log(`  targets: ${stub.targets.join(', ') || '(none recorded)'}`);
  console.log(`  ${stub.documentCount} librar${stub.documentCount === 1 ? 'y' : 'ies'}, ${count(stub.symbolCount)} distinct symbol(s), ${count(withSymbols)} export entries`);
  if (stub.documentCount > 1) {
    console.log(`\n  ${stub.documentCount} document(s) in this file — one per library:`);
    for (const l of stub.libraries) {
      const n = l.exports.reduce((a, e) => a + e.symbols.length, 0);
      console.log(`    ${String(n).padStart(6)}  ${l.installName ?? `(no install-name)`}${l.currentVersion ? `  ${l.currentVersion}` : ''}`);
    }
  } else {
    const l = stub.libraries[0];
    if (l) {
      console.log(`\n  ${l.installName ?? '(no install-name)'}`);
      if (l.currentVersion) console.log(`    current-version:     ${l.currentVersion}`);
      if (l.compatibilityVersion) console.log(`    compatibility:       ${l.compatibilityVersion}`);
      if (l.swiftAbiVersion) console.log(`    swift-abi-version:   ${l.swiftAbiVersion}`);
      if (l.flags.length) console.log(`    flags:               ${l.flags.join(', ')}`);
      if (l.parentUmbrella.length) console.log(`    parent umbrella:     ${l.parentUmbrella.join(', ')}`);
      if (l.allowableClients.length) console.log(`    allowable clients:   ${l.allowableClients.slice(0, 8).join(', ')}`);
    }
  }
  if (stub.objcClasses.length) console.log(`\n  ${count(stub.objcClasses.length)} Objective-C class(es)`);
  if (stub.reexportedLibraries.length) console.log(`  ${count(stub.reexportedLibraries.length)} re-exported librar${stub.reexportedLibraries.length === 1 ? 'y' : 'ies'}`);
  console.log(`\n  ask about a name:  macho-explorer tbd ${file} --symbol=_malloc`);
  console.log(`  or search an SDK:  macho-explorer tbd --symbol=_malloc --sdk=<SDK>/usr/lib`);
  process.exit(status);
}