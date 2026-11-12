// Projection, base layers, feature (de)serialisation and off-screen rendering
import { TYPES, PROP_KEYS, FACILITY_KINDS } from './state.js';
import { featureStyle, bearing } from './styles.js';

export const PROJ = 'EPSG:5514';
export const KROVAK = '+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 +alpha=30.2881397527778 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs';

export function setupProj() {
  proj4.defs(PROJ, KROVAK);
  ol.proj.proj4.register(proj4);
  ol.proj.get(PROJ).setExtent([-951499.37, -1353292.51, -159365.31, -911053.67]);
}
export const toLL = (c) => ol.proj.toLonLat(c, PROJ);
export const fromLL = (ll) => ol.proj.fromLonLat(ll, PROJ);
export const PRAGUE = [-743000, -1043800];

// Screen angle (deg, clockwise from up) of true north at a map point for a given view rotation
export function northAngle(center, rotation) {
  try {
    const ll = toLL(center);
    const n = fromLL([ll[0], ll[1] + 0.002]);
    const gamma = Math.atan2(n[0] - center[0], n[1] - center[1]);
    return ((gamma + (rotation || 0)) * 180) / Math.PI;
  } catch { return (rotation || 0) * 180 / Math.PI; }
}

/* ---------- base layers ---------- */

const capsCache = {};
function capsUrl(url) { return url + (url.includes('?') ? '&' : '?') + 'service=WMS&request=GetCapabilities'; }

export async function fetchLayerList(url) {
  const r = await fetch(capsUrl(url));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const caps = new ol.format.WMSCapabilities().read(await r.text());
  const out = [];
  const walk = (L, depth) => {
    if (!L) return;
    if (L.Name) out.push({ name: L.Name, title: L.Title || L.Name, depth, leaf: !L.Layer || !L.Layer.length });
    (L.Layer || []).forEach((c) => walk(c, depth + 1));
  };
  walk(caps.Capability && caps.Capability.Layer, 0);
  return out;
}

export async function resolveLayers(cfg) {
  if (cfg.layers && cfg.layers !== '*') return cfg.layers;
  if (capsCache[cfg.url]) return capsCache[cfg.url];
  try {
    const list = await fetchLayerList(cfg.url);
    const names = list.filter((l) => l.leaf).map((l) => l.name);
    capsCache[cfg.url] = names.join(',') || '0';
  } catch { capsCache[cfg.url] = '0'; }
  return capsCache[cfg.url];
}

// onCorsFail(cfg) is called once if the server refuses cross-origin image reads
export async function buildBaseLayer(cfg, onCorsFail, forceCors = false) {
  const cross = cfg._noCors && !forceCors ? undefined : 'anonymous';
  let layer, source;
  if (cfg.type === 'xyz') {
    source = new ol.source.XYZ({ url: cfg.url, crossOrigin: cross, attributions: cfg.attribution || undefined, maxZoom: 19 });
    layer = new ol.layer.Tile({ source });
  } else {
    const layers = await resolveLayers(cfg);
    source = new ol.source.ImageWMS({
      url: cfg.url, projection: PROJ, ratio: 1.15, crossOrigin: cross, attributions: cfg.attribution || undefined,
      params: { LAYERS: layers, FORMAT: cfg.format || 'image/png', TRANSPARENT: true, VERSION: cfg.version || '1.3.0', STYLES: '' },
    });
    layer = new ol.layer.Image({ source });
  }
  layer.setOpacity(cfg.opacity ?? 1);
  layer.setVisible(!!cfg.visible);
  layer.set('cfgId', cfg.id);
  const err = () => {
    if (!cfg._noCors && !cfg._triedNoCors && onCorsFail) { cfg._triedNoCors = true; cfg._noCors = true; onCorsFail(cfg); }
  };
  source.on(['imageloaderror', 'tileloaderror'], err);
  return layer;
}

/* ---------- features ---------- */

const GJ = new ol.format.GeoJSON();

export function dataToFeature(d, holeN) {
  const f = new ol.Feature(GJ.readGeometry(d.geom));
  f.setId(d.id);
  f.setProperties({ type: d.type, ...(d.props || {}), holeN }, true);
  return f;
}
export function featureToData(f) {
  const props = {};
  for (const k of PROP_KEYS) if (f.get(k) !== undefined) props[k] = f.get(k);
  return { id: f.getId(), type: f.get('type'), geom: GJ.writeGeometryObject(f.getGeometry(), { decimals: 2 }), props };
}
export function facilityFeature(fc) {
  const f = new ol.Feature(new ol.geom.Polygon([fc.coords]));
  f.setId(fc.id);
  f.setProperties({ type: 'facility', kind: fc.kind, label: fc.label, color: FACILITY_KINDS[fc.kind] }, true);
  return f;
}

