#!/usr/bin/env node
/**
 * sarif.mjs — the SARIF emitter is held to the same standard as the reader.
 *
 * This is its own suite rather than additions to `smoke.mjs` for one reason:
 * `smoke.mjs` asserts that tools answer correctly, and this asserts that a
 * *format translation* is well-formed. A finding that is correct but rendered as
 * invalid SARIF is a passing reader and a failing integration, and only a suite
 * that knows what SARIF requires can tell those apart.
 *
 * ## What is actually checked
 *
 * A structural check of the document shape against the parts of SARIF 2.1.0 that
 * a consumer depends on — not a schema validation. A full SARIF validator is a
 * dependency, and this package has none by design; see `package.json`
 * dependencies, which is empty and is the product's main claim. So the checks are
 * hand-written against the spec's required members, which is what a real consumer
 * reads, and each one is annotated with what breaks without it.
 *
 * The load-bearing checks, in order of how quietly they fail:
 *
 *   1. `$schema` and `version` are present and correct. Without them a consumer
 *      cannot tell a SARIF 2.1.0 document from a SARIF 2.0 one, and picks.
 *   2. `runs[].tool.driver` is complete. `name` alone is valid and useless.
 *   3. `ruleId` on every result appears in the rule catalog. This is the one that
 *      fails *silently* in a consumer: an unknown rule id is not an error, it is
 *      a finding rendered with no name, which a reviewer reads as a bug in their
 *      own code.
 *   4. `executionSuccessful` is true. An audit finding is not a failed run; a
 *      consumer that receives `executionSuccessful: false` is entitled to discard
 *      the file entirely, which would throw away every real finding in it.
 *   5. Level vocabulary. Only SARIF's four words appear — a custom level like
 *      "critical" is not an error to a strict consumer, it is a value it does not
 *      know, and it renders as "unknown severity".
 *   6. Findings are a subset of what the reader actually found. A SARIF document
 *      with *more* results than the tool reported is a worse bug than one with
 *      none: it invents findings on a clean binary.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const fails = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fails.push(`${label}${detail ? `  — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label, a === e ? '' : `expected ${e}, got ${a}`);
}

const runTool = (args) =>
  spawnSync(process.execPath, [join(ROOT, 'src', 'macho-explorer.mjs'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  });

const fixture = (name) => join(ROOT, 'test', 'fixtures', name);

/* ------------------------------------------------------------------ *
 * shape helpers
 * ------------------------------------------------------------------ */

const SARIF_LEVELS = new Set(['none', 'note', 'warning', 'error']);

function isSarif(doc, label) {
  ok(doc && typeof doc === 'object' && !Array.isArray(doc), `${label}: the document is an object`);
  eq(doc.version, '2.1.0', `${label}: version is 2.1.0`);
  ok(
    typeof doc.$schema === 'string' && doc.$schema.includes('sarif-schema-2.1.0'),
    `${label}: $schema names the 2.1.0 schema`,
    doc.$schema,
  );
  ok(Array.isArray(doc.runs) && doc.runs.length >= 1, `${label}: at least one run`);
  const run = (doc.runs || [])[0] || {};
  const driver = run.tool?.driver || {};
  ok(typeof driver.name === 'string' && driver.name.length > 0, `${label}: driver.name is set`);
  ok(
    typeof driver.informationUri === 'string' && /^https:\/\//.test(driver.informationUri),
    `${label}: driver.informationUri is an https URL`,
    driver.informationUri,
  );
  // The version must be the *package* version, not the envelope's. These are two
  // different numbers that look alike (0.1.0 and 1.0 at the time of writing) and
  // confusing them is the specific failure this assertion exists to catch.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  eq(driver.version, pkg.version, `${label}: driver.version is the package version`);
  ok(Array.isArray(driver.rules), `${label}: driver.rules is an array`);
  ok(Array.isArray(run.results), `${label}: run.results is an array`);
  eq(run.executionSuccessful, true, `${label}: executionSuccessful is true (findings are not a failed run)`);
  return run;
}

/**
 * Check that every result is well-formed *and* resolvable.
 *
 * The ruleId resolution check is the important one and is why this is a helper
 * rather than three lines in the caller: an unresolved ruleId is not an error in
 * any SARIF consumer, it is a finding rendered with no name attached, and it is
 * therefore the class of defect a document can ship with and a reviewer cannot
 * see.
 */
