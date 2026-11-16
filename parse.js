// parse.js — a fast drop-in for marked 18.1.3 (CommonMark 0.31.2 + GFM 0.29),
// written from the spec and the practice set. No dependencies, no network.
import { ENT } from './entities.js';

// ---------------- entities ----------------
const ENTITY_MAP = new Map();
for (const part of ENT.split('\x01')) {
  const i = part.indexOf(':');
  ENTITY_MAP.set(part.slice(0, i), part.slice(i + 1));
}

// ---------------- helpers ----------------
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const _punctCache = new Map();
function isPunct(ch) {
  if (ch === '') return false;
  const code = ch.codePointAt(0);
  if (code < 128) return ASCII_PUNCT.has(ch);
  let r = _punctCache.get(code);
  if (r === undefined) { r = /[\p{P}\p{S}]/u.test(ch); _punctCache.set(code, r); }
  return r;
}
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'; }
// Unicode whitespace per CommonMark spec (used ONLY for emphasis flanking):
// ASCII ws + U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000
function isUnicodeWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f' ||
    ch === '\u0085' || ch === '\u00a0' || ch === '\u1680' ||
    (ch >= '\u2000' && ch <= '\u200a') || ch === '\u2028' || ch === '\u2029' ||
    ch === '\u202f' || ch === '\u205f' || ch === '\u3000';
}
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isAlpha(ch) { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'); }
function isAlnum(ch) { return isAlpha(ch) || isDigit(ch); }

// Escape text/attribute content the way marked does.
export function escapeHtml(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode an entity starting at s[i] === '&'. Returns [decoded, length] or null.
// Named entities are returned verbatim (&name;) — marked does not validate
// them against the HTML5 table. Numeric entities decode, except out-of-range
// / surrogate values, which are not entities at all (0 decodes to U+FFFD).
function decodeEntity(s, i) {
  const n = s.length;
  if (s[i + 1] === '#') {
    let j = i + 2;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < n && (hex ? /[0-9a-fA-F]/.test(s[j]) : isDigit(s[j]))) j++;
    if (j === start || j >= n || s[j] !== ';') return null;
    const cp = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (cp === 0) return ['\uFFFD', j - i + 1, false];
    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return null;
    return [String.fromCodePoint(cp), j - i + 1, false];
  }
  // named: &name; — kept verbatim, any alphanumeric name
  let j = i + 1;
  while (j < n && isAlnum(s[j]) && j - i < 33) j++;
  if (j < n && s[j] === ';' && j > i + 1) {
    return [s.slice(i, j + 1), j - i + 1, true];
  }
  return null;
}

// Escape an attribute value (href/title/alt): like escapeHtml, but an
// entity-like &name; or valid numeric entity is kept/decoded, not escaped.
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const e = decodeEntity(s, i);
      if (e) {
        // named entity (&name;) is kept verbatim; numeric is decoded then escaped
        out += s.slice(start, i) + (e[2] ? e[0] : escapeHtml(e[0]));
        start = i + e[1]; i += e[1] - 1;
        continue;
      }
      out += s.slice(start, i) + '&amp;'; start = i + 1; continue;
    }
    let rep = null;
    if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Percent-encode a link destination the way CommonMark/marked render it.
// Valid %XX escapes are kept verbatim (not double-encoded to %25).
function cleanUrl(href) {
  // encodeURI, then escape for the attribute (entities kept verbatim).
  return escapeAttr(href.split(/(%[0-9A-Fa-f]{2})/g).map((seg, k) => (k % 2 === 1 ? seg : encodeURI(seg))).join(''));
}

// ---------------- inline parsing ----------------
// Node kinds: text, code, em, strong, del, link, image, html, br, softbr, delim
// A delim node carries its literal chars; unmatched delims render literally.

const LINK_LABEL_MAX = 1000;

// Unicode full case folding specials (JS toLowerCase does simple mapping
// only: ß/ẞ fold to "ss", ligatures fold to their letters).
const FOLD_MAP = { 'ß': 'ss', 'ẞ': 'ss', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

function normalizeLabel(raw) {
  // collapse whitespace, full case fold; backslash escapes are NOT resolved
  // when matching labels (spec ex. 545: [foo\!] does not match [foo!])
  let s = raw.replace(/[ßẞﬀﬁﬂﬃﬄﬅﬆ]/g, (ch) => FOLD_MAP[ch]);
  s = s.replace(/[ \t\r\n]+/g, ' ');
  return s.trim().toLowerCase();
}

function parseLabel(s, i) {
  // s[i] === '['; parse a link label, return [labelRaw, endIndexAfterBracket] or null.
  // A label ends at the first unescaped ']'; an unescaped '[' inside the
  // label makes it invalid (spec ex. 547/548).
  const n = s.length;
  let j = i + 1;
  let len = 0;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; len += 2; continue; }
    if (c === '[') return null;
    if (c === ']') {
      if (len === 0) return null;
      return [s.slice(i + 1, j), j + 1];
    }
    j++; len++;
    if (len > LINK_LABEL_MAX) return null;
  }
  return null;
}

// Parse a link destination starting at s[i]. Returns [dest, next] or null.
function parseDest(s, i) {
  const n = s.length;
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return [out, j + 1];
      if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; if (depth > 32) return null; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    out += c; j++;
  }
  if (j === i) return null;
  return [out, j];
}

// Parse a link title starting at s[i] (after spaces). Returns [title, next] or null.
function parseTitle(s, i) {
  const n = s.length;
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === close) return [out, j + 1];
    if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    out += c; j++;
  }
  return null;
}

// Skip spaces/newlines; returns index after them (at least one char consumed if any).
function skipSpaceNL(s, i) {
  const n = s.length;
  while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Try to parse "(dest title)" after a ']' at position i. Returns {dest,title,next} or null.
function parseInlineLink(s, i, refs) {
  const n = s.length;
  if (s[i] !== '(') return null;
  let j = skipSpaceNL(s, i + 1);
  if (j < n && s[j] === ')') return { dest: '', title: null, next: j + 1 };
  const d = parseDest(s, j);
  if (!d) return null;
  const [dest, j2] = d;
  j = skipSpaceNL(s, j2);
  if (j < n && s[j] === ')') return { dest, title: null, next: j + 1 };
  const t = parseTitle(s, j);
  if (!t) return null;
  const [title, j3] = t;
  j = skipSpaceNL(s, j3);
  if (j < n && s[j] === ')') return { dest, title, next: j + 1 };
  return null;
}

function renderPlain(nodes) {
  // alt text: raw text of children, no formatting
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'code' || nd.t === 'delim' || nd.t === 'raw') out += nd.s;
    else if (nd.t === 'html') out += '';
    else if (nd.t === 'br' || nd.t === 'softbr') out += '\n';
    else if (nd.children) out += renderPlain(nd.children);
  }
  return out;
}