// Tees without a fixed direction face the nearest basket of the hole
export function applyAutoRot(features) {
  const baskets = features.filter((f) => f.get('type') === 'basket').map((f) => f.getGeometry().getCoordinates());
  for (const f of features) {
    if (f.get('type') !== 'tee') continue;
    const p = f.getGeometry().getCoordinates();
    let best = null, bd = Infinity;
    for (const b of baskets) { const d = Math.hypot(b[0] - p[0], b[1] - p[1]); if (d < bd) { bd = d; best = b; } }
    f.set('autoRot', best ? bearing(p, best) : 0, true);
  }
}

// Data-level helpers (work on the saved JSON)
const first = (h, t) => h.features.find((f) => f.type === t);
export function holeLength(hole) {
  const fw = first(hole, 'fairway');
  if (fw) {
    const c = fw.geom.coordinates; let L = 0;
    for (let i = 1; i < c.length; i++) L += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
    return Math.round(L);
  }
  const t = first(hole, 'tee'), b = first(hole, 'basket');
  if (t && b) return Math.round(Math.hypot(t.geom.coordinates[0] - b.geom.coordinates[0], t.geom.coordinates[1] - b.geom.coordinates[1]));
  return null;
}
export function holeLine(hole) { // fairway, or straight tee→basket
  const fw = first(hole, 'fairway');
  if (fw) return fw.geom.coordinates;
  const t = first(hole, 'tee'), b = first(hole, 'basket');
  return t && b ? [t.geom.coordinates, b.geom.coordinates] : null;
}
export function holeExtentCoords(hole) {
  const out = [];
  for (const f of hole.features) {
    const c = f.geom.coordinates;
    if (f.geom.type === 'Point') {
      out.push(c);
      if (f.type === 'basket') { out.push([c[0] - 20, c[1] - 20], [c[0] + 20, c[1] + 20]); }
    } else if (f.geom.type === 'LineString') out.push(...c);
    else out.push(...c[0]);
  }
  return out;
}

// Simplified features for the overview map: tee, basket and line per hole
export function overviewFeatures(project, exceptN) {
  const out = [];
  for (const h of project.holes) {
    if (h.n === exceptN) continue;
    const line = holeLine(h);
    if (line) {
      const f = new ol.Feature(new ol.geom.LineString(line));
      f.setProperties({ type: 'fairway', holeN: h.n }, true);
      out.push(f);
    }
    const t = first(h, 'tee'), b = first(h, 'basket');
    const fs = [];
    if (b) fs.push(dataToFeature(b, h.n));
    if (t) fs.push(dataToFeature(t, h.n));
    applyAutoRot(fs);
    out.push(...fs);
  }
  return out.filter(Boolean);
}

/* ---------- off-screen rendering for print ---------- */

function composite(map, w, h, background = '#ffffff') {
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
  map.getViewport().querySelectorAll('.ol-layer canvas, canvas.ol-layer').forEach((canvas) => {
    if (canvas.width <= 0) return;
    const op = canvas.parentNode.style.opacity || canvas.style.opacity;
    ctx.globalAlpha = op === '' ? 1 : Number(op);
    const tr = canvas.style.transform;
    const m = tr && tr.match(/^matrix\(([^(]*)\)$/);
    if (m) ctx.setTransform(...m[1].split(',').map(Number));
    else ctx.setTransform(canvas.width ? w / canvas.width : 1, 0, 0, canvas.height ? h / canvas.height : 1, 0, 0);
    ctx.drawImage(canvas, 0, 0);
  });
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

/**
 * Render a map to a canvas.
 * vectors: [{ features, pxPerMm, overview, opacity }]
 * Returns { canvas, skipped: [layer names left out because of CORS] }
 */
export async function renderMap({ wms, vectors, center, resolution, rotation, width, height, timeout = 30000, background = '#ffffff' }) {
  const div = document.createElement('div');
  div.style.cssText = `position:fixed;left:-${width + 5000}px;top:0;width:${width}px;height:${height}px;`;
  document.body.appendChild(div);
  const skipped = [];
  const layers = [];
  const failed = new Set();
  for (const cfg of wms) {
    if (!cfg.visible) continue;
    // Always request with CORS for print: a failed image is simply not drawn and never taints the canvas
    const l = await buildBaseLayer(cfg, null, true);
    l.getSource().on(['imageloaderror', 'tileloaderror'], () => failed.add(cfg.name));
    layers.push(l);
  }
  for (const v of vectors) {
    layers.push(new ol.layer.Vector({
      source: new ol.source.Vector({ features: v.features }),
      opacity: v.opacity ?? 1,
      renderBuffer: 2000,
      style: (f, r) => featureStyle(f, r, { pxPerMm: v.pxPerMm, overview: v.overview }),
    }));
  }
  const map = new ol.Map({
    target: div, pixelRatio: 1, controls: [], interactions: [], layers,
    view: new ol.View({ projection: PROJ, center, resolution, rotation: rotation || 0 }),
  });
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    map.once('rendercomplete', fin);
    setTimeout(fin, timeout);
  });
  const canvas = composite(map, width, height, background);
  skipped.push(...failed);
  map.setTarget(null);
  div.remove();
  return { canvas, skipped };
}
