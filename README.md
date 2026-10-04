# MachO-explorer

[![test](https://github.com/ranjithrajv/MachO-explorer/actions/workflows/test.yml/badge.svg)](https://github.com/ranjithrajv/MachO-explorer/actions/workflows/test.yml)

Mach-O binary introspection for **macOS, iOS, iPadOS, tvOS, watchOS and
visionOS** binaries — thin or universal, 32-bit or 64-bit, `arm64`, `arm64e`,
`arm64_32`, `x86_64`, `i386`, `armv7`, `armv7k`. Reads fat headers, symbol
tables, sections and `__text`, and answers questions about an executable you know
nothing about. **It knows nothing about any application** — no formats, no
products, no save files. Every answer is a fact about the file format or about
the bytes.

**Mach-O is the whole scope, chosen.** This is a tool built around one format,
not a toolkit that happens to include one, and that focus is what pays for the
depth. It decodes *instruction boundaries* and *direct* branch displacements —
lengths and edges, which are facts about the bytes — and stops there. It does not
print mnemonics or operands, and it will not grow to.

## Quick start

```sh
macho-explorer describe /usr/local/go/bin/go       # what is in this file?
macho-explorer describe --sections /usr/local/go/bin/go   # every section
macho-explorer sym 'runtime.main' /usr/local/go/bin/go
macho-explorer symlookup 0x100085c30 -b /usr/local/go/bin/go
macho-explorer findcall --list /usr/local/go/bin/go 20
macho-explorer findliteral LZ4 "/Applications/Some App.app"
macho-explorer a2o 0x100085c30 -b /usr/local/go/bin/go
macho-explorer o2a 0x85c30 -b /usr/local/go/bin/go
macho-explorer disasm 0x100085c30 /usr/local/go/bin/go
macho-explorer findcall --json 0x100085c30 /usr/local/go/bin/go | jq '.count'
```

No dependencies, no build step, no install, no network. Node ≥ 22.15.

## Install

```sh
npm install -g macho-explorer
```

Or vendor `src/`. Or copy **`src/macho.mjs` alone** — it imports nothing but
`node:fs`, so the whole raw reader is one auditable file with no `node_modules`,
no lockfile and no install step.

## Subcommands

| | |
|---|---|
| `describe` | What is in this file? Every slice, architecture, extent, platform, filetype, symbol counts, `__TEXT` bounds, UUID, header flags, section types and attributes, entry point, rpaths, source version, linked libraries — plus `--sections`, `--segments`, `--loads` for full listings. Reports abnormalities when a header disagrees with the file |
| `sym` | Search a symbol table by substring, or by regex with `--regex`. Imports marked rather than shown as `0x0` |
| `symlookup` | Which function contains this vaddr? Reads symbols directly, because `nm` on a large universal binary is unusable |
| `findcall` | Direct `call`/`jmp` xrefs to an address — or `--list` for the distinct targets a binary calls |
| `findliteral` | Find a byte literal anywhere in a file, per slice, with context — or `--strings` to list what the binary already contains |
| `mapliteral` | Map a literal to vaddrs, then find the pointers to them — which is how you find the code that handles a format |
| `a2o` | Which byte of the file is this vaddr? Both the slice-relative and the absolute offset, and zero-fill as its own answer |
| `o2a` | Which vaddr does this file offset have? Every slice's answer, since one offset means a different address in each |
| `disasm` | Where do instructions start and end at this address, and where do they branch? Instruction lengths plus resolved direct branch edges for `arm64`, `arm64e` and `x86_64` — bytes, not mnemonics |
| `audit` | Is this file internally consistent? Every structural claim it makes about itself, checked, with a verdict and an exit status a build can gate on |
| `fingerprint` | Is this the same program as that one? A digest that survives a rebuild, which a byte comparison cannot |
| `diff` | What changed between two binaries — structural facts only, so a rebuilt pair does not read as a different program |
| `overview` | The whole picture in one call: every slice, segment, section, load command, flag, UUID and entry point, plus `--symbols` and `--strings` on request — all read from one slice, and carrying a `notRead` list of what this package does not parse |
| `mcp` | Serve the tools over the Model Context Protocol (JSON-RPC on stdin/stdout) |

### Global flags

Every subcommand accepts:

| Flag | Meaning |
|---|---|
| `--json` | Emit one JSON object on stdout; diagnostics go to stderr |
| `-b`, `--binary <path>` | The binary, for subcommands where every positional is a query |
| `--arch=<name>` | Restrict to one architecture. A preference, not a requirement |
| `-q`, `--quiet` | Suppress non-essential output |
| `--color` / `--no-color` | Force or disable color output |
| `-v`, `--verbose` | Diagnostic output |
| `-h`, `--help` | Print usage |
| `-V`, `--version` | Print version |

**An unrecognised flag is a usage error**, exit 2, with a suggestion when the
name is a near miss:

```sh
$ macho-explorer sym --regexx 'runtime\.main' /path/to/binary
unknown flag: --regexx

  did you mean --regex?
```

## Documentation

- **[User Manual](docs/user-manual.md)** — detailed reference for every subcommand, flag, and usage pattern
- **[Envelope Schema](schema/envelope.schema.json)** — JSON Schema for `--json` output
- **[Agent Skill](skill/)** — instructions for AI coding agents
- **[Contributing](CONTRIBUTING.md)** — how to contribute

## When to use this, and when not to

Mach-O tooling splits cleanly into two kinds of thing, and this is only one of
them. MachO-explorer is a **reader**: facts about the file, in milliseconds, not a
disassembler. What it does is get you from "I have a binary and no idea what is
in it" to "here are the four addresses worth opening in a disassembler" in about
a second.

Reach for **this** when:

- you want **one dependency-free file** you can vendor, or read end to end;
- you are on **Linux or Windows** pointing at a Mac binary. The reader is pure
  buffer arithmetic, and `nm` and `otool` do not run off macOS at all;
- the binary is **large and universal**. `nm` on a 476 MB universal binary takes
  minutes; this reads the symbol table directly and answers in milliseconds;
- you want **scriptable, composable queries** rather than a GUI — every tool
  takes `--json`, and `src/api.mjs` is importable;
- you need **literal-level triage**: where is this format magic, what addresses
  does it map to, and what points at them.

Reach for **something else** when:

- you want **Mach-O and everything around it**. [`blacktop/ipsw`](https://github.com/blacktop/ipsw)
  is the closest thing to a superset of this package: 17 `macho` commands and 34
  `dyld` commands as of `ipsw` 3.1.730, covering load commands, chained fixups,
  code signing, entitlements, FairPlay decryption, Objective-C and Swift
  metadata, ARM64 disassembly, and firmware images and dyld shared caches this
  package never looks at. It is MIT, installs from Homebrew, and is the better
  choice for almost every question *except* the two in the table below;
- you want a **complete, general Mach-O parser**.
  [`p-x9/MachOKit`](https://github.com/p-x9/MachOKit) (Swift, the most complete)
  or [`pstirparo/machofile`](https://github.com/pstirparo/machofile) (Python,
  self-contained, malware-analysis lineage) parse load commands, code signing,
  fixups, export tries and Objective-C/Swift metadata;
- you want **several file formats**. LIEF covers ELF, PE and Mach-O in one
  dependency. Mach-O being this project's whole scope is the reason it is not
  here;
- you want to **know what the code does**. Ghidra is free and needs no licence
  server, and these tools are built to hand work *to* one, not to replace one.

### The comparison, concretely

| | MachO-explorer | `ipsw` | MachOKit / machofile | LIEF | `nm` / `otool` | Ghidra / IDA |
|---|---|---|---|---|---|---|
| Dependencies | none | none (~40 MB binary) | none (Swift) / none (Python) | native library | none | large |
| Build step | none | no (prebuilt) | SwiftPM / none | yes | — | no |
| Runs on Linux/Windows | yes | yes (static binary) | Swift: no / Python: yes | yes | no | yes |
| Universal binaries | every slice | every slice | every slice | every slice | `lipo` first | per slice |
| Regex over symbols | yes | yes | no | no | partial | yes |
| vaddr → function | yes | yes (`macho a2s`) | partial | no | no | yes |
| vaddr → file offset | yes | yes (`macho a2o`) | no | no | no | by hand |
| file offset → vaddr | yes | yes (`macho o2a`) | no | no | no | by hand |
| Zero-fill reported as its own case | yes | no ¶ | no | no | no | no |
| Linked libraries, per linkage (`otool -L`) | yes | yes | yes | yes | `otool -L` | by hand |
| Platform, `minos`/`sdk`, filetype, `cryptid` | yes | yes | yes | yes | `vtool -show`, `codesign` | by hand |
| Direct-call xrefs | yes | **no** † | no | no | no | yes |
| Indirect / PLT xrefs | **no** | no | no | no | no | yes |
| Literal → vaddr → pointers | yes | **no** † | no | no | no | by hand |
| Scan restricted to code sections | yes | **no** † | no | no | n/a | yes |
| Objective-C / Swift metadata | **no** | yes | yes | partial | no | yes |
| Code signing / fixups | **no** | yes | yes | yes | `codesign` | partial |
| Instruction boundaries (lengths) | yes | ARM64 only ‡ | no | no | no | yes |
| Direct branch edges from a known address | yes | ARM64 only ‡ | no | no | no | yes |
| Disassembly to text — mnemonics, operands, CFG | **no** | ARM64 only ‡ | no | no | no | yes |
| JSON output | yes | partial § | manual | yes | no | yes |
| Importable as a library | yes | yes (Go, `ipswd`) | yes | yes | no | limited |
| Reproducible offline test gate | **yes** | no | partial | n/a | n/a | partial |

The four bolded gaps in the MachO-explorer column are deliberate. They are the ones
where a general parser or a disassembler is strictly better, and closing them
here would mean becoming one of those projects instead of this one.

`a2o` and `o2a` close a gap `ipsw` also has, and the reason it is worth saying
is that the obvious implementation of both is wrong in the same direction. A
section's file `offset` is relative to its slice, and `__bss` records an offset
of 0 while having a non-zero size — so a reader that walks sections without
asking whether they occupy bytes resolves the Mach-O header into `__bss`. In
`go` that is a prefix of the file measured in hundred-odd kilobytes. `a2o`
reports both the slice-relative and the absolute offset, and treats zero-fill as
its own answer.

`ipsw` wins almost every row above, and that is the honest shape of the
landscape: it is the superset, this is the subset. The three rows marked † are
the ones where it has no answer at all, and they are the reason this package
still exists:

- **`ipsw` has no cross-reference command for a standalone Mach-O.** Its only
  one is `dyld xref <cache> <addr>`, scoped to a dyld shared cache rather than a
  file, and marked `🚧 [WIP]` by its own author. `findcall` works on a single
  binary, covers arm64 `BL` and x86_64 `rel32`, and can be restricted to code
  sections so a data coincidence does not read as a call.
- **Nothing in `ipsw` searches for an arbitrary byte literal and then follows
  the pointers to it.** `macho info --strings` prints `__cstring`;
  `findliteral` scans any byte sequence anywhere in the file, and `mapliteral`
  turns each hit into a vaddr and finds what references it.

‡ Its disassembler is ARM64-only and says so in the source — `macho_disass.go`
returns `can only disassemble arm64 binaries` on any other CPU — so on x86_64,
`findcall` and `disasm` cover ground `ipsw` does not reach at all.

¶ `macho a2o` and `macho o2a` return an offset for any address, including one
inside `__bss` — which has an address, a size, and no bytes in the file, because
the loader supplies zeros. The offset it reports there is arithmetic that does not
correspond to a readable byte. `a2o` reports that case as `zerofill: true` with
no offset, because "mapped, and there is a byte" and "mapped, and there is none"
are different facts and a patch script needs to tell them apart.

§ `--json` is on `macho info` and `macho disass` but absent from `macho a2s`,
`macho a2o`, `macho o2a` and `macho dump`, so a pipeline cannot rely on it
uniformly. Every tool here has it, and the envelope shape is the same across all
of them.

The full row-by-row comparison, taken from `ipsw`'s source tree rather than its
README, is in [`FEATURE-PARITY-IPSW.md`](FEATURE-PARITY-IPSW.md).

## What it will not do

Worth stating as a decision, because a gap and a refusal read the same in a
table and only one of them survives a contributor with good intentions and too
much time:

| Will not | Because |
|---|---|
| **Disassemble to text** | `disasm` gives instruction lengths and direct branch edges, which is the last step before a real disassembler and the only part that a byte-level reader can do without guessing. Past that — mnemonics, operands, a control flow graph — is Hopper or Ghidra's job, and duplicating it is the clearest possible way to become a worse Hopper |
| **Resolve indirect / PLT calls** | The target is not in the instruction; it is a pointer reachable only by following the register through a stub and then through `LC_DYLD_CHAINED_FIXUPS` or a bind, and none of which is read here. A wrong edge here would be worse than a missing one: it would look like a call graph |
| **Read dSYM / DWARF** | A different file format and a large amount of code for the minority of binaries whose symbols are in a sidecar |
| **Parse ObjC/Swift metadata** | MachOKit does this properly and is better at it. Duplicating it is the clearest possible way to become a worse MachOKit |
| **ELF or PE** | Mach-O is the focus, not the first of four. Depth in one format beats breadth across several |
| **FAT64 containers** | A fat header with 64-bit slice offsets (`FAT_MAGIC_64`) is refused rather than half-read: its offset type is wider than the 32-bit one every other field uses, and reading it as 32-bit would resolve a slice to an offset inside the file's first 4 GiB. Linux's `objdump` rejects it too, so the refusal is the portable one |
| **Code signing, fixups, export tries** | LIEF and `codesign` cover them, and none of them changes which function a vaddr lands in |

The test for anything on that list is not "is it hard" — indirect call
resolution is genuinely hard, which is why it stays out. The test is whether
closing the gap would make this package *worse at the thing it is for*. A
package that answers 40% of a question is useful; one that answers all of a
question it was never built for is not.

## Verify it yourself, in about five seconds

Every correctness claim in this README is reproducible on a clean checkout,
offline, with nothing installed — no `npm install`, no fixture download, no
network:

```sh
git clone https://github.com/ranjithrajv/MachO-explorer && cd MachO-explorer

node test/fixtures.mjs --check    #  ~0.1s   the corpus matches its generator
node test/smoke.mjs               #  ~4s     the tools, on binaries they were not written for
node test/mcp.mjs                 #  ~15s    the protocol, driven over a real pipe
node test/skill.mjs               #  ~3s     the agent instructions match the tools
node test/mutation-check.mjs      #  ~2m     the historical defects are still caught
```

The four fast numbers are wall-clock on an M-series laptop and are there to set
expectations, not to be asserted. The counts and verdicts are the claim.

Each is a different kind of evidence: `--check` re-derives every byte of the
generated corpus, so a hand-edited or stale fixture cannot pass as a test;
`smoke.mjs` runs the tools against binaries they were not written for and
asserts its own coverage; `mcp.mjs` drives a real subprocess over a real pipe
and parses **every** line of stdout, so a stray write on any code path turns a
test red rather than a user's session green; `skill.mjs` holds the agent-facing
prose to the tree, so an instruction cannot name a flag that does nothing or an
exit code that means something else. `mutation-check.mjs` reintroduces one real
historical bug at a time and requires the suite to fail, with an inconclusive
mutation failing the run rather than counting as caught.

**A green `npm run test:all` is also a complete rot check** — the fixtures pin
exact addresses and counts, so a new toolchain release cannot silently change
what the readers do. CI runs four jobs, with the reader suite on macOS, Linux and
Windows.

Two of them also run before you commit. Clone once and enable the versioned
hooks:

```sh
git config core.hooksPath .githooks
```

`pre-commit` runs the corpus check and the reader suite; `pre-push` adds the
protocol and skill suites. The mutation check is in neither, because ~2m on every
commit is how a fast gate stops being run — it stays in CI and in `test:all`.
Both hooks **refuse rather than pass** when they cannot run, so a clone without
`node` on `PATH` is told so instead of reporting a green it did not earn.

`CONTRIBUTING.md` has the detail: what each check establishes, why the suite runs
against two corpora, and the four defects in this project's own history that a
test suite reported green.

## Contributing

Pull requests welcome, with one thing to read first: the scope above is a
decision, not a backlog. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the test
for anything that would join the "will not do" list, the no-application-knowledge
boundary, the gate a change has to pass, and what a new tool owes the rest of the
package.

## Licence

**LGPL-3.0-or-later.** See [`LICENSE`](LICENSE) for the GNU Lesser General Public
License v3, and [`COPYING`](COPYING) for the GNU General Public License v3 that it
incorporates — both are required, since LGPLv3 is defined in terms of GPLv3.

It has no opinion about, and no access to, the contents of the files it is
pointed at.

### Provenance

This reader was written while reversing a commercial product, and it is
published from a workspace whose disclosure for those projects lives in the
sibling project's `NOTICE.md` — reach it from the repository root rather than by
link here, because this package is published to npm on its own. **Nothing
proprietary ships here**: no key material, no game data, no disassembly of any
product, no asset bytes, and the only inputs it ever reads are the Mach-O files a
user points it at. That is enforced rather than reviewed — four `boundary:` checks scan `src/`,
`test/` and the published tarball and fail on a publisher, a title or its
container format appearing in any of them.

**The licence does not extend to that product.** LGPL covers this code. It does
not license anyone else's intellectual property, and reading a file format out of
a binary does not make the binary yours to redistribute.