// ---- raw HTML tag matching (CommonMark) ----
const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*/;
function matchTag(s, i) {
  // returns end index after a valid inline HTML tag starting at s[i]==='<' or -1
  const n = s.length;
  if (s[i + 1] === '!') {
    if (s.startsWith('<!--', i)) {
      // abrupt closing of an empty comment: <!--> and <!---> are complete
      if (s.startsWith('<!-->', i)) return i + 5;
      if (s.startsWith('<!--->', i)) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e === -1 ? -1 : e + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    // declaration <!A-Z ...>
    if (i + 2 < n && s[i + 2] >= 'A' && s[i + 2] <= 'Z') {
      let j = i + 3;
      while (j < n && s[j] !== '>') j++;
      return j < n ? j + 1 : -1;
    }
    return -1;
  }
  if (s[i + 1] === '?') {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  const m = TAG_NAME_RE.exec(s.slice(j, j + 40));
  if (!m) return -1;
  j += m[0].length;
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return j < n && s[j] === '>' ? j + 1 : -1;
  }
  // after the tag name only whitespace, '>' or '/>' may follow
  if (j < n && s[j] !== '>' && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' &&
      !(s[j] === '/' && s[j + 1] === '>')) return -1;
  // attributes
  for (;;) {
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (j >= n) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    // an attribute must be separated from the tag name / previous value
    // by whitespace
    if (ws === 0) return -1;
    // attribute name: first char [A-Za-z_:] only
    if (!/[A-Za-z_:]/.test(s[j])) return -1;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '=') {
      j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j >= n) return -1;
      const q = s[j];
      if (q === '"' || q === "'") {
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        if (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '>' || s[j] === '"' || s[j] === "'" || s[j] === '=' || s[j] === '<' || s[j] === '`') return -1;
        while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '>' && s[j] !== '"' && s[j] !== "'" && s[j] !== '=' && s[j] !== '<' && s[j] !== '`') j++;
      }
    }
  }
}

// ---- autolinks ----
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
function tryAutolink(s, i) {
  // s[i] === '<'
  const n = s.length;
  let j = i + 1;
  // scheme:...
  let k = j;
  while (k < n && (isAlnum(s[k]) || s[k] === '+' || s[k] === '.' || s[k] === '-')) k++;
  if (k < n && s[k] === ':' && k - j >= 2 && k - j <= 32 && isAlpha(s[j])) {
    let e = k + 1;
    while (e < n && s[e] !== '>' && s[e] !== ' ' && s[e] !== '\t' && s[e] !== '\n' && s[e] !== '<') e++;
    if (e < n && s[e] === '>') {
      const dest = s.slice(j, e);
      return { node: { t: 'link', href: dest, title: null, children: [{ t: 'text', s: dest }] }, next: e + 1 };
    }
    return null;
  }
  // email
  let e = j;
  while (e < n && s[e] !== '>' && s[e] !== ' ' && s[e] !== '\t' && s[e] !== '\n' && s[e] !== '<') e++;
  if (e < n && s[e] === '>') {
    const cand = s.slice(j, e);
    if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(cand)) {
      return { node: { t: 'link', href: 'mailto:' + cand, title: null, children: [{ t: 'text', s: cand }] }, next: e + 1 };
    }
  }
  return null;
}

// GFM extended autolink: www. / http(s):// / email in plain text.
// Returns {node, next} or null. s[i] is the start char.
function tryExtAutolink(s, i) {
  const n = s.length;
  let isWww = false, isHttp = false, isEmail = false;
  let start = i;
  if (s.startsWith('www.', i)) { isWww = true; }
  else if (s.startsWith('https://', i) || s.startsWith('http://', i)) { isHttp = true; }
  else {
    // email: scan local@domain
    let j = i;
    while (j < n && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[j])) j++;
    if (j > i && j < n && s[j] === '@') {
      let d = j + 1;
      while (d < n && /[A-Za-z0-9.-]/.test(s[d])) d++;
      const cand = s.slice(i, d);
      if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(cand)
          && /[A-Za-z]/.test(cand.slice(cand.lastIndexOf('.') + 1))) {
        return { node: { t: 'link', href: 'mailto:' + cand, title: null, children: [{ t: 'text', s: cand }] }, next: d };
      }
    }
    return null;
  }
  // URL: scan until whitespace or '<'
  let j = i;
  while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '<') j++;
  let url = s.slice(i, j);
  if (isWww) {
    // domain must contain a dot with valid TLD-ish part
    const m = /^www\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.exec(url);
    if (!m) return null;
  } else {
    const m = /^https?:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*/.exec(url);
    if (!m) return null;
  }
  // trim trailing punctuation per GFM
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if ('?!.,:;*_~'.includes(c)) { end--; continue; }
    if (c === "'") { end--; continue; }
    if (c === ')') {
      // balance parens in the url
      let open = 0, close = 0;
      for (let q = 0; q < end; q++) { if (url[q] === '(') open++; else if (url[q] === ')') close++; }
      if (close > open) { end--; continue; }
      break;
    }
    if (c === ';') {
      // if the ; could close an entity, drop it
      const amp = url.lastIndexOf('&', end - 2);
      if (amp !== -1 && /^&[A-Za-z0-9]+$/.test(url.slice(amp, end - 1))) { end--; continue; }
      break;
    }
    break;
  }
  url = url.slice(0, end);
  if (!url) return null;
  // must still contain a valid domain after trimming
  if (isWww && !/^www\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(url)) return null;
  const href = isWww ? 'http://' + url : url;
  return { node: { t: 'link', href, title: null, children: [{ t: 'text', s: url }] }, next: i + url.length };
}

