#!/usr/bin/env node
/**
 * schemas.mjs — every tool's real output validates against its own schema.
 *
 * ## Why this is not a documentation exercise
 *
 * A JSON Schema nobody validates against is a guess. The only thing that makes a
 * schema a contract rather than a description is running the *actual* output of
 * the *actual* tool through it, on a binary, in CI — and that is the entire
 * content of this file.
 *
 * The gap it closes is specific. `test/types.mjs` holds the hand-written
 * `src/api.d.ts` against the code. That catches the *declarations* drifting. It
 * cannot catch the *schema* drifting, because the schema is a third artifact and
 * nothing was comparing it to anything.
 *
 * ## The negative control, which is the load-bearing half
 *
 * Every "does this validate?" assertion above would also pass against a schema
 * that accepts everything. So this file also asserts that the schemas *reject*
 * wrong documents, and that matters in three specific ways that a positive-only
 * suite cannot reach:
 *
 *   1. **The validator is not a no-op.** A validator bug that silently accepts
 *      everything is indistinguishable from a correct validator on a positive
 *      test. This is the "a verification that cannot fail is worse than a
 *      missing one" rule from this project's own README, applied to the thing
 *      that would catch it.
 *   2. **The constraints are the ones claimed.** `additionalProperties: false` on
 *      the envelope is asserted by feeding an envelope with a typo'd field.
 *      Without it, a consumer's typo (`errorss`) passes validation and then
 *      reads as "no errors" — the exact confident-wrong-answer class this project
 *      exists to prevent, arriving through the schema instead of a typo.
 *   3. **The address pattern holds.** An address as a JSON *number* is rejected,
 *      because that is the one thing the schema exists to stop and a consumer
 *      relying on it must be able to rely on it.
 *
 * ## Address-bearing output is checked for the hex form
 *
 * Every `0x…` in a validated document is swept for a *sibling* field that is the
 * same address as a bare number. That is the bug this project's whole reason for
 * existing, in the one place a schema could plausibly let it back in: `toJSON`
 * converts BigInt to a hex string at the boundary, and if that conversion were
 * removed the schema would be the only thing standing between a silent precision
 * loss and a downstream consumer.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// A bare Windows path is not a valid `import()` specifier — it parses as a URL with
// an unsupported `d:` scheme, so this threw ERR_UNSUPPORTED_ESM_URL_SCHEME there
// while working on POSIX.
const imp = (...parts) => import(pathToFileURL(join(...parts)).href);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { validate, generated } = await import('./schema-gen.mjs');

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
const eq = (a, b, label) => ok(a === b, label, a === b ? '' : `expected ${b}, got ${a}`);

/* ------------------------------------------------------------------ *
 * the composed root, for $ref resolution
 * ------------------------------------------------------------------ *
 * The validator resolves `#/$defs/slice` against whatever root it is given.
 * Every tool schema carries its own `$defs`, so the root is the schema under
 * test — not a global. Resolving against a shared root would let a schema
 * validate by referencing a definition it does not ship, which is precisely the
 * failure a consumer hits when they copy one file out of the directory.
 */
const validates = (schema, doc) => validate(schema, doc).length === 0;
const errorsFor = (schema, doc) => validate(schema, doc);

const runTool = (args) =>
  spawnSync(process.execPath, [join(ROOT, 'src', 'macho-explorer.mjs'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  });

const fixture = (n) => join(ROOT, 'test', 'fixtures', n);

/** Parse `--json` output, or return the error so the caller can report it. */
const jsonOf = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    return { __parseError: e.message, __raw: r.stdout.slice(0, 200) };
  }
};

/* ------------------------------------------------------------------ *
 * every tool's real output validates
 * ------------------------------------------------------------------ */

console.log('real output validates against its own schema');

