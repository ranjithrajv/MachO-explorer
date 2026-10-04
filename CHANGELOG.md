# Changelog

All notable changes to this project are documented here. The format is loosely
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semver for the public API (`src/api.mjs` and the `--json` envelope).

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
- **Licence**: LGPL-3.0-or-later. It does not extend to any binary the reader is
  pointed at.

[0.1.0]: https://github.com/ranjithrajv/MachO-explorer/releases/tag/v0.1.0
