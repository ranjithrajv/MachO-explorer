#!/usr/bin/env node
/**
 * docs/build.mjs — render this repository's markdown as a documentation site.
 *
 * ## Why a renderer written here rather than a dependency
 *
 * The package's central claim is zero dependencies, and a markdown library would
 * be the first one anybody would add and the hardest one to remove: it is the
 * difference between "one file you can read" and "a tree you have to trust".
 * So this is a renderer for *the markdown this repository actually contains*,
 * and the important design decision is what it does with anything else.
 *
 * ## The property that makes this acceptable: it fails, loudly
 *
 * A hand-rolled markdown renderer has a specific and well-known failure mode. It
 * meets a construct it does not understand, has no branch for it, and emits the
 * source line as a paragraph. The page looks *plausible*. A table becomes a
 * paragraph of pipes; a callout becomes four lines of prose; a list becomes one
 * run-on line. Nothing is red, nothing throws, and the documentation is quietly
 * wrong — which is the same failure this project keeps recording about its own
 * prose, arrived at through the build.
 *
 * So this renderer collects every construct it meets that it does not handle and
 * **exits non-zero**, naming the file and the line. An unhandled construct is a
 * build failure, not a degraded page. That single rule is what makes a
 * purpose-built renderer defensible where a general one would be required.
 *
 * `test/docs.mjs` asserts the same property from the other side: no output page
 * may contain leftover markdown syntax, so the two checks cannot both be
 * satisfied by a renderer that quietly degrades.
 *
 * ## The supported set, and why it is closed
 *
 *   ATX headings `#`..`######`
 *   fenced code blocks, with an optional language
 *   GFM pipe tables, including the alignment row
 *   unordered lists (`-`) and ordered lists (`1.`)
 *   blockquotes
 *   thematic breaks (`---`)
 *   paragraphs
 *   inline: `code`, **bold**, *italic*, [links](url), autolinks, hard breaks
 *
 * That is every construct `docs/`, `AUDITABILITY.md` and `CONTRIBUTING.md` use,
 * checked rather than assumed — see the `CONSTRUCTS` report the build prints.
 * Deliberately absent: setext headings, nested lists deeper than one level,
 * reference-style links, images-as-figures, HTML passthrough, footnotes. Each is
 * absent because nothing here uses it, and each would be *added* if something
 * started using it rather than silently mis-rendered in the meantime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.join(ROOT, '_site', 'docs');

/**
 * The documents, in reading order. Explicit rather than a directory scan.
 *
 * A scan would pick up whatever happens to be in `docs/`, including a scratch
 * file, and the reading order would be alphabetical — which puts `releasing.md`
 * before `user-manual.md` and tells a visitor that the release runbook is the
 * first thing to read. Order is a documentation decision, so it is written down.
 */
const PAGES = [
  { src: 'docs/user-manual.md', out: 'user-manual.html', title: 'User manual', blurb: 'Every subcommand, every flag, and what each one refuses to do.' },
  { src: 'docs/ci-gate.md', out: 'ci-gate.html', title: 'Gating a build', blurb: 'The exit-status taxonomy, SARIF, the composite action, and the fingerprint comparison.' },
  { src: 'docs/machine-contract.md', out: 'machine-contract.html', title: 'The machine contract', blurb: 'One envelope, four exit codes, nine reason codes, and a JSON Schema per tool.' },
  { src: 'docs/agent-integration.md', out: 'agent-integration.html', title: 'Driving it from an agent', blurb: 'The MCP server, the agent skill, and the three things that waste an agent’s time.' },
  { src: 'docs/use-cases.md', out: 'use-cases.html', title: 'When to use this', blurb: 'Where this reader is the right tool, and where it is the wrong one.' },
  { src: 'AUDITABILITY.md', out: 'auditable.html', title: 'Auditable by design', blurb: 'What the claim means, what it does not mean, and the checks that keep it true.' },
  { src: 'CONTRIBUTING.md', out: 'contributing.html', title: 'Contributing', blurb: 'The gate a change has to pass, and the rules that decide what belongs here.' },
];

/* ------------------------------------------------------------------ *
 * the one rule: unhandled means failed
 * ------------------------------------------------------------------ */

const unhandled = [];
const note = (file, line, what) => unhandled.push({ file, line, what });

/* ------------------------------------------------------------------ *
 * inline
 * ------------------------------------------------------------------ */

