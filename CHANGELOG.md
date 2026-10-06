# Changelog

All notable changes to this project are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semver for the public API (`src/api.mjs` and the `--json` envelope).

## [Unreleased]

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

## [0.1.0] — 2026-10-04

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

[0.1.0]: https://github.com/ranjithrajv/MachO-explorer/releases/tag/v0.1.0
