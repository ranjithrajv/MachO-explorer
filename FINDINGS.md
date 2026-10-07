# Findings

A verification that cannot fail is worse than a missing one, because it reports
success. This project has been wrong in that way more than once, and this file is
the record: every defect below was live while the suite was green, every one
produced a plausible answer rather than a crash, and every one now has a check
that would have caught it. The point is not the bugs — it is that each guard is
traceable to a real failure, so a reader can tell a test that establishes
something from a test that merely exists.

The shape of the whole project is the response to this list: one reader, facts
rather than guesses, and a negative answer that is a value instead of an
exception. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and
[CONTRIBUTING.md](CONTRIBUTING.md) for what a change has to survive.

## The reader

### 1. An imported symbol resolved as the function containing an address

Imports carry `n_value == 0`, so any low address "resolved" to an import at
`0x0` — a function name and an offset, both wrong. The symbol table had no
lower bound and the resolver asked for none. The fix requires an
`N_SECT` symbol with a nonzero value; `test/mutation-check.mjs` reintroduces
exactly this defect and fails if the suite stops noticing.

### 2. A universal binary reported zero call sites

The call scanner never parsed the fat header, so on a universal binary its
section walk failed silently and it scanned a default window that contained
nothing. It printed "0 call sites" and exited 1 — a plausible answer, not an
error. The guard is a generated fat fixture with slices at known offsets.

### 3. Sections read at their slice-relative offset

Correct on a thin binary, and correct on any universal binary whose first slice
sits near the file start — which is every binary the tool had ever been run
against, so it was invisible for the life of the project. Everywhere else it
read the right *number* of bytes from the wrong place. A generated fat binary
with slices at known offsets surfaced it. The reader now adds the slice base,
and the fixture keeps it honest.

### 4. A scan that could not terminate

The chunk loop advanced by `len - 5`, which stops advancing once the final chunk
is smaller than five bytes. The tool did not report a wrong answer; it did not
return. The mutation check reintroduces the exact loop.

### 5. The arm64 scanner that confidently found nothing

Only the x86 `rel32` encoding was known, and the mask compared a *signed* int32
against a constant above 2³¹, so the comparison never matched and arm64 returned
a confident zero. A check that asserted only "an encoding was reported" passed
against it. The positive control that catches it is finding 11.

### 6. An absent architecture was treated as fatal

`--arch=x86_64` against an arm64-only binary returned null and failed outright,
rather than reading the one slice it had. An architecture is a preference. The
guard is the arm64-only fixture.

### 7. A second copy of the fat-header reader

`mapliteral` carried its own copy, hardcoding `cputype === 0x01000007` and
throwing on any Apple-silicon-native build. It survived because it did not share
the reader — which is exactly the failure the one-reader rule exists to prevent.
It now goes through `macho.mjs` like every other tool.

### 8. `__bss` swallowed the start of the file

`toVaddr` tested sections before asking whether they occupy file bytes, and
`__bss` records offset `0` with a nonzero size, so file offset `0x1000` — the
first byte of `__text` — resolved into `__bss`. The reader now asks whether a
section is backed by the file, and reports zero-fill as its own answer rather
than as an offset that does not exist.

### 9. Every address above the last symbol resolved to it

A symbol table records where code *starts*, not where a slice ends, so without a
bounds check any address above the last symbol resolved to that symbol with an
offset of billions of bytes — a wrong answer shaped like a measurement.
`lookupAddress` now checks that the slice actually maps the address and returns
`{ function: null }` when it does not.

### 10. `--arch=arm64` matched none of the slices

A binary whose arm64 slice is arm64e failed a `===` comparison, so the tool
reported "matched none of the slices" and then showed all of them — worse than a
wrong pick because it looked like it had checked. One predicate, `archMatches`,
is now the rule every `--arch` path uses.

## The verification

### 11. A positive control that could not fail

The smoke test only checked that the call finder *reported* an encoding, which it
did even with the arm64 comparison inverted (finding 5), so a dead scanner
passed. The control now uses `findcall --list` to prove the matcher resolves
real targets and cross-checks the top one against the symbol reader, so two
independent parsers have to agree. When per-slice narration moved to stderr,
`execFileSync` silently dropped it and the control compared `[undefined]` while
asserting nothing; the suite now uses `spawnSync` and *asserts* the encoding it
verified is a known one.

