# Feature parity — `MachO-explorer` vs `blacktop/ipsw`

**Researched 2026-10-03. Fully re-verified 2026-10-04 against `ipsw` v3.1.730.**

The `ipsw` column is taken from source, not its README: flag registrations read out of
`cmd/ipsw/cmd/**/*.go`, cross-checked against the man pages shipped in the release
tarball, with the command tree enumerated through the GitHub git-tree API. The
`MachO-explorer` column is taken from the code and from running every tool — against
the pushed commit `85e8ac1` in a clean export, not against a working tree.

That distinction is not pedantry. The previous version of this document was wrong
about `ipsw` in **twelve** places, including one that inverted a row, and every one
of the twelve came from the same shortcut: reading a flag name somewhere and
assuming it was on the command being discussed. `macho info` has no `--section`, no
`--regex`, no `--import`, no `--uuid` and no `--sym`; those live on `macho search`.
Reading the source rather than the docs is the only thing that caught it.

**Re-verification result: `ipsw` moved, and one of its movements matters.** Same
13 visible `macho` commands, but `macho info --json` now warns and *ignores* every
selector combined with it, and `macho diff` — which this document recorded as a
working diff — is a **hidden `panic()` stub** that has never compared anything.

**Verdict up front:** `ipsw` is still a strict superset on format coverage and still
wins every contest that involves *decoding* something. MachO-explorer now wins **ten
capability rows** — seven outright, three on honesty — up from five, and it has closed
parity on seven more that it previously lost. The feature race over format coverage
is over; the remaining contest is on footprint, auditability, contract and agent
integration.

---

## 1. The `ipsw` surface, for reference

Verified against `v3.1.730` (2026-10-01), last push 2026-10-03. **13 visible `macho`
commands + 3 nested under `patch` + 2 hidden = 16 files.**

```
ipsw macho info       22 flags. header loads json arch sig ent ent-der objc objc-refs
                      swift swift-all symbols strings starts fixups split-seg demangle
                      bit-code fileset-entry extract-fileset-entry all-fileset-entries
                      dump-cert output
ipsw macho search     load-command launch-const import section uuid sym protocol class
                      category sel ivar mte pem-db device      (regex, over FOLDER or IPSW)
ipsw macho disass     arch section entry symbol vaddr off count demangle json cache
                      quiet force + an entire --dec* LLM-decompilation family
ipsw macho dump       arch addr bytes count size output entry segment section
ipsw macho a2o        vaddr -> file offset          (arch, dec, hex — no --json)
ipsw macho o2a        file offset -> vaddr          (arch, dec, hex — no --json)
ipsw macho a2s        vaddr -> symbol               (arch — no --json)
ipsw macho lipo       extract one slice from a fat binary   (leaf; no subcommands)
ipsw macho bbl        the inverse: many Mach-Os -> one fat binary
ipsw macho patch      add / mod / rm                (--overwrite --re-sign --output)
ipsw macho sign       codesign a MachO              (--id --team --ad-hoc --cert --verify …)
ipsw macho decrypt    FairPlay decryption           HIDDEN
ipsw macho diff       diff two Mach-Os              HIDDEN — panic() stub, see §2.9

ipsw dyld             26 visible + 5 nested + 1 hidden. xref (WIP) symaddr str objc
                      swift search disass info emu extract split tbd webkit ida …
```

`ipsw macho info` alone carries **22 feature flags**. MachO-explorer's entire tool
count is **13 CLIs**, and `describe` alone answers four of `info`'s flags (`--header`,
`--loads`, plus `--strings` via `findliteral` and the UUID) in one structure.

Two corrections to the previous version of this document, both of which had been
copied from a plausible-looking surface listing rather than from source:

- **`macho bbl` is not a "boot blob loader."** It is `"Create single universal/fat
  MachO out many MachOs"` — the exact inverse of `lipo`. This document had it wrong
  for at least one revision.
- **There is no `macho s2a`.** The symbol lookup is `a2s`, and it is a leaf with a
  single `--arch` flag.

---

## 2. Parity matrix

`ipsw` only · **both** · MachO-explorer only

### 2.1 Container and format

