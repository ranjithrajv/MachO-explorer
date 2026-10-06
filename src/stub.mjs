/**
 * stub.mjs — read a text-based stub, the text form of what a Mach-O symbol
 * table would have been.
 *
 * A `.tbd` is what a Mach-O *would* have been if Apple had shipped the symbol
 * table as text. Since macOS 11 the system dylibs no longer exist as files at
 * all — they are baked into the dyld shared cache — and this stub is the only
 * description of what they export. So the question "what does libSystem export"
 * is not a slow question on a modern machine; it is one this file answers and
 * nothing else on the box does.
 *
 * ## Why a hand-written parser, and not a YAML library
 *
 * The format is YAML with a custom tag, so the obvious move is a YAML dependency.
 * That would be the package's first and hardest dependency, and it would be
 * wrong for a reason beyond size: a general YAML parser accepts a thousand shapes
 * this reader has no interpretation for, and every one of them is a place to
 * answer confidently and wrongly. A parser that knows `tbd` cannot silently
 * accept a construct whose meaning is unknown here.
 *
 * So this reads the subset the format actually uses, and — the property that
 * makes it defensible — **it reports every line it did not recognise**, naming
 * file and line. A `.tbd` whose exports are half-parsed must fail, not return a
 * plausible short list. "libSystem exports 4 symbols" when it exports 40,000 is
 * the exact failure this project exists to prevent, and it would be invisible:
 * both answers are well-formed.
 *
 * `test/tbd.mjs` runs this over every stub in a real SDK when one is present, and
 * requires zero unrecognised lines. That is the conformance corpus, and it is not
 * something to be written by hand.
 *
 * ## A `.tbd` is a stream of documents, not one document
 *
 * `libSystem.tbd` is 39 separate YAML documents in one file — one per real
 * dylib (`libsystem_c.dylib`, `libsystem_malloc.dylib`, `libsystem_pthread.dylib`,
 * and so on). Reading only the first would report the umbrella's own metadata and
 * a fraction of its symbols, with nothing in the answer saying so.
 *
 * So the reader keeps the documents apart. That is not tidiness: it is the whole
 * answer to the question people actually ask. "Which library provides this symbol"
 * is only answerable if the symbol knows which of the 39 documents it came from,
 * and a flat union of 40,000 names would answer a different, much weaker
 * question.
 *
 * ## Per-item targets, and why the output is item-shaped
 *
 * In v4 every `exports` entry carries its own `targets:` list, so a symbol is
 * exported for `arm64-macos` and not for `x86_64-maccatalyst`. Recording that per
 * symbol would multiply the output by the target count and make the common case
 * — where the item's targets equal the document's — indistinguishable from the
 * interesting one. So exports are kept **item-shaped**: an item is a target list
 * and the symbols exported for it. Compact, and faithful.
 *
 * ## What is not read
 *
 * `targets` triples (`arm64-apple-macos10.4`) in the v2/v3 shape, Swift
 * conformance metadata, `objc-ivars` type encodings, and the `$` re-export
 * annotation's target library are all recorded verbatim where they appear rather
 * than interpreted. The strings are kept; the meaning is not invented.
 */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * scalars
 * ------------------------------------------------------------------ */

/**
 * Split a flow sequence's body on commas that are not inside quotes.
 *
 * A comma inside `'a, b'` is part of the value, and a split on every comma turns
 * one library path into two garbage symbol names — which is the failure a stub
 * parser cannot recover from, because the result still looks like a symbol list.
 */
function splitFlow(body) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        // A doubled quote is an escaped quote in this format, not a terminator.
        if (body[i + 1] === quote) {
          cur += quote;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

const unquote = (s) => {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).split(t[0] + t[0]).join(t[0]);
  }
  return t;
};

/**
 * Turn a raw right-hand side into a scalar or an array of scalars.
 *
 * `null` and `~` become `null` rather than the four-character string, because the
 * v2 shape writes every plain symbol as `_exit: null` and treating that as a name
 * would export the symbol "null" 4,000 times.
 */
