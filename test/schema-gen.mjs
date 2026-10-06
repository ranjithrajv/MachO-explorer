#!/usr/bin/env node
/**
 * schema.mjs — generate and verify one JSON Schema per tool.
 *
 * ## Why one file per tool, when the envelope schema already exists
 *
 * `envelope.schema.json` pins the shape every consumer can rely on and nothing
 * else: `schemaVersion`, `tool`, `ok`, `binary`, `errors`, and an
 * *unconstrained* `data`. That is a deliberate choice and the right one — the
 * envelope is the part that has to stay identical across ten tools and two
 * doors, and constraining each tool's answer in one file would make that file a
 * second, worse copy of `src/api.d.ts`.
 *
 * But it leaves a real gap. A consumer that reads `audit`'s `data` and branches
 * on `data.counts.errors` has nothing to validate that field against, and a
 * rename that breaks it fails at runtime rather than at the point the rename
 * happens. The TypeScript declarations close that gap for a TypeScript consumer
 * and nothing else — a Python or Go consumer reading `--json` has no equivalent.
 *
 * So: one schema per tool, each a `$ref` to the envelope with `data` replaced by
 * the shape that tool actually returns. Composed, not duplicated — the envelope
 * constraints are imported from the one file that owns them, so tightening the
 * envelope tightens every tool at once and a tool schema cannot claim a different
 * contract for the part it shares.
 *
 * ## Why these are generated, and why that is checked
 *
 * A hand-maintained schema drifts from the code the moment a field is added, and
 * a schema that lies is worse than no schema: it rejects valid output, so the
 * consumer works around it, and the workaround is now a second description of
 * the shape.
 *
 * So `npm run schema:check` regenerates every file and fails if any byte differs
 * from what is checked in. The same discipline `fixtures --check` applies to the
 * binary corpus and `demo/link.mjs --check` applies to the browser bundle, applied
 * to the one artefact category that had none.
 *
 * The negative control matters as much as the check: there is a fixture with a
 * deliberately wrong shape, and the suite asserts the schema *rejects* it. A
 * validator that accepts everything would also pass every "does this validate?"
 * assertion above, and would be found by nobody.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'schema');

let pass = 0;
const fails = [];
const ok = (cond, label, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fails.push(`${label}${detail ? `  — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
};

/* ------------------------------------------------------------------ *
 * a validator, in about a hundred lines
 * ------------------------------------------------------------------ *
 *
 * A dependency would be easier and this package has none by design — that is the
 * product's central claim, and a JSON Schema validator is the single most likely
 * dependency to appear by accident in a package whose pitch is "zero
 * dependencies". So this is a subset validator covering exactly the keywords
 * these schemas use, and it says so at every keyword it does not support rather
 * than ignoring it.
 *
 * **A keyword this validator does not know is an error, not a no-op.** That is the
 * important design decision and it is the opposite of a normal validator's: a
 * JSON Schema that says `minProperties: 3` and a validator that silently ignores
 * it will both report success on a document with one property. The check is meant
 * to catch a schema that stopped constraining something, and a validator that
 * shrugs is exactly how that goes unnoticed. So an unknown keyword fails loudly,
 * which means adding a keyword to a schema here also means adding it here — and
 * that is the point.
 */
const KNOWN = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', 'examples', 'default',
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'pattern', 'patternProperties', 'minItems', 'maxItems',
  'minimum', 'maximum', 'minLength', 'maxLength', 'anyOf', 'oneOf', 'allOf',
  'not', 'propertyNames', 'minProperties', 'maxProperties', 'uniqueItems',
]);

function validate(schema, value, path = '$', root = schema) {
  const errors = [];

  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k)) {
      errors.push(`${path}: schema uses unsupported keyword "${k}" — add it to KNOWN or the constraint is silently unenforced`);
    }
  }

  // $ref: only local, only to "#/..." — the envelope is composed, not bundled, so
  // a consumer resolves the whole tree from the schema directory. A remote $ref
  // would make these files need a network to validate, which is the opposite of
  // the point of a zero-dependency tool.
  //
  // Resolved against the *schema under test* (`root`), not a global. That is
  // deliberate and is itself under test: resolving against a shared global would
  // let a schema validate by referencing a definition it does not ship, which is
  // exactly the failure a consumer hits when they copy one file out of the
  // directory.
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) {
      errors.push(`${path}: only local $ref is supported, got "${schema.$ref}"`);
      return errors;
    }
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) errors.push(`${path}: $ref "${schema.$ref}" does not resolve`);
    else errors.push(...validate(resolved, value, path, root));
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.includes(actual)) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${actual}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) errors.push(`${path}: items are not unique`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`, root)));
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!Object.hasOwn(props, k)) errors.push(`${path}: unexpected property "${k}"`);
      }
    }
    if (schema.patternProperties) {
      for (const [re, sub] of Object.entries(schema.patternProperties)) {
        for (const k of Object.keys(value)) {
          if (new RegExp(re).test(k)) errors.push(...validate(sub, value[k], `${path}.${k}`, root));
        }
      }
    }
    if (schema.propertyNames) {
      for (const k of Object.keys(value)) errors.push(...validate(schema.propertyNames, k, `${path} property name`, root));
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path}: fewer than minProperties ${schema.minProperties}`);
    }
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) {
      errors.push(`${path}: more than maxProperties ${schema.maxProperties}`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) errors.push(...validate(sub, value[k], `${path}.${k}`, root));
    }
  }

  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => validate(s, value, path, root).length === 0)) {
    errors.push(`${path}: matches none of the anyOf alternatives`);
  }
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter((s) => validate(s, value, path, root).length === 0).length;
    if (n !== 1) errors.push(`${path}: matched ${n} oneOf alternatives, expected exactly 1`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const s of schema.allOf) errors.push(...validate(s, value, path, root));
  }
  if (schema.not && validate(schema.not, value, path, root).length === 0) {
    errors.push(`${path}: matched a schema it must not match`);
  }

  return errors;
}