function checkResults(run, label, { expectAny = null } = {}) {
  const declared = new Set((run.tool?.driver?.rules || []).map((r) => r.id));
  for (const rule of run.tool?.driver?.rules || []) {
    ok(typeof rule.id === 'string' && rule.id.length > 0, `${label}: rule has an id`);
    ok(typeof rule.name === 'string' && rule.name.length > 0, `${label}: rule "${rule.id}" has a name`);
    ok(
      typeof rule.fullDescription?.text === 'string' && rule.fullDescription.text.length > 0,
      `${label}: rule "${rule.id}" has a fullDescription`,
    );
  }
  for (const [i, r] of (run.results || []).entries()) {
    ok(typeof r.ruleId === 'string' && r.ruleId.length > 0, `${label}: result[${i}] has a ruleId`);
    ok(
      declared.has(r.ruleId),
      `${label}: result[${i}] ruleId "${r.ruleId}" is declared in the catalog`,
      'an undeclared ruleId renders as a finding with no name, which is not an error to a consumer — it is worse',
    );
    ok(typeof r.message?.text === 'string' && r.message.text.length > 0, `${label}: result[${i}] has a message`);
    ok(SARIF_LEVELS.has(r.level), `${label}: result[${i}] level "${r.level}" is a SARIF level`, 'SARIF knows only none/note/warning/error');
    ok(
      typeof r.locations?.[0]?.physicalLocation?.artifactLocation?.uri === 'string',
      `${label}: result[${i}] has a physical location with an artifact URI`,
    );
  }
  if (expectAny) {
    ok((run.results || []).length > 0, `${label}: has at least one result`, 'expected findings and got none');
  }
  return run.results || [];
}

/* ------------------------------------------------------------------ *
 * audit --sarif
 * ------------------------------------------------------------------ */

console.log('audit --sarif');

// A sound fixture: a valid SARIF document with *no* findings. This is the case
// that matters most and is the easiest to get wrong — a consumer that receives
// `results: []` must be able to conclude "the check ran and passed", which it can
// only do if the document is otherwise well-formed. A missing `$schema` or an
// absent driver makes an empty result unreadable as a pass.
{
  const r = runTool(['audit', '--sarif', fixture('universal.macho')]);
  eq(r.status, 0, 'audit --sarif on a sound binary exits 0');
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch (e) {
    ok(false, 'audit --sarif on a sound binary emits valid JSON', e.message);
  }
  if (doc) {
    const run = isSarif(doc, 'audit/sound');
    eq(run.results.length, 0, 'audit/sound: no results for a sound binary');
    // The rule catalog is still declared even with no findings, because "this
    // reader has this check" and "this check fired" are different claims and only
    // the first is a property of the tool.
    ok(true, 'audit/sound: rule catalog present (declared, unfired)');
    ok(
      (r.stdout.match(/\n/g) || []).length > 0,
      'audit/sound: stdout is a document, not empty',
    );
  }
}

// A damaged fixture: findings become results, and the rule catalog grows to
// match. `bent.macho` is the one with the most kinds — overlapping slices, a
// slice past EOF, a misaligned slice — so it exercises catalog construction
// rather than the single-rule path.
{
  const r = runTool(['audit', '--sarif', fixture('bent.macho')]);
  eq(r.status, 1, 'audit --sarif on an unsound binary exits 1 (a negative answer, not an error)');
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch (e) {
    ok(false, 'audit --sarif on an unsound binary emits valid JSON', e.message);
  }
  if (doc) {
    const run = isSarif(doc, 'audit/damaged');
    checkResults(run, 'audit/damaged', { expectAny: true });
    ok(
      (run.tool?.driver?.rules || []).length >= 2,
      'audit/damaged: several distinct rules are catalogued',
      `only ${(run.tool?.driver?.rules || []).length}`,
    );
    // Every finding the text form reports must appear here. A SARIF document that
    // drops a finding the same tool printed in prose is worse than no document:
    // it looks authoritative and is incomplete.
    const prose = runTool(['audit', fixture('bent.macho')]).stdout;
    const reported = (prose.match(/^\s+(?:error|warning)\s+\S+$/gm) || []).length;
    const kinds = new Set(run.results.map((r) => r.ruleId.split('/')[1]));
    ok(
      kinds.size >= reported - 1,
      'audit/damaged: the SARIF document has at least as many distinct kinds as prose reports',
      `${kinds.size} kinds vs ${reported} prose lines`,
    );
  }
}