// ---- main inline scanner ----
function parseInline(src, refs, opts) {
  const nodes = [];          // node list
  const brackets = [];       // {idx, image, active}
  const n = src.length;
  let i = 0;
  let textStart = 0;
  const flushText = (upto) => {
    if (upto > textStart) nodes.push({ t: 'text', s: src.slice(textStart, upto) });
  };

  const canOpenClose = (pos, len, ch) => {
    const before = pos > 0 ? src[pos - 1] : '';
    const after = pos + len < n ? src[pos + len] : '';
    // start/end of string count as whitespace for flanking purposes
    const beforeWs = before === '' || isUnicodeWs(before);
    const afterWs = after === '' || isUnicodeWs(after);
    const beforePunct = isPunct(before);
    const afterPunct = isPunct(after);
    const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
    let canOpen, canClose;
    if (ch === '_') {
      canOpen = leftFlanking && (!rightFlanking || beforePunct);
      canClose = rightFlanking && (!leftFlanking || afterPunct);
    } else {
      canOpen = leftFlanking;
      canClose = rightFlanking;
    }
    return [canOpen, canClose];
  };

  while (i < n) {
    const c = src[i];

    // --- backslash escape / hard break ---
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { flushText(i); nodes.push({ t: 'br' }); i += 2; textStart = i; continue; }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) { flushText(i); nodes.push({ t: 'text', s: nx }); i += 2; textStart = i; continue; }
      i++; continue;
    }

    // --- newline: soft/hard break ---
    if (c === '\n') {
      // hard break if 2+ spaces precede
      let k = i - 1, spaces = 0;
      while (k >= textStart && src[k] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        flushText(i - spaces);
        nodes.push({ t: 'br' });
      } else {
        flushText(i);
        nodes.push({ t: 'softbr' });
      }
      i++; textStart = i; continue;
    }

    // --- code span ---
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      // find matching run
      let k = j, found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let m = k;
          while (m < n && src[m] === '`') m++;
          if (m - k === run) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found !== -1) {
        flushText(i);
        let content = src.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^[ ]+$/.test(content)) {
          content = content.slice(1, -1);
        }
        nodes.push({ t: 'code', s: content });
        i = found + run; textStart = i; continue;
      }
      i = j; continue;
    }

    // --- emphasis delimiters ---
    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const len = j - i;
      const [co, cc] = canOpenClose(i, len, c);
      flushText(i);
      nodes.push({ t: 'delim', s: src.slice(i, j), ch: c, len, canOpen: co, canClose: cc, active: true });
      i = j; textStart = i; continue;
    }

    // --- strikethrough ---
    if (c === '~') {
      let j = i;
      while (j < n && src[j] === '~') j++;
      const len = j - i;
      // GFM: one or two tildes form a delimiter; a run of 3+ is literal text
      if (len === 1 || len === 2) {
        const [co, cc] = canOpenClose(i, len, '~');
        flushText(i);
        nodes.push({ t: 'delim', s: src.slice(i, j), ch: '~', len, canOpen: co, canClose: cc, active: true });
        i = j; textStart = i; continue;
      }
      i = j; continue;
    }

    // --- image / link open ---
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImage = c === '!';
      const bpos = isImage ? i + 1 : i;
      flushText(isImage ? i : i);
      if (isImage) { nodes.push({ t: 'text', s: '!' }); }
      nodes.push({ t: 'text', s: '[' });
      brackets.push({ idx: nodes.length - 1, image: isImage, active: true, bangIdx: isImage ? nodes.length - 2 : -1, pos: bpos });
      i = bpos + 1; textStart = i; continue;
    }

    // --- link close ---
    if (c === ']') {
      // find nearest active bracket
      let b = -1;
      for (let q = brackets.length - 1; q >= 0; q--) {
        if (brackets[q].active) { b = q; break; }
      }
      if (b === -1) { i++; continue; }
      const br = brackets[b];
      flushText(i);
      nodes.push({ t: 'text', s: ']' });
      const closeIdx = nodes.length - 1;
      // what follows?
      let dest = null, title = null, next = i + 1;
      let formed = false;
      let noShortcut = false; // a reference was attempted and failed: no shortcut fallback
      const after = src[i + 1];
      if (after === '(') {
        const il = parseInlineLink(src, i + 1, refs);
        if (il) { dest = il.dest; title = il.title; next = il.next; formed = true; }
        // failed inline link: fall through to shortcut below
      } else if (after === '[') {
        if (src[i + 2] === ']') {
          // collapsed reference: [foo][] uses the bracket's own text as label.
          // The label is the RAW source text (escapes not resolved), so that
          // [foo\!] does not match [foo!] but [bar\\] matches [bar\\].
          const ref = refs.get(normalizeLabel(src.slice(br.pos + 1, i)));
          if (ref) { dest = ref.dest; title = ref.title; next = i + 3; formed = true; }
          else noShortcut = true;
        } else {
          const lab = parseLabel(src, i + 1);
          if (lab) {
            const ref = refs.get(normalizeLabel(lab[0]));
            if (ref) { dest = ref.dest; title = ref.title; next = lab[1]; formed = true; }
            else noShortcut = true; // label parsed but no such reference
          }
          // label did not parse (unclosed/invalid): fall through to shortcut
        }
      }
      if (!formed && !noShortcut) {
        // shortcut reference: label is the RAW source text between the
        // brackets (escapes not resolved), same rule as collapsed refs
        const ref = refs.get(normalizeLabel(src.slice(br.pos + 1, i)));
        if (ref) { dest = ref.dest; title = ref.title; next = i + 1; formed = true; }
      }
      if (formed) {
        const children = nodes.slice(br.idx + 1, closeIdx);
        // a link cannot contain another link (images may contain links)
        if (!br.image) {
          for (const ch of children) if (ch.t === 'link') { formed = false; break; }
        }
      }
      if (formed) {
        const children = nodes.slice(br.idx + 1, closeIdx);
        // emphasis inside the link/image text is resolved now
        processEmphasis(children);
        // remove bracket nodes and the ']' node, and '!' if image
        let startIdx = br.idx;
        if (br.image) startIdx = br.bangIdx;
        nodes.splice(startIdx, closeIdx - startIdx + 1);
        if (br.image) {
          const alt = renderPlain(children);
          nodes.push({ t: 'image', src: dest, title, alt, children });
        } else {
          nodes.push({ t: 'link', href: dest, title, children });
          // deactivate inner brackets
          for (let q = b + 1; q < brackets.length; q++) brackets[q].active = false;
        }
        brackets.splice(b, 1);
        i = next; textStart = i; continue;
      }
      // not a link: leave literal, deactivate this bracket
      brackets[b].active = false;
      i++; textStart = i; continue;
    }

    // --- autolink / raw html ---
    if (c === '<') {
      const al = tryAutolink(src, i);
      if (al) { flushText(i); nodes.push(al.node); i = al.next; textStart = i; continue; }
      const tagEnd = matchTag(src, i);
      if (tagEnd !== -1) { flushText(i); nodes.push({ t: 'html', s: src.slice(i, tagEnd) }); i = tagEnd; textStart = i; continue; }
      i++; continue;
    }

    // --- entity ---
    if (c === '&') {
      const e = decodeEntity(src, i);
      if (e) {
        flushText(i);
        if (e[2]) nodes.push({ t: 'raw', s: e[0] }); // named: verbatim
        else nodes.push({ t: 'text', s: e[0] }); // numeric: decoded char
        i += e[1]; textStart = i; continue;
      }
      i++; continue;
    }

    // --- GFM extended autolink (www. / http(s) / email) ---
    if (c === 'w' || c === 'h' || isAlnum(c)) {
      const prev = i > 0 ? src[i - 1] : '';
      const prevOk = prev === '' || isSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(';
      if (prevOk) {
        const ea = tryExtAutolink(src, i);
        if (ea) { flushText(i); nodes.push(ea.node); i = ea.next; textStart = i; continue; }
      }
      i++; continue;
    }

    i++;
  }
  flushText(n);

  // task list checkbox at the very start of a list-item paragraph
  if (opts && opts.taskList && nodes.length > 0 && nodes[0].t === 'text') {
    const s0 = nodes[0].s;
    const m = /^\[([ xX])\] /.exec(s0);
    if (m) {
      const checked = m[1] !== ' ';
      nodes[0].s = s0.slice(4);
      if (nodes[0].s === '') nodes.shift();
      nodes.unshift({ t: 'taskbox', checked });
    }
  }

  processEmphasis(nodes);
  return nodes;
}

