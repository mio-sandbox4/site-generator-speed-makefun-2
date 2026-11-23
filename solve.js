// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree makefun-site's build
// returns, byte for byte, computed with a hand-tuned Markdown renderer, a cached slugifier and templates
// compiled to JavaScript functions. No dependencies; all state is per-run (nothing cached between cases).

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_CHARS = ['&', '<', '>', '"', "'"];

/** s[a..b) with & < > " and ' escaped (makefun-site's table, nothing else). */
function escapeHtmlRange(s, a, b) {
  let pos = a;
  let out = '';
  for (;;) {
    let j = b;
    let rep = null;
    for (let t = 0; t < 5; t++) {
      const k = s.indexOf(ESC_CHARS[t], pos);
      if (k !== -1 && k < j) { j = k; rep = ESC_MAP[ESC_CHARS[t]]; }
    }
    if (rep === null) break;
    out += s.slice(pos, j) + rep;
    pos = j + 1;
  }
  return out + s.slice(pos, b);
}

/** `text` with & < > " and ' escaped. */
function escapeHtml(s) {
  return escapeHtmlRange(s, 0, s.length);
}

const SLUG_MAX = 64;
const MARK_RE = /\p{M}/gu;

/** The slug of `text`, before caching: NFKD, marks dropped, A-Z lowered, runs of other chars one "-". */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  const plain = ascii ? text : text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace (the \S+ count). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c > 32) {
      // \s beyond ASCII: NBSP, Ogham, en/em spaces, line/paragraph separators, narrow NBSP, medium math, ideographic, BOM
      ws = c > 127 && (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
    } else ws = c === 32 || (c >= 9 && c <= 13);
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error } with the first reason it is refused. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // Walk lines only until the closing --- (the reference splits the whole text; the result is the same).
  const fmLines = [];
  let body = null;
  let lineStart = firstNl + 1;
  for (;;) {
    let end = text.indexOf('\n', lineStart);
    if (end === -1) end = text.length;
    if (end - lineStart === 3 && text.startsWith('---', lineStart)) {
      body = end === text.length ? '' : text.slice(end + 1);
      break;
    }
    fmLines.push(text.slice(lineStart, end));
    if (end === text.length) break;
    lineStart = end + 1;
  }
  if (body === null) return { error: 'the front matter is not closed' };
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
/** The escapable characters by char code (all ASCII), for the hot loops. */
const ESCAPABLE_CODE = new Uint8Array(128);
for (const ch of ESCAPABLE) ESCAPABLE_CODE[ch.charCodeAt(0)] = 1;
const isEscapableAt = (s, i) => {
  const c = s.charCodeAt(i);
  return c < 128 && ESCAPABLE_CODE[c] === 1;
};

function findUnescaped(s, what, from, end) {
  for (let j = from; j <= end - what.length; j++) {
    if (s[j] === '\\' && j + 1 < end && isEscapableAt(s, j + 1)) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && isEscapableAt(s, j + 1)) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** s[a..b) rendered inline; `link(target)` is a link's href. Works on ranges: no substring copies but the output's. */
function inlineRange(s, a, b, link) {
  let out = '';
  let runStart = a;
  let i = a;
  while (i < b) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < b && isEscapableAt(s, i + 1)) {
        out += escapeHtmlRange(s, runStart, i);
        const nx = s[i + 1];
        out += nx === '>' ? '&gt;' : nx;
        i += 2;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      let j = s.indexOf('`', i + 1);
      if (j >= b) j = -1;
      if (j > i + 1) {
        out += escapeHtmlRange(s, runStart, i) + '<code>' + escapeHtmlRange(s, i + 1, j) + '</code>';
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          out += escapeHtmlRange(s, runStart, i) + '<strong>' + inlineRange(s, i + 2, j, link) + '</strong>';
          i = j + 2;
          runStart = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1, b);
        if (j > i + 1) {
          out += escapeHtmlRange(s, runStart, i) + '<em>' + inlineRange(s, i + 1, j, link) + '</em>';
          i = j + 1;
          runStart = i;
        } else i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      if (m >= b) m = -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out += escapeHtmlRange(s, runStart, i) + '<a href="' + escapeHtml(link(target)) + '">' + inlineRange(s, i + 1, k, link) + '</a>';
        i = m + 1;
        runStart = i;
      } else i++;
      continue;
    }
    i++;
  }
  return out + escapeHtmlRange(s, runStart, b);
}

