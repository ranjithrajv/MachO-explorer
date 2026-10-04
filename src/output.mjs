/**
 * output.mjs — argument parsing and JSON emission, shared by every tool.
 *
 * ## Why `--json` lives here rather than in each tool
 *
 * Each tool already had its own argument handling, and each did it slightly
 * differently: some read positionals by index, some filtered out anything
 * starting with `--`, and none of them could produce machine-readable output.
 * That is the state these tools were in for their entire life, and it is why
 * they were only usable by a person at a terminal.
 *
 * `--json` changes what the tools are *for*. The text output is a report; a
 * report is something a person reads. Structured output is something a script,
 * a pipeline or an agent consumes, and it is what makes these tools composable
 * with anything else rather than terminal-only. It is also the cheapest
 * possible path to "ask a question of a 476 MB binary in a shell pipeline":
 *
 *     macho-explorer findcall --json 0x100085c30 /usr/local/go/bin/go | jq '.hits | length'
 *
 * ## One guarantee this module makes that it did not used to
 *
 * A `--json` envelope is written **completely, or not at all**. It was not, and
 * the failure was invisible: see {@link writeAllSync} for the measurement and
 * for why the test suite did not catch it.
 *
 * ## The contract
 *
 * Two guarantees, because a consumer that has to work around them will not
 *   1. **stdout is JSON only.** Progress lines, the per-slice narration and the
 *      "none found" prose all go to stderr under `--json`. This matters more
 *      than it looks: it is the difference between `tool --json | jq` working
 *      and it silently reading its own diagnostics as data.
 *   2. **It is one object, always.** Envelope shape, not a bare array, so a
 *      consumer can read `.tool`, `.ok` and `.warnings` on a failure without
 *      first guessing what a success looks like.
 *
 * Addresses are emitted as `"0x..."` strings rather than JSON numbers. A 64-bit
 * vaddr does not survive `Number` — anything above 2^53 loses its low bits —
 * and a silent precision loss in the tool's output would be indistinguishable
 * from a correct answer. This is exactly the class of bug the rest of this
 * project exists to avoid, so it is fixed at the boundary rather than left to
 * whoever writes the consumer.
 */

import fs from 'node:fs';

/**
 * Envelope keys every tool emits, so consumers can rely on the shape.
 *
 * `sym` is one of them rather than the two it replaced: the `symgrep`/`symfind`
 * pair went away with the merge rather than being kept as aliases, so neither name
 * can appear here any more.
 *
 * The list is the suite's roster: `smoke.mjs` walks it to check that every tool
 * answers `--help`, and refuses unknown flags, on the reasoning that a tool whose
 * one universally-required flag reports a usage error is the wrong shape for the
 * first thing anyone runs. A tool that exists but is not on this list gets none
 * of that, so being added here is part of being added at all.
 */
export const TOOLS = [
  'describe', 'sym', 'symlookup', 'findcall', 'findliteral', 'mapliteral', 'a2o', 'o2a', 'disasm',
  'audit', 'fingerprint', 'diff',
];

/**
 * Split argv into flags and positionals.
 *
 * A bare `--` is honoured, because a Mach-O path may legitimately begin with a
 * dash and there is no other way to say so. `--flag=value` is accepted for the
 * same reason `getopt` accepts it.
 */
/**
 * Flags that take a separate value, so `-b /bin/ls` consumes `/bin/ls`.
 *
 * Without this list the value falls through as a positional, and in
 * `symlookup` — where every positional is an address — that produced
 * "addresses must be hex: got /bin/ls". A usage error naming the wrong problem
 * is worse than no usage error, because it sends the reader looking in the
 * wrong place.
 *
 * `count` and `bytes` are here for the same reason as `max`: they take a
 * number, and a number in the wrong slot reads as a perfectly plausible address
 * or path. Keeping the list here rather than per-tool is what makes that a
 * single edit instead of one per tool that later grows a numeric flag.
 *
 * `min` was missing, and the omission was live in both tools that take it:
 * `findliteral --strings --min 9 <binary>` and `overview --strings --min 9
 * <binary>` both read `9` as the binary and failed with "9: cannot be read",
 * because `--min=9` worked and the space form did not — so a flag documented
 * with an `=` in one place silently misparsed in another. The asymmetry was the
 * bug: a flag that only works one way is a trap for anyone who types the other.
 */
export const VALUE_FLAGS = new Set(['b', 'binary', 'arch', 'max', 'include', 'count', 'bytes', 'in', 'per-file', 'max-files', 'max-depth', 'min']);

/**
 * Flags every tool accepts, whatever else it does.
 *
 * `-h`/`--help` is here so it can never be reported as unknown, and `-b`/`--binary`
 * so a binary can always be named the documented way. A tool passes its own set
 * alongside these to `rejectUnknownFlags`.
 */
