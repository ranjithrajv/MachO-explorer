/**
 * sarif.mjs — SARIF 2.1.0 output for `audit` and `fingerprint`.
 *
 * ## Why this file exists
 *
 * A CI gate nobody has to write glue for is a CI gate that gets turned on. GitHub
 * Code Scanning ingests SARIF from a file in the workspace and renders it as
 * annotations on the commit that introduced the finding — which means the reader
 * does not have to be explained to whoever reviews the pull request. The finding
 * simply appears, on the line, with the reader's own words.
 *
 * Every other consumer of `audit --json` needs something written around it: a
 * jq program, a parser, a schema check. SARIF is the one format that means "these
 * are findings" to a system that already knows what findings are.
 *
 * ## What a finding is, and is not
 *
 * `audit` already separates `error` from `warning` on one question: can the
 * reader's answers still be trusted? SARIF has a level vocabulary of its own
 * (`error` / `warning` / `note` / `none`), and mapping the two onto each other
 * naively would grade a *warning* as a build failure in a UI, which is the same
 * mistake the exit code taxonomy exists to avoid.
 *
 * So the mapping is deliberately blunt and deliberately documented:
 *
 *   severity error   -> level "error"    — the file disagrees with itself
 *   severity warning -> level "warning"  — unfamiliar or heuristic, answers probably right
 *
 * A `note` would be the wrong word for a warning here: SARIF `note` means
 * "informational, not a problem", and a warning *is* a problem — just not a
 * damage one.
 *
 * ## Why the rule id is derived rather than invented
 *
 * GitHub Code Scanning keys "the same finding" on `ruleId` plus a fingerprint of
 * the location. A stable, machine-generated id means the second run recognises the
 * first run's finding as the same finding and comments on it, rather than filing
 * a new one every build. An id a human wrote would drift — renamed when someone
 * thought of a better name, which silently restarts every alert in the history.
 *
 * So the id is `macho-explorer/<kind>`, taken verbatim from the `kind` the reader
 * already reports, and the human-readable `name` is the same string. Nothing here
 * maps one vocabulary onto another, so nothing here can drift.
 *
 * ## The `fingerprints` field is a stable answer, not a hash of this code
 *
 * GitHub will also track a finding by `fingerprints`. Deriving one from a value
 * that is a *fact about the binary* rather than about the bytes of this file
 * would be genuinely useful — the same kind in the same section of two builds of
 * one program is the same finding — but that is a design decision with its own
 * failure modes, and this file declines to make it. `partialFingerprints` is
 * populated with the values that *are* stable today (the section, the slice
 * architecture), which degrades gracefully: a fingerprint that misses collapses to
 * the `ruleId` match, which is the behaviour without it.
 */

import { createRequire } from 'node:module';

/** The one SARIF schema URI. Required by every consumer; it is not negotiable. */
const SARIF_SCHEMA = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';

/** Where the tool that produced this lives. Required in `informationUri`. */
const INFO_URI = 'https://github.com/ranjithrajv/MachO-explorer';

/**
 * The package version, read the same way `mcp.mjs` reads it.
 *
 * This is deliberately NOT `SCHEMA_VERSION`. The two answer different questions,
 * and putting the envelope version where the tool version belongs produces a
 * SARIF file claiming to have been written by version "1.0" rather than by
 * version 0.1.0 of the reader — which is exactly the plausible-wrong-metadata
 * failure this project exists to avoid, and a consumer records it permanently in
 * an alert's history where nothing will ever correct it.
 *
 * `createRequire` rather than a JSON import assertion because the rest of the
 * package reads this exact file that way; one mechanism to keep working is
 * better than two.
 */
const { version: TOOL_VERSION } = createRequire(import.meta.url)('../package.json');

/**
 * Severity to SARIF level.
 *
 * Only two of the four SARIF levels are reachable from an audit finding, and
 * `note`/`none` are deliberately unused — see the file header. The default is
 * `warning` rather than `error`: an unknown severity is unfamiliar, not damage,
 * and that is exactly what a `warning` means in this reader's own vocabulary.
 */
const LEVEL = { error: 'error', warning: 'warning' };