function parseValue(raw) {
  const t = raw.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t.startsWith('[')) {
    const end = t.lastIndexOf(']');
    const body = end > 0 ? t.slice(1, end) : t.slice(1);
    return splitFlow(body).map(unquote);
  }
  if (t.startsWith('{')) return { __flowMap: t };
  return unquote(t);
}

/** Bracket depth, ignoring brackets inside quotes. */
function depth(s) {
  let d = 0;
  let quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '[' || ch === '{') d++;
    else if (ch === ']' || ch === '}') d--;
  }
  return d;
}

/* ------------------------------------------------------------------ *
 * the parser
 * ------------------------------------------------------------------ */

/**
 * Keys whose values are lists of names, and what those names are.
 *
 * A `symbols:` entry under `reexports:` is a *re-export* — this library passes
 * the symbol through from somewhere else — and one under `exports:` is its own.
 * Collapsing the two into one "symbols" list is the difference between "libSystem
 * exports malloc" and "libSystem exports malloc because libsystem_malloc.dylib
 * does", which are different claims about the same name.
 *
 * The section is therefore part of a key's meaning, and the tables below are keyed
 * by `section/key` rather than by `key` alone.
 */
const SECTION_OF = {
  exports: 'exports',
  reexports: 'reexportedSymbols',
  'reexported-libraries': 'reexportedLibraries',
  'parent-umbrella': 'parentUmbrella',
  'allowable-clients': 'allowableClients',
};

/** Keys that are names of symbols, classes, ivars or libraries. */
const NAME_LIST_KEYS = new Set([
  'symbols',
  'objc-classes',
  'objc-ivars',
  'objc-eh-types',
  'weak-symbols',
  'thread-local-symbols',
  'libraries',
  'umbrella',
  'clients',
  'targets',
  'flags',
]);

const NAME_SECTIONS = new Set(['exports', 'reexportedSymbols', 'reexportedLibraries', 'parentUmbrella', 'allowableClients', 'flags']);

const indentOf = (line) => line.length - line.replace(/^\s*/, '').length;

/**
 * Flatten a node to a list of names.
 *
 * The same logical field arrives in three shapes across the versions, and all
 * three occur in real SDKs:
 *
 *   v4   `symbols: [ _a, _b ]`              a flow sequence
 *   v2   `symbols:` followed by `_a: null`  a mapping whose keys are the names
 *   v2   `objc-classes:` then `NSObject:`   a mapping of names to lists
 *
 * So a field is read as "every name under here", wherever the names live. The
 * alternative — insisting on one shape — would report a v2 stub as empty, which
 * is the worst possible failure for a symbol reader: a well-formed answer saying
 * nothing is exported.
 */
/**
 * Every name under a node, wherever the names happen to live.
 *
 * The same logical field arrives in three shapes across the versions, and all
 * three occur in real SDKs:
 *
 *   v4   `symbols: [ _a, _b ]`              a flow sequence
 *   v2   `symbols:` then `_a: null`         a mapping whose keys are the names
 *   v2   `objc-classes:` then `NSObject:`   a mapping of names to lists
 *
 * So a field is read as "every name below here" and the shape stops mattering.
 * The alternative — insisting on one shape — reports a v2 stub as empty, which
 * is the worst failure available to a symbol reader: a well-formed answer saying
 * nothing is exported.
 *
 * `keysAreNames` covers the v2 mapping case, and is off by default because a
 * mapping with null values is not automatically a list of names —
 * `settings: { base: null }` would otherwise contribute the word "base".
 *
 * Scalars are handled by `typeof`, not by a wrapper object. The first version
 * looked for `{ __scalar }` while `parseValue` returned bare strings, so every
 * scalar fell through and a v4 stub reported **zero** symbols with nothing wrong
 * anywhere — two halves of a contract that did not meet.
 */
function namesUnder(node, keysAreNames = false) {
  const out = [];
  collectNames(node, out, keysAreNames);
  return out;
}

