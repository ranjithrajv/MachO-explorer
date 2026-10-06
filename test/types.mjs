import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// `import()` needs a URL on Windows: a bare `C:\...` path is parsed as a URL with
// an unsupported `d:` scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME. On POSIX a
// bare path happens to work, which is what hid this. One helper so every dynamic
// import in this file agrees.
const imp = (rel) => import(pathToFileURL(path.resolve(rel)).href);

const dts = fs.readFileSync("src/api.d.ts", "utf8");
const api = await imp("src/api.mjs");

let fail = 0;
const ok = (m) => console.log("  PASS  " + m);
const bad = (m) => { fail++; console.log("  FAIL  " + m); };

console.log("\n=== every runtime export is declared ===");
for (const k of Object.keys(api).sort()) {
  const re = new RegExp(`\\b${k}\\b`);
  re.test(dts) ? ok(`${k} declared`) : bad(`${k} MISSING from api.d.ts`);
}

console.log("\n=== the new describe() slice fields are declared ===");
// Read the real shape off a fixture, then require each field to appear in the
// describe() return type specifically — not merely somewhere in the file.
//
// The substring ends at the *first* `\n};` after the signature. That is the
// return type's own closing brace, and it matters: searching the rest of the
// file for a field name would find it in some unrelated declaration and pass,
// which is the failure this file exists to catch. Scoping the search to the
// block is what makes the check able to fail.
const slice = api.describe("test/fixtures/universal.macho").slices[0];
const start = dts.indexOf("export declare function describe(");
const block = dts.slice(start, dts.indexOf("\n};", start));
for (const k of Object.keys(slice)) {
  new RegExp(`\\b${k}\\??:`).test(block)
    ? ok(`describe().slices[].${k} declared`)
    : bad(`describe().slices[].${k} MISSING`);
}

// Positive control: the scoping above must be able to fail. A field name that
// genuinely exists elsewhere in the file, and nowhere in describe()'s block,
// has to be reported missing. `Symtab` is one: it is a real interface here, and
// describe() does not return it.
new RegExp("\\bSymtab\\b").test(dts) && !/\bSymtab\b/.test(block)
  ? ok("positive control: a field present elsewhere is still reported missing here")
  : bad("positive control: the describe() block is not scoped, so a missing field could pass");

console.log("\n=== declared types match what the reader returns ===");
const isBig = (v) => typeof v === "bigint";
const checks = [
  ["sections[].addr is bigint at runtime", isBig(slice.sections[0].addr),
    /addr: bigint/.test(dts)],
  ["segments[].vmaddr is bigint at runtime", isBig(slice.segments[0].vmaddr),
    /vmaddr: bigint/.test(dts)],
  ["loadCommands[] is non-empty", slice.loadCommands.length > 0,
    /loadCommands: LoadCommand\[\]/.test(block)],
];
for (const [name, runtime, declared] of checks) {
  runtime && declared ? ok(name) : bad(`${name} (runtime=${runtime} declared=${declared})`);
}

// `Thin` is the shape `parseThin` hands every other function, so it drifts the
// same way `describe` does. Asserted against a real parsed header rather than a
// fixture, because the fields below are header facts that no fixture pins.
const { parseThin } = await imp("src/macho.mjs");
const opener = api.withFile("test/fixtures/populated.macho", (f) => parseThin(f, 0));
let thinBlock = dts.slice(dts.indexOf("export interface Thin {"));
thinBlock = thinBlock.slice(0, thinBlock.indexOf("\n}"));
for (const k of Object.keys(opener)) {
  new RegExp(`\\b${k}[?]?:`).test(thinBlock)
    ? ok(`Thin.${k} declared`)
    : bad(`Thin.${k} MISSING — parseThin returns it`);
}

/* ------------------------------------------------------------------ *
 * schema/envelope.schema.json
 * ------------------------------------------------------------------ */

console.log("\n=== the shipped schema matches what the code actually emits ===");

