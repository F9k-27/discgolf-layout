// Page layout shared by the on-screen preview and the PDF renderer.
// Everything is sized with the CSS variable --mm (pixels per paper millimetre).
import { PAPER, MARGIN, TYPES, TOOL_ORDER, FACILITY_KINDS } from './state.js';
import { t } from './i18n.js';
import { legendIcon } from './styles.js';
import { holeLength } from './map.js';
import { esc, el, sanitizeHtml } from './util.js';

export function pageSize(pg) {
  const [w, h] = PAPER[pg.paper] || PAPER.A4;
  return pg.orientation === 'landscape' ? [h, w] : [w, h];
}
export function mapAreaMm(pg) {
  const [w, h] = pageSize(pg);
  return [w - 2 * MARGIN, h - 2 * MARGIN];
}

const mm = (v) => `calc(var(--mm) * ${v})`;
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Page skeleton: .page > .map-area (+ footer in the bottom margin)
export function pageShell(pg, pxPerMm, footerL = '', footerR = '') {
  const [w, h] = pageSize(pg);
  const page = el('div', 'page');
  page.style.setProperty('--mm', pxPerMm + 'px');
  page.style.width = w * pxPerMm + 'px';
  page.style.height = h * pxPerMm + 'px';
  const area = el('div', 'map-area');
  area.style.left = area.style.top = mm(MARGIN);
  area.style.width = mm(w - 2 * MARGIN);
  area.style.height = mm(h - 2 * MARGIN);
  page.appendChild(area);
  const foot = el('div', 'page-foot', `<span>${esc(footerL)}</span><span>${esc(footerR)}</span>`);
  page.appendChild(foot);
  return { page, area };
}

export function footerText(project) {
  const m = project.meta;
  return [m.name || t('misc.untitled'), m.place, [m.date && fmtDate(m.date), m.time].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}
export function fmtDate(d) {
  if (!d) return '';
  const [y, mo, da] = d.split('-').map(Number);
  if (!y) return d;
  return `${da}. ${mo}. ${y}`;
}

function placeBox(e, b) {
  e.style.left = e.style.right = e.style.top = e.style.bottom = e.style.transform = '';
  const v = b.corner[0], h = b.corner[1];
  if (v === 't') e.style.top = mm(b.dy || 0); else e.style.bottom = mm(b.dy || 0);
  if (h === 'l') e.style.left = mm(b.dx || 0);
  else if (h === 'r') e.style.right = mm(b.dx || 0);
  else { e.style.left = '50%'; e.style.transform = 'translateX(-50%)'; }
}

/* ---------- scale bar + north arrow ---------- */

function niceBar(scale, targetMm = 34) {
  const m = (targetMm * scale) / 1000;
  const p = 10 ** Math.floor(Math.log10(m));
  let best = p;
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p <= m) best = k * p;
  return { meters: best, mm: (best * 1000) / scale };
}
const northCache = {};
function northIcon(deg) {
  const key = Math.round(deg * 10);
  if (northCache[key]) return northCache[key];
  const s = 120, c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  x.translate(s / 2, s / 2);
  x.rotate((deg * Math.PI) / 180);
  x.beginPath(); x.moveTo(0, -40); x.lineTo(16, 26); x.lineTo(0, 14); x.closePath(); x.fillStyle = '#111'; x.fill();
  x.beginPath(); x.moveTo(0, -40); x.lineTo(-16, 26); x.lineTo(0, 14); x.closePath(); x.fillStyle = '#fff'; x.fill();
  x.lineWidth = 3; x.strokeStyle = '#111';
  x.beginPath(); x.moveTo(0, -40); x.lineTo(16, 26); x.lineTo(0, 14); x.lineTo(-16, 26); x.closePath(); x.stroke();
  x.fillStyle = '#111'; x.font = 'bold 30px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('N', 0, -52 + 0);
  return (northCache[key] = c.toDataURL());
}
export function scaleBox(scale, north) {
  const bar = niceBar(scale);
  const segs = [0, 1, 2, 3].map((i) => `<i style="width:${mm(bar.mm / 4)}" class="${i % 2 ? 'w' : 'b'}"></i>`).join('');
  const lab = (v) => (v >= 1000 ? fmtInt(v / 1000) + ' km' : (Number.isInteger(v) ? v : v.toFixed(1)) + (v === bar.meters ? ' m' : ''));
  return `
    <div class="sb-wrap">
      <img class="north" src="${northIcon(north || 0)}" alt="N">
      <div>
        <div class="sb-bar">${segs}</div>
        <div class="sb-lab" style="width:${mm(bar.mm)}"><span>0</span><span>${lab(bar.meters / 2)}</span><span>${lab(bar.meters)}</span></div>
        <div class="sb-txt">1 : ${fmtInt(scale)}</div>
      </div>
    </div>`;
}

