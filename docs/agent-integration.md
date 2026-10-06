# Driving it from an agent

Two doorways, and they are not redundant: an **MCP server** so an agent that
speaks the protocol finds these tools at all, and an **agent skill** so it knows
what to do with them. Either alone leaves a gap the other fills.

## The MCP server

```sh
claude mcp add macho -- node /absolute/path/to/src/mcp.mjs
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "macho": {
      "command": "node",
      "args": ["/absolute/path/to/src/mcp.mjs"],
      "env": { "MACHO_EXPLORER_BINARY": "/path/to/a/binary" }
    }
  }
}
```

Sixteen tools: `describe`, `overview`, `sym`, `symlookup`, `starts`, `findcall`,
`findliteral`, `mapliteral`, `a2o`, `o2a`, `dump`, `disasm`, `audit`,
`fingerprint`, `diff`, `assert`.

### Start with `overview`, not `describe`

`overview` is `describe`'s whole answer plus the symbol table and the strings on
request, in one call. An agent's first question is "what is this file", and
answering it with `describe` alone leaves two obvious follow-ups that each cost a
round trip — and, worse, each *choose a slice independently*. Four tools choosing
independently is how a caller ends up holding a symbol table from one architecture
and strings from another, with nothing in either output saying so.

```json
{ "name": "overview", "arguments": { "binary": "/path/to/binary", "symbols": true } }
```

The inventories are opt-in and bounded, and the bound is reported rather than
silently applied: on a 14 MB Go binary the structure is 9 KB of JSON and its 19,526
defined symbols turn that into 422 KB.

`overview` also returns **`notRead`** — the list of what this package does not
parse — in every answer. An absent field is evidence, not silence.

## The agent skill

`skill/macho-explorer/SKILL.md` is a portable Agent Skill: one markdown file that
teaches an agent the workflow, the three things that waste its time, and what the
reader will not do. It works with Claude Code, Codex, Cursor, VS Code, Copilot and
the Gemini CLI, and it needs no MCP server — the CLI is documented alongside.

Copy it to wherever your agent looks for skills:

```sh
cp -R skill/macho-explorer ~/.claude/skills/
# or: codex, .cursor/rules/, .github/copilot-instructions/, …
```

### Why the skill is tested, and what that buys

`test/skill.mjs` holds the skill's prose to the tree. It extracts every `--flag`
the skill mentions and asserts a tool accepts it, extracts every flag a tool
accepts and asserts the skill documents it, and asserts the address-as-hex claim
against the MCP schema rather than the prose.

That is not ceremony. The category leader in this space shipped
`blacktop/ipsw-skill` v2.0.0 with a changelog documenting **41 incorrect commands
and flags corrected from 1.0.0**, after checking every one against `ipsw --help`.
Hand-written skill prose drifts from reality almost immediately, and the maintainer
who shipped it is the one who had to fix it.

This suite has already caught two flags invented by the author of the very prose it
checks — a `--offsets` that does not exist and a `--no-audit` that never did. A
skill that cannot drift is the differentiator; having a skill is not.

## Five things that will otherwise waste your time

These are repeated in the server's own `instructions` block, because a model that
does not know them will confidently do the wrong thing.

**Addresses are hex strings.** `"0x100085c30"`, never a JSON number. A 64-bit
address does not survive a double, and an agent that sends `1091523120` has
silently lost the low bits before the file is even opened.

**An empty result is an answer, not a failure.** No matches returns an empty list
with `ok: true`. Do not retry it with variations. Distinguish it from a real
failure by the code: **1 means "ran, found nothing"**, 2 is a usage error, 3 means
the file could not be read.

**`findcall` sees direct calls only.** A call through a register, or through a PLT
stub, does not encode its target in the instruction. Every hit is a site *worth*
opening in a disassembler, not a proven call-graph edge, and **an empty result does
not mean nothing calls the target.**

**`disasm` is not a disassembler.** It reports instruction lengths and direct
branch edges as bytes — no mnemonics, no operands, no control-flow graph. It is a
*linear sweep*, so padding and data interleaved in a code section decode as
instructions too; read the `bytesCovered` / `bytesInRange` line before trusting a
whole-section sweep.

**A stripped binary has no defined symbols.** `sym` and `symlookup` return nothing
at all rather than guessing — which means a missing `.dSYM` makes those two useless,
while `findcall` and `findliteral` keep working, because they read bytes rather
than names.

## The workflow that actually works

Reverse-engineering a binary is a loop, and skipping the first step is how you end
up reading addresses that were never in the slice you thought you had.

1. **`overview`** — how many slices, which architecture, whether there is a symbol
   table at all, where `__TEXT` starts, the build's UUID.
2. **`sym`** — turn a name into an address.
3. **`symlookup`** — turn an address back into a function. The way to make sense of
   a crash-log address.
4. **`findcall`** — who calls it.
5. **`findliteral`** then **`mapliteral`** — where a format magic sits, then which
   code points at it.

To go the other way — address to file position to bytes — `a2o`, then `o2a`, then
`dump`. An address can reach a byte, be mapped with no byte (`__bss`, `__PAGEZERO`),
or be in no slice at all, and the tools report all three as values rather than
conflating them.

## The literal-to-pointer recipe

This is the workflow with **no equivalent in `ipsw`, Ghidra`, `otool`, Hopper or
`jtool2`**, and it is the one to reach for when the question is "which code in this
binary handles format X".

**Step 1 — find the magic.** `findliteral` searches the whole file by default, not
just `__TEXT`, which matters because a format's magic often lives in a `__cstring`
next to its name rather than in code. Escapes work, because the match is raw
latin1:

```json
{ "name": "findliteral", "arguments": { "binary": "/b", "literal": "\\x1f\\x8b" } }
```

**Step 2 — map it to addresses.** `mapliteral` turns each occurrence into the
virtual address it loads at.

**Step 3 — find what points at it.** The same call reports every pointer in the
binary referencing those addresses — the descriptor table, the vtable, the dispatch
array. **These are the addresses worth disassembling.** Everything before step 3
was in service of asking that question.

```json
{ "name": "mapliteral", "arguments": { "binary": "/b", "literal": "LZ4" } }
```

Then hand those addresses to `symlookup` to name them and `findcall` for their
callers.

Two answers to read correctly. **No pointers at all** means nothing dispatches on
this magic *by reference*, so it is matched inline — a real answer about the
program's shape, not a failure. **No literal at all** means the value is never
stored contiguously: it is built at runtime from parts, or obfuscated.

## `arch` accepts every slice name the CLI does

`x86_64`, `arm64`, `arm64e`, `arm64_32`, `ppc`, `ppc64`, `arm`, `i386`, `armv7`,
`armv7k` — and a trailing `e` is not significant, so `arch: "arm64"` selects an
arm64e slice.

That matters more than it sounds. Every current Apple-silicon system binary is
**arm64e**, not arm64, and an agent that asks for the wrong one is either refused
or silently handed the wrong slice. Pass `arch` on a universal binary and check
the note that comes back: it says which slice was actually read.

## When to hand the addresses over

When you need to know what the code *does* rather than where it is, use Ghidra
(free, no licence server) or Hopper. That is the intended division: this reader
produces the shortlist of addresses worth opening, and hands them over. `disasm`
narrows that shortlist to instruction boundaries and direct branch edges, which is
the last step before a real disassembler takes over.

No code signature, no Objective-C or Swift metadata, no DWARF, no dyld shared
cache, and not ELF or PE.