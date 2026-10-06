# The machine contract

Every tool in this package answers in one shape. A consumer learns it once, and
it is the same whether the answer arrived through a pipe or an agent session.

## One envelope, always

```json
{
  "schemaVersion": "1.0",
  "tool": "audit",
  "ok": true,
  "binary": "/path/to/binary",
  "errors": [],
  "notes": ["verdict is ok / warnings / failed"],
  "data": { }
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Version of the **envelope shape**, not of the package |
| `ok` | True when the tool ran, whether or not it found anything |
| `errors` | Machine-readable reason codes. Empty when `ok` is true |
| `messages` | Prose for a human, one per code |
| `notes` | Caveats that do not make the answer wrong |
| `data` | The answer. `null` when `ok` is false |

Two guarantees, because a consumer that has to work around them will not:

**stdout is JSON only.** Progress lines, per-slice narration and "none found"
prose all go to stderr under `--json`. This is the difference between
`tool --json | jq` working and it silently reading its own diagnostics as data.

**It is one object, always.** An envelope rather than a bare array, so a consumer
can read `.tool`, `.ok` and `.errors` on a failure without first guessing what a
success looks like.

### Pin `schemaVersion`

The envelope is the package's only stable surface, so once anything consumes it,
changing a field name or a meaning is a breaking change whether or not
`package.json` says so. A consumer that cannot detect that will keep parsing and
quietly believe the wrong thing.

The version travels **in every response** rather than in documentation beside it.
Compare it against the value you were written against and fail loudly on a change,
instead of discovering it from an empty field.

- **Major** on a removal, a rename, or a change of meaning.
- **Minor** when a field is added, since an added field is ignorable.

A new tool is *not* a change to the envelope. That is the point of having one
envelope.

## Reason codes

`errors` holds machine-readable codes so a caller can self-correct rather than
parse an English sentence:

| Code | Meaning |
|---|---|
| `bad-arguments` | The caller's fault, and fixable |
| `bad-address` | An address was not hex, or not in any slice |
| `bad-pattern` | Not a valid regular expression |
| `no-match` | Ran fine, the literal was not there |
| `no-call-sites` | Ran fine, nothing calls the target |
| `no-symbols` | Ran fine, nothing matched |
| `encrypted` | **Could not run.** The bytes are ciphertext |
| `unknown-encoding` | Readable, but not a Mach-O |
| `io` | The path could not be read |

`io` and `unknown-encoding` are deliberately distinct. One is a file that cannot
be read; the other is a file that reads fine and is not a Mach-O. Told "not a
Mach-O binary" about a path that does not exist, a caller goes looking for the
wrong file entirely.

`encrypted` is the one code that means **could not look** rather than **looked and
found nothing**. An App Store build's `__TEXT` is ciphertext, so a zero result from
`findcall` or `findliteral` is **not** evidence the target is absent. Reporting it
as a clean zero would be a confident wrong answer about bytes nobody read.

Over MCP the `no-*` codes are **not** put in `errors`. What a client branches on
there is `isError`, and a model told a literal is absent with `isError: true`
goes looking for a different binary instead of accepting the answer. Nothing-found
arrives as a note with `data.count === 0` as the precise signal.

## Addresses are hex strings, never numbers

```json
{ "addr": "0x100085c30" }
```

A 64-bit virtual address does not survive a JavaScript `Number` — everything above
2^53 loses its low bits, and the resulting address points at real, wrong code
rather than failing. A silent precision loss in the output would be
indistinguishable from a correct answer, so it is fixed at the boundary rather than
left to whoever writes the consumer.

Over MCP the schema **enforces** the `0x` form with a pattern, which is stronger
than anything the CLI can do. In the shell, quote it.

**File offsets stay numeric.** They are arithmetic, bounded by file size, and far
below 2^53 in practice. `a2o` reports both: `offset` is slice-relative,
`absoluteOffset` is the position in the file.

## Exit codes

The same four codes, on every tool:

| Code | Meaning |
|---|---|
| 0 | Ran, found something |
| 1 | **Ran, found nothing.** Deliberately distinct from an error |
| 2 | Usage error |
| 3 | Could not do the job |

The status is the same with and without `--json`: the flag changes the **format**
of the answer, not the answer. A tool whose text mode and JSON mode disagree about
whether something was found is worse than one with no contract at all. The suite
asserts that parity across tools rather than listing expected values per tool, so a
tool added later fails the same check.

## JSON Schema, per tool

Sixteen schemas under `schema/`, one per tool, each composed from
`envelope.schema.json` with `data` constrained to what that tool actually returns.

```sh
macho-explorer audit --json app | ajv validate -s schema/audit.schema.json
```

Two deliberate properties:

**The envelope is closed.** `additionalProperties: false`, so a typo'd field is
rejected. `errorss` does not validate — and a consumer whose typo silently passed
would read "no errors" from a document that said two.

**`data` is open.** An unrecognised key is ignorable, which is what lets a bug fix
add a field without a major version bump. A closed `data` would force every
consumer to pin a version before a fix could land.

The schemas are **generated** from the shapes the tools emit:

```sh
npm run schema          # regenerate
npm run schema:check    # fail if a checked-in schema has drifted
```

`schema:check` is the same drift discipline the fixture corpus and the browser
bundle already had. A hand-maintained schema drifts from the code the moment a
field is added, and a schema that lies is worse than no schema: it rejects valid
output, so the consumer works around it, and the workaround becomes a second
description of the shape.

## SARIF

```sh
macho-explorer audit --sarif app > audit.sarif
```

SARIF 2.1.0, for GitHub Code Scanning and any other consumer. See
[gating a build](ci-gate.html) for the properties that matter — stable rule ids,
no findings for an unreadable file, and no per-consumer compat flags.

## What this contract deliberately does not promise

- **No streaming.** `disasm --json` materialises its answer. For a whole-section
  sweep on a large binary, cap it with `--count` or `--bytes`.
- **No partial envelopes.** A tool either writes a complete envelope or exits. The
  failure that motivates this is invisible: a redirected `> file` always worked
  because a regular file is synchronous, and only `| cat` lost the tail — and no
  fixture produced more than 64 KiB of JSON, so the path that mattered most for
  scale was the one never exercised.
- **No stability guarantee on `data` field names across a major version.** Bump
  `schemaVersion` when one changes meaning; an added field needs only a minor.