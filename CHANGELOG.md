# Changelog

All notable changes to this project are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semver for the public API (`src/api.mjs` and the `--json` envelope).

## [0.1.0-alpha.1] — 2026-10-07

First pre-release. Everything below is what this alpha ships.

### Added

- **`symbolicate` — crash-report addresses to functions** (`src/symbolicate.mjs`,
  `src/crash.mjs`). Reads both Apple report formats and says which it read, because
  they disagree about the one thing that matters: an `.ips` frame is an *offset into
  an image* and the base must be added, while a legacy `.crash` frame is *already
  absolute*. Applying the wrong rule to either yields numbers that look like
  addresses, land inside a real image, and name the wrong function.
  <br>Most frames in a real crash log are in Apple frameworks, and since macOS 11
  those are not files on disk — they are in the dyld shared cache. So the honest
  answer for them is a *reason*, and every unresolved frame carries one: "this
  function is not known" and "there was no file to ask" send you to different
  places, and a bare `0x…` says neither. The address and its owning image are still
  reported, because failing to name a function is not the same as not knowing where
  it was.
  <br>`symbolSource` keeps two different claims apart: a symbol the report already
  carried is `report` and is never recomputed, while one this package read out of a
  file is `binary` — correct for the binary that is there now, which may not be the
  build that crashed. `--no-resolve` parses without reading binaries and says so in
  each frame's reason, so withholding is distinguishable from failing.
- **A friendly message when the file is Apple packaging, not a Mach-O.** Handed a
  `.ipa`, a `.dmg`, a `.pkg` or any of the other containers a person actually has on
  disk, every tool now names the packaging, says how to open it, and — the part that
  matters — lists what *is* accepted. "not a Mach-O binary" is true and useless about
  a `.dmg`; the question it raises is "then what do you take?", and the error now
  answers it. The table lives in `src/container.mjs` and reaches all three doors —
  the library, the CLIs and the MCP server — from one zero-import leaf, so the
  refusals cannot drift apart.
- **`src/container.mjs` exports `APPLE_CONTAINERS`, `ACCEPTED`, `containerFor` and
  `containerMessage`**, so a consumer can tell packaging from a binary without
  matching on an English sentence.
- `macho-explorer <tool> app.ipa` reads the executable inside `Payload/<App>.app`
  whether the archive stores the flat iOS layout or the nested `Contents/MacOS` one.
- **The demo reads a dropped `.app` bundle.** Its headline offered one, but a bundle
  is a directory and `dataTransfer.files[0]` is not the executable, so the drop either
  failed or read the wrong bytes. The drop handler now walks to `Contents/MacOS/`,
  prefers the file named like the bundle, and reports a folder that is not a bundle as
  that rather than as an unreadable Mach-O. The walk is in `demo/bundle-drop.mjs`
  (no DOM) so `test/browser.mjs` can drive it with fake entries — including the
  multi-batch case whose first version recreated the reader each pass and looped
  forever instead of failing.
- **`macho-explorer --help` groups the subcommands by intent** (start here, symbols,
  addresses & code, verify & compare, integrate) and carries four copy-paste examples,
  rather than 19 commands in one alphabetical wall.
- **`ARCHITECTURE.md`** — a contributor-facing design document: the layered shape of
  the system, a module map with the permitted dependency directions, the data flow
  from bytes to facts, the invariants a change must not break, how a change lands,
  and the test and documentation pipelines. It records the one mutual edge in the
  graph (`api.mjs` ↔ `instruction.mjs`) rather than claiming a clean downward one.
- **The README is now short and user-facing** (194 lines, down from 910), opening
  with the project's pitch and keeping the quick start, the tool list, three
  worked examples, the agent surface, and the "what it will not do" table. The
  detailed competitor comparison moved to `docs/use-cases.md` rather than being
  dropped, and the docs site gained an **Architecture** page.
- **`FINDINGS.md`** — a public defect journal: the defects that were live while the
  suite was green, why a green run missed each, and the check that now catches it.
  It gives the mutation tests a face and makes the reader's claims traceable to the
  failures they were written for.
- The README gained a **dated proof strip** and a **"Prove it on real binaries"**
  section that runs the reader against a stock system binary (`/usr/lib/dyld`) and
  shows the real output, so a reader can reproduce the claim rather than take it.

### Fixed

- **`diff` and `fingerprint` resolve both sides of the pair, and blame the right one
  on failure.** Only the first path went through target resolution, so
  `diff App.app App.app` handed the reader a directory while the same two paths in
  the reverse order worked — the natural way to ask whether a rebuild changed a
  bundle. A read error was also always prefixed with the first binary, naming the
  wrong file when it was the second that could not be read, and an empty second
  argument now fails as a usage error rather than silently falling back to a system
  binary the caller never named.
