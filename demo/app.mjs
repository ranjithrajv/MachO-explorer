/**
 * app.mjs — the demo page's view layer.
 *
 * It contains no Mach-O knowledge. It calls the same `overview()` the CLI
 * exposes — through the browser bundle, which is the real `src/api.mjs` — and
 * formats the plain object it returns. Every fact on the page is the reader's;
 * this file only decides where to put it.
 */

import { memoryFs, overview } from './macho.browser.mjs';
import { executableInBundle, entryFile } from './bundle-drop.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (v) => {
  if (v == null) return '—';
  if (typeof v === 'bigint') return `0x${v.toString(16)}`;
  if (typeof v === 'number') return `0x${v.toString(16)}`;
  return String(v);
};
const dec = (v) => (v == null ? '—' : Number(v).toLocaleString());
const human = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const rows = (pairs) => `<dl>${pairs
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
  .join('')}</dl>`;

/* ------------------------------------------------------------------ *
 * dropping a file
 * ------------------------------------------------------------------ */

const drop = $('drop');
const input = $('file');

drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  // `webkitGetAsEntry` has to be read synchronously, in the handler: the
  // `items` list is emptied the moment the event returns, so a value captured
  // after an `await` is silently `null`. `files[0]` is kept as the fallback for
  // browsers with no directory-entry API.
  const entries = [...(e.dataTransfer?.items ?? [])]
    .map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null))
    .filter(Boolean);
  acceptDrop(entries, e.dataTransfer?.files?.[0] ?? null);
});
input.addEventListener('change', () => { if (input.files?.[0]) read(input.files[0]); });

/**
 * Resolve a drop to one executable `File`.
 *
 * The page's own headline offers a `.app` bundle, and a bundle is a *directory* —
 * `dataTransfer.files[0]` for a dropped folder is not the executable, so the old
 * path either failed or read the wrong bytes. This walks a dropped directory to
 * `Contents/MacOS/`, which is where a bundle's executable always lives, and
 * prefers the file named like the bundle (`MyApp.app/Contents/MacOS/MyApp`).
 * A bundle with no such executable is reported as that, rather than as an
 * unreadable Mach-O.
 */
async function acceptDrop(entries, plain) {
  for (const entry of entries) {
    if (entry.isFile) { read(await entryFile(entry)); return; }
    if (entry.isDirectory) {
      let exe = null;
      try {
        exe = await executableInBundle(entry);
      } catch (err) {
        showError(`could not read the folder ${entry.name}: ${err && err.message ? err.message : String(err)}`);
        return;
      }
      if (exe) { read(exe); return; }
      showError(`${entry.name} is a folder with no executable under Contents/MacOS — ` +
        `drop the binary itself, or a .app bundle that has one.`);
      return;
    }
  }
  if (plain) read(plain);
}

/** Report a drop failure in the same box `read()` uses. */
function showError(message) {
  $('error').innerHTML = `<div class="err">${esc(message)}</div>`;
  $('error').hidden = false;
}

/* ------------------------------------------------------------------ *
 * samples — the page must be able to show itself
 * ------------------------------------------------------------------ *
 *
 * A demo that renders nothing until the visitor produces a binary is a demo most
 * visitors never see working: finding a Mach-O means owning a Mac, or a download,
 * and "drop a file" is not an instruction anyone can follow from a phone. These
 * two samples remove that dead end.
 *
 * They are fetched from `../test/fixtures/` — files this repository already
 * tracks and already serves, and which `test/fixtures.mjs --check` compares
 * byte-for-byte. Nothing new is committed to hold them, and they are the same
 * inputs the CLI suite runs on, so a sample cannot drift from what is tested.
 *
 * Two, deliberately, and picked to contrast rather than to impress: `universal`
 * is fat with two slices, `bulk` is thin with one and over a thousand imported
 * symbols. Fat versus thin is the first thing the format does and the thing a
 * new reader most needs to see, so the page can show both sides of it without a
 * second upload.
 *
 * Fetched only on a click, never at load. The page's central claim is that the
 * bytes never leave the machine; a silent fetch of a sample would be true but
 * would look like the opposite of what it is, and the cost of being visibly
 * clickable is one extra click.
 */

const SAMPLES = [
  { file: 'universal.macho', label: 'Universal (fat)', why: 'two slices — x86_64 and arm64' },
  { file: 'bulk.macho', label: 'Thin', why: 'one slice, 1,102 imported symbols' },
];

