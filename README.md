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

## Auditable by design

The reader is **one file you can read**. `src/macho.mjs` imports only `node:fs`
and `node:crypto`; copy it into an empty directory and it parses real binaries
with no `node_modules`, no build step and no network. That property — not any row
in a feature table — is why this package exists, and
**[AUDITABILITY.md](AUDITABILITY.md)** is the argument for it and the five-second
recipe to check it yourself.

The same file runs in a browser: [`demo/`](demo/) is a drag-and-drop page that
reads a Mach-O **in the tab**, with the bytes never leaving the machine, and
`test/browser.mjs` proves it produces byte-for-byte the same answers as the Node
build on every fixture.

It is also the **audit report** — not just a demo. Every number it states about
itself is fetched from the repository at page load rather than typed into the
page, so a claim cannot survive the thing it describes changing: add a dependency
and the row turns amber, because it is reading `package.json` rather than
reciting a slogan. The "Audit it yourself" panel opens the actual source that read
your file, served from this repository. Published at the repository's GitHub Pages
site; `npm run demo` serves the same page locally on
<http://localhost:8788/demo/>.

## Run it anywhere

One reader, every platform. The same Mach-O analysis runs on a forensic
workstation, a CI runner, a laptop, or a phone — no dependencies, no build step,
no network, no install.

| Platform | How | Use case |
|---|---|---|
| **macOS** | Native CLI | Full analysis on the same platform as the binaries |
| **Linux** | Native CLI | Forensic workstations, CI/CD pipelines, air-gapped environments |
| **Windows** | Native CLI | Enterprise environments, Windows-based analysis labs |
| **Android** | Browser demo or Termux | Field triage — drop a binary, get answers, bytes never leave the device |
| **iOS** | Browser demo | On-device analysis — no upload, no install, no jailbreak |

The browser demo makes it universal: any device with a modern browser can
analyze a Mach-O binary **client-side**. The file never leaves the device —
there is no server, no upload, no cloud. For forensic teams, that means
sensitive binaries can be triaged on-site without network exposure.