- **The refusal message no longer prints the path twice.** `readerError` embedded the
  path and every CLI prefixed it, so the text door printed `/tmp/F.dmg: /tmp/F.dmg:
  …`. The message now describes the file and the caller names it, once.
- **`.ipa` extraction finds the executable in a real App Store archive.** It searched
  only `Payload/<App>.app/Contents/MacOS/`, which no iOS `.ipa` contains — an iOS
  bundle is flat. It also required an explicit `.app/` directory entry, which many ZIP
  writers omit. Both are fixed, and `test/ipa.mjs` (whose ZIP builder wrote every
  local-header offset as `0`, so it never exercised the reader) now passes.
- **`describe` printed the same fact three times.** The summary line emitted
  `filetype.name`, `buildVersion.platform` and then the flat mirrors of both, so a
  slice read `MH_EXECUTE  macos  macos MH_EXECUTE`; `minos`/`sdk` were likewise
  emitted twice, once from the flat `s.minos` and once from `LC_BUILD_VERSION`. Each
  fact is now printed once. The first command most people run should not look like a
  rendering bug.
- **`--version`/`-V` was accepted and then ignored on every subcommand.**
  `COMMON_FLAGS` made every tool parse it, and nothing acted on it, so
  `macho-explorer describe --version` silently analyzed the default binary instead of
  printing the version. Handled once in `rejectUnknownFlags`, the function every tool
  funnels through, and asserted for every tool in `test/smoke.mjs`.
- **`-q/--quiet` and `-v/--verbose` did nothing on most tools.** Both were advertised
  and parsed through `COMMON_FLAGS`, but only `findcall` and `symbolicate` acted on
  them. Every tool now logs its resolved target to stderr under `--verbose` (so
  `--json` stays clean) and drops its trailing notes under `--quiet`. Asserted on
  every documented invocation in `test/smoke.mjs`: `-v` must add a `[verbose]` line
  and change nothing on stdout.
- **`docs/user-manual.md` showed a `describe` sample that predated the filetype and
  platform columns.** Replaced with a real, reproducible capture (`describe /bin/ls`)
  rather than numbers typed from a binary the reader cannot check.
- **The demo's file picker could not be reached by keyboard.** The `<input type=file>`
  was `display:none`, which removes it from the tab order; it is now visually hidden
  and focusable, with the focus ring drawn on the label.
- **The demo's `--faint` text failed WCAG AA.** `#5b6672` on `#0b0d10` is ≈2.9:1, and
  it colored most of the small print; raised to `#7f8b99` (≈5.6:1).

- **`tbd` — read a `.tbd` text stub.** The only tool here that does not read a Mach-O,
  and the one that answers a question nothing else on a current macOS can.
- `readTbd`, `findSymbol`, `findInSdk` and `parseTbd` exported from `src/api.mjs`, so
  the stub reader is importable and vendorable like the rest.
- `schema/tbd.schema.json`, a per-tool schema like every other tool on the surface.
- `man/man1/tbd.1`, a skill section, and a README section on the libSystem question.

### Why a `.tbd` reader belongs in a Mach-O tool

Since macOS 11 the system dylibs are not files. `/usr/lib/libSystem.B.dylib` is
inside the dyld shared cache, so `nm`, `otool`, `jtool2` and this package's own
symbol tools all have nothing to open. "What does libSystem export" is not a slow
question on a modern machine — it is unanswerable by anything that reads binaries.

The answer is in the SDK, as text:

```
$ macho-explorer tbd --symbol=_pthread_mutex_lock --sdk="$SDK/usr/lib"
_pthread_mutex_lock  —  4 hit(s) in 2 libraries, from 394 stub(s)
  /usr/lib/system/libsystem_pthread.dylib
```

That is the answer you need before reasoning about a call site: it is
`libsystem_pthread.dylib`, **not** `libSystem.B.dylib`, which only re-exports it.
0.7 seconds.

### What the reader is careful about

Each of these was a real bug found while building it, not a precaution.

- **A `.tbd` is a stream of documents, not one.** `libSystem.tbd` holds **39**, one
  per constituent dylib. Reading only the first reports the umbrella's metadata
  and a fraction of its symbols with nothing saying so. Every hit is attributed to
  the document that exports it.
- **A partial answer is withheld.** A stub containing one unread line has an
  *unknown* symbol count, so `tbd` exits 3 and names the line rather than printing
  a number it cannot justify. Exit 1 is reserved for "ran, found nothing".