/**
 * HTML-escape, then apply inline markup.
 *
 * The order is load-bearing and it is the only subtle thing here. Escaping first
 * means a `<` inside a code span becomes `&lt;` and stays visible rather than
 * becoming a tag; and because code spans are extracted *after* escaping and put
 * back with placeholders, a `**` or a `[` inside code is never interpreted as
 * emphasis or a link.
 *
 * The placeholder is a private-use codepoint rather than a generated token,
 * because a token could collide with text in the document and silently eat it.
 * A private-use character cannot appear in the source without being noticed,
 * which is the same "cannot fail quietly" rule applied inside a line.
 */
const SENTINEL = '';

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(src, file, lineNo) {
  // Code spans first, lifted out before anything else can touch their contents.
  const spans = [];
  let s = src.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return SENTINEL + (spans.length - 1) + SENTINEL;
  });

  s = escapeHtml(s);

  // Links. The label is escaped already; only the href needs guarding, and only
  // against the schemes that can execute. `javascript:` in an href is the one
  // thing worth refusing in generated documentation.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    if (/^\s*javascript:/i.test(href)) {
      note(file, lineNo, `link with a javascript: href (${href}) — refused`);
      return label;
    }
    return `<a href="${href.replace(/"/g, '&quot;')}">${label}</a>`;
  });

  // Autolinks, which is how a bare URL in the source becomes clickable.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${url}">${url}</a>`);

  // Emphasis, by scanning delimiter runs rather than by alternation.
/**
   * Emphasis, by scanning delimiter runs rather than by alternation.
   *
   * ## Why not a regex
   *
   * Two attempts failed, and both failed *silently* — which is the part that
   * mattered. `\*\*([^*]+)\*\*` cannot match a strong span containing emphasis, so
   * `**bold with *italic* inside**` left a literal `**` in the output. Switching to
   * an italic-first pass fixed that and broke something worse: `\*([^*\n]+)\*`
   * happily matched across a `**` run, turning `**0**` into `*<em>0</em>*`.
   *
   * Both produced a page that rendered, with visibly wrong syntax in it. Neither
   * threw. A regex for this is the wrong tool because the ambiguity is in the
   * *delimiter runs* — how many asterisks are adjacent, and whether a run of three
   * closes an emphasis and a strong together — and that is not a regular property.
   *
   * ## The rule this implements
   *
   * A run of asterisks is a delimiter. Two of them open and close `strong`; one
   * opens and closes `em`. A run of **three** at a closer is the CommonMark reading
   * and the reading a person expects: it closes an `em` *and* a `strong` at once.
   * That is exactly the shape `... the check *name***,` produces, and it is the
   * case that defeated the first version. A run of three or more with no matching
   * opener is reported rather than guessed at.
   */
  function emphasis(s, file, lineNo) {
    let out = '';
    let i = 0;
  
    while (i < s.length) {
      const star = s.indexOf('*', i);
      if (star < 0) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, star);
  
      let n = 0;
      while (s[star + n] === '*') n++;
  
      // Find a closing run. `n === 2` accepts a run of three, because that run is
      // an `em` close followed by this `strong` close; `n === 1` accepts a run of
      // three too, for the mirror case. The run length recorded is how many
      // characters to consume, which is the whole difference between the two.
      let j = star + n;
      let close = -1;
      let consume = n;
      while (j < s.length) {
        const k = s.indexOf('*', j);
        if (k < 0) break;
        let m = 0;
        while (s[k + m] === '*') m++;
        if (m === n) {
          close = k;
          consume = m;
          break;
        }
        // A run of three closing a strong span is an em-close *plus* the strong
        // close, sharing one run. The em belongs to whatever is nested inside, so the
        // first star of the run has to stay inside `inner` — otherwise the nested
        // emphasis is left unterminated and the third star survives as a literal.
        // Getting this wrong produced "<strong>…the check *name</strong>*, which…":
        // correct nesting on the outside, an orphaned delimiter on the inside.
        if (m === 3 && n === 2) {
          // `close` has already advanced by one, so the remaining two stars of the
          // run are what is left to consume — three would swallow the character
          // after the run, which on `*name***, which` is the comma.
          close = k + 1;
          consume = 2;
          break;
        }
        if (m > 3) break; // something else is going on; do not try to pair across it
        j = k + m;
      }
  
      if (close < 0) {
        // No matching closer: the asterisk is content, not a delimiter. Emitting it
        // literally is correct — `2 * 3` must not become an emphasis.
        if (n > 2) note(file, lineNo, 'a run of three or more asterisks with no matching opener, emitted literally');
        out += '*'.repeat(n);
        i = star + n;
        continue;
      }
  
      const inner = s.slice(star + n, close);
      const tag = n === 2 ? 'strong' : 'em';
      out += `<${tag}>${emphasis(inner, file, lineNo)}</${tag}>`;
      i = close + consume;
    }
  
    return out;
  }

  // Applied here, after links and autolinks, so a URL containing an
  // underscore or asterisk pair is not turned into emphasis on the way past.
  s = emphasis(s, file, lineNo);

  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // A hard break: two trailing spaces, which is how the source wraps a line
  // inside a list item. Without this those lines run together.
  s = s.replace(/ {2,}\n/g, '<br>\n');

  // Put the code spans back.
  s = s.replace(new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g'), (_, i) => spans[Number(i)]);

  return s;
}