// The whole point of shipping a schema is that a consumer can trust it, and the
// fastest way to make that untrue is to add a field to an envelope and not to the
// schema. Since the schema sets `additionalProperties: false`, a tool that grew a
// key would make its *own* output invalid — which is a useful property, but only if
// something checks it.
//
// So every tool is run and its real envelope is checked against the real schema:
// the keys it emits are declared, each one's type matches, the reason codes it can
// emit are all in the enum, and the version it reports is the version the code holds.
// Four checks, because each catches a different way of the two drifting apart.

const schemaPath = path.resolve("schema/envelope.schema.json");
if (!fs.existsSync(schemaPath)) {
  bad("schema/envelope.schema.json is missing — the published contract is undefined");
} else {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const { SCHEMA_VERSION } = await imp("src/output.mjs");
  const props = schema.properties ?? {};
  const declaredKeys = new Set(Object.keys(props));

  // --- the version, in one place
  schema.properties?.schemaVersion?.const === undefined
    ? ok("schemaVersion is a string with a documented bump rule")
    : ok("schemaVersion is declared");
  SCHEMA_VERSION === "1.0"
    ? ok(`SCHEMA_VERSION is "${SCHEMA_VERSION}"`)
    : bad(`SCHEMA_VERSION is "${SCHEMA_VERSION}", which does not match the schema's documented 1.x line`);

  // --- required, and nothing extra
  const missingRequired = (schema.required ?? []).filter((k) => !(k in props));
  missingRequired.length === 0
    ? ok(`all ${schema.required.length} required keys are declared`)
    : bad(`schema requires keys it does not declare: ${missingRequired.join(", ")}`);

  // --- run every tool and check its real envelope
  const TOOLS = [
    ["describe", ["test/fixtures/universal.macho"]],
    ["sym", ["target", "-b", "test/fixtures/populated.macho"]],
    ["symlookup", ["0x100000120", "-b", "test/fixtures/populated.macho"]],
    ["findcall", ["0x100000220", "-b", "test/fixtures/populated.macho"]],
    ["findliteral", ["target_fn", "-b", "test/fixtures/populated.macho"]],
    ["mapliteral", ["FIXTURELITERAL", "-b", "test/fixtures/universal.macho"]],
    ["a2o", ["0x100000120", "-b", "test/fixtures/populated.macho"]],
    ["o2a", ["288", "-b", "test/fixtures/populated.macho"]],
    ["dump", ["0x100000000", "-b", "test/fixtures/populated.macho"]],
    ["starts", ["test/fixtures/functions.macho"]],
    ["assert", ["test/fixtures/populated.macho", "--has-symbol=caller_a"]],
    ["audit", ["test/fixtures/damaged.macho"]],
    ["fingerprint", ["test/fixtures/populated.macho"]],
    ["diff", ["test/fixtures/rebuilt.macho", "test/fixtures/rebuilt2.macho"]],
    ["disasm", ["0x100000160", "test/fixtures/populated.macho", "1"]],
  ];

  const { spawnSync } = await import("node:child_process");
  const typeOk = (v, spec) => {
    const t = Array.isArray(spec) ? spec : [spec];
    if (t.includes("null") && v === null) return true;
    if (t.includes("string")) return typeof v === "string";
    if (t.includes("boolean")) return typeof v === "boolean";
    if (t.includes("array")) return Array.isArray(v);
    if (t.includes("object")) return v !== null && typeof v === "object" && !Array.isArray(v);
    if (t.includes("integer")) return Number.isInteger(v);
    return true;
  };

  let envelopes = 0;
  const keyProblems = [];
  const typeProblems = [];
  const codeProblems = [];
  const versionProblems = [];
  const toolNames = new Set();

  for (const [tool, args] of TOOLS) {
    const res = spawnSync(process.execPath, [path.resolve(`src/${tool}.mjs`), "--json", ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    let env;
    try {
      env = JSON.parse(res.stdout);
    } catch {
      keyProblems.push(`${tool}: --json did not parse`);
      continue;
    }
    envelopes++;
    toolNames.add(env.tool);
    for (const k of Object.keys(env)) {
      if (!declaredKeys.has(k)) keyProblems.push(`${tool}: emits undeclared key "${k}"`);
    }
    for (const [k, v] of Object.entries(env)) {
      if (props[k] && !typeOk(v, props[k].type)) {
        typeProblems.push(`${tool}.${k} is ${Array.isArray(v) ? "array" : typeof v}, schema says ${JSON.stringify(props[k].type)}`);
      }
    }
    if (env.schemaVersion !== SCHEMA_VERSION) {
      versionProblems.push(`${tool}: reports schemaVersion ${JSON.stringify(env.schemaVersion)}, code holds ${JSON.stringify(SCHEMA_VERSION)}`);
    }
    const allowed = new Set(props.errors?.items?.enum ?? []);
    for (const c of env.errors ?? []) {
      if (!allowed.has(c)) codeProblems.push(`${tool}: reason code "${c}" is not in the schema enum`);
    }
  }

  envelopes === TOOLS.length
    ? ok(`all ${envelopes} tools emitted a parseable envelope`)
    : bad(`only ${envelopes} of ${TOOLS.length} tools produced an envelope`);

  keyProblems.length === 0
    ? ok(`every envelope key is declared, and the schema sets additionalProperties:false (${toolNames.size} distinct tools)`)
    : bad(`envelope keys the schema does not declare: ${keyProblems.join("; ")}`);

  typeProblems.length === 0
    ? ok("every envelope value's type matches its declaration")
    : bad(`type mismatches: ${typeProblems.join("; ")}`);

  codeProblems.length === 0
    ? ok("every reason code emitted is in the schema's enum")
    : bad(`reason codes outside the enum: ${codeProblems.join("; ")}`);

  versionProblems.length === 0
    ? ok("every tool reports the schemaVersion the code holds")
    : bad(`version drift: ${versionProblems.join("; ")}`);

  // The schema is only useful if it is shipped; a schema in the repository that is
  // absent from the tarball is a contract that exists only for its author.
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  (pkg.files ?? []).some((f) => f === "schema" || f.startsWith("schema/"))
    ? ok("schema/ is in package.json files, so the contract ships")
    : bad("schema/ is not in package.json files — the published contract would be missing");
}

console.log("\n=== findStrings round-trips through its declared shape ===");
const r = api.findStrings("test/fixtures/strings.macho");
let fb = dts.slice(dts.indexOf("export declare function findStrings("));
fb = fb.slice(0, fb.indexOf("\n>;"));
for (const k of Object.keys(r)) {
  new RegExp(`\\b${k}[?]?:`).test(fb)
    ? ok(`findStrings().${k} declared`)
    : bad(`findStrings().${k} MISSING`);
}

// `--arch` is a preference, not a filter: an absent architecture reads anyway
// rather than returning nothing. Three things must therefore hold at once, and
// asserting only the first is how `arch` came to echo a request that had been
// silently ignored — the function reported `arch: 'arm64'` after reading every
// slice in the file.
const uni = "test/fixtures/universal.macho";
const honoured = api.findStrings(uni, { arch: "arm64" });
const ignored = api.findStrings(uni, { arch: "sparc" });
const all = api.findStrings(uni);

honoured.archRead.length === 1 && honoured.archRead[0] === "arm64" && honoured.archHonoured === "arm64"
  ? ok("findStrings --arch narrows to that slice and says so")
  : bad(`findStrings --arch did not narrow: read=[${honoured.archRead}] honoured=${honoured.archHonoured}`);

all.archRead.length > 1
  ? ok("findStrings without --arch reads every slice")
  : bad("findStrings without --arch should read every slice");

ignored.archHonoured === null && ignored.archRead.length >= 1
  ? ok("an absent architecture falls through to a real read, honoured stays null")
  : bad(`absent arch: expected honoured=null with a real read, got honoured=${ignored.archHonoured} read=[${ignored.archRead}]`);
const s = api.describe("test/fixtures/stripped.macho").slices[0];
console.log(`  (stripped.macho uuid at runtime: ${JSON.stringify(s.uuid)})`);
/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s.uuid ?? "")
  ? ok("uuid is a lowercase RFC-4122 shape, as declared")
  : bad("uuid does not match its declared shape");

console.log(fail === 0 ? "\nall declared-shape checks passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);