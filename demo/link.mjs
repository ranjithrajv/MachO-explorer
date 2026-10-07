#!/usr/bin/env node
/**
 * link.mjs — build the browser bundle for the auditability demo.
 *
 *   node demo/link.mjs            # write demo/macho.browser.mjs
 *   node demo/link.mjs --check    # verify the committed bundle matches, write nothing
 *
 * ## Why a linker and not a copy
 *
 * The demo's whole claim is that the reader you audit is the reader that runs in
 * the browser. A hand-maintained browser copy would falsify that claim the first
 * time anyone edited `src/macho.mjs`, and a copy is exactly the "second reader"
 * this project spent its history deleting. So this file does the least it can:
 * it strips the module boundaries (`import`/`export`) from the three source
 * modules, prepends the host shim (`demo/runtime.mjs`), and emits one module.
 *
 * It is a **mechanical** transform. It renames nothing, reorders nothing inside a
 * module, and changes no expression. `test/browser.mjs` is the proof: it loads
 * the generated bundle and requires byte-for-byte the same `describe` and
 * `overview` answers as the Node build on all 22 fixtures, so a transform that
 * silently altered behaviour would fail rather than ship.
 *
 * ## Why `--check`
 *
 * A generated file that is committed can go stale, and a stale bundle is a demo
 * that lies about the source it claims to run. `--check` re-derives the bundle
 * and fails if the checked-in copy differs — the same discipline
 * `test/fixtures.mjs --check` applies to the binary corpus, applied to the one
 * other generated artefact in this repository.
 *
 * The generated bundle is committed so the demo needs no build step to run: open
 * the page and it works. `--check` is what keeps "no build step" from becoming
 * "no relationship to the source".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'macho.browser.mjs');

/** The modules, in dependency order: shims, then reader, then the API over it. */
const MODULES = [
  { file: 'demo/runtime.mjs', label: 'the host shim (Buffer, node:fs, node:crypto, node:path)' },
  // Before `api.mjs`, which imports it — the bundler concatenates in this order, so a
  // module has to precede the one that binds its names. Missing it produced a bundle
  // that loaded and then threw `ReferenceError: NOT_READ is not defined` on first use,
  // which is the worst shape of failure: it passes a syntax check and fails silently
  // until an answer is actually requested.
  { file: 'src/notread.mjs', label: 'the omissions list every answer carries' },
  // Before `api.mjs`, which binds `parseCrash` from it. A module the bundle omits
  // is not a load error — the name is simply undefined until the code path that
  // uses it runs, so a missing `crash.mjs` would surface as a crash in the browser
  // when someone symbolicated a report, and nowhere else.
  { file: 'src/crash.mjs', label: 'crash-report parsing, both the .ips and legacy shapes' },
  // Same rule, same reason: `api.mjs` binds `containerMessage` from this, and a
  // bundle without it still *loads* — the missing name only surfaces when someone
  // hands the reader an `.ipa` or a `.dmg`, which is exactly the moment the message
  // matters. A check that only asks "does it import?" cannot see that.
  { file: 'src/container.mjs', label: 'what a user hands you versus what the reader parses' },
  { file: 'src/macho.mjs', label: 'the reader — fat headers, load commands, symbols, mapping' },
  { file: 'src/instruction.mjs', label: 'instruction lengths and direct branch edges' },
  { file: 'src/api.mjs', label: 'the supported programmatic interface' },
];

/**
 * The public surface of the bundle.
 *
 * Every name here exists in one of the three modules (asserted by loading the
 * bundle in `test/browser.mjs`); listing them explicitly rather than `export *`
 * keeps the demo's surface the same deliberate thing the package's is.
 */