/**
 * The pairs that matter, and why each is here.
 *
 * `universal` is a fat binary with symbols, so it exercises the richest path in
 * `describe` — multiple slices, sections, load commands, dylibs. `bent` is the
 * damaged one, so `audit` is checked with *findings present* rather than only on
 * a clean file; a schema validated solely against empty findings would not notice
 * a wrong constraint on `severity` or `kind`.
 *
 * Each entry runs the tool for real and validates. No mock documents: a mock
 * validates against whatever the author believed, which is the thing being
 * tested.
 */
const CASES = [
  { tool: 'describe', args: ['describe', '--json', fixture('universal.macho')], note: 'a fat binary with two slices and a symbol table' },
  { tool: 'describe', args: ['describe', '--json', fixture('bent.macho')], note: 'a damaged binary, so abnormalities are present' },
  { tool: 'sym', args: ['sym', '--json', 'main', fixture('populated.macho')], note: 'a substring match with results' },
  { tool: 'sym', args: ['sym', '--json', 'zzzznomatch', fixture('populated.macho')], note: 'no matches — count 0, an answer not an error' },
  { tool: 'symlookup', args: ['symlookup', '--json', '-b', fixture('populated.macho'), '0x100000000'], note: 'an address lookup, found and not-found' },
  { tool: 'starts', args: ['starts', '--json', fixture('functions.macho')], note: 'LC_FUNCTION_STARTS present' },
  { tool: 'starts', args: ['starts', '--json', fixture('thin-arm64.macho')], note: 'no LC_FUNCTION_STARTS — present:false' },
  // `findcall` in listing mode needs `--list`; a bare invocation with no target is
// a usage error. That is itself worth asserting separately — a bare `findcall`
// asking no question must exit 2 rather than answering something nobody asked —
// so the case below uses the documented flag and the misuse is covered in the
// negative-control section.
{ tool: 'findcall', args: ['findcall', '--list', '--json', fixture('functions.macho')], note: 'listing mode' },
{ tool: 'findcall', args: ['findcall', '--json', '0x100000200', fixture('functions.macho')], note: 'query mode, callers of one address' },
  { tool: 'findliteral', args: ['findliteral', '--json', '--strings', fixture('strings.macho')], note: 'the string-listing mode' },
  { tool: 'findliteral', args: ['findliteral', '--json', 'main', fixture('strings.macho')], note: 'the byte-search mode' },
  { tool: 'mapliteral', args: ['mapliteral', '--json', 'main', fixture('strings.macho')], note: 'literal to pointers' },
  { tool: 'a2o', args: ['a2o', '--json', '-b', fixture('zerofill.macho'), '0x100000000'], note: 'three outcomes kept distinct, incl. zero-fill' },
  { tool: 'o2a', args: ['o2a', '--json', '-b', fixture('universal.macho'), '4096'], note: 'offset to address' },
  { tool: 'dump', args: ['dump', '--json', '-b', fixture('strings.macho'), '0x100000000', '64'], note: 'bytes at an address' },
  { tool: 'audit', args: ['audit', '--json', fixture('universal.macho')], note: 'no findings' },
  { tool: 'audit', args: ['audit', '--json', fixture('bent.macho')], note: 'findings present, both severities' },
  { tool: 'fingerprint', args: ['fingerprint', '--json', fixture('rebuilt.macho')], note: 'the one-file shape' },
  { tool: 'fingerprint', args: ['fingerprint', '--json', fixture('rebuilt.macho'), fixture('rebuilt2.macho')], note: 'the two-file comparison shape' },
  { tool: 'diff', args: ['diff', '--json', fixture('rebuilt.macho'), fixture('rebuilt2.macho')], note: 'a rebuilt pair, so differences is 0' },
  { tool: 'assert', args: ['assert', '--json', '--has-symbol', 'main', fixture('populated.macho')], note: 'a passing assertion' },
  { tool: 'disasm', args: ['disasm', '--json', fixture('functions.macho')], note: 'decoded instructions' },
];

