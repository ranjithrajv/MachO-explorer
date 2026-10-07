# Architecture

This document is for developers and contributors. It describes how MachO-explorer
is put together, why each seam is where it is, and where a change lands. It is not
the user README — that is short and marketing-toned — and it is not the user
manual. This is the open-the-hood document.

The system has one property that shapes every other decision: **the reader is a
single, dependency-free file that a person can audit end to end.** Everything
above it — the tasks, the CLIs, the MCP server, the browser demo — exists to make
that file useful without ever becoming a second implementation of it.

## The shape of the system

At the bottom is `src/macho.mjs`: the whole Mach-O reader, importing nothing but
`node:fs` and `node:crypto`. Above it sits `src/api.mjs`, which exposes named
tasks — describe, search symbols, map an address, scan for calls, audit,
fingerprint — by composing the reader's functions rather than replacing them.
Above *that* sit two doors: the command-line tools in `src/*.mjs` and the MCP
server in `src/mcp.mjs` plus `src/mcp-tools.mjs`. Both doors read through
`api.mjs`; neither knows a byte offset the reader did not give it.

The rule that keeps this shape is: **new format support lands at the bottom
first.** A new load command, a new section attribute bit, a new fact derived from
the header is parsed in `macho.mjs` (or in a small leaf module for a genuinely
different format, like `stub.mjs` or `crash.mjs`), then exposed through `api.mjs`,
then surfaced in the CLI and the MCP tool table. It is never parsed a second time
in a tool.

That rule is not tidiness. The tools began life with a reader each, and they
diverged: one hardcoded a slice offset of `0x4000` that was correct for exactly
one file; another read the architecture list at a fixed offset, which is only
valid for a thin Mach-O; a third treated an absent architecture as fatal rather
than as a preference. Every one of those was a parse bug that no amount of testing
on the binary a tool was written for would have found. Centralising the parse is
what makes them fixable once — and what makes the auditability claim true, because
there is exactly one file to audit.

## Module map

Almost every dependency arrow points *down*, toward `macho.mjs` at the bottom: no
CLI tool, and no door, is imported by anything it sits on. There is exactly one
mutual edge, and it is deliberate rather than a leak — `api.mjs` re-exports the
decoder from `instruction.mjs`, while `instruction.mjs` uses `api.mjs`'s file
lifecycle (`withFile`, `coversAddress`). "How long is the instruction here, and
where does it branch" is the same *kind* of question as `addressToOffset`, and a
caller holding a buffer should not have to spawn a process for it, so it belongs on
the public surface even though it is the one module that reaches back for the file
it is given. It is the only cycle in the graph, and it is the only exception to the
rule below.