/** Resolve `#/a/b/c` against the composed root. */
function resolveRef(ref, root) {
  let node = root;
  for (const seg of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return null;
    node = node[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node || null;
}

const typeOf = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v;

/* ------------------------------------------------------------------ *
 * the building blocks every tool schema shares
 * ------------------------------------------------------------------ */

/** A hex address string. The pattern is the point — see `output.mjs` on 2^53. */
const ADDRESS = {
  type: 'string',
  pattern: '^0x[0-9a-fA-F]+$',
  description: 'A virtual address as a hex string with an 0x prefix. Never a number: a 64-bit address does not survive one.',
};

const COUNT = { type: 'integer', minimum: 0 };
const ARCH = { type: 'string', minLength: 1 };

const SEVERITY = {
  type: 'string',
  enum: ['error', 'warning'],
  description: 'error — the file disagrees with itself, so addresses computed from it may be wrong. warning — it parsed; something is unfamiliar or heuristic.',
};

const FINDING = {
  type: 'object',
  required: ['severity', 'kind', 'detail'],
  properties: {
    severity: SEVERITY,
    kind: { type: 'string', minLength: 1, description: 'A stable identifier for the check that fired. This is the string SARIF uses as its rule id, so it must not be renamed lightly.' },
    detail: { type: 'string', minLength: 1, description: 'The finding in prose, naming the numbers that produced it.' },
  },
};

/* ------------------------------------------------------------------ *
 * the per-tool `data` shapes
 * ------------------------------------------------------------------ *
 *
 * Every one of these is derived from what the corresponding function in
 * `src/api.mjs` returns, which is asserted separately by `test/types.mjs`. Two
 * assertions over the same code from different directions, which is the point:
 * one catches the schema drifting from the code, the other catches the declared
 * TypeScript drifting from the code.
 *
 * `additionalProperties` is deliberately NOT set to false on the inner objects.
 * The reader will grow fields, and a schema that rejects an unrecognised field
 * forces every consumer to pin a version before a bug fix lands. The *envelope*
 * is closed — that is the contract — while `data` is open, so an added field is
 * ignorable, exactly as `SCHEMA_VERSION`'s own documentation requires.
 */
const DATA = {
  describe: {
    type: 'object',
    required: ['slices', 'size', 'fat'],
    properties: {
      slices: { type: 'array', items: { $ref: '#/$defs/slice' } },
      size: { type: 'integer', minimum: 0 },
      fat: { type: 'boolean', description: 'True for a universal binary with more than one architecture.' },
      thin: { type: 'boolean' },
    },
  },

overview: {
    type: 'object',
    // `notRead` is required, and that is the point. It is the reason this tool
    // exists on the agent surface in this shape: an agent that gets structure and
    // two inventories in one call must learn, in that same call, what it did not
    // get. Making it optional would let a consumer read its absence as "this
    // package parses everything" — which is the one inference this project exists
    // to prevent.
    required: ['path', 'size', 'fat', 'slices', 'containerAbnormalities', 'notRead'],
    properties: {
      path: { type: 'string' },
      size: COUNT,
      fat: { type: 'boolean' },
      slices: { type: 'array', items: { $ref: '#/$defs/slice' } },
      containerAbnormalities: { type: 'array', items: FINDING },
      notRead: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description: 'What this package does not parse. Present in every answer, not only on request, so an absent field is evidence rather than silence.',
      },
      symbols: { type: 'object', properties: {
        arch: ARCH,
        count: COUNT,
        defined: COUNT,
        imports: COUNT,
        truncated: { type: 'boolean', description: 'More matched than `max` allowed. The count stays exact.' },
        max: COUNT,
        symbols: { type: 'array', items: { type: 'object', required: ['name', 'addr'], properties: { name: { type: 'string' }, addr: ADDRESS } } },
        note: { type: ['string', 'null'] },
      } },
      strings: { type: 'object', properties: {
        arch: ARCH,
        min: { type: 'integer', minimum: 0 },
        count: COUNT,
        scanned: COUNT,
        truncated: { type: 'boolean' },
        max: COUNT,
        sections: { type: 'array', items: { type: 'string' } },
        strings: { type: 'array', items: { type: 'object', required: ['vaddr'], properties: {
          vaddr: ADDRESS, section: { type: 'string' }, text: { type: 'string' },
        } } },
        note: { type: ['string', 'null'] },
      } },
    },
  },

  tbd: {
    type: 'object',
    // No field is required, because the four queries return four different shapes:
    // a summary, a symbol list, a symbol match, and an SDK sweep. A schema that
    // demanded the union of all four would be describing none of them, and a
    // validator that rejects correct output is worse than no validator — the
    // consumer works around it, and the workaround becomes a second description
    // of the shape.
    //
    // What *is* constrained is the part a consumer branches on. `matchCount` and
    // `symbolCount` are the precise signals a caller needs, and both are pinned to
    // non-negative integers so "found nothing" cannot be spelled some other way.
    properties: {
      // -- the summary --
      path: { type: 'string', description: 'The stub that was read.' },
      size: COUNT,
      tbdVersion: { type: ['integer', 'null'], description: 'The stub format version, when the file states exactly one. Null for a file whose documents disagree.' },
      tbdVersions: { type: 'array', items: { type: 'integer' } },
      documentCount: COUNT,
      installName: { type: 'string', description: 'Present only when the file holds exactly one library. A multi-library stub has no single install name, and reporting the first document\'s as if it were the file\'s would answer "which dylib is this" with whichever came first.' },
      targets: { type: 'array', items: { type: 'string' } },
      symbolCount: COUNT,
      objcClassCount: COUNT,
      weakSymbolCount: COUNT,
      reexportedLibraryCount: COUNT,
      reexportedLibraries: { type: 'array', items: { type: 'string' } },
      reexportedSymbols: { type: 'array', items: { type: 'string' } },
      reexportedSymbolCount: COUNT,
      libraries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: COUNT,
            installName: { type: ['string', 'null'] },
            targets: { type: 'array', items: { type: 'string' } },
            currentVersion: { type: ['string', 'null'] },
            compatibilityVersion: { type: ['string', 'null'] },
            swiftAbiVersion: { type: ['string', 'null'] },
            flags: { type: 'array', items: { type: 'string' } },
            symbolCount: COUNT,
            objcClassCount: COUNT,
            reexportedLibraries: { type: 'array', items: { type: 'string' } },
          },
        },
      },

      // -- --symbols --
      symbols: { type: 'array', items: { type: 'string' }, description: 'Exported symbol names. A name, not a hex address — a stub describes the linker\'s view, so there are no addresses in it.' },
      truncated: { type: 'boolean', description: 'More names matched than --max allowed. symbolCount stays exact.' },
      weakSymbols: { type: 'array', items: { type: 'string' } },

      // -- --symbol --
      query: { type: 'string' },
      mode: { type: 'string', enum: ['exact', 'substring'] },
      matchCount: COUNT,
      // Install names of the libraries that export the name, as strings. Named
      // `providers` rather than `libraries` because the summary's `libraries` is
      // a list of objects — one field cannot be both, and a schema that permits
      // both is a schema that permits a consumer to read the wrong one.
      providers: { type: 'array', items: { type: 'string' } },
      providerCount: COUNT,
      reexported: { type: 'boolean', description: 'Every match is a re-export rather than an implementation. This library passes the name through from somewhere else.' },
      weak: { type: 'boolean' },
      hits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            library: { type: 'string', description: 'The install name of the document that exports it — not the file, which may hold 39 libraries.' },
            document: COUNT,
            targets: { type: 'array', items: { type: 'string' } },
            weak: { type: 'boolean' },
            threadLocal: { type: 'boolean' },
            reexported: { type: 'boolean' },
            file: { type: 'string', description: 'Present for an SDK sweep.' },
          },
        },
      },

      // -- --sdk --
      providerCount: COUNT,
      scanned: COUNT,
      stubs: COUNT,
      aliasesSkipped: COUNT,
      unreadable: COUNT,
      symbolCount: COUNT,
    },
  },

  sym: {
    type: 'object',
    required: ['matches', 'count', 'arch', 'mode', 'pattern'],
    properties: {
      mode: { type: 'string', enum: ['substring', 'regex'] },
      pattern: { type: 'string' },
      // Null rather than absent when unset. `flags` is the regex-flag string and
      // a substring search has none — `null` says "no flags because this was not
      // a regex", which an omitted key would not distinguish from "flags were
      // omitted by mistake".
      flags: { type: ['string', 'null'] },
      arch: ARCH,
      deduped: { type: 'boolean' },
      definedOnly: { type: 'boolean' },
      defined: COUNT,
      total: COUNT,
      matches: { type: 'array', items: { type: 'object', required: ['name', 'addr'], properties: { name: { type: 'string' }, addr: ADDRESS, defined: { type: 'boolean' } } } },
      count: COUNT,
      uniqueCount: COUNT,
      truncated: { type: 'boolean' },
      note: { type: ['string', 'null'], description: 'Set when there is nothing to search — a stripped binary. A reason, not a failure.' },
    },
  },

  symlookup: {
    type: 'object',
    required: ['queries'],
    properties: {
      // Every address field here is nullable and all of them are null together,
      // when no symbol covers the address. That is the answer for a crash-log
      // address in a stripped binary, and it must be expressible rather than
      // forcing a consumer to treat "absent" as "not searched".
      queries: { type: 'array', items: { type: 'object', required: ['vaddr'], properties: {
        arch: ARCH,
        vaddr: ADDRESS,
        function: { type: ['string', 'null'] },
        start: { type: ['string', 'null'] },
        next: { type: ['string', 'null'] },
        offset: { type: ['string', 'null'] },
        size: { type: ['string', 'null'] },
        aliases: { type: ['array', 'null'], items: { type: 'string' } },
        note: { type: ['string', 'null'] },
      } } },
    },
  },

  starts: {
    type: 'object',
    required: ['functions', 'count', 'present'],
    properties: {
      base: { type: ['string', 'null'], description: 'The __TEXT vmaddr the deltas are relative to. Null when there is no blob to be relative to.' },
      present: { type: 'boolean', description: 'False when the file carries no LC_FUNCTION_STARTS. An answer, not an empty list.' },
      functions: { type: 'array', items: { type: 'object', required: ['address', 'label'], properties: { address: ADDRESS, label: { type: 'string' }, symbol: { type: ['string', 'null'] } } } },
      count: COUNT,
      named: { type: ['integer', 'null'], minimum: 0 },
      blobTruncated: { type: 'boolean' },
      capped: { type: 'boolean' },
    },
  },

  findcall: {
    type: 'object',
    properties: {
      // `listing` is ours, not the reader's: the CLI distinguishes the two modes
      // by which flag was given, and a model needs the same thing as a field,
      // because both modes otherwise share a shape closely enough to be misread.
      listing: { type: 'boolean' },
      target: ADDRESS,
      hits: { type: 'array', items: { type: 'object', required: ['addr'], properties: { addr: ADDRESS, kind: { type: 'string' }, section: { type: 'string' }, slice: ARCH } } },
      count: COUNT,
      scanned: COUNT,
      unsupported: { type: 'array', items: ARCH },
      unreadable: { type: 'boolean', description: 'The slice is encrypted, so the scan did not run. A zero here is NOT an answer.' },
      targets: { type: 'array', items: { type: 'object', required: ['dest'], properties: { dest: ADDRESS, sites: COUNT } } },
      total: COUNT,
      slices: { type: 'array' },
    },
  },

  findliteral: {
    type: 'object',
    properties: {
      // Two modes, one shape. `strings: true` produces `strings[]`; a literal
      // search produces `hits[]`. Requiring one or the other is what stops a
      // consumer reading `hits` on a string listing and concluding the file has
      // no occurrences of anything.
      anyOf: [{ required: ['hits'] }, { required: ['strings'] }],
      literal: { type: 'string' },
      hex: { type: 'string' },
      scanned: COUNT,
      arch: { type: ['string', 'null'] },
      archHonoured: { type: ['boolean', 'null'] },
      archRead: { type: 'array', items: ARCH },
      hits: { type: 'array', items: { type: 'object', required: ['off', 'vaddr'], properties: {
        off: COUNT, vaddr: ADDRESS, section: { type: 'string' }, slice: ARCH, inText: { type: 'boolean' },
        context: { type: 'object', properties: { pre: { type: 'string' }, hit: { type: 'string' } } },
      } } },
      strings: { type: 'array', items: { type: 'object', required: ['vaddr'], properties: { vaddr: ADDRESS, section: { type: 'string' }, text: { type: 'string' } } } },
      sections: { type: 'array', items: { type: 'string' } },
      min: { type: 'integer', minimum: 0 },
      count: COUNT,
      truncated: { type: 'boolean' },
      searchedCiphertext: { type: 'array', items: { type: 'string' } },
      encryptedSections: { type: 'array', items: { type: 'string' } },
    },
  },

  mapliteral: {
    type: 'object',
    required: ['locations', 'arch'],
    properties: {
      arch: ARCH,
      sliceOffset: COUNT,
      explicit: { type: 'boolean', description: 'True when offsets were passed rather than searched for.' },
      locations: { type: 'array', items: { type: 'object', required: ['off', 'vaddr'], properties: {
        off: COUNT, vaddr: ADDRESS, section: { type: 'string' }, context: { type: 'object' },
        pointerCount: COUNT, pointers: { type: 'array', items: { type: 'object', properties: { off: COUNT, vaddr: ADDRESS, section: { type: 'string' } } } },
        pointersTruncated: { type: 'boolean' },
      } } },
      unmapped: { type: 'array', items: { type: 'object', required: ['off'], properties: { off: COUNT } } },
    },
  },

  a2o: {
    type: 'object',
    required: ['queries', 'asked', 'resolved', 'zerofill', 'unmapped'],
    properties: {
      // Three outcomes kept distinct, because conflating the last two is what
      // sends a patch script to the wrong place: an offset (mapped, byte exists),
      // zerofill (mapped, no byte), and not-mapped (in no slice).
      queries: { type: 'array', items: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' }, offset: { type: ['integer', 'null'], minimum: 0 }, absoluteOffset: { type: ['integer', 'null'], minimum: 0 },
        vaddr: { type: ['string', 'null'] }, section: { type: ['string', 'null'] }, mapped: { type: 'boolean' },
        zerofill: { type: 'boolean' }, ambiguous: { type: 'boolean' }, note: { type: ['string', 'null'] }, slices: { type: 'array' },
      } } },
      asked: COUNT, resolved: COUNT, zerofill: COUNT, unmapped: COUNT,
    },
  },

  o2a: {
    type: 'object',
    required: ['queries', 'asked', 'resolved'],
    properties: {
      queries: { type: 'array', items: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' }, vaddr: { type: ['string', 'null'] }, offset: { type: ['integer', 'null'], minimum: 0 },
        mapped: { type: 'boolean' }, ambiguous: { type: 'boolean' }, note: { type: 'string' }, slices: { type: 'array' },
      } } },
      asked: COUNT, resolved: COUNT,
    },
  },

  dump: {
    type: 'object',
    required: ['vaddr', 'found', 'mapped', 'zerofill'],
    properties: {
      vaddr: ADDRESS,
      found: { type: 'boolean', description: 'False for both zero-fill and unmapped — neither has a byte to read.' },
      mapped: { type: 'boolean' },
      zerofill: { type: 'boolean' },
      section: { type: ['string', 'null'] },
      offset: { type: ['integer', 'null'], minimum: 0 },
      absoluteOffset: { type: ['integer', 'null'], minimum: 0 },
      bytes: { type: ['integer', 'null'], minimum: 0 },
      requestedBytes: COUNT,
      truncated: { type: 'boolean', description: 'The request outran the section that maps the address.' },
      lines: { type: 'array', items: { type: 'object', properties: { vaddr: ADDRESS, hex: { type: 'string' }, ascii: { type: 'string' } } } },
    },
  },

  audit: {
    type: 'object',
    required: ['verdict', 'clean', 'strictClean', 'counts', 'slices', 'containerAbnormalities'],
    properties: {
      path: { type: 'string' },
      // Three-valued, for a human.
      verdict: { type: 'string', enum: ['ok', 'warnings', 'failed'] },
      // Two-valued, for a gate. The exit status follows these, NOT `verdict`:
      // `verdict: 'warnings'` with `clean: true` is a *passing* audit, and a
      // consumer that maps the label onto the status fails a build over a binary
      // the reader says is fine.
      clean: { type: 'boolean', description: 'The gate without --strict: true when there are no error-severity findings.' },
      strictClean: { type: 'boolean', description: 'The gate with --strict: false when there are any findings at all.' },
      counts: { type: 'object', required: ['errors', 'warnings'], properties: { errors: COUNT, warnings: COUNT } },
      findings: { type: 'array', items: FINDING },
      slices: { type: 'array', items: { type: 'object', required: ['arch', 'abnormalities'], properties: { arch: ARCH, abnormalities: { type: 'array', items: FINDING } } } },
      containerAbnormalities: { type: 'array', items: FINDING, description: 'Findings about the fat container itself, which no per-slice check can see.' },
    },
  },

  fingerprint: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      size: COUNT,
      fat: { type: 'boolean' },
      fingerprint: { type: 'string' },
      // `structure-only` means the binary is stripped, so a match would rest on
      // section and load-command shape alone: a real claim, and a weaker one.
      tier: { type: 'string', enum: ['full', 'structure-only'] },
      uuid: { type: ['string', 'null'] },
      slices: { type: 'array' },
      // Two-binary shape. `a`/`b` are whole one-file answers.
      a: { $ref: '#/$defs/fingerprintSide' },
      b: { $ref: '#/$defs/fingerprintSide' },
      byArch: { type: 'array', items: { type: 'object', required: ['arch', 'match', 'presentInBoth'], properties: {
        arch: ARCH, fingerprint: { type: 'string' }, other: { type: 'string' }, match: { type: 'boolean' }, presentInBoth: { type: 'boolean' },
      } } },
      verdict: { type: 'string' },
      // Present only when one side is stripped, which is exactly when it matters.
      // An absent caveat and an absent `false` would be the same document to a
      // consumer, and they mean opposite things: "the match is full" versus "there
      // is no caveat on this one".
      caveat: { type: ['string', 'null'] },
      comparable: { type: 'boolean', description: 'False when the two sides share no architecture and could not be compared at all.' },
      // Three different questions, and collapsing them loses the one the caller
      // meant. `sameBuild` is UUIDs; `sameProgram` is the fingerprint; `rebuilt`
      // is true only when two *differing* UUIDs prove a rebuild happened.
      sameBuild: { type: ['boolean', 'null'] },
      sameProgram: { type: ['boolean', 'null'] },
      rebuilt: { type: ['boolean', 'null'] },
    },
  },

  diff: {
    type: 'object',
    required: ['verdict', 'counts', 'perArch', 'differences', 'buildMetadata', 'sizeChanges'],
    properties: {
      // `a` and `b` are whole fingerprint *answers*, not path strings — each
      // carries its own `path`, `size`, `slices` and digests. Typing them as
      // strings was the first draft's mistake, and it rejected every real
      // `diff` output for the same reason the segment sizes did: the shape was
      // taken from a prose description rather than from what the function
      // returns. It is now a `$ref` to the shared `fingerprintSide` so the two
      // tools cannot disagree about it.
      a: { $ref: '#/$defs/fingerprintSide' },
      b: { $ref: '#/$defs/fingerprintSide' },
      // The second path as a plain string, kept because a consumer that only
      // wants "what was it compared against" should not have to reach into
      // `a`/`b` for a field that is right there.
      other: { type: 'string' },
      verdict: { type: 'string' },
      // Three lists, and only the first decides the verdict. A UUID change or a
      // section-size change is a fact about a *build*; a changed literal string is
      // a change to the *program*, because strings do not move on a rebuild.
      counts: { type: 'object', required: ['differences'], properties: { differences: COUNT, buildMetadata: COUNT, sizeChanges: COUNT } },
      perArch: { type: 'array' },
      differences: { type: 'array', items: { type: 'object', required: ['category', 'detail'], properties: { category: { type: 'string' }, detail: { type: 'string' } } } },
      buildMetadata: { type: 'array', items: { type: 'object', properties: { detail: { type: 'string' } } } },
      sizeChanges: { type: 'array' },
      sameBuild: { type: ['boolean', 'null'] },
      sameShape: { type: ['boolean', 'null'] },
    },
  },

  assert: {
    type: 'object',
    required: ['passed', 'count', 'failed', 'assertions'],
    properties: {
      // A failed assertion is an *answer*, not an error. `errors` stays empty and
      // `passed` is the verdict, which is why this tool's ok:true-with-a-false-
      // verdict is a real shape and not a contradiction.
      passed: { type: 'boolean' },
      count: COUNT,
      failed: COUNT,
      assertions: { type: 'array', items: { type: 'object', required: ['kind', 'value', 'pass'], properties: {
        kind: { type: 'string', enum: ['has-symbol', 'no-symbol', 'has-string', 'no-string'] },
        value: { type: 'string' },
        // has-symbol/no-symbol match the WHOLE name — a policy names a symbol, and
        // a substring would pass on _main_helper when asked about _main.
        // has-string/no-string match a SUBSTRING, because the useful claim is
        // that a URL or an error message is present.
        pass: { type: 'boolean' },
        detail: { type: 'string' },
      } } },
    },
  },
};

