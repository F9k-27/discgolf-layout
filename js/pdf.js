// Printing. Every page is laid out as HTML with the same code as the on-screen preview.
// Two outputs:
//  - printProject(): pages go to the browser's print dialog ("Save as PDF"). WMS base maps
//    are placed as plain GetMap images, which works even when a server does not allow CORS,
//    and the disc golf features are drawn on a transparent layer above them. Text stays vector.
//  - exportPdf(): pages are rasterised and saved as a PDF file directly. This needs every
//    base map server to allow CORS; layers that don't are left out.
import { MARGIN } from './state.js';
import { t } from './i18n.js';
import { renderMap, resolveLayers, overviewFeatures, dataToFeature, facilityFeature, applyAutoRot, northAngle, holeExtentCoords, PRAGUE, fromLL } from './map.js';
import { pageShell, pageSize, mapAreaMm, renderHoleOverlays, buildTitlePage, footerText, scaleBox, facilityLegendHtml } from './page.js';
import { el, busy, nextFrame } from './util.js';

const CSS_PX_PER_MM = 96 / 25.4; // 1 CSS mm — pages built at this size print at exact paper size
const MAX_WMS_PX = 4000;          // typical WMS MaxWidth/MaxHeight

export function defaultCenter(project, hole) {
  const cs = hole ? holeExtentCoords(hole) : [];
  if (cs.length) {
    const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  if (project.bbox) return [(project.bbox[0] + project.bbox[2]) / 2, (project.bbox[1] + project.bbox[3]) / 2];
  if (project.meta.lat != null && project.meta.lon != null) return fromLL([project.meta.lon, project.meta.lat]);
  return PRAGUE;
}

function imgFromCanvas(c, type = 'image/jpeg', cls = 'map-img') {
  return new Promise((res) => {
    const i = new Image();
    i.className = cls;
    i.onload = () => res(i);
    i.src = c.toDataURL(type, 0.93);
  });
}

function getMapUrl(cfg, layers, bbox, w, h) {
  const v = cfg.version || '1.3.0';
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: v, REQUEST: 'GetMap', LAYERS: layers, STYLES: '',
    FORMAT: cfg.format || 'image/png', TRANSPARENT: 'TRUE', WIDTH: w, HEIGHT: h,
  });
  p.set(v === '1.3.0' ? 'CRS' : 'SRS', 'EPSG:5514');
  p.set('BBOX', bbox.map((x) => x.toFixed(3)).join(','));
  return cfg.url + (cfg.url.includes('?') ? '&' : '?') + p.toString();
}

/**
 * Map content for the print path: one element per visible base layer (bottom → top),
 * then the features. WMS = plain <img> of a north-up GetMap covering the (rotated) frame,
 * rotated with CSS to match the view. XYZ tiles need reprojection, so they go through
 * OpenLayers (those servers normally allow CORS).
 */
async function buildMapStack(project, { center, rotation = 0, scale, awMm, ahMm, dpi, vectors }) {
  const stack = el('div', 'map-stack');
  const skipped = [];
  const loads = [];
  const ppm = dpi / 25.4;
  const mpp = scale / 1000 / ppm;                 // metres per output pixel
  const W = Math.round(awMm * ppm), H = Math.round(ahMm * ppm);
  const wM = (awMm * scale) / 1000, hM = (ahMm * scale) / 1000;
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  const bw = wM * c + hM * s, bh = wM * s + hM * c; // north-up box covering the rotated frame

  for (const cfg of project.wms) {
    if (!cfg.visible) continue;
    if (cfg.type === 'xyz') {
      const r = await renderMap({ wms: [cfg], vectors: [], center, rotation, resolution: mpp, width: W, height: H, background: null });
      if (r.skipped.length) { skipped.push(cfg.name); continue; }
      const im = await imgFromCanvas(r.canvas, 'image/png');
      im.style.opacity = cfg.opacity ?? 1;
      stack.appendChild(im);
      continue;
    }
    const k = Math.min(1, MAX_WMS_PX / Math.max(bw / mpp, bh / mpp));
    const iw = Math.max(1, Math.round((bw / mpp) * k)), ih = Math.max(1, Math.round((bh / mpp) * k));
    const url = getMapUrl(cfg, await resolveLayers(cfg), [center[0] - bw / 2, center[1] - bh / 2, center[0] + bw / 2, center[1] + bh / 2], iw, ih);
    const im = new Image();
    im.className = 'map-wms';
    im.alt = '';
    Object.assign(im.style, {
      width: (bw / wM) * 100 + '%', height: (bh / hM) * 100 + '%',
      left: ((1 - bw / wM) / 2) * 100 + '%', top: ((1 - bh / hM) / 2) * 100 + '%',
      transform: `rotate(${rotation}rad)`, opacity: cfg.opacity ?? 1,
    });
    loads.push(new Promise((res) => {
      const timer = setTimeout(() => { skipped.push(cfg.name); res(); }, 60000);
      im.onload = () => { clearTimeout(timer); res(); };
      im.onerror = () => { clearTimeout(timer); skipped.push(cfg.name); im.remove(); res(); };
    }));
    im.src = url;
    stack.appendChild(im);
  }

  const v = await renderMap({ wms: [], vectors, center, rotation, resolution: mpp, width: W, height: H, background: null });
  stack.appendChild(await imgFromCanvas(v.canvas, 'image/png'));
  await Promise.all(loads);
  return { stack, skipped };
}