| Module | Layer | Responsibility | May depend on |
|---|---|---|---|
| `macho.mjs` | reader | The whole Mach-O format: fat headers, load commands, segments, sections, symbol tables, address↔offset mapping, structural abnormalities, shape digests. | `node:fs`, `node:crypto` only |
| `instruction.mjs` | reader | Instruction lengths and direct branch targets for arm64 and x86_64, plus a linear sweep; the only thing in the package that decodes an instruction, and only far enough to know its length and its direct edge. | `api.mjs` (`withFile`), `macho.mjs` (arch helpers) |
| `api.mjs` | API / tasks | The supported programmatic surface. Wraps the reader: open/close lifecycle, reason codes, and one named task per question. Re-exports the stub reader and the instruction decoder. | `node:fs`, `node:path`, `macho.mjs`, `notread.mjs`, `crash.mjs`, `container.mjs`, `stub.mjs`, `instruction.mjs` |
| `crash.mjs` | formats | The two crash-report shapes — the modern JSON header-plus-body form and the legacy text form — and the rule that a frame's number is an address in one and an offset in the other. | none |
| `stub.mjs` | formats | The text-stub reader: a hand-written parser over the subset of the stub format that is actually used, reporting every line it did not recognise. | `node:fs`, `node:path` |
| `container.mjs` | containers | The table of Apple packaging a user may hand in place of a binary, and the message for it. | none |
| `bundle.mjs` | containers | The configurable application-bundle layout, the bundle extension, and the per-platform fallback target. | `node:fs` |
| `ipa.mjs` | containers | A deliberately incomplete ZIP reader that locates and extracts the executable inside an app archive. | `node:fs`, `node:path`, `node:os`, `node:zlib`, `bundle.mjs` |
| `target.mjs` | resolution | Resolves an argument, an environment variable, a bundle, or a fallback into the one binary a tool should read. | `node:fs`, `node:path`, `macho.mjs`, `bundle.mjs`, `ipa.mjs`, `container.mjs` |
| `version.mjs` | plumbing | Reads the package version from `package.json`, or from the embedded asset when running as a single executable. | `node:module` |
| `notread.mjs` | plumbing | The list of things the package does not parse, as data, so all three doors cannot disagree. | none |
| `output.mjs` | plumbing | Argument parsing, valued-flag handling, unknown-flag rejection, the JSON envelope, the exit-code taxonomy, and complete-write output. | `node:fs`, `notread.mjs`, `version.mjs` |
| `macho-explorer.mjs` | plumbing | The subcommand dispatcher; validates the verb and dynamically imports one tool. | `node:path`, `node:url`, `node:fs` |
| `describe.mjs`, `overview.mjs`, `sym.mjs`, `symlookup.mjs`, `findcall.mjs`, `findliteral.mjs`, `mapliteral.mjs`, `a2o.mjs`, `o2a.mjs`, `dump.mjs`, `starts.mjs`, `assert.mjs`, `disasm.mjs`, `audit.mjs`, `fingerprint.mjs`, `diff.mjs`, `tbd.mjs`, `symbolicate.mjs` | CLI tools | One question each. Parse flags, resolve the target, call one or more `api.mjs` tasks, and print text to stdout or one JSON envelope. `audit` and `fingerprint` also emit SARIF. | `target.mjs`, `api.mjs`, `output.mjs`, `macho.mjs`, `sarif.mjs` |
| `mcp.mjs` | agent surface | JSON-RPC transport, modern/legacy era negotiation, and the stdout guard that diverts any non-protocol write. | `mcp-tools.mjs`, `output.mjs`, `version.mjs` |
| `mcp-tools.mjs` | agent surface | The tool table, input schemas, the hand-written validator, and the short text rendering per tool. | `output.mjs` (`SCHEMA_VERSION`), `notread.mjs`, `container.mjs`; imports `api.mjs`/`macho.mjs` lazily inside handlers |
| `sarif.mjs` | CI surface | SARIF 2.1.0 for `audit` and `fingerprint`, with rule ids derived from the reader's own finding kinds. | `version.mjs` |
| `demo/link.mjs` | build / demo | Mechanically links the host shim and the three reader modules into one browser module; `--check` fails if the committed bundle is stale. | `node:fs`, `node:path` |
| `demo/runtime.mjs` | build / demo | The host shim: `Buffer`, `node:fs` over an in-memory registry, a synchronous SHA-256, and the slice of `node:path` the reader touches. | none |
| `demo/bundle-drop.mjs` | build / demo | Resolves a dropped application-directory entry to its executable, over the directory-reader contract the browser supplies. | none |
| `docs/build.mjs` | build / demo | The from-scratch markdown renderer for the documentation site. | `node:fs`, `node:path`, `node:url` |

The direction matters in one specific way beyond aesthetics. `macho.mjs` must
import nothing from this project, because it is the file a reviewer reads to
decide whether the package is safe to vendor, and every import is one more thing
that file does not contain. The leaves — `notread.mjs`, `container.mjs`,
`crash.mjs` — are import-free for the same reason: the MCP door reaches them
without pulling `api.mjs` and its transitive graph behind it, and the MCP server
is what an agent loads first, so every module it must resolve is one more thing
that can fail before a tool is reachable.

## The layered data flow

The reader turns bytes into facts in a fixed order. Nothing above it skips a
stage, and no stage re-derives what a lower one already answered.

```
  describe  sym  findcall  audit  …          mcp.mjs / mcp-tools.mjs
       \        |        /                          |
        \       |       /                           |
         +------+------+----------------------------+
         |                 api.mjs                  |   tasks, the public surface
         +---+------------------+-------------+-----+
             |                  |             |
        macho.mjs        instruction.mjs   crash.mjs / stub.mjs
        (the reader)     (lengths, edges)  (other formats)
```

