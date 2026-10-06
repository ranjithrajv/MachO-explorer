---
name: macho-explorer
description: Reads Apple Mach-O binaries without otool, nm or a disassembler. Answers what is in a binary, which function contains an address, what directly calls a given address, where a byte literal or file-format magic lives in the file, and which code points at it. Works on macOS, Linux and Windows, including universal binaries and stripped ones. Use when inspecting a Mach-O, a .app bundle, an iOS binary, a dylib, a Go/Rust/Swift/ObjC executable, or when handed a crash-log address, a "what is this binary" question, or a magic number to trace back to its handler — even when MachO-explorer is not named.
license: LGPL-3.0-or-later
metadata:
  version: "1.0.0"
  macho-explorer-version: "0.1.0"
---

# MachO-explorer

Mach-O introspection in pure JavaScript. No dependencies, no build step, no
install: Node ≥ 22.15 and either the CLI or an MCP server.

**It is a reader, not a disassembler.** Every answer is a fact about the file
format or the bytes. Hand the addresses it produces to a disassembler; do not
try to make it decode code.

## Reading the file's structure

`describe` is also the only tool here that shows you the map: every
segment, every section with its address and size, every load command by name,
the build's UUID — the one field that says *which* build this is rather than
what is in it — and the platform and filetype, which say whether you are holding
an iOS binary, a framework or a command-line tool.

```sh
describe --sections /path/to/binary   # segment,section  addr..end  size  code|data
describe --segments /path/to/binary   # name  vm range  file range
describe --loads    /path/to/binary   # LC_SEGMENT_64, LC_LOAD_DYLIB, LC_UUID, ...
describe --arch=arm64 /path/to/binary # one slice of a universal binary
```

The `code`/`data` marking is the same signal `findcall` types its scan by,
so the two can be checked against each other.

Load commands are **named, not interpreted** — with four families decoded. Knowing
a binary declares `LC_CODE_SIGNATURE` or `LC_DYLD_CHAINED_FIXUPS` is a fact about
it; parsing the signature or walking the fixups is not something these tools do.

Four families are interpreted rather than merely named, because their values are
plain fields rather than another format:

| | `--json` | |
|---|---|---|
| `LC_RPATH` | `rpaths` | the `@rpath` search paths, in declaration order |
| the `dylib_command` family | `dylibs`, `installName` | what the binary must find to load — see below |
| `LC_SOURCE_VERSION` | `sourceVersion` | the five-part `A.B.C.D.E` version |
| `LC_MAIN` | `entryPoint` | the entry point |

`dylibs` is the answer to "what does this need to run", and each entry keeps its
own `linkage`, because the five commands differ in what a *missing* library
means — `'weak'` tolerates absence, `'load'` does not, `'reexport'` also
republishes that image's symbols, `'lazy'` defers, `'upward'` is satisfied by an
older image already loaded. `installName` is separate because a dylib's own
`LC_ID_DYLIB` names *itself*, not a dependency.

Expect `dylibs: []` on a modern macOS executable. System libraries arrive
through `LC_DYLD_CHAINED_FIXUPS` and are not on disk as Mach-O at all — an empty
list is the correct answer, not a gap in the reader.

**`entryPoint.vaddr` is always `null`.** The header calls `LC_MAIN`'s `entryoff` a
`__TEXT` offset and measurement does not bear that out — on a real 113 MB binary it
resolves into `__LINKEDIT`, and on a dyld shared-cache stub it points at code the
file does not contain. Do not compute `__TEXT.vmaddr + entryoff` yourself; use the
raw `entryoff` and treat `vaddr: null` as the honest answer.

Header `flags` are decoded into names (`MH_PIE`, `MH_TWOLEVEL`, `MH_NOUNDEFS`, …),
and a bit the reader cannot name is reported separately as `flagsUnknown` rather
than dropped. Each section's `flags` are split into `type` (`S_CSTRING_LITERALS`,
`S_SYMBOL_STUBS`, …) and `attributes` (`S_ATTR_PURE_INSTRUCTIONS`, …) — two
disjoint halves of one word, so a section is routinely `code` *and* `S_REGULAR`.

## Three questions about two binaries

"Is this the same thing?" has three answers, and `cmp` gets both directions wrong:
two builds of one source differ in every address (PIE and ASLR move them), in the
dylib version fields and in any timestamp, while two *different* programs built
from one template differ in almost nothing structural.