/* ---------- hole overlays ---------- */

const iconCache = {};
function icon(type, props) {
  const key = type + JSON.stringify(props);
  return iconCache[key] || (iconCache[key] = legendIcon(type, props, 8));
}

export function legendHtml(features) {
  const seen = new Map();
  for (const f of features) if (!seen.has(f.type)) seen.set(f.type, f.props || {});
  const rows = TOOL_ORDER.filter((tp) => seen.has(tp)).map((tp) => {
    const p = { ...seen.get(tp) }; delete p.label; delete p.rotation;
    const name = tp === 'basket' ? t('legend.basket') : t('type.' + tp);
    return `<div class="lg-row"><img src="${icon(tp, p)}" alt=""><span>${esc(name)}</span></div>`;
  });
  return rows.length ? `<div class="lg-title">${t('page.legend')}</div>${rows.join('')}` : '';
}

/**
 * o = { pxPerMm, editable, north, total, onBoxMove(key, box) }
 */
export function renderHoleOverlays(area, project, hole, o) {
  area.querySelectorAll('.ov').forEach((e) => e.remove());
  const pg = hole.page;
  const len = holeLength(hole);

  const hd = el('div', 'ov ov-header', `
    <div class="hn">${hole.n}</div>
    <div class="hp"><div class="par">${t('page.par')} ${hole.par}</div>${len ? `<div class="len">${len} m</div>` : ''}</div>`);
  placeBox(hd, { corner: 'tl', dx: 0, dy: 0 });
  area.appendChild(hd);

  const boxes = [];
  if (pg.boxes.notes.show && (hole.info || '').trim()) {
    boxes.push(['notes', el('div', 'ov ov-box ov-notes', esc(hole.info).replace(/\n/g, '<br>'))]);
  }
  if (pg.boxes.legend.show) {
    const lg = legendHtml(hole.features);
    if (lg) boxes.push(['legend', el('div', 'ov ov-box ov-legend', lg)]);
  }
  if (pg.boxes.scale.show) {
    boxes.push(['scale', el('div', 'ov ov-box ov-scale', scaleBox(pg.scale, o.north))]);
  }
  for (const [key, e] of boxes) {
    placeBox(e, pg.boxes[key]);
    area.appendChild(e);
    if (o.editable) makeDraggable(e, key, area, o);
  }
}