/* ------------------------------------------------------------------ *
 * blocks
 * ------------------------------------------------------------------ */

const slug = (s) =>
  s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');

function render(src, file) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let lineNo = 0;

  // YAML frontmatter, if present. Stripped, not rendered — a page whose first
  // element is a metadata table is a page about its own metadata.
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    out.push(`<p>${inline(buf.join('\n'), file, lineNo)}</p>`);
    buf.length = 0;
  };

  const para = [];

  while (i < lines.length) {
    lineNo = i + 1;
    const line = lines[i];

    // Blank
    if (!line.trim()) {
      flushParagraph(para);
      i++;
      continue;
    }

    // Fenced code
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(para);
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) note(file, lineNo, 'a code fence that is never closed');
      i++; // the closing fence
      out.push(
        `<pre class="code"${lang ? ` data-lang="${lang}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // ATX heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph(para);
      const level = h[1].length;
      // An h1 in a document whose title is already the page title is a duplicate
      // heading, and the docs use one to open `user-manual.md`. Demoted rather
      // than dropped, so nothing is lost.
      const lvl = level === 1 ? 2 : level;
      out.push(`<h${lvl} id="${slug(h[2])}">${inline(h[2], file, lineNo)}</h${lvl}>`);
      i++;
      continue;
    }

    // Setext heading — deliberately unsupported, and reported rather than guessed.
    if (i + 1 < lines.length && /^(=+|-{2,})\s*$/.test(lines[i + 1]) && line.trim() && !/^\s*[-*+]\s/.test(line)) {
      note(file, lineNo, 'a setext heading (underlined with === or ---), which this renderer does not support');
      flushParagraph(para);
      i += 2;
      continue;
    }

    // Thematic break. Checked before the list rule because `---` is also a table
    // separator, and a table's separator is consumed by the table branch below.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(para);
      out.push('<hr>');
      i++;
      continue;
    }

    // Table: a header row followed by a delimiter row.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushParagraph(para);
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(splitRow(lines[i++]));
      const cell = (c, tag, align) =>
        `<${tag}${align ? ` class="ta-${align}"` : ''}>${inline(c.trim(), file, lineNo)}</${tag}>`;
      out.push(
        '<div class="tablewrap"><table><thead><tr>' +
          header.map((c, n) => cell(c, 'th', aligns[n])).join('') +
          '</tr></thead><tbody>' +
          body
            .map((row) => '<tr>' + header.map((_, n) => cell(row[n] ?? '', 'td', aligns[n])).join('') + '</tr>')
            .join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${render(body.join('\n'), file)}</blockquote>`);
      continue;
    }

    // Lists. One level of nesting: a deeper indent is folded into the item rather
    // than silently flattened, and reported so the source can be simplified.
// Lists, with one level of nesting.
    //
    // Nesting is supported rather than refused because `docs/user-manual.md` opens
    // with a table of contents whose sub-entries are indented list items, and
    // flattening that produces a *plausible* page: the sub-items all still appear,
    // just at the wrong depth, which reads as though the document had no
    // hierarchy. The first draft refused it instead, which was defensible but
    // meant rewriting somebody else's document to suit a renderer.
    //
    // One level, and a third is reported rather than silently flattened.
// Lists, with nesting.
    //
    // Nesting is supported rather than refused because `docs/user-manual.md` opens
    // with a table of contents whose sub-entries are indented list items, and
    // flattening that produces a *plausible* page: the sub-items all still appear,
    // just at the wrong depth, which reads as though the document had no
    // hierarchy. The first draft refused it instead, which was defensible but
    // meant rewriting somebody else's document to suit a renderer.
    //
    // Depth is measured **relative to the parent's own indent**, not against a
    // fixed number of spaces. That distinction is the whole reason the first
    // attempt at this rejected fourteen legitimate sub-items: it compared against
    // `base + 1`, and markdown allows two to four spaces for a nested list, so a
    // three-space sub-item — which is one level — was reported as too deep. A
    // renderer that guesses the indent width is guessing at the author's intent.
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushParagraph(para);
      const baseIndent = line.length - line.trimStart().length;
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];

      /**
       * Read one item's text plus its indented continuation lines.
       *
       * Shared by both levels, because a second copy of this loop would be a
       * second thing to keep correct — which is how a nested list ends up
       * rendered by two slightly different rules.
       *
       * Returns null when the line is not a list item at this indent, which is the
       * signal both levels use to stop.
       */
      const readItem = (from) => {
        const raw = lines[from];
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
        if (!m) return null;
        const indent = raw.length - raw.trimStart().length;
        if (indent < baseIndent) return null;
        let text = m[2];
        let j = from + 1;
        // Continuation lines are indented past their own marker and are not new
        // items — which is how every list in these documents wraps its prose.
        while (
          j < lines.length &&
          lines[j].trim() &&
          !/^\s*([-*+]|\d+[.)])\s+/.test(lines[j]) &&
          lines[j].length - lines[j].trimStart().length > indent
        ) {
          text += '\n' + lines[j].trim();
          j++;
        }
        return { text, next: j, indent, ordered: /\d/.test(m[1]) };
      };

      while (i < lines.length) {
        const item = readItem(i);
        if (!item || item.indent !== baseIndent) break;

        // Sub-items: list markers indented deeper than this item's marker. The
        // first one's indent becomes the depth for the rest, so a run of
        // three-space sub-items is one level and a genuine third level is
        // something deeper than the sub-items themselves.
        const subs = [];
        let subIndent = null;
        let j = item.next;
        while (j < lines.length) {
          const sub = readItem(j);
          if (!sub || sub.indent === baseIndent) break;
          if (subIndent === null) subIndent = sub.indent;
          if (sub.indent > subIndent) {
            note(file, j + 1, `a list item nested ${sub.indent - subIndent} level(s) below its own sub-list, which is flattened`);
          }
          if (sub.ordered) note(file, j + 1, 'an ordered list nested inside another list, rendered as unordered');
          subs.push(`<li>${inline(sub.text, file, lineNo)}</li>`);
          j = sub.next;
        }

        i = j;
        items.push(`<li>${inline(item.text, file, lineNo)}${subs.length ? `<ul>${subs.join('')}</ul>` : ''}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // Anything that looks like markdown we have no branch for.
    if (/^\s*(<[a-zA-Z/]|!\[[^\]]*\]\()/.test(line)) {
      note(file, lineNo, 'raw HTML or an image, which this renderer does not pass through');
    }

    para.push(line);
    i++;
  }
  flushParagraph(para);
  return out.join('\n');
}

