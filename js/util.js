export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let h;
  const d = (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(h); fn(...a); };
  return d;
}

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

export function slug(s) {
  return (String(s || 'layout').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()) || 'layout';
}

let toastTimer;
export function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, kind === 'warn' ? 6000 : 2600);
}

export function busy(text) {
  const b = document.getElementById('busy');
  if (text == null) { b.classList.add('hidden'); return; }
  document.getElementById('busyText').textContent = text;
  b.classList.remove('hidden');
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// Allow only simple formatting in rich-text notes (they can come from opened files)
const OK_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'DIV', 'SPAN', 'FONT', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'A', 'SMALL', 'SUB', 'SUP', 'BLOCKQUOTE', 'HR', 'TABLE', 'TBODY', 'TR', 'TD', 'TH']);
const OK_ATTR = new Set(['style', 'color', 'size', 'face', 'href', 'align']);
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  const walk = (node) => {
    for (const ch of [...node.children]) {
      if (!OK_TAGS.has(ch.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'svg', 'SVG', 'MATH'].includes(ch.tagName)) { ch.remove(); continue; }
        walk(ch);
        ch.replaceWith(...ch.childNodes);
        continue;
      }
      for (const a of [...ch.attributes]) {
        const n = a.name.toLowerCase();
        if (!OK_ATTR.has(n)) ch.removeAttribute(a.name);
        else if (n === 'href' && !/^(https?:|mailto:|tel:)/i.test(a.value.trim())) ch.removeAttribute(a.name);
        else if (n === 'style' && /url\s*\(|expression|javascript:/i.test(a.value)) ch.removeAttribute(a.name);
      }
      walk(ch);
    }
  };
  walk(root);
  return root.innerHTML;
}