| ask | tool | the answer |
|---|---|---|
| same build? | `fingerprint` | identical `uuid` — exact, useless once anything relinks |
| same program? | `fingerprint` | identical `fingerprint` — survives a rebuild |
| what changed? | `diff` | structure and literal content, so a rebuilt pair reads as unchanged |

```sh
fingerprint a.dylib b.dylib          # "same program, rebuilt"
diff a.dylib b.dylib                 # 0 differences, exit 0
```

`diff` keeps three lists apart and only the first decides the verdict:
`differences` (structure and literal strings), `buildMetadata` (UUIDs, signing —
reported, never counted) and `sizeChanges` (a recompiled dependency moves a size
without changing the program). **A UUID difference is never a structural
difference.** If you see one in `differences`, that is a bug worth reporting. An
added or removed literal string *is* one: it does not move on a rebuild, so it is a
change to the program. Strings are compared by text, since the whole point is that
their addresses differ.

Check `tier` before relying on a `fingerprint` match: `structure-only` means the
binary is stripped, so the match rests on section and load-command shape alone —
two different stripped binaries with the same sections share a fingerprint.

## Is this file even sound? — `audit`

Run this before trusting anything else. It checks every structural claim the file
makes about itself and returns a verdict plus `clean` / `strictClean`.

```sh
audit /path/to/binary                 # exit 0 sound, 1 unsound, 3 unreadable
audit --strict ./dist/*.dylib
```

Every finding carries a **severity**, and that is what you branch on:

| `severity` | means |
|---|---|
| `error` | the file disagrees with itself — extents point at bytes that are not there, so addresses computed from it may be wrong |
| `warning` | it parsed and the answers are probably right, but something is unfamiliar or explicitly heuristic |

Branch on `clean`, never on `verdict`: `verdict: "warnings"` with `clean: true` is
a **passing** audit, and an exit status derived from the label instead of the
boolean would fail a build over a binary this tool calls sound.

Findings are reported *alongside* a successful parse, never instead of one — a
damaged file still returns the sections and symbols that could genuinely be read.
So a non-empty `findings` means "these specific parts are untrustworthy", **not**
"discard everything above".

Two things are deliberately **not** findings, and both would otherwise make the
tool cry wolf: unknown *load commands* (named by number on purpose — unfamiliar is
not broken), and an `LC_MAIN` entry point outside `__TEXT` (normal for a dyld
shared-cache stub, and also seen on a fully-symbolled 113 MB `node`).

## A policy gate — `assert`

`audit` gates a file on its *internal* consistency; `assert` gates it on facts
you supply. A release build usually wants both.

```sh
assert build/Contents/MacOS/app \
    --has-symbol=_main --no-symbol=_NSLog --has-string="https://"
```

Four predicates, repeatable, with two matching rules:

| flag | matches |
|---|---|
| `--has-symbol` / `--no-symbol` | the **whole** symbol name — a substring would pass on `_main_helper` when asked about `_main` |
| `--has-string` / `--no-string` | a **substring** of any NUL-terminated string — the useful claim is that a URL or an error message is present |

Exit **0** only when every assertion holds, **1** when at least one does not. A
failed assertion is data, not an error: `errors` stays empty and `data.passed` is
the verdict, the same shape `audit` returns. An empty value is rejected —
`--has-string ""` is true of every binary, so accepting it would install a gate
that can never fail.

### When `abnormalities` is non-empty

`describe` reports structural problems **alongside** a successful parse, never
instead of one: a damaged file still answers every other question, and the result
still carries the sections and symbols that could genuinely be read. So a
non-empty `abnormalities` means "this header disagrees with this file", not "nothing
here is trustworthy" — read what was recovered, and treat the named parts as
suspect:

| `kind` | what it means |
|---|---|
| `unknown-header-flags` | a flag bit `<mach-o/loader.h>` gives no name to — a newer toolchain, or a patched header |
| `load-commands-truncated` | the header claims more load commands than the file contains, so the section and symbol tables may be incomplete |
| `strtab-past-slice-end`, `symtab-past-slice-end` | the symbol or string table reaches past the end of the slice |
| `section-past-slice-end`, `segment-past-slice-end` | a section or segment claims bytes the slice does not have |
| `symtab-strtab-overlap` | the two tables overlap, which no linker emits |
| `strtab-high-entropy` | the string table's bytes are too uniform to be text — possibly compressed or obfuscated. A heuristic; it invites a look, it does not conclude |

