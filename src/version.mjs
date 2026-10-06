/**
 * version.mjs — the package version, from wherever it can be read.
 *
 * ## Why this is a module
 *
 * Because two callers needed it and neither could do it alone. `mcp.mjs` and
 * `sarif.mjs` both did `createRequire(import.meta.url)('../package.json')`,
 * which is correct for an installed npm package and *throws* in a Single
 * Executable Application, where `import.meta.url` points inside the blob and
 * there is no `package.json` beside it. A released binary would not report a
 * wrong version; it would fail to start, which is worse.
 *
 * ## Why a SEA asset rather than a fallback string
 *
 * Because a fallback would have to be a guess. `sarif.mjs` says in its own
 * header that a SARIF file claiming the wrong version is precisely the
 * plausible-wrong-metadata failure this project exists to avoid, and a
 * consumer records that permanently in an alert's history. So the version is
 * carried into the binary by the build, not invented at runtime: the build
 * embeds `package.json` as a SEA asset and this reads that.
 *
 * Cost: one more line in the build script, and no version of this package can
 * disagree with its own binary. There is no code path that returns a version
 * the build did not put there.
 */
import { createRequire } from 'node:module';

/** The asset name `scripts/build-sea.mjs` embeds `package.json` under. */
const ASSET = 'macho-explorer-package.json';

/**
 * The embedded asset reader, or `null` when not running as a SEA.
 *
 * `node:sea` throws on require in a normal process, so its availability is
 * the test — there is no `isSea()` to ask first without a try around it.
 */
function sea() {
  try {
    return createRequire(import.meta.url)('node:sea');
  } catch {
    return null;
  }
}

/** The version string. Never a placeholder; see the header for why. */
export function version() {
  const s = sea();
  if (s && s.isSea()) {
    const raw = s.getAsset(ASSET);
    if (raw) return JSON.parse(raw.toString('utf8')).version;
  }
  return createRequire(import.meta.url)('../package.json').version;
}