function collectNames(node, out, keysAreNames) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const v of node) collectNames(v, out, keysAreNames);
    return;
  }
  if (typeof node === 'string') {
    if (node !== '') out.push(node);
    return;
  }
  if (typeof node !== 'object') return;

  if (keysAreNames) {
    // The v2 shape: a symbol mapping whose keys are the names. Unconditional,
    // because a value need not be `null` — `_malloc$RENAMED: '@rpath/libmalloc.dylib'`
    // is a re-export annotation, and gating on "every value is null" dropped the
    // whole mapping, taking `malloc` with it.
    for (const k of Object.keys(node)) out.push(k);
    return;
  }
  for (const v of Object.values(node)) collectNames(v, out, keysAreNames);
}

/**
 * Target names, which are a list in v4 and the `keys` of a mapping in v2.
 *
 * Read as a list of values, a v2 `targets:` block yields the platforms —
 * "macos", "macCatalyst" — as though they were architectures.
 */
function triplesUnder(node) {
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) return node.map(String);
  if (typeof node === 'object') return Object.keys(node);
  return [];
}

/**
 * Normalise a field that may be one entry, a list of entries, or a bare list.
 *
 * `reexports:` is a list of entries in v4 and a bare list of names in v2, and
 * `platforms:` is a bare list in both. Treating them as one shape is how a
 * re-export comes back padded with architectures.
 */
function entriesFor(node) {
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) return node;
  if (typeof node === 'object') return [node];
  return [node];
}

const KEY = /^([A-Za-z_][\w.$-]*):(?:\s+(.*))?$/;

/**
 * Parse a `.tbd` file's text.
 *
 * Returns `{ documents, unrecognised, versions }` and never throws on content it
 * does not understand — the caller decides whether that is fatal, and it always
 * is, because a partially-read stub is a confidently wrong stub.
 *
 * ## One parser for both versions, not two
 *
 * v2/v3 and v4 look nothing alike: v4 is a flat mapping with sequence entries,
 * v2 nests three mappings deep with symbols as mapping *keys*. A line-oriented
 * scanner handles v4 and refuses v2 — which is what the first version did, and it
 * was correct to refuse rather than guess, but it made every pre-Xcode-11 SDK
 * unreadable.
 *
 * So this parses an indentation-structured subset of YAML, which covers both with
 * one code path. That matters for a reason beyond tidiness: two parsers for one
 * format is two places for a subtle disagreement to hide, and the disagreement
 * would show up as a symbol list that differs between SDK versions with no error
 * in either.
 *
 * ## What "unrecognised" means here
 *
 * Structural confusion is reported. Unfamiliar *keys* are not an error — a new
 * version may add fields — but they are kept verbatim on the node so nothing is
 * silently dropped, and a key whose name looks like a list is read as one.
 */