- **An unread line is not the same as the wrong format.** A Mach-O handed to `tbd`
  once produced "a line I do not understand" — because the "is this a stub?" guard
  was gated on there being no unrecognised lines, and a Mach-O has plenty. Now a
  file with no `--- !tapi-tbd` header is rejected as the wrong format, which is a
  different problem with a different fix.
- **46% of an SDK's stubs are symlinks.** `libm.tbd` is a link to `libSystem.tbd`.
  Without resolution and deduplication, `_pthread_mutex_lock` reads as exported by
  39 files and you look in all 39 — while the install name is identical in all 39
  and nothing in the output contradicts you. The alias count is reported.
- **Re-exports read the `libraries` field, not the whole entry.** An entry is
  `{ targets, libraries }`; walking it wholesale returned the six target triples
  alongside the one library, so `libnetwork.tbd` reported **7** re-exported
  libraries when the file lists 1. All seven were real strings from the file, so
  the wrong answer was entirely plausible.
- **Both format versions, one parser.** v4 is flat; v2 nests three mappings deep
  and writes each symbol as `_name: null` — the names are the *keys*. Reading
  values alone reports a v2 stub as exporting nothing, and the first rule for the
  keys ("only when every value is null") broke on the next line of the same
  mapping, because `_malloc$RENAMED: '@rpath/libmalloc.dylib'` carries a
  re-export annotation. `malloc` vanished from a v2 stub that plainly listed it.
- **`...` is Apple's end-of-document marker**, on the last line of every stub
  Apple ships. Treating it as content puts one unrecognised line on every file,
  and a report that always says "1 unrecognised" trains a reader to ignore the
  field.
- **Exports are item-shaped, not per-symbol.** A v4 entry has its own `targets:`,
  so `libQMIParserDynamic`'s two weak symbols are recorded as x86_64-only while
  its real symbols list all three architectures. Per-symbol targets would have
  buried that.

### The performance bug

`readValue` recomputed bracket depth over the whole accumulated buffer on every
continuation line. That is quadratic, and a flow sequence with 50,000 entries
spread over 2,000 lines triggers it — which `libextension.tbd` (5.1 MB) does on
its own.

An SDK search took **14 minutes**. Tracking the depth incrementally took it to
**0.7 seconds**, and the 5.1 MB file now parses in 0.3 s.

### How it is verified

`test/tbd.mjs` — 127 checks.

- **Fixtures are verbatim excerpts of real SDK files**, not files written to match
  the parser. A generated fixture is a restatement of the parser's assumptions.
- **One fixture is malformed on purpose**, and the reader must refuse it.
- **When a real SDK is present, its stubs must parse with zero unrecognised
  lines.** That is a deterministic stride sample of ~300 files by default, and
  `--full` walks the lot. Sampled rather than exhaustive because a check that
  takes minutes stops being run; deterministic rather than random because a
  failure has to reproduce.

Run against the whole SDK on this machine: **5,304 files, 6,387 documents,
4,743,784 symbols, zero unrecognised lines, zero failures, 15.7 seconds.**

### Also fixed

- `test/skill.mjs` supplied the Mach-O probe binary to every tool, which is the
  wrong operand for `tbd` — so `--sdk` and `--mode` were reported as "accepted by
  no tool". The harness now supplies a real stub, and the case builds
  `[src, ...sub, …]` because `src` is the dispatcher and an invocation without the
  subcommand makes it read `--symbol=_exit` as a verb name.

### Unchanged

No change to the Mach-O reader, so `schemaVersion` stays `1.0` and no consumer
needs to update. `mutation-check` still catches 23 of 23.

---


### Added

- **`overview` and `disasm` on the MCP server**, taking it from 14 tools to 16.
  `overview` is `describe`'s whole answer plus the symbol table and strings on
  request, in one call, and it returns `notRead` in every answer. `disasm` reports
  instruction lengths and direct branch edges as bytes — explicitly not a
  disassembler, and its description says so before the model has to discover it.
  Both are placed in the tool order an agent reads on a cold start, so
  "what is this file" is one call rather than three.
- **A documentation site** (`docs/build.mjs`, seven documents) published alongside
  the audit report. Rendered from the markdown in this repository, so it cannot
  disagree with the code it documents. New documents: `docs/ci-gate.md`,
  `docs/machine-contract.md`, `docs/agent-integration.md`; `docs/user-manual.md`,
  `docs/use-cases.md`, `AUDITABILITY.md` and `CONTRIBUTING.md` are now rendered
  too. `npm run docs:build` regenerates, `npm run docs:check` fails on drift, and
  the Pages workflow gates its deploy on the same check.
- `schema/overview.schema.json`, completing a per-tool schema for every tool on the
  MCP surface.