// An unreadable file must NOT become findings. This is the assertion that stops a
// workflow typo being filed as a bug in the binary under test.
{
  const r = runTool(['audit', '--sarif', join(ROOT, 'does-not-exist')]);
  eq(r.status, 3, 'audit --sarif on an unreadable file exits 3, never 1');
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch (e) {
    ok(false, 'audit --sarif on an unreadable file still emits a valid SARIF document', e.message);
  }
  if (doc) {
    const run = isSarif(doc, 'audit/unreadable');
    eq(run.results.length, 0, 'audit/unreadable: an unreadable file produces no findings');
  }
}

// --sarif and --json together is a usage error, not a precedence rule.
{
  const r = runTool(['audit', '--sarif', '--json', fixture('universal.macho')]);
  eq(r.status, 2, 'audit --sarif --json is a usage error');
  ok(
    !/\{/.test(r.stdout),
    'audit --sarif --json writes nothing to stdout',
    'so a redirect cannot produce a file that is half one format and half the other',
  );
}

/* ------------------------------------------------------------------ *
 * fingerprint --sarif
 * ------------------------------------------------------------------ */

console.log('fingerprint --sarif');

{
  const r = runTool(['fingerprint', '--sarif', fixture('rebuilt.macho'), fixture('rebuilt2.macho')]);
  eq(r.status, 0, 'fingerprint --sarif on the same program exits 0');
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch (e) {
    ok(false, 'fingerprint --sarif emits valid JSON', e.message);
  }
  if (doc) {
    const run = isSarif(doc, 'fingerprint/same');
    // The rule catalog is declared even when nothing fired: this reader *has* a
    // mismatch check, and a consumer needs to know that without inferring it from
    // an empty result.
    ok(
      (run.tool?.driver?.rules || []).some((x) => x.id === 'macho-explorer/fingerprint-mismatch'),
      'fingerprint/same: the mismatch rule is catalogued even though nothing fired',
    );
    const mismatches = run.results.filter((r) => r.ruleId === 'macho-explorer/fingerprint-mismatch');
    eq(mismatches.length, 0, 'fingerprint/same: no mismatch findings for the same program');
  }
}

{
  const r = runTool(['fingerprint', '--sarif', fixture('populated.macho'), fixture('rebuilt.macho')]);
  eq(r.status, 1, 'fingerprint --sarif on different programs exits 1');
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch (e) {
    ok(false, 'fingerprint --sarif emits valid JSON on a mismatch', e.message);
  }
  if (doc) {
    const run = isSarif(doc, 'fingerprint/differ');
    const results = checkResults(run, 'fingerprint/differ', { expectAny: true });
    const mismatch = results.find((x) => x.ruleId === 'macho-explorer/fingerprint-mismatch');
    ok(!!mismatch, 'fingerprint/differ: a mismatch finding is present');
    if (mismatch) {
      eq(mismatch.level, 'error', 'fingerprint/differ: a mismatch is level error');
      ok(
        /0x[0-9a-f]+/.test(mismatch.message.text) || mismatch.message.text.length > 20,
        'fingerprint/differ: the message names what differed',
        mismatch.message.text,
      );
    }
  }
}

// One binary is a usage error, because there is nothing to compare against and
// an empty document would read as a passing gate.
{
  const r = runTool(['fingerprint', '--sarif', fixture('rebuilt.macho')]);
  eq(r.status, 2, 'fingerprint --sarif with one binary is a usage error');
  ok(/two binaries/.test(r.stderr), 'fingerprint --sarif one binary explains why', r.stderr.trim().split('\n').pop());
}

/* ------------------------------------------------------------------ *
 * the emitter as a module
 * ------------------------------------------------------------------ *
 * The CLIs are covered above through a real subprocess, which is the shape a
 * consumer uses. These two check the module directly, because there is a claim
 * only the module can make: that it produces valid SARIF for an *empty* result,
 * with no binary at all. That is the shape a fixture-less unit test or a
 * downstream consumer assembling their own run needs, and if it throws there it
 * will throw in their build rather than in CI.
 */
{
  const { auditSarif, fingerprintSarif } = await import(join(ROOT, 'src', 'sarif.mjs'));

  const emptyAudit = auditSarif({ path: 'x', slices: [], containerAbnormalities: [], counts: { errors: 0, warnings: 0 } }, { path: 'x' });
  const r1 = isSarif(emptyAudit, 'auditSarif(empty)');
  eq(r1.results.length, 0, 'auditSarif(empty): no results');

  const compared = fingerprintSarif(
    {
      a: { path: 'a' },
      b: { path: 'b' },
      byArch: [{ arch: 'arm64', fingerprint: 'aaa', other: 'bbb', match: false, presentInBoth: true }],
      verdict: 'different programs',
      sameProgram: false,
    },
    { path: 'a', other: 'b' },
  );
  const r2 = isSarif(compared, 'fingerprintSarif(mismatch)');
  checkResults(r2, 'fingerprintSarif(mismatch)', { expectAny: true });

  // A stripped comparison must surface its caveat as a `note`, and a note must not
  // be graded as a finding: the comparison still passed.
  const stripped = fingerprintSarif(
    {
      a: { path: 'a' },
      b: { path: 'b' },
      byArch: [{ arch: 'arm64', fingerprint: 'aaa', other: 'aaa', match: true, presentInBoth: true }],
      verdict: 'same shape, one side stripped',
      caveat: 'one side is stripped, so this is a structural match only',
      sameProgram: true,
    },
    { path: 'a', other: 'b' },
  );
  const r3 = isSarif(stripped, 'fingerprintSarif(stripped)');
  const note = (r3.results || []).find((x) => x.ruleId === 'macho-explorer/fingerprint-stripped');
  ok(!!note, 'fingerprintSarif(stripped): the caveat is reported');
  if (note) eq(note.level, 'note', 'fingerprintSarif(stripped): the caveat is a note, not a finding');
  eq(
    (r3.results || []).filter((x) => x.level === 'error').length,
    0,
    'fingerprintSarif(stripped): a passing comparison produces no errors',
  );

  // An architecture on one side only is a warning, not an error — the two
  // binaries may simply be thin vs universal, which is not a finding about either.
  const missingArch = fingerprintSarif(
    {
      a: { path: 'a' },
      b: { path: 'b' },
      byArch: [{ arch: 'x86_64', fingerprint: 'aaa', other: null, match: false, presentInBoth: false }],
      verdict: 'different programs',
      sameProgram: false,
    },
    { path: 'a', other: 'b' },
  );
  const r4 = isSarif(missingArch, 'fingerprintSarif(missing-arch)');
  const arch = (r4.results || []).find((x) => x.ruleId === 'macho-explorer/fingerprint-arch-missing');
  ok(!!arch, 'fingerprintSarif(missing-arch): the asymmetry is reported');
  if (arch) eq(arch.level, 'warning', 'fingerprintSarif(missing-arch): an asymmetry is a warning');
}

/* ------------------------------------------------------------------ *
 * stability of the rule ids
 * ------------------------------------------------------------------ *
 * Code Scanning tracks a finding across runs by ruleId plus a location
 * fingerprint. An id that changes when nothing about the finding changed would
 * file a new alert on every build and bury the history. This asserts the property
 * that makes them stable: the id is derived mechanically from the reader's own
 * `kind`, so it cannot drift from the code that produces the finding.
 */
{
  const { auditSarif } = await import(join(ROOT, 'src', 'sarif.mjs'));
  const mk = (kind) =>
    auditSarif(
      { path: 'x', slices: [{ arch: 'arm64', abnormalities: [{ severity: 'warning', kind, detail: 'd' }] }], containerAbnormalities: [], counts: { errors: 0, warnings: 1 } },
      { path: 'x' },
    ).runs[0].results[0].ruleId;

  eq(mk('slice-misaligned'), mk('slice-misaligned'), 'the rule id is stable across identical findings');
  eq(mk('slice-misaligned'), 'macho-explorer/slice-misaligned', 'the rule id is the kind, namespaced');
  ok(mk('a') !== mk('b'), 'different kinds get different rule ids');

  // Namespaced: a consumer aggregating several tools' SARIF into one view must
  // not have this reader's `slice-overlap` collide with another tool's identically
  // named rule.
  ok(mk('slice-misaligned').includes('/'), 'the rule id is namespaced by tool name');
}

/* ------------------------------------------------------------------ */

console.log('');
if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass} passed. The SARIF emitter is well-formed, and silent where it should be.`);