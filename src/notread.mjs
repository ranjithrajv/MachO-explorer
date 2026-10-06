/**
 * notread.mjs — what this package does not parse, as data.
 *
 * ## Why this is its own file with no imports
 *
 * Three doors emit an answer: the CLI (`output.mjs`), the library (`api.mjs`), and
 * the MCP server (`mcp-tools.mjs`). All three must carry the same list, or an agent
 * that learned to read it from one door would be told by another that an answer was
 * complete when it was not.
 *
 * The obvious way to share one constant is for the other two to import it from
 * `api.mjs`. That is wrong here, and specifically so: `src/mcp-tools.mjs` states
 * that everything in that layer is deliberately self-contained, because the MCP
 * server is what an agent loads first and every module it has to resolve is one
 * more thing that can fail to load before a single tool is reachable.
 * `SCHEMA_VERSION` is the documented single exception — one literal, because a
 * *version* is only a version if there is exactly one of it.
 *
 * So the list lives here instead: a module with no imports at all, which the MCP
 * door can reach without pulling `api.mjs` and its transitive graph behind it. That
 * is the same reasoning as `SCHEMA_VERSION`, generalised — the things that must be
 * identical across doors are the ones that live where no door can disagree.
 *
 * ## The rule this list is held to
 *
 * It is kept in step with `README.md`'s "What it will not do" by hand, and asserted
 * against it by `test/smoke.mjs`. A gap list that drifts from the refusal list is
 * worse than none, because it is a gap list that is confidently wrong: it says
 * precisely what was not looked at, and a consumer reads the absence of a warning as
 * evidence there was nothing to warn about.
 */

export const NOT_READ = [
  'code signature, entitlements or designated requirements',
  'the export trie and chained fixups',
  'Objective-C and Swift metadata',
  'dSYM and DWARF',
  'FAT32 containers',
  'disassembly, and the mnemonics behind an instruction length',
];