### Fixed

- **The MCP `arch` enum rejected `arm64e`** while the CLI accepted ten slice
  names. On an arm64e Mac — which is every current Apple-silicon system binary —
  an agent asking for `arm64e` was refused, and the CLI accepted the same value on
  the same file. Two doors, two vocabularies, and the agent-facing one was wrong.
  The enum now matches the CLI's list, which is additive and therefore not a
  breaking change.
- **`test/mcp.mjs` chose its subject by index** (`TOOLS[2]`), so adding `overview`
  shifted it onto `sym` and it failed for a reason unrelated to what it tests. It
  now selects the tool by capability.

### Notes on how it is tested

The two new tools are held to **byte-identical parity with the CLI** on the same
file, not merely to "works". A divergence between the two doors is the worst bug
this package can ship: a model and a person get different instruction boundaries
on the same binary, both well-formed, one wrong.

`docs/build.mjs` is a markdown renderer written here rather than a dependency,
because a markdown library would be the package's first one and the hardest to
remove. That is only defensible because it **fails the build on any construct it
does not handle**, naming file and line — a table rendered as a paragraph looks
finished, and that is worse than a failed build. `test/docs.mjs` asserts the same
property from the output side (no page may contain leftover markdown syntax), and
`test/pages.mjs` asserts the assembled site contains every page the docs link to.

The renderer shipped two real bugs during this work, both **silent** — producing
pages that rendered with literal `**` in the output and nothing thrown:

  - `**bold with *em* inside**` could not match, because the strong pattern's body
    excluded `*`.
  - Fixing that by running the italic pass first was worse: it matched across a
    `**` run and turned `**0**` into `*<em>0</em>*`.

Fixed by scanning delimiter runs rather than by alternation, including the
CommonMark rule that a run of three closes an `em` *and* a `strong` at once. Only
the leftover-syntax assertion caught either, which is why it is in the suite.

### Unchanged

No change to the reader, so `schemaVersion` stays `1.0` and no consumer needs to
update. `mutation-check` still catches 23 of 23.


The CI-gate and agent-readiness surface. No change to the reader, so
`schemaVersion` stays `1.0` and no consumer needs to update.

### Added

- **`--sarif` on `audit` and `fingerprint`** (`src/sarif.mjs`): SARIF 2.1.0 for
  GitHub Code Scanning and any other SARIF consumer. Findings are rules named by
  the reader's own `kind`, so a second run matches the first run's findings rather
  than filing a new alert every build. `--sarif` and `--json` cannot be combined —
  they are two formats for one answer, and silently preferring one produces a
  `.sarif` file containing JSON that fails to parse much later with an error that
  names neither flag. An unreadable file produces a valid SARIF document with
  **no findings**: a workflow typo must not be filed as damage to the binary.
- **Composite GitHub Action** (`action.yml`): audit, fingerprint comparison and
  diff with **no install step**. It runs the reader from the checked-out source, so
  the gate tests this commit rather than whatever a version tag resolved to today.
  Every path arrives through `env:` rather than `${{ }}` interpolation, because
  Actions substitutes expressions before the shell sees the string and a path
  containing a quote or `$(...)` would be code execution. Fields are read with
  `node -p`, not `jq`, which is present on GitHub's images and absent from many
  self-hosted runners.
- **Per-tool JSON Schemas** (`schema/*.schema.json`): one per tool, composed from
  `envelope.schema.json` with `data` constrained to what that tool returns. The
  envelope stays closed (a typo'd field is rejected, so `errorss` cannot read as
  "no errors") while `data` stays open (an added field is ignorable, which is what
  lets a minor release add one). Generated from the shapes the tools emit;
  `npm run schema:check` fails on drift.
- **GitHub Pages audit report** (`.github/workflows/pages.yml`): the browser page
  is now the audit report rather than only a demo. Every number it states about
  itself is fetched from the repository at page load, so a claim cannot survive
  the thing it describes changing. The bundle-freshness gate runs before upload, so
  the published page never runs a parser that no longer matches the source it
  offers for reading.
- **`macho-explorer/conformance` export subpath**: the conformance adapter,
  reachable as a dependency rather than only inside this repository.

### Fixed

- **`schema/envelope.schema.json` omitted `encrypted` from the reason-code enum.**
  The reader emits it for a zero result over App Store ciphertext, so the envelope
  schema rejected correct output from its own package. Found by running every
  tool's real output through its generated schema — the only direction that catches
  a *description* drifting when the code is right.