export const COMMON_FLAGS = new Set(['h', 'help', 'b', 'binary', 'q', 'quiet', 'color', 'no-color', 'v', 'verbose', 'V', 'version']);

/**
 * Fail on a flag this tool does not accept, rather than ignoring it.
 *
 * The alternative was the bug this replaces: `sym --regexx <pattern>` silently
 * downgraded to a substring search and answered a *different question*, exiting
 * 1 — "found nothing" — so a typo produced a confident wrong answer instead of an
 * error. `describe` rejected unknown flags while `sym`, `symlookup` and
 * `findliteral` accepted anything, which is the worst of both: the same
 * misspelling failed on one tool and was ignored on three.
 *
 * The MCP layer rejected unknown arguments from the start; this is that rule
 * applied to the CLIs, so both surfaces now agree. `--` still ends flag parsing
 * and a lone `-` stays positional, so nothing legitimate is caught by it.
 *
 * @param {Set<string>} known       flags this tool accepts
 * @param {Set<string>} used        flags actually given
 * @param {string[]}   usageLines   printed above the error
 */
export function rejectUnknownFlags(known, used, usageLines) {
  const unknown = [...used].filter((f) => !known.has(f) && !COMMON_FLAGS.has(f));
  if (!unknown.length) return;
  const [long] = unknown;
  // The near-miss suggestion is the point of doing this by hand: the commonest
  // cause is a typo, and "did you mean" turns a failed command into a corrected
  // one. Levenshtein rather than a library, because the alternative is a
  // dependency in a package whose identity is having none.
  let hint = '';
  let best = null;
  for (const k of new Set([...known, ...COMMON_FLAGS])) {
    if (k === long) continue;
    const d = distance(long, k);
    if (d <= Math.max(1, Math.floor(long.length / 3)) && (!best || d < best.d)) best = { k, d };
  }
  if (best) hint = `\n\n  did you mean --${best.k}?`;
  usage([
    ...usageLines,
    '',
    `unknown flag: --${long}${hint}`,
    ...(unknown.length > 1 ? [`also unrecognised: ${unknown.slice(1).map((f) => `--${f}`).join(', ')}`] : []),
  ]);
}

/** Plain Levenshtein, no early exit. Inputs are a handful of characters. */
function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  const positional = [];
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (literal) { positional.push(a); continue; }
    if (a === '--') { literal = true; continue; }

    // Single-dash flags count as flags. They used to be treated as positionals,
    // so `symlookup -b /bin/ls` parsed `-b` as a vaddr. A bare `-` (stdin, by
    // convention) stays positional rather than becoming a flag.
    if (a.length > 1 && a.startsWith('-') && a !== '-') {
      const body = a.replace(/^--?/, '');
      const eq = body.indexOf('=');
      if (eq > 0) {
        const name = body.slice(0, eq);
        flags.add(name);
        opts[name] = body.slice(eq + 1);
      } else {
        flags.add(body);
        if (VALUE_FLAGS.has(body) && i + 1 < argv.length) opts[body] = argv[++i];
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, opts, positional };
}

/**
 * Serialise a value as JSON, with BigInt rendered as a hex string.
 *
 * `JSON.stringify` throws on a BigInt, which every address in this codebase
 * is, so the naive `JSON.stringify(result)` fails on every tool. Converting in
 * a replacer — rather than by hand at each call site — means a BigInt cannot be
 * forgotten: the first address anyone adds to a new tool is handled here, not
 * by whoever notices the crash.
 *
 * `indent` defaults to 2 because every tool has always pretty-printed and a
 * response a person reads under `--json` is meant to be readable. `0` gives the
 * compact form, measured at 41% smaller on a symbol inventory of 4,000 rows
 * (421,816 bytes to 248,890 on the Go binary). It is opt-in per tool rather than
 * global because the readability is worth losing only where the volume is: a
 * 4000-row array is read by a program, not by a person.
 */
export function toJSON(value, indent = 2) {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') return `0x${v.toString(16)}`;
    return v;
  }, indent);
}