/**
 * One side of a comparison: the whole one-file `fingerprint` answer.
 *
 * Shared by `fingerprint`'s two-binary shape and `diff`'s `a`/`b`, because they
 * are the same value produced by the same function. Two definitions of it would
 * be free to drift, and the drift would be invisible until a consumer relied on
 * the one that was wrong.
 *
 * Declared here rather than beside `DATA` because `DATA` is a map from tool name
 * to a `data` shape and this is a `$defs` entry — it is reached through a `$ref`,
 * not composed into a tool directly.
 */
const FINGERPRINT_SIDE = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string' },
    size: COUNT,
    fat: { type: 'boolean' },
    fingerprint: { type: ['string', 'null'] },
    uuid: { type: ['string', 'null'] },
    tier: { type: ['string', 'null'], enum: ['full', 'structure-only', null] },
    slices: { type: 'array', items: { type: 'object', properties: {
      arch: ARCH, fingerprint: { type: 'string' }, structure: { type: 'string' }, symbols: { type: 'string' },
      tier: { type: 'string' }, nsyms: COUNT, nsects: COUNT, ncmds: COUNT, uuid: { type: ['string', 'null'] },
    } } },
  },
};

/** The slice shape `describe` returns, shared by every schema that names one. */
const SLICE = {
  type: 'object',
  required: ['arch'],
  properties: {
    arch: ARCH,
    bits: { type: 'integer', enum: [32, 64] },
    readable: { type: 'boolean' },
    // Nullable, and this is not a hedge. A thin binary has no `platformName`
    // because the platform is in the header rather than in a build-version
    // command, and `note` is set only when a slice failed to parse. Declaring
    // them as plain strings makes the schema reject the majority of real output,
    // which is worse than no schema: a consumer that works around a schema that
    // rejects valid data stops reading it.
    note: { type: ['string', 'null'] },
    platformName: { type: ['string', 'null'] },
    filetypeName: { type: ['string', 'null'] },
    // A *file offset* — a position in the file, not an address — so a plain
    // integer. This distinction is load-bearing and `a2o`'s schema says so
    // twice: `offset` is a number because it is counted from the start of the
    // file, and `vaddr` is a hex string because 2^53 is reachable in it.
    offset: COUNT,
    size: COUNT,
    thin: { type: 'boolean' },
    nsyms: COUNT,
    defined: COUNT,
    textAddr: { type: ['string', 'null'] },
    textSize: COUNT,
    codeSections: COUNT,
    uuid: { type: ['string', 'null'] },
    // Nullable, and load-bearing: a binary with no `LC_ENCRYPTION_INFO_64` has
    // no cryptid, and `encrypted: null` is a *different claim* from
    // `encrypted: false`. The first means "this file makes no encryption claim",
    // the second means "this file claims to be unencrypted" — and conflating them
    // would report an App Store build's `__TEXT` as readable because it is not
    // encrypted, when the right answer is that nothing was said.
    encrypted: { type: ['boolean', 'null'] },
    cryptid: { type: ['integer', 'null'] },
    flagsNamed: { type: 'array', items: { type: 'string' } },
    flagsUnknown: { type: ['integer', 'null'], minimum: 0 },
    // Segment extents are all hex strings. `vmsize` and `filesize` being
    // addresses-derived is why: they are computed as `vmaddr + size` through
    // BigInt arithmetic and rendered by the same `toJSON` replacer that converts
    // addresses, so a schema that types them as integers rejects every real
    // `describe` output. That is the mistake this file made first and the reason
    // it now derives shapes from real output rather than from the reader's prose.
    segments: { type: 'array', items: { type: 'object', required: ['segname'], properties: {
      segname: { type: 'string' },
      vmaddr: ADDRESS,
      vmsize: ADDRESS,
      fileoff: ADDRESS,
      filesize: ADDRESS,
      maxprot: { type: 'integer' },
      initprot: { type: 'integer' },
      flags: { type: 'integer' },
    } } },
    sections: { type: 'array', items: { type: 'object', required: ['sectname'], properties: {
      segname: { type: 'string' },
      sectname: { type: 'string' },
      addr: ADDRESS,
      size: COUNT,
      offset: { type: 'integer', minimum: 0, description: 'A file offset, not an address.' },
      align: { type: 'integer', minimum: 0 },
      reloff: COUNT,
      nreloc: COUNT,
      flags: { type: 'integer' },
      type: { type: ['string', 'null'] },
      typeRaw: { type: ['integer', 'null'] },
      attributes: { type: 'array', items: { type: 'string' } },
    } } },
    loadCommands: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, cmdsize: COUNT } } },
    rpaths: { type: 'array', items: { type: 'string' } },
    dylibs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, linkage: { type: 'string' } } } },
    installName: { type: ['object', 'null'], properties: { name: { type: 'string' } } },
    buildVersion: { type: ['object', 'null'], properties: {
      platform: { type: ['string', 'null'] }, platformRaw: { type: 'integer' },
      minos: { type: 'object' }, sdk: { type: 'object' },
    } },
    sourceVersion: { type: ['object', 'null'], properties: { text: { type: 'string' } } },
    entryPoint: { type: ['object', 'null'], properties: {
      entryoff: COUNT,
      // Always null, and always will be: the reader derives no address from
      // LC_MAIN's entryoff because the header's "__TEXT offset" description does
      // not hold on real binaries. Schema'd as nullable-but-present so a consumer
      // reading it finds null and asks why, rather than finding the key absent
      // and assuming the binary has no entry point.
      vaddr: { type: ['string', 'null'] },
      note: { type: 'string' },
    } },
    encryption: { type: ['object', 'null'], properties: { cryptid: { type: 'integer' }, encrypted: { type: 'boolean' } } },
    filetype: { type: ['object', 'null'], properties: { name: { type: ['string', 'null'] }, raw: { type: 'integer' } } },
    // Reported ALONGSIDE a successful parse. Non-empty means those specific
    // parts are untrustworthy, not that the rest of the answer is void.
    abnormalities: { type: 'array', items: FINDING },
  },
};