| Capability | `ipsw` | MachO-explorer |
|---|:--:|:--:|
| Fat header, per-slice listing | ✅ | ✅ `describe` |
| Mach header dump | ✅ `--header` | ⚠️ the fields it reports, not a byte dump |
| **Load-command dump** | ✅ `--loads` | ✅ **`describe --loads`, 17 in a Go binary** |
| Segment / section enumeration | ✅ `dump -x`, `search -x` | ✅ **`describe --sections`, per section** |
| UUID value | ✅ `search --uuid` | ✅ **`describe`, every slice** |
| Architecture selection on fat | ✅ `--arch` | ⚠️ **12 of 13 CLIs** — see below |
| Split segments (`__DATA_CONST`) | ✅ `--split-seg` | ❌ |
| Chained fixups | ✅ `--fixups` | ❌ |
| Embedded LLVM bitcode | ✅ `--bit-code` | ❌ |
| Fileset entries (`MH_FILESET`) | ✅ `-t` / `-x` / `-z` | ❌ |
| **Extract a slice from fat** | ✅ `lipo` | ❌ **no equivalent** |
| **Build a fat binary from many** | ✅ `bbl` | ❌ |
| FAT32 (`FAT_MAGIC`) | ✅ | ✅ |
| FAT64 (`FAT_MAGIC_64`) | ❌ `go-macho` rejects it | ❌ |
| Diff two binaries | ❌ **`macho diff` is a panic stub** | ✅ **`diff`** |
| **Linked libraries, per linkage** | ✅ `info` prints a `Dylibs:` block from `sd.Dylibs` | ✅ **`dylibs`, with `load`/`weak`/`reexport`/`lazy`/`upward` kept distinct** |
| **This image's install name** (`LC_ID_DYLIB`) | ✅ | ✅ **`installName`** |
| arm64 + x86_64 | ✅ | ✅ |

**The `--arch` row is now marked ⚠️ rather than ✅, and that is a defect on our side.**
`mapliteral` is the one CLI out of thirteen that does not accept `--arch`. It was
previously recorded as "all 8 tools", which was true when there were eight and has
been quietly untrue as tools were added. It is not yet clear whether this is a bug or
correct-by-design — `mapliteral` already reports per-slice — but the honest entry is
the one that names it, not the one that rounds up.

**The two `Dylib` rows are new, and they close a gap this document had missed
entirely.** Every earlier version of this table rated `describe --loads` as "names
every load command, interprets none", which was true and read as a limitation. It
was not a limitation: `LC_LOAD_DYLIB` names the file a binary cannot start
without, it is the answer to the most-asked question about any executable, and
`ipsw` — which this document has called a strict superset on format coverage
since it was written — has always printed it. A reader that named the command and
withheld the name was strictly worse than `otool -L` on the one question
`otool -L` exists to answer, on a tool whose entire claim is that it can read a
Mach-O on a machine with no Apple toolchain.

The five linkages are kept distinct rather than flattened to a list of paths,
because they differ in what a *missing* library means: an absent `weak` dylib is
normal, an absent `load` dylib is a broken install. `test/fixtures/dylibs.macho`
carries all five in one image, because a stock macOS executable emits only
`LC_LOAD_DYLIB` — chained fixups removed the other four — so without that fixture
four of the five decode paths would be untested while every test still passed.

### 2.2 Symbols

| Capability | `ipsw` | MachO-explorer |
|---|:--:|:--:|
| Substring symbol search | ✅ `search --sym` (regex) | ✅ `sym` |
| Regex symbol search | ✅ `search --sym` | ✅ `--regex` |
| Import-only / defined-only split | ✅ `search --import` | ✅ `--all-imp` |
| Name **demangling** (Swift **and** C++) | ✅ `--demangle` | ❌ |
| cstrings listing (`__cstring`) | ✅ `info --strings` | ✅ `findliteral --strings`, **with addresses** |
| Function-start listing (LC_FUNCTION_STARTS) | ✅ `--starts` | ❌ **named, never parsed** |
| Search **ObjC** classes / selectors / categories / ivars / protocols | ✅ `search` 5 flags | ❌ |
| Search **Swift** metadata | ✅ `--swift`, `--swift-all`, `dyld search --swift` | ❌ |
| Multi-symbol batch lookup | ✅ `dyld symaddr --in <json>` | ✅ **`symlookup`, multiple positionals** |
| Symbol search across a **directory** | ✅ `macho search <FOLDER>` | ✅ **`sym --in <dir>`** |

**Two rows flipped from ❌ to ✅, and both are more than a tick.**

`symlookup` takes multiple positionals and answers with `{queries:[…]}`, so a batch
address lookup no longer costs one invocation per address. The previous version of
this document called that "one pattern per run", which was true of `sym` and was never
true of `symlookup`.

`sym --in <dir>` walks a directory through the same envelope as a single file, and it
separates **files found** from **files actually read** — so a corpus scan cannot
report 4,000 hits by reading 12 files. `macho search` has no `--json` at all.

**One correction against ourselves:** `LC_FUNCTION_STARTS` is a *named constant* in
`src/macho.mjs` (`LC_FUNCTION_STARTS_CMD = 0x26`) and appears in the load-command
name table. It is never parsed. A previous entry described it as absent, which was
wrong in a way that flattered us — it is present as a label and absent as a feature,
and the label is the more misleading of the two.

### 2.3 Addresses

Both tools answer the same question `ipsw macho a2o` and `o2a` do, and both take
`--arch`. Three things differ, and all three are the same species of thing this
project exists to avoid.

**Zero-fill is a third answer, not an error or a wrong offset.** An address in
`__bss` is mapped, has a section, and has *no byte in the file*. Verified against
`zerofill.macho`:

```json
{ "vaddr": "0x100001000", "offset": null, "section": "__TEXT,__bss",
  "zerofill": true, "mapped": true,
  "note": "__TEXT,__bss is zero-fill — mapped at this address, but no byte of it exists in the file" }
```

**Re-verified: `ipsw macho a2o` still has no zero-fill concept.** Not a flag, not a
branch — its only fallback is `FindSectionForVMAddr` then `FindSegmentForVMAddr`, and
failure is a plain error. `go-macho` *does* probe with a real read so bss tails are
treated as unresolvable, but that is library-internal and never surfaces as a
distinct answer. A script that takes an offset from `ipsw macho a2o` and `dd`s the
file gets nothing for a `__bss` address; conflating that with "not in this binary"
sends it to the wrong place.

**An ambiguous fat binary is reported, not resolved by coin toss.** Every slice maps
`__TEXT` at `0x100000000`, so an address is genuinely in all of them. Verified on
`universal.macho`:

```json
{ "arch": null, "vaddr": "0x100000120", "mapped": true, "ambiguous": true,
  "slices": [ { "arch": "x86_64", "offset": 288, "absoluteOffset": 16672 },
              { "arch": "arm64",  ... } ] }
```

`arch: null` and every per-slice answer, rather than one slice chosen silently.

**Both emit JSON.** **Re-verified against both source files and both shipped man
pages: neither `ipsw macho a2o` nor `o2a` has `--json`.** The complete flag set on
each is `--arch`, `--dec`, `--hex`. The two commands that exist to feed a *script*
are the two that cannot be scripted.

| Capability | `ipsw` | MachO-explorer |
|---|:--:|:--:|
| vaddr → containing function | ✅ `a2s` | ✅ `symlookup` |
| vaddr → file offset | ✅ `a2o` | ✅ **`a2o`** |
| file offset → vaddr | ✅ `o2a` | ✅ **`o2a`** |
| **Zero-fill as a distinct answer** | ❌ not surfaced | ✅ **`zerofill:true`** |
| **Slice ambiguity reported, not guessed** | ❌ | ✅ **`ambiguous:true`** |
| Batch address lookup | ✅ `symaddr --in <json>` | ✅ multiple positionals |
| **Direct call/jmp xrefs in a standalone Mach-O** | ❌ **none** | ✅ **`findcall`** |
| List distinct call targets | ❌ | ✅ `findcall --list` |
| **JSON on the offset conversions** | ❌ neither has `--json` | ✅ **both do** |
| **Scan restricted to code sections** | ❌ | ✅ **`--include-data` to widen** |

`ipsw` has no `macho xref`. Its only cross-reference command is `dyld xref <DSC>
<ADDR>` — scoped to a **dyld shared cache**, not a standalone Mach-O, and **still**
marked work-in-progress by its own author after all this time:

```
Short: "🚧 [WIP] Find all cross references to an address"
```

Its `--slide` flag's help text still reads `"dyld_shared_cache slide to apply (not
supported yet)"`. **`findcall` has no competitor in `ipsw` at all**, and its
competitor-in-waiting has not shipped in the interval.

The converse also holds and is worth keeping precise: `ipsw macho disass` is
**still** documented `"Disassemble ARM64 MachO"` and **still hard-rejects x86_64** —
its `RunE` returns `can only disassemble arm64 binaries` outright. It *does* have
`--json`, which the previous version of this document credited to the wrong
commands. It also now carries an entire `--dec*` family that drives external LLMs
(Anthropic, Gemini, Ollama, OpenAI, OpenRouter) through the Agent Client Protocol.
Neither disassembler is a superset of the other: `ipsw` prints mnemonics and loses
x86_64 entirely, `disasm` reports instruction lengths and resolved direct branch
edges on both architectures and prints no mnemonics, because per-opcode tables whose
wrong answer is a plausible-looking instruction rather than a detectable error are
worse than no answer.

### 2.4 Bytes and literals

| Capability | `ipsw` | MachO-explorer |
|---|:--:|:--:|
| Hex/bytes dump at a vaddr | ✅ `macho dump --bytes --section` | ⚠️ context bytes only |
| Dump a whole segment/section | ✅ `--segment` / `--section` | ❌ |
| **Arbitrary byte-literal search in a Mach-O** | ❌ | ✅ **`findliteral`** |
| **literal → vaddr → pointers to it** | ❌ | ✅ **`mapliteral`** |
| `__cstring` dump | ✅ `info --strings` | ✅ `--strings`, each with an **address** |
| String search over a dyld cache | ✅ `dyld str` | n/a (cache-scoped) |
| Decoy rejection (data vs code) | n/a | ✅ `decoy.macho` fixture |

`ipsw macho dump` has **no `--json`** — output shape is chosen between `--bytes` and
`--addr` as a formatting flag. The two tools that read raw bytes out of a binary are
the two that cannot be scripted.