/**
 * Write every byte of `text` to `fd` before returning.
 *
 * ## Why not `process.stdout.write`
 *
 * Because `process.stdout.write` is **asynchronous when stdout is a pipe**, and
 * every tool in this package finishes with `process.exit()`. `process.exit` does
 * not wait for pending stream writes, so the last thing to happen is the only
 * thing that matters being discarded:
 *
 *     $ findliteral --strings --json /usr/lib/dyld > file   # 826,998 bytes, parses
 *     $ findliteral --strings --json /usr/lib/dyld | cat    # 65,536 bytes, does not
 *
 * 65,536 is exactly one macOS pipe buffer. Redirecting to a file always worked,
 * because a file descriptor to a regular file is synchronous — which is why this
 * survived a test suite that runs every tool through `spawnSync` and captures
 * stdout through a pipe. It did not survive: no fixture produced more than 64 KiB
 * of JSON, so the one path that matters most for scale was the one path never
 * exercised. The failure is silent and *looks* like data — a truncated envelope
 * that a lenient consumer parses into a short array rather than rejecting.
 *
 * `writeSync` in a loop is the fix, and it is at the boundary rather than at each
 * call site because the boundary is the one place that knows a `process.exit` is
 * coming. Fixing it per-tool would mean thirteen edits and one omission.
 *
 * ## EAGAIN and EPIPE
 *
 * A non-blocking descriptor reports `EAGAIN` instead of waiting for room. The
 * bytes are still ours to write, so this waits and retries rather than dropping
 * them — a dropped tail is the same silent truncation in a smaller disguise.
 * `EPIPE` means the reader left (`| head`, or a consumer that had seen enough),
 * which is a normal way for a pipeline to end and not this tool's failure to
 * report; it stops the loop quietly instead of throwing at the consumer.
 *
 * Exported because the MCP server has the same shape and a worse version of it:
 * its transport is stdio, so stdout is *always* a pipe there rather than a pipe
 * only when the caller redirects — meaning the CLI bug hid behind a working
 * `> file` case and the MCP one has no hiding place at all.
 */
export function writeAllSync(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        // Block the thread briefly rather than spinning. A hot retry loop on a
        // busy pipe is a CPU burner, which is the wrong failure for a tool whose
        // whole claim is that it is cheap.
        Atomics.wait(SLEEP, 0, 0, 1);
        continue;
      }
      if (e.code === 'EPIPE') return;
      throw e;
    }
  }
}

/** One scratch cell for {@link writeAllSync}'s backoff. Never read. */
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/**
 * Emit one JSON envelope and exit with `code`.
 *
 * `errors` is a list of machine-readable reason codes, not prose, so a consumer
 * can branch on `code === "no-symbols"` without pattern-matching an English
 * sentence. The prose lives in `messages` for the human reading stderr.
 *
 * Both streams are written with {@link writeAllSync} rather than
 * `process.stdout.write`, because `process.exit(code)` at the end of this
 * function discards whatever the stream had not flushed yet, and on a pipe that
 * is everything past the first 64 KiB. See that function for the measurement.
 */
/**
 * The version of the JSON envelope this build emits.
 *
 * ## Why a version at all
 *
 * The envelope is the package's only stable surface. `--json` is how every tool is
 * scripted and how the MCP server answers an agent, so once anything consumes it,
 * changing a field name or a meaning is a breaking change whether or not the
 * package.json version says so. A consumer that cannot detect that will keep
 * parsing and quietly believe the wrong thing — which is the failure this project
 * exists to prevent, arrived at through a dependency instead of through a typo.
 *
 * So the version travels *in* every response rather than in documentation beside it.
 * A consumer pins the value it was written against and fails loudly on a change,
 * instead of discovering it from an empty field.
 *
 * ## When to bump it
 *
 * Bump the **major** on a removal, a rename, or a change of meaning. Bump the
 * **minor** when a field is added, since an added field is ignorable and existing
 * consumers keep working. Nothing else warrants a bump — in particular, a new tool
 * is not a change to the envelope, which is the point of having one envelope.
 *
 * Kept as a string rather than a number so `1.10` sorts after `1.9` to a reader as
 * well as to a version comparison, and so it can never be compared with `>` by a
 * consumer that forgets the coercion.
 */
export const SCHEMA_VERSION = '1.0';

export function emitJSON({ tool, binary, ok = true, data = null, errors = [], messages = [], notes = [], indent = 2 }, code = 0) {
  // Normalised rather than trusted: `notes: null` is a natural thing to write
  // when a tool has nothing to say, and it crashed the emitter rather than
  // emitting nothing. A helper that throws on `null` is a helper every caller
  // has to remember to guard, and one caller will not.
  const msgs = Array.isArray(messages) ? messages : [];
  const nts = Array.isArray(notes) ? notes : [];
  // stderr too, and for the same reason: a `--json` consumer that also captures
  // diagnostics through a pipe lost them the same way. Same fix, same boundary.
  writeAllSync(2, [...msgs, ...nts].map((m) => m + '\n').join(''));
  writeAllSync(
    1,
    toJSON({
      // First key, so it is the first thing anyone reading a raw response sees.
      // The envelope's own version, before the tool's name: it qualifies everything
      // that follows.
      schemaVersion: SCHEMA_VERSION,
      tool,
      ok,
      binary: binary ?? null,
      errors,
      // Omitted rather than emitted as null or []: an absent key is
      // distinguishable from an empty list, which is the distinction between
      // "nothing to report" and "there is nothing there" that this project
      // keeps having to be careful about.
      ...(msgs.length ? { messages: msgs } : {}),
      ...(nts.length ? { notes: nts } : {}),
      data,
    }, indent) + '\n',
  );
  process.exit(code);
}