The stages, bottom to top:

- `opener(path)` opens the file and returns a bounded reader with a small read
  cache. The cache is why a 476 MB universal binary does not become hundreds of
  thousands of syscalls: walking load commands and the symbol table re-reads the
  same pages many times.
- `parseFat(f)` reads the fat header and each `fat_arch` record. Slice offsets are
  read from the table, never assumed — the two slices of one measured binary sat at
  `0x4000` and `0xf16c000`, and a reader that hardcoded either would work on that
  file and nowhere else.
- `slicesOf(f)` normalises the two shapes: a fat file becomes its slice records, a
  thin file becomes a single synthetic slice with `thin: true`. Callers then handle
  one shape.
- Slice selection is a *question*, not a default. `richestSlice` takes the slice
  with the most symbols, because a universal binary can be stripped on one
  architecture and not the other. `preferredSlice` treats a requested architecture
  as a preference that falls back to the richest. `layoutSlices` takes the first
  slice that parses, because an address-mapping question is about a slice's layout
  and a stripped slice can be the one being asked about.
- `parseThin(f, base)` reads the thin header at a slice offset and walks the load
  commands, collecting segments, sections, the symbol table, the UUID, the entry
  point, the runtime search paths, the linked libraries, the build version, and the
  encryption command. This is the fact-producing stage.
- Above that, `api.mjs` composes. `describe` is the parse plus symbol counts and
  structural checks; `overview` is `describe` plus one slice's symbols and strings,
  pinned by offset so the two inventories cannot come from different architectures;
  `searchSymbols`, `findCalls`, `findLiteral`, `audit`, `fingerprint`, and `diff`
  are each a reader parse plus a small amount of arithmetic. `api.mjs` opens and
  closes the file around each task (`withFile`) and maps a genuine read failure to a
  reason code; it never re-implements a parse.
- The CLI tools call those tasks. `mcp-tools.mjs` calls the same tasks through
  dynamic `import()`, wraps the same result in the same envelope, and adds a text
  rendering a model can read. The two doors differ in transport and in vocabulary
  of failure, never in what a fact means.
- The browser path reuses the same three modules. `demo/link.mjs` strips the
  `import`/`export` boundaries from `macho.mjs`, `instruction.mjs`, and `api.mjs`,
  prepends `demo/runtime.mjs`, and emits one module. It is a mechanical transform:
  it renames nothing and reorders nothing, and `test/browser.mjs` requires the
  bundle to produce byte-for-byte the same `describe` and `overview` answers as the
  Node build on every fixture.

## The invariants

These are the load-bearing rules. A change that breaks one is a bug even if every
test passes.

- **No runtime dependencies.** `package.json` has no `dependencies`, and the reader
  imports only Node builtins. The alternative is a transitive tree between the
  bytes and the answer, which is exactly the surface this package exists to shrink.
- **The reader stays one auditable file.** New format support lands in
  `macho.mjs`. A second implementation anywhere — a separate parser in a tool, a
  hand-maintained browser copy — is a second answer free to disagree with the first.
- **Facts versus guesses.** Instruction *lengths* and *direct branch edges* are
  facts about the byte stream; a mnemonic is not. `disasm` reports boundaries and
  resolved direct targets and stops there. A direct call site is a site worth
  disassembling, not a proven edge, because indirect and stub calls encode no
  target. The offset `LC_MAIN` records is reported raw, with no address derived,
  because the derivation is one arithmetic step a caller can make and this package
  declines to make a second, independently-computed answer.
- **A negative result is a value, not an exception.** No match is
  `{ matches: [] }`, `ok: true`, exit 1. A failed assertion is `passed: false`, not
  an error. Only an unreadable file throws, and that throw carries a `.code` so a
  caller can branch without matching English.
- **Addresses are `"0x…"` strings at the JSON boundary.** They are `BigInt` inside
  the reader, because a 64-bit virtual address does not survive a `Number` — anything
  above 2^53 loses its low bits, and a silent precision loss looks exactly like a
  correct answer. Every address is rendered by one replacer in `output.mjs` and one
  equivalent in `mcp.mjs`, so a new tool cannot forget it.