/* ---------- page builders (shared) ---------- */

function holeVectors(project, hole, ppm) {
  const feats = hole.features.map((d) => dataToFeature(d, hole.n));
  applyAutoRot(feats);
  const vectors = [];
  if (hole.page.showOthers) vectors.push({ features: overviewFeatures(project, hole.n), pxPerMm: ppm, overview: true, opacity: 0.45 });
  vectors.push({ features: feats, pxPerMm: ppm });
  return vectors;
}

async function buildHolePage(project, hole, dpi, mode) {
  const pg = hole.page;
  const [aw, ah] = mapAreaMm(pg);
  const ppm = dpi / 25.4;
  const center = pg.center || defaultCenter(project, hole);
  const rotation = pg.rotation || 0;
  const vectors = holeVectors(project, hole, ppm);
  const { page, area } = pageShell(pg, CSS_PX_PER_MM, footerText(project), `${hole.n} / ${project.holes.length}`);
  let skipped;
  if (mode === 'print') {
    const r = await buildMapStack(project, { center, rotation, scale: pg.scale, awMm: aw, ahMm: ah, dpi, vectors });
    area.appendChild(r.stack);
    skipped = r.skipped;
  } else {
    const r = await renderMap({
      wms: project.wms, vectors, center, rotation,
      resolution: pg.scale / 1000 / ppm, width: Math.round(aw * ppm), height: Math.round(ah * ppm),
    });
    area.appendChild(await imgFromCanvas(r.canvas));
    skipped = r.skipped;
  }
  renderHoleOverlays(area, project, hole, { pxPerMm: CSS_PX_PER_MM, editable: false, north: northAngle(center, rotation) });
  return { page, size: pageSize(pg), skipped };
}

// The title page needs to be in the document to measure how much room the map gets
async function buildTitle(project, dpi, mode, host) {
  const { page, area } = buildTitlePage(project, CSS_PX_PER_MM);
  host.appendChild(page);
  await nextFrame();
  const r = area.getBoundingClientRect();
  const awMm = r.width / CSS_PX_PER_MM, ahMm = r.height / CSS_PX_PER_MM;
  const ppm = dpi / 25.4;
  const W = Math.round(awMm * ppm), H = Math.round(ahMm * ppm);

  let ext = project.bbox;
  if (!ext) {
    const cs = project.holes.flatMap(holeExtentCoords).concat(project.facilities.flatMap((f) => f.coords));
    if (cs.length) {
      const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
      ext = [Math.min(...xs) - 30, Math.min(...ys) - 30, Math.max(...xs) + 30, Math.max(...ys) + 30];
    }
  }
  const center = ext ? [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2] : defaultCenter(project);
  const resPx = ext ? Math.max((ext[2] - ext[0]) / W, (ext[3] - ext[1]) / H) : 1000 / ppm;
  const scale = Math.ceil((resPx * ppm * 1000) / 50) * 50;
  const feats = overviewFeatures(project).concat(project.facilities.map(facilityFeature));
  applyAutoRot(feats);
  const vectors = [{ features: feats, pxPerMm: ppm, overview: true }];
  let skipped;
  if (mode === 'print') {
    const s = await buildMapStack(project, { center, rotation: 0, scale, awMm, ahMm, dpi, vectors });
    area.appendChild(s.stack);
    skipped = s.skipped;
  } else {
    const s = await renderMap({ wms: project.wms, vectors, center, resolution: scale / 1000 / ppm, rotation: 0, width: W, height: H });
    area.appendChild(await imgFromCanvas(s.canvas));
    skipped = s.skipped;
  }
  const sb = el('div', 'ov ov-box ov-scale', scaleBox(scale, northAngle(center, 0)));
  sb.style.left = sb.style.bottom = '0';
  area.appendChild(sb);
  const fl = facilityLegendHtml(project);
  if (fl) {
    const lg = el('div', 'ov ov-box ov-legend', fl);
    lg.style.right = lg.style.bottom = '0';
    area.appendChild(lg);
  }
  return { page, size: pageSize(project.titlePage), skipped };
}

