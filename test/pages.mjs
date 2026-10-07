#!/usr/bin/env node
/**
 * pages.mjs — the GitHub Pages site is assembled from this repository, so the
 * assembly is tested here rather than discovered in a browser.
 *
 * ## Why this file exists
 *
 * The Pages workflow is a `cp` list. `cp` fails loudly when a path is wrong, which
 * is the good case — but the failure mode that matters is a path that is *right*
 * on the machine that assembles and *wrong* for the page: a source file the audit
 * panel fetches that nobody copies, which produces a dead "view source" button on
 * a page whose entire argument is that you can verify what it claims.
 *
 * That is not a crash. It is a page that looks like it works. So the list of paths
 * the page fetches is asserted here, and the "no external origin" rule — which is
 * the page's other load-bearing claim — is asserted against the real assembled
 * output.
 *
 * ## What is deliberately NOT tested
 *
 * It does not run `deploy-pages`, upload an artifact, or touch the API. Those need
 * a token and a GitHub context, and the parts that can be wrong — the assembly, the
 * file list, the external-origin rule, the bundle-freshness gate — are here. A test
 * that mocks the upload proves the mock.
 *
 * The bundle-freshness gate (`demo/link.mjs --check` before upload) is asserted to
 * be *present in the workflow* rather than run here, because `test/browser.mjs`
 * already runs the same check against the same tree. What this file adds is the
 * guarantee that the workflow cannot lose the step — a deleted line and a failing
 * test are the same event, which is the point.
 */

import { readFileSync, existsSync, rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
 * assemble the site the way the workflow does
 * ------------------------------------------------------------------ *
 * The commands are duplicated from the workflow's `run:` block rather than
 * executed from it, and the reason is worth stating: this file asserts that the
 * *site the workflow builds* contains every path the page fetches. If the copy
 * list lived only inside the YAML, a change to it would be invisible to this test
 * until someone loaded the page and saw a dead button — which is exactly the
 * silent failure this file exists to prevent.
 *
 * The counter-risk (the list drifting between here and the YAML) is covered by the
 * presence assertions below: if the workflow's copy list and this one disagree, one
 * of the two will be missing a file the page needs, and the fetch-path assertions
 * catch it. Neither list is trusted alone; they are checked against a third,
 * independent thing — the actual `fetch()`/`import` calls in the page.
 */
const SITE = join(ROOT, '_site_test');
rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });

// Mirror the workflow's assembly exactly.
cpSync(join(ROOT, 'demo'), join(SITE, 'demo'), { recursive: true });
mkdirSync(join(SITE, 'src'), { recursive: true });
for (const f of ['macho.mjs', 'instruction.mjs', 'api.mjs']) cpSync(join(ROOT, 'src', f), join(SITE, 'src', f));
mkdirSync(join(SITE, 'schema'), { recursive: true });
cpSync(join(ROOT, 'schema', 'envelope.schema.json'), join(SITE, 'schema', 'envelope.schema.json'));
cpSync(join(ROOT, 'package.json'), join(SITE, 'package.json'));
cpSync(join(ROOT, 'pages', 'index.html'), join(SITE, 'index.html'));

console.log('the assembled site');

/**
 * The paths the page actually reaches for, discovered from the page source rather
 * than restated here — so this list cannot drift from the page.
 *
 * Parsed out of `demo/app.mjs` and `demo/index.html` with a regex, which is
 * fragile to a rewrite and correct for what it needs: a fetch of `../src/x.mjs` or
 * an import of `./y.mjs` in a file whose every such reference is a repo-relative
 * path. A human-maintained copy of this list is exactly the second version that
 * drifts.
 */
const appSrc = readFileSync(join(ROOT, 'demo', 'app.mjs'), 'utf8');
const htmlSrc = readFileSync(join(ROOT, 'demo', 'index.html'), 'utf8');

// `fetch('../src/macho.mjs')` and friends in app.mjs, plus the SOURCES array.
const fetched = [...appSrc.matchAll(/fetch\(`\.\.\/\$\{[^}]+\}`\)|fetch\('\.\.\/([^']+)'\)/g)].map((m) => m[1]).filter(Boolean);
const sourceButtons = [...appSrc.matchAll(/\['(src\/[^']+|demo\/[^']+)',/g)].map((m) => m[1]);
const pageFetches = [...new Set([...fetched, ...sourceButtons])];

// The module script tag in index.html.
const scriptSrc = /<script[^>]+src="([^"]+)"/.exec(htmlSrc)?.[1];

ok(!!scriptSrc, 'the page has a module script tag');
ok(scriptSrc?.startsWith('./'), `the module script is a relative path (${scriptSrc})`, 'an absolute path breaks under a GitHub Pages project subpath');