- **`notRead` travels with every payload.** The list of what the package does not
  parse — code signature, entitlements, Objective-C and Swift metadata, DWARF,
  chained fixups, disassembly mnemonics — is injected by `output.mjs` for the CLIs
  and by the guard in `mcp-tools.mjs` for the agent door. An empty field on a binary
  that lacks a section and an empty field from a reader that never looked are the
  same characters in JSON, and this field is the only thing that separates them.
- **stdout is data, stderr is prose.** Under `--json`, narration, per-slice
  commentary, and "none found" prose all go to stderr, so a pipeline that parses
  stdout cannot read a diagnostic as a fact. Both streams are written by
  `writeAllSync`, because `process.exit` discards whatever an asynchronous pipe
  write has not yet flushed.
- **Exit codes distinguish "found nothing" from "could not look".** A scan of an
  encrypted slice returns exit 3 with the reason `encrypted`, never exit 1 — a zero
  from ciphertext is not evidence that a symbol is absent.
- **No application knowledge.** The reader knows the file format and nothing about
  any program that is stored in it. No product name appears in the source, the
  tests, or the published package, and the `boundary:` check in `test/smoke.mjs`
  enforces that with a positive control.

## The contracts that make it composable

Four things are promised to a consumer, and each is promised in a place the code
cannot quietly abandon.

- **A versioned JSON envelope.** Every tool answers `--json` with one object whose
  first key is `schemaVersion` (currently `1.0`), followed by `tool`, `ok`,
  `binary`, `errors`, and `data`, with `messages` and `notes` when there is
  something to say. The major number bumps on a removal, a rename, or a change of
  meaning; the minor on an added field. A new tool is not a change to the envelope,
  which is the point of having one.
- **A schema per tool.** `schema/envelope.schema.json` pins the shared shape and
  leaves `data` unconstrained; each tool has its own schema that references the
  envelope and replaces `data` with the shape that tool returns. They are generated
  by `test/schema-gen.mjs` and `npm run schema:check` fails if the committed files
  differ, so a description cannot drift from the code.
- **Four exit codes.** `0` ran and found something, `1` ran and found nothing, `2` a
  usage error, `3` could not do the job. The taxonomy exists so that "no matches" and
  "could not read the file" cannot be reported the same way.
- **A documented flag is not accepted and ignored.** `rejectUnknownFlags` refuses a
  flag a tool does not take, with a near-miss suggestion, because a silently ignored
  `--regex` typo answers a different question than the one asked. `--version`, which
  once parsed and changed nothing, is handled once at the function every tool funnels
  through.

## How a change lands

There are two common shapes of change, and one test that governs both.

**New format support.** Parse it in `macho.mjs`. Expose the resulting fact through
the relevant `api.mjs` task. Surface it in the CLI tool that answers the question it
belongs to, and add it to the MCP tool's schema and description. The tests come
last and assert the fact through the API, not through the text of a tool. A patch
that parses a new command inside `describe.mjs` will be asked to move, because it
has created a second reader.

**A new tool.** Add `src/<tool>.mjs`, register it in `package.json`'s `bin` and in
`src/macho-explorer.mjs`'s subcommand list, add it to the roster in `output.mjs`
(which `test/smoke.mjs` walks to check that every tool answers `--help` and refuses
unknown flags), add an MCP entry in `mcp-tools.mjs` if an agent should reach it,
generate its schema, add a man page, and cross-reference it from the skill. A tool
that exists but is absent from the roster gets none of the shared checks, so being
added to it is part of being added at all.

**The scope test.** Before a change lands, ask whether it makes the package *worse
at the thing it is for* — a file small enough to audit that turns bytes into facts
without guessing. A new dependency, a second parser, a derived value presented as a
measurement, a silent truncation: each buys something and costs the property the
package is chosen for. That cost is the reason to refuse the change, and the reason
is written down rather than assumed.

## The test architecture

The suites are separate because each establishes a different kind of claim, and a
suite that asserts too much stops being able to fail for one reason.