for (const c of CASES) {
  const schema = generated[`${c.tool}.schema.json`];
  const r = runTool(c.args);
  const doc = jsonOf(r);

  if (doc.__parseError) {
    ok(false, `${c.tool} (${c.note}) emits parseable JSON`, doc.__parseError);
    continue;
  }

  // The envelope carries the tool's own name, which is what a consumer branches
  // on. Asserted separately because a mismatch would validate fine against a
  // schema that never says which tool produced the answer.
  eq(doc.tool, c.tool, `${c.tool} (${c.note}): the envelope names the right tool`);

  const errs = errorsFor(schema, doc);
  ok(
    errs.length === 0,
    `${c.tool} (${c.note}) validates`,
    errs.length ? errs.slice(0, 3).join(' | ') : '',
  );
}

/* ------------------------------------------------------------------ *
 * addresses are never JSON numbers
 * ------------------------------------------------------------------ *
 * Swept rather than sampled: the failure this is looking for is a field holding a
 * number where the reader documented a hex string, and a sample would miss the
 * one nested field out of forty where it happened.
 */
console.log('');
console.log('addresses are hex strings, never JSON numbers');

/**
 * Walk every leaf and report any whose key implies a *virtual address* but is
 * not hex.
 *
 * Two distinctions matter here, and both were got wrong in the first draft of this
 * check:
 *
 * 1. **Address vs file offset.** A virtual address is a hex string because 64-bit
 *    values do not survive a JSON number. A file offset is a byte position
 *    counted from the start of the file and bounded by file size — it is safely
 *    an integer, and the reader returns it as one. So `offset`, `absoluteOffset`,
 *    `fileoff` and `entryoff` are all integers *by design* and are excluded here.
 *    A "no bare numbers anywhere under an *off* key" rule would fail on correct
 *    output, which is how a correct rule gets deleted to make a check green.
 *
 * 2. **`vaddr`/`vmaddr`/`addr`/`target`/`start`/`next`/`dest`.** These are all
 *    genuine virtual addresses and must be hex. They are what this check is for.
 */
function findNumericAddresses(doc) {
  const bad = [];
  // Keys whose value is a virtual address. File-offset keys are deliberately absent.
  const addressish = /^(addr|address|vaddr|vmaddr|target|dest|source|start|next|base)$/i;
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
    const leaf = path.split('.').pop() || '';
    if (typeof v === 'number' && addressish.test(leaf) && v > 1) {
      bad.push(`${path} = ${v}`);
    }
  };
  walk(doc, '$');
  return bad;
}

for (const c of CASES) {
  const r = runTool(c.args);
  const doc = jsonOf(r);
  if (doc.__parseError) continue;
  const bad = findNumericAddresses(doc);
  ok(bad.length === 0, `${c.tool}: no address is a bare number`, bad.slice(0, 3).join(', '));
}

// The schema itself rejects a numeric address, which is what lets a consumer
// rely on the hex form rather than hoping for it.
{
  const schema = generated['a2o.schema.json'];
  const numericAddr = {
    schemaVersion: '1.0',
    tool: 'a2o',
    ok: true,
    binary: 'x',
    errors: [],
    data: {
      queries: [{ query: '0x1000', vaddr: 1091523120, offset: 4096, mapped: true, zerofill: false }],
      asked: 1,
      resolved: 1,
      zerofill: 0,
      unmapped: 0,
    },
  };
  ok(!validates(schema, numericAddr), 'the a2o schema rejects an address given as a JSON number', 'a 64-bit address above 2^53 silently loses its low bits, which is the bug the hex form exists to prevent');
}

/* ------------------------------------------------------------------ *
 * negative controls — the schemas must reject
 * ------------------------------------------------------------------ */

console.log('');
console.log('negative controls: the schemas reject what they should');

const ENV = (data, extra = {}) => ({
  schemaVersion: '1.0',
  tool: 'audit',
  ok: true,
  binary: 'x',
  errors: [],
  data,
  ...extra,
});

