#!/usr/bin/env node
/**
 * action.mjs — the composite GitHub Action is exercised the only way it can be.
 *
 * ## Why this file exists at all
 *
 * A composite action's steps are shell scripts. Nothing type-checks them, nothing
 * lints them, and `action.yml` parses as valid YAML whether the shell inside it is
 * correct or not. A GitHub-hosted runner is the only thing that would catch
 * `${ARCH:+--arch="$ARCH"}` being wrong — and by then the action has been merged,
 * and the failure is a red X on someone else's pull request.
 *
 * So the steps are *extracted from the action file* and run here. Not copied:
 * extracted. A copy is a second version that drifts, and a drifted copy of a CI
 * gate is worse than no test, because it reports green for a script nobody is
 * running.
 *
 * ## What it deliberately does not do
 *
 * It does not run `upload-sarif`. That step needs a GitHub API token and a
 * workflow context, and the part that can be wrong — the shell before it, and the
 * SARIF file it points at — is covered here. Asserting on a mock upload would test
 * the mock.
 *
 * ## The load-bearing checks
 *
 * 1. The action file parses and declares the inputs and outputs the steps read.
 *    A step reading `${{ inputs.something }}` that no input declares renders as
 *    the empty string, which looks like a user error rather than a typo here.
 * 2. Every `env:` block that a `run:` script reads is declared *in that step*.
 *    GitHub does not fail on an unset variable; `$BIN` becomes empty and the
 *    reader is called with no binary, which exits 2 or falls back to a default.
 * 3. The audit step reproduces the reader's real exit codes, including the one
 *    that separates "unsound" from "could not read".
 * 4. A path with a space survives. This is not hypothetical: `${{ inputs.binary }}`
 *    interpolated into a shell line splits, and the audit then reads the wrong
 *    file and reports on it. The suite has always had a spaced-path fixture for the
 *    CLI; this asserts the *action* does not undo that.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const fails = [];
const ok = (cond, label, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fails.push(`${label}${detail ? `  — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, a === b ? '' : `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ------------------------------------------------------------------ *
 * extract the shell out of action.yml
 * ------------------------------------------------------------------ */

/**
 * A deliberately small reader for the one shape this file needs: a `run: |`
 * block under a step, and that step's `env:` keys.
 *
 * A YAML dependency is the alternative and this package has none, which is the
 * product's central claim. The block being extracted is a literal scalar with
 * uniform indentation, so this is enough — and if the action is ever restructured
 * to something this cannot read, the extraction below returns nothing and the
 * first assertion fails, which is the correct outcome rather than a silent skip.
 */
function parseAction(src) {
  const lines = src.split('\n');
  const steps = [];
  let cur = null;
  let inRun = false;
  let runIndent = 0;
  let inEnv = false;
  let envIndent = 0;
  const env = {};

  for (const line of lines) {
    const mStep = /^ {4}- (?:name|uses):\s*(.+)$/.exec(line);
    if (mStep) {
      if (cur) steps.push(cur);
      const isUses = /- uses:/.test(line);
      cur = { name: isUses ? mStep[1].trim() : mStep[1].trim(), uses: isUses ? mStep[1].trim() : null, run: '', env: {} };
      inRun = false;
      inEnv = false;
      continue;
    }
    if (!cur) continue;

    const mName = /^ {6}name:\s*(.+)$/.exec(line);
    if (mName && !inRun) {
      cur.name = mName[1].trim();
      continue;
    }
    const mUse = /^ {6}uses:\s*(.+)$/.exec(line);
    if (mUse) {
      cur.uses = mUse[1].trim();
      continue;
    }
    const mEnv = /^ {6}env:\s*$/.exec(line);
    if (mEnv && !inRun) {
      inEnv = true;
      envIndent = 8;
      continue;
    }
    if (inEnv && !inRun) {
      const mEnvKey = /^ {8}([A-Z_][A-Z0-9_]*):/.exec(line);
      if (mEnvKey) {
        cur.env[mEnvKey[1]] = true;
        continue;
      }
      if (/^ {6}\S/.test(line)) inEnv = false; // left the env block
    }
    const mRun = /^ {6}run: \|\s*$/.exec(line);
    if (mRun) {
      inRun = true;
      runIndent = 8;
      continue;
    }
    if (inRun) {
      const indent = line.match(/^ */)[0].length;
      if (line.trim() !== '' && indent < runIndent) {
        inRun = false;
        continue;
      }
      cur.run += line.slice(runIndent) + '\n';
    }
  }
  if (cur) steps.push(cur);
  return steps;
}