// ---- emphasis / strikethrough resolution ----
function processEmphasis(nodes) {
  // openersBottom[ch] is a NODE reference: the scan for an opener stops when
  // it reaches that node. When an opener is fully consumed, the bottom is
  // set to the closer node; if the closer was also fully consumed (removed
  // from the list) the bottom no longer blocks the scan, so an outer opener
  // can still match a later closer.
  const bottom = { '*': null, '_': null, '~': null };
  for (let ci = 0; ci < nodes.length; ci++) {
    const closer = nodes[ci];
    if (closer.t !== 'delim' || !closer.canClose || !closer.active) continue;
    const ch = closer.ch;
    // find opener
    let oi = -1;
    for (let q = ci - 1; q >= 0; q--) {
      const cand = nodes[q];
      if (cand === bottom[ch]) break;
      if (cand.t !== 'delim' || cand.ch !== ch || !cand.canOpen || !cand.active) continue;
      // rule of 3: when both can open and close, the sum of lengths must not
      // be a multiple of 3, unless both lengths are multiples of 3
      if ((cand.canClose || closer.canOpen) && (cand.len + closer.len) % 3 === 0 && !(cand.len % 3 === 0 && closer.len % 3 === 0)) continue;
      oi = q; break;
    }
    if (oi === -1) continue;
    const opener = nodes[oi];
    const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    const kind = ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const children = nodes.slice(oi + 1, ci);
    const wrapper = { t: kind, children };
    nodes.splice(oi, ci - oi + 1, wrapper);
    // adjust delimiter lengths; re-insert leftovers next to the wrapper
    let insertPos = oi + 1;
    opener.len -= use;
    closer.len -= use;
    if (opener.len > 0) {
      opener.s = opener.ch.repeat(opener.len);
      nodes.splice(oi, 0, opener);
      insertPos++;
    } else {
      bottom[ch] = closer; // opener fully consumed
    }
    if (closer.len > 0) {
      closer.s = closer.ch.repeat(closer.len);
      nodes.splice(insertPos, 0, closer);
      ci = insertPos - 1; // re-examine the leftover closer (it may match an outer opener)
    } else {
      ci = oi;
    }
    // continue scanning after the wrapper
  }
}

// ---- inline rendering ----
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += escapeHtml(nd.s); break;
      case 'raw': out += nd.s; break;
      case 'code': out += '<code>' + escapeHtml(nd.s) + '</code>'; break;
      case 'em': out += '<em>' + renderInline(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(nd.children) + '</del>'; break;
      case 'link': {
        out += '<a href="' + cleanUrl(nd.href) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += '>' + renderInline(nd.children) + '</a>';
        break;
      }
      case 'image': {
        out += '<img src="' + cleanUrl(nd.src) + '" alt="' + escapeAttr(nd.alt) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += '>';
        break;
      }
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'softbr': out += '\n'; break;
      case 'delim': out += escapeHtml(nd.s); break;
      case 'taskbox': out += nd.checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">'; break;
    }
  }
  return out;
}

