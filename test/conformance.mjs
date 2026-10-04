#!/usr/bin/env node
/**
 * conformance.mjs — the oracle is current, the reference conforms, and the check
 * can fail.
 *
 * A conformance suite is only worth what its own checks are worth, so this
 * asserts three things:
 *
 *   1. `conformance/cases.json` matches what the reader produces today, so the
 *      committed expectations cannot drift from the fixtures they describe.
 *   2. The reference adapter — this reader behind the conformance interface —
 *      conforms on every fixture.
 *   3. A deliberately wrong adapter **fails**. Without this the suite could be
 *      passing because `run.mjs` compares nothing, which is the failure mode this
 *      whole project keeps writing checks against.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join('conformance', 'run.mjs');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  PASS  ${m}`); };
const bad = (m) => { failed++; console.log(`  FAIL  ${m}`); };

/** Run a command, returning `{status, stdout, stderr}` instead of throwing. */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

console.log('\nconformance — the corpus is an oracle a stranger can run\n');

/* 1. cases.json is current */
const check = run([RUN, '--check']);
check.status === 0
  ? ok('conformance/cases.json matches the reader')
  : bad(`cases.json is stale — run: node conformance/run.mjs --write-cases\n${check.stderr.trim()}`);

/* 2. the reference adapter conforms */
const ref = run([RUN, '--command', 'node conformance/adapter.mjs']);
ref.status === 0
  ? ok('the reference adapter conforms on every fixture')
  : bad(`the reference adapter did not conform\n${ref.stdout.trim()}`);

/* 3. a wrong adapter fails — the positive control */
const wrong = path.join(os.tmpdir(), `macho-conformance-wrong-${process.pid}.mjs`);
fs.writeFileSync(wrong, `
import { describe } from ${JSON.stringify(path.join(ROOT, 'src', 'api.mjs'))};
import { normalize } from ${JSON.stringify(path.join(ROOT, 'conformance', 'record.mjs'))};
const r = normalize(describe(process.argv[2]));
r.slices[0].arch = 'definitely-not-the-real-arch';
process.stdout.write(JSON.stringify(r));
`);
try {
  const badRun = run([RUN, '--command', `node ${wrong}`]);
  badRun.status !== 0
    ? ok('a wrong parser fails the suite (the check can actually fail)')
    : bad('a wrong parser PASSED — the suite is comparing nothing');
} finally {
  fs.unlinkSync(wrong);
}

console.log(
  failed === 0
    ? `\n${passed} passed. The corpus is a working oracle.\n`
    : `\n${passed} passed, ${failed} FAILED.\n`,
);
process.exit(failed === 0 ? 0 : 1);