/* ------------------------------------------------------------------ *
 * compose
 * ------------------------------------------------------------------ */

const envelope = JSON.parse(readFileSync(join(OUT, 'envelope.schema.json'), 'utf8'));

/**
 * Build one tool schema: the envelope, with `data` replaced.
 *
 * Composed rather than copied, so the envelope constraints — `additionalProperties:
 * false`, the reason-code enum, the version pattern — are enforced for every tool
 * from the one file that owns them. A tool schema that restated them would be free
 * to drift, and the drift would be invisible until a consumer relied on it.
 */
function compose(tool, data) {
  const base = JSON.parse(JSON.stringify(envelope));
  base.$id = `https://github.com/ranjithrajv/MachO-explorer/schema/${tool}.schema.json`;
  base.title = `MachO-explorer ${tool} — full response envelope`;
  base.description =
    `The response shape of the ${tool} tool, under \`--json\` from the CLI and in \`structuredContent\` over MCP. ` +
    'Composed from `envelope.schema.json` with `data` constrained to what this tool actually returns, so the ' +
    'envelope contract is enforced from the one file that owns it.\n\n' +
    'Addresses inside `data` are hex strings, never JSON numbers — a 64-bit address does not survive one. ' +
    '`data` is left open to new fields: an unrecognised key is ignorable, which is what lets a bug fix add one ' +
    'without a major version bump. The *envelope* is closed; `data` is not.';

  // The envelope's `data` was deliberately unconstrained. Narrow it, and only it.
  base.properties.data = { ...data, description: `The answer. Shape specific to \`${tool}\`. Null when ok is false.` };

  // `$defs` so a tool that names a shared shape refers to one definition rather
  // than inlining a second copy that could drift.
  base.$defs = { slice: SLICE, fingerprintSide: FINGERPRINT_SIDE };

  // Keep only the examples that are relevant: the envelope's `sym` examples on an
  // `audit` schema are documentation that teaches the wrong shape.
  base.examples = envelope.examples.filter((ex) => ex.tool === tool);

  return base;
}

