#!/usr/bin/env node
/**
 * build-viewer.mjs — generates docs/index.html, a self-contained viewer for
 * every .md file under docs/.
 *
 * Zero dependencies. Run it again whenever the docs change:
 *
 *   node docs/build-viewer.mjs
 *
 * Everything is inlined at build time (markdown is converted to HTML here, not
 * in the browser) so the result opens straight from the filesystem with no
 * server, no CDN, and no network.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(DOCS_DIR, 'index.html');

/* ══════════════════════════════════════════════════════════════════════════
   Markdown → HTML
   A focused converter for the constructs these docs actually use:
   headings, fenced code, tables, lists (incl. task lists), blockquotes,
   rules, and inline emphasis/code/links.
   ══════════════════════════════════════════════════════════════════════════ */

const NUL = '\u0000';

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline formatting. Code spans are extracted to placeholders first so that
 * emphasis and link syntax inside them is left alone.
 */
function inline(src) {
  let text = escapeHtml(src);
  const codes = [];

  text = text.replace(/(`+)([\s\S]*?)\1/g, (_, _ticks, body) => {
    codes.push(body.replace(/^ | $/g, ''));
    return `${NUL}C${codes.length - 1}${NUL}`;
  });

  // Links before emphasis, so bracket text can itself be emphasised.
  text = text.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const ext = /^https?:/i.test(href);
    const attrs = ext ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${href.replace(/"/g, '&quot;')}"${attrs}>${label}</a>`;
  });

  text = text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    // allow a single '*' inside bold so "**Not *if*.**" nests correctly,
    // while still stopping at the next '**'
    .replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return text.replace(new RegExp(`${NUL}C(\\d+)${NUL}`, 'g'), (_, i) => `<code>${codes[+i]}</code>`);
}