const EXPORTS = [
  'memoryFs', 'ByteBuffer', 'Buffer', 'sha256', 'createHash',
  // api.mjs
  'describe', 'overview', 'searchSymbols', 'findLiteral', 'findStrings', 'mapLiteral',
  'addressToOffset', 'offsetToAddress', 'lookupAddress', 'findCalls', 'listCallTargets',
  'audit', 'fingerprint', 'compareFingerprints', 'diffBinaries', 'coversAddress', 'withFile',
  // macho.mjs
  'isMachOFile', 'sliceName', 'sliceArchName', 'textSection', 'codeSections', 'sectionOf',
  'toVaddr', 'toFileOffset', 'loadCommandName', 'decodeFiletype', 'decodePlatform',
  'decodeHeaderFlags', 'decodeSectionFlags', 'decodeSourceVersion', 'decodePackedVersion',
  'filetypeKey', 'detectAbnormalities', 'detectContainerAbnormalities', 'resolveEntryPoint',
  'sliceShape', 'fileShape', 'digestOf', 'slicesOf', 'parseFat', 'parseThin', 'readSymbols',
  'richestSlice', 'preferredSlice', 'archMatches', 'isBackedByFile', 'shannonEntropy', 'findInSection',
];

/**
 * Strip a module's `import` and `export` syntax so its body can share one scope.
 *
 * Three substitutions, each anchored so it cannot touch prose or a string:
 *   1. `import ... from '...';`      removed — the shim or an earlier module
 *                                     already binds every imported name.
 *   2. `export { ... };`             removed — re-exported at the end instead.
 *   3. `export function|const|class` de-exported — the declaration stays, the
 *                                     keyword goes.
 */
function stripModuleBoundaries(source) {
  return source
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];[ \t]*\r?\n/gm, '')
    .replace(/^export\s*\{[\s\S]*?\}(?:\s*from\s*['"][^'"]+['"])?;[ \t]*\r?\n/gm, '')
    .replace(/^export\s+(async\s+function|function|const|let|var|class)\b/gm, '$1');
}

/** The banner that tells a reader of the generated file where it came from. */
const BANNER = `/**
 * macho.browser.mjs — GENERATED. Do not edit; edit the sources and re-link.
 *
 *   node demo/link.mjs
 *
 * This is the real reader — \`src/macho.mjs\`, \`src/instruction.mjs\` and
 * \`src/api.mjs\` — with their module boundaries removed and \`demo/runtime.mjs\`
 * prepended so they run in a browser with no Node and no network. The reader
 * logic is unchanged: \`test/browser.mjs\` requires this bundle to produce the
 * same answers as the Node build on every fixture in the corpus.
 *
 * Sources, in order:
${MODULES.map((m) => ` *   - ${m.file} — ${m.label}`).join('\n')}
 */

`;

/** Build the bundle text from the current sources. */
export function build() {
  const parts = [BANNER];
  for (const { file } of MODULES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    parts.push(`/* ${'='.repeat(66)} *\n * ${file}\n * ${'='.repeat(66)} */\n\n`);
    parts.push(stripModuleBoundaries(source));
    parts.push('\n');
  }
  parts.push(`/* ${'='.repeat(66)} *\n * public surface\n * ${'='.repeat(66)} */\n\n`);
  parts.push(`export {\n  ${EXPORTS.join(', ')}\n};\n`);
  return parts.join('');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

// Only when run directly. `test/browser.mjs` imports `build()` from this file,
// and an import that rewrote the bundle would make that suite's drift check read
// the file it had just regenerated — a check that cannot fail, which is the exact
// defect the rest of this project treats as worse than no check.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const check = process.argv.includes('--check');
  const generated = build();

  if (check) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
    if (existing === generated) {
      console.log('link: demo/macho.browser.mjs matches the sources.');
      process.exit(0);
    }
    console.error('link: demo/macho.browser.mjs is stale or missing.');
    // Derived from MODULES rather than restated. This was a hand-written sentence
    // naming four modules, and it went stale the moment a fifth was added — a
    // diagnostic that lists the wrong inputs is worse than one that lists none,
    // because it sends the reader to check files that are not involved.
    console.error(`      The bundle is generated from ${MODULES.map((m) => m.file).join(', ')}.`);
    console.error('      Re-run: node demo/link.mjs');
    process.exit(1);
  }

  fs.writeFileSync(OUT, generated);
  console.log(`link: wrote demo/macho.browser.mjs (${generated.length} bytes) from ${MODULES.length} modules.`);
}