An **unknown load command is not an abnormality** — those are named by number by
`--loads` on purpose, so an unfamiliar-but-valid command is not graded as damage.

## Many binaries at once

`sym --in` searches a file **or a directory**, and the answer arrives in the same
envelope as a single-binary search — `data.files[]` instead of `data.matches`.

```sh
sym CCCrypt --in ./artifacts --matched-only --json
sym --all-imp _objc_msgSend --in ./build --per-file=0    # counts only
```

Other tools search directories too, but not through one uniform door, which is the
part that matters if you are writing a pipeline: a consumer that can read one
binary's output can read four thousand.

Three things it keeps apart, each of which is a distinction rather than a detail:

- **non-Mach-O files are skipped, not failed.** A build tree is full of plists and
  headers. `totals.skipped` counts them.
- **a path that does not exist is reported**, per file, with reason code `io`.
- **`totals.files` is not `totals.looked`.** The first counts every Mach-O found;
  the second only those actually read. Use `looked` whenever you would otherwise
  write "N files read".

Exit status: **0** something matched, **1** nothing matched, **3** nothing could be
read at all. 3 versus 1 matters — "no matches" and "could not look" are different
answers, and treating the second as the first concludes a build contains no such
symbol when in fact nothing was readable.

## Listing what a binary already contains

To see its strings without knowing one in advance:

```sh
findliteral --strings /path/to/binary
findliteral --strings --min=8 --filter=error /path/to/binary
```

Each string carries its address and its section, so it can be handed straight to
`symlookup`. This reads `__cstring`, `__objc_methname`, `__swift5_reflstr`
and `__objc_classname`.

**It finds nothing in a Go binary.** Go keeps its strings length-prefixed inside
`__gopclntab`, not NUL-terminated, so there is no terminator to scan for and zero
is the correct answer. Use `sym` on a Go symbol, or `findliteral`
with a substring you already know, instead.

## One call instead of four — `overview`

When you need the whole picture rather than one fact about it, `overview` is one
invocation instead of `describe` + `sym` + `findliteral --strings`, and it is the
only one that guarantees all three read the *same* slice of a universal binary:

```sh
overview /path/to/binary                     # structure only
overview --symbols /path/to/binary            # plus the symbol table
overview --strings --symbols --max=200 /path/to/binary
overview --json --compact --symbols /path/to/binary | jq '.data.symbols.count'
```

`slices` is exactly what `describe` returns, field for field, so
`.data.slices[0].sections` means the same thing in both.

**The inventories are capped at 4000 rows by default, and the cap is reported.**
`truncated: true` and a note saying how many were dropped come with a shortened
list. A short list that does not say it is short is worse than no list, because
you cannot tell it from a complete one.

**`notRead` is in every result.** It is the list of what this package does not
parse: code signature and entitlements, export trie and chained fixups, ObjC and
Swift metadata, dSYM/DWARF, FAT32. Check it rather than assuming an absent field
means the file has nothing there — that is the difference between a fact and a
gap, and it is why this tool is not called `dump`.

**Zero is explained, never bare.** No `__cstring` section (a Go binary, or
anything else that packs strings into one blob) reports zero strings *with a note
saying the section is absent*. That is a fact about the file. A stripped slice
reports no defined symbols *with a note saying that*. Neither arrives as an empty
list you have to interpret.

**There is no `overview` on the MCP server, on purpose.** The server keeps one
tool per question, because a tool that answers several answers none of them well.
Use `describe`, `sym` and `findliteral` there.

## Three ways in, in order of preference

**1. The MCP server**, if one is configured — the tools are already there and
return structured answers:

```
describe  sym  symlookup  findcall
findliteral  mapliteral  a2o  o2a  dump
starts  audit  fingerprint  diff  assert
```

**Not on the MCP server:** `overview`, `disasm` — use the CLI for these.

**2. The CLI**, which needs nothing configured:

```sh
describe    /path/to/binary
sym         'runtime.main' /path/to/binary
symlookup   0x100085c30 -b /path/to/binary
findcall    0x100085c30 /path/to/binary
findliteral LZ4 "/path/to/Some App.app"
mapliteral  LZ4 /path/to/binary
a2o         0x100085c30 -b /path/to/binary     # address  → file offset
o2a         0x85c30 -b /path/to/binary          # file offset → address
dump        0x100085c30 /path/to/binary         # the bytes at an address, bounded by its section
starts      /path/to/binary                    # where functions begin
assert      /path/to/binary --has-symbol=_main --no-string=debug
disasm      0x100085c30 /path/to/binary         # where instructions start, and where they branch
overview    --symbols /path/to/binary           # everything at once, one slice, one call
```

**3. The library**, when you are writing code:

```js
import { describe, overview, searchSymbols, lookupAddress, findCalls,
         listCallTargets, findLiteral, mapLiteral } from 'macho-explorer';
```

From a checkout with nothing installed, `node src/describe.mjs <binary>` works —
and `src/macho.mjs` alone is one auditable file that imports nothing but
`node:fs`, so it can be copied into a project outright.

**Validating the answers.** Every tool emits one envelope, and `schema/` holds a
JSON Schema per tool — `schema/audit.schema.json`, `schema/a2o.schema.json`, and
so on — each composed from `schema/envelope.schema.json` with `data` constrained
to what that tool actually returns.

```sh
macho-explorer audit --json app | ajv validate -s schema/audit.schema.json
```

The envelope is **closed** (a typo'd field is rejected, so `errorss` does not read
as "no errors"); `data` is deliberately **open**, so a bug fix can add a field
without a major version bump. Check `schemaVersion` against the value you were
written against rather than trusting the field names.

The browser audit report — where the reader runs in a tab and you can read the
source that read your file — is published at the repository's GitHub Pages site,
and `npm run demo` serves the same thing locally.

### Reading a `.app`

Pass the bundle; the executable inside is found automatically. Anywhere a binary
is accepted, a bundle is too.

## The workflow that actually works

Reverse-engineering a binary is a loop, and skipping the first step is how you
end up reading addresses that were never in that slice.

1. **`describe`** first, always. It tells you how many slices there are,
   which architecture each is, whether there is a symbol table to search at all,
   where `__TEXT` starts, and the build's UUID. On a universal binary everything
   after this needs `--arch` or it silently reads one arbitrary slice.
2. **`sym`** to turn a name into an address.
3. **`symlookup`** to turn an address back into a function — the way to
   make sense of an address from a crash log.
4. **`findcall`** for who calls it.
5. **`findliteral`** for where a format magic sits, then
   **`mapliteral`** for which code points at it. `mapliteral` searches all
   sections (not just `__TEXT`), so it finds literals in `__cstring` too —
   the section name is reported per hit. This pair is the one with
   no equivalent in `ipsw`, Ghidra or `otool`.

To go the other way — from an address to the file position to read bytes —
`a2o` then `o2a`. To read the bytes themselves, `dump`: it resolves the address
through its section and stops at that section's end, so it never blends
`__cstring` into `__const` or the tail of `__text` into whatever the linker
packed after it. `--len` caps how many bytes; the section end clamps below it and
`truncated` says when.

```sh
dump 0x100085c30 /path/to/binary          # 64 bytes at the address, as hex + ascii
dump --len=16 0x100085c30 /path/to/binary
```

An address can reach a byte, be mapped with no byte (`__bss`, `__PAGEZERO`), or
be in no slice at all. `dump` reports all three as values — `zerofill` and
`mapped` tell them apart — and exits 1 for the two "no byte" cases, which are
answers rather than errors.

## The literal-to-pointer recipe — find the code that handles a format

This is the workflow with **no equivalent in `ipsw`, Ghidra, `otool`, Hopper or
`jtool2`**, and it is the one to reach for when the question is "which code in this
binary handles format X". Three steps, each one answering a question the previous
one made askable.

**Step 1 — find the magic.** `findliteral` searches the whole file by default,
not just `__TEXT`, which matters because a format's magic often lives in a
`__cstring` next to its name rather than in code.

```sh
findliteral '\x1f\x8b' /path/to/binary          # a gzip header, as escapes
findliteral LZ4 --json /path/to/binary          # a readable substring
findliteral --json LZ4 /path/to/binary | jq '.data.hits[] | {off, vaddr, section}'
```

Each hit carries `off` (file offset), `vaddr`, `section`, and the surrounding
bytes as context. Escapes work because the match is raw latin1.