export function parseTbd(text, source = '<tbd>') {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const unrecognised = [];
  /*
   * Diagnostics name a line **in the file**, not in a document body.
   *
   * The first version indexed the master line array with a body-relative index,
   * so every message pointed at the wrong line — by the distance to the start of
   * the document containing it, which is 3,700 lines for libSystem.tbd. A
   * diagnostic that names the wrong line sends a reader to the wrong place with
   * confidence, and that is worse than one that names no line at all.
   */
  const note = (ls, off, n, why) => unrecognised.push({ line: off + n + 1, text: ls[n], why });

  /** Read a value that may be a flow sequence continued over several lines. */
  const readValue = (ls, off, i, first) => {
    let buf = first;
    // The running depth, advanced per line — **not** recomputed over the whole
    // buffer.
    //
    // Recomputing it is the obvious thing to write and it is quadratic: a flow
    // sequence with 50,000 entries spread over 2,000 continuation lines costs
    // 2,000 scans of a buffer that grows to megabytes, so each of the 508 stubs
    // under an SDK's usr/lib re-scans its own bulk hundreds of times. An SDK
    // search took 14 minutes; this is the whole of it.
    //
    // The trigger is a large file, not a large SDK: libextension.tbd is 5.1 MB and
    // libAlembic.tbd 2.6 MB, and either one is enough.
    let d = depth(first);
    let j = i + 1;
    while (d > 0 && j < ls.length) {
      const line = ls[j];
      buf += ' ' + line.trim();
      d += depth(line);
      j++;
    }
    if (d > 0) note(ls, off, i, 'a flow sequence that is never closed');
    return { value: parseValue(buf), next: j };
  };

  /** True when the line at `j` is nested under a key that ended at `indent`. */
  const continues = (ls, j, indent) => {
    while (j < ls.length && !ls[j].trim()) j++;
    if (j >= ls.length) return null;
    const ind = indentOf(ls[j]);
    if (ind > indent) return { j, ind };
    // A sequence may sit at its key's own indent; some writers emit it that way.
    if (ind === indent && /^\s*-\s/.test(ls[j])) return { j, ind };
    return null;
  };

  /**
   * Read mapping entries at exactly `indent` into `into`.
   *
   * `into` is passed in so a sequence item — whose first key is inline, after the
   * dash — can seed the map and then have its remaining keys read by the same
   * code. One loop for both is the point: a second copy of this would be a second
   * set of rules for what a mapping is.
   */
  const readMap = (ls, off, i, indent, into) => {
    const map = into || {};
    let j = i;
    while (j < ls.length) {
      const line = ls[j];
      if (!line.trim()) {
        j++;
        continue;
      }
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) {
        note(ls, off, j, `indented ${ind - indent} past the mapping it belongs to`);
        j++;
        continue;
      }
      if (/^\s*-\s/.test(line)) break;

      // `trimStart()` is load-bearing: KEY is anchored at ^, so on an indented
      // line it never matched at all and every nested mapping reported as junk.
      const kv = KEY.exec(line.trimStart());
      if (!kv) {
        note(ls, off, j, 'not a key, a sequence entry, or a document boundary');
        j++;
        continue;
      }
      const key = kv[1];
      const rest = (kv[2] || '').trim();

      if (rest) {
        const r = depth(rest) > 0 ? readValue(ls, off, j, rest) : { value: parseValue(rest), next: j + 1 };
        map[key] = r.value;
        j = r.next;
        continue;
      }

      const deeper = continues(ls, j + 1, indent);
      if (!deeper) {
        map[key] = null;
        j++;
        continue;
      }
      if (/^\s*-\s/.test(ls[deeper.j])) {
        const r = readSeq(ls, off, deeper.j, deeper.ind);
        map[key] = r.value;
        j = r.next;
      } else {
        const r = readMap(ls, off, deeper.j, deeper.ind, null);
        map[key] = r.value;
        j = r.next;
      }
    }
    return { value: map, next: j };
  };

  /** Read sequence entries at exactly `indent`. */
  const readSeq = (ls, off, i, indent) => {
    const items = [];
    let j = i;
    while (j < ls.length) {
      const line = ls[j];
      if (!line.trim()) {
        j++;
        continue;
      }
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) {
        note(ls, off, j, `a sequence entry indented ${ind - indent} past the sequence it belongs to`);
        j++;
        continue;
      }
      const entry = /^\s*-\s+(.*)$/.exec(line);
      if (!entry) break;

      const rest = entry[1];
      const kv = KEY.exec(rest);
      if (!kv) {
        // `- /usr/lib/system/libcommon_shims.dylib` — a plain scalar entry.
        items.push(parseValue(rest));
        j++;
        continue;
      }

      // `- key: value` — the item is a mapping whose first key is inline. The
      // remaining keys sit at the column the key starts in, which is exact
      // rather than assumed to be indent+2.
      const keyIndent = indent + 2;
      const seed = {};
      const rest2 = (kv[2] || '').trim();
      if (rest2) {
        const r = depth(rest2) > 0 ? readValue(ls, off, j, rest2) : { value: parseValue(rest2), next: j + 1 };
        seed[kv[1]] = r.value;
        j = r.next;
      } else {
        const deeper = continues(ls, j + 1, keyIndent);
        if (deeper) {
          const r = /^\s*-\s/.test(ls[deeper.j]) ? readSeq(ls, off, deeper.j, deeper.ind) : readMap(ls, off, deeper.j, deeper.ind, null);
          seed[kv[1]] = r.value;
          j = r.next;
        } else {
          seed[kv[1]] = null;
          j++;
        }
      }
      const r = readMap(ls, off, j, keyIndent, seed);
      items.push(r.value);
      j = r.next;
    }
    return { value: items, next: j };
  };

  /* ---- split into documents and parse each ---- */

  const documents = [];
  let start = null;
  for (let n = 0; n <= lines.length; n++) {
    const atEnd = n === lines.length;
    const line = atEnd ? '' : lines[n];
    if (!atEnd && !/^---\s/.test(line) && line !== '---') continue;
    if (start !== null) {
      let end = n;
      // `...` is Apple's end-of-document marker and it is the last non-blank line
      // of every stub in every SDK checked (5,309 of 5,309). Treating it as
      // content would put one unrecognised line on every file, which is worse
      // than useless: a report that always says "1 unrecognised" trains a reader
      // to ignore the field, and then a second one arrives unheard.
      while (end > start && !lines[end - 1].trim()) end--;
      if (end > start && lines[end - 1].trim() === '...') end--;
      const body = lines.slice(start, end);
      // Parsed against the body slice with the body start as the line offset, so a
      // diagnostic inside document 30 of a 39-document stub names the file line.
      const r = body.some((l) => l.trim()) ? readMap(body, start, 0, 0, null) : { value: {}, next: 0 };
      documents.push({ line: start + 1, node: r.value });
    }
    start = atEnd ? null : n + 1;
  }

  if (documents.length === 0 && lines.some((l) => l.trim())) {
    unrecognised.push({ line: 1, text: lines[0], why: 'no `--- !tapi-tbd` document header found' });
  }

  /* ---- interpret ---- */

  const out = documents.map((d) => {
    const top = d.node || {};
    const scalars = {};
    const targets = triplesUnder(top.targets);
    for (const k of ['install-name', 'current-version', 'compatibility-version', 'swift-abi-version', 'tbd-version']) {
      const v = top[k];
      scalars[k] = Array.isArray(v) ? v[0] ?? null : v === undefined ? null : v;
    }
    const tbdVersion = scalars['tbd-version'] === null ? null : Number(scalars['tbd-version']);

    // v4: `exports` is a list of entries, each with its own targets. v2: `exports`
    // does not exist and the names live under per-target mappings.
    const exports = [];
    for (const entry of Array.isArray(top.exports) ? top.exports : []) {
      if (!entry || typeof entry !== 'object') continue;
      const itemTargets = namesUnder(entry.targets);
      exports.push({
        targets: itemTargets.length ? itemTargets : targets,
        symbols: namesUnder(entry.symbols),
        objcClasses: namesUnder(entry['objc-classes']),
        objcIvars: namesUnder(entry['objc-ivars']),
        objcEhTypes: namesUnder(entry['objc-eh-types']),
        weakSymbols: namesUnder(entry['weak-symbols'], true),
        threadLocalSymbols: namesUnder(entry['thread-local-symbols'], true),
      });
    }

    // v2 nests everything one level deeper: the names sit under
    // `targets.<triple>.symbols`, not at the top. The first version looked for
    // `top.symbols`, which exists in no tbd version — so a v2 stub parsed
    // cleanly and reported zero symbols, with nothing in the answer to say the
    // file had been read and not understood. That is the one answer this reader
    // must never give about a file it read successfully.
    if (exports.length === 0) {
      const triples =
        top.targets && typeof top.targets === 'object' && !Array.isArray(top.targets) ? top.targets : null;
      if (triples) {
        for (const [triple, body] of Object.entries(triples)) {
          if (!body || typeof body !== 'object') continue;
          exports.push({
            // The triple carries a vendor and an OS version; neither is an
            // architecture, and keeping them would make `arm64-apple-macos10.4`
            // and `arm64-apple-macos14.0` two architectures.
            targets: [triple.replace(/-apple-.*$/, '')],
            symbols: namesUnder(body.symbols, true),
            objcClasses: namesUnder(body['objc-classes']),
            objcIvars: namesUnder(body['objc-ivars']),
            objcEhTypes: namesUnder(body['objc-eh-types']),
            weakSymbols: namesUnder(body['weak-symbols'], true),
            threadLocalSymbols: namesUnder(body['thread-local-symbols'], true),
          });
        }
      } else if (top.symbols) {
        exports.push({
          targets,
          symbols: namesUnder(top.symbols, true),
          objcClasses: [],
          objcIvars: [],
          objcEhTypes: [],
          weakSymbols: [],
          threadLocalSymbols: [],
        });
      }
    }

    // v2 spells this `re-exports:` — a plain list of install names, nested under
    // the triple. v4 nests it under `reexported-libraries:`. Both spellings are
    // real, and a reader knowing only the new one reports a v2 re-export as none.
    const v2Reexports = Object.values(
      top.targets && typeof top.targets === 'object' && !Array.isArray(top.targets) ? top.targets : {},
    )
      .filter((b) => b && typeof b === 'object')
      .map((b) => b['re-exports']);

    // Read the one field that holds the names, never the whole entry: an entry is
    // `{ targets, libraries }`, and walking it wholesale returns the target
    // triples as if they were libraries. libnetwork.tbd lists exactly one
    // re-exported library and this returned seven, all of them real strings from
    // the file — so the wrong answer was entirely plausible.
    const reexportedLibraries = dedupe([
      ...entriesFor(top['reexported-libraries'] ?? top['reexports-libraries'])
        .flatMap((e) => (e && typeof e === 'object' && !Array.isArray(e) ? namesUnder(e.libraries ?? e.library) : namesUnder(e))),
      ...(v2Reexports.length ? v2Reexports.flatMap((e) => namesUnder(e)) : []),
      ...(v2Reexports.length ? [] : namesUnder(top['re-exports'])),
    ]);

    const reexportedSymbols = dedupe(
      entriesFor(top.reexports).flatMap((e) =>
        e && typeof e === 'object' && !Array.isArray(e) ? namesUnder(e.symbols, true) : namesUnder(e, true),
      ),
    );
    const parentUmbrella = namesUnder(top['parent-umbrella']);
    const allowableClients = namesUnder(top['allowable-clients']);
    const flags = namesUnder(top.flags);

    // Anything this reader does not have a table for is kept, so a future key is
    // visible in the answer rather than absent from it.
    const known = new Set([
      'targets', 'install-name', 'current-version', 'compatibility-version',
      'swift-abi-version', 'tbd-version', 'exports', 'symbols', 'reexports',
      'reexported-libraries', 're-exports', 'parent-umbrella', 'allowable-clients', 'flags',
    ]);
    const other = {};
    for (const [k, v] of Object.entries(top)) if (!known.has(k)) other[k] = v;

    return {
      line: d.line,
      tbdVersion,
      installName: scalars['install-name'],
      currentVersion: scalars['current-version'],
      compatibilityVersion: scalars['compatibility-version'],
      swiftAbiVersion: scalars['swift-abi-version'],
      targets,
      flags,
      exports,
      objcClasses: dedupe(exports.flatMap((e) => e.objcClasses).concat(namesUnder(top['objc-classes']))),
      objcIvars: dedupe(exports.flatMap((e) => e.objcIvars)),
      objcEhTypes: dedupe(exports.flatMap((e) => e.objcEhTypes)),
      weakSymbols: dedupe(exports.flatMap((e) => e.weakSymbols)),
      threadLocalSymbols: dedupe(exports.flatMap((e) => e.threadLocalSymbols)),
      reexportedLibraries: dedupe(reexportedLibraries),
      reexportedSymbols: dedupe(reexportedSymbols),
      parentUmbrella: dedupe(parentUmbrella),
      allowableClients: dedupe(allowableClients),
      ...(Object.keys(other).length ? { other } : {}),
    };
  });

  const versions = [...new Set(out.map((d) => d.tbdVersion).filter((v) => v !== null && Number.isFinite(v)))];

  return { documents: out, unrecognised, versions, source };
}

