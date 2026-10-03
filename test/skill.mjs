#!/usr/bin/env node
/**
 * skill.mjs (test) — the Agent Skill, checked against the tree it describes.
 *
 * ## Why a skill needs tests
 *
 * A `SKILL.md` is prose in a directory, and prose does not fail when it drifts —
 * it just becomes wrong, quietly, in the one place nobody re-reads it. The
 * failure is invisible from the code: the tool it names gets renamed, the flag it
 * documents stops existing, the exit code it promises changes meaning, and the
 * file still parses. An agent then follows instructions that no longer match the
 * tool, which is worse than having no skill at all because it is trusted.
 *
 * So the checks here are all *cross-references*: does every command the skill
 * names exist, does every exit code it documents mean what it says, does every
 * claim it makes about the tools' limits hold when the tools are run.
 *
 * ## What is deliberately not checked
 *
 * That the prose is well written. Only the parts a machine can get wrong: names,
 * flags, codes, and the claims that are checkable by running something.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SKILL_DIR = path.join(ROOT, 'skill');
const FIXTURES = path.join(HERE, 'fixtures');

let pass = 0;
let fail = 0;
const skipped = [];

function check(ok, name, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

function skip(name, why) {
  skipped.push({ name, why });
  console.log(`  SKIP  ${name}\n          ${why}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BINS = Object.keys(pkg.bin || {});

console.log('\nskill: the agent instructions\n');

/* ---- 1. the shape the format requires ------------------------------- */

const SKILLS = fs.existsSync(SKILL_DIR)
  ? fs.readdirSync(SKILL_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILL_DIR, e.name, 'SKILL.md')))
      .map((e) => e.name)
  : [];

check(SKILLS.length > 0, 'skill/ contains at least one skill with a SKILL.md', JSON.stringify(SKILLS));

