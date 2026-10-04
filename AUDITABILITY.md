# Auditability

This document is the argument for the one property of MachO-explorer that no
competitor copies by adding a feature: **the reader is small enough to read, and
you can prove it runs where it says it runs.**

Everything else here — the JSON envelope, the exit codes, the test corpus — is
in service of that. If you are evaluating this package to vendor into something
you are legally responsible for, this is the document to read first.

## The claim, stated so it can be checked

> `src/macho.mjs` imports nothing but `node:fs` and `node:crypto`. It is the
> whole Mach-O reader: fat headers, load commands, symbol tables, sections,
> address↔offset mapping. You can read it end to end in an afternoon, with no
> build, no `node_modules`, and no network.

That is a claim about *auditability*, not about features. It is deliberately
narrower than "complete Mach-O parser" — the [README](README.md) lists what this
reader will not do, and those refusals are part of the same discipline. A parser
that answers 40% of a question in a way you can verify is more useful than one
that answers all of it in a way you cannot.

## Why this matters more than a feature list

The competitor set is full of capable parsers: `ipsw`, LIEF, MachOKit,
`debug/macho`, Ghidra. Every one of them wins on coverage, and every one of them
asks you to trust a codebase you will not read — thousands of commits of Go, a
C++ library with bindings, a research institution's JVM tool. That is a fine
trade for many uses. It is the wrong trade when:

- you are **vendoring** a parser into a product you ship, and a reviewer needs to
  know what it does to bytes;
- you are working from an **air-gapped or restricted network**, where "no
  dependencies" and "no install step" are not preferences but the only way to
  proceed;
- the binary is **proprietary** and cannot legally leave the machine, so a hosted
  analyser is not an option;
- you are reasoning about a **supply-chain** risk and want the smallest possible
  surface between your data and an answer.

None of those is a feature request. They are reasons to choose a *dependency*
over a *tool*, and auditability is what a dependency is chosen on.

## Verify it yourself, in about five seconds

The claim is reproducible on a clean clone, offline, with nothing installed:

```sh
git clone https://github.com/ranjithrajv/MachO-explorer && cd MachO-explorer

# 1. The reader really does import only the two builtins.
grep -n "^import" src/macho.mjs

# 2. It really does run with no install — copy it out and use it alone.
mkdir /tmp/vendor && cp src/macho.mjs /tmp/vendor/
cd /tmp/vendor && node -e "
  import('./macho.mjs').then(async (m) => {
    const { opener, parseThin } = m;
    const f = opener(process.argv[1]);
    console.log(parseThin(f, 0)?.filetype);
  });
" /bin/ls

# 3. The whole suite runs with no install and no network.
cd - && node test/fixtures.mjs --check && node test/smoke.mjs
```

Step 2 is the demonstration: **one file, copied alone into an empty directory,
parsing a real binary with no `package.json` and no `node_modules` present.**

## The same file runs in a browser — and proves it

`demo/` is a drag-and-drop page that reads a Mach-O **in the tab**, with the
bytes never leaving the machine. It is not a reimplementation: `demo/link.mjs`
mechanically links `src/macho.mjs`, `src/instruction.mjs` and `src/api.mjs` into
one module with a small host shim, and `test/browser.mjs` requires the linked
bundle to produce **byte-for-byte the same `describe` and `overview` answers as
the Node build on all 23 fixtures.**

```sh
node demo/serve.mjs      # then open http://localhost:8788/demo/
node demo/link.mjs --check   # fails if the bundle drifts from the sources
node test/browser.mjs        # 45 checks: shims match Node, answers match Node
```

That is the auditability claim made visible: the code you audit is the code that
runs, in both hosts, and a stale bundle fails the build rather than shipping.

## What "auditable" does *not* mean

- **It is not a security audit.** Reading the parser tells you it reads bytes
  correctly and does nothing else. It does not tell you the *binary* is safe —
  nothing here executes what it reads.
- **It is not completeness.** The reader names what it does not parse (code
  signing, ObjC/Swift metadata, DWARF, fixups) in every `overview` result, so an
  empty field is evidence rather than silence.
- **It is not a guarantee about the build you get from npm.** npm is a supply
  chain too. The point is that the alternative — vendoring the one file — is
  always available, and the file is small enough that vendoring is reasonable.
- **The licence is not a warranty.** LGPL-3.0-or-later covers this code and
  nothing else. It does not license anyone else's intellectual property, and
  reading a file format out of a binary does not make that binary yours.

## The checks that keep the claim honest

Auditability would be worthless if it were a paragraph that could quietly stop
being true. It is enforced, not asserted:

| Check | What it holds |
|---|---|
| `test/smoke.mjs` `boundary:` checks | No publisher, title, or product format appears in `src/`, `test/`, or the published tarball — with a positive control, so a check that matched nothing fails |
| `test/browser.mjs` | The browser bundle imports no `node:` builtin and answers identically to Node on every fixture |
| `demo/link.mjs --check` | The committed browser bundle matches the sources it is generated from |
| `conformance/run.mjs --check` | `cases.json` matches the reader on every fixture |
| `test/fixtures.mjs --check` | Every byte of the test corpus matches its generator |

Each of these is a check that **can fail** — the project treats a verification
that cannot fail as worse than none, because it reports success. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the gate a change has to pass.