/** Declared inputs, from `inputs:` up to `outputs:`. */
function declaredInputs(src) {
  const body = src.split(/\noutputs:/)[0].split(/\ninputs:/)[1] || '';
  return new Set([...body.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]));
}

const actionSrc = readFileSync(join(ROOT, 'action.yml'), 'utf8');
const steps = parseAction(actionSrc);
const inputs = declaredInputs(actionSrc);

/* ------------------------------------------------------------------ *
 * the file itself
 * ------------------------------------------------------------------ */

console.log('action.yml');

ok(/using:\s*composite/.test(actionSrc), 'the action is composite');
ok(steps.length >= 4, `the action has steps (found ${steps.length})`, steps.map((s) => s.name).join(', '));
eq([...inputs].sort(), ['arch', 'baseline', 'binary', 'sarif', 'strict'], 'the declared inputs are the ones the steps read');

// Every `${{ inputs.X }}` must name a declared input. An undeclared one renders
// as the empty string, which is indistinguishable from a user passing nothing.
for (const m of actionSrc.matchAll(/\$\{\{\s*inputs\.([a-z_]+)\s*\}\}/g)) {
  ok(inputs.has(m[1]), `inputs.${m[1]} is declared`);
}

// A step that reads a variable in its `run:` must declare it. This is the check
// that would have caught the first draft of this action, which read $BIN and
// $ARCH without putting either in `env:` — GitHub does not error on that, it
// passes an empty string, and the reader is then called with no binary.
const BUILTIN = new Set(['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY', 'RUNNER_OS', 'HOME', 'PWD', 'PATH']);
for (const s of steps) {
  if (!s.run) continue;
  const declared = new Set([...Object.keys(s.env), ...BUILTIN]);
  // `$FOO` used as a whole word, not `${FOO}` inside a string and not `$FOOBAR`.
  for (const m of s.run.matchAll(/\$([A-Z_][A-Z0-9_]*)\b/g)) {
    ok(declared.has(m[1]), `step "${s.name}" declares $${m[1]} before using it`, 'an undeclared variable becomes an empty string in a composite step');
  }
}

// The SARIF report must be uploaded on `always()`, or it is produced exactly when
// there is nothing to report.
const upload = steps.find((s) => s.uses?.includes('upload-sarif'));
ok(!!upload, 'there is an upload-sarif step');
if (upload) {
  const idx = steps.indexOf(upload);
  const later = steps.slice(idx + 1);
  // The `if:` lives on the sibling step or the uses step itself; assert the
  // upload is not gated on success() being false, which is the failure mode.
  const guardedBySuccess = /if:.*success\(\)/.test(actionSrc);
  ok(!guardedBySuccess || /always\(\)/.test(actionSrc), 'the upload is not gated behind success() alone');
}

// No `npm install` / `npm ci`. The whole premise of the action is that there is
// nothing to install, and a well-meaning "let's pin the version" edit would
// reintroduce the failure mode the action exists to avoid.
//
// Comments are stripped first, and that detail is the whole reason this check is
// written the way it is: the file's own header explains *why* it does not install
// by naming the command it is declining to run, so a check over the raw text
// fails on the explanation. A check that reads the documentation as though it were
// code is worse than no check — it reports a problem that is not there, and the
// fix for that "problem" is to delete the explanation.
const codeOnly = actionSrc
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
ok(!/\bnpm\s+(install|ci|add)\b/.test(codeOnly), 'the action does not run npm install or npm ci', 'a network fetch of a moving tag would make the gate test something other than this commit');

