# Gating a build

`audit` is the one tool here designed to be a CI gate rather than a report. Its
**exit status is the product**, and everything else on this page exists to make
that status safe to act on.

## The exit-status taxonomy

Every tool in this package uses four exit codes, and the distinction between two
of them is the reason the taxonomy exists:

| Code | Meaning |
|---|---|
| **0** | Ran, found something |
| **1** | **Ran, found nothing.** A negative answer, not an error |
| **2** | Usage error — bad or missing arguments |
| **3** | Could not do the job — unreadable file, unparseable Mach-O |

An audit that found something wrong has **done its job**, so it exits 1. A caller
that treats that as a crash will switch the gate off within a week.

The distinction that matters more is 3. An unreadable file is **not a passing
audit**:

```sh
$ audit /nope; echo "exit $?"
/nope: cannot be read (no such file, not a regular file, or not permitted)
exit 3
```

A mistyped path in a workflow must never read as a clean bill of health. That is
the whole reason 3 is separate from both 0 and 1.

## Severity, and why `--strict` is off by default

Findings carry a severity, on one question: **can the reader's answers still be
trusted?**

| Severity | Meaning |
|---|---|
| `error` | The file disagrees with itself. A size or extent points at bytes that are not there, so anything computed from it may be wrong |
| `warning` | The file parsed and the answers are probably right; something is unfamiliar or explicitly heuristic |

By default only errors fail. `--strict` fails on warnings too.

That default is deliberate. A binary built by an Xcode newer than this reader sets
a header flag bit that `loader.h` has no name for, and failing every build over
that trains people to switch the gate off. **A gate that only fires on genuine
damage is a gate people leave on.** Turn `--strict` on for a release gate where you
control the toolchain.

## Branch on the booleans, not the label

`verdict` is `ok` / `warnings` / `failed`, and it is a **label for a person**.
`data.clean` and `data.strictClean` are the gate:

```sh
$ audit --json ./out | jq '{verdict: .data.verdict, clean: .data.clean, strict: .data.strictClean}'
{ "verdict": "warnings", "clean": true, "strict": false }
```

That document **passes**. `verdict: "warnings"` with `clean: true` is a passing
audit, and mapping the label onto the exit status fails a build over a binary the
reader says is fine. The first version of this tool did exactly that: the API
reported `verdict: "warnings", clean: true` while the process exited 1 — the same
file described as passing and failing in the same breath.

## SARIF

```sh
macho-explorer audit --sarif ./out > audit.sarif
```

SARIF 2.1.0 on stdout, a one-line summary on stderr. Two properties are
deliberate.

**Findings are rules named by the reader's own `kind`**, so a second run matches
the first run's findings rather than filing a new alert on every build. The rule
id is derived mechanically — `macho-explorer/slice-overlap` — rather than written
by hand, because an id a human wrote drifts when someone thinks of a better name,
and that drift silently restarts every alert in the history.

**An unreadable file yields a valid document with *no* findings.** A mistyped path
in a workflow is a bug in the workflow, not damage to the binary, and reporting it
as a finding puts an annotation on the commit for something the commit did not
do.

`--sarif` and `--json` are two formats for one answer and **cannot be combined**.
That is a usage error rather than a precedence rule, because silently preferring
one produces a `.sarif` file containing JSON that fails to parse much later with
an error naming neither flag.

### Why no compat flags

`capa`, the closest precedent, ships `-g/--ghidra-compat` — commented *"Ghidra
can't handle this structure as of 11.0.x"* — and `-r/--radare-compat`. Every SARIF
consumer apparently needs its output bent into shape.

This emitter does not, because it emits the minimum a consumer needs: rule id,
level, one artifact location, and a message naming the numbers that produced the
finding. No `invocations`, no `artifacts` tree, no address model to disagree about.

## The composite action

So none of the above needs writing:

```yaml
- uses: ranjithrajv/MachO-explorer@main
  with:
    binary: build/Some.app/Contents/MacOS/Some
    baseline: known-good/Some        # enables the fingerprint and diff jobs
    sarif: true                      # upload to GitHub Code Scanning
  permissions:
    contents: read
    pages: write
    id-token: write
```

