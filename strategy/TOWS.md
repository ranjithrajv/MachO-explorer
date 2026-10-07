# TOWS analysis — `MachO-explorer`

A strategic view of the project, re-derived from what the tree and its suites
actually do rather than from the previous version of this file. Every claim below
is checkable against the repository, and every number was produced by running the
suites on **2026-10-07** against **`8313665`** ("Fix the Pages deploy: docs
--check ran before the build it was checking"), with `src/api.mjs` and
`src/audit.mjs` carrying uncommitted edits. The tree moved **three times** during
the derivation — `7ae74b9` plus two untracked files became `2a24e44`, then
`3d357cc`, then `8313665` — and every count below was re-run after each move
rather than carried. The header names the commit because, as the rest of this
document argues, a claim about a tree is only worth the tree it named — and this
one is a moving target: within the hour the working tree had changed again under
a concurrent pass (`src/ipa.mjs`, `demo/macho.browser.mjs` and seven others), so
re-run the suites before quoting any number here.

**One suite is red, and a second is red and wired into nothing.** `test/ipa.mjs`
is 8 passed, 1 failing, has no `npm` script, is absent from `test:all`, and runs
in no workflow — so a failing suite that looks like coverage is in the tree and
nobody's gate sees it. `test/browser.mjs` is 44 passed, 1 FAILED in the working
tree only, because the two uncommitted files re-staled a bundle the previous
commit had just regenerated; the drift check fired repeatedly on this pass, which
is it working. Both are findings below, not noise.

TOWS is SWOT with the action step: the four factor lists are the inputs, and the
matrix is the output — pairing each internal factor with each external one to
generate a strategy, rather than leaving four disconnected lists that tell you
nothing about what to do on Monday.

## What moved since the last version

The previous version was written on 2026-10-03 against `a87991e`. Forty-five
commits later, it is wrong in nine places, and the practical agenda has turned
over almost completely: the last version's headline was a one-word fix to
`package.json`, and that fix has since been made, unmade and replaced by a
different one. Each correction is worth naming, because the stale version was
more confident than it was correct.

| Stale claim on 2026-10-03 | Reality at `8313665` |
|---|---|
| **`S1` "Fix the name — LANDED"**, package `macho-tools`, every other asset "waiting for a channel" | **The name moved again.** `package.json` is `macho-explorer`, and commit `57cffd7` dropped the `macho-` prefix from every command. `macho-explorer` now returns E404 because it is **unpublished**, not because it is invalid. The channel was built and not opened. |
| "310 checks in `smoke.mjs`, 183 in `mcp.mjs`, 36 in `skill.mjs` — **529 checks**" | **765 smoke + 267 MCP + 69 skill = 1,101**, and `types`, `publish`, `schemas`, `sarif`, `action`, `docs`, `pages`, `conformance`, `browser` and `ipa` are suites that did not exist or were not counted. |
| "**11 mutations, 11 caught**" | **23 mutations, 23 caught** — 15 by the fixture generator's self-check, 8 by `smoke.mjs`. |
| "**10 fixtures, 42,060 bytes**" | **23 fixtures, 152,381 bytes**, including `arm64e`, `ios`, `damaged`, `decoy`, `meta`, `newer`, `dylibs`, `bulk`, `rebuilt`/`rebuilt2` and a `.tbd` corpus. |
| "**Nine man pages, nine `bin` entries**" | **18 man pages and 17 `bin` entries.** `tbd` has a man page and no `bin` entry; it is reachable only as `macho-explorer tbd`. |
| "Four CI jobs, and only `test` is an OS matrix" | Still true — plus `pages.yml`, `release.yml` and `release-binaries.yml`, which the previous version did not know existed. |
| "**No tags, no releases, version `0.1.0`**" | Tag **`v0.1.0` exists** (`354c895`, 2026-10-04), and **18 commits** have landed since it. `npm view macho-explorer` is still E404. `release.yml` was added *after* the tag was cut, so the tag triggered nothing. |
| "Indirect calls are invisible" as the largest gap against Ghidra, and "**No disassembly**" | `disasm` and `src/instruction.mjs` exist: instruction lengths and resolved direct branch edges for `arm64`, `arm64e`, `x86_64` — **bytes, not mnemonics**, which is why the no-disassembly refusal still holds. |
| "Nine flat binaries"; "`nm` on a 476 MB universal binary takes minutes" | **17 `bin` entries**, plus Single Executable Applications via `scripts/build-sea.mjs` and a `release-binaries.yml` that cuts them. The `nm` speed claim is **withdrawn** — `strategy/LANDSCAPE-ANALYSIS.md` records that `nm` is unusable on the authoring host (Xcode licence prompt, exit 0), so it was never measured. |

### Corrections, second pass

Recorded rather than quietly deleted, because a strategic document that is only
ever right about the present is indistinguishable from one that was never
checked. These are defects the re-derivation found in the tree, not in the old
document:

1. **`README.md` says "Fifteen tools" and its own table lists sixteen.** The
   table rows are `describe`, `sym`, `symlookup`, `starts`, `findcall`,
   `findliteral`, `mapliteral`, `a2o`, `o2a`, `dump`, `disasm`, `audit`,
   `fingerprint`, `diff`, `assert`, `tbd` — sixteen, with `mcp` a seventeenth
   `bin` on top. The prose was right when it was written and drifted as tools
   landed, which is the exact failure mode `test/skill.mjs` was built to prevent
   for the skill and nothing prevents in the README.
2. **`macho-explorer --help` lists fifteen subcommands; `SUBCOMMANDS` accepts
   eighteen.** `dump`, `starts` and `assert` are dispatched and undiscoverable
   from the help text. Same shape as (1), one file over.
3. **`test/ipa.mjs` is red and wired into nothing.** It is 8 passed, 1 failing
   (`resolveIpa returns a path for a valid IPA`, with `exeBytes: null`), it has
   no `test:ipa` script, it is absent from `test:all`, and no workflow runs it.
   A failing suite that nothing runs is worse than a missing one: it reads as
   coverage, and the feature it tests — "reads the Mach-O inside an `.ipa`" —
   is a claim the tree does not currently support. Its own fixture is a ZIP the
   test builds in `os.tmpdir()`.
4. **The browser bundle is stale in the working tree, and the drift check has
   fired three times across this pass.** `test/browser.mjs` reports
   `demo/macho.browser.mjs is stale — run node demo/link.mjs`, 44 passed, 1
   FAILED. The commit that last fixed this, `3d357cc`, is one commit old; the
   two uncommitted files re-staled it. This is the *good* direction — a check
   catching the artefact it was built to catch — and it is also a demonstration
   that the regenerate-then-edit loop is easy to leave half-done.
5. **`release.yml`'s gate is narrower than `test:all`.** The publish path runs
   eight suites (fixtures, smoke, disasm, browser, conformance, mcp, skill,
   publish) and not `types`, `schemas`, `sarif`, `action`, `tbd`, `pages` or
   `docs`. Mutation is excluded on purpose. The comment says "the gate, in the
   order a maintainer would run it" — but a package can be published with a
   stale `.d.ts` or a broken schema, both of which `test:all` would have caught.
6. **A workflow comment still explains the publish check with the wrong package
   name.** `test.yml`'s comment on `publish.mjs` says **`+ MachO-Tools@0.1.0`**,
   and the package has not been called that for two renames. A comment is the one
   piece of documentation nobody re-reads, which is precisely why the previous
   version of this document recorded a stale commit message and why it has
   drifted again here.

Items 1, 2 and 6 are prose that a reader can falsify in ten seconds. Item 3 is a
red suite with no gate behind it. Items 4 and 5 are the gate itself being thinner
than its own description. All six were found by re-deriving rather than
re-reading, which is the argument for doing this every time the tree moves.

---

## Inputs

### Strengths — internal, helpful

| | Evidence |
|---|---|
| **Zero dependencies, zero build step** | Node builtins only; `node_modules/` absent, `.gitignore` treats its appearance as a bug. All suites run on a clean clone with no install. |
| **No product knowledge, and it is a test rather than a review habit** | Five `boundary:` checks scan `src/`, `test/` and the published tarball, with a positive control and a file set derived from `package.json`'s own `files` rather than a restated list. The list has grown with the package and still passes. |
| **One reader, and it is small enough to read** | `src/macho.mjs` is **2,241 lines / 97 KB** and still owns fat headers, load commands, `LC_SYMTAB`, sections, `LC_UUID`, function starts, platform and build version, and the 32/64-bit split. Nothing else in the tree duplicates it. |
| **Two corpora with opposite assertion policies** | 23 generated fixtures (152,381 bytes, exact counts and addresses) plus the system binaries present on the machine, asserted against *invariants* only. This is what makes a green run mean something on a bare CI runner. |
| **Mutation testing, and it bites harder** | **23 mutations, 23 caught**, 15 of them by the fixture generator's own self-check; an inconclusive mutation fails the run. Every one reintroduces a real historical bug. |
| **One envelope, four doors, and now a schema per tool** | `{tool, ok, binary, errors, messages?, notes?, data}`, identical across CLI, library, MCP and the browser bundle — with **18 versioned JSON Schemas**, generated and `schema:check`-verified, and a suite that asserts the schemas *reject* wrong documents. No Mach-O tool and no general RE tool in the competitive set publishes one. |
| **A build gate as a first-class output** | `audit` exits 0/1/2/3 with 1 meaning *found something wrong* rather than *errored*, emits **SARIF 2.1.0** with no per-consumer compat flags, and ships as a composite GitHub Action whose shell is extracted and executed by `test/action.mjs`. The category leader has no `action.yml`. |
| **Agent surface that cannot drift** | 16 MCP tools over a real stdio pipe, 267 protocol checks that parse *every* stdout line, and `test/skill.mjs` (69 checks) holding the skill prose to the flags the tools actually accept. `ipsw-skill` v2.0.0 shipped **41 corrections to its own commands** in one release; this is the mechanism that would have caught them. |
| **Capability beyond the reader: `.tbd` stubs** | Since macOS 11 the system dylibs are inside the dyld shared cache and are not files. `tbd` reads Apple's **text** stubs — 39 documents per `libSystem.tbd`, with each symbol attributed to the library that exports it, aliases resolved, and a partial answer withheld by exit 3 rather than guessed. Verified against 5,304 files / 6,387 libraries / 4,743,784 symbols. |
| **The three answers about two binaries** | `fingerprint` (relink-stable program identity), `diff` (structural + literal, including added/removed strings by content) and `audit` split what a byte comparison gets wrong in both directions. No competitor has a working pair of these. |
| **A client-side demo and no-upload guarantee** | The browser bundle is generated from `src/` by `demo/link.mjs`, `test/browser.mjs` asserts it is not stale and contains no `node:` builtin, and the page reads a binary the user selects without sending it anywhere. |
| **Generated-or-verified artefacts, zero hand-maintained claims** | `fixtures --check`, `schema:check`, `demo/link.mjs --check` and `test/skill.mjs`: four mechanisms that turn "a document says X" into "the tree is X". |
| **Honest about itself** | A table of its own historical bugs, comparison rows with honest `no`, a "What it will not do" section *with the test for joining it*, a `NOT_READ` list carried as data, and a Limits section that states the gaps. |

### Weaknesses — internal, harmful

| | Evidence |
|---|---|
| **Publishing is still not done, and it is the only thing that gates the rest** | `npm view macho-explorer` is E404. The name is valid, `test/publish.mjs` (16 checks) asserts the manifest and docs agree, and `.github/workflows/release.yml` is now the **only** publish path — it re-runs the gate and publishes with provenance on a `v*` tag. But the only tag, `v0.1.0`, was cut the day *before* that workflow existed, and **18 commits** have landed since. Re-cutting is one command; nothing in the tree does it, and no check fails while it is undone. |
| **The provenance pointer is still unreachable** | `README.md`:820 sends the reader to "the sibling project's `NOTICE.md` — reach it from the repository root". There is no `NOTICE.md` here. Unchanged since the previous two versions of this document. The one paragraph whose job is to survive a sceptical reader still dead-ends at the one direction that reader will follow. |
| **Three checked-in prose claims are falsifiable today** | `README.md` says "Fifteen tools" over a table of sixteen; `macho-explorer --help` lists fifteen subcommands where `SUBCOMMANDS` accepts eighteen; and `test.yml`'s `publish.mjs` comment still names the package `MachO-Tools`. Each takes ten seconds to disprove. |
| **The browser bundle goes stale every time `src/` moves** | `test/browser.mjs`: 44 passed, 1 FAILED in the working tree. The bundle must be regenerated after any `src/` change, and the regenerate-then-edit loop left it stale on this pass — twice, including one commit after the commit that fixed it. The check works; the workflow around it is easy to leave half-done. |
| **`test/ipa.mjs` is red and wired into nothing** | 8 passed, 1 failing. No `test:ipa` script, absent from `test:all`, run by no workflow. A failing suite nobody runs reads as coverage and is worse than a missing one. The `.ipa` claim in the README is unsupported while it stays this way. |
| **`release.yml`'s publish gate is narrower than `test:all`** | Eight suites run before `npm publish`; `types`, `schemas`, `sarif`, `action`, `tbd`, `pages` and `docs` do not. The comment says "the gate, in the order a maintainer would run it", but a package can ship with a stale `d.ts` or a broken schema under it. |
| **An absent corpus member is still silent** | `discover()` drops a missing system binary with a bare `continue`. Skipped *checks* are reported loudly and the MCP suite prints "A skip means the input was unavailable, not that the check passed"; the corpus-level half of the same honesty is still missing. Open across three versions of this document. |
| **`tbd` is a tool with no `bin` entry** | It has a man page, a suite and a dispatcher entry, and no standalone command. Either it is a tool or it is a subcommand; the tree says both. |
| **No release, no stars, no docs deployment** | Tag `v0.1.0` is 18 commits behind; `release-binaries.yml` has never produced artefacts on a tag that postdates it; the Pages workflow still publishes the audit report while `docs/` holds a user manual, a CI-gate guide, a machine contract and a text-stub reference with no deployed home. |
| **Indirect calls are invisible** | Register calls, jumps through a PLT stub, and any indirect call do not encode their target. Largest permanent gap against Ghidra/IDA, and a decision rather than a backlog item. |
| **The x86_64 scan is typed by section, not by instruction** | It can match a byte inside a multi-byte instruction. The arm64 path steps 4 bytes at a time and sees only aligned `BL`s. Fixing either means becoming a disassembler. |
| **Bundle ergonomics are macOS-shaped** | `bundle.mjs` assumes `.app` / `Contents/MacOS`. Fine — that is the target — but the cross-platform story is thinner than the three-OS matrix suggests. |
| **One maintainer, no institutional home** | Unchanged, and the most likely way the project ends. |

### Opportunities — external, helpful

| | |
|---|---|
| **Three empty slots, verified by code search rather than inferred** | SARIF: zero hits in `ipsw`/`radare2`/`rizin`; `capa` needs two extra dependencies and ships per-consumer compat flags including `-g/--ghidra-compat`. GitHub Action: `blacktop/ipsw` has no `action.yml` (404). JSON Schema: zero in the space. This project has all three, natively. |
| **The modern-macOS question nothing else can answer** | `/usr/lib/libSystem.B.dylib` is not on disk since macOS 11, so "what does libSystem export" is unanswerable by anything that reads binaries. `ipsw dyld` reads the shared cache, which is a large surface; `.tbd` is text, and the reader already does it. |
| **An agent-integration surface no Mach-O tool has** | `ipsw` has an agent *skill* and **no MCP server** (0 results for `modelcontextprotocol`, no MCP SDK in `go.mod`). This has a tested MCP server, a tested skill, and a schema for every tool's output, so an agent can be handed a contract rather than a description. |
| **A deterministic corpus is independently useful** | 23 fixtures with known answers, exported as `macho-explorer/fixtures`, plus a `conformance` adapter and cases — the artefact a *different* project's parser tests borrow. |
| **Stable format, thin tooling** | Mach-O has barely changed in 30 years. `otool`/`nm` ship in the box, need `lipo` first, emit no JSON and answer one question per invocation. |
| **Linux/Windows against Mac binaries** | `nm` and `otool` do not run off macOS at all. Server-side triage and CI are unserved by the in-box tools, and a SEA binary plus a schema makes that reachable with no runtime. |
| **A verifiable green is a marketing asset** | 1,101 checks and 23 mutations, reproducible offline in about five seconds by a stranger, with four generated-or-verified artefacts. That is rarer than it sounds and it is already built. |
| **The defect history is publishable on its own** | 23 mutation-locked bugs — including a 32-bit nlist stride that returned plausible names — is a write-up regardless of which toolkit reads them. |
| **The competitive set moved *toward* this lane, which validates it** | Binary Ninja 6.0 put AArch64 and an MCP server in its free tier; two independent `ghidra-cli` projects converged on "CLI + structured JSON beats MCP for agents". Both are the thesis being confirmed by better-funded actors. |

### Threats — external, harmful

| | |
|---|---|
| **Provenance and IP optics** | Written while reversing a commercial product. The code is clean of it and that is enforced; the lineage is knowable. **MPL-2.0 does not license the publisher's IP.** The only threat that can end the project — and the one document that manages it is still unreachable. |
| **Zero adoption from an unpublished package** | The pitch is "install it and read `man`". Until `npm install -g macho-explorer` works, the SARIF emitter, the Action, the 18 schemas, the demo and the docs are reachable by one person. Unchanged in substance across three versions of this document, and now blocked only by the act of cutting a tag. |
| **The moat is compositional, not technical** | `ipsw` could add SARIF, an `action.yml` and a schema in a quarter if anyone decided to. Nothing structural stops them. The window is 12–18 months and it closes when the tool is published and noticed. |
| **Better-funded incumbents moving into the lane** | Ghidra is free with no licence server and has the deepest SARIF implementation in RE; Binary Ninja 6.0 added an official MCP server and put AArch64 in the free tier; `morluto/rea` reached **8,285 stars in six months**; `mrexodia/ida-pro-mcp` has **12,492**. |
| **Abandonment** | One maintainer, no institutional home, no release. The most likely way this ends is by not being continued. |
| **Discoverability** | 0 stars, no releases, no docs deployment, no Marketplace presence. The three empty slots are empty partly because nobody is looking. |
| **Conflation with the sibling workspace** | The "no product knowledge" guarantee is true of this package in isolation and easy to overstate from the outside. |
| **Swift-fleet risk in the agent layer** | The skill mechanism is verified against *this* tree; it cannot verify a third-party harness's interpretation of it. `selridge` on HN makes the sharpest available critique — shipping a skill is not shipping a standard — and this project has no answer to that beyond "our prose cannot drift from our tools". |

---

## The TOWS matrix

|  | **Opportunities** | **Threats** |
|---|---|---|
| **Strengths** | **SO — build** | **ST — defend** |
| One reader, 1,101 checks, 23 mutations, an envelope per door, 18 schemas, SARIF + Action, a client-side demo, a `.tbd` reader | **S1. Publish.** The one move that converts every strength into reach. The tarball, the schemas, the Action, the man pages, the demo and the fixture corpus already ship in `files`. `release.yml` is the only publish path, it re-runs the gate, and it is waiting for a tag that postdates it. **This is the whole external quadrant.** | **S5. Fix the provenance pointer, in this repository, before anything ships.** The disclosure must live where a standalone clone can reach it. Everything else in §Provenance is right and enforced by five `boundary:` checks; only the destination is broken. It is the single strongest answer to the existential threat. |
| A tested skill and a tested MCP surface built for agents | **S2. Lead the pitch with the empty slots, not the feature list.** "SARIF no Mach-O tool emits · a GitHub Action the category leader lacks · a versioned schema per tool when the space has none" is a category claim; "reads Mach-O" is a feature claim against a superset. | **S6. Keep the five `boundary:` checks and the `NOT_READ` list as the provenance proof.** A claim that nothing proprietary ships is worth nothing unverified; it is currently verified over the shipped file set with a positive control. Do not trade it for coverage. |
| Deterministic corpus + conformance oracle | **S3. Ship `.tbd` as the answer to the macOS-11 question.** It is text, it is bounded, it makes the tool *more* itself, and nothing in the binary-reading world can answer it. | **S7. Freeze rather than rot.** With `fixtures --check`, `schema:check`, `demo/link.mjs --check` and the mutation suite, an archived tree can still demonstrate a verified working state to anyone who arrives later. |
| Zero dependencies, one-file reader, MPL-2.0 | **S4. Publish the reader, not just the package.** `src/macho.mjs` alone parses real binaries with no `node_modules`, no lockfile and no install — the artefact that survives a hostile network, a supply-chain incident or a reader who will never run npm, and it needs no valid package name to be useful. | **S8. Publish the defect history.** 23 mutation-locked defects with the reasoning attached is the credibility surface against "just use Ghidra", and it is already written down in a form a reader can reproduce. |
| | | |
| **Weaknesses** | **WO — fix** | **WT — contain** |
| **Unpublished**; provenance pointer unreachable; README/`--help` drift; bundle stale; IPA half-landed | **W1. Cut a tag that postdates `release.yml`.** This is the same item as `S1` seen from the weakness side: the machinery exists and no check fails while it is unused. Nothing else on this side of the matrix matters until it is done. | **W7. Do not add mnemonics, ObjC/Swift metadata, DWARF, or shared-cache extraction.** The reversal stands across three versions of this document, and it now has a second argument: `rea` and Binary Ninja are both going *up* the stack toward decompilation, and contesting that with a per-opcode table whose wrong answer is a plausible instruction loses on the only axis that is unique. |
| Absent corpus member still silent; a `tbd` tool with no `bin`; no docs deployment | **W2. Name the absent system binaries.** One line in `discover()`. "765 passed" and "765 passed, no ffmpeg on this box" differ only in the number, and skipped *checks* are already reported honestly. Open for three versions; cheap enough to just do. | **W8. Ship the gate with the package.** `.githooks/pre-commit` and `pre-push` are versioned and blocking-verified, and `release.yml` re-runs the suite rather than trusting the tag. The failure mode this prevents — a publish whose gate was a `--dry-run` believed at face value — is exactly how the package's name story went wrong the first time. |
| One maintainer; no release; no stars | **W3. Make the three prose claims checks.** `README.md`'s tool count, `macho-explorer --help`'s subcommand list and the workflow comment's package name are all falsifiable today. `test/skill.mjs` already proves the mechanism exists; this is applying it to the three files nobody re-reads. | **W9. State the isolation explicitly.** The workspace-level "no product knowledge" guarantee is true of this package and easy to overstate from outside; the boundary checks are the proof and should be named as such wherever the claim appears. |
| | **W4. Regenerate the bundle, and wire or drop IPA.** `node demo/link.mjs` closes the first. The second is a one-way decision: either `test/ipa.mjs` goes green *and* gains a `test:ipa` script and a workflow step, or the README stops claiming `.ipa` support. A red suite nobody runs is the worse option of the three. | |
| | **W5. Widen the publish gate to `test:all`, and deploy the docs tree.** `release.yml` runs eight of the seventeen suites; the seven it skips are the ones that guard the `.d.ts`, the schemas and the Action — exactly the artefacts a published package ships. `docs/` is already built and `test/docs.mjs` already checks it; the Pages workflow should publish it rather than the audit report. | |
| | **W6. Cut the release binaries.** `release-binaries.yml` exists and has never run on a tag that postdates it. A SEA binary with the version embedded as a SEA asset is the distribution story for the readers who will never run npm. | |

> **W-note — the reversal stands.** Three versions of this document have now
> considered DWARF and disassembly, and two earlier ones named DWARF as the
> highest-value next step. None does now. `README.md` frames mnemonics, DWARF,
> Objective-C/Swift metadata and code signing as *deliberate gaps* — "the ones
> where a general parser or a disassembler is strictly better, and closing them
> here would mean becoming one of those projects instead of this one". The gaps
> worth closing are the ones that make this *more* itself: `.tbd` text stubs,
> the `NOT_READ` list, the schema per tool. As of `8313665` that list is short.

---

## Reading the matrix

**The agenda inverted twice, and that is the headline.** The previous version's
whole external quadrant was `S1`, "fix the name", and the fix was one word. That
word has since been changed again — the package is `macho-explorer`, the prefix
is gone from every command — and the name is now valid and tagged. What remains
is not a string at all: it is the *act* of publishing, which no check fails on,
which no document blocks, and which gates every one of the eight opportunities on
the right-hand side. **The last version was a strategy document whose top
recommendation was a typo fix. This one's top recommendation is a command nobody
has run.**

**The moat is compositional and the clock is real.** Each of SARIF, the Action,
the schema-per-tool, zero dependencies and auditable-in-an-afternoon is a
feature. All five together is a category, and `strategy/LANDSCAPE-ANALYSIS.md`
verifies each slot empty by code search rather than by inference. But `ipsw`
could close all three in a quarter, and Binary Ninja already moved into the agent
lane with an MCP server and a free AArch64 tier. The window is 12–18 months and
it opens the day the package is installable.

**The most valuable outcomes were still found by doing, not by reading.** The
`.tbd` reader was recommended as `P1` in the landscape pass and is now in the
tree, and re-deriving it turned up the two facts that make it a claim rather than
a feature: 46% of an SDK's stubs are symlinks to the same file, and a stub with
one unread line has an *unknown* symbol count and must exit 3 rather than print a
number. Neither is visible from a plan. The same is true of the re-derivation in
this document: the README's tool count, the help's missing subcommands, the stale
bundle and the failing IPA suite are all defects that a re-read of the previous
TOWS could not have found, because the previous TOWS was confident and wrong in
the same places.

**One red is in the tree and outside every gate, and one red is the working
tree, and both directions are informative.** `test/ipa.mjs` fails, has no npm
script, and runs in no workflow — it *cannot* fail a build, which is the exact
shape this project has written about six times: a verification that reports
success because nobody runs it. `test/browser.mjs` fails because two uncommitted
files re-staled a generated bundle one commit after the commit that fixed it, and
that one is the check *working*: the drift it guards against is real and frequent.
But "the check works" is not "the gate is green": until IPA is wired or dropped
and the bundle is regenerated, the `protocol` job does not pass and the CI badge
does not vouch for the commit it points at.

**The one item open across all three versions of this document is the provenance
pointer.** It is not the most valuable item — `S1`/`W1` publishing is — but it is
the one whose failure mode is unrecoverable: the reader who follows it is the one
looking for a reason not to trust the project, and the path they are sent down
does not exist. It belongs in the same commit as the first publication, because
after that commit the audience it exists to reassure is no longer one person.