**Step 2 — map it to addresses.** `mapliteral` turns each occurrence into the
virtual address it loads at. Pass the offsets from step 1 as **positional
arguments** to skip the search pass:

```sh
mapliteral LZ4 /path/to/binary                  # search and map
mapliteral LZ4 /path/to/binary 0x8a40          # map offsets you already found
```

The positional order is `<literal> [binary] [file-offset ...]` — the binary comes
second, so it must be named before the offsets. With `-b` the binary moves out of
the positionals entirely and the offsets stand alone:

```sh
mapliteral LZ4 -b /path/to/binary 0x8a40 0x8b10
```

**Step 3 — find what points at it.** The same call reports every pointer in the
binary that references those addresses — the descriptor table, the vtable, the
dispatch array. **These are the addresses worth disassembling.** That set is the
answer to the question; everything before step 3 was in service of asking it.

```sh
mapliteral LZ4 --json /path/to/binary \
  | jq -r '.data.locations[].pointers[] | "\(.vaddr) \(.section)"'
```

Then hand those to `symlookup` to name them, and to `findcall` for their callers.
`mapliteral` searches **all** sections, not just `__TEXT`, and reports the section
per hit — so a magic in `__cstring` is found the same way as one in code.

Two answers this recipe must read correctly:

- **No pointers at all** means nothing dispatches on this magic *by reference*, so
  it is matched inline — a single comparison against a constant, or assembled at
  runtime. That is a real answer about the program's shape, not a failure.
- **No literal at all** means the value is never stored contiguously. It is built
  at runtime from parts, or obfuscated. Go to `findcall` on the handler you
  already suspect, or pass explicit offsets if you know where to look.

## Gating a build — `audit`, `--sarif`, and the composite action

`audit` is not just a report: its **exit status is the product**, and it is the
one tool here designed to be a CI gate.

```sh
audit  /path/to/binary        # 0 sound · 1 unsound · 2 usage · 3 could not read
audit  --strict /path/to/binary   # warnings fail too
audit  --sarif /path/to/binary > audit.sarif   # SARIF 2.1.0, for Code Scanning
audit  --json /path/to/binary | jq '.data.strictClean'
```

The four codes are the whole design. **1 is a negative answer, not an error** — an
audit that found something wrong has done its job. **3 is "could not read the
file"**, which is *not* a passing audit: a mistyped path in a CI script must never
read as a clean bill of health.

Branch on the **booleans**, not the label: `data.clean` (the default gate) and
`data.strictClean` (`--strict`). `verdict` is `ok` / `warnings` / `failed` and is
a **label for a person** — `verdict: "warnings"` with `clean: true` is a
*passing* audit, and mapping the label onto the exit status fails a build over a
binary the reader says is fine.

`--strict` is off by default on purpose. A binary built by an Xcode newer than
this reader sets a header flag bit the reader has no name for, and failing every
build over that trains people to stop running the gate. **A gate that only fires
on genuine damage is a gate people leave on.** Turn it on for a release gate where
you control the toolchain.

If you find yourself wanting to disable the gate on some builds only, that is the
signal to fix the toolchain rather than to split the gate — an audit that is
sometimes skipped is an audit that is eventually always skipped.

`--sarif` gives GitHub Code Scanning findings named by the reader's own `kind`, so
a second run matches the first run's findings rather than filing a new alert every
build. `--sarif` and `--json` are two formats for one answer and cannot be
combined; combining them is a usage error rather than a precedence rule, because
silently preferring one produces a `.sarif` file containing JSON that fails to
parse much later with an error that names neither flag.

There is also a **composite GitHub Action** so none of this needs writing:

```yaml
- uses: ranjithrajv/MachO-explorer@main
  with:
    binary: build/Some.app/Contents/MacOS/Some
    baseline: known-good/Some        # enables the fingerprint and diff jobs
    sarif: true
```

It has **no install step** — it runs the reader from the checked-out source, so
the gate tests this commit rather than whatever a version tag resolved to today.
See `action.yml` for the inputs and outputs.

**When comparing two builds**, `fingerprint` answers a question `cmp` gets wrong in
both directions, and `fingerprint --sarif` turns "these are not the same program"
into a finding on the commit:

```sh
fingerprint built.app known-good.app      # 0 same program · 1 different · 3 unreadable
fingerprint --sarif built.app known-good.app > fp.sarif
```

