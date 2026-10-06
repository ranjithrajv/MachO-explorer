/**
 * container.mjs — what a user actually hands you, and what this package reads.
 *
 * ## Why this is its own file with no imports
 *
 * The same sentence has to reach three doors, and the reason codes have to agree:
 *
 *   - the library and the CLIs, through `api.mjs`'s `readerError`
 *   - the CLIs' own resolution failure, through `target.mjs`'s `requireBinary`
 *   - the MCP server, through `mcp-tools.mjs`
 *
 * `mcp-tools.mjs` is deliberately self-contained — it is what an agent loads first,
 * and every module it has to resolve is one more thing that can fail to load before
 * a tool is reachable. So the table cannot live in `api.mjs`, which is exactly the
 * argument `notread.mjs` makes for the same reason. This file is that argument again:
 * a module with no imports at all, which any door can reach without pulling a graph
 * behind it.
 *
 * It also must not import `bundle.mjs`, which is where the `.app` convention comes
 * from. That convention is configurable, and a message that named a hardcoded
 * `.app`/`Contents/MacOS` would contradict a deployment that changed it. The bundle
 * is therefore passed in by the one caller that already knows it (`target.mjs`), and
 * everything else matches on extensions alone.
 *
 * ## What the message is for
 *
 * A person who downloads an app has a `.ipa` or a `.dmg`, not a Mach-O. Told "not a
 * Mach-O binary" about either, the reasonable reading is that the file is damaged or
 * the wrong file was picked. Neither is likely: the file is fine, it is simply one
 * layer of packaging above what this reader parses. So the message names the
 * packaging, says what to do about it, and lists what *is* accepted — because the
 * question behind "not a Mach-O binary" is almost always "then what do you take?",
 * and an error that does not answer it leaves the user to guess from a filename.
 *
 * The accepted list is stated as prose rather than as extensions, and deliberately
 * says "any filename": the overwhelmingly common case is a binary with no extension
 * at all, and an error that listed only extensions would read as "mine is not one of
 * those" about `/usr/libexec/something`.
 */

/**
 * Apple ecosystem containers that wrap a Mach-O inside an archive, a disk image or a
 * bundle. These are the files a user is most likely to have on disk and most likely
 * to mistake for a binary.
 *
 * `containsMachO: false` marks the ones that hold no Mach-O to find — an asset
 * catalog and a result bundle are Apple containers a person may well hand over, but
 * extracting them does not produce a binary, and sending them down the same
 * "extract it and try again" road would be advice that cannot work.
 */
export const APPLE_CONTAINERS = [
  { ext: '.ipa', hint: 'an iOS app archive — a ZIP holding Payload/<App>.app, which the CLIs extract for you', containsMachO: true },
  { ext: '.dmg', hint: 'a disk image — mount it (`hdiutil attach`) and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.pkg', hint: 'an installer package — expand it (`pkgutil --expand`) and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.mpkg', hint: 'a multi-package installer — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.xip', hint: 'a compressed Xcode package — expand it (`xip -x`) and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.zip', hint: 'a ZIP archive — unzip it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.tar', hint: 'a tar archive — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.gz', hint: 'a gzip archive — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.bz2', hint: 'a bzip2 archive — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.xz', hint: 'an xz archive — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.ipsw', hint: 'an iOS firmware image — extract it and point this tool at the Mach-O inside', containsMachO: true },
  { ext: '.xcarchive', hint: 'an Xcode archive — the Mach-O is under Products/ or the .app bundle inside', containsMachO: true },
  { ext: '.dSYM', hint: 'a debug-symbol bundle — the Mach-O is under Contents/Resources/DWARF/', containsMachO: true },
  { ext: '.simruntime', hint: 'a simulator runtime — the Mach-O files are under the platform library directories', containsMachO: true },
  { ext: '.car', hint: 'a compiled asset catalog — it holds no Mach-O; extract the assets with `assetutil` instead', containsMachO: false },
  { ext: '.xcresult', hint: 'an Xcode result bundle — it holds no Mach-O; read it with `xcrun xcresulttool` instead', containsMachO: false },
];

/**
 * What this package will read, in the words a user needs to pick a file.
 *
 * A list rather than a sentence because the answers are not one sentence: a bundle
 * and an `.ipa` are both accepted, and neither is accepted because of its extension
 * — what is read is the executable inside.
 *
 * `.tbd` is listed with its own caveat because it is the one entry that is not a
 * Mach-O at all: `tbd` reads it, and every other tool refuses it. A list that said
 * only "a .tbd stub" would send a user to `describe`, which answers "not a Mach-O
 * binary" — correctly, and confusingly, because the list above it said yes.
 */
export const ACCEPTED = [
  'a Mach-O binary, thin or universal (fat) — any filename, extension or none',
  'an application bundle — the executable inside it is found for you',
  'an .ipa archive — the executable inside Payload/ is extracted for you',
  'a .tbd text stub — but only for `macho-explorer tbd`, which reads what it exports',
];

/** The accepted list as one indented block, for appending to a message. */
export function acceptedBlock(indent = '  ') {
  return ACCEPTED.map((a) => `${indent}${a}`).join('\n');
}

/**
 * The container a path names, or null.
 *
 * Matched on the lowercased path, because these extensions are conventionally
 * capitalised on Apple platforms (`.dSYM`) and a case-sensitive match would miss
 * exactly the ones a macOS user is most likely to have.
 *
 * @param {string} path
 * @param {string} [bundleExt] the configured bundle extension, when the caller knows
 *   it. Passed rather than imported so this module stays free of `bundle.mjs`; see
 *   the header.
 * @returns {object|null}
 */
export function containerFor(path, bundleExt) {
  if (typeof path !== 'string' || !path) return null;
  const lower = path.toLowerCase();
  if (bundleExt && lower.endsWith(bundleExt.toLowerCase())) {
    return {
      ext: bundleExt,
      hint: 'an application bundle — a directory, not a file; the executable is inside it',
      containsMachO: true,
      isBundle: true,
    };
  }
  const hit = APPLE_CONTAINERS.find((c) => lower.endsWith(c.ext.toLowerCase()));
  return hit ? { ...hit } : null;
}

/**
 * The message for a file that is packaging rather than a binary, or null when the
 * path names nothing this module recognises.
 *
 * The path is an input, not part of the output. Every caller already prints the path
 * it asked about — the CLIs as `${binary}: ${e.message}`, and the envelope carries it
 * as `binary` — so a message that named it too produced a doubled prefix on the text
 * door, which is worse than either arrangement alone: the reader has to work out
 * which of the two paths is the file before the sentence means anything.
 *
 * The reason code is `unknown-encoding` throughout, because the file *is* readable —
 * it just is not what this reader parses. Reporting `io` would send a caller looking
 * for a permissions problem with a file it can open perfectly well.
 *
 * @param {string} path
 * @param {string} [bundleExt]
 * @returns {string|null}
 */
export function containerMessage(path, bundleExt) {
  const c = containerFor(path, bundleExt);
  if (!c) return null;
  const action = c.containsMachO
    ? c.isBundle
      ? 'Point this tool at the bundle and it will find the executable inside, or pass that executable directly.'
      : 'Extract the Mach-O executable and pass that file to this tool.'
    : 'Nothing inside it is a Mach-O, so extracting it will not help.';
  return (
    `this is ${c.hint}. ${action}\n` +
    `  accepted instead:\n${acceptedBlock('    ')}`
  );
}