On Android, the full CLI runs under [Termux](https://termux.dev), giving you
the complete toolset — `describe`, `sym`, `findcall`, `diff`, `audit`, and
every other subcommand — in your pocket.

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

## Standalone binaries

Every individual tool is available as a standalone binary — no Node.js install
required. Download from [GitHub Releases](https://github.com/ranjithrajv/MachO-explorer/releases):

| Platform | Architectures |
|---|---|
| **macOS** | `arm64`, `x64` |
| **Linux** | `x64` |
| **Windows** | `x64` |

```sh
# macOS / Linux
chmod +x describe-darwin-arm64
./describe-darwin-arm64 /usr/local/go/bin/go          # same flags as `describe`

# Windows
.\describe-win-x64.exe C:\Windows\System32\notepad.exe
```

Binaries are built with Node's built-in SEA (Single Executable Application)
support — the same zero-dependency property, in a single file. Verify a
download against the `checksums.txt` attached to each release.

The unified `macho-explorer <subcommand>` dispatcher is **not** among them: it
loads subcommands with dynamic imports, which cannot be bundled into one file.
Use `npx macho-explorer` for that.

## What it covers

Mach-O, on every platform Apple ships it — which is the whole reason one reader
is enough:

| Platform | Architectures |
|---|---|
| **macOS** | `x86_64`, `arm64`, `i386` |
| **iOS / iPadOS** | `arm64`, `arm64e`, `armv7` |
| **tvOS** | `arm64` |
| **watchOS** | `arm64_32`, `armv7k` |
| **visionOS** | `arm64` |

| | |
|---|---|
| **Format** | thin and fat (universal), 32-bit and 64-bit, little-endian |
| **Filetypes** | all twelve `MH_*` values named — executable, dylib, bundle, dylinker, kext, fileset, dSYM, core, object |
| **Also reported** | the target platform and SDK (`LC_BUILD_VERSION`), and `ppc` / `ppc64` by name |
| **Not covered** | big-endian Mach-O, ELF, PE, the dyld shared cache, firmware images |
| **Hosts** | Linux, macOS and Windows — one Node runtime, no dependencies, no build step |

Five things about that table are worth stating rather than leaving to be
discovered:

- **visionOS needs nothing new.** A Vision Pro binary is arm64 Mach-O — the M2 —
  so the same reader handles it and only the platform constant distinguishes it.
  `LC_BUILD_VERSION` reports `visionos` and `visionos-simulator` separately.
- **iPadOS is reported as `ios`**, and that is the file's doing, not the tool's.
  Apple defines `PLATFORM_IOS` and no separate iPadOS constant, so an iPadOS
  binary says `ios` and reporting anything else would be a fabrication.
- **watchOS is the awkward one.** `arm64_32` is a 32-bit ABI on the arm64
  instruction set, so it uses the *64-bit* Mach-O header with 32-bit pointers —
  `bits: 64` is right about the file and wrong about the pointer. And `armv7k`
  reports as `arm`: the subtype is what makes it a watch, so it is the platform
  command, not the architecture name, that identifies one.
- **Big-endian is refused, not misread.** A PowerPC or 68k slice is named and
  listed in the slice table, but reports `readable: false` with
  `unknown-encoding` rather than being parsed as if its bytes were little-endian
  — so a NeXTSTEP or classic Mac OS binary is visibly unsupported instead of
  quietly wrong.
- **All twelve `MH_*` filetypes are named; four are read with a caveat.** The
  eight loaded-image shapes — `MH_EXECUTE`, `MH_DYLIB`, `MH_BUNDLE`,
  `MH_DYLINKER`, `MH_KEXT_BUNDLE`, `MH_FVMLIB`, `MH_PRELOAD`, `MH_DYLIB_STUB` —
  are what the tools are built for. The other four parse and are named, but the
  address model does not carry over: `MH_OBJECT` is relocatable, so it has no
  load address (`textAddr` is `0x0` and symbol values are section-relative
  offsets, making `symlookup`/`a2o` answers meaningful only relative to the
  object); `MH_FILESET` is named but **not traversed**, so the nested Mach-Os
  inside a kernelcache are not walked; `MH_DSYM` carries only `__DWARF`, which
  this does not read; and `MH_CORE` keeps its state in `LC_THREAD`, not `__text`.

An App Store binary's `__TEXT` is ciphertext, which changes what a zero result
means. That is not a footnote: see
[iOS binaries, and what an encrypted one means](#ios-binaries-and-what-an-encrypted-one-means).

## The tools

| | |
|---|---|
| `describe.mjs` | What is in this file? Every slice, architecture, extent, **platform** (ios / macos / tvos…), **filetype**, symbol counts, where `__TEXT` starts, the build's **UUID**, the header's **flags** (`MH_PIE`, `MH_TWOLEVEL`, …), each section's **type** and **attributes**, the **entry point**, **rpaths** and **source version** — plus, with `--sections`, `--segments` or `--loads`, every section, segment and load command by name. Reports **abnormalities** when a header disagrees with the file |
| `sym.mjs` | Search a symbol table by substring, or by regex with `--regex`. Imports marked rather than shown as `0x0` |
| `symlookup.mjs` | Which function contains this vaddr? Reads symbols directly, because `nm` on a large universal binary is unusable |
| `starts.mjs` | Where do functions begin? The linker's own `LC_FUNCTION_STARTS` list — the only one a stripped binary carries, each address labeled `sub_<hex>` |
| `findcall.mjs` | Direct `call`/`jmp` xrefs to an address — or `--list` for the distinct targets a binary calls |
| `findliteral.mjs` | Find a byte literal anywhere in a file, per slice, with context — or `--strings` to list what the binary already contains |
| `mapliteral.mjs` | Map a literal to vaddrs, then find the pointers to them — which is how you find the code that handles a format |
| `a2o.mjs` | Which byte of the file is this vaddr? Both the slice-relative and the absolute offset, and zero-fill as its own answer |
| `o2a.mjs` | Which vaddr does this file offset have? Every slice's answer, since one offset means a different address in each |
| `dump.mjs` | The bytes at a vaddr, resolved through its section — bounded by that section, so it never blends into the next one |
| `disasm.mjs` | Where do instructions start and end at this address, and where do they branch? Instruction lengths plus resolved **direct** branch edges for `arm64`, `arm64e` and `x86_64` — bytes, not mnemonics |
| `audit.mjs` | Is this file internally consistent? Every structural claim it makes about itself, checked, with a verdict and an exit status a build can gate on |
| `fingerprint.mjs` | Is this the same **program** as that one? A digest that survives a rebuild, which a byte comparison cannot |
| `diff.mjs` | What changed between two binaries — structure and literal content, so a rebuilt pair does not read as a different program |
| `assert.mjs` | A CI policy: `--has-symbol`, `--no-symbol`, `--has-string`, `--no-string`, repeatable. Exit 0 only when every assertion holds |
| `tbd.mjs` | **What does this library export?** A `.tbd` text stub — the only readable record of a system dylib, since macOS 11 put them all in the shared cache. One file may hold 39 libraries, and every symbol is attributed to the one that exports it. `--symbol` with `--sdk` answers "which library provides this", which nothing else on a current macOS can |
| `symbolicate.mjs` | **Why is my app crashing?** Turn a crash report — modern `.ips` or legacy `.crash` — into named frames, resolving each address against the binaries on this machine. Says which format it read, because the two disagree about whether a frame is an address or an offset, and gives every unresolved frame the **reason** it could not be named |

Seventeen tools; there were seven until `symgrep.mjs` and `symfind.mjs` merged into
`sym.mjs`, which now covers both conventions with `--regex` and `--all-imp`, eight
until `disasm.mjs` added the boundary decoder, nine until `audit`, `fingerprint`
and `diff` answered the three questions a build or a reviewer asks about *two*
binaries at once, and twelve until `dump`, `starts` and `assert` added the byte
read, the function list and the policy gate, fifteen until `tbd` added the
text-stub reader, and sixteen until `symbolicate` turned a crash report into
named frames.

### Why is my app crashing?

`symlookup` answers "which function contains this address" for an address you
already have. A crash report is the case where you have a *stack* of them, in
several binaries you did not build, and the numbers in it are not even always
addresses — an `.ips` frame is an offset into an image, a legacy `.crash` frame is
already absolute. `symbolicate` reads both formats and says which it read:

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

Most frames in a real crash log are in Apple frameworks, and since macOS 11 those
are not files on disk, so they **cannot** be named on the machine that produced the
report. That is a property of the platform, not a limitation to be worked around
quietly: every frame that cannot be named carries the reason it cannot, because
"this function is not known" and "there was no file to ask" send you to different
places. The address and its owning image are still reported.

`[binary]` and `[report]` are not decoration. The first is a name this package read
out of a file that may since have been rebuilt; the second was already in the report
and is more authoritative. `--json` keeps them apart in `symbolSource` and counts
them separately, so a caller can decide which to trust.

### What does libSystem export?

Since macOS 11 the system dylibs are not files. `/usr/lib/libSystem.B.dylib` is inside the
dyld shared cache, so `nm`, `otool` and every tool here have nothing to open — the
question is not slow, it is unanswerable by anything that reads binaries.

The answer is in the SDK, as text:

```sh
$ macho-explorer tbd --symbol=_pthread_mutex_lock --sdk="$SDK/usr/lib"
_pthread_mutex_lock  —  4 hit(s) in 2 libraries, from 394 stub(s)
  /usr/lib/system/libsystem_pthread.dylib
  /usr/lib/system/introspection/libsystem_pthread.dylib
```

That is the answer you need before reasoning about a call site: it is
`libsystem_pthread.dylib`, **not** `libSystem.B.dylib`, which only re-exports it.

Three properties make it trustworthy rather than merely fast:

- **One file, many libraries.** `libSystem.tbd` holds **39 documents**, one per
  constituent dylib. Every hit is attributed to the library that exports it — a
  reader that took only the first would report the umbrella's metadata and a
  fraction of its symbols with nothing saying so.
- **46% of an SDK's stubs are symlinks.** `libm.tbd` is a link to `libSystem.tbd`;
  so are `libc.tbd` and `libpthread.tbd`. Paths are resolved and deduplicated, or
  `_pthread_mutex_lock` reads as exported by 39 files and you look in all 39.
  The alias count is reported, not hidden.
- **A partial answer is withheld.** A stub with one unread line has an *unknown*
  symbol count, so `tbd` exits 3 and names the line rather than printing a number
  it cannot justify.

Verified against **every stub in a real SDK**: 5,304 files, 6,387 libraries,
**4,743,784 symbols**, zero unrecognised lines. That corpus run is the check; the
checked-in fixtures are verbatim excerpts of Apple's own files, not files written
to match the parser.

### Three questions about two binaries

The last three tools exist because one question — "is this the same thing?" — has
three different answers, and every existing tool gives you the wrong one:

| | |
|---|---|
| **same build** | the `LC_UUID`. Exact, and useless the moment anything is relinked |
| **same program** | a `fingerprint`. Survives a rebuild; changes if a symbol or a section does |
| **what changed** | a `diff`. Structure and literal content, so a rebuilt pair is not a changed one |

Byte comparison gets both directions wrong. Two builds of one source differ in every
address — PIE and ASLR move them — in the dylib version fields, and in any
timestamp, so `cmp` calls them different. Two *different* programs built from one
template with a function renamed differ in almost nothing structural, so a loose
structural diff calls them the same.

```sh
$ fingerprint v1.0/libthing.dylib v1.1/libthing.dylib
  same program, rebuilt
$ diff v1.0/libthing.dylib v1.1/libthing.dylib
  same program, rebuilt  —  0 difference(s), 1 build-metadata change(s)
  exit 0
```

`audit` is the fourth thing in this family, and the one aimed at a build rather than
a person: it checks every structural claim a file makes about itself and exits
non-zero when it does not hold up. Findings carry a **severity** — `error` means the
file disagrees with itself, `warning` means it parsed and something is merely
unfamiliar — so `--strict` can widen the gate without failing every build produced
by a newer Xcode:

```sh
$ audit --strict build/Contents/MacOS/app
app — FAILED  2 error(s), 1 warning(s)
exit 1
```

It also checks the fat table itself, which no per-slice check can: two slices
claiming the same file bytes are *each* internally consistent, and the damage only
exists between them.

## Gating a build

`audit`'s **exit status is the product**, and it is the one tool here designed to
be a CI gate rather than a report.

```sh
audit  app                        # 0 sound · 1 unsound · 2 usage · 3 could not read
audit  --strict app               # warnings fail too
audit  --sarif app > audit.sarif  # SARIF 2.1.0, for GitHub Code Scanning
```

The four codes are the design. **1 is a negative answer, not an error** — an audit
that found something wrong has done its job. **3 means the file could not be
read**, which is *not* a passing audit: a mistyped path in a CI script must never
read as a clean bill of health.

Branch on the **booleans**, not the label: `data.clean` (the default gate) and
`data.strictClean` (`--strict`). `verdict` is `ok` / `warnings` / `failed` and is
a label for a person — `verdict: "warnings"` with `clean: true` is a *passing*
audit.

`--strict` is off by default on purpose: a binary built by an Xcode newer than
this reader sets a header flag bit the reader has no name for, and failing every
build over that trains people to stop running the gate.

### The composite GitHub Action

So none of that needs writing:

```yaml
- uses: ranjithrajv/MachO-explorer@main
  with:
    binary: build/Some.app/Contents/MacOS/Some
    baseline: known-good/Some        # enables fingerprint + diff
    sarif: true                      # upload to Code Scanning
  permissions:
    contents: read
    pages: write
    id-token: write
```

It has **no install step** — it runs the reader from the checked-out source, so
the gate tests *this commit* rather than whatever a version tag resolved to today.
A CI gate that needs an install is a gate that gets skipped, and the install is
the part that fails. See [`action.yml`](action.yml) for inputs and outputs.

`diff` is deliberately **not** a gate: it reports three lists and only the first
decides the verdict, because a UUID change and a section-size change are facts
about a *build* while a changed literal string is a change to the *program*.
Turning any of them into a failure is a policy decision, and a policy belongs in
[`assert`](#the-tools) where it can be written down and reviewed.

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
| `tbd` | Read a `.tbd` text stub: the exported symbols, install names and target triples of a dylib. Since macOS 11 the system libraries exist only in the dyld shared cache, so this is the **only** readable record of what they export — and `--symbol=X --sdk=<dir>` answers "which library provides X" across an entire SDK in under a second |
| `symbolicate` | Turn a crash report into named frames. Reads both the modern `.ips` and legacy `.crash` formats, resolves each address against the binaries on this machine, and says **why** every frame it could not resolve was not resolved — most Apple framework frames cannot be, because they live in the dyld shared cache |
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

- **[Auditability](AUDITABILITY.md)** — why the one-file reader matters, and how to verify it
- **[Use cases](docs/use-cases.md)** — where this reader is the right shape, and where it is not
- **[Conformance corpus](conformance/)** — hold any Mach-O parser to known answers
- **[Browser demo](demo/)** — the reader running client-side, no upload
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

The claims above were taken from `ipsw`'s source tree rather than its README, which
matters: `macho diff` is a hidden `panic()` stub, and `macho info --json` discards
every selector combined with it. Neither is visible in `--help`.

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

## Limits

- **One format, on purpose.** Mach-O is what this package is for, not the only
  format it has not got round to yet. Android APKs, iOS bundles and Windows PE
  need a different reader, and always will.
- **Direct calls only.** Indirect calls, register calls and jumps through a PLT
  stub do not encode their target in the instruction, so they do not appear in
  `findcall`. Every hit is a site *worth disassembling*, not a proven call-graph
  edge.
- **The x86_64 scan is typed by *section*, not by instruction.** It restricts
  itself to sections the linker flagged as code, which removes data false
  positives, but it will still match a byte inside a multi-byte instruction
  rather than at an instruction boundary. Alignment is not something the file
  format records, so this cannot be fixed without a disassembler. The arm64 path
  steps 4 bytes at a time and does see only aligned `BL`s.
- **Stripped binaries have no defined symbols** to grep. `sym` and `symlookup` report
  nothing rather than guess; `findcall` and `findliteral` read bytes rather than
  names and are unaffected. There is no dSYM support, so a shipped build with
  its symbols in a sidecar is out of reach.
- **Not a general Mach-O parser.** `describe --loads` names every load command but
  interprets none of them: no code signing, no fixups, no export trie, no
  ObjC/Swift metadata, no FAT32, and no following a `LC_LOAD_DYLIB` to the library
  it names.
- **Verified on macOS and Linux.** The reader is portable buffer arithmetic; on
  Windows only the generated half of the suite runs.

## Scripting it

Every tool takes `--json`, with two guarantees so a consumer does not have to
learn one dialect: **stdout is JSON only** (progress lines, per-slice narration
and "none found" prose all go to stderr), and **one envelope, always** —
`{ tool, ok, binary, errors, messages?, notes?, data }`, where `errors` holds
machine-readable reason codes (`bad-arguments`, `bad-address`, `bad-pattern`,
`no-match`, `no-call-sites`, `no-symbols`, `encrypted`, `unknown-encoding`, `io`)
rather than prose.

`io` and `unknown-encoding` are deliberately distinct, because the two are
different problems: one is a file that cannot be read, the other a file that
reads fine and is not a Mach-O. Told "not a Mach-O binary" about a path that
does not exist, a caller goes looking for the wrong file entirely.

`encrypted` is the one code that means **could not look** rather than **looked and
found nothing**: an App Store build's `__TEXT` is ciphertext, so a zero result from
`findcall` or `findliteral` is not evidence the target is absent.

Addresses are emitted as `"0x..."` strings, never JSON numbers: a 64-bit vaddr
does not survive a `Number`, and a silent precision loss would be
indistinguishable from a correct answer.

| Code | Meaning |
|---|---|
| 0 | Ran, found something |
| 1 | **Ran, found nothing.** Deliberately distinct from an error |
| 2 | Usage error — bad or missing arguments |
| 3 | Could not do the job — unreadable file, unparseable Mach-O |

A caller that cannot tell "found nothing" from "could not look" has the problem
this project keeps fixing, so it is encoded in the exit status. The status is
the same with and without `--json`: the flag changes the format of the answer,
not the answer, and a tool whose text mode and JSON mode disagree about whether
something was found is worse than one with no contract at all. The suite asserts
that parity across tools rather than listing expected values per tool, so a tool
added later fails the same check.

### Validating the output

Every tool ships a **JSON Schema for its own envelope** under `schema/`, composed
from `schema/envelope.schema.json` with `data` constrained to what that tool
actually returns:

```sh
macho-explorer audit --json app | ajv validate -s schema/audit.schema.json
```

Two deliberate properties. The **envelope is closed** — a typo'd field is
rejected, so `errorss` does not validate and a consumer cannot read it as "no
errors". **`data` is open** — an unrecognised key is ignorable, which is what
lets a bug fix add a field without a major version bump.

Check `schemaVersion` against the value you were written against rather than
trusting the field names; that field exists so a consumer can fail loudly on a
change instead of discovering it from an empty field.

The schemas are **generated** from the shapes the tools emit, and
`npm run schema:check` fails if a checked-in schema has drifted from the
generator — the same discipline the fixture corpus and the browser bundle get.
`test/schemas.mjs` runs every tool's real output through its own schema and
asserts the schemas also *reject* wrong documents, because a validator that
accepts everything would pass every positive check and be found by nobody.

### For coding agents

Two doorways, and they are not redundant.

**An MCP server**, so an agent that speaks the protocol finds these tools at
all:

```sh
claude mcp add macho -- node /absolute/path/to/src/mcp.mjs
```

```json
{ "mcpServers": { "macho": {
    "command": "node",
    "args": ["/absolute/path/to/src/mcp.mjs"],
    "env": { "MACHO_BINARY": "/path/to/a/binary" } } } }
```

Eight tools — `macho-describe`, `macho-sym`, `macho-symlookup`,
`macho-findcall`, `macho-findliteral`, `macho-mapliteral`, `macho-a2o`,
`macho-o2a` — each returning the **same envelope** the CLIs emit under `--json`,
plus a short text block. Nothing new to learn depending on how you arrived.

It speaks both protocol eras, because clients in the wild still use both: the
modern `2026-07-28` revision (per-request `_meta`, no handshake) and the legacy
`initialize` handshake back to `2024-11-05`.

**An [Agent Skill](skill/)**, for agents that drive the CLI or the library
instead. It carries the three things that produce confidently wrong answers —
addresses are hex *strings*, an empty result is not an error, `findcall` sees
direct calls only — plus the workflow and the fallbacks. It is plain
`SKILL.md` in an open format, so it works in Claude Code, Codex, Cursor, VS Code,
Copilot and Gemini CLI by copying one directory.

```sh
mkdir -p .claude/skills && cp -r skill/macho-explorer .claude/skills/
```

Be clear-eyed about what this is: Hopper, Binary Ninja, IDA and Ghidra all ship an
MCP server, so **this is distribution, not differentiation**. An MCP server is how
an agent discovers a capability exists; without one this package is invisible to
every agent-driven workflow while being well suited to it.

```js
import { describe, findCalls, lookupAddress, mapLiteral } from 'macho-explorer';

const { slices } = describe('/path/to/binary');
const fn = lookupAddress('/path/to/binary', 0x100085c30n);
const callers = findCalls('/path/to/binary', fn.start);
const tables = mapLiteral('/path/to/binary', 'LZ4');
```

The specifier is `macho-explorer`, exactly as `"name"` spells it in `package.json` —
package names are case-sensitive when Node resolves them.

The name is lowercase because npm will not accept a capital letter in a name
published for the first time. That was not a style choice: this package shipped
as `MachO-Tools`, and `npm publish --dry-run` reported `+ MachO-Tools@0.1.0` and
exited 0 on it, because a dry run never asks the registry whether a name is
acceptable. `npm view` returned E404 with the reason spelled out — *"name can no
longer contain capital letters"* — and npm's own validator reported
`validForNewPackages: false`. The command that looks like the check was not one.

| Export | Returns |
|---|---|
| `describe(path)` | Every slice: architecture, extent, symbol counts, `__TEXT` bounds, **`uuid`**, and the full `segments` / `sections` / `loadCommands` lists |
| `searchSymbols(path, pattern, opts)` | Symbol search. `mode: 'substring'` (default) or `'regex'`; `definedOnly` and `dedupe` default true |
| `lookupAddress(path, vaddr, opts)` | The function containing an address |
| `findCalls(path, vaddr, opts)` | Direct call/jmp sites targeting an address |
| `listCallTargets(path, opts)` | The distinct addresses a binary calls |
| `findLiteral(path, lit, opts)` | Byte-literal occurrences, per slice, with context |
| `mapLiteral(path, lit, opts)` | Literal → vaddr → the pointers to it |
| `addressToOffset(path, vaddr, opts)` | vaddr → file offset, both bases, or `zerofill` |
| `offsetToAddress(path, offsets, opts)` | File offset → vaddr, one row per slice |
| `withFile(path, fn)` | Open, hand to a callback, close |
| `coversAddress(thin, vaddr)` | Is this address mapped by this slice? |

Two conventions worth knowing: **a negative answer is a value, not an
exception** (`{ matches: [] }`, `{ function: null }` — genuine I/O failures still
throw, so "no result" and "could not look" stay distinguishable), and
**addresses are `bigint`** in, `"0x…"` out.

`lookupAddress` returns `{ function: null }` for an address the slice does not
map, rather than for the last symbol below it. A symbol table records where code
*starts*, not where the slice *ends*, so without that check every address above
the last symbol would resolve to that symbol with an offset of billions of bytes
— a wrong answer shaped like a measurement. A symbol's own entry point still
resolves even where it sits one past the last mapped byte, which is where a BSS
symbol can land. `findCalls` and `mapLiteral` have always asked the same
question, so the three agree about any address in any binary.

`aliases` carries a second caveat: when several symbols start at the same
address, the answer names the alternatives rather than implying it is the only
one. This is ordinary, not exotic — Go's linker writes zero-size region markers
beside real symbols, so in `go` both `_go:buildid` and `_runtime.text` sit at
`0x100001000`. `nlist_64` has no size field, so nothing in the table separates a
marker from a function, and a `size` derived from the next unrelated symbol is a
bound rather than a measurement. `aliases: null` means the answer stands alone.

`addressToOffset` and `offsetToAddress` report `query` and `vaddr` as `"0x…"`
strings for the same reason every other address here is: a 64-bit position does not
survive a JSON number. Offsets stay numeric — they are arithmetic, and a file
position is far below 2^53 in practice.

`src/macho.mjs` — the raw reader — is also importable and is where new format
support lands first. It is stable within a major version but lower-level and more
likely to grow than `api.mjs`.

## Configuration

`config.json` holds the two things that are facts about the world rather than
about the format: the bundle convention (`.app`, `Contents/MacOS`) and the scan
chunking. Both are overridable with `$MACHO_CONFIG`, and a malformed override
falls back to the shipped values rather than failing — a typo should not stop a
tool you handed an explicit binary.

```sh
echo '{"bundle":{"ext":".bundle","macosDir":["bin","exec"]}}' > /tmp/alt.json
MACHO_CONFIG=/tmp/alt.json node src/sym.mjs 'someSymbol'
```
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
node test/schemas.mjs             #  ~3s     every tool's real output, against its own schema
node test/sarif.mjs               #  ~2s     the SARIF emitter is well-formed
node test/action.mjs              #  ~2s     the composite action's shell, extracted and run
node test/pages.mjs               #  ~1s     the published page is this repository
npm run schema:check              #  ~1s     the checked-in schemas match the generator
node test/mutation-check.mjs      #  ~2m     the historical defects are still caught
```

The fast numbers are wall-clock on an M-series laptop and are there to set
expectations, not to be asserted. The counts and verdicts are the claim.

Each is a different kind of evidence: `--check` re-derives every byte of the
generated corpus, so a hand-edited or stale fixture cannot pass as a test;
`smoke.mjs` runs the tools against binaries they were not written for and
asserts its own coverage; `mcp.mjs` drives a real subprocess over a real pipe
and parses **every** line of stdout, so a stray write on any code path turns a
test red rather than a user's session green; `skill.mjs` holds the agent-facing
prose to the tree, so an instruction cannot name a flag that does nothing or an
exit code that means something else; `schemas.mjs` runs each tool's real output
through its own schema **and** asserts the schema rejects wrong documents, because
a validator that accepts everything passes every positive check; `action.mjs`
extracts the shell out of `action.yml` and runs it, which is the only way to test
a composite action — its steps are shell, nothing type-checks them, and the file
parses as valid YAML whether the shell inside it is correct or not.
`mutation-check.mjs` reintroduces one real historical bug at a time and requires
the suite to fail, with an inconclusive mutation failing the run rather than
counting as caught.

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

**MPL-2.0.** See [`LICENSE`](LICENSE) for the Mozilla Public License 2.0.

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

**The licence does not extend to that product.** MPL-2.0 covers this code. It does
not license anyone else's intellectual property, and reading a file format out of
a binary does not make the binary yours to redistribute.