`diff` is the companion and is **deliberately not a gate**: it reports three lists
and only the first decides the verdict, because a UUID change and a section-size
change are facts about a *build* while a changed literal string is a change to the
*program*. Turning any of them into a failure is a policy decision, and a policy
belongs in `assert` where it can be written down and reviewed.

## Where functions begin — `starts`

`LC_FUNCTION_STARTS` is the linker's own list of function entry addresses, and it
is the only such list a **stripped** binary carries: the symbol table is gone, but
the command survives because the unwinder needs it at runtime. On a shipped build
it is the difference between a column of addresses and no structure at all.

```sh
starts /path/to/binary                  # every entry, labeled sub_<hex>
starts --symbols /path/to/binary        # name the symbol sitting on each start
starts --max=20 /path/to/binary         # cap the list; the count stays exact
```

Each address is labeled `sub_<hex>` — a name for the address, not a claim about
what the function does. Where a defined symbol sits exactly on a start,
`--symbols` names it too.

`present: false` means the file carries no `LC_FUNCTION_STARTS` at all (an object
file, a hand-built binary), which is an answer rather than an empty list. A start
address is where the linker says a function begins; it is not a boundary derived
from disassembly, and it is not the same as a symbol — a symbol can sit
mid-function, and a function can have no symbol at all.

## Five things that will otherwise waste your time

**Addresses are hex strings.** `"0x100085c30"`, never a JSON number. A 64-bit
virtual address does not survive a JavaScript `Number` — everything above 2^53
loses its low bits, and the resulting address points at real, wrong code rather
than failing. Over MCP the schema rejects a number; in the shell, quote it.

**An empty result is an answer, not a failure.** No matches returns an empty
list and exit status 1. Do not retry it with variations. Distinguish it from a
real failure by the status: **1 means "ran, found nothing"**, 2 is a usage
error, 3 means the file could not be read. `ok:false` with
`errors:["io"]` means the binary is missing; `errors:["unknown-encoding"]` means
it is there and is not a Mach-O. Those are different problems and the codes tell
them apart.

**`findcall` sees direct calls only.** A call through a register, or
through a PLT stub, does not encode its target in the instruction, so it does not
appear. Every hit is a site *worth* opening in a disassembler, not a proven
call-graph edge, and **an empty result does not mean nothing calls the target.**
On x86_64 the scan is typed by section rather than by instruction, so it can also
match a byte inside the middle of a multi-byte instruction. On arm64 it steps 4
bytes and sees only aligned `BL`s.

**A stripped binary has no defined symbols.** `sym` and `symlookup` return
nothing at all rather than guessing — which means a missing `.dSYM` makes those
two useless, while `findcall` and `findliteral` keep working, because
they read bytes rather than names. A binary with only undefined imports (like
`/bin/ls`) is not fully stripped — `sym --regex '.'` will still find the one
defined symbol (`__mh_execute_header`), and `symlookup` will work on it.
When symbols are missing, go straight to `findliteral`/`mapliteral` or to the
byte-oriented tools.

**System dylibs are not on disk any more.** Since macOS 11 there is no
`/usr/lib/libSystem.B.dylib` to point at; the real libraries live inside the dyld
shared cache, which this does not read. If a path under `/usr/lib` turns out not
to exist, that is why — it is not a broken install. Use a real binary instead.

## What it will not do, so you do not have to try

No decompilation, no mnemonics, no operand decoding, no control flow graph. No
indirect or PLT call resolution. No dSYM or
DWARF. No code signature, entitlements, chained fixups, export tries, or
Objective-C and Swift metadata — `describe --loads` *names* those load commands
but does not interpret them. Not ELF, not PE. **Little-endian only** — big-endian
Mach-O (NeXTSTEP on m68k/SPARC, classic Mac OS on PowerPC) is refused as
`unknown-encoding`; a `ppc` slice is named and reported `readable: false`.

`disasm` does decode instruction lengths and resolve **direct** branches
(`x86_64` for `x86_64`, and `BL`/`B`/`B.cond`/`CBZ`/`CBNZ`/`TBZ`/`TBNZ`/`ADR`/`ADRP`
for `arm64`/`arm64e`) — that is what it is for, and it is not a disassembler:
instructions come back as bytes, not as text. Read it as a linear sweep from a
*known-good* address such as a symbol. Sweeping a whole code section decodes
interleaved jump tables and string literals as instructions, and on `x86_64` one
wrong length shifts every boundary after it.