MachO-explorer's `findliteral` scans **any byte sequence anywhere in the file**,
including inside code, and `mapliteral` resolves each occurrence to a vaddr and finds
the pointers that reference it. Nothing in `ipsw` does this. It remains the single
most distinctive thing in the package.

The `--strings` row was a genuine gap and is closed, with one difference that matters
more than the feature: every entry carries its file offset, virtual address and owning
section, so it can be fed straight into `symlookup` or `mapliteral`. A string you
cannot address is a string you cannot act on. The limits are stated rather than left to
be discovered — it reads the Objective-C and Swift name sections too, skips
`__cfstring` because those are structures rather than text, and finds nothing in a Go
binary, whose strings are length-prefixed in `__gopclntab` and have no terminator to
scan for (§4.6).

### 2.5 Corpus scale

| Capability | `ipsw` | MachO-explorer |
|---|:--:|:--:|
| One binary at a time | ✅ | ✅ |
| Search a **directory** of binaries | ✅ `macho search <FOLDER>` | ✅ **`sym --in <dir>`**, with `--json` |
| Search an entire **IPSW firmware image** | ✅ | ❌ |
| dyld shared cache (31 commands) | ✅ | ❌ |
| Firmware: img3 / img4 / OTA / kernelcache / KDK | ✅ | ❌ |
| Connected-device inspection (`idev`, 78 doc pages) | ✅ | ❌ |
| Firmware download (16 subcommands) | ✅ | ❌ |

This is the one block that moved *against* us since the last revision, and it is worth
being precise about why it is still a loss. `ipsw macho search` takes a folder **or a
whole IPSW image** with the same flag set; `sym --in` takes a directory of files. So
the two rows that look like parity are parity on the *directory* and a large deficit
on the *image*. `ipsw idev` remains a genuinely different product: 78 documented pages
covering `afc`, `amfi`, `apps`, `backup`, `crash`, `dvt`, `fsyms`, `img`, `restore`,
`pcap`, `prof`, `prov` and more.

`macho search` is also regex-only on every criterion except `--uuid`, and cannot search
strings at all — string search over a cache is `dyld str`, a separate command.

### 2.6 Mutation

| Capability | `ipsw` | MachO-explorer |
|---|:--:|:--:|
| Patch bytes / load commands | ✅ `patch add/mod/rm` | ❌ |
| Code signing | ✅ `macho sign` | ❌ |
| FairPlay decryption | ✅ `macho decrypt` | ❌ |
| Entitlements read | ✅ `--ent`, `--ent-der` | ❌ |
| Code signature read | ✅ `--sig` | ❌ |
| ObjC / Swift metadata read | ✅ `--objc`, `--swift`, `--demangle` | ❌ |

All six are on MachO-explorer's own "What it will not do" list, and the project's own
test for that list — *would closing this gap make the package worse at the thing it is
for?* — is the right test. **But the honest reading of that list is that it is a list
of everything `ipsw` does and MachO-explorer does not.** It is a scope statement, not
a competitive strength.

### 2.7 Output contract — the strongest row, and it widened again

| Property | `ipsw` | MachO-explorer |
|---|:--:|:--:|
| `--json` | ⚠️ **3 of 16 `macho` commands** | ⚠️ **all 13 accept it, 4 emit it on every exit path** |
| One envelope shape across tools | ❌ per-command | ✅ `{tool, ok, binary, errors, messages, notes, data}` |
| Exit-code taxonomy | ❌ | ✅ 0 / 1 / 2 / 3 |
| "Found nothing" ≠ "could not look" | ❌ | ✅ by design |
| Addresses never lose precision | ⚠️ | ✅ `"0x…"` strings, `bigint` in |
| stdout is data only | ❌ mixed | ✅ prose to stderr |
| Negative answer is a value | ❌ | ✅ `{matches: []}`, `{function: null}` |
| **Same shape over MCP and CLI** | ❌ n/a | ✅ **one envelope, two doors** |
| A misspelled option is rejected | ❌ | ✅ **both surfaces, exit 2** |
| A mistyped `--arch` is reported | ❌ | ✅ `archHonoured: null`, `archRead` |
| **Envelope on a *usage* error** | ❌ n/a | ⚠️ **4 of 13** — see below |
| **JSON composes with other flags** | ❌ **warns and ignores them** | ✅ **every flag combination** |

**One row in that table is weaker than it looks, and it is ours.** All thirteen CLIs
accept `--json` and emit the envelope whenever they produce a result or fail to read
the file — that part is solid, and verified per-tool rather than inferred. But **nine
of the thirteen print nothing on stdout for a usage error**: they write usage to
stderr and exit 2, leaving `tool --json | jq` with an empty stream instead of a
parseable `ok:false`. The four that do emit it — `describe`, `audit`, `disasm`,
`overview` — are exactly the four with no required positional, so they fall through
to a default target and never reach the usage path at all.

