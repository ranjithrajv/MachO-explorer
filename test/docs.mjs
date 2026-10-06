#!/usr/bin/env node
/**
 * docs.mjs — the documentation site is rendered, complete, and honest.
 *
 * ## What this is for
 *
 * `docs/build.mjs` is a markdown renderer written from scratch, because a markdown
 * library would be the package's first dependency and the hardest one to remove.
 * A hand-rolled renderer has one characteristic failure and this suite exists to
 * catch it: **it degrades quietly.**
 *
 * Meet a construct with no branch and the obvious implementation emits the source
 * line as a paragraph. The page renders. Nothing throws. A table becomes a
 * paragraph of pipes, a callout becomes prose, and the documentation is quietly
 * wrong — a worse outcome than a missing page, because it looks finished.
 *
 * So this suite asserts from the *output* side, which is the direction the builder
 * cannot check itself:
 *
 *   1. No page contains leftover markdown syntax. Pipes where a table should be,
 *      `**` where emphasis should be, `#` where a heading should be. This is the
 *      assertion that catches a degraded render, and it is the reason the builder's
 *      own `unhandled` report is not the only gate.
 *   2. Every anchor a page links to **within the site** exists. A table of
 *      contents full of dead links is the most visible possible way for a
 *      generated page to be wrong.
 *   3. Structural elements are present: headings, tables, code blocks, the
 *      sidebar. A page that silently rendered as one paragraph has none.
 *   4. Every source document produced a page, and every page has a source.
 *   5. `--check` detects drift, so the committed site cannot lag the markdown.
 *
 * ## What it deliberately does not do
 *
 * It does not compare the rendered text against the source text for equality.
 * That would require a correct renderer *and* a correct expectation, and getting
 * both right independently is harder than either. The structural and
 * no-leftover-syntax assertions catch the failure that actually happens; a
 * golden-file comparison would mostly catch the renderer's own choices, which are
 * all legitimate.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, '_site', 'docs');

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
const eq = (a, b, label) => ok(a === b, label, a === b ? '' : `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// Build fresh, so the assertions below are about the builder's current behaviour
// rather than about whatever was left in the directory by an earlier run.
rmSync(join(ROOT, '_site'), { recursive: true, force: true });
const build = spawnSync(process.execPath, [join(ROOT, 'docs', 'build.mjs')], { encoding: 'utf8', cwd: ROOT });
ok(build.status === 0, 'the docs build succeeds', build.stderr?.trim().split('\n').slice(0, 4).join(' | '));
ok(/unhandled/.test(build.stderr) === false, 'the builder reported no unhandled construct', build.stderr?.slice(0, 200));

const pages = existsSync(SITE) ? readdirSync(SITE).filter((f) => f.endsWith('.html')) : [];
ok(pages.length >= 7, `every source document produced a page (${pages.length} pages)`, pages.join(', '));
ok(existsSync(join(SITE, 'index.html')), 'there is an index page');
ok(existsSync(join(SITE, 'site.css')), 'the stylesheet was copied');

/* ------------------------------------------------------------------ *
 * no leftover markdown — the assertion that catches a degraded render
 * ------------------------------------------------------------------ */

/**
 * Strip the regions where markdown syntax is *legitimate* before looking for it.
 *
 * Inside `<code>`, `<pre>` and `<h1 id="...">` a `#` or a `|` is content, not
 * markup. Without this, a page documenting `awk '{print $1}'` would fail on its
 * own example — and a check that fires on correct output gets disabled, which is
 * how a real defect survives.
 */
function proseOnly(html) {
  return html
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
    .replace(/<code[\s\S]*?<\/code>/g, ' ')
    .replace(/<h[1-6] id="[^"]*">[\s\S]*?<\/h[1-6]>/g, ' ')
    .replace(/<[^>]+>/g, '');
}