It has **no install step**. It checks out the repository, sets up Node, and runs
the reader from the checked-out source.

That is the whole point. A CI gate that needs an install is a gate that gets
skipped, because the install is the part that fails — on a pinned-dependency
update, a runner image change, a cache miss, a network blip — and every one of
those failures is indistinguishable from "the binary is broken" unless somebody
reads the log. Running from the tree also means the gate tests *this commit*
rather than whatever a version tag resolved to today.

Two implementation details that are load-bearing rather than fussy:

- **Every path arrives through `env:`, never through `${{ }}` inside a `run:`
  block.** GitHub substitutes expressions before the shell sees the string, so a
  binary path containing a quote, a backtick or `$(...)` becomes code execution.
  An environment value is passed as data.
- **JSON fields are read with `node -p`, not `jq`.** Node is already a hard
  requirement; `jq` is present on GitHub's images and absent from many self-hosted
  runners. A gate that works on the runner you were given is worth more than one
  that works on the runner in the documentation.

## Comparing against a baseline

`fingerprint` answers a question `cmp` gets wrong in both directions.

```sh
$ fingerprint built.app known-good.app; echo "exit $?"
built.app — 66102b7cfcc2  full
known-good.app — 66102b7cfcc2  full
  arm64  match  (match)

  same program, rebuilt (UUIDs differ)
exit 0
```

Two builds of one source differ in every address (PIE and ASLR move them), in the
current-version fields of the dylibs they load, and in any timestamp — so a byte
comparison calls them different. Two *different* programs built from one template
differ in almost nothing structural — so a loose structural comparison calls them
the same.

Three answers are kept apart, because they are three questions:

| Field | Question |
|---|---|
| `sameBuild` | Same **build**? Compares UUIDs. Exact, and useless the moment anything relinks |
| `sameProgram` | Same **program**? Compares fingerprints. Survives a rebuild |
| `rebuilt` | Did a rebuild happen? True only when two *differing* UUIDs prove it |

`fingerprint --sarif a b` turns "these are not the same program" into a finding on
the commit rather than a line in a log.

## Why `diff` is not a gate

`diff` reports three lists and only the first decides its verdict:

| List | What it holds | Counted? |
|---|---|---|
| `differences` | Structure and literal content | **Yes** |
| `buildMetadata` | UUIDs, signing | Reported, never counted |
| `sizeChanges` | Section sizes | Reported, counted separately |

A UUID difference is a fact about a *build*. A changed literal string is a change
to the *program*, because strings do not move on a rebuild.

Turning any of them into a failure is a policy decision, and a policy belongs
somewhere it can be written down and reviewed:

```sh
macho-explorer assert ./out \
  --has-symbol _main \
  --no-string 'assertion failed' \
  --has-string 'https://api.example.com'
```

A failed assertion is an **answer**, not an error: `errors` stays empty and
`data.passed` is the verdict. Only an unreadable file is an error.

## A complete workflow

```yaml
name: binary gate
on: [pull_request]

permissions:
  contents: read
  security-events: write   # for Code Scanning; not needed for the gate itself

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: ranjithrajv/MachO-explorer@main
        with:
          binary: build/Some.app/Contents/MacOS/Some
          baseline: ${{ github.event.repository.pull_request.base.sha }}

      - uses: actions/checkout@v7
        if: always()
        with:
          repository: ranjithrajv/MachO-explorer
          ref: main
          path: known-good

      # A second invocation against the baseline, because the action's `baseline`
      # input wants a path and this is how you get one for a pull request.
      - uses: ranjithrajv/MachO-explorer@main
        if: always()
        with:
          binary: build/Some.app/Contents/MacOS/Some
          sarif: false
```

Reading a Mach-O on a Linux runner is not a workaround. The reader claims
platform-independence and the three-OS test matrix is what keeps that claim
honest; Windows is in that matrix specifically because it is the only one of the
three with no `/usr/bin` to fall back on.