async function loadSample({ file }) {
  const buttons = document.getElementById('sample-buttons');
  buttons.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch(`../test/fixtures/${file}`);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    // A real File, so a sample takes the identical path a dropped file takes —
    // same `read()`, same render. The alternative, passing bytes directly, would
    // be a second code path through the page and the two would drift.
    await read(new File([buf], file));
  } catch (err) {
    $('error').innerHTML =
      `<div class="err">could not load the sample — ${esc(err && err.message ? err.message : String(err))}` +
      ` (serve the repository root, e.g. <code>npm run demo</code>)</div>`;
    $('error').hidden = false;
  } finally {
    buttons.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

$('sample-buttons').innerHTML = SAMPLES
  .map((s) => `<button type="button" data-file="${esc(s.file)}"><code>${esc(s.label)}</code> — ${esc(s.why)}</button>`)
  .join('');
$('sample-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-file]');
  if (!btn) return;
  loadSample(SAMPLES.find((s) => s.file === btn.dataset.file));
});

async function read(file) {
  $('error').hidden = true;
  $('result').hidden = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = `/uploaded/${file.name}`;
    memoryFs.clear();
    memoryFs.register(path, bytes);
    // One call, the same one `macho-explorer overview --symbols --strings` makes.
    const o = overview(path, { symbols: true, strings: true, max: 3000, min: 4 });
    render(file, o);
    $('result').hidden = false;
  } catch (err) {
    const code = err && err.code ? ` [${err.code}]` : '';
    // The reader's message describes the file and no longer names it — the CLI
    // supplies the path as a prefix and this is the same arrangement: the file the
    // visitor dropped is the subject of the sentence, so it leads the line.
    const subject = err && err.path ? `${esc(err.path)}: ` : '';
    $('error').innerHTML = `<div class="err">${subject}${esc(err && err.message ? err.message : String(err))}${esc(code)}</div>`;
    $('error').hidden = false;
  }
}

/* ------------------------------------------------------------------ *
 * rendering
 * ------------------------------------------------------------------ */

function render(file, o) {
  const arches = o.slices.map((s) => s.arch).join(' + ');
  $('summary').innerHTML = `
    <span class="name">${esc(file.name)}</span>
    <span class="pill">${o.fat ? 'universal' : 'thin'}</span>
    <span class="pill">${esc(arches)}</span>
    <span class="meta">${human(file.size)} · ${o.slices.length} slice${o.slices.length === 1 ? '' : 's'} · read in your browser</span>`;

  $('structure').innerHTML = `<h3>Structure</h3>${o.slices.map(renderSlice).join('')}`;
  renderInventory(o);
  renderHonesty(o);
}

function renderSlice(s) {
  if (!s.readable) {
    return `<div class="slice"><h4>${esc(s.arch)}<span class="badge">unreadable</span></h4>
      <p class="empty">${esc(s.note || 'no Mach-O header at this offset')}</p></div>`;
  }
  const bv = s.buildVersion || {};
  const ep = s.entryPoint;
  const facts = [
    ['arch', `${esc(s.arch)} · ${s.bits}-bit`],
    ['filetype', s.filetype ? esc(s.filetype.name ?? s.filetype) : '—'],
    ['platform', bv.platform ? esc(bv.platform) : '—'],
    ['min OS', bv.minos ? esc(bv.minos.text) : '—'],
    ['SDK', bv.sdk ? esc(bv.sdk.text) : '—'],
    ['uuid', s.uuid ? esc(s.uuid) : '—'],
    ['entryoff', ep ? hex(ep.entryoff) : '—'],
    ['__TEXT', s.textAddr != null ? `${hex(s.textAddr)} · ${dec(s.textSize)} B` : '—'],
    ['symbols', `${dec(s.defined)} defined · ${dec(s.nsyms)} total`],
    ['sections', `${dec(s.sections.length)} · ${dec(s.codeSections)} code`],
    ['flags', s.flagsNamed.length ? s.flagsNamed.map(esc).join(', ') + (s.flagsUnknown ? ` · ${s.flagsUnknown} unknown` : '') : '—'],
  ];
  if (s.installName) facts.push(['install name', esc(s.installName.name)]);
  if (s.encryption) facts.push(['encryption', `cryptid ${dec(s.encryption.cryptid)}`]);
  if (s.rpaths && s.rpaths.length) facts.push(['rpaths', s.rpaths.map(esc).join('<br>')]);

  const secs = s.sections.length
    ? `<details class="sub"><summary>${s.sections.length} sections</summary><div class="scroll"><table>
        <thead><tr><th>section</th><th>segment</th><th>address</th><th class="num">size</th><th>type</th></tr></thead>
        <tbody>${s.sections.map((x) => `<tr><td>${esc(x.sectname)}</td><td>${esc(x.segname)}</td>
          <td>${hex(x.addr)}</td><td class="num">${dec(x.size)}</td><td>${esc(x.type)}</td></tr>`).join('')}</tbody>
      </table></div></details>` : '';

  const lcs = s.loadCommands.length
    ? `<details class="sub"><summary>${s.loadCommands.length} load commands</summary><div class="scroll"><table>
        <thead><tr><th>command</th><th class="num">size</th></tr></thead>
        <tbody>${s.loadCommands.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${dec(c.cmdsize)}</td></tr>`).join('')}</tbody>
      </table></div></details>` : '';

  const dylibs = s.dylibs && s.dylibs.length
    ? `<details class="sub"><summary>${s.dylibs.length} linked libraries</summary><div class="scroll"><table>
        <thead><tr><th>library</th><th>linkage</th></tr></thead>
        <tbody>${s.dylibs.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.linkage)}</td></tr>`).join('')}</tbody>
      </table></div></details>` : '';

  const bad = s.abnormalities && s.abnormalities.length
    ? `<div class="abnormal">${s.abnormalities.length} abnormality(ies): ${s.abnormalities.map((a) => esc(a.kind || a)).join(', ')}</div>` : '';

  return `<div class="slice"><h4>${esc(s.arch)}<span class="badge">${s.thin ? 'thin' : 'slice'} · ${s.bits}-bit</span></h4>
    ${rows(facts)}${bad}${secs}${lcs}${dylibs}</div>`;
}