/** Split a table row on unescaped pipes, ignoring pipes inside code spans. */
function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode && body[i - 1] !== '\\') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isDelimRow = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');
const isFence = (l) => /^\s{0,3}```/.test(l);
const isHeading = (l) => /^#{1,6}\s+/.test(l);
const isHr = (l) => /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l);
const isListItem = (l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l);
const isQuote = (l) => /^\s{0,3}>/.test(l);

function slugify(text, seen) {
  let base = text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    // strip emoji / symbols
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!base) base = 'section';
  if (seen.has(base)) {
    const n = seen.get(base) + 1;
    seen.set(base, n);
    return `${base}-${n}`;
  }
  seen.set(base, 0);
  return base;
}

/* ── Severity extraction ────────────────────────────────────────────────────
   Headings in the hardening guide end with a rating, e.g.
     "### 3.1 The rules — CRITICAL"
   Only the final em-dash segment is inspected, so prose like "HIGH value" in
   the middle of a title never produces a false chip.                        */

const SEV_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function extractSeverity(text) {
  const idx = Math.max(text.lastIndexOf('—'), text.lastIndexOf(' - '));
  if (idx === -1) return { text, sev: null };

  const head = text.slice(0, idx).trimEnd();
  const tail = text.slice(idx + (text[idx] === '—' ? 1 : 3)).trim();

  const match = tail.match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/);
  if (!match) return { text, sev: null };

  const sev = match[1];
  // Strip the trailing segment only when the rating is the whole of it,
  // otherwise the remaining words ("verify only, LOW effort") would be mangled.
  const remainder = tail.replace(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/, '').replace(/^[\s,–-]+|[\s,–-]+$/g, '');
  return remainder ? { text, sev } : { text: head, sev };
}

/** Build nested <ul>/<ol> from a run of list lines. */
function renderList(lines) {
  const items = [];
  for (const raw of lines) {
    const m = raw.match(/^(\s*)((?:[-*+])|(?:\d+[.)]))\s+([\s\S]*)$/);
    if (m) {
      items.push({
        indent: m[1].replace(/\t/g, '    ').length,
        ordered: /\d/.test(m[2]),
        content: m[3],
      });
    } else if (items.length) {
      // continuation line belonging to the previous item
      items[items.length - 1].content += ' ' + raw.trim();
    }
  }
  if (!items.length) return '';

  const build = (start, indent) => {
    let html = '';
    let i = start;
    const ordered = items[start].ordered;
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) {
        const [sub, next] = build(i, items[i].indent);
        html = html.replace(/<\/li>$/, sub + '</li>');
        i = next;
        continue;
      }
      let content = items[i].content;
      let cls = '';
      const task = content.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === 'x';
        cls = ' class="task"';
        content = `<span class="task__box${checked ? ' is-done' : ''}" aria-hidden="true"></span><span class="task__label">${inline(task[2])}</span>`;
      } else {
        content = inline(content);
      }
      html += `<li${cls}>${content}</li>`;
      i++;
    }
    const tag = ordered ? 'ol' : 'ul';
    return [`<${tag}>${html}</${tag}>`, i];
  };

  return build(0, items[0].indent)[0];
}

function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const seen = new Map();
  const toc = [];
  const sevCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let out = '';
  let title = null;
  let i = 0;

  const flushInto = (html) => { out += html; };

  while (i < lines.length) {
    const line = lines[i];

    /* fenced code */
    if (isFence(line)) {
      const lang = line.trim().replace(/^`+/, '').trim();
      const body = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      const code = escapeHtml(body.join('\n'));
      const label = lang || 'text';
      flushInto(
        `<figure class="code" data-lang="${escapeHtml(label)}">` +
          `<figcaption class="code__bar">` +
            `<span class="code__lang">${escapeHtml(label)}</span>` +
            `<button class="code__copy" type="button">Copy</button>` +
          `</figcaption>` +
          `<pre><code>${code}</code></pre>` +
        `</figure>`
      );
      continue;
    }

    /* heading */
    if (isHeading(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      const level = m[1].length;
      const rawText = m[2].replace(/\s*#+\s*$/, '').trim();

      if (level === 1 && title === null) {
        title = rawText.replace(/[`*]/g, '');
        flushInto(`<h1 class="doc__title">${inline(rawText)}</h1>`);
        i++;
        continue;
      }

      const { text, sev } = extractSeverity(rawText);
      const id = slugify(text, seen);
      if (sev) sevCounts[sev]++;

      const chip = sev ? ` <span class="chip chip--${sev.toLowerCase()}">${sev}</span>` : '';
      flushInto(
        `<h${level} id="${id}" class="h h--${level}"${sev ? ` data-sev="${sev}"` : ''}>` +
          `<a class="h__anchor" href="#${id}" aria-label="Link to this section">#</a>` +
          `${inline(text)}${chip}` +
        `</h${level}>`
      );
      toc.push({ id, text: text.replace(/[`*_]/g, ''), level, sev });
      i++;
      continue;
    }

    /* horizontal rule */
    if (isHr(line)) {
      flushInto('<hr>');
      i++;
      continue;
    }

    /* table */
    if (line.includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return r && l ? 'center' : r ? 'right' : 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i++]));
      }
      // Spec-style tables often use an empty header row purely for layout;
      // rendering it produces a blank band, so drop the thead entirely.
      const hasHeader = header.some((c) => c.trim() !== '');
      const th = hasHeader
        ? '<thead><tr>' +
          header.map((c, n) => `<th style="text-align:${aligns[n] || 'left'}">${inline(c)}</th>`).join('') +
          '</tr></thead>'
        : '';
      const tb = rows
        .map(
          (r) =>
            `<tr>${r
              .map((c, n) => `<td style="text-align:${aligns[n] || 'left'}">${inline(c)}</td>`)
              .join('')}</tr>`
        )
        .join('');
      flushInto(`<div class="tablewrap"><table>${th}<tbody>${tb}</tbody></table></div>`);
      continue;
    }

    /* blockquote — rendered as a callout, keyed off its leading marker.
       Strictly '>'-prefixed: CommonMark lazy continuation is skipped on
       purpose so a following paragraph can never be swallowed. */
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      const inner = renderMarkdown(buf.join('\n')).html;
      const joined = buf.join(' ');
      let kind = 'note';
      if (/LOCKOUT RISK|⚠️/.test(joined)) kind = 'danger';
      else if (/BREAKS THINGS|💥/.test(joined)) kind = 'warn';
      flushInto(`<blockquote class="callout callout--${kind}">${inner}</blockquote>`);
      continue;
    }

    /* list */
    if (isListItem(line)) {
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !isFence(lines[i]) &&
        !isHeading(lines[i]) &&
        !isHr(lines[i]) &&
        (isListItem(lines[i]) || /^\s{2,}\S/.test(lines[i]))
      ) {
        buf.push(lines[i++]);
      }
      flushInto(renderList(buf));
      continue;
    }

    /* blank */
    if (line.trim() === '') {
      i++;
      continue;
    }

    /* paragraph */
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !isHr(lines[i]) &&
      !isQuote(lines[i]) &&
      !isListItem(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1]))
    ) {
      buf.push(lines[i++]);
    }
    const para = buf.join('\n').trim();
    if (para) {
      // A standalone ⚠️/💥 paragraph is a callout, not body copy.
      const danger = /^(⚠️|💥)/.test(para);
      if (danger) {
        const kind = para.startsWith('⚠️') ? 'danger' : 'warn';
        flushInto(`<div class="callout callout--${kind}"><p>${inline(para)}</p></div>`);
      } else {
        flushInto(`<p>${inline(para)}</p>`);
      }
    }
  }

  return { html: out, toc, title, sevCounts };
}

/* ══════════════════════════════════════════════════════════════════════════
   Collect documents
   ══════════════════════════════════════════════════════════════════════════ */

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.toLowerCase().endsWith('.md')) acc.push(full);
  }
  return acc;
}

/* ── Collections ────────────────────────────────────────────────────────────
   Top-level shelves in the sidebar. A file inside a folder belongs to that
   folder's first path segment; loose files at the docs/ root are classified
   by filename so they don't all pile into one bucket.
   Add a rule here when you start a new set of root-level docs.             */

const ROOT_COLLECTIONS = [
  { label: 'VPS',        test: (f) => /^vps-/i.test(f) },
  { label: 'Governance', test: (f) => /^(orch-|orchestrator-)/i.test(f) },
];

// Shelves appear in this order; anything unlisted sorts after, alphabetically.
const COLLECTION_ORDER = ['VPS', 'DevOps', 'SpriteChat', 'Governance', 'Other'];

function classify(rel) {
  if (rel.includes('/')) {
    const parts = rel.split('/');
    return { collection: parts[0], sub: parts.slice(1, -1).join('/') };
  }
  const hit = ROOT_COLLECTIONS.find((c) => c.test(rel));
  return { collection: hit ? hit.label : 'Other', sub: '' };
}

/** "module-06-docker" → "Module 06 Docker" (fallback when a folder has no README) */
function prettifyDir(name) {
  return name
    .split('/').pop()
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const files = walk(DOCS_DIR).sort();
if (!files.length) {
  console.error('No .md files found under', DOCS_DIR);
  process.exit(1);
}

const docs = files.map((file) => {
  const rel = relative(DOCS_DIR, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  const { html, toc, title, sevCounts } = renderMarkdown(src);
  const { collection, sub } = classify(rel);
  const totalSev = SEV_ORDER.reduce((n, s) => n + sevCounts[s], 0);

  return {
    id: rel.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase(),
    file: rel,
    collection,
    sub,
    title: title || basename(rel, '.md'),
    words: src.split(/\s+/).filter(Boolean).length,
    lines: src.split('\n').length,
    html,
    toc,
    // Severity UI only switches on for docs that genuinely use ratings.
    sev: totalSev >= 3 ? sevCounts : null,
  };
});

/* Order: top-level docs first, then grouped folders. Files named here lead,
   in this order; everything else falls back to alphabetical. */
const PINNED = ['vps-as-built.md', 'vps-hardening.md', 'vps-hardening-why.md'];
const rank = (f) => {
  const i = PINNED.indexOf(f);
  return i === -1 ? PINNED.length : i;
};

const isReadme = (f) => /(^|\/)readme\.md$/i.test(f);
const collIdx = (c) => {
  const i = COLLECTION_ORDER.indexOf(c);
  return i === -1 ? COLLECTION_ORDER.length : i;
};

docs.sort((a, b) => {
  if (collIdx(a.collection) !== collIdx(b.collection)) return collIdx(a.collection) - collIdx(b.collection);
  if (a.collection !== b.collection) return a.collection.localeCompare(b.collection);
  // A collection's own loose files (DevOps/README.md) sit above its subfolders.
  if (!a.sub !== !b.sub) return a.sub ? 1 : -1;
  if (a.sub !== b.sub) return a.sub.localeCompare(b.sub);
  if (rank(a.file) !== rank(b.file)) return rank(a.file) - rank(b.file);
  // A folder's README is its index — surface it above the numbered lectures.
  if (isReadme(a.file) !== isReadme(b.file)) return isReadme(a.file) ? -1 : 1;
  return a.file.localeCompare(b.file);
});

/* Label each subfolder with its README's title ("Module 6 — Docker &
   Containerization") rather than the raw directory name. */
const subLabels = {};
for (const d of docs) {
  if (d.sub && isReadme(d.file)) subLabels[d.collection + '/' + d.sub] = d.title;
}
for (const d of docs) {
  const key = d.collection + '/' + d.sub;
  if (d.sub && !subLabels[key]) subLabels[key] = prettifyDir(d.sub);
}

/* ══════════════════════════════════════════════════════════════════════════
   Page
   ══════════════════════════════════════════════════════════════════════════ */

const payload = JSON.stringify({ docs, subLabels, built: new Date().toISOString() })
  // Neutralise anything that could terminate the inline <script>.
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

const CSS = String.raw`
/* ── Tokens ─────────────────────────────────────────────────────────────────
   The reading surface is deliberately monochrome. Saturated colour is
   reserved for the severity scale so a rating always reads as information. */
:root {
  --ground:      #eceef0;
  --surface:     #f7f8f9;
  --surface-2:   #e3e6e9;
  --ink:         #14181b;
  --ink-soft:    #4a555c;
  --ink-faint:   #78848c;
  --rule:        #d2d7db;
  --rule-soft:   #e0e4e7;
  --link:        #1f5aa8;
  --focus:       #1f5aa8;
  --code-bg:     #1a1f23;
  --code-ink:    #dfe5ea;
  --code-bar:    #23292e;

  --critical: #b32820;
  --high:     #9a5a06;
  --medium:   #2563a8;
  --low:      #5d6a72;
  --critical-bg: #fbe9e7;
  --high-bg:     #fbf0e0;
  --medium-bg:   #e6eefa;
  --low-bg:      #e8ebed;

  --sans: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: "Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, "SF Mono", Menlo, monospace;

  --rail: 19.5rem;
  --measure: 74ch;
  --pad: clamp(1.25rem, 4vw, 3.5rem);
  --radius: 3px;
}

:root:not([data-theme="light"]) {
  @media (prefers-color-scheme: dark) {
    --ground:    #0e1114;
    --surface:   #14181c;
    --surface-2: #1c2126;
    --ink:       #dde3e8;
    --ink-soft:  #a3aeb6;
    --ink-faint: #6e7c85;
    --rule:      #262d33;
    --rule-soft: #1e242a;
    --link:      #6fa8e8;
    --focus:     #6fa8e8;
    --code-bg:   #0a0d0f;
    --code-ink:  #d6dde3;
    --code-bar:  #14181c;

    --critical: #ff6f62;
    --high:     #e9a13b;
    --medium:   #6fabec;
    --low:      #90a1ab;
    --critical-bg: #2b1512;
    --high-bg:     #2a1e0c;
    --medium-bg:   #10202f;
    --low-bg:      #1b2126;
  }
}

:root[data-theme="dark"] {
  --ground:    #0e1114;
  --surface:   #14181c;
  --surface-2: #1c2126;
  --ink:       #dde3e8;
  --ink-soft:  #a3aeb6;
  --ink-faint: #6e7c85;
  --rule:      #262d33;
  --rule-soft: #1e242a;
  --link:      #6fa8e8;
  --focus:     #6fa8e8;
  --code-bg:   #0a0d0f;
  --code-ink:  #d6dde3;
  --code-bar:  #14181c;

  --critical: #ff6f62;
  --high:     #e9a13b;
  --medium:   #6fabec;
  --low:      #90a1ab;
  --critical-bg: #2b1512;
  --high-bg:     #2a1e0c;
  --medium-bg:   #10202f;
  --low-bg:      #1b2126;
}

* { box-sizing: border-box; }

html { scroll-behavior: smooth; scroll-padding-top: 1.5rem; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: 2px;
}

.skip {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: var(--surface); color: var(--ink);
  padding: .6rem 1rem; border: 1px solid var(--rule);
}
.skip:focus { left: .5rem; top: .5rem; }

/* ── Shell ───────────────────────────────────────────────────────────────── */
.shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); min-height: 100vh; }

/* ── Rail ────────────────────────────────────────────────────────────────── */
.rail {
  position: sticky; top: 0; align-self: start;
  height: 100vh; overflow-y: auto; overscroll-behavior: contain;
  background: var(--surface);
  border-right: 1px solid var(--rule);
  padding: 1.5rem 0 3rem;
  scrollbar-width: thin;
}

.rail__brand {
  display: flex; align-items: baseline; gap: .55rem;
  padding: 0 1.25rem 1rem;
  font-family: var(--mono);
}
.rail__mark { font-size: .95rem; font-weight: 700; letter-spacing: -.04em; color: var(--ink); }
.rail__sub { font-size: .7rem; color: var(--ink-faint); letter-spacing: .02em; }

.rail__search { padding: 0 1.25rem 1.25rem; }
.field { position: relative; display: block; }
.field input {
  width: 100%; padding: .5rem .6rem .5rem 1.9rem;
  font: 400 .82rem/1.4 var(--mono);
  color: var(--ink);
  background: var(--ground);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
}
.field input::placeholder { color: var(--ink-faint); }
.field__icon {
  position: absolute; left: .6rem; top: 50%; transform: translateY(-50%);
  font: 600 .75rem var(--mono); color: var(--ink-faint); pointer-events: none;
}
.field__hint {
  position: absolute; right: .5rem; top: 50%; transform: translateY(-50%);
  font: 500 .65rem var(--mono); color: var(--ink-faint);
  border: 1px solid var(--rule); border-radius: 2px; padding: 0 .3rem;
  pointer-events: none;
}
.field input:focus + .field__hint { display: none; }

.eyebrow {
  display: flex; align-items: center; gap: .5rem;
  padding: 0 1.25rem; margin: 1.4rem 0 .5rem;
  font: 600 .62rem var(--mono);
  letter-spacing: .14em; text-transform: uppercase;
  color: var(--ink-faint);
}
.eyebrow::after { content: ""; flex: 1; height: 1px; background: var(--rule-soft); }

.navlist { list-style: none; margin: 0; padding: 0; }

.navlist a {
  display: flex; align-items: baseline; gap: .5rem;
  padding: .3rem 1.25rem;
  color: var(--ink-soft); text-decoration: none;
  font-size: .84rem; line-height: 1.45;
  border-left: 2px solid transparent;
}
.navlist a:hover { background: var(--surface-2); color: var(--ink); }
.navlist a[aria-current="true"] {
  color: var(--ink); font-weight: 600;
  border-left-color: var(--ink);
  background: var(--surface-2);
}
.navlist .nav__file { font-family: var(--mono); font-size: .78rem; color: var(--ink-faint); }

/* collapsible document groups — 70+ docs need folding */
.navgroup { list-style: none; }
.navgroup__hdr {
  display: flex; align-items: baseline; gap: .5rem;
  width: 100%; padding: .4rem 1.25rem; margin-top: .35rem;
  background: none; border: 0; cursor: pointer; text-align: left;
  font: 600 .62rem var(--mono); letter-spacing: .1em; text-transform: uppercase;
  color: var(--ink-faint);
}
.navgroup__hdr:hover { color: var(--ink); background: var(--surface-2); }
.navgroup__caret { display: inline-block; transition: transform .15s ease; flex: none; }
.navgroup__hdr[aria-expanded="true"] .navgroup__caret { transform: rotate(90deg); }
.navgroup__label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.navgroup__n { font-variant-numeric: tabular-nums; opacity: .65; flex: none; }
.navgroup__items { list-style: none; margin: 0; padding: 0; }
.navgroup__items > li > a { padding-left: 2rem; }

/* second level — module folders inside a collection */
.navsub { list-style: none; }
.navsub__hdr {
  display: flex; align-items: baseline; gap: .45rem;
  width: 100%; padding: .3rem 1.25rem .3rem 1.9rem;
  background: none; border: 0; cursor: pointer; text-align: left;
  font: 500 .74rem/1.35 var(--sans);
  color: var(--ink-soft);
}
.navsub__hdr:hover { color: var(--ink); background: var(--surface-2); }
.navsub__hdr[aria-expanded="true"] { color: var(--ink); font-weight: 650; }
.navsub__items { list-style: none; margin: 0 0 .2rem; padding: 0; }
.navsub__items a { padding-left: 2.9rem; font-size: .8rem; }

/* section list: number + label + severity dots */
.toc a { padding-left: 1.25rem; }
.toc .lvl-3 { padding-left: 2.1rem; font-size: .8rem; }
.toc .lvl-4 { padding-left: 2.9rem; font-size: .78rem; }
.toc__num { font-family: var(--mono); font-size: .72rem; color: var(--ink-faint); flex: none; }
.toc__label { flex: 1; min-width: 0; }
.toc__dots { display: flex; gap: 2px; flex: none; align-self: center; }
.dot { width: 5px; height: 5px; border-radius: 50%; }
.dot--critical { background: var(--critical); }
.dot--high     { background: var(--high); }
.dot--medium   { background: var(--medium); }
.dot--low      { background: var(--low); }

/* severity legend doubles as a filter */
.legend { list-style: none; margin: 0; padding: 0 1.25rem; display: grid; gap: 1px; }
.legend button {
  display: grid; grid-template-columns: 8px 1fr auto; align-items: center; gap: .55rem;
  width: 100%; padding: .3rem .4rem;
  background: none; border: 0; border-radius: var(--radius);
  font: 500 .76rem/1.4 var(--mono); letter-spacing: .04em;
  color: var(--ink-soft); text-align: left; cursor: pointer;
}
.legend button:hover { background: var(--surface-2); color: var(--ink); }
.legend button[aria-pressed="true"] { background: var(--surface-2); color: var(--ink); font-weight: 700; }
.legend__swatch { width: 8px; height: 8px; border-radius: 50%; }
.legend__n { font-variant-numeric: tabular-nums; color: var(--ink-faint); }

.legend__clear {
  margin: .5rem 1.25rem 0;
  font: 500 .7rem var(--mono);
  color: var(--link); background: none; border: 0; padding: .2rem 0; cursor: pointer;
}

/* ── Content ─────────────────────────────────────────────────────────────── */
.main { min-width: 0; padding: 0 var(--pad) 8rem; }

.topbar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 1rem;
  margin: 0 calc(var(--pad) * -1); padding: .7rem var(--pad);
  background: color-mix(in srgb, var(--ground) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--rule-soft);
}
.crumb { font: 500 .75rem var(--mono); color: var(--ink-faint); flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb b { color: var(--ink-soft); font-weight: 600; }

.iconbtn {
  display: inline-flex; align-items: center; gap: .4rem;
  padding: .3rem .6rem;
  font: 500 .72rem var(--mono);
  color: var(--ink-soft); background: var(--surface); cursor: pointer;
  border: 1px solid var(--rule); border-radius: var(--radius);
}
.iconbtn:hover { color: var(--ink); border-color: var(--ink-faint); }

.drawer-toggle { display: none; }

.doc { max-width: var(--measure); padding-top: 2.5rem; }

.doc__title {
  font-family: var(--mono);
  font-size: clamp(1.5rem, 1rem + 2.2vw, 2.15rem);
  font-weight: 700; letter-spacing: -.035em; line-height: 1.15;
  margin: 0 0 .75rem;
  text-wrap: balance;
}

.docmeta {
  display: flex; flex-wrap: wrap; gap: .4rem .9rem;
  margin: 0 0 2.5rem; padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--rule);
  font: 500 .7rem var(--mono); letter-spacing: .04em;
  color: var(--ink-faint); text-transform: uppercase;
}

/* Headings: monospace, like a manpage. The subject is a terminal runbook. */
.h { font-family: var(--mono); font-weight: 700; letter-spacing: -.025em; position: relative; scroll-margin-top: 4rem; }
.h--2 {
  font-size: 1.32rem; line-height: 1.25;
  margin: 3.5rem 0 1rem; padding-top: 1.5rem;
  border-top: 1px solid var(--rule);
}
.h--3 { font-size: 1.02rem; line-height: 1.35; margin: 2.25rem 0 .6rem; }
.h--4 { font-size: .88rem; line-height: 1.4; margin: 1.75rem 0 .5rem; color: var(--ink-soft); }

.h__anchor {
  position: absolute; left: -1.1rem; top: 0;
  color: var(--ink-faint); text-decoration: none; opacity: 0;
  font-weight: 400;
}
.h:hover .h__anchor, .h__anchor:focus { opacity: 1; }
@media (max-width: 900px) { .h__anchor { display: none; } }

.doc p { margin: 0 0 1.1rem; }
.doc ul, .doc ol { margin: 0 0 1.1rem; padding-left: 1.4rem; }
.doc li { margin: .3rem 0; }
.doc li > ul, .doc li > ol { margin: .3rem 0 .2rem; }
.doc hr { height: 1px; margin: 2.5rem 0; background: var(--rule); border: 0; }
/* a rule immediately before a section heading would double up with the
   heading's own top border — let the rule do the job alone */
.doc hr + .h--2 { border-top: 0; padding-top: 0; margin-top: 2rem; }
.doc strong { font-weight: 650; color: var(--ink); }

/* task lists */
li.task { list-style: none; margin-left: -1.4rem; display: flex; gap: .55rem; align-items: baseline; }
.task__box {
  flex: none; width: .8rem; height: .8rem; margin-top: .25rem;
  border: 1.5px solid var(--ink-faint); border-radius: 2px;
}
.task__box.is-done { background: var(--ink-faint); position: relative; }
.task__box.is-done::after {
  content: "✓"; position: absolute; inset: 0;
  color: var(--surface); font-size: .62rem; line-height: .72rem; text-align: center;
}

/* inline code */
.doc :not(pre) > code {
  font: 500 .86em var(--mono);
  background: var(--surface-2);
  border: 1px solid var(--rule-soft);
  border-radius: 2px;
  padding: .08em .32em;
  word-break: break-word;
}

/* code blocks */
.code { margin: 0 0 1.4rem; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--rule); }
.code__bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: .3rem .5rem .3rem .75rem;
  background: var(--code-bar);
  border-bottom: 1px solid color-mix(in srgb, var(--code-ink) 12%, transparent);
}
.code__lang {
  font: 600 .64rem var(--mono); letter-spacing: .12em; text-transform: uppercase;
  color: color-mix(in srgb, var(--code-ink) 55%, transparent);
}
.code__copy {
  font: 500 .68rem var(--mono);
  color: color-mix(in srgb, var(--code-ink) 70%, transparent);
  background: none; border: 1px solid color-mix(in srgb, var(--code-ink) 18%, transparent);
  border-radius: 2px; padding: .15rem .5rem; cursor: pointer;
}
.code__copy:hover { color: var(--code-ink); border-color: color-mix(in srgb, var(--code-ink) 40%, transparent); }
.code__copy.is-done { color: #7ddc95; border-color: #7ddc95; }
.code pre {
  margin: 0; padding: .85rem 1rem;
  background: var(--code-bg); color: var(--code-ink);
  overflow-x: auto;
}
.code code { font: 400 .82rem/1.6 var(--mono); tab-size: 2; }

/* tables */
.tablewrap { overflow-x: auto; margin: 0 0 1.4rem; border: 1px solid var(--rule); border-radius: var(--radius); }
.doc table { border-collapse: collapse; width: 100%; font-size: .88rem; }
.doc th, .doc td { padding: .5rem .7rem; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
.doc th {
  font: 600 .68rem var(--mono); letter-spacing: .08em; text-transform: uppercase;
  color: var(--ink-faint); background: var(--surface);
  border-bottom: 1px solid var(--rule); white-space: nowrap;
}
.doc tbody tr:last-child td { border-bottom: 0; }
.doc tbody tr:hover { background: var(--surface); }

/* callouts */
.callout {
  margin: 0 0 1.4rem; padding: .85rem 1rem;
  border-left: 3px solid var(--ink-faint);
  background: var(--surface);
  border-radius: 0 var(--radius) var(--radius) 0;
}
.callout > :last-child { margin-bottom: 0; }
.callout--danger { border-left-color: var(--critical); background: var(--critical-bg); }
.callout--warn   { border-left-color: var(--high);     background: var(--high-bg); }

/* severity chips */
.chip {
  display: inline-block; vertical-align: middle;
  margin-left: .5rem; padding: .1rem .4rem;
  font: 700 .58rem var(--mono); letter-spacing: .1em;
  border-radius: 2px; border: 1px solid currentColor;
  position: relative; top: -1px;
}
.chip--critical { color: var(--critical); background: var(--critical-bg); }
.chip--high     { color: var(--high);     background: var(--high-bg); }
.chip--medium   { color: var(--medium);   background: var(--medium-bg); }
.chip--low      { color: var(--low);      background: var(--low-bg); }

/* filter state — visibility is decided per node in applyFilter(), so that a
   matching heading keeps the prose, code and tables that belong to it */
.doc.is-filtered [data-hidden="true"] { display: none; }

.empty {
  padding: 2rem 0; color: var(--ink-faint);
  font: 500 .85rem var(--mono);
}

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 1000px) {
  .shell { grid-template-columns: 1fr; }
  .rail {
    position: fixed; inset: 0 auto 0 0; z-index: 50;
    width: min(20rem, 85vw);
    transform: translateX(-100%);
    transition: transform .18s ease;
    box-shadow: 0 0 0 100vmax rgba(0,0,0,0);
  }
  .rail.is-open { transform: translateX(0); box-shadow: 0 0 0 100vmax rgba(0,0,0,.45); }
  .drawer-toggle { display: inline-flex; }
  .main { padding-top: 0; }
}

/* ── Print ───────────────────────────────────────────────────────────────── */
@media print {
  .rail, .topbar, .code__copy, .h__anchor { display: none !important; }
  .shell { display: block; }
  .main { padding: 0; }
  .doc { max-width: none; }
  body { background: #fff; color: #000; font-size: 11pt; }
  .code pre { background: #f4f4f4; color: #000; border: 1px solid #ccc; }
  .code__bar { background: #eee; }
  .code__lang { color: #555; }
  .h--2 { break-after: avoid; }
  .code, .tablewrap, .callout { break-inside: avoid; }
  a { color: #000; }
}
`;

const JS = String.raw`
(function () {
  var DATA  = window.__DOCS__;
  var docs  = DATA.docs;
  var SEVS  = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

  var els = {
    docNav:   document.getElementById('docnav'),
    tocNav:   document.getElementById('tocnav'),
    tocHead:  document.getElementById('tochead'),
    legend:   document.getElementById('legend'),
    legendHd: document.getElementById('legendhead'),
    clearBtn: document.getElementById('clearfilter'),
    body:     document.getElementById('docbody'),
    crumb:    document.getElementById('crumb'),
    search:   document.getElementById('search'),
    rail:     document.getElementById('rail'),
    drawer:   document.getElementById('drawer'),
    theme:    document.getElementById('theme')
  };

  var current = null;
  var activeSev = null;
  var observer = null;

  /* Trust boundary: doc.html is produced by this generator at build time from
     local .md files, and every markdown-derived character is HTML-escaped in
     inline()/escapeHtml() before any tag is emitted. No runtime input — URL,
     search box, or otherwise — is ever interpolated into innerHTML; the few
     dynamic strings below all go through esc() or textContent. */

  /* ── Theme ──────────────────────────────────────────────────────────── */
  var THEMES = ['system', 'light', 'dark'];
  var themeIdx = THEMES.indexOf(localStorage.getItem('docs-theme') || 'system');
  if (themeIdx < 0) themeIdx = 0;

  function applyTheme() {
    var t = THEMES[themeIdx];
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    els.theme.textContent = t === 'system' ? 'auto' : t;
    els.theme.setAttribute('aria-label', 'Colour theme: ' + t + '. Click to change.');
    localStorage.setItem('docs-theme', t);
  }
  els.theme.addEventListener('click', function () {
    themeIdx = (themeIdx + 1) % THEMES.length;
    applyTheme();
  });
  applyTheme();

  /* ── Document list ──────────────────────────────────────────────────── */
  /* Two-level tree: collections (VPS, DevOps, SpriteChat…) containing loose
     documents and, where the folder nests, labelled subgroups. Everything
     starts folded; show() opens whichever branch holds the active document. */
  function buildDocNav() {
    var SUB = DATA.subLabels || {};
    var order = [];
    var byColl = {};
    docs.forEach(function (d) {
      if (!(d.collection in byColl)) { byColl[d.collection] = []; order.push(d.collection); }
      byColl[d.collection].push(d);
    });

    function item(d, cid, sid) {
      return '<li><a href="#/' + d.id + '" data-doc="' + d.id + '" data-coll="' + cid + '"' +
             (sid ? ' data-sub="' + sid + '"' : '') + '>' +
               '<span class="toc__label">' + esc(d.title) + '</span>' +
             '</a></li>';
    }

    var html = '';
    order.forEach(function (c, ci) {
      var items = byColl[c];
      var cid = 'c' + ci;

      var subOrder = [];
      var bySub = {};
      items.forEach(function (d) {
        if (!d.sub) return;
        if (!(d.sub in bySub)) { bySub[d.sub] = []; subOrder.push(d.sub); }
        bySub[d.sub].push(d);
      });

      html +=
        '<li class="navgroup">' +
          '<button class="navgroup__hdr" type="button" data-target="' + cid + '" aria-expanded="false">' +
            '<span class="navgroup__caret" aria-hidden="true">▸</span>' +
            '<span class="navgroup__label">' + esc(c) + '</span>' +
            '<span class="navgroup__n">' + items.length + '</span>' +
          '</button>' +
          '<ul class="navgroup__items" id="' + cid + '" hidden>' +
            items.filter(function (d) { return !d.sub; })
                 .map(function (d) { return item(d, cid, ''); }).join('') +
            subOrder.map(function (s, si) {
              var sid = cid + 's' + si;
              var kids = bySub[s];
              return '<li class="navsub">' +
                       '<button class="navsub__hdr" type="button" data-target="' + sid + '" aria-expanded="false">' +
                         '<span class="navgroup__caret" aria-hidden="true">▸</span>' +
                         '<span class="navgroup__label">' + esc(SUB[c + '/' + s] || s) + '</span>' +
                         '<span class="navgroup__n">' + kids.length + '</span>' +
                       '</button>' +
                       '<ul class="navsub__items" id="' + sid + '" hidden>' +
                         kids.map(function (d) { return item(d, cid, sid); }).join('') +
                       '</ul>' +
                     '</li>';
            }).join('') +
          '</ul>' +
        '</li>';
    });
    els.docNav.innerHTML = html;
  }

  // One handler drives both levels — headers carry data-target.
  els.docNav.addEventListener('click', function (e) {
    var hdr = e.target.closest('[data-target]');
    if (!hdr) return;
    var open = hdr.getAttribute('aria-expanded') === 'true';
    hdr.setAttribute('aria-expanded', String(!open));
    var list = document.getElementById(hdr.dataset.target);
    if (list) list.hidden = open;
  });

  function reveal(id) {
    if (!id) return;
    var list = document.getElementById(id);
    if (list) list.hidden = false;
    var hdr = els.docNav.querySelector('[data-target="' + id + '"]');
    if (hdr) hdr.setAttribute('aria-expanded', 'true');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ── Render a document ──────────────────────────────────────────────── */
  function show(id, hash) {
    var doc = docs.filter(function (d) { return d.id === id; })[0] || docs[0];
    current = doc;
    activeSev = null;

    els.body.innerHTML =
      doc.html.replace('</h1>', '</h1><p class="docmeta">' +
        '<span>' + doc.lines.toLocaleString() + ' lines</span>' +
        '<span>' + doc.words.toLocaleString() + ' words</span>' +
        '<span>~' + Math.max(1, Math.round(doc.words / 220)) + ' min read</span>' +
        '<span>' + esc(doc.file) + '</span>' +
      '</p>');
    els.body.classList.remove('is-filtered');

    els.crumb.innerHTML = 'docs / ' + (doc.group ? esc(doc.group) + ' / ' : '') + '<b>' + esc(doc.file.split('/').pop()) + '</b>';
    document.title = doc.title + ' · docs';

    Array.prototype.forEach.call(els.docNav.querySelectorAll('a[data-doc]'), function (a) {
      var active = a.dataset.doc === doc.id;
      a.setAttribute('aria-current', active ? 'true' : 'false');
      // Unfold both levels so the active document is never hidden
      if (active) { reveal(a.dataset.coll); reveal(a.dataset.sub); }
    });

    buildToc(doc);
    buildLegend(doc);
    wireCopy();
    wireSpy();
    filterSearch(els.search.value);

    // Jump instantly when switching documents — smooth-scrolling the length of
    // a 1,400-line page lands you somewhere random for a second.
    if (hash) {
      var target = document.getElementById(hash);
      if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
      else window.scrollTo(0, 0);
    } else {
      window.scrollTo(0, 0);
    }
  }

  /* ── Section rail ───────────────────────────────────────────────────── */
  function buildToc(doc) {
    if (!doc.toc.length) { els.tocNav.innerHTML = ''; els.tocHead.hidden = true; return; }
    els.tocHead.hidden = false;

    // Roll each heading's severity up to its parent section, so the rail
    // shows at a glance where the critical work lives.
    var rolled = {};
    var lastTop = null;
    doc.toc.forEach(function (h) {
      if (h.level <= 2) { lastTop = h.id; rolled[h.id] = {}; }
      if (h.sev && lastTop && rolled[lastTop]) {
        rolled[lastTop][h.sev] = (rolled[lastTop][h.sev] || 0) + 1;
      }
    });

    var html = '';
    doc.toc.forEach(function (h) {
      if (h.level > 3) return;
      var num = '';
      var label = h.text;
      var m = h.text.match(/^([0-9]+(?:\.[0-9]+)*)[.)]?\s+([\s\S]*)$/);
      if (m) { num = m[1]; label = m[2]; }

      var dots = '';
      if (h.level <= 2 && rolled[h.id]) {
        SEVS.forEach(function (s) {
          if (rolled[h.id][s]) dots += '<span class="dot dot--' + s.toLowerCase() + '" title="' + s + '"></span>';
        });
      } else if (h.sev) {
        dots = '<span class="dot dot--' + h.sev.toLowerCase() + '" title="' + h.sev + '"></span>';
      }

      html += '<li><a class="lvl-' + h.level + '" href="#/' + doc.id + '/' + h.id + '" data-target="' + h.id + '"' +
              (h.sev ? ' data-sev="' + h.sev + '"' : '') + '>' +
                (num ? '<span class="toc__num">' + num + '</span>' : '') +
                '<span class="toc__label">' + esc(label) + '</span>' +
                (dots ? '<span class="toc__dots">' + dots + '</span>' : '') +
              '</a></li>';
    });
    els.tocNav.innerHTML = html;
  }

  /* ── Severity legend / filter ───────────────────────────────────────── */
  function buildLegend(doc) {
    var has = !!doc.sev;
    els.legendHd.hidden = !has;
    els.legend.hidden = !has;
    els.clearBtn.hidden = true;
    if (!has) { els.legend.innerHTML = ''; return; }

    var html = '';
    SEVS.forEach(function (s) {
      var n = doc.sev[s] || 0;
      if (!n) return;
      html += '<li><button type="button" data-sev="' + s + '" aria-pressed="false">' +
                '<span class="legend__swatch" style="background:var(--' + s.toLowerCase() + ')"></span>' +
                '<span>' + s + '</span>' +
                '<span class="legend__n">' + n + '</span>' +
              '</button></li>';
    });
    els.legend.innerHTML = html;
  }

  els.legend.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-sev]');
    if (!btn) return;
    applyFilter(btn.dataset.sev === activeSev ? null : btn.dataset.sev);
  });

  els.clearBtn.addEventListener('click', function () { applyFilter(null); });

  /**
   * Hide every heading (and the content beneath it) whose rating is not the
   * selected one. Content is hidden per-node rather than with a CSS sibling
   * rule so that unrated intro prose under a rated heading stays with it.
   */
  function applyFilter(sev) {
    activeSev = sev;
    var nodes = Array.prototype.slice.call(els.body.children);
    var keeping = true;
    var sawRated = false;

    nodes.forEach(function (node) {
      var isH = /^H[1-6]$/.test(node.tagName);
      if (isH) {
        var lvl = +node.tagName[1];
        if (lvl === 1) { keeping = true; node.dataset.hidden = 'false'; return; }
        if (!sev) { keeping = true; }
        else if (node.dataset.sev) { keeping = node.dataset.sev === sev; sawRated = true; }
        else if (lvl === 2) { keeping = false; }
        // sub-headings with no rating inherit the current decision
      }
      node.dataset.hidden = (sev && !keeping) ? 'true' : 'false';
    });

    els.body.classList.toggle('is-filtered', !!sev);
    els.clearBtn.hidden = !sev;
    els.clearBtn.textContent = sev ? 'Clear ' + sev + ' filter' : '';

    Array.prototype.forEach.call(els.legend.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.sev === sev ? 'true' : 'false');
    });
    Array.prototype.forEach.call(els.tocNav.querySelectorAll('a'), function (a) {
      a.parentElement.hidden = !!(sev && a.dataset.sev !== sev);
    });
    if (sev && !sawRated) applyFilter(null);
  }

  /* ── Copy buttons ───────────────────────────────────────────────────── */
  function wireCopy() {
    Array.prototype.forEach.call(els.body.querySelectorAll('.code__copy'), function (btn) {
      btn.addEventListener('click', function () {
        var code = btn.closest('.code').querySelector('code').textContent;
        copy(code).then(function () {
          btn.textContent = 'Copied';
          btn.classList.add('is-done');
          setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('is-done'); }, 1400);
        }, function () {
          btn.textContent = 'Press Ctrl+C';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1800);
        });
      });
    });
  }

  // navigator.clipboard is unavailable on some file:// origins, so fall back.
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(); }
      catch (e) { reject(e); }
      finally { document.body.removeChild(ta); }
    });
  }

  /* ── Scrollspy ──────────────────────────────────────────────────────── */
  function wireSpy() {
    if (observer) observer.disconnect();
    var heads = els.body.querySelectorAll('h2[id], h3[id]');
    if (!heads.length) return;

    var visible = new Map();
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) visible.set(en.target.id, en.boundingClientRect.top);
        else visible.delete(en.target.id);
      });
      var top = null;
      visible.forEach(function (v, k) { if (top === null) top = k; });
      if (!top) return;
      Array.prototype.forEach.call(els.tocNav.querySelectorAll('a'), function (a) {
        a.setAttribute('aria-current', a.dataset.target === top ? 'true' : 'false');
      });
    }, { rootMargin: '-10% 0px -75% 0px' });

    Array.prototype.forEach.call(heads, function (h) { observer.observe(h); });
  }

  /* ── Search ─────────────────────────────────────────────────────────── */
  function filterSearch(term) {
    var q = term.trim().toLowerCase();

    // Filter document entries, then hide groups with no surviving children and
    // auto-expand the ones that do — otherwise matches stay buried when collapsed.
    Array.prototype.forEach.call(els.docNav.querySelectorAll('a[data-doc]'), function (a) {
      a.parentElement.hidden = !!q && a.textContent.toLowerCase().indexOf(q) === -1;
    });
    // Roll emptiness upward: subgroups first, then collections.
    [['.navsub', '.navsub__hdr', '.navsub__items'],
     ['.navgroup', '.navgroup__hdr', '.navgroup__items']].forEach(function (sel) {
      Array.prototype.forEach.call(els.docNav.querySelectorAll(sel[0]), function (grp) {
        var hdr = grp.querySelector(sel[1]);
        var list = grp.querySelector(sel[2]);
        if (!hdr || !list) return;
        var hits = Array.prototype.filter.call(list.children, function (li) { return !li.hidden; }).length;
        grp.hidden = !!q && hits === 0;
        if (q && hits) { list.hidden = false; hdr.setAttribute('aria-expanded', 'true'); }
      });
    });

    Array.prototype.forEach.call(els.tocNav.querySelectorAll('a'), function (a) {
      if (activeSev && a.dataset.sev !== activeSev) return;
      a.parentElement.hidden = !!q && a.textContent.toLowerCase().indexOf(q) === -1;
    });

    var anyToc = Array.prototype.some.call(els.tocNav.querySelectorAll('li'), function (li) { return !li.hidden; });
    els.tocNav.nextElementSibling.hidden = !q || anyToc;
    if (!anyToc && q) els.tocNav.nextElementSibling.textContent = 'No sections match "' + term.trim() + '".';
  }

  els.search.addEventListener('input', function () { filterSearch(els.search.value); });
  els.search.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { els.search.value = ''; filterSearch(''); els.search.blur(); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== els.search) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
    }
  });

  /* ── Drawer (small screens) ─────────────────────────────────────────── */
  els.drawer.addEventListener('click', function () {
    els.rail.classList.toggle('is-open');
  });
  els.rail.addEventListener('click', function (e) {
    if (e.target.closest('a')) els.rail.classList.remove('is-open');
  });

  /* ── Routing ────────────────────────────────────────────────────────── */
  function route() {
    var parts = location.hash.replace(/^#\//, '').split('/');
    var id = parts[0] || docs[0].id;
    var anchor = parts[1] || '';
    if (!current || current.id !== id) show(id, anchor);
    else if (anchor) {
      var t = document.getElementById(anchor);
      if (t) t.scrollIntoView();
    }
  }

  window.addEventListener('hashchange', route);
  buildDocNav();
  route();
})();
`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>docs</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#docbody">Skip to document</a>

<div class="shell">
  <aside class="rail" id="rail">
    <div class="rail__brand">
      <span class="rail__mark">docs/</span>
      <span class="rail__sub">${docs.length} files</span>
    </div>

    <div class="rail__search">
      <label class="field">
        <span class="field__icon" aria-hidden="true">&gt;</span>
        <input id="search" type="search" placeholder="Filter docs and sections" aria-label="Filter documents and sections" autocomplete="off" spellcheck="false">
        <span class="field__hint" aria-hidden="true">/</span>
      </label>
    </div>

    <nav aria-label="Documents">
      <ul class="navlist" id="docnav"></ul>
    </nav>

    <p class="eyebrow" id="legendhead" hidden>Severity</p>
    <ul class="legend" id="legend" hidden></ul>
    <button class="legend__clear" id="clearfilter" type="button" hidden></button>

    <p class="eyebrow" id="tochead" hidden>Sections</p>
    <nav aria-label="Sections in this document">
      <ul class="navlist toc" id="tocnav"></ul>
      <p class="empty" style="padding-left:1.25rem" hidden></p>
    </nav>
  </aside>

  <main class="main">
    <div class="topbar">
      <button class="iconbtn drawer-toggle" id="drawer" type="button" aria-label="Toggle navigation">☰</button>
      <p class="crumb" id="crumb"></p>
      <button class="iconbtn" id="theme" type="button">auto</button>
    </div>

    <article class="doc" id="docbody"></article>
  </main>
</div>

<script>window.__DOCS__ = ${payload};</script>
<script>${JS}</script>
</body>
</html>
`;

writeFileSync(OUT_FILE, HTML, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`\n  docs viewer built → ${relative(process.cwd(), OUT_FILE)}  (${kb(Buffer.byteLength(HTML))})\n`);
for (const d of docs) {
  const sev = d.sev ? SEV_ORDER.filter((s) => d.sev[s]).map((s) => `${s[0]}${d.sev[s]}`).join(' ') : '';
  console.log(
    `    ${d.file.padEnd(44)} ${String(d.toc.length).padStart(3)} sections  ${String(d.words).padStart(6)} words  ${sev}`
  );
}
console.log('');