/**
 * Thousands-separated integer, locale-independently.
 *
 * `toLocaleString()` groups according to the machine's locale, so the same
 * count prints as `5,880,564` in one locale and `58,80,564` in another — where
 * it reads as fifty-eight million and is off by a factor of ten. A number a
 * reader has to re-parse by eye is a number that will be misread, so the
 * separator is fixed here rather than inherited.
 */
export function count(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  return String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Standard exit codes. Documented because callers branch on them. */
export const EXIT = {
  ok: 0,
  /** The tool ran but found nothing. Distinct from `fail` on purpose: a caller
   *  that treats "no matches" as an error will treat a working tool as broken. */
  empty: 1,
  /** Usage error — bad or missing arguments. */
  usage: 2,
  /** The tool could not do its job: unreadable file, unknown architecture. */
  fail: 3,
};

/** Print usage and exit 2. Every tool routes through this. */
export function usage(lines) {
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(EXIT.usage);
}

/* ------------------------------------------------------------------ *
 * Standard flag helpers
 *
 * These are the flags every tool accepts via COMMON_FLAGS. They are
 * parsed by parseArgs like any other flag, so a tool checks for them
 * with flags.has('quiet') etc. The helpers below centralise the
 * behaviour so each tool does not reimplement it.
 * ------------------------------------------------------------------ */

/**
 * Returns true when --quiet / -q was passed.
 *
 * --quiet suppresses non-essential output: progress messages, notes,
 * per-slice narration, and summary lines. The actual data (symbols,
 * call sites, sections, etc.) is still printed. Error messages are
 * never suppressed.
 */
export function isQuiet(flags) {
  return flags.has('quiet') || flags.has('q');
}

/**
 * Returns true when --verbose / -v was passed.
 *
 * --verbose enables diagnostic output: parsing steps, slice detection,
 * timing information, and other details that help understand *why*
 * something failed or what the tool discovered.
 */
export function isVerbose(flags) {
  return flags.has('verbose') || flags.has('v');
}

/**
 * Returns true when color output should be used.
 *
 * Color is enabled when:
 *   - --color is passed, OR
 *   - stdout is a TTY and --no-color was not passed and NO_COLOR is not set
 *
 * Color is disabled when:
 *   - --no-color is passed, OR
 *   - NO_COLOR env var is set, OR
 *   - TERM=dumb, OR
 *   - stdout is not a TTY (piped/redirected)
 */
export function colorEnabled(flags) {
  if (flags.has('no-color')) return false;
  if (flags.has('color')) return true;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  return process.stdout.isTTY;
}

/**
 * Log a non-essential message unless --quiet is set.
 *
 * Use this for progress messages, notes, and summary lines that a
 * scripting consumer does not need. The actual data output should
 * use console.log directly so it is never suppressed.
 */
export function quietLog(flags, ...args) {
  if (!isQuiet(flags)) console.log(...args);
}

/**
 * Log a diagnostic message only when --verbose is set.
 *
 * Use this for parsing steps, timing, and other details that help
 * understand what the tool did.
 */
export function verboseLog(flags, ...args) {
  if (isVerbose(flags)) console.error(`[verbose] ${args.join(' ')}`);
}

/* ------------------------------------------------------------------ *
 * Color helpers
 *
 * ANSI escape codes for terminal output. Used by tools when
 * colorEnabled(flags) returns true.
 * ------------------------------------------------------------------ */

/** ANSI color codes. */
export const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

/**
 * Wrap text in a color code when color is enabled.
 *
 * @param {string} text  the text to colorize
 * @param {string} color the color name from COLOR
 * @param {Set<string>} flags  the parsed flags
 * @returns {string}
 */
export function colorize(text, color, flags) {
  if (!colorEnabled(flags)) return text;
  return `${COLOR[color] || ''}${text}${COLOR.reset}`;
}

/**
 * Colorize text for a severity level.
 *
 * @param {string} text  the text to colorize
 * @param {string} severity  'error', 'warning', 'info', 'success'
 * @param {Set<string>} flags  the parsed flags
 * @returns {string}
 */
export function severityColor(text, severity, flags) {
  const map = { error: 'red', warning: 'yellow', info: 'blue', success: 'green' };
  return colorize(text, map[severity] || 'reset', flags);
}