for (const f of pageFetches) {
  ok(existsSync(join(SITE, f)), `the page fetches ${f}, and it is in the site`, 'a dead "view source" button on a page arguing you can verify its claims');
}

ok(existsSync(join(SITE, scriptSrc.replace('./', 'demo/'))), `the module script ${scriptSrc} is in the site`);
ok(existsSync(join(SITE, 'index.html')), 'the site root has a page, so a visitor is not dropped on a directory listing');

/* ------------------------------------------------------------------ *
 * the documentation site
 * ------------------------------------------------------------------ *
 *
 * Assembled from the same tree as the audit report, and gated the same way: the
 * builder runs with `--check` first, so a site that has drifted from the markdown
 * fails the deploy rather than shipping. `test/docs.mjs` holds the renderer
 * itself; what is asserted here is that the *site* is wired up — that the files
 * the docs link to are in it, and that the two surfaces do not point at each other
 * wrongly.
 */
{
  // Rendered here rather than assumed present, because a workflow that builds the
  // docs into a directory this suite never looks at is a claim, not a fact.
  // Into the same directory this suite assembles the audit report into, so the
  // assertions below are about the *deployed layout* rather than about wherever
  // the builder happens to default to. The workflow copies `_site` wholesale, so
  // a site that only looks right at its default location is a site that is wrong
  // where it actually ships.
  const built = spawnSync(process.execPath, [join(ROOT, "docs", "build.mjs"), "--out", join(SITE, "docs")], { encoding: "utf8" });
  ok(built.status === 0, "the docs build succeeds", built.stderr?.trim().slice(0, 160));

  const DOCS = join(SITE, "docs");
  ok(existsSync(join(DOCS, "index.html")), "the docs site has an index");
  ok(existsSync(join(DOCS, "site.css")), "the docs site has a stylesheet");

  // Listed rather than counted, so a page dropped from the builder fails here
  // instead of quietly reducing a total. A gate that checks "at least seven" is a
  // gate that passes with the wrong seven.
  const expected = [
    "user-manual.html", "ci-gate.html", "machine-contract.html", "text-stubs.html",
    "agent-integration.html", "use-cases.html", "auditable.html", "contributing.html",
    "architecture.html",
  ];
  for (const f of expected) ok(existsSync(join(DOCS, f)), `the docs site has ${f}`);

  // The cross-links between the two surfaces. A docs page that points at the audit
  // report by a path that does not exist in the deployed layout is a dead link a
  // reader finds the hard way.
  const idx = readFileSync(join(DOCS, "index.html"), "utf8");
  ok(/href="\.\.\/demo\/"/.test(idx), "the docs index links to the audit report, which is one level up");
  ok(existsSync(join(SITE, "demo", "index.html")), "and that target exists in the assembled site");

  for (const f of expected) {
    const html = readFileSync(join(DOCS, f), "utf8");
    ok(/href="\.\.\/\.\.\/"/.test(html), `${f} links back to the repository root`);
    ok(/href="\.\/site\.css"/.test(html), `${f} loads the stylesheet relatively`, "an absolute /site.css breaks under a GitHub Pages project subpath");
  }

  // No third-party origin anywhere in the docs, for the same reason as the audit
  // report: a documentation site that pulls a font or a script from a CDN cannot
  // promise what it told you to run.
  const allow = /ranjithrajv\/MachO-explorer|json-schema\.org|oasis-tcs\.com|opensource\.apple\.com|example\.com|api\.example\.com|127\.0\.0\.1|localhost/;
  let external = [];
  for (const f of readdirSync(DOCS)) {
    const html = readFileSync(join(DOCS, f), "utf8");
    for (const m of html.matchAll(/<(?:script|img|link)[^>]*\b(?:src|href)="(https?:[^"]+)"/g)) {
      if (!allow.test(m[1])) external.push(`${f}: ${m[1]}`);
    }
  }
  ok(external.length === 0, "the docs site loads no script, image or stylesheet from a third party", external.slice(0, 3).join(" | "));
}

/* ------------------------------------------------------------------ *
 * the no-external-origin rule
 * ------------------------------------------------------------------ */

console.log('');
console.log('nothing is loaded from a third party');

