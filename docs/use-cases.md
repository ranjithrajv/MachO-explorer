# Where this reader is the right tool

MachO-explorer is a **reader**, and the honest competitive picture is in
[COMPETITIVE-LANDSCAPE.md](../COMPETITIVE-LANDSCAPE.md): `ipsw` is a superset,
Ghidra is a better disassembler, LIEF is a better general parser. So the useful
question is not "is this the most capable tool" — it is "which jobs is it
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