| Suite | What it establishes |
|---|---|
| `test/fixtures.mjs` and `--check` | Builds the binary corpus from code, writing its own constants rather than importing the reader's, so a typo in a constant cannot be shared. `--check` asserts every byte matches the generator. |
| `test/smoke.mjs` | Runs the tools against the fixtures (exact counts, exact addresses) and against system binaries (invariants only, because a compiler release must not fail the suite). Leans on the negative paths, includes a positive control for the call scanner, and enforces the no-application-knowledge boundary. |
| `test/browser.mjs` | The bundle matches its sources and imports no Node builtin; the shim's `Buffer` and SHA-256 match Node's; `describe` and `overview` are byte-identical across hosts; the dropped-bundle walk resolves. |
| `test/schemas.mjs` and `schema:check` | The real output of the real tool validates against its own schema, and the schema rejects what it should — a typo'd field, an address as a number — so a permissive validator cannot pass. |
| `test/sarif.mjs` | Every `ruleId` resolves to a declared rule, `executionSuccessful` is true, and only SARIF's own level vocabulary appears. |
| `test/mcp.mjs` | Drives a real server over a real pipe; asserts every line of stdout is well-formed JSON-RPC, that the eras negotiate, and that EOF exits cleanly. |
| `test/skill.mjs` | Every command, flag, and exit code the Agent Skill names exists and means what the skill says. |
| `test/mutation-check.mjs` | Reintroduces each historical defect into a temporary copy and asserts `smoke.mjs` notices. |
| `test/docs.mjs` and `test/pages.mjs` | The documentation site and the Pages assembly are complete and internally consistent. |

`test/mutation-check.mjs` exists because a passing smoke test proves nothing on its
own. Every defect the suite guards against was at some point live while the suite
was green: a fixed slice offset, a signed arm64 mask that never matched, a chunk
loop that could not terminate, imported symbols matched as enclosing functions, an
absent architecture treated as fatal, section reads with no slice base. The suite
now asserts each of those, so the mutation check reintroduces them one at a time —
faithfully, restoring the *actual* original defect rather than approximating it —
and fails if the suite does not react. The first attempt at this check removed only
one of two guards around the imported-symbol bug and still passed, which is exactly
the danger: a green result from an incomplete mutation reads as coverage and
establishes nothing. Mutations run against a copy in a temporary directory, never
the working tree.

## The documentation pipeline

`docs/build.mjs` renders the repository's markdown into the documentation site. It
is a renderer written here rather than pulled as a dependency, because a markdown
library would be the first dependency anybody would add and the hardest to remove.

A hand-rolled renderer has one characteristic failure: a construct it has no branch
for is emitted as a paragraph. The page renders, nothing throws, and a table becomes
a paragraph of pipes that reads as though it were correct. So the renderer takes the
opposite position: **any construct it does not handle is a build failure.** It
collects every unhandled construct and exits non-zero, naming the file and the line.
The supported set is closed and deliberate — ATX headings, fenced code, pipe tables,
one level of list nesting, blockquotes, thematic breaks, paragraphs, and inline code,
bold, italic, and links — and each absent construct is absent because nothing in the
repository uses it, not because it was forgotten.

`test/docs.mjs` asserts the same property from the output side, which is the
direction the builder cannot check itself: no rendered page may contain leftover
markdown syntax, every internal anchor must resolve, every page must contain its
structural elements, and every source document must have produced a page. The two
checks cannot both be satisfied by a renderer that quietly degrades.

One rewrite happens on the way through: a link to a source document — `[x](docs/x.md)`
or `[x](AUDITABILITY.md)` — is pointed at the page it renders to (`./x.html`,
`./auditable.html`). The link is then correct both in the repository and in the site,
so the source does not have to choose one and break the other. Only declared pages
are rewritten; a link to a file the site does not contain is left exactly as written,
because rewriting it would invent a target.

The Pages workflow assembles the public site from named paths rather than pointing
at the repository root: the demo directory, the three reader modules the bundle is
built from, the envelope schema, `package.json`, and the two fixture binaries the
sample buttons fetch. It runs `docs/build.mjs` to render the site, and — before any
upload — `demo/link.mjs --check`, because a published page running a bundle that no
longer matches the source it offers for reading is worse than no page at all. The
page fetches nothing from a third party, and `test/pages.mjs` asserts both that
every path the page fetches is present in the assembled site and that the workflow
cannot lose the bundle-freshness step.

The through-line is the same at every layer: a fact is produced once, the seam where
it crosses to a consumer is versioned and checked, and any check that cannot fail is
treated as worse than no check at all.
