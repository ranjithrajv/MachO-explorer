# MachO-explorer

[![test](https://github.com/ranjithrajv/MachO-explorer/actions/workflows/test.yml/badge.svg)](https://github.com/ranjithrajv/MachO-explorer/actions/workflows/test.yml)

> **The reader you can read.** Dependency-free Mach-O introspection that runs in Node, in a browser tab, or on a phone — and names what it cannot read instead of guessing at it.

**Verified 2026-10-07.** 0 runtime dependencies · the reader is `src/macho.mjs`, one file importing only `node:fs` and `node:crypto` · 776 checks in the reader suite, on binaries it was not written for · in the browser it returns byte-for-byte the same answers as Node. Re-run every one of those claims in five seconds, [below](#verify-it-yourself).

Mach-O binary introspection for **macOS, iOS, iPadOS, tvOS, watchOS and visionOS** binaries — thin or universal, 32- or 64-bit, `arm64`, `arm64e`, `arm64_32`, `x86_64`, `i386`, `armv7`, `armv7k`. Fat headers, symbol tables, sections, `__text`, instruction boundaries and direct branch edges. **It knows nothing about any application** — no formats, no products, no save files. Every answer is a fact about the file format or about the bytes.

**Mach-O is the whole scope, chosen.** This is not a toolkit that happens to include one; that focus is what pays for the depth. Under the hood it decodes instruction *boundaries* and *direct* branch displacements — lengths and edges, which are facts about the bytes — and stops there. It does not print mnemonics or operands, and it will not grow to.

## Why it is different

- **One file you can read.** `src/macho.mjs` imports only `node:fs` and `node:crypto`. Copy it into an empty directory and it parses real binaries — no `node_modules`, no build step, no network. Audit it over a coffee: **[AUDITABILITY.md](AUDITABILITY.md)** is the argument and the five-second recipe.
- **Runs where the binary is.** The same reader runs on macOS, Linux and Windows, client-side in a browser tab, and under Termux on Android — so a sensitive binary can be triaged with **nothing leaving the machine**. No upload, no server, no cloud.
- **Built for machines first.** Every tool emits one versioned JSON envelope under `--json`, a documented exit-code contract, and a `notRead` list on every payload. An **MCP server** and an **Agent Skill** ship in the box.
- **Honest by construction.** A negative answer is a value, not an exception: *found nothing* (exit 1) is never confused with *could not look* (exit 3). Every omission is named, in the answer and in [What it will not do](#what-it-will-not-do).

## Install

```sh
npm install -g macho-explorer        # Node ≥ 22.15
```

Zero dependencies. Or vendor `src/`. Or copy **`src/macho.mjs` alone** — the whole raw reader, one auditable file, no lockfile and no install step.

## Quick start

```sh
macho-explorer describe /usr/local/go/bin/go              # what is in this file?
macho-explorer sym runtime.main /usr/local/go/bin/go      # find a symbol by name
macho-explorer symlookup 0x100085c30 -b /usr/local/go/bin/go
macho-explorer findcall --list /usr/local/go/bin/go 20    # the busiest call sites
macho-explorer a2o 0x100085c30 -b /usr/local/go/bin/go    # vaddr → file offset
macho-explorer disasm 0x100085c30 /usr/local/go/bin/go    # boundaries + branch edges
macho-explorer findcall --json 0x100085c30 /usr/local/go/bin/go | jq '.count'
```

## The tools

| | |
|---|---|
| `describe` | What is in this file? Every slice, architecture, platform (`ios`, `macos`, …), filetype, extent, symbol counts, `__TEXT` bounds, UUID, header flags, entry point, rpaths, source version, dylibs. `--sections` / `--segments` / `--loads` for full listings |
| `overview` | The whole picture in one call, plus `--symbols` / `--strings` on request — and a `notRead` list of what this package does not parse |
| `sym` | Search a symbol table by substring, or `--regex`. Imports marked, not shown as `0x0` |
| `symlookup` | Which function contains this vaddr? Reads symbols directly; `nm` on a large universal binary is unusable |
| `starts` | Where do functions begin? The linker's `LC_FUNCTION_STARTS` list — the only one a stripped binary carries |
| `findcall` | Direct `call`/`jmp` xrefs to an address, or `--list` for the distinct targets a binary calls |
| `findliteral` | A byte literal anywhere in the file, per slice, with context — or `--strings` to list what is already there |
| `mapliteral` | Literal → vaddrs → the pointers to it. How you find the code that handles a format |
| `a2o` / `o2a` | Virtual address ↔ file offset, every slice's answer, with zero-fill as its own case |
| `dump` | The bytes at a vaddr, resolved through its section and bounded by it |
| `disasm` | Instruction boundaries and resolved **direct** branch edges for `arm64`, `arm64e`, `x86_64` — bytes, not mnemonics |
| `audit` | Is the file internally consistent? Its exit status is the product — a gate, not a report |
| `fingerprint` | Is this the same *program* as that one? A digest that survives a rebuild |
| `diff` | What changed between two binaries — structural facts, so a rebuilt pair is not a changed program |
| `assert` | A CI policy: `--has-symbol`, `--no-symbol`, `--has-string`, `--no-string`, repeatable |
| `tbd` | What does this library export? A `.tbd` text stub — the only readable record of a system dylib since macOS 11 |
| `symbolicate` | Turn a crash report into named frames, and say *why* every frame it could not name was not named |
| `mcp` | Serve the tools over the Model Context Protocol (JSON-RPC on stdin/stdout) |

## Three things worth seeing

**A crash report becomes names.** `symlookup` answers for an address you already have; a crash report is a *stack* of them, in binaries you did not build, and not always addresses — an `.ips` frame is an offset into an image, a legacy `.crash` frame is absolute. `symbolicate` reads both, says which, and gives every frame it cannot name a *reason* (most are in Apple frameworks, which since macOS 11 are not files on disk).

```sh
$ macho-explorer symbolicate MyApp-2026-10-07.ips
  MyApp-2026-10-07.ips  —  ips, MyApp, macOS 15.0
  exception EXC_BAD_ACCESS (SIGSEGV)

  Thread 1  (crashed)
     0  -[MyController handleTap:] [binary]
     1  main [report]
     2  (unresolved)
        why not: not on disk — a modern Apple system library lives in the
                 dyld shared cache, so there is no file to read
```

**What does libSystem export?** Since macOS 11 the system libraries are not files, so `nm` and `otool` have nothing to open — the question is unanswerable by anything that reads binaries. The answer is in the SDK, as text:

```sh
$ macho-explorer tbd --symbol=_pthread_mutex_lock --sdk="$SDK/usr/lib"
_pthread_mutex_lock  —  4 hit(s) in 2 libraries, from 394 stub(s)
  /usr/lib/system/libsystem_pthread.dylib
```

**Same program? What changed?** "Is this the same thing?" has three answers, and a byte comparison gets all three wrong — PIE and ASLR move every address, while a templated binary with one function renamed is structurally near-identical. `fingerprint` survives a rebuild; `diff` says what actually changed.

```sh
$ macho-explorer fingerprint v1.0/libthing.dylib v1.1/libthing.dylib
  same program, rebuilt
$ macho-explorer diff v1.0/libthing.dylib v1.1/libthing.dylib
  same program, rebuilt  —  0 difference(s), 1 build-metadata change(s)
```

## Prove it on real binaries

Stock system binaries, no fixtures and no setup — the reader on files it did not create. `/usr/lib/dyld` is the dynamic linker: a universal `MH_DYLINKER` with four thousand symbols per slice, not a toy built to flatter the parser.

```sh
$ macho-explorer describe /usr/lib/dyld
/usr/lib/dyld — 2.4 MB, universal, 2 slice(s)

  x86_64   file 16384..1161760  64-bit  MH_DYLINKER  macos  4,041 defined / 4,041 symbols  1 code section(s) __text 0x1000+606,251
           uuid cf55ca34-3ecb-38f3-9e3e-e20592c197be
           flags MH_NOUNDEFS MH_DYLDLINK MH_TWOLEVEL
           minos 26.6.0  sdk 26.6.1
  arm64e   file 1163264..2562000  64-bit  MH_DYLINKER  macos  4,386 defined / 4,386 symbols  1 code section(s) __text 0x1000+647,224

$ macho-explorer audit /usr/lib/dyld
/usr/lib/dyld — OK  0 error(s), 0 warning(s)

$ macho-explorer findcall --list /usr/lib/dyld 2
4577 distinct direct call/jmp target(s), most-called first  (1 MB of code scanned)
  0x000000091802  397 site(s)
  0x000000001ce6  314 site(s)
```

Every number above is from a stock binary; run the three commands and compare.

## Gate a build on it

`audit`'s exit status is the product, and `assert` turns structure into policy. The composite action runs the reader from the checked-out source — **no install step** — so the gate tests *this commit* rather than whatever a tag resolved to today.

```yaml
- uses: ranjithrajv/MachO-explorer@main
  with:
    binary: build/Some.app/Contents/MacOS/Some
    baseline: known-good/Some        # enables fingerprint + diff
    sarif: true                      # upload to Code Scanning
```

See **[Gating a build](docs/ci-gate.md)** for the exit-status taxonomy and SARIF, and [`action.yml`](action.yml) for the inputs.

## For agents and pipelines

If a program, not a person, reads the answer, this is the surface it gets.

- **One versioned envelope, always.** The same JSON object on success and failure — `schemaVersion`, `tool`, `ok`, `binary`, `errors`, `data`. stdout carries JSON only; progress and prose go to stderr. The version travels *in* every response so a consumer fails loudly on a change instead of reading a renamed field as empty.
- **Omissions travel with the answer.** `data.notRead` names what this package does not parse, so an empty field is evidence rather than silence: "the binary has none" stays distinct from "the reader does not look".
- **Addresses are `"0x…"` strings,** because a 64-bit vaddr does not survive a JSON number and a silently truncated address looks exactly like a correct one.
- **Two doorways.** An **MCP server** for an agent that speaks the protocol, and an **[Agent Skill](skill/)** for one that drives the CLI or the library.

```sh
claude mcp add macho -- node /absolute/path/to/src/mcp.mjs
```

```js
import { describe, lookupAddress, findCalls, mapLiteral } from 'macho-explorer';

const { slices } = describe('/path/to/binary');
const fn = lookupAddress('/path/to/binary', 0x100085c30n);
const callers = findCalls('/path/to/binary', fn.start);
```

Full detail: **[Driving it from an agent](docs/agent-integration.md)** and **[the machine contract](docs/machine-contract.md)**.

## What it will not do

A gap and a refusal read the same in a table, and only one of them survives a contributor with good intentions. These are refusals:

| Will not | Because |
|---|---|
| **Disassemble to text** | `disasm` gives instruction lengths and direct branch edges — the last step a byte-level reader can take without guessing. Mnemonics, operands and a CFG are a disassembler's job, and duplicating it is how you become a worse one |
| **Resolve indirect / PLT calls** | The target is not in the instruction; a wrong edge here would look like a call graph |
| **Read dSYM / DWARF** | A different file format, for the minority of binaries whose symbols are in a sidecar |
| **Parse ObjC/Swift metadata** | Another project does it properly; duplicating it makes this a worse version of that one |
| **ELF or PE** | Mach-O is the focus, not the first of four |
| **FAT64 containers** | A fat header with 64-bit slice offsets is refused rather than half-read; reading its wider offset as 32-bit resolves a slice into the file's first 4 GiB |
| **Code signing, fixups, export tries** | Covered elsewhere, and none of them changes which function an address lands in |

## When to use it — and when not to

Reach for **this** when you want one dependency-free file you can vendor or read end to end; when you are on **Linux or Windows** pointing at a Mac binary that `otool` and `nm` cannot touch; when the binary is **large and universal**; when you want **scriptable, composable** answers rather than a GUI; or when you need **literal-level triage** — where a format magic is, what it maps to, and what points at it.

Reach for **something else** when you want Mach-O *and everything around it* (code signing, fixups, ObjC/Swift metadata, firmware images, the dyld shared cache), a complete general-purpose parser, several file formats in one dependency, or a disassembler. The honest comparison — including the exact rows where a general parser wins — is in **[When to use this](docs/use-cases.md)**.

## Limits

- **Direct calls only.** Indirect calls and PLT stubs do not encode their target, so they are absent from `findcall`. Every hit is a site *worth disassembling*, not a proven edge.
- **The x86_64 scan is typed by section, not instruction.** Data false positives are removed, but a byte inside a multi-byte instruction can still match. The file format records no alignment, so nothing short of a disassembler fixes it. The arm64 path steps 4 bytes and sees only aligned `BL`s.
- **Stripped binaries have no names.** `sym` and `symlookup` report nothing rather than guess; `findcall` and `findliteral` read bytes and are unaffected.
- **Verified on macOS and Linux.** The reader is portable buffer arithmetic; on Windows only the generated half of the suite runs.

## Verify it yourself

Every correctness claim here is reproducible on a clean checkout, offline, with nothing installed — no network, no fixture download:

```sh
git clone https://github.com/ranjithrajv/MachO-explorer && cd MachO-explorer

node test/fixtures.mjs --check    #   ~0.1s   the corpus matches its generator
node test/smoke.mjs               #   ~4s     the tools, on binaries they were not written for
node test/mcp.mjs                 #  ~15s     the protocol, driven over a real pipe
node test/schemas.mjs             #   ~3s     every tool's output, against its own schema
node test/mutation-check.mjs      #   ~2m     the historical defects are still caught
```

The counts and verdicts are the claim; the timings only set expectations. `mutation-check.mjs` reintroduces one real historical bug at a time and requires the suite to fail — and a `green npm run test:all` is also a complete rot check. **[CONTRIBUTING.md](CONTRIBUTING.md)** explains what each suite establishes and why the suite runs against two corpora; **[FINDINGS.md](FINDINGS.md)** records the defects that were live while the suite was green.

## Documentation

- **[Architecture](ARCHITECTURE.md)** — how the system is layered, and why each decision was made
- **[Auditability](AUDITABILITY.md)** — the one-file reader, and how to verify it
- **[Findings](FINDINGS.md)** — the defects that were live while the suite was green, and the check each one now has
- **[User manual](docs/user-manual.md)** — every subcommand, every flag, and what each refuses to do
- **[When to use this](docs/use-cases.md)** — the right and wrong tool for the job
- **[The machine contract](docs/machine-contract.md)** — one envelope, four exit codes, a JSON Schema per tool
- **[Driving it from an agent](docs/agent-integration.md)** — MCP, the skill, and what wastes an agent's time
- **[Gating a build](docs/ci-gate.md)** — exit-status taxonomy, SARIF, the composite action
- **[Text stubs](docs/text-stubs.md)** — what a system dylib exports, now that it is not a file
- **[Conformance corpus](conformance/)** — hold any Mach-O parser to known answers
- **[Browser demo](demo/)** — the reader running client-side, with no upload

## Contributing

Pull requests welcome, with one thing to read first: the scope above is a decision, not a backlog. **[CONTRIBUTING.md](CONTRIBUTING.md)** covers the test for anything on the "will not do" list, the no-application-knowledge boundary, the gate a change has to pass, and what a new tool owes the package.

## Licence

**MPL-2.0.** See [`LICENSE`](LICENSE). It has no opinion about, and no access to, the contents of the files it is pointed at. **Nothing proprietary ships here** — no key material, no product data, no disassembly of any product, no asset bytes — and that is enforced rather than reviewed: `boundary:` checks scan `src/`, `test/` and the published tarball and fail on a vendor name, title or container format appearing in any of them.