const dedupe = (a) => [...new Set(a)];
/* ------------------------------------------------------------------ *
 * the shape a reader gets
 * ------------------------------------------------------------------ */


/**
 * Number the libraries, and nothing else.
 *
 * This used to re-derive the library shape from the parser's raw output. The
 * parser now interprets the tree itself — it has to, because the v2 and v4
 * shapes differ enough that only the code holding the tree can tell them apart —
 * so re-deriving the shape here produced a second, subtly different set of
 * fields. Two code paths for one shape is how the two come to disagree, and the
 * disagreement would be silent.
 */
function libraryOf(doc, index) {
  return { ...doc, index };
}

/**
 * Read a `.tbd` file.
 *
 * `unrecognised` is returned rather than thrown so the caller can decide, and the
 * CLI decides always: a stub with an unread line is not a stub with fewer symbols,
 * it is a stub whose symbol count is unknown, and saying "0 symbols" or "412
 * symbols" would both be inventions.
 */
export function readTbd(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw Object.assign(new Error(`${file}: cannot be read (${e.code === 'ENOENT' ? 'no such file' : e.code || 'unreadable'})`), {
      code: 'io',
    });
  }
  const stat = safeStat(file);
  const { documents, unrecognised, versions } = parseTbd(text, file);

  if (documents.length === 0) {
    // The presence of unrecognised lines must NOT gate this. A Mach-O passed in
    // place of a stub produces a parse in which nothing is recognised, so the
    // guard `unrecognised.length === 0 && documents.length === 0` was false and
    // the file fell through to the "a line I do not understand" report — telling
    // someone who handed over the wrong format that their stub was malformed.
    // Those are different problems and they need different messages: one is a
    // wrong file, the other is a parser gap.
    throw Object.assign(
      new Error(
        bytes(text) === 0
          ? `${file}: the file is empty, so it is not a tbd stub`
          : `${file}: not a tbd stub — no \`--- !tapi-tbd\` document header. A .tbd is text and a Mach-O is not, so this is the wrong kind of file for this tool; it reads stubs and not binaries.`,
      ),
      { code: 'unknown-encoding' },
    );
  }

  const libraries = documents.map(libraryOf);
  const allSymbols = dedupe(libraries.flatMap((l) => l.exports.flatMap((e) => e.symbols)));
  const allTargets = dedupe(libraries.flatMap((l) => l.targets));

  return {
    path: file,
    size: stat ? stat.size : null,
    tbdVersion: versions.length === 1 ? versions[0] : null,
    tbdVersions: versions.sort((a, b) => a - b),
    documentCount: libraries.length,
    // Only when there is exactly one library. A multi-document stub has no
    // single install name, and reporting the first document's as if it were the
    // file's would answer "which dylib is this?" with whichever one happened to
    // come first in the file.
    ...(libraries.length === 1 ? { installName: libraries[0].installName } : {}),
    libraries,
    targets: allTargets,
    symbols: allSymbols,
    symbolCount: allSymbols.length,
    objcClasses: dedupe(libraries.flatMap((l) => l.objcClasses)),
    weakSymbols: dedupe(libraries.flatMap((l) => l.weakSymbols)),
    reexportedLibraries: dedupe(libraries.flatMap((l) => l.reexportedLibraries)),
    unrecognised: unrecognised.map((u) => ({ line: u.line, why: u.why })),
  };
}