Whether that is a defect or a defensible choice is a judgement call: a caller
branching on exit 2 loses nothing. But "one envelope, every tool, every exit" is a
stronger sentence than the code supports, and the previous revision of this document
would have repeated it without noticing.

**Re-verified, and the finding is sharper than last time.** `ipsw macho info --json`
is not an aggregate. Its own source:

```go
if asJSON && len(setFlags) > 0 {
    log.Warnf("--json flag is set; other flag(s) [ %s ] not currently supported …", …)
}
```

`--json` works standalone, or with `--header`, or with `--loads`, or with
`--all-fileset-entries`. Combine it with `--sym`, `--strings`, `--objc`, `--swift`,
`--starts`, `--fixups`, `--ent`, `--sig`, `--demangle` or `--bit-code` and it warns
and drops them. **The two commands most likely to be scripted together cannot be.**
And `macho search` — the one command that processes many binaries — has no `--json`
at all, so a corpus sweep cannot be piped anywhere.

Counted properly: `ipsw` has machine-readable output on `macho info`, `macho
disass` and `ipsw symbols` — **3 of 16 `macho` commands**, verified absent from
`a2o`, `o2a`, `a2s`, `dump`, `lipo`, `bbl`, `search`, `patch` and `sign`. A pipeline
cannot rely on it uniformly, and the two commands that read raw bytes cannot be
scripted at all.

### 2.8 Distribution and adoption

| | `ipsw` | MachO-explorer |
|---|---|---|
| Stars | **3,771** (313 forks) | 0 |
| Licence | **MIT** | MPL-2.0 |
| Latest release | **v3.1.730**, 2026-10-01 | — |
| Install | Homebrew (own tap + core), snap, scoop, releases | `npm i -g` → **valid name, not yet published** |
| Language runtime | Go 1.26.0 | Node ≥ 22.15 |
| Release binary size | **~80 MiB** (83,895,042 B) | **zero** runtime dependencies |
| Compressed download | 26 MB (macOS arm64) | — |
| Docs site | ✅ + Discord + DeepWiki | README only |
| **MCP server** | ❌ **none** — 0 results for `modelcontextprotocol` | ✅ **dual-era stdio, `mcp`** |
| Agent skill | ✅ `ipsw-skill` (90★, promoted in README) | ✅ `skill/` |
| LLM integration | ✅ `--dec*` via ACP, 6 providers | ❌ by design |
| Programmatic surface | REST daemon (`ipswd`) | ✅ `src/api.mjs` + CLI + **MCP** |
| Shell completion | ✅ | ✅ |
| Man pages | ✅ 14 shipped for `macho` | ✅ 14 |
| Tests | Go suite | **632 smoke + 210 MCP + 44 skill + 72 disasm + 15 publish + 20/20 mutation** |
| Offline reproducible gate | ❌ | ✅ |
| **Auditable in one file** | ❌ ~6,200 commits of Go | ✅ **`macho.mjs`, one file** |

Four corrections, all of which had been stale:

- **The binary is ~80 MiB, not ~40 MB.** Measured off the release tarball:
  `83,895,042` bytes for the `macOS_arm64` `ipsw` entry, up from 26 MB compressed.
  The growth tracks the LLM stack — `internal/ai/*` with six providers plus
  `github.com/coder/acp-go-sdk` — and the `appstore`, `disk`, `frida` and `sb`
  subcommand trees. There is a separate `ipswd` daemon binary at 17–21 MB.
- **`go 1.26.0`**, unchanged.
- **3,771 stars**, up from 3,769.
- **The MCP row holds, and it is now a stronger claim than it was.** Zero results for
  `modelcontextprotocol` across the repository, no MCP path in the 1,946-file git
  tree, no MCP SDK in `go.mod`. The `acp-go-sdk` dependency is the **Agent Client
  Protocol** and drives LLMs for `--dec`; it is not MCP. A caution for whoever
  re-checks this: grepping `mcp` in that tree returns false positives — it appears as
  a substring in `cmd/ipsw/cmd/pbzx.go`, `pkg/fairplay/fairplay.go` and `pkg/ota/*`.

`ipsw-skill` is confirmed at **90 stars**, last pushed 2026-09-27, and is promoted in
the `ipsw` README with an `npx skills add` line. So the agent-skill row is a **tie**,
and the MCP-server row is a genuine flip.

### 2.9 The four tools this document never assessed

`audit`, `fingerprint`, `diff` and `overview` all landed after the last revision of
this file, which is why the previous version scored nine rows and mentioned none of
them. Each was checked against `ipsw` by enumerating the full command tree through
the git-tree API and running targeted code searches — not by reading a `--help`.

**Confidence is stated per row, because "I found nothing" is much weaker evidence
than "I found it", and a parity document that does not distinguish them is worse than
one that admits the gap.**