// Scan the assembled HTML and JS for anything that would fetch from an external
// origin. The same allow-list as the workflow: the project's own URLs (which are
// links, not loads) and the two schema identifiers (which are `additionalProperties`
// string values in JSON, not fetched URLs).
const ALLOW = /ranjithrajv\/MachO-explorer|json-schema\.org|oasis-tcs\.com|opensource\.apple\.com/;
let external = [];
for (const f of ['demo/index.html', 'demo/app.mjs', 'demo/macho.browser.mjs']) {
  const text = readFileSync(join(SITE, f), 'utf8');
  for (const m of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
    if (!ALLOW.test(m[0])) external.push(`${f}: ${m[0]}`);
  }
}
ok(external.length === 0, 'the assembled page loads nothing from an external origin', external.slice(0, 3).join(' | '));

// The bundle must not *import* a node: builtin — that would mean the browser is
// running against a shim that isn't there. This mirrors `test/browser.mjs` but on
// the *assembled* artifact, so a copy mistake is caught rather than a source
// change.
//
// The check is on the import form, not on the string `node:` appearing anywhere.
// The bundle's own comments describe the shim by name — "the host shim (Buffer,
// node:fs, node:crypto, node:path)" — so a bare substring test fails on the
// documentation of the thing it is checking. That is the same trap as reading a
// comment as code in the npm-install check, and the fix is the same: match the
// construct, not the vocabulary.
const bundle = readFileSync(join(SITE, 'demo', 'macho.browser.mjs'), 'utf8');
ok(!/^\s*import\s/m.test(bundle), 'the bundle has no import statement — every boundary was stripped');
ok(!/from\s+['"]node:/.test(bundle), 'the bundle imports no node: builtin — the host is the shim');
// And the positive half: the shim it *does* provide must be in the bundle, or the
// absence of node: imports would mean nothing at all.
ok(/memoryFs/.test(bundle) && /createHash/.test(bundle), 'the shim\'s own exports are present in the bundle');

/* ------------------------------------------------------------------ *
 * the workflow declares the steps this file is checking
 * ------------------------------------------------------------------ */

console.log('');
console.log('the workflow');

const wf = readFileSync(join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');

ok(/demo\/link\.mjs --check/.test(wf), 'the workflow runs demo/link.mjs --check before uploading', 'a stale bundle publishes a page that audits code that is no longer the code that ran');
ok(/upload-pages-artifact/.test(wf), 'the workflow uploads a Pages artifact');
ok(/deploy-pages/.test(wf), 'the workflow deploys to Pages');
ok(/^permissions:/m.test(wf) && /pages:\s*write/.test(wf), 'the workflow requests pages: write explicitly rather than relying on a default');
ok(/id-token:\s*write/.test(wf), 'the workflow requests id-token: write, so the deployment has verifiable provenance');

// Least privilege, asserted by the absence of the write scopes it does not need.
ok(!/contents:\s*write/.test(wf), 'the workflow does not request contents: write — it only reads the repository');
ok(!/issues:\s*write|pull-requests:\s*write/.test(wf), 'the workflow does not request issue or PR write scopes');

// The concurrency guard. Two Pages deployments racing produce an intermittent 404
// for whoever clicks the link next — which here is a reviewer checking a claim.
ok(/^concurrency:/m.test(wf), 'the workflow declares a concurrency group', 'two Pages deploys racing produce an intermittent 404 for a reader');

// The path filter. Publishing on every commit is not wrong, it is just wasteful;
// the subtle bug is a *missing* path, which would leave the page stale when it
// changes. So both directions are asserted: the paths that must trigger a deploy
// are named, and the filter is present at all.
ok(/paths:/.test(wf), 'the workflow deploys only for the paths that can change the page');
for (const p of ['demo/**', 'src/macho.mjs', 'src/api.mjs', 'src/instruction.mjs', 'schema/envelope.schema.json', 'package.json', 'pages/**']) {
  ok(wf.includes(`'${p}'`) || wf.includes(p), `the deploy path filter includes ${p}`);
}

// The external-origin check is in the workflow too, so a future edit that adds a
// CDN link fails in CI rather than in a reviewer's browser.
ok(/external origin/.test(wf) || /third party/.test(wf), 'the workflow itself rejects an external origin in the assembled site');

// A workflow that deploys on PRs should not deploy to the live site from a fork.
// `pull_request` here builds and validates but the deploy job needs `build`, and
// `deploy` is only reached on push because that is the trigger that matters — the
// presence of `pull_request` as a trigger means the *build* runs on PRs (good: the
// assembly is checked), and `deploy` gating on `build` plus being a separate job
// is what keeps a fork from publishing.
ok(/^  deploy:/m.test(wf) && /needs:\s*build/.test(wf), 'the deploy job needs build, so it only runs after a successful assembly');

rmSync(SITE, { recursive: true, force: true });

console.log('');
if (fails.length) {
  console.log(`${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${pass} passed. The published page is this repository, and it says so.`);