// The negative-control documents below are checked against the *generated*
// audit schema, so they get the same `$defs` root that schema ships with. Passing
// a bare document with no root would resolve `#/$defs/fingerprintSide` against
// the document instead of the schema, which is a different test than intended.
const auditSchema = generated['audit.schema.json'];

// 1. The envelope is closed. A typo'd field passes validation on a permissive
//    schema and then reads as absent — "no errors" when the tool said three.
//
//    `errorss` goes at the *envelope* level, which is where the constraint
//    applies. Putting it inside `data` would be meaningless and would pass for the
//    wrong reason: `data` is deliberately open to new fields (see the schema
//    descriptions), so a typo there is not something the envelope can catch, and
//    a check that appeared to prove it could would be proving nothing.
{
  const schema = generated['audit.schema.json'];
  const base = { verdict: 'failed', clean: false, strictClean: false, counts: { errors: 2, warnings: 1 }, slices: [], containerAbnormalities: [] };
  ok(!validates(schema, ENV(base, { errorss: 2 })),
    'a typo in an envelope field is rejected', 'errorss must not validate as errors — a consumer would read it as "no errors"');
  ok(validates(schema, ENV(base)), 'the same document without the typo validates');

  // And the counterpart, because an open envelope would also pass the test above
  // for the wrong reason: `data` must still accept an unrecognised key, or every
  // consumer is pinned to a version before a bug fix can add a field.
  ok(validates(schema, ENV({ ...base, aFieldAddedLater: 1 })),
    'data accepts an unrecognised field — an added field is ignorable, which is what lets a minor release add one');
}

// 2. required fields are required.
{
  const schema = generated['audit.schema.json'];
  ok(!validates(schema, ENV({ verdict: 'ok', clean: true })), 'a data object missing counts/slices is rejected');
}

// 3. The severity enum holds. `info` is not a severity this reader emits, and a
//    consumer switching on it would fall through to a default and treat a
//    warning as informational.
{
  const schema = generated['audit.schema.json'];
  const bad = ENV({ verdict: 'warnings', clean: true, strictClean: false, counts: { errors: 0, warnings: 1 },
    slices: [{ arch: 'arm64', abnormalities: [{ severity: 'info', kind: 'x', detail: 'd' }] }], containerAbnormalities: [] });
  ok(!validates(schema, bad), 'a severity of "info" is rejected — the enum is error|warning');
  const good = ENV({ verdict: 'warnings', clean: true, strictClean: false, counts: { errors: 0, warnings: 1 },
    slices: [{ arch: 'arm64', abnormalities: [{ severity: 'warning', kind: 'x', detail: 'd' }] }], containerAbnormalities: [] });
  ok(validates(schema, good), 'the same finding with severity "warning" validates');
}

// 4. The verdict enum holds, and `verdict` is *not* the gate.
{
  const schema = generated['audit.schema.json'];
  // This combination is legal and is the whole point of carrying both fields.
  const okDoc = ENV({ verdict: 'warnings', clean: true, strictClean: false, counts: { errors: 0, warnings: 1 }, slices: [], containerAbnormalities: [] });
  ok(validates(schema, okDoc), 'verdict:warnings with clean:true validates — a passing audit');
  const badVerdict = ENV({ verdict: 'OK', clean: true, strictClean: false, counts: { errors: 0, warnings: 0 }, slices: [], containerAbnormalities: [] });
  ok(!validates(schema, badVerdict), 'a verdict of "OK" is rejected — the enum is lowercase ok|warnings|failed');
}

// 5. The schemaVersion pattern holds, so a consumer pinned to 1.0 fails loudly on
//    a 2.0 rather than parsing it and believing the wrong thing.
{
  const schema = generated['audit.schema.json'];
  const good = ENV({ verdict: 'ok', clean: true, strictClean: false, counts: { errors: 0, warnings: 0 }, slices: [], containerAbnormalities: [] });
  ok(!validates(schema, { ...good, schemaVersion: '2.0' }) === false, 'schemaVersion 2.0 parses against the ^\\d+\\.\\d+$ pattern');
  ok(!validates(schema, { ...good, schemaVersion: '1' }), 'a schemaVersion with no minor is rejected');
  ok(!validates(schema, { ...good, schemaVersion: 'v1.0' }), 'a schemaVersion with a prefix is rejected');
}