// ================= block parsing =================
// Line cursor: {s, i, col, partial} — partial = remaining spaces of a
// partially-consumed tab (the tab char is still at i).
function peek(L) { return L.partial > 0 ? ' ' : (L.i < L.s.length ? L.s[L.i] : ''); }
function adv(L, n) {
  while (n > 0) {
    if (L.partial > 0) {
      const take = Math.min(n, L.partial);
      L.partial -= take; L.col += take; n -= take;
      if (L.partial === 0) L.i++;
    } else {
      const c = L.s[L.i];
      if (c === '\t') {
        const w = 4 - (L.col % 4);
        if (w <= n) { L.i++; L.col += w; n -= w; }
        else { L.partial = w - n; L.col += n; n = 0; }
      } else if (c === undefined) { L.col += n; n = 0; }
      else { L.i++; L.col++; n--; }
    }
  }
}
function rest(L) {
  if (L.partial > 0) return ' '.repeat(L.partial) + L.s.slice(L.i + 1);
  return L.s.slice(L.i);
}
function isBlankLine(L) {
  for (let k = L.i; k < L.s.length; k++) {
    const c = L.s[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}
// columns of leading whitespace from current position (absolute columns)
function indentCols(L) {
  let col = L.col;
  let k = L.i;
  if (L.partial > 0) { col += L.partial; k++; }
  while (k < L.s.length) {
    const c = L.s[k];
    if (c === ' ') { col++; k++; }
    else if (c === '\t') { col += 4 - (col % 4); k++; }
    else break;
  }
  return col - L.col;
}
function advSpaces(L, maxN) {
  let n = 0;
  while (n < maxN) {
    const c = peek(L);
    if (c === ' ') { adv(L, 1); n++; }
    else if (c === '\t') { adv(L, 1); n++; }
    else break;
  }
  return n;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function matchHtmlBlockStart(L) {
  // L at first non-space (<=3 indent already consumed). Returns type 1-7 or 0.
  const s = L.s, i = L.i;
  if (s[i] !== '<') return 0;
  const sub = s.slice(i, i + 12).toLowerCase();
  if (/^<(script|pre|style|textarea)(\s|>|\/|\n|$)/.test(sub + '\n')) return 1;
  if (s.startsWith('<!--', i)) return 2;
  if (s.startsWith('<?', i)) return 3;
  if (i + 2 < s.length && s[i + 1] === '!' && s[i + 2] >= 'A' && s[i + 2] <= 'Z') return 4;
  if (s.startsWith('<![CDATA[', i)) return 5;
  // type 6: block tag open/close
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>)/.exec(s.slice(i, i + 40));
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  // type 7: a single complete open tag alone on the line
  const te = matchTag(s, i);
  if (te !== -1) {
    let k = te;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k === s.length) return 7;
  }
  return 0;
}
function htmlBlockEnds(type, line, isFirst) {
  if (type === 1) return /<\/(script|pre|style|textarea)>/i.test(line);
  if (type === 2) return line.includes('-->');
  if (type === 3) return line.includes('?>');
  if (type === 4) return line.includes('>');
  if (type === 5) return line.includes(']]>');
  return false; // 6,7 end at blank line
}

function matchThematicBreak(L) {
  const s = rest(L);
  return /^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$/.test(s);
}
function matchSetext(L) {
  const s = rest(L);
  const m = /^([=-]+)[ \t]*$/.exec(s);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}
function matchATX(L) {
  const s = rest(L);
  const m = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(s);
  if (!m) return null;
  if (m[2] === undefined) return { level: m[1].length, content: '' };
  let content = m[2];
  // strip trailing spaces, then closing sequence of #'s preceded by space
  // (or a content consisting only of #'s, which is all closing sequence)
  content = content.replace(/[ \t]+$/, '');
  const cm = /[ \t](#+)$/.exec(content);
  if (cm) content = content.slice(0, cm.index).replace(/[ \t]+$/, '');
  else if (/^#+$/.test(content)) content = '';
  return { level: m[1].length, content };
}
function matchFence(L) {
  const s = rest(L);
  const m = /^(`{3,}|~{3,})/.exec(s);
  if (!m) return null;
  const fence = m[1];
  const info = s.slice(fence.length);
  if (fence[0] === '`' && info.includes('`')) return null;
  return { char: fence[0], len: fence.length, info: info.trim() };
}
function matchListMarker(L) {
  const s = rest(L);
  let m = /^([*+-])([ \t]+|$)/.exec(s);
  if (m) {
    const spaces = m[2] === '' ? 0 : m[2].length;
    return { type: 'bullet', char: m[1], markerLen: 1, spacesAfter: spaces };
  }
  m = /^(\d{1,9})([.)])([ \t]+|$)/.exec(s);
  if (m) {
    const spaces = m[3] === '' ? 0 : m[3].length;
    return { type: 'ordered', start: parseInt(m[1], 10), delim: m[2], markerLen: m[1].length + 1, spacesAfter: spaces };
  }
  return null;
}

// Does the line (at L, after <=3 spaces) start a block that can interrupt
// a paragraph? (ATX, fence, HTML 1-6, thematic break, list, blockquote)
// An empty list item cannot interrupt; an ordered list only if it starts at 1.
function lineInterrupts(L) {
  const ic = peek(L);
  if (ic === '#') return !!matchATX(L);
  if (ic === '`' || ic === '~') return !!matchFence(L);
  if (ic === '<') { const hb = matchHtmlBlockStart(L); return hb >= 1 && hb <= 6; }
  if (ic === '*' || ic === '-' || ic === '_') {
    if (matchThematicBreak(L)) return true;
    if (ic !== '_') return listInterrupts(L);
    return false;
  }
  if (ic === '>') return true;
  if (ic === '+' || isDigit(ic)) return listInterrupts(L);
  return false;
}
// A list marker at L that can interrupt a paragraph: non-empty item, and
// an ordered list only when it starts at 1.
function listInterrupts(L) {
  const lm = matchListMarker(L);
  if (!lm) return false;
  if (lm.spacesAfter === 0) return false;
  const after = rest(L).slice(lm.markerLen + (lm.spacesAfter <= 4 ? lm.spacesAfter : 1));
  if (after.trim() === '') return false;
  if (lm.type === 'ordered' && lm.start !== 1) return false;
  return true;
}

// Try to parse a link reference definition starting at `first` (rest of the
// current line); `nextLines` are the following raw lines' contents (already
// container-stripped). Returns {label, dest, title, lines} (lines = lines
// consumed beyond the first) or null.
function tryRefDef(first, nextLines) {
  const text = first + '\n' + nextLines.join('\n');
  // up to 3 leading spaces allowed before the label
  let start = 0;
  while (start < 3 && text[start] === ' ') start++;
  if (text[start] !== '[') return null;
  const lab = parseLabel(text, start);
  if (!lab) return null;
  const norm = normalizeLabel(lab[0]);
  if (!norm) return null;
  let j = lab[1];
  if (text[j] !== ':') return null;
  j++;
  // skip spaces/tabs, then at most one newline, before the destination
  while (text[j] === ' ' || text[j] === '\t') j++;
  if (text[j] === '\n') { j++; while (text[j] === ' ' || text[j] === '\t') j++; }
  const d = parseDest(text, j);
  if (!d) return null;
  const [dest, j2] = d;
  j = j2;
  // a title must be separated from the destination by whitespace
  let wsAfterDest = 0;
  while (text[j] === ' ' || text[j] === '\t') { j++; wsAfterDest++; }
  let title = null;
  if (text[j] === '\n') {
    // title may be on the next line
    const jSave = j;
    let j2b = j + 1;
    while (text[j2b] === ' ' || text[j2b] === '\t') j2b++;
    const t = parseTitle(text, j2b);
    if (t) {
      let j3 = t[1];
      while (text[j3] === ' ' || text[j3] === '\t') j3++;
      if (text[j3] === '\n' || text[j3] === undefined) { title = t[0]; j = j3; }
      else j = jSave; // junk after the title: title line is not part of the def
    } else j = jSave; // no title on the next line
  } else {
    const q = text[j];
    if (q === '"' || q === "'" || q === '(') {
      if (wsAfterDest === 0) return null; // title needs whitespace after dest
      const t = parseTitle(text, j);
      if (t) {
        let j3 = t[1];
        while (text[j3] === ' ' || text[j3] === '\t') j3++;
        if (text[j3] === '\n' || text[j3] === undefined) { title = t[0]; j = j3; }
        else return null; // junk after the title on the same line: def invalid
      }
    }
  }
  while (text[j] === ' ' || text[j] === '\t') j++;
  if (text[j] !== '\n' && text[j] !== undefined) return null;
  // lines consumed = newlines crossed up to the end of the definition
  const linesUsed = (text.slice(0, j).match(/\n/g) || []).length;
  return { label: norm, dest, title, lines: linesUsed };
}

export function parseBlocks(markdown) {
  const refs = new Map();
  const src = markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const hasFinalNL = lines.length > 0 && lines[lines.length - 1] === '';
  if (hasFinalNL) lines.pop();
  const N = lines.length;

  const root = { t: 'document', children: [], parent: null, open: true };
  let tip = root;
  // last finalized HTML block: its trailing newline is dropped if the next
  // line is blank (marked's HTML-block text ends before a blank line)
  let pendingHtml = null;

  function addChild(parent, node) {
    node.parent = parent;
    node.open = true;
    node.children = node.children || [];
    if (parent.t === 'item' && parent._blankSeen && parent.children.length > 0) {
      parent._sawBlankBetween = true;
    }
    if (parent.t === 'item') parent._blankSeen = false;
    parent.children.push(node);
    return node;
  }
  function finalize(node) {
    node.open = false;
    if (node.t === 'html_block') pendingHtml = node;
    if (node.t === 'paragraph') {
      // strip leading link reference definitions
      let li = 0;
      while (li < node.lines.length) {
        const first = node.lines[li];
        const def = tryRefDef(first, node.lines.slice(li + 1, li + 9));
        if (!def) break;
        if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
        li += 1 + def.lines;
      }
      node.lines = node.lines.slice(li);
      if (node.lines.length === 0) {
        // paragraph was only definitions: remove it entirely
        const sibs = node.parent.children;
        const ix = sibs.indexOf(node);
        if (ix !== -1) sibs.splice(ix, 1);
        node._removed = true;
      }
      node.inline = node.lines.join('\n');
    }
    if (node.t === 'list') {
      // tightness: loose if any item has a blank line between its blocks,
      // or items are separated by a blank line
      node.tight = true;
      for (const item of node.children) {
        if (item._sawBlankBetween) { node.tight = false; break; }
      }
      if (node._blankBetweenItems) node.tight = false;
    }
    if (node.t === 'code_block') {
      if (!node.fenced) {
        // strip blank lines at the end, keep the final newline of the last content line
        while (node.literal.endsWith('\n\n')) node.literal = node.literal.slice(0, -1);
      }
    }
  }
  function finalizeUpTo(container) {
    while (tip !== container) {
      const p = tip.parent;
      finalize(tip);
      tip = p;
    }
  }

  // Strip container markers from a raw line (used for ref-def lookahead).
  function stripContainers(raw) {
    const L = { s: raw, i: 0, col: 0, partial: 0 };
    let container = root;
    // walk the current open container chain
    let chain = [];
    let c = tip;
    while (c && c !== root) { chain.unshift(c); c = c.parent; }
    for (const blk of chain) {
      if (blk.t === 'list') continue;
      if (blk.t === 'blockquote') {
        advSpaces(L, 3);
        if (peek(L) === '>') { adv(L, 1); if (peek(L) === ' ' || peek(L) === '\t') adv(L, 1); }
        else return null;
      } else if (blk.t === 'item') {
        if (isBlankLine(L)) continue;
        if (L.col + indentCols(L) >= blk.contentIndent) adv(L, blk.contentIndent - L.col);
        else return null;
      } else break;
    }
    return rest(L);
  }

  let ln = 0;
  while (ln < N) {
    const rawLine = lines[ln];
    const L = { s: rawLine, i: 0, col: 0, partial: 0 };
    const lastLineHasNL = ln < N - 1 || hasFinalNL;

    // ---- 1. walk open containers ----
    let container = root;
    let matched = true;
    let cur = root;
    while (cur.children.length > 0) {
      const last = cur.children[cur.children.length - 1];
      if (!last.open) break;
      if (last.t === 'list') { cur = last; container = last; continue; }
      if (last.t === 'blockquote') {
        const save = { i: L.i, col: L.col, partial: L.partial };
        advSpaces(L, 3);
        if (peek(L) === '>') {
          adv(L, 1);
          const c = peek(L);
          if (c === ' ' || c === '\t') adv(L, 1);
          cur = last; container = last; continue;
        }
        L.i = save.i; L.col = save.col; L.partial = save.partial;
        matched = false; break;
      } else if (last.t === 'item') {
        if (isBlankLine(L)) { cur = last; container = last; continue; }
        // contentIndent is an absolute column; compare against the column
        // of the first non-space char of this line
        if (L.col + indentCols(L) >= last.contentIndent) {
          adv(L, last.contentIndent - L.col);
          cur = last; container = last; continue;
        }
        matched = false; break;
      } else break;
    }
    const blank = isBlankLine(L);

    // ---- 2. leaf continuation / finalization ----
    let leaf = null;
    if (tip !== container && tip.parent === container && (tip.t === 'paragraph' || tip.t === 'code_block' || tip.t === 'html_block')) {
      leaf = tip;
    }
    // Lazy continuation: a non-blank line that fails the container match
    // still continues an open paragraph, unless it starts a block that can
    // interrupt a paragraph. Leading whitespace is stripped; a setext-like
    // line gets 4 spaces prefixed (marked's re-lex guard, visible in output).
    if (!matched && tip.t === 'paragraph' && !blank) {
      const saveL = { i: L.i, col: L.col, partial: L.partial };
      advSpaces(L, 3);
      let interrupts = lineInterrupts(L);
      if (!interrupts) {
        // a line starting a new item of the list this paragraph belongs to
        // is not a lazy continuation either
        const lm = matchListMarker(L);
        if (lm) {
          let p = tip.parent;
          while (p && p.t !== 'item' && p.t !== 'document') p = p.parent;
          if (p && p.t === 'item') {
            const al = p.parent;
            if (al && al.t === 'list' && al.listType === lm.type &&
                (lm.type === 'bullet' ? al.bulletChar === lm.char : al.delim === lm.delim)) {
              interrupts = true;
            }
          }
        }
      }
      if (!interrupts) {
        advSpaces(L, 1000);
        let text = rest(L);
        if (/^(=+|-+)[ \t]*$/.test(text)) text = '    ' + text;
        tip.lines.push(text);
        ln++; continue;
      }
      L.i = saveL.i; L.col = saveL.col; L.partial = saveL.partial;
    }
    if (!matched) {
      // finalize the leaf and any containers deeper than the matched one
      finalizeUpTo(container);
      tip = container;
      leaf = null;
    }

    // blank line: ends paragraph, marks blanks for lists
    if (blank) {
      // an HTML block finalized on the previous line loses its trailing
      // newline when a blank line follows it
      if (pendingHtml && pendingHtml.literal.endsWith('\n')) {
        pendingHtml.literal = pendingHtml.literal.slice(0, -1);
      }
      pendingHtml = null;
      if (leaf && leaf.t === 'paragraph') { finalize(leaf); tip = container; leaf = null; }
      else if (leaf && leaf.t === 'code_block' && !leaf.fenced) {
        // blank line inside indented code: keep whitespace beyond 4 cols
        advSpaces(L, 4);
        leaf.literal += rest(L) + (lastLineHasNL ? '\n' : '');
      }
      else if (leaf && leaf.t === 'code_block' && leaf.fenced) {
        // blank line inside fenced code is content (spaces kept)
        advSpaces(L, leaf.fenceIndent);
        leaf.literal += rest(L) + (lastLineHasNL ? '\n' : '');
      }
      else if (leaf && leaf.t === 'html_block' && leaf.blockType <= 5) {
        // blank lines inside HTML blocks type 1-5 are part of the block
        leaf.literal += lastLineHasNL ? '\n' : '';
      }
      else if (leaf && leaf.t === 'html_block' && (leaf.blockType === 6 || leaf.blockType === 7)) {
        // a blank line ends a type 6/7 HTML block; its last line loses its
        // trailing newline in the output
        if (leaf.literal.endsWith('\n')) leaf.literal = leaf.literal.slice(0, -1);
        finalize(leaf); tip = container; leaf = null;
      }
      // mark blank for list looseness: only the innermost item directly
      // containing this blank line (a blank inside a nested block does not
      // make the outer list loose)
      if (container.t === 'item') container._blankSeen = true;
      ln++;
      continue;
    }
    // non-blank line: a previous HTML block keeps its trailing newline
    pendingHtml = null;

    // ---- 3. leaf-specific handling ----
    if (leaf) {
      if (leaf.t === 'code_block') {
        if (leaf.fenced) {
          const save = { i: L.i, col: L.col, partial: L.partial };
          advSpaces(L, 3);
          const s2 = rest(L);
          const m = new RegExp('^' + (leaf.fenceChar === '`' ? '`' : '~') + '{' + leaf.fenceLen + ',}[ \t]*$').exec(s2);
          if (m) {
            finalize(leaf); tip = container; leaf = null;
            ln++; continue;
          }
          L.i = save.i; L.col = save.col; L.partial = save.partial;
          advSpaces(L, leaf.fenceIndent);
          leaf.literal += rest(L) + (lastLineHasNL ? '\n' : '');
          ln++; continue;
        } else {
          // indented code ends when a line is not blank and indented < 4
          if (indentCols(L) >= 4) {
            advSpaces(L, 4);
            leaf.literal += rest(L) + (lastLineHasNL ? '\n' : '');
            ln++; continue;
          }
          finalize(leaf); tip = container; leaf = null;
          // fall through to new-block detection for this line
        }
      }
      else if (leaf.t === 'html_block') {
        leaf.literal += rest(L) + (lastLineHasNL ? '\n' : '');
        if (htmlBlockEnds(leaf.blockType, rawLine)) { finalize(leaf); tip = container; leaf = null; }
        ln++; continue;
      }
      else if (leaf.t === 'paragraph') {
        // allow up to 3 spaces before setext / interruption checks
        // (paragraph text itself keeps its leading spaces — save position)
        const saveP = { i: L.i, col: L.col, partial: L.partial };
        advSpaces(L, 3);
        // setext?
        const st = matchSetext(L);
        if (st) {
          // strip leading ref defs first; if nothing is left, there is no
          // heading — the underline line becomes new content
          let li = 0;
          while (li < leaf.lines.length) {
            const def = tryRefDef(leaf.lines[li], leaf.lines.slice(li + 1, li + 9));
            if (!def) break;
            if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
            li += 1 + def.lines;
          }
          if (li >= leaf.lines.length) {
            finalize(leaf); tip = container; leaf = null;
            // fall through to new-block detection for this line
          } else {
            leaf.lines = leaf.lines.slice(li);
            const h = { t: 'heading', level: st, inline: leaf.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') };
            finalize(leaf);
            const sibs = container.children;
            sibs[sibs.length - 1] = h; h.parent = container;
            tip = container;
            ln++; continue;
          }
        }
        // link reference definitions cannot interrupt a paragraph (spec):
        // a def-like line mid-paragraph is plain paragraph text, handled
        // as a continuation line below and stripped at finalize if leading.
        // interrupting blocks: ATX, fence, HTML 1-6, thematic break,
        // blockquote, list (bullet, or ordered starting at 1)
        if (leaf) {
        const interrupts = lineInterrupts(L);
        if (interrupts) {
          finalize(leaf); tip = container; leaf = null;
          // fall through to new-block detection (L still positioned)
        } else {
          // continuation line: paragraph text keeps leading spaces verbatim
          L.i = saveP.i; L.col = saveP.col; L.partial = saveP.partial;
          leaf.lines.push(rest(L));
          ln++; continue;
        }
        }
      }
    }

    // ---- 4. new block detection (loop: blockquote/list nest, then leaf) ----
    tip = container;
    // A line that does not continue a list ends it: if the container is a
    // list and this line does not start a new item of the same list, the
    // list closes and the block becomes a sibling of the list.
    if (container.t === 'list') {
      const saveL = { i: L.i, col: L.col, partial: L.partial };
      advSpaces(L, 3);
      const lm0 = matchListMarker(L);
      // a thematic break is not a list item, even if it looks like one
      const sameList = lm0 && !matchThematicBreak(L) && container.listType === lm0.type &&
        (lm0.type === 'bullet' ? container.bulletChar === lm0.char : container.delim === lm0.delim);
      L.i = saveL.i; L.col = saveL.col; L.partial = saveL.partial;
      if (!sameList) {
        finalize(container);
        container = container.parent;
        tip = container;
      }
    }
    for (;;) {
      const saveLoop = { i: L.i, col: L.col, partial: L.partial };
      const ind = indentCols(L);
      if (ind >= 4) {
        // indented code (only when not interrupting a paragraph — leaf is null here)
        advSpaces(L, 4);
        const node = addChild(container, { t: 'code_block', fenced: false, literal: rest(L) + (lastLineHasNL ? '\n' : '') });
        tip = node;
        ln++; break;
      }
      const fenceIndent = advSpaces(L, 3);
      const cur2 = peek(L);
      // blockquote
      if (cur2 === '>') {
        const bq = addChild(container, { t: 'blockquote' });
        container = bq; tip = bq;
        adv(L, 1);
        const c = peek(L);
        if (c === ' ' || c === '\t') adv(L, 1);
        if (isBlankLine(L)) { ln++; break; }
        continue;
      }
      // ATX heading
      if (cur2 === '#') {
        const atx = matchATX(L);
        if (atx) {
          addChild(container, { t: 'heading', level: atx.level, inline: atx.content });
          ln++; break;
        }
      }
      // fenced code
      if (cur2 === '`' || cur2 === '~') {
        const fence = matchFence(L);
        if (fence) {
          const node = addChild(container, { t: 'code_block', fenced: true, fenceChar: fence.char, fenceLen: fence.len, fenceIndent, info: fence.info, literal: '' });
          tip = node;
          ln++; break;
        }
      }
      // HTML block
      if (cur2 === '<') {
        const hb = matchHtmlBlockStart(L);
        if (hb) {
          const node = addChild(container, { t: 'html_block', blockType: hb, literal: rest(L) + (lastLineHasNL ? '\n' : '') });
          if (hb === 6 || hb === 7 || !htmlBlockEnds(hb, rawLine)) tip = node;
          else finalize(node); // single-line block ending on this line
          ln++; break;
        }
      }
      // thematic break
      if (cur2 === '*' || cur2 === '-' || cur2 === '_') {
        if (matchThematicBreak(L)) {
          addChild(container, { t: 'thematic_break' });
          ln++; break;
        }
      }
      // list marker
      if (cur2 === '*' || cur2 === '+' || cur2 === '-' || isDigit(cur2)) {
        const lm = matchListMarker(L);
        if (lm) {
          const markerCol = L.col;
          let contentIndent;
          if (lm.spacesAfter === 0) contentIndent = markerCol + lm.markerLen + 1;
          else if (lm.spacesAfter <= 4) contentIndent = markerCol + lm.markerLen + lm.spacesAfter;
          else contentIndent = markerCol + lm.markerLen + 1;
          let list = null;
          // continuing the same list (container is the list itself)
          if (container.t === 'list') list = container;
          const sibs = container.children;
          if (!list && sibs.length > 0) {
            const prev = sibs[sibs.length - 1];
            if (prev.t === 'list' && prev.open && prev.listType === lm.type &&
                (lm.type === 'bullet' ? prev.bulletChar === lm.char : prev.delim === lm.delim)) {
              list = prev;
            }
          }
          if (!list) {
            list = addChild(container, { t: 'list', listType: lm.type, start: lm.type === 'ordered' ? lm.start : 0, delim: lm.delim || '', bulletChar: lm.char || '', tight: true });
          } else if (list.children.length > 0) {
            // blank line between items makes the list loose
            const prevItem = list.children[list.children.length - 1];
            if (prevItem._blankSeen) list._blankBetweenItems = true;
            prevItem._blankSeen = false;
          }
          const item = addChild(list, { t: 'item', markerOffset: markerCol, contentIndent, _blankSeen: false, _sawBlankBetween: false });
          container = item; tip = item;
          adv(L, lm.markerLen);
          if (lm.spacesAfter > 0) advSpaces(L, lm.spacesAfter <= 4 ? lm.spacesAfter : 1);
          if (isBlankLine(L)) { ln++; break; }
          continue;
        }
      }
      // table or paragraph
      {
        const tbl = tryTable(lines, ln, L, container);
        if (tbl) { ln += tbl; break; }
      }
      // paragraph text keeps its leading spaces verbatim
      L.i = saveLoop.i; L.col = saveLoop.col; L.partial = saveLoop.partial;
      const p = addChild(container, { t: 'paragraph', lines: [rest(L)] });
      tip = p;
      ln++; break;
    }
  }

  // finalize remaining open blocks
  while (tip !== root) { const p = tip.parent; finalize(tip); tip = p; }

  return { root, refs };

  // ---- table detection (header line already in L; next line must be delimiter) ----
  function tryTable(linesArr, idx, Lc, containerNode) {
    if (idx + 1 >= linesArr.length) return 0;
    const headerLine = rest(Lc);
    if (!headerLine.includes('|')) return 0;
    const delimRaw = linesArr[idx + 1];
    // delimiter row: optional leading/trailing pipes, cells of :?-+:?
    const cells = splitTableRow(delimRaw.trim());
    if (cells === null || cells.length === 0) return 0;
    const aligns = [];
    for (const cell of cells) {
      const c = cell.trim();
      if (!/^:?-+:?$/.test(c)) return 0;
      aligns.push(c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null);
    }
    const header = splitTableRow(headerLine);
    if (header === null) return 0;
    const node = { t: 'table', header: header.map(h => h.trim()), aligns, rows: [] };
    addChild(containerNode, node);
    let r = idx + 2;
    while (r < linesArr.length) {
      const rowLine = linesArr[r];
      if (/^[ \t]*$/.test(rowLine)) break;
      const row = splitTableRow(rowLine);
      if (row === null) break;
      node.rows.push(row.map(c => c.trim()));
      r++;
    }
    return r - idx;
  }
  function splitTableRow(line) {
    // split on unescaped |; strip optional leading/trailing empty cell from edge pipes
    const cells = [];
    let cur = '';
    let i = 0;
    const s = line.trim();
    // leading pipe
    let start = 0;
    if (s.startsWith('|')) start = 1;
    let end = s.length;
    if (s.endsWith('|') && !(s.length > 1 && s[s.length - 2] === '\\')) end = s.length - 1;
    for (i = start; i < end; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < end && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '|') { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells;
  }
}

// ================= rendering =================
function renderBlock(node, refs, out) {
  switch (node.t) {
    case 'document':
      for (const ch of node.children) renderBlock(ch, refs, out);
      break;
    case 'paragraph': {
      const firstIsItem = node.parent && node.parent.t === 'item' &&
        node.parent.children[0] === node;
      const nodes = parseInline(node.inline, refs, { taskList: firstIsItem });
      out.push('<p>' + renderInline(nodes) + '</p>\n');
      break;
    }
    case 'heading':
      out.push('<h' + node.level + '>' + renderInline(parseInline(node.inline, refs)) + '</h' + node.level + '>\n');
      break;
    case 'thematic_break':
      out.push('<hr>\n');
      break;
    case 'code_block': {
      if (node.fenced) {
        const lang = (node.info.split(/[\s]/)[0] || '').replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        out.push('<pre><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + '>' +
          escapeHtml(node.literal) + '</code></pre>\n');
      } else {
        out.push('<pre><code>' + escapeHtml(node.literal) + '</code></pre>\n');
      }
      break;
    }
    case 'html_block':
      out.push(node.literal);
      break;
    case 'blockquote': {
      out.push('<blockquote>\n');
      for (const ch of node.children) renderBlock(ch, refs, out);
      out.push('</blockquote>\n');
      break;
    }
    case 'list': {
      const tag = node.listType === 'ordered' ? 'ol' : 'ul';
      out.push('<' + tag + (node.listType === 'ordered' && node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n');
      for (const item of node.children) renderBlock(item, refs, out);
      out.push('</' + tag + '>\n');
      break;
    }
    case 'item': {
      const tight = node.parent.tight;
      out.push('<li>');
      const kids = node.children;
      for (let k = 0; k < kids.length; k++) {
        const ch = kids[k];
        if (ch.t === 'paragraph') {
          const nodes = parseInline(ch.inline, refs, { taskList: k === 0 });
          if (tight) out.push(renderInline(nodes));
          else out.push('<p>' + renderInline(nodes) + '</p>\n');
        } else {
          renderBlock(ch, refs, out);
        }
      }
      out.push('</li>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < node.header.length; k++) {
        const al = node.aligns[k];
        out.push('<th' + (al ? ' align="' + al + '"' : '') + '>' +
          renderInline(parseInline(node.header[k], refs)) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n<tbody>');
      for (const row of node.rows) {
        out.push('<tr>\n');
        for (let k = 0; k < node.header.length; k++) {
          const al = node.aligns[k];
          const cell = k < row.length ? row[k] : '';
          out.push('<td' + (al ? ' align="' + al + '"' : '') + '>' +
            renderInline(parseInline(cell, refs)) + '</td>\n');
        }
        out.push('</tr>\n');
      }
      out.push('</tbody></table>\n');
      break;
    }
  }
}

export function parse(markdown) {
  const { root, refs } = parseBlocks(markdown);
  const out = [];
  renderBlock(root, refs, out);
  return out.join('');
}
