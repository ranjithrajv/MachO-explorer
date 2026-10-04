# MachO-explorer User Manual

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Quick Start](#quick-start)
4. [Global Flags](#global-flags)
5. [Binary Resolution](#binary-resolution)
6. [JSON Output](#json-output)
7. [Exit Codes](#exit-codes)
8. [Subcommands](#subcommands)
   - [describe](#describe)
   - [overview](#overview)
   - [sym](#sym)
   - [symlookup](#symlookup)
   - [findcall](#findcall)
   - [findliteral](#findliteral)
   - [mapliteral](#mapliteral)
   - [a2o](#a2o)
   - [o2a](#o2a)
   - [disasm](#disasm)
   - [audit](#audit)
   - [fingerprint](#fingerprint)
   - [diff](#diff)
   - [mcp](#mcp)
9. [Environment Variables](#environment-variables)
10. [Configuration](#configuration)
11. [MCP Server](#mcp-server)
12. [Library Usage](#library-usage)
13. [Scripting Examples](#scripting-examples)
14. [Troubleshooting](#troubleshooting)

---

## Overview

MachO-explorer is a single CLI for inspecting Mach-O binaries — the executable format used by macOS, iOS, iPadOS, tvOS, watchOS, and visionOS. It reads fat headers, symbol tables, sections, load commands, instruction boundaries, and direct branch edges, and answers questions about binaries you know nothing about.

**Key properties:**

- **Zero dependencies** — pure Node.js, no `npm install` needed
- **No build step** — runs directly from source
- **Cross-platform** — Linux, macOS, and Windows
- **Scriptable** — every subcommand emits JSON on stdout
- **Composable** — pipe output to `jq`, `grep`, or any JSON consumer

## Installation

### Global install

```sh
npm install -g macho-explorer
```

### Vendor the source

Copy `src/` to your project. The only file you need for raw reading is `src/macho.mjs` — it imports nothing but `node:fs`.

### Requirements

Node.js ≥ 22.15

## Quick Start

```sh
# What is in this binary?
macho-explorer describe /usr/local/go/bin/go

# Search for a symbol
macho-explorer sym 'runtime.main' /usr/local/go/bin/go

# Which function contains this address?
macho-explorer symlookup 0x100085c30 -b /usr/local/go/bin/go

# Find all direct calls to a function
macho-explorer findcall 0x100085c30 /usr/local/go/bin/go

# Find a byte literal (e.g., a format magic)
macho-explorer findliteral LZ4 "/Applications/Some App.app"

# Convert address to file offset
macho-explorer a2o 0x100085c30 -b /usr/local/go/bin/go

# Convert file offset to address
macho-explorer o2a 0x85c30 -b /usr/local/go/bin/go

# Disassemble instructions at an address
macho-explorer disasm 0x100085c30 /usr/local/go/bin/go

# Check structural consistency
macho-explorer audit /usr/local/go/bin/go

# Compare two binaries
macho-explorer fingerprint v1.0/app v1.1/app
macho-explorer diff v1.0/app v1.1/app

# Get everything in one call
macho-explorer overview --symbols --strings /usr/local/go/bin/go
```

## Global Flags

Every subcommand accepts these flags:

| Flag | Short | Description |
|---|---|---|
| `--json` | | Emit one JSON object on stdout; all prose goes to stderr |
| `--binary <path>` | `-p` | The binary to read (for subcommands where every positional is a query) |
| `--arch=<name>` | | Restrict to one architecture. A preference, not a requirement |
| `--quiet` | `-q` | Suppress non-essential output (notes, progress, summaries) |
| `--color` | | Force color output |
| `--no-color` | | Disable color output |
| `--verbose` | `-v` | Diagnostic output (parsing steps, timing) |
| `--help` | `-h` | Print usage and exit 0 |
| `--version` | `-V` | Print version and exit 0 |

### Flag parsing

- `--flag=value` and `--flag value` are both accepted
- `--` ends flag parsing (useful for paths starting with `-`)
- An unrecognised flag is a usage error (exit 2) with a "did you mean" suggestion

```sh
$ macho-explorer sym --regexx 'runtime\.main' /path/to/binary
unknown flag: --regexx

  did you mean --regex?
```

## Binary Resolution

When you don't pass a binary explicitly, the tool resolves one in this order:

1. **Explicit argument** — a positional or `-b`/`--binary`
2. **`$MACHO_EXPLORER_BINARY`** — a path to an executable
3. **`$MACHO_EXPLORER_APP`** — a `.app` bundle; the executable is found inside it
4. **Fallback** — a system binary (`/bin/ls` on Unix, `null` on Windows)

```sh
macho-explorer sym 'someSymbol' /path/to/binary
MACHO_EXPLORER_APP="/Applications/Some App.app" macho-explorer sym 'someSymbol'
```

Some subcommands (`symlookup`, `a2o`, `o2a`) take only addresses or offsets as positionals, so their binary **must** come from `-b` or the environment — a path cannot be told apart from a query by position.

## JSON Output

Every subcommand accepts `--json`. Two guarantees:

1. **stdout is JSON only** — progress lines, per-slice narration, and "none found" prose all go to stderr
2. **One envelope, always** — the same shape, whether the answer is positive or negative

### Envelope shape

```json
{
  "schemaVersion": "1.0",
  "tool": "describe",
  "ok": true,
  "binary": "/path/to/binary",
  "errors": [],
  "messages": [],
  "notes": [],
  "data": { ... }
}
```

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | string | Envelope version. Pin this in consumers |
| `tool` | string | Subcommand name |
| `ok` | boolean | `true` if the tool found something, `false` if it ran and found nothing |
| `binary` | string\|null | The binary that was read |
| `errors` | string[] | Machine-readable reason codes |
| `messages` | string[] | Prose for humans (optional) |
| `notes` | string[] | Caveats and warnings (optional) |
| `data` | object | The actual answer |

### Reason codes

| Code | Meaning |
|---|---|
| `io` | File could not be read |
| `unknown-encoding` | File is not a Mach-O, or uses an unsupported architecture |
| `bad-address` | Address is not valid for this binary |
| `bad-pattern` | Search pattern is invalid |
| `no-match` | Search ran, found nothing |
| `no-call-sites` | No direct calls found |
| `no-symbols` | Binary has no symbol table |
| `no-code-at-address` | Address is not in a code section |
| `missing-pattern` | A positional that looks like a binary was passed instead of a pattern |

### Addresses in JSON

Addresses are emitted as `"0x..."` strings, never JSON numbers. A 64-bit virtual address does not survive a `Number` — anything above 2^53 loses its low bits.

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Ran, found something |
| 1 | **Ran, found nothing.** A negative answer, not an error |
| 2 | Usage error — bad or missing arguments |
| 3 | Could not do the job — unreadable file, unparseable Mach-O |

`audit` and `diff` use exit 1 for a *negative answer*: "this file is not sound" or "these are different programs". An unreadable file still exits 3, so a mistyped path in a CI script can never be mistaken for a clean result.

---

## Subcommands

### describe

What is in this binary? Reports every slice with its architecture, extent, symbol counts, `__TEXT` bounds, UUID, header flags, entry point, rpaths, source version, and linked libraries.

```sh
macho-explorer describe /usr/local/go/bin/go
macho-explorer describe --sections /usr/local/go/bin/go
macho-explorer describe --segments /usr/local/go/bin/go
macho-explorer describe --loads /usr/local/go/bin/go
```

**Flags:**

| Flag | Description |
|---|---|
| `--sections` | List every section: segment, name, address, size, type |
| `--segments` | List every segment: name, vm range, file range |
| `--loads` | List every load command by name and size |
| `--arch=<name>` | Read one slice of a universal binary |

**Example output:**

```
/usr/local/go/bin/go — 14.5 MB, universal, 2 slice(s)

  x86_64   file 0..85082112  64-bit  19526 defined / 19526 symbols  1 code section(s) __text 0x100000170+5880564
           uuid 36c0025e-345b-3249-9632-57ecd522df3b
           flags MH_NOUNDEFS MH_DYLDLINK MH_TWOLEVEL MH_PIE
           entry entryoff 2424 stack 0  (no address derived; see --json entryPoint.note)
           dylib /usr/lib/libSystem.B.dylib
           source version 479.0.0.0.0
  arm64e   file 85082112..170164224  64-bit  19526 defined / 19526 symbols  1 code section(s) __text 0x100000170+5880564
           ...
```

---

### overview

The whole structural picture in one call. Reads the file once and answers once, so a symbol table and a string list in the same answer always come from the same architecture.

```sh
macho-explorer overview /usr/local/go/bin/go
macho-explorer overview --symbols --strings /usr/local/go/bin/go
macho-explorer overview --json --compact --symbols /usr/local/go/bin/go | jq '.data.symbols.count'
```

**Flags:**

| Flag | Description |
|---|---|
| `--symbols` | Include the symbol table (defined names, deduplicated) |
| `--strings` | Include the C-string section contents |
| `--max=<n>` | Cap on each inventory (default 4000; 0 = unlimited) |
| `--min=<n>` | Shortest string to report (default 4) |
| `--compact` | Single-line JSON instead of indented (41% smaller) |
| `--arch=<name>` | Read one slice of a universal binary |

**Design principles:**

- **Inventories are opt-in and capped** — structure is 9.2 KB of JSON; 19,526 symbols turn that into 422 KB
- **`notRead` is in every result** — code signature, entitlements, export trie, ObjC/Swift metadata, dSYM/DWARF, FAT32
- **Zero is never bare** — no `__cstring` section gives zero strings *and a note saying the section is absent*

---

### sym

Search a symbol table by substring or regex.

```sh
macho-explorer sym 'runtime.main' /usr/local/go/bin/go
macho-explorer sym --regex 'runtime\..*main' /usr/local/go/bin/go
macho-explorer sym --all-imp 'malloc' /usr/local/go/bin/go
macho-explorer sym --in ./artifacts --matched-only 'CCrypt'
```

**Flags:**

| Flag | Description |
|---|---|
| `--regex` | Treat the pattern as a regular expression |
| `--case-sensitive` | Match case exactly |
| `--all-imp` | Include imported symbols, not just defined ones |
| `--no-dedupe` | One row per table entry rather than per name |
| `--arch=<name>` | Prefer an architecture |
| `--in <paths>` | Search a file or directory instead of one binary (comma-separated) |
| `--matched-only` | List only the files that matched (with `--in`) |
| `--per-file <n>` | Match names kept per file (default 10; 0 keeps counts only) |
| `--max-files <n>` | Stop after this many files (default 20000) |
| `--max-depth <n>` | Directory depth limit (default 6) |

**Corpus mode:** `--in` searches many binaries with the same envelope. Non-Mach-O files under a directory are skipped, not failed.

---

### symlookup

Which function contains this virtual address? Reads symbols directly, because `nm` on a large universal binary is unusable.

```sh
macho-explorer symlookup 0x100085c30 -b /usr/local/go/bin/go
macho-explorer symlookup 0x100085c30 0x100085c40 -b /usr/local/go/bin/go
```

**Flags:**

| Flag | Description |
|---|---|
| `--arch=<name>` | Read one architecture |

Every positional is an address. The binary comes from `-b`, `$MACHO_EXPLORER_BINARY`, or `$MACHO_EXPLORER_APP`.

---

### findcall

Direct `call`/`jmp` xrefs to an address, or the distinct targets a binary calls.

```sh
macho-explorer findcall 0x100085c30 /usr/local/go/bin/go
macho-explorer findcall --list /usr/local/go/bin/go 20
```

**Flags:**

| Flag | Description |
|---|---|
| `--list` | List distinct call targets instead of querying one |
| `--include-data` | Widen the scan from code sections to every section |
| `--arch=<name>` | Read one architecture |

**Important:** Only *direct* calls are found. Indirect calls (`call [rip+disp]`, register calls, PLT stubs) do not encode their target in the instruction.

---

### findliteral

Find a byte literal anywhere in a file, or list the strings already in the binary.

```sh
macho-explorer findliteral LZ4 "/Applications/Some App.app"
macho-explorer findliteral \x1f\x8b --text /usr/bin/ssh
macho-explorer findliteral --strings /usr/local/go/bin/go
macho-explorer findliteral --strings --filter=error /usr/local/go/bin/go
```

**Flags:**

| Flag | Description |
|---|---|
| `--text` | Search `__TEXT` only, rather than the whole file |
| `--strings` | List the strings in the binary instead of searching for one |
| `--min=<n>` | With `--strings`, shortest string to report (default 4) |
| `--filter=<s>` | With `--strings`, only strings containing this |
| `--arch=<name>` | Read one slice of a universal binary |

The literal is matched as raw latin1 bytes, so escapes work.

---

### mapliteral

Map a literal to its addresses, then find the pointers to them — which is how you find the code that handles a format.

```sh
macho-explorer mapliteral LZ4 "/Applications/Some App.app"
macho-explorer mapliteral irrelevant 0x3f8a0 /usr/bin/ssh
```

**Flags:**

| Flag | Description |
|---|---|
| (none) | All flags are global |

Positional file offsets are absolute, as reported by `findliteral`. Use them for a magic that is assembled at runtime.

---

### a2o

Which byte of the file is this virtual address? Reports both the slice-relative and the absolute offset.

```sh
macho-explorer a2o 0x100085c30 -b /usr/local/go/bin/go
macho-explorer a2o 0x100001000 0xdeadbeef00 -b /usr/local/go/bin/go
```

**Flags:**

| Flag | Description |
|---|---|
| `--arch=<name>` | Read one architecture |

Every positional is an address. The binary comes from `-b` or the environment.

**Three outcomes:**

| Outcome | Meaning |
|---|---|
| `offset: 0x85c30` | Mapped, and there is a byte at that position |
| `zerofill: true` | Mapped, but there is **no byte** — `__bss`, `__noptrbss`, `__PAGEZERO` |
| `mapped: false` | Not in this binary at all |

---

### o2a

Which virtual address does this file offset have? Reports every slice's answer, since one offset means a different address in each.

```sh
macho-explorer o2a 0x85c30 -b /usr/local/go/bin/go
macho-explorer o2a 4096 8192 -b /usr/local/go/bin/go
```

**Flags:**

| Flag | Description |
|---|---|
| `--arch=<name>` | Read one architecture |

Offsets are absolute positions in the file, accepted as decimal or as hex with a `0x` prefix. Every positional is an offset.

---

### disasm

Where do instructions start and end at this address, and where do they branch?

```sh
macho-explorer disasm 0x100085c30 /usr/local/go/bin/go
macho-explorer disasm --branches 0x100085c30 /usr/local/go/bin/go
macho-explorer disasm --arch=arm64 --count=16 /usr/local/go/bin/go
```

**Flags:**

| Flag | Description |
|---|---|
| `--branches` | Report only branches, as resolved `{from, to}` edges |
| `--count=<n>` | Instructions to decode (default 32; 0 = no cap, only sensible with `--bytes`) |
| `--bytes=<n>` | Decode a byte range instead of a count |
| `--arch=<name>` | Read one architecture |

**Architectures:** `arm64`, `arm64e`, and `x86_64` are decoded. Any other architecture is reported as `unknown-encoding` and exits 3.

**Important:** This is a linear sweep, not recursive descent. Padding and data interleaved in the code section are decoded as instructions too. Start at a symbol address for best results.

---

### audit

Is this file internally consistent? Checks every structural claim the file makes about itself.

```sh
macho-explorer audit /usr/local/go/bin/go
macho-explorer audit --strict build/Contents/MacOS/app
```

**Flags:**

| Flag | Description |
|---|---|
| `--strict` | Fail on warnings as well as errors |
| `--arch=<name>` | Audit only this slice; container findings are still reported |

**Severity levels:**

| Level | Meaning |
|---|---|
| `error` | The file disagrees with itself — a size or extent points at bytes that are not there |
| `warning` | The file parsed and the answers are probably right, but something is unfamiliar or heuristic |

By default only errors fail. `--strict` fails on warnings too.

---

### fingerprint

Is this the same program as that one? A digest that survives a rebuild.

```sh
macho-explorer fingerprint /usr/local/go/bin/go
macho-explorer fingerprint v1.0/libthing.dylib v1.1/libthing.dylib
```

**Flags:**

| Flag | Description |
|---|---|
| `--arch=<name>` | Fingerprint only this slice |

**Three questions, three answers:**

| Question | Answer |
|---|---|
| Same build? | The `LC_UUID`. Exact, and useless the moment anything is relinked |
| Same program? | The fingerprint. Survives a rebuild; changes if a symbol or a section does |
| Same shape? | Structure. Weaker, and all a stripped binary can offer |

---

### diff

What changed between two binaries — structural facts only, so a rebuilt pair does not read as a different program.

```sh
macho-explorer diff v1.0/libthing.dylib v1.1/libthing.dylib
macho-explorer diff --json a b | jq '.data.differences[].category' | sort | uniq -c
```

**Flags:**

| Flag | Description |
|---|---|
| `--arch=<name>` | Compare only this architecture |
| `--max=<n>` | Cap on symbol names listed per direction (default 20) |

**Three lists:**

| List | Description |
|---|---|
| `differences` | Structural changes — the verdict is computed from these alone |
| `buildMetadata` | UUIDs, and the presence of signing/provenance commands |
| `sizeChanges` | Section sizes, reported because they matter and counted separately |

---

### mcp

Serve the tools over the Model Context Protocol (JSON-RPC on stdin/stdout).

```sh
macho-explorer mcp
```

**MCP tools:** `describe`, `sym`, `symlookup`, `findcall`, `findliteral`, `mapliteral`, `a2o`, `o2a`, `audit`, `fingerprint`, `diff`

Each returns the same JSON envelope the CLI emits under `--json`, plus a short text block.

**Protocol versions:** Both the modern `2026-07-28` revision (per-request `_meta`, no handshake) and the legacy `initialize` handshake back to `2024-11-05`.

---

## Environment Variables

| Variable | Description |
|---|---|
| `MACHO_EXPLORER_BINARY` | Path to an executable to read |
| `MACHO_EXPLORER_APP` | Path to a `.app` bundle; the executable is found inside it |
| `MACHO_EXPLORER_CONFIG` | Path to a replacement `config.json` |
| `NO_COLOR` | Disable color output |
| `TERM=dumb` | Disable color output |

## Configuration

`config.json` holds facts about the world rather than the format: the bundle convention (`.app`, `Contents/MacOS`) and the scan chunking. Both are overridable with `$MACHO_EXPLORER_CONFIG`.

```sh
echo '{"bundle":{"ext":".bundle","macosDir":["bin","exec"]}}' > /tmp/alt.json
MACHO_EXPLORER_CONFIG=/tmp/alt.json macho-explorer sym 'someSymbol'
```

A malformed override falls back to the shipped values rather than failing.

## MCP Server

Register with a client:

```sh
claude mcp add macho -- macho-explorer mcp
```

```json
{ "mcpServers": { "macho": {
    "command": "macho-explorer",
    "args": ["mcp"],
    "env": { "MACHO_EXPLORER_BINARY": "/path/to/a/binary" } } } }
```

## Library Usage

```js
import { describe, findCalls, lookupAddress, mapLiteral } from 'macho-explorer';

const { slices } = describe('/path/to/binary');
const fn = lookupAddress('/path/to/binary', 0x100085c30n);
const callers = findCalls('/path/to/binary', fn.start);
const tables = mapLiteral('/path/to/binary', 'LZ4');
```

### Exports

| Export | Returns |
|---|---|
| `describe(path)` | Every slice: architecture, extent, symbol counts, `__TEXT` bounds, UUID, header flags, entry point, rpaths, source version, abnormalities, and the full segments/sections/loadCommands lists |
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

### Conventions

- **A negative answer is a value, not an exception** — `{ matches: [] }`, `{ function: null }`. Genuine I/O failures still throw.
- **Addresses are `bigint`** in, `"0x…"` out.

## Scripting Examples

### Search a directory for a symbol

```sh
macho-explorer sym --all-imp CCCrypt --in ./artifacts --matched-only --json | jq -r \
  '.data.files[] | "\(.count)\t\(.path)"'
```

### Find all callers of a function

```sh
macho-explorer findcall --json 0x100085c30 /usr/local/go/bin/go | jq '.data.hits[].addr'
```

### Disassemble a range and extract branch edges

```sh
macho-explorer disasm --json 0x100085c30 64 /usr/local/go/bin/go \
  | jq -r '.data.instructions[] | select(.kind) | "\(.addr) \(.kind) \(.target)"'
```

### Check if a binary is encrypted

```sh
macho-explorer describe /path/to/App.app/Contents/MacOS/App | grep ENCRYPTED
```

### Compare two builds

```sh
macho-explorer diff v1.0/app v1.1/app
macho-explorer fingerprint v1.0/app v1.1/app
```

### Convert an address and read bytes from the file

```sh
macho-explorer a2o --json 0x100085c30 -b /usr/local/go/bin/go \
  | jq -r '.data.queries[0].absoluteOffset' \
  | xargs -I{} dd if=/usr/local/go/bin/go bs=1 skip={} count=6 2>/dev/null
```

## Troubleshooting

### "no binary found"

Pass a path explicitly or set `MACHO_EXPLORER_BINARY`:

```sh
macho-explorer describe /path/to/binary
MACHO_EXPLORER_BINARY=/path/to/binary macho-explorer describe
```

### "unknown flag"

Check the flag name. The tool suggests corrections for near-misses.

### "unknown-encoding"

The file is not a Mach-O, or uses an unsupported architecture (e.g., big-endian).

### "no-symbols"

The binary is stripped. Use `findcall` or `findliteral` instead — they read bytes rather than names.

### "encrypted"

The binary's `__TEXT` is encrypted (App Store build). `findcall`, `findliteral`, and `--strings` cannot read it. The symbol table is not encrypted, so `symlookup` still works.

### Large output

Use `--quiet` to suppress non-essential output, or `--json` and pipe to `jq` for structured queries.