All twelve `MH_*` filetypes are named, but only the loaded-image ones
(`MH_EXECUTE`, `MH_DYLIB`, `MH_BUNDLE`, `MH_DYLINKER`, `MH_KEXT_BUNDLE`, …)
behave as you would expect. **Do not trust addresses from a `MH_OBJECT`**: an
object file is relocatable, so it has no load address — `textAddr` is `0x0` and
symbol values are section-relative offsets. `MH_FILESET` (kernelcache) is named
but its nested Mach-Os are not walked, and `MH_DSYM`/`MH_CORE` carry no code.

Every Apple platform is covered, because they all ship Mach-O: **macOS**
(`x86_64`, `arm64`, `i386`), **iOS and iPadOS** (`arm64`, `arm64e`, `armv7`),
**tvOS** (`arm64`), **watchOS** (`arm64_32`, `armv7k`) and **visionOS**
(`arm64`) — 32- and 64-bit, thin and universal. iPadOS reports as `ios` because
Apple has no separate platform constant for it, and `armv7k` reports as `arm`,
so the platform command is what identifies a watch build rather than the
architecture name.

`describe` reports the platform (`ios`, `macos`, `tvos`, `watchos`, the
simulators), the filetype, and whether an App Store binary's `__TEXT` is
encrypted — which is the one thing that makes a zero result from
`findcall` mean "could not look" rather than "nothing calls this".

When you need to know what the code *does* rather than where it is, use Ghidra
(free, no licence server) or Hopper. That is the intended division: this produces
the shortlist of addresses worth opening, and hands them over — `disasm`
narrows that shortlist to instruction boundaries and direct branch edges, which is
the last step before a real disassembler takes over.

## Scripting notes

- Every tool takes `--json` and emits one envelope: `{tool, ok, binary, errors,
  messages?, notes?, data}`, with stdout carrying only JSON and all prose on
  stderr.
- Addresses come back as `"0x…"` strings, deliberately — see above.
- The binary comes from an explicit argument, then `$MACHO_EXPLORER_BINARY`, then
  `$MACHO_EXPLORER_APP`. `symlookup`, `a2o` and `o2a` take only queries
  as positionals, so their binary must come from `-b` or the environment.
- `--arch=<x86_64|arm64>` is a preference, not a requirement: if that slice is
  absent, another is read and a note says which. Check the note rather than
  assuming you got the slice you asked for.
- **An unknown flag is a usage error, exit 2**, with a suggestion when the name is
  a near miss. If a tool exits 2 and says "did you mean", the answer is in the
  message. Nothing here ignores a flag — that used to be the behaviour on several
  tools and it turned a typo into a confident wrong answer.

## Verifying it works

No install, no network, no fixtures to download:

```sh
node test/fixtures.mjs --check   # the corpus matches its generator
node test/smoke.mjs              # the tools against binaries they were not written for
node test/mcp.mjs                # the protocol, over a real pipe
node test/schemas.mjs            # every tool's real output, against its own schema
node test/sarif.mjs              # the SARIF emitter is well-formed
node test/action.mjs             # the composite action's shell, extracted and run
```

`test/mutation-check.mjs` is the one that matters most and runs slowest: it
reintroduces eleven real historical bugs one at a time and requires the suite to
fail on each. An inconclusive mutation fails the run — a check that cannot fail
reports success, which is worse than a missing check.

`npm run test:all` runs everything in order.

## Registering the MCP server

```sh
claude mcp add macho -- node /absolute/path/to/src/mcp.mjs
```

or in `.mcp.json`:

```json
{ "mcpServers": { "macho": {
    "command": "node",
    "args": ["/absolute/path/to/src/mcp.mjs"],
    "env": { "MACHO_EXPLORER_BINARY": "/path/to/a/binary" } } } }
```

`MACHO_EXPLORER_BINARY` saves passing a path on every call. It speaks both the modern
`2026-07-28` protocol (per-request `_meta`, no handshake) and the legacy
`initialize` handshake, because clients in the wild still use both.

## Licence

LGPL-3.0-or-later. It has no opinion about, and no access to, the contents of the
files it is pointed at.
