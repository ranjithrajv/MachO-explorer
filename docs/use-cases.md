# Where this reader is the right tool

MachO-explorer is a **reader**, and the honest competitive picture is this: `ipsw`
is a superset, Ghidra is a better disassembler, LIEF is a better general parser. So
the useful question is not "is this the most capable tool" — it is "which jobs is it
uniquely the right shape for". There are five, and each is a job the obvious
alternatives do not do at all.

If you are deciding whether to use this at all, read
[AUDITABILITY.md](../AUDITABILITY.md) first: the properties below are consequences
of one design decision — a small, dependency-free, auditable reader.

---

## 1. Embed it as a dependency, not a destination

The package is built to be imported or vendored, and that is the axis it wins on:

```js
import { describe, searchSymbols, findCalls } from 'macho-explorer';
const facts = describe('/Applications/Some.app/Contents/MacOS/Some');
```

- **`src/macho.mjs` alone** imports only `node:fs` and `node:crypto` and is the
  whole reader — copy it into your tree and you have no `node_modules`, no
  lockfile, no install step.
- The **fixture corpus** is exported as `macho-explorer/fixtures`: a
  deterministic Mach-O corpus with known answers, usable in another project's
  parser tests without importing the reader.
- MPL-2.0's file-level copyleft exists so that embedding the reader does not infect the embedding
  application. See the licence note in [AUDITABILITY.md](../AUDITABILITY.md).

This is the job the package is *for*. The remaining four are tool-shaped uses of
the same reader.

## 2. Find the code that handles a format

This is the pair of questions no other Mach-O tool answers on a standalone
binary, and it is the workflow the reader was written for:

```sh
# Where is the magic for this container format, in this binary?
macho-explorer findliteral LZ4 SomeBinary

# Map each hit to an address, then find what points at it —
# which is how you find the code that parses the format.
macho-explorer mapliteral LZ4 SomeBinary
```

`findcall` answers the other direction — the direct `call`/`jmp` sites that reach
an address — and both can be restricted to code sections so a coincidental data
byte does not read as a call. `ipsw` has no cross-reference command for a
standalone Mach-O (its only one is scoped to a dyld shared cache and marked WIP),
so this is genuinely unserved ground.

## 3. Gate a build on a binary's own consistency

`audit` checks every structural claim a file makes about itself and exits with a
status a build can gate on:

```sh
macho-explorer audit dist/MyApp && echo "structurally sound"
```

No competitor ships this. It is the one *tool* use case where the value is a
machine contract rather than a report: a non-zero exit is a build failure, not a
paragraph to read. Pair it with `describe --json` and a JSON Schema
(`schema/envelope.schema.json`) if you want to assert specific fields.

## 4. Tell whether a rebuild changed the program

`fingerprint` and `diff` answer a question a byte comparison cannot:

```sh
macho-explorer fingerprint dist/MyApp      # a digest that survives a rebuild
macho-explorer diff old/MyApp new/MyApp    # structural change, not byte noise
```

Every address, offset, timestamp, UUID and version number is excluded, because a
rebuild moves all of them without changing the program. What is left — sections,
load commands, symbol names — is what a reviewer actually wants to diff. This is
the CI/build-verification job, and again, nothing else here does it.

## 5. Read a binary that cannot leave the machine

For an air-gapped machine, a restricted network, or a binary you are not legally
free to upload:

- **No install, no network, no native library** — pure Node builtins, runs on
  macOS, Linux and Windows against Mac binaries.
- **The browser demo reads locally** — `demo/` parses a dropped binary in the
  tab; the bytes are never uploaded.
- **The parser is one auditable file**, so a reviewer can verify what happens to
  the bytes before allowing it near a proprietary artefact.

This is the same buyer as the provenance note in the [README](../README.md): a
team that wants to look at *its own* shipping binaries, with no interest in
firmware research and no ability to send the bytes to a hosted analyser.

---

## What this is not for

Stated plainly, because a gap and a refusal read the same in a table:

| If you want | Use |
|---|---|
| Disassembly to text, a CFG, a decompiler | Ghidra, Hopper, Binary Ninja |
| Objective-C / Swift metadata, code signing, entitlements, fixups | `ipsw`, MachOKit, LIEF |
| Firmware images, dyld shared caches, kernelcaches | `ipsw` |
| A GUI tree with a hex view on macOS | `everettjf/machoexplorer` |
| A browser workbench with everything in it | `rzweb`, Leviathan |
| ELF or PE | LIEF, `llvm-readobj` |

The full reasoning, and the test a feature has to pass to join either column, is
in the [README's "What it will not do"](../README.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md).

---

## The comparison, concretely

`ipsw` wins almost every row below, and that is the honest shape of the
landscape: it is the superset, this is the subset. The rows marked † are the ones
where it has no answer at all, and they are the reason this package still exists.

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

† `ipsw` has no cross-reference command for a standalone Mach-O. Its only one is
`dyld xref <cache> <addr>`, scoped to a dyld shared cache rather than a file, and
marked WIP by its own author. `findcall` works on a single binary, covers arm64
`BL` and x86_64 `rel32`, and can be restricted to code sections. And nothing in
`ipsw` searches for an arbitrary byte literal and follows the pointers to it:
`macho info --strings` prints `__cstring`, while `findliteral` scans any byte
sequence and `mapliteral` turns each hit into a vaddr and finds what references it.

‡ Its disassembler is ARM64-only and says so in the source — `macho_disass.go`
returns `can only disassemble arm64 binaries` on any other CPU — so on x86_64,
`findcall` and `disasm` cover ground `ipsw` does not reach at all.

¶ `macho a2o` and `macho o2a` return an offset for any address, including one
inside `__bss` — which has an address, a size, and no bytes in the file, because
the loader supplies zeros. `a2o` reports that case as `zerofill: true` with no
offset, because "mapped, and there is a byte" and "mapped, and there is none" are
different facts and a patch script needs to tell them apart.

§ `--json` is on `macho info` and `macho disass` but absent from `macho a2s`,
`macho a2o`, `macho o2a` and `macho dump`, so a pipeline cannot rely on it
uniformly. Every tool here has it, and the envelope shape is the same across all
of them.

The claims above were taken from `ipsw`'s source tree rather than its README,
which matters: `macho diff` is a hidden `panic()` stub, and `macho info --json`
discards every selector combined with it. Neither is visible in `--help`.