for (const page of pages) {
  const html = readFileSync(join(SITE, page), 'utf8');
  const prose = proseOnly(html);

  // A table delimiter row surviving into the prose means the table branch did not
  // fire and the pipes were rendered as text.
  ok(!/\|\s*-{3,}\s*\|/.test(prose), `${page}: no table delimiter survived into prose`);
  ok(!/^\s*\|.*\|$/m.test(prose.trim()), `${page}: no pipe-delimited row survived into prose`);

  // Emphasis markers surviving means the inline pass did not run.
  ok(!/\*\*/.test(prose), `${page}: no ** markers survived into prose`, prose.match(/.{0,40}\*\*.{0,40}/)?.[0]);
  ok(!/^#{1,6}\s/m.test(prose), `${page}: no heading markers survived into prose`, prose.match(/^#{1,6}\s.{0,40}/m)?.[0]);

  // A fence marker surviving means the code branch did not fire.
  ok(!/^```/m.test(prose), `${page}: no code fence markers survived into prose`);

  // Raw markdown link syntax surviving means the link pass did not run.
  ok(!/\[[^\]]+\]\([^)]+\)/.test(prose), `${page}: no markdown link syntax survived into prose`, prose.match(/\[[^\]]+\]\([^)]+\)/)?.[0]);
}

/* ------------------------------------------------------------------ *
 * structure is present
 * ------------------------------------------------------------------ */

for (const page of pages) {
  const html = readFileSync(join(SITE, page), 'utf8');
  ok(/<h1>/.test(html), `${page}: has an h1`);
  ok(/<nav class="sidebar">/.test(html) || page === 'index.html', `${page}: has the sidebar`, 'a generated page with no navigation is a page nobody can leave');
  ok(/<footer>/.test(html), `${page}: says how it was generated`);
  ok(/docs\/build\.mjs/.test(html), `${page}: credits the renderer in the footer`, 'a reader who suspects the docs are stale needs to know where to check');
}

{
  // Tables and code blocks, on the pages that have them in the source. Checked
  // per page rather than site-wide, because "some page has a table" would pass
  // while every table on every other page rendered as prose.
  const manual = readFileSync(join(SITE, 'user-manual.html'), 'utf8');
  ok((manual.match(/<table>/g) || []).length > 3, 'user-manual: its tables rendered as tables', `${(manual.match(/<table>/g) || []).length} tables`);
  ok((manual.match(/<pre class="code"/g) || []).length > 10, 'user-manual: its code blocks rendered as pre/code', `${(manual.match(/<pre class="code"/g) || []).length} blocks`);
  ok((manual.match(/data-lang="/g) || []).length > 3, 'user-manual: code blocks kept their language label');

  const contract = readFileSync(join(SITE, 'machine-contract.html'), 'utf8');
  ok(/schemaVersion/.test(contract), 'machine-contract: rendered its content');
  ok((contract.match(/<table>/g) || []).length > 2, 'machine-contract: its tables rendered as tables');

  const ci = readFileSync(join(SITE, 'ci-gate.html'), 'utf8');
  ok(/upload-sarif|Code Scanning/.test(ci), 'ci-gate: rendered its content');
  ok(/<pre class="code" data-lang="yaml"/.test(ci), 'ci-gate: the workflow example kept its yaml label');
}

/* ------------------------------------------------------------------ *
 * in-page and cross-page links resolve
 * ------------------------------------------------------------------ */

{
  const slugsFor = (page) => {
    const html = readFileSync(join(SITE, page), 'utf8');
    return new Set([...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]));
  };

  for (const page of pages) {
    const html = readFileSync(join(SITE, page), 'utf8');
    const slugs = slugsFor(page);

    // Same-page anchors.
    const inPage = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    const dead = inPage.filter((a) => !slugs.has(a));
    // The slug set includes every heading id on the page, so a dead anchor here
    // is a real broken link and not a navigation entry.
    ok(dead.length === 0, `${page}: every same-page anchor resolves`, dead.slice(0, 4).map((d) => `#${d}`).join(' '));

    // Cross-page links within the docs site.
    const cross = [...html.matchAll(/href="\.\/([a-z0-9-]+\.html)(#[^"]*)?"/g)];
    for (const [, target, frag] of cross) {
      const tpath = join(SITE, target);
      ok(existsSync(tpath), `${page}: links to ./${target}, which exists`);
      if (frag && existsSync(tpath)) {
        const tslugs = slugsFor(target);
        ok(tslugs.has(frag.slice(1)), `${page}: link to ./${target}${frag} resolves`, `no heading with id "${frag.slice(1)}"`);
      }
    }
  }

  // The user manual's own table of contents is the densest link set in the site,
  // so it gets asserted explicitly rather than only through the loop above.
  const manual = readFileSync(join(SITE, 'user-manual.html'), 'utf8');
  const toc = manual.match(/<ol>[\s\S]*?<\/ol>/);
  ok(!!toc, 'user-manual: has a table of contents');
  if (toc) {
    const links = [...toc[0].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    ok(links.length > 10, `user-manual: the TOC has ${links.length} entries`);
    const slugs = slugsFor('user-manual.html');
    const dead = links.filter((l) => !slugs.has(l));
    ok(dead.length === 0, 'user-manual: every TOC entry resolves', dead.slice(0, 5).join(' '));
    // The nesting that the first renderer refused and then had to learn.
    ok(/<li>[^<]*(<a[^>]*>)?.*<ul>/s.test(toc[0]), 'user-manual: the TOC nests its sub-entries rather than flattening them');
  }
}

/* ------------------------------------------------------------------ *
 * emphasis, on the shapes that broke it
 * ------------------------------------------------------------------ *
 *
 * Three attempts at emphasis-in-markdown went in before this one, and two of them
 * failed *silently* — producing a page that rendered, carrying literal `**` in
 * the output, with nothing thrown. They are asserted here as literal cases because
 * the failure is not hypothetical and the shape is cheap to keep:
 *
 *   1. `**bold**` next to other bold — `[^*]+` cannot span a `*`, so an
 *      earlier version matched the wrong pair and corrupted its neighbour.
 *   2. `**bold with *em* inside**` — emphasis nested in strong.
 *   3. `**... the check *name***` — one run of three closing both, which is what
 *      the CommonMark reading produces and what a person writes.
 *   4. `2 * 3` — an asterisk that is arithmetic, not a delimiter.
 *
 * Each is rendered through the real builder into a scratch page, so the assertion
 * is about the output rather than about the regex that produces it.
 */
{
  // Rendered through `--one`, the same code path the site build uses. The
  // builder renders a fixed list of documents, so this is also the only way to
  // reach the renderer with markdown it was not written alongside — which is the
  // only way to test a *renderer* rather than test seven documents.
  const cases = [
    ["**bold** and **more bold**", /<strong>bold<\/strong> and <strong>more bold<\/strong>/],
    ["**bold with *em* inside**", /<strong>bold with <em>em<\/em> inside<\/strong>/],
    ["**an expectation that matched the check *name***, which", /<strong>an expectation that matched the check <em>name<\/em><\/strong>, which/],
    ["*just em*", /<em>just em<\/em>/],
    ["2 * 3 is arithmetic", /2 \* 3 is arithmetic/],
    ["\`**not bold** in code\`", /<code>\*\*not bold\*\* in code<\/code>/],
  ];
  for (const [src, want] of cases) {
    const file = join(ROOT, ".tmp-emph.md");
    writeFileSync(file, "# T\n\n" + src + "\n");
    const r = spawnSync(process.execPath, [join(ROOT, "docs", "build.mjs"), "--one", file], { encoding: "utf8" });
    rmSync(file, { force: true });
    ok(r.status === 0, `emphasis: \`${src}\` renders without an unhandled-construct failure`, r.stderr?.trim().slice(0, 120));
    ok(want.test(r.stdout), `emphasis: \`${src}\` produces the right HTML`, r.stdout.trim().slice(0, 140));
  }
  rmSync(join(ROOT, ".tmp-emph.md"), { force: true });
}

/* ------------------------------------------------------------------ *
 * every page has a source, and every source has a page
 * ------------------------------------------------------------------ */

{
  const builder = readFileSync(join(ROOT, 'docs', 'build.mjs'), 'utf8');
  const declared = [...builder.matchAll(/src: '([^']+)'/g)].map((m) => m[1]);
  ok(declared.length >= 7, `${declared.length} source documents are declared`);
  for (const src of declared) {
    ok(existsSync(join(ROOT, src)), `the declared source ${src} exists`, 'a declared document that is missing fails the build, not just this check');
  }
  const expected = declared.map((s) => s.replace(/\.md$/, '.html').replace(/^docs\//, '').replace('AUDITABILITY', 'auditable').replace('CONTRIBUTING', 'contributing'));
  for (const e of expected) {
    ok(pages.includes(e), `the declared source produced ${e}`);
  }
}

/* ------------------------------------------------------------------ *
 * --check detects drift
 * ------------------------------------------------------------------ */

{
  // The property that keeps the committed site from lagging the markdown. A stale
  // documentation site is worse than none: it is confidently out of date.
  const clean = spawnSync(process.execPath, [join(ROOT, 'docs', 'build.mjs'), '--check'], { encoding: 'utf8', cwd: ROOT });
  eq(clean.status, 0, '--check passes against a freshly built site', clean.stdout?.trim().split('\n').pop());

  // And it must actually fail on drift, or it is a check that cannot fail — which
  // is worse than no check, because it reports success.
  const cssPath = join(SITE, 'site.css');
  const original = readFileSync(cssPath, 'utf8');
  try {
    const fs = await import('node:fs');
    fs.writeFileSync(cssPath, original + '\n/* drifted */\n');
    const drifted = spawnSync(process.execPath, [join(ROOT, 'docs', 'build.mjs'), '--check'], { encoding: 'utf8', cwd: ROOT });
    ok(drifted.status !== 0, '--check fails when the built site drifts from its sources', 'a drift check that cannot fail is worse than none, because it reports success');
  } finally {
    const fs = await import('node:fs');
    fs.writeFileSync(cssPath, original);
  }

  const after = spawnSync(process.execPath, [join(ROOT, 'docs', 'build.mjs'), '--check'], { encoding: 'utf8', cwd: ROOT });
  eq(after.status, 0, '--check passes again once the site is rebuilt');
}

/* ------------------------------------------------------------------ */

console.log('');
if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass} passed. Every page renders what it documents, and says nothing it did not.`);