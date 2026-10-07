/**
 * bundle-drop.mjs — resolve a dropped `.app` directory to its executable.
 *
 * ## Why this is a module rather than a few functions in `app.mjs`
 *
 * Because it is the only part of the drop path that is logic rather than
 * plumbing, and `app.mjs` touches `document` the moment it is imported, so it
 * cannot be loaded in Node. Keeping the walk here means `test/browser.mjs` can
 * drive it with fake directory entries — the same objects the browser hands to
 * a drop handler — and assert the answers without a browser.
 *
 * ## The bug this exists to keep fixed
 *
 * A `FileSystemDirectoryReader` yields at most ~100 entries per `readEntries`
 * call and signals the end with an empty batch, so one reader is created per
 * directory and drained. The first version of this called `createReader()`
 * inside the drain loop, which restarts from the top on every iteration and
 * never terminates — the tab's renderer died rather than the page showing an
 * error. That is not a mistake worth re-learning, so it is asserted below.
 *
 * The module has no DOM and no reader dependencies: `{ isFile, isDirectory,
 * name, createReader, file }` is the whole contract, and it is exactly the
 * shape the browser supplies.
 */

/** One batch from an already-created reader. */
export function readBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** The `File` behind a file entry. */
export function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Every file under `entry`, depth-first, as `{ entry, path }`.
 *
 * `path` is relative to the dropped directory (`Contents/MacOS/MyApp`), which
 * is what lets the caller find the executable by position rather than by
 * guessing from a recursive search.
 */
export async function walk(entry, prefix = '') {
  const out = [];
  const reader = entry.createReader();
  for (;;) {
    const batch = await readBatch(reader);
    if (batch.length === 0) break;
    for (const e of batch) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isFile) out.push({ entry: e, path: p });
      else if (e.isDirectory) out.push(...(await walk(e, p)));
    }
  }
  return out;
}

/**
 * The executable inside a `.app` directory entry, or `null`.
 *
 * A bundle's executable always lives in `Contents/MacOS/`, so that directory is
 * the filter; within it, the file named like the bundle wins
 * (`MyApp.app/Contents/MacOS/MyApp`), and the first file there is the fallback
 * for a bundle whose name and executable disagree. `null` is a real answer —
 * a dropped folder that is not a bundle — and the caller reports it as that
 * rather than as an unreadable Mach-O.
 */
export async function executableInBundle(dirEntry) {
  const files = await walk(dirEntry);
  const macos = files.filter((f) => /(^|\/)Contents\/MacOS\//.test(f.path));
  if (macos.length === 0) return null;
  const base = dirEntry.name.replace(/\.app$/i, '');
  const named = macos.find((f) => f.path === `Contents/MacOS/${base}`);
  return entryFile((named ?? macos[0]).entry);
}