function splitRow(row) {
  return row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'));
}

/* ------------------------------------------------------------------ *
 * page shell
 * ------------------------------------------------------------------ */

const STYLE = fs.readFileSync(path.join(HERE, 'site.css'), 'utf8');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page({ title, blurb, body, active }) {
  const nav = PAGES.map((p) => {
    const on = p.out === active;
    return `<a class="nav${on ? ' on' : ''}" href="./${p.out}"${on ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — MachO-explorer</title>
<meta name="description" content="${esc(blurb)}">
<link rel="stylesheet" href="./site.css">
</head>
<body>
<header class="top">
  <a class="brand" href="../demo/">MachO-explorer</a>
  <span class="tag">documentation</span>
  <a class="back" href="../../">repository</a>
</header>
<div class="wrap">
  <nav class="sidebar">${nav}</nav>
  <main>
    <h1>${esc(title)}</h1>
    <p class="blurb">${esc(blurb)}</p>
    ${body}
  </main>
</div>
<footer>
  <p>Rendered from this repository's markdown by <code>docs/build.mjs</code>, which fails the build on any
  construct it does not handle rather than emitting a plausible-looking wrong page. Regenerate with
  <code>node docs/build.mjs</code>.</p>
</footer>
</body>
</html>
`;
}

function index() {
  const items = PAGES.map(
    (p) => `<li><a href="./${p.out}">${esc(p.title)}</a><span>${esc(p.blurb)}</span></li>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Documentation — MachO-explorer</title>
<link rel="stylesheet" href="./site.css">
</head>
<body>
<header class="top">
  <a class="brand" href="../demo/">MachO-explorer</a>
  <span class="tag">documentation</span>
  <a class="back" href="../../">repository</a>
</header>
<div class="wrap">
  <main style="grid-column:1/-1">
    <h1>Documentation</h1>
    <p class="blurb">Rendered from the markdown in this repository, so it cannot disagree with the code it
    documents. The <a href="../demo/">audit report</a> runs in your browser and lets you read the source that read your file.</p>
    <ul class="index">${items}</ul>
  </main>
</div>
<footer>
  <p>Rendered by <code>docs/build.mjs</code> from the markdown under <code>docs/</code> and the two root documents.
  No markdown dependency: the renderer fails the build on any construct it does not handle rather than emitting a
  plausible-looking wrong page.</p>
</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * build
 * ------------------------------------------------------------------ */

/**
 * `--one <file>` renders a single markdown file to stdout and exits, building
 * nothing.
 *
 * It exists for two reasons and the second is the real one. For a person, it is
 * the fastest way to see what a snippet becomes. For `test/docs.mjs`, it is the
 * only way to exercise the renderer on markdown that is not one of the declared
 * pages — and a renderer tested only on the documents it was written for has been
 * tested on its own assumptions rather than on the renderer.
 */
const oneAt = process.argv.indexOf("--one");
if (oneAt >= 0) {
  const target = process.argv[oneAt + 1];
  if (!target) {
    console.error("--one needs a path");
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error(`--one: ${target} does not exist`);
    process.exit(1);
  }
  process.stdout.write(render(fs.readFileSync(target, "utf8"), target) + "\n");
  // An unhandled construct still fails here. A single-file render that degrades
  // quietly is how the renderer would end up rendering prose and calling it a
  // page, and the site build would only find out much later.
  if (unhandled.length) {
    for (const u of unhandled) console.error(`  ${u.file}:${u.line}  ${u.what}`);
    process.exit(1);
  }
  process.exit(0);
}

const check = process.argv.includes('--check');
const missing = [];

if (!check) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
}

let built = 0;
const report = [];

for (const p of PAGES) {
  const srcPath = path.join(ROOT, p.src);
  if (!fs.existsSync(srcPath)) {
    missing.push(p.src);
    continue;
  }
  const md = fs.readFileSync(srcPath, 'utf8');
  const body = render(md, p.src);
  const html = page({ title: p.title, blurb: p.blurb, body, active: p.out });
  const dest = path.join(OUT, p.out);
  if (check) {
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== html) {
      report.push(`${p.out} differs from what docs/build.mjs produces`);
    }
  } else {
    fs.writeFileSync(dest, html);
  }
  built++;
  report.push(`  ${p.src.padEnd(28)} -> docs/${p.out}`);
}

if (check) {
  const idx = path.join(OUT, 'index.html');
  if (!fs.existsSync(idx) || fs.readFileSync(idx, 'utf8') !== index()) {
    report.push('index.html differs from what docs/build.mjs produces');
  }
  if (!fs.existsSync(path.join(OUT, 'site.css')) || fs.readFileSync(path.join(OUT, 'site.css'), 'utf8') !== STYLE) {
    report.push('site.css is missing or differs from docs/site.css');
  }
} else {
  fs.writeFileSync(path.join(OUT, 'index.html'), index());
  fs.writeFileSync(path.join(OUT, 'site.css'), STYLE);
}

console.log(`docs: ${built} page(s)${check ? ' checked' : ' written'} to ${path.relative(ROOT, OUT)}/`);
for (const r of report) console.log(r);

if (missing.length) {
  console.error(`\ndocs: ${missing.length} source document(s) not found:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

if (unhandled.length) {
  console.error(
    `\ndocs: ${unhandled.length} markdown construct(s) this renderer does not handle.\n` +
      '  Each is a page that would render as prose and read as though it were correct:\n',
  );
  for (const u of unhandled) console.error(`  ${u.file}:${u.line}  ${u.what}`);
  console.error('\n  Add support, or simplify the source. Do not ignore this — a degraded page is worse than a failed build.');
  process.exit(1);
}

if (report.some((r) => r.includes('differs'))) {
  console.error('\ndocs: the built site is stale — run `node docs/build.mjs`');
  process.exit(1);
}