/** Byte length, used only to tell an empty file from a wrong-format one. */
function bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * queries
 * ------------------------------------------------------------------ */

/**
 * Which libraries in a stub export `name`, and for which targets.
 *
 * `exact` and `substring` are separate answers, not one answer with a flag. "Does
 * libSystem export `_pthread_mutex_lock`" and "what names containing
 * `pthread_mutex` are exported" are different questions, and a caller who asked
 * the second and got the first has been told nothing.
 */
export function findSymbol(stub, name, { mode = 'exact' } = {}) {
  const want = String(name);
  const hits = [];
  for (const lib of stub.libraries) {
    for (const ex of lib.exports) {
      for (const sym of ex.symbols) {
        const match = mode === 'exact' ? sym === want : sym.includes(want);
        if (!match) continue;
        hits.push({
          symbol: sym,
          library: lib.installName ?? `${stub.path}#document-${lib.index}`,
          document: lib.index,
          targets: ex.targets ?? lib.targets,
          weak: lib.weakSymbols.includes(sym),
          threadLocal: lib.threadLocalSymbols.includes(sym),
        });
      }
    }
    for (const sym of lib.reexportedSymbols) {
      const match = mode === 'exact' ? sym === want : sym.includes(want);
      if (!match) continue;
      hits.push({ symbol: sym, library: lib.installName ?? `${stub.path}#document-${lib.index}`, document: lib.index, targets: lib.targets, reexported: true });
    }
  }
  return hits;
}