/* ---------- output 1: browser print / Save as PDF ---------- */

export async function printProject(project, { dpi = 200, title = true, holes = null } = {}) {
  document.querySelectorAll('.print-root, #printPageStyle').forEach((e) => e.remove());
  const root = el('div', 'print-root');
  document.body.appendChild(root);
  const sizes = new Map();
  const skipped = new Set();
  const place = ({ page, size: [w, h], skipped: sk }) => {
    sk.forEach((s) => skipped.add(s));
    const name = `dgl${Math.round(w)}x${Math.round(h)}`;
    sizes.set(name, [w, h]);
    page.style.setProperty('page', name);
    if (!page.isConnected) root.appendChild(page);
  };
  try {
    if (title) { busy(t('busy.title')); place(await buildTitle(project, dpi, 'print', root)); }
    const list = holes || project.holes;
    for (let i = 0; i < list.length; i++) {
      busy(t('busy.hole', { i: i + 1, n: list.length }));
      place(await buildHolePage(project, list[i], dpi, 'print'));
    }
  } catch (e) {
    root.remove();
    busy(null);
    throw e;
  }
  const st = document.createElement('style');
  st.id = 'printPageStyle';
  st.textContent = '@page { margin: 0; }\n' + [...sizes].map(([n, [w, h]]) => `@page ${n} { size: ${w}mm ${h}mm; margin: 0; }`).join('\n');
  document.head.appendChild(st);
  busy(null);
  await nextFrame();
  const cleanup = () => { root.remove(); st.remove(); };
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
  return { skipped: [...skipped] };
}

/* ---------- output 2: direct PDF file (raster, needs CORS) ---------- */

async function rasterise(page, dpi) {
  return html2canvas(page, { scale: dpi / 96, backgroundColor: '#ffffff', logging: false, useCORS: true, scrollX: 0, scrollY: 0 });
}

export async function exportPdf(project, { dpi = 200, title = true, holes = null } = {}) {
  const host = el('div', 'print-host');
  document.body.appendChild(host);
  const skipped = new Set();
  let pdf = null;
  const add = async ({ page, size: [w, h], skipped: sk }) => {
    sk.forEach((s) => skipped.add(s));
    if (!page.isConnected) host.appendChild(page);
    await nextFrame();
    const canvas = await rasterise(page, dpi);
    page.remove();
    const orient = w > h ? 'l' : 'p';
    if (!pdf) pdf = new jspdf.jsPDF({ unit: 'mm', format: [Math.min(w, h), Math.max(w, h)], orientation: orient, compress: true });
    else pdf.addPage([Math.min(w, h), Math.max(w, h)], orient);
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, w, h, undefined, 'FAST');
  };
  try {
    if (title) { busy(t('busy.title')); await add(await buildTitle(project, dpi, 'raster', host)); }
    const list = holes || project.holes;
    for (let i = 0; i < list.length; i++) {
      busy(t('busy.hole', { i: i + 1, n: list.length }));
      await add(await buildHolePage(project, list[i], dpi, 'raster'));
    }
    busy(t('busy.pdf'));
    await nextFrame();
    return { blob: pdf.output('blob'), skipped: [...skipped] };
  } finally {
    host.remove();
    busy(null);
  }
}

export { MARGIN };
