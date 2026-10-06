# Text stubs — `.tbd`

Since macOS 11 the system dylibs are not files. `/usr/lib/libSystem.B.dylib` is
inside the dyld shared cache, so `nm`, `otool`, `jtool2` and every tool in this
package that reads binaries have **nothing to open**.

"What does libSystem export" is therefore not a slow question on a modern
machine. It is unanswerable by anything that reads binaries. The answer is in
the SDK, as text.

A `.tbd` is what Apple would have shipped if the symbol table had been a file:
install names, target triples, and every exported name. Reading one needs no
Mach-O parser at all.

```sh
macho-explorer tbd --symbol=_pthread_mutex_lock \
  --sdk="$(xcode-select -p)/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/lib"
```

```
_pthread_mutex_lock  —  4 hit(s) in 2 libraries, from 394 stub(s)
  /usr/lib/system/libsystem_pthread.dylib
  /usr/lib/system/introspection/libsystem_pthread.dylib
    _pthread_mutex_lock   .../libSystem.B.tbd#31  [arm64-macos, arm64-macos, ...]
```

That is the answer you need before reasoning about a call site: it is
`libsystem_pthread.dylib`, **not** `libSystem.B.dylib`, which only re-exports it.
It takes about **0.7 seconds**.

## One file, many libraries

`libSystem.tbd` is **39 documents** in one file — one per constituent dylib:
`libsystem_c.dylib`, `libsystem_malloc.dylib`, `libsystem_pthread.dylib`, and so
on.

Reading only the first would report the umbrella's own metadata and a fraction of
its symbols, with nothing in the answer saying so. So the summary always states
the document count, and `--symbol` attributes every hit to the document that
exports it.

"That is the one answer this reader must never give about a file it read
successfully" is the whole reason: **which library provides this symbol** is only
answerable if the symbol knows which of the 39 it came from. A flat union of
40,000 names answers a much weaker question.

## 46% of an SDK's stubs are symlinks

**2,448 of the 5,309 stubs** in the macOS 15.2 SDK are symlinks. `libm.tbd` is a
link to `libSystem.tbd`; so are `libc.tbd` and `libpthread.tbd`. An SDK ships one
stub per *interface umbrella* and points every name at it.

Walking without resolving gives a correct-looking answer that is wrong in the way
that matters most: `_pthread_mutex_lock` would be reported as exported by 39
files, and a reader concludes there are 39 places to look. The install name is
identical in all 39, so nothing in the output contradicts it.

Paths are therefore resolved and deduplicated, and the **alias count is
reported** rather than hidden — "39 names, one file" is itself the interesting
fact, because it tells you the SDK has no per-library symbol granularity, only
per-umbrella.

## Queries

| Flag | Question |
|---|---|
| `--symbol=<name>` | Is this exported, by which library, for which targets |
| `--mode=substring` | …matching anywhere in the name. `exact` is the default, and the two are **different questions** |
| `--sdk=<dir>` | Search a whole SDK. Needs `--symbol` |
| `--symbols` | List every exported symbol |
| `--reexports` | What this stub passes through from somewhere else |
| `--objc` | Objective-C class and ivar **names** |
| `--max=<n>` | Cap a listing. The count stays exact |

With none of them, the stub is summarised: version, targets, document count,
symbol count, and one line per library.

Per-entry targets are kept **item-shaped** — an entry is a target list and the
symbols exported for it. `libQMIParserDynamic` is the case that makes this
matter: its two weak symbols are x86_64-only while its real symbols list all three
architectures, and recording targets per symbol would have buried that.

## Exit codes

`0` found · `1` **found nothing** · `2` usage error · `3` could not do the job.

So `--symbol=_nonexistent` exits **1**, not 3. It is a negative answer about the
stub, and a caller that retries variations of a name which is genuinely absent is
wasting time.

`3` means the file could not be read, **or it is not a stub, or it contains a line
this reader does not understand**.

## A partial answer is withheld

That last one is deliberate. A stub containing an unread line has an **unknown**
symbol count, and printing the count anyway states something not known to be true.
"This stub exports 4,100 symbols" is exactly the kind of confident answer that
sends someone down the wrong path.

So the reader exits 3 and names the lines:

```
libBroken.tbd: 1 line(s) this reader does not understand, so its symbol count is unknown
  libBroken.tbd:9  not a key, a sequence entry, or a document boundary

  Refusing to report a partial symbol list. Every line is parsed or the answer is withheld.
```

Every line is parsed or the answer is not given. It is also the only way anyone
finds out the parser needs extending.

A wrong *format* is a different problem with a different message. A Mach-O handed
to `tbd` is told it is not a stub, not that the stub is malformed.

## Both format versions

`v4` is flat. `v2` — anything from Xcode 7 to 10 — nests three mappings deep and
writes each symbol as `_name: null`, so the names are the **keys**.

One parser covers both, because two parsers for one format is two places for a
subtle disagreement to hide, and it would surface as a symbol list that differs
between SDK versions with no error in either.

```yaml
# v2: names are mapping keys
targets:
  x86_64-apple-macos:
    symbols:
      _exit: null
      _malloc$RENAMED: '@rpath/libmalloc.dylib(libSystem.B)'
```

The annotation is the *value*, so the keys are the names unconditionally. Reading
values alone reports a v2 stub as exporting nothing — a well-formed, entirely
wrong answer from a symbol reader.

## What it does not read

| | |
|---|---|
| Addresses | **None.** A stub describes the linker's view and contains no addresses |
| Objective-C | Names only — no types, no ivar offsets, no method lists, no metadata |
| Swift | No conformance metadata |
| `$REF` | The annotation is kept verbatim; the target library is not resolved |
| Mach-O, DWARF, shared cache | Not read. Handled by the other tools |

**A re-export is not an implementation.** The name is recorded where it passes
through, and the code may live in another library entirely. That is why the
answer names the provider rather than assuming the umbrella built it.

## How it is verified

Against **every stub in a real SDK** — the macOS 15.2 Command Line Tools SDK:

| | |
|---|---|
| Files | **5,304** |
| Libraries (documents) | **6,387** |
| Symbols | **4,743,784** |
| Unrecognised lines | **0** |
| Failures | **0** |
| Time | 15.7 seconds |

That corpus is the check. The checked-in fixtures under `test/fixtures/tbd/` are
**verbatim excerpts of Apple's own files**, not files written to match the parser
— a generated fixture is a restatement of the parser's own assumptions.

One fixture is malformed on purpose, and the reader must refuse it.

Run the sweep yourself:

```sh
node test/tbd.mjs          # a deterministic ~300-file stride sample
node test/tbd.mjs --full   # every stub in the SDK
```

Sampled by default because a check that takes minutes stops being run.
Deterministic rather than random because a failure has to reproduce.