| Capability | `ipsw` | MachO-explorer | Confidence |
|---|:--:|:--:|---|
| **Two-binary diff that works** | ❌ | ✅ `diff` | **confirmed present-and-broken** |
| **Mach-O soundness audit** | ❌ | ✅ `audit` | confirmed absent, 0 results |
| **Relink-stable binary fingerprint** | ❌ | ✅ `fingerprint` | confirmed absent, 0 results |
| **One-round-trip aggregate + stated gap list** | ❌ | ✅ `overview` | confirmed absent, source read |

**`ipsw macho diff` is a hidden `panic()` stub.** Verbatim from
`cmd/ipsw/cmd/macho/macho_diff.go`:

```go
var machoDiffCmd = &cobra.Command{
    Use: "diff", Short: "Diff MachOs", Args: cobra.ExactArgs(2),
    Hidden: true,
    RunE: func(cmd *cobra.Command, args []string) error {
        // FIXME: implement
        panic("ipsw macho diff - not implemented yet")
        return nil
    },
}
```

It is `Hidden: true`, which is why it appears in neither `ipsw macho --help` nor the
docs. It has **no flags** — only a commented-out `--toggle`. It compares nothing, and
it panics if you try. `ipsw dyld diff` is the same shape.

**This inverts a row in the previous revision of this document**, which recorded
`macho diff` as a working `ipsw` capability and therefore scored `diff` as a tie. It
is not a tie. This is the single most important correction in the re-verification, and
it is exactly the kind of error that survives re-review because the command *name*
looks right in a `--help` listing you cannot see.

**`audit` — confirmed absent.** No `macho audit`, `verify`, `validate` or `check`. The
`v3.1.730` man page index for `macho` contains fourteen pages and none of them is one.
Code search for `audit` under `cmd/` returns **0 results**. Two things that look like
counter-examples and are not: `ipsw img4 im4m verify` validates an **Image4 manifest**,
a different subsystem entirely, and `macho sign --verify` is a post-signing check that
shells out to Apple's `codesign`. What `ipsw` has instead is fail-fast at open time
plus good error strings — e.g. `--fixups` refuses a legacy `LC_DYLD_INFO_ONLY` slice
with a message naming the arch to retry. That is a real virtue and not the same thing.

**`fingerprint` — confirmed absent.** No `fingerprint`, `buildid`, `hash` or
`identify` command anywhere in the tree. `fingerprint` as a *word* has 17 hits, all in
`internal/diff/*`, cache-key code and `pkg/plist` — internal change detection, never a
command. The two things that look closest are both unsuitable, and it is worth saying
why rather than leaving the row as a bare ✅:

- `macho search --uuid` matches an exact UUID, which is *useless* the moment anything
  is relinked — the same property that makes `fingerprint` worth having.
- `macho info --sig` prints a computed `CDHash`, but that is per-code-directory page
  hashing of the current bytes. It changes on every rebuild, so it is a checksum, not
  an identity.

`ipsw diff` does exist at the **firmware** level (`ipsw diff <IPSW|OTA|DIR> …`), and
`dyld info --diff` / `--delta` compare two shared caches. Neither is per-binary.

**`overview` — confirmed absent.** `ipsw macho info --json` is the closest thing and
is explicitly not an aggregate — see §2.7, where it warns and discards every selector
combined with it. The nearest aggregate JSON in `ipsw` is
`macho info --all-fileset-entries --json`, which marshals the *fileset array*, i.e. a
list of entries rather than a description of one binary. `ipsw` does ship
`ipsw jsonschema`, which is a nice thing to have and is not an answer to any question
this row asks.

MachO-explorer's `overview` is therefore uncontested, and it is worth being clear about
why that is not a licence to grow: it carries a `notRead` list in every result, because
the alternative — a JSON object that looks exhaustive and is silent about code
signatures, fixups, ObjC/Swift metadata, DWARF and FAT32 — cannot be told apart from
one that genuinely has nothing to report.

**And one tool of ours that is CLI-only for a stated reason.** `disasm` and `overview`
are both absent from the 11 MCP tools. For `overview` that is deliberate and argued in
`src/mcp-tools.mjs`: *"There is deliberately no combined 'inspect this binary' tool …
a schema that says 'and also'."* For `disasm` it is simply an omission, and it means an
agent cannot disassemble anything today.

---

## 3. Score