/** `s` rendered inline. */
function inline(s, link) {
  return inlineRange(s, 0, s.length, link);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** A fence-opening line's language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = line.slice(3, i);
  for (; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return null;
  return lang;
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(line) {
  let d = 0;
  while (line[d] === '#') d++;
  if (d < 1 || d > 6) return null;
  if (line[d] !== ' ' && line[d] !== '\t') return null;
  let a = d;
  while (line[a] === ' ' || line[a] === '\t') a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: d, text: line.slice(a, b) };
}

function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  return (line[0] === '-' || line[0] === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered item's { num, text }, or null. */
function orderedOf(line) {
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d < 1 || d > 9) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { num: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

const CONTINUED = /^ {2,}\S/;

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph, checked without building anything (blank, fence, heading, break). */
function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c0 = line[0];
  if (c0 === '`') return fenceLang(line) !== null;
  if (c0 === '#') {
    let d = 0;
    while (line[d] === '#') d++;
    if (d < 1 || d > 6) return false;
    if (line[d] !== ' ' && line[d] !== '\t') return false;
    for (let i = d; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return true;
    return false;
  }
  if (c0 === '-' || c0 === '*') return isHR(line);
  return false;
}

/** `src` rendered: its HTML, its table of contents and its excerpt. `slugify` is the build's cached one. */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      html += `<pre><code${cls}>${body.length === 0 ? '' : body.map((l) => escapeHtml(l)).join('\n') + '\n'}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const inner = inline(heading.text, link);
      html += `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
      i++;
      continue;
    }
    if (isHR(line)) { html += '<hr>\n'; i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        let s = lines[i].slice(1);
        if (s[0] === ' ') s = s.slice(1);
        body.push(s);
        i++;
      }
      const kept = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') kept.push(t); }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (lines[i][0] === ' ' && lines[i][1] === ' ' && CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      let block = open + '\n';
      for (const parts of items) block += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      html += block + `</${tag}>\n`;
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) parts.push(trimLine(lines[i++]));
    const inner = inline(parts.join('\n'), link);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A lookup over the scope chain for a dotted path string; split paths are cached per run of the entry. */
function makeLookup() {
  const cache = new Map();
  return function lookup(scope, pathStr) {
    let path = cache.get(pathStr);
    if (path === undefined) { path = pathStr.split('.'); cache.set(pathStr, path); }
    let s = scope;
    while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
    if (s === null) return undefined;
    let v = s.vars[path[0]];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  };
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Compile a parsed template into a render function (scope, depth) -> string, resolving includes via `bag`. */
function compileTemplate(nodes, bag, lookupFn) {
  const code = [];
  let uid = 0;
  const pathArgs = (path) => JSON.stringify(path.join('.'));
  function gen(list, scopeVar) {
    for (const node of list) {
      switch (node.kind) {
        case 'text':
          code.push(`_o+=${JSON.stringify(node.text)};`);
          break;
        case 'var':
          code.push(`_o+=_E(_T(_L(${scopeVar},${pathArgs(node.path)})));`);
          break;
        case 'raw':
          code.push(`_o+=_T(_L(${scopeVar},${pathArgs(node.path)}));`);
          break;
        case 'if':
          code.push(`if((_Y(_L(${scopeVar},${pathArgs(node.path)})))!==${node.not}){`);
          gen(node.then, scopeVar);
          if (node.else !== null) { code.push('}else{'); gen(node.else, scopeVar); }
          code.push('}');
          break;
        case 'for': {
          const id = ++uid;
          const xs = `_x${id}`, ln = `_n${id}`, kk = `_k${id}`, sc = `_s${id}`, lp = `_l${id}`;
          // One scope object per loop execution, mutated per iteration (rendering is synchronous; no scope
          // reference outlives its iteration).
          // (A loop variable named "loop" stays shadowed by the loop-info object, as in the reference.)
          const assign = node.name === 'loop' ? '' : `${sc}.vars[${JSON.stringify(node.name)}]=${xs}[${kk}];`;
          code.push(`{const ${xs}=_L(${scopeVar},${pathArgs(node.path)});if(Array.isArray(${xs})){const ${ln}=${xs}.length;const ${lp}={index:0,first:false,last:false,length:${ln}};const ${sc}={vars:{${JSON.stringify(node.name)}:undefined,loop:${lp}},parent:${scopeVar}};for(let ${kk}=0;${kk}<${ln};${kk}++){${assign}${lp}.index=${kk}+1;${lp}.first=${kk}===0;${lp}.last=${kk}===${ln}-1;`);
          gen(node.body, sc);
          code.push('}}}');
          break;
        }
        case 'include':
          code.push(`{const _t=_C[${JSON.stringify(node.name)}];if(_t!==undefined&&_d<${INCLUDE_DEPTH})_o+=_t(${scopeVar},_d+1);}`);
          break;
      }
    }
  }
  gen(nodes, '_s');
  const fn = new Function('_s', '_d', '_L', '_T', '_E', '_Y', '_C', `let _o='';${code.join('')}return _o;`);
  return (scope, depth) => fn(scope, depth, lookupFn, textOf, escapeHtml, truthy, bag);
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  let i = 0;
  for (;;) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = rel.length;
    const len = j - i;
    if (len === 2 && rel[i] === '.' && rel[i + 1] === '.') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (len !== 0 && !(len === 1 && rel[i] === '.')) parts.push(rel.slice(i, j));
    if (j === rel.length) break;
    i = j + 1;
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    let r = slugCache.get(text);
    if (r === undefined) { r = slugifyRaw(text); slugCache.set(text, r); }
    return r;
  };
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = {};
  const lookupFn = makeLookup();
  for (const [name, nodes] of templates) compiled[name] = compileTemplate(nodes, compiled, lookupFn);
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources and statics, in code-unit order of path
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter: refusals and drafts dropped, in the reference's check order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 3. permalinks
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown, links resolved
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const linkCache = new Map();
    const link = (target) => {
      const hit = linkCache.get(target);
      if (hit !== undefined) return hit;
      let out;
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) out = target;
      else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) out = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) out = `${base}/${path}${frag}`;
        else {
          broken.add(`broken-link ${s.path} -> ${target}`);
          out = target;
        }
      }
      linkCache.set(target, out);
      return out;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts
  const cardOf = (s) => {
    if (s._card !== undefined) return s._card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s._card = card;
    return card;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled[name];
    return fn === undefined ? null : fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0);
  };
  const output = {};
  for (const s of kept) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. the report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
