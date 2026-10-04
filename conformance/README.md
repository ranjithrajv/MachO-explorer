# The Mach-O conformance corpus

A set of Mach-O files with **known answers**, and a runner that holds any parser
to them. It is designed to be useful to parsers that will never import a line of
this package: `debug/macho`, MachOKit, LIEF, `ipsw`, `machofile`, or your own.

This is the one thing here that is not a reader. It is the artefact another
project borrows.

## Why it exists

Every Mach-O parser is tested against binaries its author had. That is not the
same as being correct, and the gap shows up as bugs reachable only on *someone
else's* file — a fixed slice offset that works on one universal binary, an
assumption that an architecture is present, a 32-bit path that has never run.
This project's own history has four such bugs in the [README](../README.md).

The corpus is different in kind from "some test files":

- **Built, not collected.** `test/fixtures.mjs` writes each binary from scratch
  and asserts its properties *before* writing it, so the expected answers come
  from the bytes the generator chose, not from a parser's output.
- **Minimal on purpose.** Each fixture isolates one thing, so a failure points at
  one thing.
- **Byte-exact and checked in.** `node test/fixtures.mjs --check` re-derives every
  byte, so a stale or hand-edited fixture fails the build rather than weakening
  the suite.

## Run it against a parser

A parser is wrapped in an **adapter**: a command that takes one path and writes
one JSON record to stdout. `conformance/record.mjs` defines that record and
`conformance/adapter.mjs` is a reference implementation over this reader.

```sh
# The reference adapter (this reader):
node conformance/run.mjs --command "node conformance/adapter.mjs"

# Your parser, as a command that prints the record for one path:
node conformance/run.mjs --command "my-macho-conformance"
```

Exit status is `0` when every fixture conforms, `1` otherwise, and a failure
names the first differing field rather than dumping two objects.

## The record

Only the facts a parser can be held to without adopting our shape:

```jsonc
{
  "size": 33567,
  "fat": true,
  "slices": [
    {
      "arch": "x86_64",
      "bits": 64,
      "readable": true,
      "filetype": "MH_EXECUTE",      // MH_* name, or null
      "uuid": null,                   // lowercase hex, or null
      "text": { "addr": "0x100000120", "size": 320 },   // or null
      "symbols": { "total": 5, "defined": 3 },
      "sections": [
        { "segname": "__TEXT", "sectname": "__text", "addr": "0x100000120", "size": 320 }
      ],
      "loadCommands": ["LC_SEGMENT_64", "LC_SYMTAB"]
    }
  ]
}
```

Normalisation rules, so two parsers' answers are comparable:

- **Addresses are lowercase `0x` hex strings**, never JSON numbers — a 64-bit
  vaddr does not survive a `Number`.
- **Section and load-command names are verbatim** from the file's own strings and
  `<mach-o/loader.h>`.
- **Slices are in file order.** Fields a parser does not produce should be
  omitted; the runner compares the keys present.

## Regenerating the expected answers

`conformance/cases.json` is committed, not computed at run time — an oracle that
recomputes its expectations from the system under test verifies nothing.

```sh
node conformance/run.mjs --write-cases   # regenerate from the reader
node conformance/run.mjs --check         # CI: cases.json matches the reader
```

`test/conformance.mjs` asserts both, plus a **positive control**: a deliberately
wrong adapter must fail the suite, so a runner that compares nothing cannot pass.

## What a conformance failure means

It means your parser and this corpus disagree about a fact. It does **not**
automatically mean your parser is wrong — it means one of the two is, and the
fixture's bytes are the tiebreaker. `test/fixtures.mjs` is the generator; read it
to see what each file was built to contain.