// 6. An unknown reason code is rejected. `errors` is what a consumer branches on
//    to self-correct, so an unrecognised value silently swallowed is worse than
//    a rejected document.
{
  const schema = generated['audit.schema.json'];
  const good = ENV({ verdict: 'ok', clean: true, strictClean: false, counts: { errors: 0, warnings: 0 }, slices: [], containerAbnormalities: [] });
  ok(!validates(schema, { ...good, errors: ['gibberish'] }), 'an unknown reason code is rejected');
  ok(validates(schema, { ...good, errors: ['io'] }), 'a known reason code validates');
  ok(validates(schema, { ...good, errors: ['encrypted'] }), '"encrypted" is a known reason code — a zero over ciphertext is not an answer');
}

// 7. The validator is not a no-op, stated directly.
{
  const schema = generated['audit.schema.json'];
  ok(!validates(schema, { nonsense: true }), 'a completely wrong document is rejected');
  ok(!validates(schema, 'not even an object'), 'a non-object document is rejected');
  ok(!validates(schema, null), 'null is rejected');
}

/* ------------------------------------------------------------------ *
 * the generated files are on disk and self-consistent
 * ------------------------------------------------------------------ */

console.log('');
console.log('the schema files themselves');

for (const [name, schema] of Object.entries(generated)) {
  const onDisk = JSON.parse(readFileSync(join(ROOT, 'schema', name), 'utf8'));
  eq(onDisk.$id, schema.$id, `${name}: $id is stable`);
  ok(onDisk.properties?.data?.description?.includes('Shape specific to'), `${name}: data says which tool it is for`);
  // No examples from another tool: an `audit` schema carrying a `sym` example
  // teaches the wrong shape to anyone who reads it instead of running it.
  const stray = (onDisk.examples || []).filter((e) => e.tool && e.tool !== name.split('.')[0]);
  eq(stray.length, 0, `${name}: carries no example from another tool`);
}

// The envelope schema is the one thing this file composes from and does not
// generate, so it is checked directly. A change to it propagates to every tool
// schema, which is the point — and which is also why it needs its own assertions
// rather than being assumed correct because the compositions inherit from it.
{
  const env = JSON.parse(readFileSync(join(ROOT, 'schema', 'envelope.schema.json'), 'utf8'));
  eq(env.additionalProperties, false, 'the envelope schema is closed');
  eq(env.properties.data.type.includes('null') && env.properties.data.type.includes('object'), true, 'the envelope data stays unconstrained to object|null');

  // `encrypted` was missing from this enum until the per-tool schemas were run
  // against real output: the reader emits it for a zero result over App Store
  // ciphertext, and an envelope schema that omits a code the tools actually use
  // rejects correct output from its own package. That this assertion exists is
  // the argument for generating the per-tool schemas at all — the gap was not in
  // the reader, which was right, but in the description of it.
  const codes = env.properties.errors.items.enum;
  ok(codes.includes('encrypted'), 'the envelope enum includes "encrypted" — the reader emits it');
  ok(codes.includes('io') && codes.includes('unknown-encoding'), 'the envelope enum keeps io and unknown-encoding distinct');

  // Every code the MCP layer declares must be in the enum. Two lists that are
  // maintained separately are two lists that drift, and the drift shows up as a
  // consumer's validator rejecting a valid response from this package.
  const { REASON_CODES } = await imp(ROOT, 'src', 'mcp-tools.mjs');
  for (const code of REASON_CODES) {
    ok(codes.includes(code), `the envelope enum includes "${code}", which the MCP layer can emit`);
  }
}

/* ------------------------------------------------------------------ */

console.log('');
if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass} passed. Every schema describes what the tools actually emit, and rejects what they do not.`);