- **`fingerprint --sarif` with one binary was a crash** rather than a usage error:
  `usage` was not imported in `src/fingerprint.mjs`. Found by `test/sarif.mjs` on
  its first run, which is the argument for writing the test before the feature
  ships rather than after.
- **Regenerated `demo/macho.browser.mjs`**, which had drifted from `src/api.mjs`.
  `demo/link.mjs --check` caught it and `test/browser.mjs` was correctly reporting
  that the demo was not the reader it claims.

### Test suites added

Each covers something no amount of reader testing reaches, and each found at least
one real defect on its first run:

- `test/sarif.mjs` — the SARIF emitter is held to the members a consumer depends
  on. The check that bites is that every `ruleId` appears in the declared rule
  catalog: an undeclared one is not an error to a consumer, it is a finding
  rendered with no name.
- `test/action.mjs` — extracts the shell out of `action.yml` and runs it. Its steps
  are shell, nothing type-checks them, and the file parses as valid YAML whether
  the shell inside it is correct or not. Also asserts every `$VAR` a `run:` block
  reads is declared in that step's `env:`, because Actions passes an undeclared
  variable as an empty string and the reader is then called with no binary.
- `test/schemas.mjs` — every tool's real output against its own schema, plus the
  negative controls that make those assertions meaningful.
- `test/pages.mjs` — the assembled Pages site contains every path the page fetches,
  and loads nothing from a third party. A CDN link would mean the reader being
  audited is not the reader that ran, and the visitor could not tell.
- `test/schema-gen.mjs` — the generator and the drift check.

`test/skill.mjs` gained positive controls for the CI-gate section: that
`audit --sarif` and `fingerprint --sarif` change the output rather than being
accepted and ignored, and that `mapliteral` accepts file offsets as positionals the
way the skill's recipe shows. Both caught invented flags in the skill prose
(`--offsets`, and a `--no-audit` that does not exist).

## [0.1.0] — unreleased

First release. Mach-O introspection for Apple binaries: one auditable,
dependency-free reader with a CLI, a library API, an MCP server, a conformance
corpus and a client-side browser demo.

### Added

- **Reader** (`src/macho.mjs`): fat and thin headers, 32- and 64-bit, `arm64`,
  `arm64e`, `arm64_32`, `x86_64`, `i386`, `armv7`, `armv7k`, `ppc`, `ppc64`;
  load commands, sections, segments, symbol tables, `LC_UUID`, `LC_MAIN`,
  `LC_RPATH`, the `dylib_command` family, `LC_SOURCE_VERSION`,
  `LC_BUILD_VERSION` / `LC_VERSION_MIN_*`, and `LC_ENCRYPTION_INFO*`.
- **Subcommands**: `describe`, `overview`, `sym`, `symlookup`, `findcall`,
  `findliteral`, `mapliteral`, `a2o`, `o2a`, `dump`, `starts`, `assert`,
  `disasm`, `audit`, `fingerprint`, `diff`, and `mcp`. Every one takes `--json`
  and emits the same envelope.
- **Instruction decoding** (`src/instruction.mjs`): instruction lengths and
  direct branch edges for `arm64`, `arm64e` and `x86_64`. Bytes and edges, not
  mnemonics — see "What it will not do" in the README.
- **Library API** (`src/api.mjs`) and TypeScript declarations (`src/api.d.ts`).
- **MCP server** (`src/mcp.mjs`): the tools over the Model Context Protocol,
  dual-era (modern `2026-07-28` and legacy handshake revisions).
- **Conformance corpus** (`conformance/`): a deterministic, built-from-scratch
  Mach-O corpus with known answers, and a runner (`run.mjs`) that holds any
  parser — in any language — to them behind a small JSON interface.
- **Browser demo** (`demo/`): the real reader linked into one client-side
  module, with the bytes never leaving the machine. `test/browser.mjs` proves the
  bundle answers identically to the Node build on every fixture.
- **Auditability** (`AUDITABILITY.md`): the one-file argument, and the recipe to
  verify it.

### Notes

- **Zero runtime dependencies.** `src/macho.mjs` imports only `node:fs` and
  `node:crypto`. There is no build step.
- **Addresses are BigInt**, rendered as `"0x…"` strings under `--json`; a 64-bit
  vaddr does not survive a JSON number.
- **Four exit codes**: `0` found something, `1` found nothing, `2` usage error,
  `3` could not look. A negative answer is a value, not an exception.
- **Licence**: MPL-2.0. It does not extend to any binary the reader is
  pointed at.

[0.1.0-alpha.1]: https://github.com/ranjithrajv/MachO-explorer/releases/tag/v0.1.0-alpha.1
[0.1.0]: https://github.com/ranjithrajv/MachO-explorer/releases/tag/v0.1.0