### 12. An expectation that matched the check name

A pattern matched the string in the check's own PASS line, so a wholly broken
tool still "matched" and the run reported green. It now accepts only a `FAIL`
line.

### 13. An incomplete mutation

Removing only the `N_SECT` filter left the `value === 0n` guard still blocking
imported symbols, so the suite passed while establishing nothing about finding 1.
A mutation now restores the *actual* original defect rather than an
approximation of it — the approximation is what made it prove nothing.

### 14. A stale anchor, and a skip that exited 0

One mutation was still written against a five-argument call that had since grown
a sixth. It could no longer be applied; the run printed `SKIP … anchor not found`
and **exited 0**, so `test:all` stayed green while one of its mutations had
quietly stopped running. An inconclusive mutation now fails the run like a
survivor does, and the "none surviving" line only prints when every mutation
really ran and was caught.

## The boundary

### 15. `sym --regexx` answered a different question

An unrecognised flag was ignored, so the typo downgraded a regex search to a
substring search and exited 1 — "found nothing" — for a query that would have
matched. A one-character mistake produced a confident wrong answer. Every tool
now refuses a flag it does not take, and suggests the near miss.

### 16. `--min 9` read `9` as the binary

`min` was missing from the list of flags that take a separate value, so the
space form parsed `9` as the target while the `--min=9` form worked. The
asymmetry was the bug: a flag documented with `=` in one place silently
misparsed in the other, and the error named the wrong problem. The list is now
the one place a valued flag is declared.

### 17. `--version` was accepted and ignored

`COMMON_FLAGS` made every tool parse it, and nothing acted on it, so
`macho-explorer describe --version` silently analysed the default binary instead
of printing the version — a confident answer to a question nobody asked. It is
handled once, at the function every tool funnels through, and asserted for every
tool.

### 18. `notRead` reached exactly one door

`overview` carried the gap list and every other tool omitted it, which made the
strongest claim in the package true of exactly one command — and an absent field
is indistinguishable from a reader that read everything. It is now injected in
`output.mjs`, so no tool can forget it.

### 19. JSON to a pipe truncated at 64 KiB

`process.stdout.write` is asynchronous on a pipe, and every tool ends with
`process.exit`, which does not wait for a pending write. So `tool --json | cat`
produced exactly one pipe buffer and a malformed envelope, while
`tool --json > file` worked — and no fixture produced more than 64 KiB, so the
one path that mattered most for scale was the one path never exercised. Both
streams now go through a synchronous, complete write.

### 20. A catch that turned a programming error into an answer

A copy of the Mach-O check lost its module-level constants but kept its
`catch { return false }`, so it threw a `ReferenceError` on every call and
swallowed it. Every binary was reported as "not a Mach-O" and every tool exited
cleanly saying it could not find one. A catch that hides programming errors turns
a crash into a wrong answer, which is much harder to notice.

### 21. `.ipa` extraction found nothing in a real archive

It searched only the nested `Contents/MacOS` layout, which no iOS `.ipa`
contains — an iOS bundle is flat — and it required an explicit `.app/` directory
entry that many ZIP writers omit. Its own test could not catch either: the ZIP
builder there wrote every local-header offset as `0`, so it never exercised the
reader. Both are fixed, and the suite now builds a real archive layout.

### 22. The npm name that passed a dry run and was refused

`npm publish --dry-run` printed `+ MachO-Tools@0.1.0` and exited 0 on a name the
registry rejects, because a dry run never asks the registry whether a name is
acceptable. The command that looked like the check was not one. The name is
lowercase now, and a publish test asserts that the install line in the docs names
the same package the manifest does.

---

The through-line is the same at every layer: a check that cannot fail is worse
than none, and a green suite is not evidence until it has been shown to fail.
`test/mutation-check.mjs` reintroduces each reader and boundary defect above, one
at a time, and requires the suite to catch it.