/**
 * Walk an SDK and report which stubs export `name`.
 *
 * This is the question the whole tool exists to answer. Since macOS 11 there is no
 * `/usr/lib/libSystem.B.dylib` to run `nm` on — the file does not exist, the
 * code is in the shared cache — so "which library provides this symbol" is
 * answerable from the SDK's stubs and from nothing else on the machine.
 *
 * ## Symlinks are resolved, and that is not housekeeping
 *
 * **2,448 of the 5,309 stubs in the macOS 15.2 SDK are symlinks.** `libm.tbd` is
 * a link to `libSystem.tbd`; so are `libc.tbd`, `libpthread.tbd` and most of the
 * rest, because the SDK ships one comprehensive stub per *interface* umbrella and
 * points every name at it.
 *
 * Walking without resolving gives a correct-looking answer that is wrong in the
 * way that matters most: `_pthread_mutex_lock` would be reported as exported by 39
 * files, and a caller reasonably concludes there are 39 places to look. The
 * install-name is identical in all 39, so nothing in the output contradicts it.
 *
 * So paths are resolved to a real path and deduplicated on it. The canonical file
 * is reported and the aliases are counted, because "39 names, one file" is itself
 * the interesting fact: it is what tells you the SDK has no per-library symbol
 * granularity, only per-umbrella.
 */