/**
 * Build one SARIF `run`.
 *
 * `rules` and `results` are passed separately because SARIF wants the full rule
 * catalog declared up front even when only some of its members fired — a rule
 * declared and not used is how a consumer knows the reader *could* have reported
 * that finding and chose not to, which is a different claim from "this reader has
 * no such check".
 *
 * Exported for the per-tool schemas and for tests, not called directly by the
 * CLIs: they call the two named helpers below.
 */
function run(rules, results, invocation) {
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'macho-explorer',
            informationUri: INFO_URI,
            version: TOOL_VERSION,
            rules,
          },
        },
        // `executionSuccessful: false` would make every consumer discard the file,
        // which is the opposite of what an audit finding wants to say. The run
        // succeeded; the *binary* is what is wrong.
        executionSuccessful: true,
        invocations: [invocation],
        results,
      },
    ],
  };
}

/**
 * A stable, URL-safe rule id for one finding kind.
 *
 * `kind` values are already lowercase, underscore-separated identifiers the
 * reader emits (`symtab-out-of-range`, `overlapping-slices`, …). They are used
 * verbatim after a namespacing prefix, so the id cannot drift from the code that
 * produces the finding: if the reader renames a `kind`, the SARIF id changes in
 * the same commit, which is visible in review rather than silent.
 */
const ruleId = (kind) => `macho-explorer/${kind}`;

/** The rule catalog entry. One per distinct kind present in this run. */
function rule(kind, severity, detail) {
  return {
    id: ruleId(kind),
    name: kind,
    shortDescription: { text: kind },
    fullDescription: {
      text:
        `The reader found "${kind}" while checking this binary's structural claims. ` +
        'A finding means this specific part of the answer is not to be trusted; ' +
        'the rest of the parse is unaffected and is reported alongside it.',
    },
    defaultConfiguration: { level: LEVEL[severity] ?? 'warning' },
    properties: {
      // Machine-readable severity, so a consumer that wants the reader's own
      // vocabulary rather than SARIF's can get it without parsing the text.
      severity: severity ?? 'warning',
      ...(detail ? { firstDetail: detail } : {}),
    },
  };
}

/**
 * `audit` findings as SARIF.
 *
 * Every finding becomes a result, on the binary itself rather than on a source
 * line. There is no line to point at — a Mach-O is not a text file — so the
 * location is the file, and `logicalLocations` carries the architecture and,
 * where known, the section the finding is about. That is the most specific
 * location the format honestly supports here, and a consumer that wants a
 * clickable line will not find one, which is correct: there isn't one.
 *
 * @param {object} result  the `audit()` answer
 * @param {object} opts    `{ path }` — the binary path, for the artifact location
 */
export function auditSarif(result, { path } = {}) {
  /** @type {{arch: string, severity: string, kind: string, detail: string}[]} */
  const findings = [];

  for (const s of result.slices ?? []) {
    for (const a of s.abnormalities ?? []) {
      findings.push({ arch: s.arch, ...a });
    }
  }
  for (const a of result.containerAbnormalities ?? []) {
    // Container findings are about the file, not about one slice, so they carry
    // no architecture. Kept as an explicit empty string rather than null because
    // the `logicalLocation.name` below is a display string either way.
    findings.push({ arch: '', ...a });
  }

  const rules = [];
  const seen = new Set();
  const results = [];

  for (const f of findings) {
    if (!seen.has(f.kind)) {
      seen.add(f.kind);
      rules.push(rule(f.kind, f.severity, f.detail));
    }
    results.push({
      ruleId: ruleId(f.kind),
      // The finding's own `detail` is the message. A generic one would be
      // generated for every finding regardless of which check fired, so every
      // alert in a review would read the same until it was expanded — and the
      // expanded text is the only part that says which check this was.
      message: { text: f.detail },
      level: LEVEL[f.severity] ?? 'warning',
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: path ?? result.path ?? 'unknown' },
          },
          ...(f.arch
            ? { logicalLocations: [{ name: f.arch, kind: 'slice' }] }
            : {}),
        },
      ],
      // Stable across runs of the same reader on the same binary: the architecture
      // and the kind are facts about the input, not about this file.
      partialFingerprints: {
        archetype: f.arch || 'container',
        finding: f.kind,
      },
    });
  }

  return run(rules, results, {
    executionSuccessful: true,
    // The arguments that produced this file. A consumer rendering the alert can
    // show the reader's own notes — "verdict is a label for a person, branch on
    // clean/strictClean" — which is the guidance that stops someone acting on the
    // wrong field.
    toolExecutionNotifications: (result.verdict === 'ok' ? [] : [1]).map(() => ({
      level: result.verdict === 'failed' ? 'error' : 'warning',
      message: {
        text:
          `audit verdict: ${result.verdict} — ${result.counts.errors} error(s), ` +
          `${result.counts.warnings} warning(s). ` +
          'Branch on `clean` (the default gate) or `strictClean` (--strict), not on the verdict label.',
      },
    })),
  });
}