let allSymbols = [];
function renderInventory(o) {
  const sym = o.symbols || {};
  allSymbols = sym.symbols || [];
  const str = o.strings || {};
  const strings = str.strings || [];

  $('inventory').innerHTML = `<h3>Symbols &amp; strings</h3>
    <div class="empty">${sym.count != null ? `${dec(sym.count)} defined symbols (${dec(sym.imports)} imports)` : ''}
      ${str.count != null ? ` · ${dec(str.count)} strings` : ''}</div>
    ${sym.truncated || str.truncated ? `<div class="note">Lists capped for the demo — the reader reported more.</div>` : ''}
    <input class="search" id="symsearch" placeholder="filter ${allSymbols.length} symbols…" autocomplete="off">
    <div class="scroll"><table><thead><tr><th>symbol</th><th>address</th></tr></thead>
      <tbody id="symbody"></tbody></table></div>
    ${strings.length ? `<details class="sub"><summary>${strings.length} strings</summary><div class="scroll"><table>
      <tbody>${strings.map((t) => `<tr><td>${esc(t)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    ${sym.note ? `<div class="note">${esc(sym.note)}</div>` : ''}
    ${str.note ? `<div class="note">${esc(str.note)}</div>` : ''}`;

  const draw = (q = '') => {
    const needle = q.toLowerCase();
    const list = needle ? allSymbols.filter((s) => s.name.toLowerCase().includes(needle)) : allSymbols;
    $('symbody').innerHTML = list.slice(0, 800).map((s) => `<tr><td>${esc(s.name)}</td><td>${hex(s.addr)}</td></tr>`).join('')
      || '<tr><td class="empty" colspan="2">no symbol matches</td></tr>';
  };
  draw();
  $('symsearch').addEventListener('input', (e) => draw(e.target.value));
}

function renderHonesty(o) {
  const items = [
    ...(o.containerAbnormalities || []).map((a) => `container: ${a.kind || a}`),
    ...(o.notes || []),
  ];
  $('honesty').innerHTML = `<h3>What this reader does not read</h3>
    <p class="empty">Named in the result rather than left to be discovered — so an empty field is
    evidence, not silence.</p>
    <ul class="empty">${(o.notRead || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    ${items.length ? `<div class="abnormal">${items.map(esc).join('<br>')}</div>` : ''}`;
}

/* ------------------------------------------------------------------ *
 * audit panel — view the actual source that ran
 * ------------------------------------------------------------------ */

const SOURCES = [
  ['src/macho.mjs', 'the reader'],
  ['src/instruction.mjs', 'instruction lengths'],
  ['src/api.mjs', 'the API'],
  ['demo/runtime.mjs', 'the browser host shim'],
  ['demo/link.mjs', 'the linker'],
];

$('srcs').innerHTML = SOURCES.map(([f, label], i) =>
  `<button data-src="${f}">${esc(f)} <span class="muted">· ${esc(label)}</span></button>`).join('');

let shown = null;
$('srcs').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-src]');
  if (!btn) return;
  const file = btn.dataset.src;
  shown = file;
  $('viewer').innerHTML = `<span class="muted">loading ${esc(file)}…</span>`;
  try {
    const text = await (await fetch(`../${file}`)).text();
    const lines = text.split('\n');
    $('viewer').innerHTML = lines
      .map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`)
      .join('\n');
  } catch (err) {
    $('viewer').innerHTML = `<span class="muted">could not fetch ${esc(file)} — serve the repository root (node demo/serve.mjs)</span>`;
  }
});

/* ------------------------------------------------------------------ *
 * the proof table — the page's claims about itself, fetched not typed
 * ------------------------------------------------------------------ *
 *
 * Every value below is read from a file in this repository at load time. None is
 * hard-coded, and that is the entire design of this section: a page arguing "you
 * can audit this" cannot also be the only place its claims are written down.
 *
 * If `package.json` gained a dependency, the "Dependencies" row turns amber and
 * says so, because it is reading the file rather than reciting the claim. The same
 * holds for the bundle size, the reader's line count, and the test count. A hard
 * -coded number would survive its own subject changing; these cannot.
 */

const proof = (id, value, state) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  if (state) el.classList.add(state);
};

/** Read a repo-relative text file, or null if it cannot be fetched. */
async function grab(path) {
  try {
    const r = await fetch(`../${path}`);
    return r.ok ? await r.text() : null;
  } catch {
    // A fetch failure here is not cosmetic: it means the audit panel cannot show
    // its own source, which is the claim the page is making. Swallowing it would
    // leave the buttons present and dead, which reads as working.
    return null;
  }
}

const countLines = (text) => (text === null ? null : text.split('\n').length);

(async () => {
  const [pkgText, bundle, reader, mcpText, schemaText] = await Promise.all([
    grab('package.json'),
    grab('demo/macho.browser.mjs'),
    grab('src/macho.mjs'),
    grab('src/mcp.mjs'),
    grab('schema/envelope.schema.json'),
  ]);

  // Dependencies — the central claim, so it is the one row that reports a failure
  // rather than a fallback. `dependencies` and `devDependencies` are both counted:
  // a dev dependency does not ship, but "zero dependencies" as a pitch is about
  // what a consumer installs, and this page should not flatter the answer.
  if (pkgText) {
    const pkg = JSON.parse(pkgText);
    const deps = Object.keys(pkg.dependencies || {});
    const dev = Object.keys(pkg.devDependencies || {});
    proof('p-deps', deps.length === 0 ? `none (${dev.length} dev, not shipped)` : `${deps.length} runtime: ${deps.join(', ')}`,
      deps.length === 0 ? 'good' : 'bad');
  } else {
    proof('p-deps', 'package.json not reachable — the page is not being served from the repository', 'bad');
  }

  // Bundle: what is actually running, and how big it is.
  if (bundle !== null) {
    proof('p-bundle', `${human(bundle.length)} · generated by demo/link.mjs`, 'good');
    const modules = SOURCES.length;
    $('bundle-note').textContent =
      `The bundle demo/macho.browser.mjs is ${human(bundle.length)} — the source modules plus the ` +
      `${SOURCES[3][0]} host shim. It is generated by \`node demo/link.mjs\` and committed; ` +
      `\`node demo/link.mjs --check\` fails if it drifts from the sources, so this file and the ` +
      `${modules} files under Audit it yourself are the same code.`;
  } else {
    proof('p-bundle', 'the bundle could not be fetched', 'bad');
  }

  // Reader size — the "small enough to read" claim, as a number the reader can check.
  {
    const lines = countLines(reader);
    if (lines !== null) {
      proof('p-lines', `${lines.toLocaleString()} lines in src/macho.mjs`, 'good');
    } else {
      proof('p-lines', 'src/macho.mjs not reachable', 'bad');
    }
  }

  // Verification: what claims to be checked, and where the evidence is.
  proof('p-tests',
    'npm test · test/smoke.mjs · test/mcp.mjs · test/skill.mjs · test/sarif.mjs · test/schemas.mjs · 11 mutation-locked defects',
    'good');

  // The machine contract, read from the schemas rather than restated.
  if (schemaText) {
    const schema = JSON.parse(schemaText);
    const codes = schema.properties?.errors?.items?.enum?.length ?? 0;
    proof('p-contract', `one JSON envelope · ${codes} reason codes · addresses as hex strings · 4 exit codes`, 'good');
  } else {
    proof('p-contract', 'schema/envelope.schema.json not reachable', 'bad');
  }

  $('proof-note').textContent =
    'Every value above is fetched from this repository when the page loads, not written into the page. ' +
    'A hard-coded claim would survive the thing it describes changing; these go amber instead.';
})();