export function findInSdk(root, name, { mode = 'exact', maxFiles = 0 } = {}) {
  const seen = new Map(); // realpath -> the first path that reached it
  let aliases = 0;

  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // The versioned directories (`MacOSX15.2.sdk`) hold the real stubs and the
        // unversioned name is a symlink to one of them. Descending into both would
        // read every stub twice.
        if (e.name.endsWith('.sdk')) continue;
        walk(p, depth + 1);
      } else if (e.name.endsWith('.tbd')) {
        let real;
        try {
          real = fs.realpathSync(p);
        } catch {
          real = p;
        }
        const prev = seen.get(real);
        if (prev) {
          aliases++;
          // Prefer the regular file over the link. Both name the same stub, so the
          // answer is the same either way — but reporting `libcompress.tbd` when
          // `libz.tbd` is the file on disk sends a reader to open a symlink to
          // learn something the file next to it already said. Alphabetical order
          // alone picks the link, because "libcompress" sorts before "libz".
          if (!e.isSymbolicLink() && prev.isLink) seen.set(real, { path: p, isLink: false });
          continue;
        }
        seen.set(real, { path: p, isLink: e.isSymbolicLink() });
      }
    }
  };
  walk(root, 0);

  const files = [...seen.values()].map((v) => v.path).sort();
  const limited = maxFiles > 0 ? files.slice(0, maxFiles) : files;

  const hits = [];
  let scanned = 0;
  let unreadable = 0;
  for (const f of limited) {
    scanned++;
    let stub;
    try {
      stub = readTbd(f);
    } catch {
      unreadable++;
      continue;
    }
    for (const h of findSymbol(stub, name, { mode })) {
      hits.push({ file: f, ...h });
    }
  }
  return {
    root,
    scanned,
    unreadable,
    stubs: files.length,
    aliasesSkipped: aliases,
    truncated: files.length > limited.length,
    hits,
  };
}