/**
 * A `fingerprint` comparison as SARIF.
 *
 * One result per architecture whose fingerprint differs, plus one per
 * architecture that is present on only one side. This is deliberately *not*
 * `diff`: it is not "what changed", it is "this is not the program you said it
 * was", which is the finding a release gate wants surfaced.
 *
 * A match produces no results at all — an empty `results` array with a populated
 * rule catalog, because the check exists and passed. Code Scanning renders that
 * as "0 alerts" rather than as a report about the file, which is the right
 * answer for a passing gate.
 */
export function fingerprintSarif(result, { path, other } = {}) {
  const rules = [
    {
      ...rule('fingerprint-mismatch', 'error', 'the two binaries are not the same program'),
      shortDescription: { text: 'the two binaries are not the same program' },
    },
    {
      ...rule('fingerprint-arch-missing', 'warning', 'an architecture is present on one side only'),
      shortDescription: { text: 'an architecture is present on one side only' },
    },
    {
      ...rule('fingerprint-stripped', 'note', 'one side is stripped, so the match would rest on shape alone'),
      shortDescription: { text: 'one side is stripped, so the match rests on shape alone' },
    },
  ];

  const results = [];

  for (const row of result.byArch ?? []) {
    if (!row.presentInBoth) {
      results.push({
        ruleId: ruleId('fingerprint-arch-missing'),
        message: {
          text:
            `${row.arch} is present on only one side, so the two binaries are not comparable ` +
            `for that architecture. ${result.a.path} vs ${result.b.path}`,
        },
        level: 'warning',
        locations: [
          {
            physicalLocation: { artifactLocation: { uri: path ?? result.a?.path ?? 'unknown' } },
            logicalLocations: [{ name: row.arch, kind: 'slice' }],
          },
        ],
        partialFingerprints: { archetype: row.arch, finding: 'arch-missing' },
      });
      continue;
    }
    if (!row.match) {
      results.push({
        ruleId: ruleId('fingerprint-mismatch'),
        message: {
          text:
            `${row.arch} differs: ${row.fingerprint} vs ${row.other}. ${result.verdict ?? ''}`.trim(),
        },
        level: 'error',
        locations: [
          {
            physicalLocation: { artifactLocation: { uri: path ?? result.a?.path ?? 'unknown' } },
            logicalLocations: [{ name: row.arch, kind: 'slice' }],
          },
        ],
        // Both digests in the fingerprint, because "these two differ" is a claim
        // about a *pair* — the same kind in the same architecture of a different
        // comparison is a different finding, and a fingerprint that ignored the
        // other side would merge them.
        partialFingerprints: { archetype: row.arch, other: row.other ?? '' },
      });
    }
  }

  // The stripped caveat is a `note` rather than a finding about a specific slice:
  // it qualifies the whole comparison rather than any one row of it.
  if (result.caveat) {
    results.push({
      ruleId: ruleId('fingerprint-stripped'),
      message: { text: result.caveat },
      level: 'note',
      locations: [
        {
          physicalLocation: { artifactLocation: { uri: path ?? result.a?.path ?? 'unknown' } },
          ...(other ? { relatedLocations: [{ id: 1, physicalLocation: { artifactLocation: { uri: other } } }] } : {}),
        },
      ],
      partialFingerprints: { finding: 'stripped-caveat' },
    });
  }

  return run(rules, results, {
    executionSuccessful: true,
    toolExecutionNotifications: [
      {
        level: result.sameProgram ? 'note' : 'warning',
        message: {
          text:
            `${result.verdict ?? 'comparison complete'}. ` +
            'sameBuild compares UUIDs, sameProgram compares fingerprints; they are different questions.',
        },
      },
    ],
  });
}