function makeDraggable(e, key, area, o) {
  e.classList.add('draggable');
  e.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const ar = area.getBoundingClientRect(), r = e.getBoundingClientRect();
    const offX = ev.clientX - r.left, offY = ev.clientY - r.top;
    e.setPointerCapture(ev.pointerId);
    e.classList.add('dragging');
    const move = (m) => {
      const x = Math.max(0, Math.min(ar.width - r.width, m.clientX - ar.left - offX));
      const y = Math.max(0, Math.min(ar.height - r.height, m.clientY - ar.top - offY));
      e.style.right = e.style.bottom = e.style.transform = '';
      e.style.left = x + 'px'; e.style.top = y + 'px';
    };
    const up = () => {
      e.removeEventListener('pointermove', move);
      e.removeEventListener('pointerup', up);
      e.classList.remove('dragging');
      const a2 = area.getBoundingClientRect(), r2 = e.getBoundingClientRect();
      const L = r2.left - a2.left, T = r2.top - a2.top, R = a2.right - r2.right, B = a2.bottom - r2.bottom;
      const cx = (L + r2.width / 2) / a2.width, cy = (T + r2.height / 2) / a2.height;
      const h = cx < 0.36 ? 'l' : cx > 0.64 ? 'r' : 'c';
      const v = cy < 0.5 ? 't' : 'b';
      const k = o.pxPerMm;
      const box = {
        ...hole_box_default(), show: true, corner: v + h,
        dx: h === 'l' ? L / k : h === 'r' ? R / k : 0,
        dy: v === 't' ? T / k : B / k,
      };
      box.dx = Math.max(0, Math.round(box.dx * 10) / 10);
      box.dy = Math.max(0, Math.round(box.dy * 10) / 10);
      o.onBoxMove && o.onBoxMove(key, box);
    };
    e.addEventListener('pointermove', move);
    e.addEventListener('pointerup', up);
  });
}
const hole_box_default = () => ({ corner: 'tl', dx: 0, dy: 0, show: true });

/* ---------- title page ---------- */

export function buildTitlePage(project, pxPerMm) {
  const pg = project.titlePage;
  const [w, h] = pageSize(pg);
  const page = el('div', 'page title-page');
  page.style.setProperty('--mm', pxPerMm + 'px');
  page.style.width = w * pxPerMm + 'px';
  page.style.height = h * pxPerMm + 'px';
  const m = project.meta;
  const when = [fmtDate(m.date), m.time].filter(Boolean).join(' · ');
  const inner = el('div', 'tp-inner');
  inner.style.inset = mm(MARGIN);

  const head = el('div', 'tp-head', `
    <div class="tp-name">${esc(m.name || t('misc.untitled'))}</div>
    <div class="tp-meta">${[m.place && esc(m.place), when && esc(when)].filter(Boolean).join('<span class="dot">•</span>')}</div>`);
  const mapBox = el('div', 'tp-map map-area');
  const bottom = el('div', 'tp-bottom');

  // scorecard: rows of 9
  const holes = project.holes;
  const chunks = [];
  for (let i = 0; i < holes.length; i += 9) chunks.push(holes.slice(i, i + 9));
  let totPar = 0, totLen = 0;
  const tables = chunks.map((ch) => {
    const pars = ch.map((x) => x.par), lens = ch.map((x) => holeLength(x) || 0);
    const sp = pars.reduce((a, b) => a + b, 0), sl = lens.reduce((a, b) => a + b, 0);
    totPar += sp; totLen += sl;
    return `<table class="sc">
      <tr><th>${t('title.hole')}</th>${ch.map((x) => `<td class="hn">${x.n}</td>`).join('')}<td class="sum">${t('title.sum')}</td></tr>
      <tr><th>${t('title.par')}</th>${pars.map((p) => `<td>${p}</td>`).join('')}<td class="sum">${sp}</td></tr>
      <tr class="len"><th>${t('title.length')}</th>${lens.map((l) => `<td>${l || '–'}</td>`).join('')}<td class="sum">${sl || '–'}</td></tr>
    </table>`;
  }).join('');
  const notes = sanitizeHtml(m.notesHtml || '');
  bottom.innerHTML = `
    <div class="tp-sc">${tables}<div class="tp-total">${t('title.total', { par: totPar, len: fmtInt(totLen) })}</div></div>
    ${notes.replace(/<[^>]*>|&nbsp;|\s/g, '') ? `<div class="tp-notes">${notes}</div>` : ''}`;

  inner.append(head, mapBox, bottom);
  page.appendChild(inner);
  return { page, area: mapBox };
}

export function facilityLegendHtml(project) {
  const kinds = [...new Set(project.facilities.map((f) => f.kind))];
  if (!kinds.length) return '';
  return kinds.map((k) => `<div class="lg-row"><img src="${icon('facility', { kind: k, color: FACILITY_KINDS[k] })}" alt=""><span>${esc(t('fac.' + k))}</span></div>`).join('');
}