| | `ipsw` | MachO-explorer |
|---|---|---|
| Capability rows won | ~46 | **10** (was 5, then 9) |
| …of which outright | | **7** |
| …of which on honesty, not absence | | **3** |
| MachO format coverage | complete | partial |
| Multi-arch disassembly | ARM64 only, hard-rejected | boundaries + edges, both arches |
| x86_64 direct-call xrefs | ❌ (cache-scoped WIP) | ✅ |
| Byte-literal → pointer analysis | ❌ | ✅ |
| Two-binary diff | ❌ hidden `panic()` stub | ✅ |
| Soundness audit | ❌ | ✅ |
| Relink-stable fingerprint | ❌ | ✅ |
| One-round-trip aggregate | ❌ `--json` drops other flags | ✅ + `notRead` |
| vaddr ⇄ file offset | ✅ no JSON, no zero-fill | ✅ **JSON + zerofill + ambiguity** |
| Corpus / firmware scale | ✅ incl. IPSW images, `idev` | ⚠️ directory only |
| Output contract consistency | 3 of 16 commands | ⚠️ **13 of 13 accept `--json`; 4 of 13 on every exit path** |
| Agent integration | skill + LLM decompilation | ✅ **skill + MCP server** |
| Zero runtime footprint | ⚠️ ~80 MiB binary | ✅ **zero dependencies** |
| Single-file auditability | ❌ ~6,200 commits of Go | ✅ **`macho.mjs`** |
| MCP server | ❌ | ✅ |
| Agent skill | ✅ 90★ | ✅ |
| Installable today | ✅ | ❌ **still unpublished** |

**Ten rows, and the composition changed more than the count.** Up from five. Seven
are outright — `findcall`, byte-literal search, literal→pointer analysis, a working
`diff`, `audit`, `fingerprint` and `overview` — and three are capabilities `ipsw` has
and answers less honestly: zero-fill, slice ambiguity, and JSON on the offset
conversions. The previous revision counted four *parity-closing* moves (load-command
listing, section enumeration, UUID, `__cstring`-with-addresses) as wins; this one does
not, because parity is not winning, and leaving them in the win column is how a
document starts inflating itself.

Three things this does **not** change. `ipsw` is still a strict superset on format
coverage — code signing, entitlements, fixups, export tries, ObjC/Swift, demangling,
function starts, mnemonics, split segments, bitcode, filesets, dyld caches and firmware
are all still theirs alone. `ipsw` still wins corpus scale outright, and the §2.5 row
should be read as "we caught up on directories and did not catch up on images."
And MachO-explorer is still **not published**.

That last one is the row that matters, and it has not changed. `npm view
macho-explorer` returns E404. The name is now valid and `test/publish.mjs` asserts the
property in CI, so this is the last blocker rather than a permanent one — but every
row in this document is worth nothing until it clears.

---

## 4. Defects found while building this comparison

§4.1 through §4.5 found defects in **our** code and are unchanged. §4.6 and §4.7 are
records of closed gaps. §4.8 is new.

### 4.1 Unknown flags were silently ignored by the CLIs — **fixed**
### 4.2 `--arch` was missing from `describe` and `findliteral` — **fixed, incompletely**

`mapliteral` still has no `--arch`. See §2.1. Recording this as "fixed" when one
thirteen tools still lacks the flag is the exact error this document was written to
catch, and it is in this document.

### 4.3 The reason-code conflation — **fixed**
### 4.4 `describe` reported a count of code sections and nothing else
### 4.5 The 32-bit reader path had three defects and no fixture

### 4.6 `--strings` over `__cstring`

`ipsw macho info --strings` prints C strings. MachO-explorer had nothing, and the gap
was worth closing because a string you cannot address is a string you cannot hand
to `symlookup` or `mapliteral` — every entry carries its file offset, virtual
address and owning section.

Two things about it that are worth stating plainly rather than leaving to be
discovered:

- **It finds nothing in a Go binary, and zero is the correct answer.** Go keeps
  its strings length-prefixed inside `__gopclntab`, not NUL-terminated, so there
  is no terminator to scan for. Both the CLI and the MCP tool say so in a note
  when the count is zero, because "0 strings" otherwise reads as "this binary has
  nothing to say".
- It reads `__cstring`, `__objc_methname`, `__swift5_reflstr` and
  `__objc_classname`. `__cfstring` is excluded on purpose: those are 32-byte
  structures, so including it would report addresses as if they were strings.
  The rest are included and labelled rather than filtered out, because a tool that
  only looked at `__cstring` would report an Objective-C binary as having no
  strings in it.

### 4.7 The UUID was named but not read — **fixed**

A smaller instance of the same rule as §4.4, found while writing §4.4's
`--loads` output: the load-command table said `LC_UUID`, and the 16 bytes
immediately after the command header were not parsed. `ipsw` prints them via
`macho search --uuid`.

```
$ node src/describe.mjs /usr/local/go/bin/go
  arm64    file 0..14516816  64-bit  19,526 defined / 19,657 symbols  2 code section(s) __text 0x100001000+5,880,564
           uuid e5f29a7e-46cd-3735-c21f-ed044a7e5c86
```

A UUID is the only field in the file that identifies *which build* this is rather
than describing what is in it. Two binaries can have identical sizes, symbol
counts and section layouts and still be different builds.

The fixture places its `LC_UUID` **last of three** commands, which is what makes
the test worth having: the bytes sit at offset 8 of that command, and a reader
pointing at offset 0 gets `cmd` and `cmdsize` — which format into a perfectly
plausible identifier. Verified:

```
- stripped: reads its LC_UUID (got 1b000000-1800-0000-a1b2-c3d4e5f64708)
```

`0x1b` is `LC_UUID` and `0x18` is 24, its size. Both correct, neither a UUID.

### 4.8 This document was wrong about `ipsw` in twelve places — **fixed**

Recorded because it is the defect that matters most in a competitive document, and
because the failure mode is not exotic.

Every one of the twelve came from the same shortcut: a flag or command name seen
somewhere, attributed to a command it does not belong to. `macho info` has no
`--section`, no `--regex`, no `--import`, no `--uuid` and no `--sym`. `macho
search` does not search strings. `macho bbl` builds fat binaries and is not a boot
blob loader. There is no `macho s2a`. `macho diff` does not work. And `--json` on
`macho info` silently drops every other flag you give it, which no amount of
reading the docs would have revealed.

Two of the twelve were self-flattering — `LC_FUNCTION_STARTS` was recorded as absent
when it is present as a label and absent as a feature, and the four parity-closing
moves were counted as wins. A document that only errs in your favour is not a
document anyone should act on.

The method that caught them, for whoever re-checks this next time:

1. Enumerate the command tree via the git-tree API, not `--help` — hidden commands
   do not appear in help, and `Hidden: true` is exactly how a `panic()` stub hides.
2. Read cobra flag registrations out of the source file for each command.
3. Cross-check against the man pages shipped **in the release tarball**, which
   reflect the binary that users actually run.
4. Quote the help string verbatim and check for `🚧`, `FIXME`, `panic` and `Hidden`.
5. Count the flags. A `--json` that warns about every other flag is not an aggregate
   output, whatever the docs call it.
6. For every row scored ✅ for us, find the `ipsw` source line that proves it. A row
   we win because we searched and found nothing is a weaker claim than one we win
   because we read the thing, and the document should say which it is.

---

## 5. The one-paragraph honest summary

If a user needs to know what is in a Mach-O and has Node and nothing else,
MachO-explorer is a better choice than `ipsw`: nothing to install, one file to
read, and a machine contract `ipsw` does not have — the same contract whether
the caller arrived by pipe or by MCP. Every one of the thirteen tools takes
`--json` and answers with one envelope, where `ipsw` has machine-readable output
on three of sixteen and drops your other flags when you ask for it on a fourth.
(Our own contract has one gap, recorded in §2.7: nine of the thirteen print
nothing on stdout for a *usage* error.) If a user needs to know anything *else* —
code signing, entitlements,
chained fixups, export tries, Objective-C or Swift metadata, demangling, function
starts, mnemonics and operands, a firmware image, a connected device, or the
literal's callers in a shared cache — `ipsw` answers it and MachO-explorer does
not. The load-command *listing* is closed; the load-command *interpretation* is
not, and is not planned to be.

Seven capabilities MachO-explorer is now alone on, and they are not all the same
kind of thing. Three are gaps in `ipsw`: **direct call xrefs in a standalone
file**, with no equivalent at all; **byte-literal → vaddr → pointers**, which no
`ipsw` command does; and a **two-binary diff that runs**, where `ipsw macho diff`
is a hidden `panic()`. Three more are questions `ipsw` does not ask: **is this
binary sound**, **are these two files the same program across a rebuild**, and
**what is in this file, in one round trip, with a list of what it skipped**. The
seventh is not a gap but a better answer to a question `ipsw` does answer:
**vaddr ⇄ file offset that admits "mapped but there is no byte there" and "this
address is in every slice"** rather than collapsing them into a wrong offset.

The parity table is not a roadmap argument for closing rows. It is a scoping
argument for **stopping**: the lost rows are all on the "What it will not do"
list, by decision, and the project's own test for that list still comes out right.

Three things are worth saying out loud rather than leaving in a table where they
lose. **The MCP server is distribution, not differentiation** — `ipsw` has a skill
and now drives six LLM providers for decompilation, and Hopper and Binary Ninja have
servers, so this is table stakes. **Zero footprint is a real consequence of one
file and zero dependencies, and `ipsw` is now an 80 MiB binary** — that gap widened
while we were not looking. And **none of it counts while the package is
unpublished**: `npm view macho-explorer` still returns E404, which is worth more than
every row in this document combined.

The row worth defending loudest is still `findcall`, because `ipsw` has no
competitor and its nearest candidate — `dyld xref`, 🚧 WIP, cache-scoped — has now
been WIP for years with a `--slide` flag whose own help text says "not supported
yet". A capability with no live alternative does not decay by being unmaintained; it
just stays absent.

And the row to be most careful about is this document itself. It was wrong about
`ipsw` twelve times, twice in our own favour, and every error came from reading a
name instead of reading the code. §4.8 is the most useful thing in the file.