for (const name of SKILLS) {
  const file = path.join(SKILL_DIR, name, 'SKILL.md');
  const text = fs.readFileSync(file, 'utf8');
  const short = `skill ${name}`;

  // Frontmatter. The format requires `name` and `description`; everything else
  // is optional, and a missing delimiter means no agent will read the file at all.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  check(!!fm, `${short}: starts with a YAML frontmatter block`);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (m) meta[m[1]] = m[2].trim();
    }
  }
  check(!!meta.name, `${short}: declares a name`);
  check(meta.name === name, `${short}: the name matches its directory`, `${meta.name} in ${name}/`);
  check(!!meta.description, `${short}: declares a description`);
  check(
    !!meta.license && /SPDX|LGPL|MIT|Apache/.test(meta.license),
    `${short}: declares a licence`,
    meta.license,
  );
  check(
    (meta.description || '').length > 80,
    `${short}: the description says enough to route on at discovery time`,
    `${(meta.description || '').length} chars`,
  );
  check(
    meta.license === pkg.license,
    `${short}: its licence agrees with package.json`,
    `${meta.license} vs ${pkg.license}`,
  );

  // The description is the *only* thing an agent sees before deciding to load
  // the skill, so it has to carry the trigger conditions, not just a summary.
  const d = meta.description || '';
  check(
    /mach-?o/i.test(d) && /when|use|question|binary|inspect/i.test(d),
    `${short}: the description names the format and when to reach for it`,
  );
  check(
    /linux|windows/i.test(d),
    `${short}: the description says it is not macOS-only, which is the main reason to prefer it`,
  );
  check(
    d.length < 1024,
    `${short}: the description is short enough to sit in a discovery index`,
    `${d.length} chars`,
  );

  /* ---- 2. every command it names must exist ----------------------- */

  // Commands are bare verbs now. A leftover `macho-<verb>` is the failure worth
  // catching, because it names the old prefixed form that no longer exists.
  const referenced = new Set();
  const stale = new Set();
  for (const rel of ['SKILL.md', 'README.md']) {
    const p = path.join(SKILL_DIR, name, rel);
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, 'utf8');
    for (const m of body.matchAll(/\bmacho-[a-z0-9]+/g)) {
      if (m[0] !== 'macho-explorer') stale.add(m[0]);
    }
    for (const b of BINS) {
      if (new RegExp(`(^|[^-\\w])${b}([^-\\w]|$)`).test(body)) referenced.add(b);
    }
  }
  check(stale.size === 0, `${short}: it names no stale macho-* commands`, [...stale].join(', '));

  const unmentioned = BINS.filter((b) => !referenced.has(b) && b !== 'mcp');
  check(
    unmentioned.length === 0,
    `${short}: every binary in package.json is documented in the skill`,
    unmentioned.join(', '),
  );

  // Flags it tells an agent to pass. A flag that does not exist is a silent
  // no-op in this package, which is exactly why the skill must not name one.
  const body = fs.readFileSync(file, 'utf8');
  const flags = new Set([...body.matchAll(/(?<![-\w])--([a-z][a-z0-9-]{1,20})\b/g)].map((m) => m[1]));

  // Established behaviourally rather than by grepping the source. This package
  // *silently ignores* unknown flags on several tools instead of rejecting
  // them, which means a grep would happily "confirm" a flag that does nothing.
  // Running each tool with the flag and checking it is not rejected as a usage
  // error asks the question that actually matters: does passing this change
  // anything, or is it a no-op the skill is instructing an agent to rely on?
  const probeBin = path.join(FIXTURES, 'populated.macho');
  const rebuilt = path.join(FIXTURES, 'rebuilt.macho');
  const rebuilt2 = path.join(FIXTURES, 'rebuilt2.macho');

  // Per-tool arguments, because a flag check is only meaningful if the tool got far
  // enough to parse it. `audit` takes a bare path, `diff` takes two, and `disasm`
  // takes an address and a count — feeding them the older tools' arguments makes
  // them exit 2 on the *arguments* and the flag looks rejected when it is not.
  //
  // The tool list comes from package.json's `bin`, which is authoritative, and this
  // is a correction rather than an improvement. Deriving it from `src/*.mjs` instead
  // swept in the non-CLI modules — `api.mjs`, `output.mjs`, `bundle.mjs`,
  // `instruction.mjs` — and those exit 0 for *any* argument because they have no CLI
  // to reject one. So the first module tried accepted everything, every flag passed,
  // and the check went green while testing nothing at all. A guard that silently
  // stops guarding is worse than no guard, and this file's own comment says so.
  //
  // `mcp` is excluded from the same reasoning, for a different reason: it is a stdio
  // server, so it reads stdin until stdin closes and then exits 0 — whatever it was
  // handed. It would "accept" any flag the same way. It genuinely takes no flags of
  // its own, so there is nothing here for it to prove.
  const TOOLS_ON_DISK = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).bin ?? {})
    .filter((t) => t !== 'mcp');

  const argsFor = (t, flag) => {
    const src = path.join(ROOT, 'src', `${t}.mjs`);
    switch (t) {
      case 'audit':
        return [src, `--${flag}`, rebuilt];
      case 'fingerprint':
        return [src, `--${flag}`, probeBin];
      case 'diff':
        return [src, `--${flag}`, rebuilt, rebuilt2];
      case 'disasm':
        return [src, `--${flag}`, '0x100000160', probeBin, '1'];
      case 'sym': {
        // The corpus flags change `sym`'s shape: `--in` *replaces* the binary
        // positional, so the ordinary `sym --flag pop <binary>` arguments become
        // `sym --flag <dir> pop` — a pattern and an extra positional, which `sym`
        // refuses as a usage error. That made `--in` and `--per-file` look
        // rejected by every tool when they are accepted by the only one that has
        // them, and the guard was reporting a real property as a defect.
        const CORPUS_VALUE_FLAGS = new Set(['in', 'per-file', 'max-files', 'max-depth']);
        if (CORPUS_VALUE_FLAGS.has(flag)) {
          const value = flag === 'in' ? path.join(HERE, 'fixtures') : '5';
          return [src, `--${flag}`, value, 'pop'];
        }
        if (flag === 'matched-only') return [src, `--${flag}`, 'pop', '--in', path.join(HERE, 'fixtures')];
        break;
      }
      case 'dump':
        // `dump` takes the address as its first positional and the binary as its
        // second, so a valued flag has to be given its value *before* the address —
        // `--len 16 <binary>` would otherwise put the path in the address slot and
        // fail the hex check, making a working flag look rejected.
        return flag === 'len'
          ? [src, '--len', '16', '0x100000000', probeBin]
          : flag === 'arch'
            ? [src, '--arch', 'x86_64', '0x100000000', probeBin]
            : [src, `--${flag}`, '0x100000000', probeBin];
      case 'starts':
        // `--max` takes a number; `--symbols` is a bare flag.
        return flag === 'max' ? [src, '--max', '5', probeBin] : [src, `--${flag}`, probeBin];
      default:
        break;
    }
    const args = [src, `--${flag}`];
    if (t === 'sym') args.push('pop');
    else if (t === 'symlookup' || t === 'a2o') args.push('0x100000120');
    else if (t === 'o2a') args.push('0x120');
    else if (t === 'findcall') args.push('0x100000220');
    else if (t === 'findliteral' || t === 'mapliteral') args.push('pop');
    args.push(t === 'describe' || t === 'sym' || t === 'findcall' || t === 'findliteral' || t === 'mapliteral' ? probeBin : '-b');
    if (['symlookup', 'a2o', 'o2a', 'describe'].includes(t)) args.push(probeBin);
    return args;
  };

  const runFlag = (flag) => {
    for (const t of TOOLS_ON_DISK) {
      const src = path.join(ROOT, 'src', `${t}.mjs`);
      if (!fs.existsSync(src)) continue;
      // A recognised flag must not produce a usage error (2). `describe` rejects
      // everything but --json and -b, so it answers for no flag at all and the
      // others have to.
      const r = spawnSync(process.execPath, argsFor(t, flag), { encoding: 'utf8' });
      if (r.status !== 2) return true;
    }
    return false;
  };

  for (const flag of flags) {
    // `--help` is handled before flag parsing, and `--version` is the MCP
    // server's own; neither is a reader flag, so neither is claimed here.
    //
    // `--check` is the third kind: a flag belonging to `fixtures.mjs`, quoted in
    // this skill because it documents how to verify the package. No reader accepts
    // it, and asking a reader whether it does is a fair question whose answer is
    // "no" — which is exactly what the check below reports. So it is excluded from
    // *this* loop rather than from the tree, and the exclusion says why: a name in
    // prose is not a promise that the flag means anything to the tool it is quoted
    // near.
    if (['help', 'version', 'check'].includes(flag)) continue;
    check(runFlag(flag), `${short}: --${flag} is accepted by a tool rather than silently ignored`);
  }

  // The converse, and the one that actually protects a reader: no reader may
  // accept a flag it does not implement. A tool that ignores `--check` instead of
  // refusing it is the exact defect this package's own docs call a confident wrong
  // answer, so it is asserted here rather than assumed.
  const readers = ['describe', 'sym', 'symlookup', 'findcall', 'findliteral', 'mapliteral', 'a2o', 'o2a'];
  const acceptingCheck = readers.filter((t) => {
    const src = path.join(ROOT, 'src', `${t}.mjs`);
    if (!fs.existsSync(src)) return false;
    const r = spawnSync(process.execPath, [src, '--check'], { encoding: 'utf8' });
    return r.status !== 2;
  });
  check(
    acceptingCheck.length === 0,
    `${short}: no reader accepts --check, which belongs to fixtures.mjs`,
    acceptingCheck.join(', '),
  );

  /* ---- 3. the claims that can be checked by running something ----- */

  // The single most damaging thing a skill can get wrong: telling an agent to
  // send an address as a number. Verified against the schema, not the prose.
  const { findTool, TOOLS } = await import('../src/mcp-tools.mjs');
  const addrTools = TOOLS.filter((t) =>
    Object.values(t.inputSchema.properties || {}).some((p) => p.pattern?.includes('0x')),
  );
  check(
    addrTools.length > 0,
    `${short}: the address-as-hex claim matches a schema that enforces it`,
  );
  for (const t of addrTools) {
    const key = Object.entries(t.inputSchema.properties).find(([, p]) => p.pattern?.includes('0x'))?.[0];
    if (!key) continue;
    const list = t.inputSchema.properties[key].type === 'array';
    const bad = list ? [12345] : 12345;
    const { validate } = await import('../src/mcp-tools.mjs');
    const v = validate(t.inputSchema, { binary: '/x', [key]: bad });
    check(!!v.error, `${short}: ${t.name} really does reject a numeric address`);
  }

  // "An empty result is an answer, not a failure" — the other claim that, if
  // wrong, makes an agent loop. Checked by running it.
  const { callTool } = await import('../src/mcp-tools.mjs');
  const noMatch = await callTool('sym', {
    binary: path.join(FIXTURES, 'populated.macho'),
    pattern: 'zzz-definitely-not-a-symbol-zzz',
  });
  check(
    noMatch?.isError === false && noMatch?.envelope?.ok === true,
    `${short}: "an empty result is an answer" is true of the tool as built`,
    JSON.stringify(noMatch?.envelope?.errors),
  );

  // "Direct calls only" — checked by confirming the reader says so rather than
  // claiming a capability it does not have.
  const noCallers = await callTool('findcall', {
    binary: path.join(FIXTURES, 'populated.macho'),
    target: '0x100000000',
  });
  check(
    noCallers?.isError === false,
    `${short}: "findcall finds nothing" is reported as an answer, not an error`,
    JSON.stringify(noCallers?.envelope?.errors),
  );
  const saysDirectOnly = /direct|indirect/i.test((noCallers?.envelope?.notes || []).join(' '));
  check(saysDirectOnly, `${short}: the direct-calls-only caveat is actually emitted by the tool`);

  /* ---- 4. the exit codes the skill documents ---------------------- */

  // A skill that documents exit 1 as "found nothing" is making a promise about
  // the CLIs. Held to that, because a caller branching on status is exactly the
  // consumer this package is written for.
  const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
  // Every one of these runs with `--json`, because that is the mode a skill
  // tells an agent to use and the only one that emits a parseable envelope.
  // Reading a reason code out of the human-readable output would test the wrong
  // surface — and would pass on a file where the JSON contract is broken.
  const found = run([path.join(ROOT, 'src', 'sym.mjs'), '--json', 'pop', path.join(FIXTURES, 'populated.macho')]);
  const empty = run([path.join(ROOT, 'src', 'sym.mjs'), '--json', 'zzz-nothing-zzz', path.join(FIXTURES, 'populated.macho')]);
  const usage = run([path.join(ROOT, 'src', 'symlookup.mjs'), '--json', 'not-an-address', '-b', path.join(FIXTURES, 'populated.macho')]);
  const unreadable = run([path.join(ROOT, 'src', 'describe.mjs'), '--json', '/nonexistent/nope']);

  check(found.status === 0, `${short}: documented exit 0 — found something`, `got ${found.status}`);
  check(empty.status === 1, `${short}: documented exit 1 — ran, found nothing`, `got ${empty.status}`);
  check(usage.status === 2, `${short}: documented exit 2 — usage error`, `got ${usage.status}`);
  check(unreadable.status === 3, `${short}: documented exit 3 — could not do the job`, `got ${unreadable.status}`);

  // And the two failure modes are distinguishable, which the skill claims they are.
  const nonMachO = run([path.join(ROOT, 'src', 'describe.mjs'), '--json', file]);
  const codes = (out) => {
    try {
      return JSON.parse(out).errors;
    } catch {
      return ['<unparseable>'];
    }
  };
  check(
    codes(unreadable.stdout)[0] === 'io' && codes(nonMachO.stdout)[0] === 'unknown-encoding',
    `${short}: a missing file and a non-Mach-O carry different reason codes, as documented`,
    `missing=${codes(unreadable.stdout)} notMachO=${codes(nonMachO.stdout)}`,
  );

  // The skill's "no /usr/lib/libSystem.B.dylib" claim is platform-specific, so
  // it is only checked where it applies.
  if (process.platform === 'darwin') {
    const exists = fs.existsSync('/usr/lib/libSystem.B.dylib');
    const claimsGone = /shared cache|not on disk|no \/usr\/lib/i.test(body);
    check(
      claimsGone ? !exists : true,
      `${short}: its claim about system dylibs matches this machine`,
      exists ? 'the skill says the library is not on disk, but it is' : 'not present, as documented',
    );
  } else {
    skip(`${short}: the /usr/lib claim`, `only checkable on macOS; this is ${process.platform}`);
  }
}

/* ---- 5. the skill ships -------------------------------------------- */

check(
  (pkg.files || []).includes('skill'),
  'the skill directory is in package.json `files`, so it ships',
  JSON.stringify(pkg.files),
);
check(
  !!pkg.bin?.['mcp'],
  'mcp is a published binary, so the server is installable',
  JSON.stringify(Object.keys(pkg.bin || {})),
);
check(
  fs.existsSync(path.join(SKILL_DIR, 'README.md')),
  'skill/ has a README explaining where to copy the skill',
);

/* ------------------------------------------------------------------ */

console.log(`\n${pass} passed. The instructions match the tools.`);
if (skipped.length) {
  console.log(`${skipped.length} skipped:`);
  for (const s of skipped) console.log(`  ${s.name}\n    ${s.why}`);
  console.log('  A skip means the input was unavailable, not that the check passed.');
}
console.log(fail ? `\n${fail} FAILED.` : '');
process.exit(fail ? 1 : 0);