// Each tool schema carries its own `$defs`, so a schema validates against the
// root it ships with — not a global — which is what makes "copy one file out of
// the directory" a thing that works.
console.log('schema generation');

const tools = Object.keys(DATA);
const generated = {};

for (const tool of tools) {
  const schema = compose(tool, DATA[tool]);
  generated[`${tool}.schema.json`] = schema;
  ok(!!schema.properties.data, `${tool}: has a constrained data shape`);
  ok(schema.additionalProperties === false, `${tool}: the envelope stays closed`);
  ok(schema.properties.schemaVersion?.pattern === '^[0-9]+\\.[0-9]+$', `${tool}: carries the envelope's version pattern`);
}

// `disasm` is in the CLI roster but its data is a list of decoded instructions
// whose shape is an open question — see the boundary note on mnemonics. It is
// documented here rather than omitted, because a tool with no schema is a tool a
// consumer cannot validate, and that should be a decision rather than an oversight.
generated['disasm.schema.json'] = compose('disasm', {
  type: 'object',
  required: ['slices', 'totals'],
  properties: {
    addr: { type: ['string', 'null'] },
    count: { type: 'integer', minimum: 0 },
    bytes: { type: 'integer', minimum: 0 },
    branchesOnly: { type: 'boolean' },
    slices: { type: 'array', items: { type: 'object', required: ['arch', 'instructions'], properties: {
      arch: ARCH,
      section: { type: 'string' },
      sectionAddr: ADDRESS,
      startAddr: ADDRESS,
      instructions: { type: 'array', items: { type: 'object', required: ['addr', 'bytes', 'length'], properties: {
        addr: ADDRESS,
        bytes: { type: 'string', description: 'Space-separated hex, e.g. "fd 7b bf a9". Bytes, not mnemonics — this is not a disassembler.' },
        length: { type: 'integer', minimum: 1 },
        kind: { type: 'string', description: 'Present only on a direct branch: BL, B, B.cond, CBZ, CBNZ, TBZ, TBNZ, ADR, ADRP, or call/jmp on x86_64.' },
        target: ADDRESS,
      } } },
      branches: { type: 'array', items: { type: 'object', required: ['source', 'target'], properties: { source: ADDRESS, target: ADDRESS, kind: { type: 'string' } } } },
      decoded: COUNT, bytesCovered: COUNT, bytesInRange: COUNT,
    } } },
    totals: { type: 'object', required: ['slices', 'instructions', 'branches'], properties: { slices: COUNT, instructions: COUNT, branches: COUNT } },
  },
});
ok(!!generated['disasm.schema.json'], 'disasm: has a documented data shape');