// And the reason it must not is actually stated somewhere, so the next person to
// consider adding one finds the argument rather than rediscovering the bug.
ok(/npm install/.test(actionSrc), 'the action explains why it does not install from npm');

/* ------------------------------------------------------------------ *
 * running the steps for real
 * ------------------------------------------------------------------ */

console.log('');
console.log('the audit step, extracted and run');

const auditStep = steps.find((s) => s.name?.startsWith('Audit'));
ok(!!auditStep, 'the audit step was extracted');
if (!auditStep) {
  console.log('');
  console.log(`${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}

/** Run one extracted step with a given environment, return {code, stdout, stderr}. */
function runStep(step, env, cwd = ROOT) {
  // The scratch directory is *not* `.tmp-action-test`, and that separation is
  // load-bearing rather than tidy. One of the checks below puts a binary named
  // "a binary with spaces.macho" into `.tmp-action-test` and then calls this; a
  // shared scratch dir would delete the fixture before the step ran, and the
  // assertion would fail for the uninteresting reason that the file was missing
  // rather than for the reason it exists — which is that a spaced path must
  // survive `${{ inputs.binary }}` threading.
  const dir = mkdtemp();
  const outFile = join(dir, 'gh_output');
  writeFileSync(outFile, '');
  const r = spawnSync('bash', ['-c', step.run], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env, GITHUB_OUTPUT: outFile },
  });
  // Read the outputs file *before* removing the scratch directory. Doing it in
  // the other order is a race with the filesystem rather than a logic error, and
  // it fails with ENOENT on a scratch dir that was cleaned up by something else —
  // a message that names neither this assertion nor the step it was checking.
  const outputs = readFileSync(outFile, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    outputs,
  };
}

function mkdtemp() {
  const d = join(ROOT, '.tmp-action-scratch');
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

const fixture = (n) => join(ROOT, 'test', 'fixtures', n);

// The unsound case: exit 1, findings present, outputs populated.
{
  const r = runStep(auditStep, { BIN: fixture('bent.macho'), ARCH: '', STRICT: 'false', WANT_SARIF: 'true' });
  eq(r.code, 1, 'an unsound binary fails the step with exit 1');
  ok(/verdict=failed/.test(r.outputs), 'the verdict output is set', JSON.stringify(r.outputs));
  ok(/errors=2/.test(r.outputs), 'the error count output is set', JSON.stringify(r.outputs));
  ok(/wrote macho-audit.sarif/.test(r.stdout + r.stderr), 'the SARIF report was written');
  const sarifPath = join(ROOT, 'macho-audit.sarif');
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(sarifPath, 'utf8'));
  } catch (e) {
    ok(false, 'the SARIF report parses', e.message);
  }
  if (doc) ok(doc.runs[0].results.length > 0, 'the SARIF report carries the findings');
  rmSync(sarifPath, { force: true });
}

// The sound case: exit 0, and a SARIF file that exists with zero results. This is
// the one that keeps a green run from looking like a broken integration.
{
  const r = runStep(auditStep, { BIN: fixture('universal.macho'), ARCH: '', STRICT: 'false', WANT_SARIF: 'true' });
  eq(r.code, 0, 'a sound binary passes with exit 0');
  ok(/verdict=ok/.test(r.outputs), 'the verdict is ok', JSON.stringify(r.outputs));
  const sarifPath = join(ROOT, 'macho-audit.sarif');
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(sarifPath, 'utf8'));
  } catch (e) {
    ok(false, 'a passing run still writes a parseable SARIF report', e.message);
  }
  if (doc) {
    eq(doc.runs[0].results.length, 0, 'a sound binary produces zero findings');
    ok(doc.runs[0].tool.driver.rules.length >= 0, 'the rule catalog is still declared');
  }
  rmSync(sarifPath, { force: true });
}

// Exit 3 — the file could not be read. This must be *named*, because it is a
// workflow bug and reporting it as "the binary is damaged" sends the next person
// to the wrong place.
{
  const r = runStep(auditStep, { BIN: join(ROOT, 'no-such-binary'), ARCH: '', STRICT: 'false', WANT_SARIF: 'false' });
  eq(r.code, 3, 'an unreadable binary exits 3');
  ok(/::error::/.test(r.stdout + r.stderr), 'an unreadable binary is reported as an error annotation');
  ok(
    /not a finding about the binary/.test(r.stdout + r.stderr),
    'the message distinguishes a workflow bug from a finding',
  );
}

// --strict is threaded through as a flag, not a word-split accident.
{
  const r = runStep(auditStep, { BIN: fixture('bent.macho'), ARCH: '', STRICT: 'true', WANT_SARIF: 'false' });
  ok(r.code !== 0, '--strict does not turn an unsound binary green');
}

// A path with a space. This is the assertion that the env-threading works: a
// `${{ inputs.binary }}` interpolated into the run: block would be split here and
// the reader would be handed the wrong path.
{
  const spaced = join(ROOT, '.tmp-action-test', 'a binary with spaces.macho');
  mkdirSync(dirname(spaced), { recursive: true });
  writeFileSync(spaced, readFileSync(fixture('bent.macho')));
  const r = runStep(auditStep, { BIN: spaced, ARCH: '', STRICT: 'false', WANT_SARIF: 'false' });
  eq(r.code, 1, 'a binary path containing spaces is read correctly, not split');
  rmSync(join(ROOT, '.tmp-action-test'), { recursive: true, force: true });
}

// The fingerprint step.
console.log('');
console.log('the fingerprint step, extracted and run');

const fpStep = steps.find((s) => s.name?.startsWith('Compare against'));
ok(!!fpStep, 'the fingerprint step was extracted');
if (fpStep) {
  const base = { BIN: '', BASE: '', ARCH: '' };
  const same = runStep(fpStep, { ...base, BIN: fixture('rebuilt.macho'), BASE: fixture('rebuilt2.macho') });
  eq(same.code, 0, 'the same program passes');
  ok(/same-program=true/.test(same.outputs), 'the same-program output is set', JSON.stringify(same.outputs));

  const diff = runStep(fpStep, { ...base, BIN: fixture('populated.macho'), BASE: fixture('rebuilt.macho') });
  eq(diff.code, 1, 'a different program fails the step');
  ok(/::error::/.test(diff.stdout + diff.stderr), 'a mismatch is reported as an error annotation');
  ok(/not the same program/.test(diff.stdout + diff.stderr), 'the mismatch message names the problem');

  const missing = runStep(fpStep, { ...base, BIN: fixture('nope'), BASE: fixture('rebuilt.macho') });
  eq(missing.code, 3, 'an unreadable baseline exits 3, distinct from a mismatch');
}

// The diff step must never gate.
console.log('');
console.log('the diff step, extracted and run');

const diffStep = steps.find((s) => s.name?.startsWith('Report what changed'));
ok(!!diffStep, 'the diff step was extracted');
if (diffStep) {
  const r = runStep(diffStep, { BIN: fixture('populated.macho'), BASE: fixture('rebuilt.macho'), ARCH: '' });
  eq(r.code, 0, 'a difference in structure does not fail the step', 'diff reports; assert is where policy belongs');
  ok(/differences=/.test(r.outputs), 'the differences output is set', JSON.stringify(r.outputs));
}

/* ------------------------------------------------------------------ */

rmSync(join(ROOT, '.tmp-action-test'), { recursive: true, force: true });
rmSync(join(ROOT, 'macho-audit.sarif'), { force: true });

console.log('');
if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass} passed. The action's shell is correct, because it was run rather than read.`);