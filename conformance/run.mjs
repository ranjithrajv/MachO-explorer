#!/usr/bin/env node
/**
 * run.mjs — hold any Mach-O parser to the same known answers.
 *
 *   node conformance/run.mjs --command "node conformance/adapter.mjs"
 *   node conformance/run.mjs --command "macho-conformance"
 *   node conformance/run.mjs --write-cases      # regenerate cases.json
 *   node conformance/run.mjs --check            # cases.json is current
 *
 * ## The interface
 *
 * A parser is wrapped in an **adapter**: a command that takes one path and writes
 * one JSON record to stdout. `conformance/record.mjs` defines that record and
 * `conformance/adapter.mjs` is a reference implementation over this reader. Any
 * language can satisfy it — a Go program around `debug/macho`, a Swift one around
 * MachOKit, a Python one around LIEF — which is the point: the corpus is useful to
 * parsers that will never import a line of this package.
 *
 * ## Why the expected values are checked in
 *
 * `cases.json` is committed rather than regenerated at run time, because a test
 * oracle that recomputes its own expectations from the system under test verifies
 * nothing. `--check` re-derives it from the reader and fails on a mismatch, so the
 * file cannot drift from the fixtures it describes without CI noticing — the same
 * discipline `test/fixtures.mjs --check` applies to the binaries themselves.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe } from '../src/api.mjs';
import { normalize } from './record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const CASES = path.join(HERE, 'cases.json');

/** Stable stringify: object keys sorted, so two parsers' key order cannot matter. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const fixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.macho')).sort();
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

/** The expected record for one fixture, from this reader. */
const expectedFor = (file) => normalize(describe(path.join(FIXTURES, file)));

/* ------------------------------------------------------------------ *
 * --write-cases / --check
 * ------------------------------------------------------------------ */

if (process.argv.includes('--write-cases') || process.argv.includes('--check')) {
  const cases = Object.fromEntries(fixtures.map((f) => [f, expectedFor(f)]));
  const text = `${JSON.stringify(cases, null, 2)}\n`;
  if (process.argv.includes('--write-cases')) {
    fs.writeFileSync(CASES, text);
    console.log(`conformance: wrote cases.json — ${fixtures.length} fixtures.`);
    process.exit(0);
  }
  const existing = fs.existsSync(CASES) ? fs.readFileSync(CASES, 'utf8') : '';
  if (existing === text) {
    console.log(`conformance: cases.json matches the reader on all ${fixtures.length} fixtures.`);
    process.exit(0);
  }
  console.error('conformance: cases.json is stale. Re-run: node conformance/run.mjs --write-cases');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * default: run an adapter
 * ------------------------------------------------------------------ */

const command = argOf('--command');
if (!command) {
  console.error('conformance: --command "<parser command>" is required.');
  console.error('             try: --command "node conformance/adapter.mjs"');
  process.exit(2);
}
if (!fs.existsSync(CASES)) {
  console.error('conformance: cases.json is missing. Run: node conformance/run.mjs --write-cases');
  process.exit(2);
}

const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
const [bin, ...pre] = command.split(/\s+/);

let pass = 0;
let fail = 0;
console.log(`\nconformance — ${command}\n`);
for (const file of fixtures) {
  let got;
  try {
    const out = execFileSync(bin, [...pre, path.join(FIXTURES, file)], { encoding: 'utf8', timeout: 120000 });
    got = JSON.parse(out);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${file}  (${err.status != null ? `exit ${err.status}` : err.message.split('\n')[0]})`);
    continue;
  }
  if (canon(got) === canon(cases[file])) {
    pass++;
    console.log(`  PASS  ${file}`);
  } else {
    fail++;
    console.log(`  FAIL  ${file}`);
    // Name the first differing top-level field rather than dumping both records.
    for (const key of new Set([...Object.keys(cases[file]), ...Object.keys(got || {})])) {
      if (canon(cases[file]?.[key]) !== canon(got?.[key])) {
        console.log(`        field "${key}":`);
        console.log(`          expected ${canon(cases[file]?.[key]).slice(0, 200)}`);
        console.log(`          got      ${canon(got?.[key]).slice(0, 200)}`);
        break;
      }
    }
  }
}

console.log(
  fail === 0
    ? `\n${pass} fixtures conform. ${command} agrees with the corpus.\n`
    : `\n${pass} conformed, ${fail} did not. See the fields above.\n`,
);
process.exit(fail === 0 ? 0 : 1);