ok(generated['audit.schema.json'].properties.data.properties.strictClean !== undefined,
  'audit: strictClean is in the schema, because it is the gate');

// `--check` mode: the CI invocation. Fail rather than write, and say which file.
if (process.argv.includes('--check')) {
  console.log('');
  let drift = 0;
  for (const [name, schema] of Object.entries(generated)) {
    const path = join(OUT, name);
    let onDisk;
    try {
      onDisk = readFileSync(path, 'utf8');
    } catch {
      fails.push(`${name} is not on disk`);
      console.log(`  FAIL  ${name} is not on disk`);
      drift++;
      continue;
    }
    const want = JSON.stringify(schema, null, 2) + '\n';
    if (onDisk !== want) {
      console.log(`  FAIL  ${name} differs from the generated schema — run: npm run schema`);
      drift++;
    }
  }
  console.log('');
  if (drift) {
    console.log(`${pass} passed, ${drift} schema file(s) are stale.`);
    process.exit(1);
  }
  console.log(`${pass} passed. Every schema on disk matches what the code produces.`);
  process.exit(0);
}

// Write mode.
for (const [name, schema] of Object.entries(generated)) {
  writeFileSync(join(OUT, name), JSON.stringify(schema, null, 2) + '\n');
  console.log(`  wrote schema/${name}`);
}

export { validate, DATA, generated, tools, SEVERITY, ADDRESS };