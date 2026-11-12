// Project model, defaults and constants
export const APP_ID = 'discgolf-layout';
export const VERSION = 1;

export const PAPER = { A4: [210, 297], A3: [297, 420] };
export const MARGIN = 8; // mm around the map area on every page

// Print scales the zoom snaps to (1 : n)
export const NICE_SCALES = [200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 50000];

// Feature types of a hole. size = metres (real world) unless noted, width = mm on paper.
export const TYPES = {
  tee:      { geom: 'Point',      color: '#263238', rotation: null, label: '' },
  basket:   { geom: 'Point',      color: '#c62828', c1: true, c2: true },
  fairway:  { geom: 'LineString', color: '#ffe14d', width: 0.6 },
  ob:       { geom: 'Polygon',    color: '#e53935' },
  hazard:   { geom: 'Polygon',    color: '#fb8c00' },
  water:    { geom: 'Polygon',    color: '#1e88e5' },
  mando:    { geom: 'Point',      color: '#d50000', rotation: 0 },
  mandoObj: { geom: 'Polygon',    color: '#d50000', label: 'M' },
  dropzone: { geom: 'Point',      color: '#fdd835' },
  tree:     { geom: 'Point',      color: '#2e7d32', size: 6 },
  object:   { geom: 'Point',      color: '#6d4c41', size: 2, label: '' },
  line:     { geom: 'LineString', color: '#455a64', width: 0.5 },
  text:     { geom: 'Point',      color: '#111111', size: 3.5, label: 'Text' },
};
export const TOOL_ORDER = ['tee', 'basket', 'fairway', 'ob', 'hazard', 'water', 'mando', 'mandoObj', 'dropzone', 'tree', 'object', 'line', 'text'];
export const PROP_KEYS = ['color', 'size', 'width', 'rotation', 'label', 'c1', 'c2'];

export const FACILITY_KINDS = {
  parking: '#1565c0',
  toilet:  '#6d4c41',
  hq:      '#c62828',
  food:    '#ef6c00',
  aid:     '#2e7d32',
  other:   '#546e7a',
};

// Base map layers. Array order = drawing order (first = bottom).
export const DEFAULT_WMS = [
  { id: 'osm', name: 'OpenStreetMap', type: 'xyz', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors', visible: false, opacity: 1, builtin: true },
  { id: 'orto', name: 'Ortofoto ČÚZK', type: 'wms', url: 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer',
    layers: '0', format: 'image/jpeg', attribution: '© ČÚZK', visible: true, opacity: 1, builtin: true },
  { id: 'ztm5', name: 'ZTM5 (ČÚZK)', type: 'wms', url: 'https://ags.cuzk.gov.cz/arcgis1/services/ZTM/ZTM5/MapServer/WMSServer',
    layers: '0', format: 'image/png', attribution: '© ČÚZK', visible: false, opacity: 1, builtin: true },
  { id: 'zabaged', name: 'ZABAGED polohopis (ČÚZK)', type: 'wms', url: 'https://ags.cuzk.gov.cz/arcgis/services/ZABAGED_POLOHOPIS/MapServer/WMSServer',
    layers: '*', format: 'image/png', attribution: '© ČÚZK', visible: false, opacity: 0.8, builtin: true },
];

export const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));

export function defaultBoxes() {
  return {
    notes:  { corner: 'tr', dx: 0, dy: 0, show: true },
    legend: { corner: 'br', dx: 0, dy: 0, show: true },
    scale:  { corner: 'bl', dx: 0, dy: 0, show: true },
  };
}

export function newHole(n) {
  return {
    n, par: 3, info: '', features: [],
    page: { paper: 'A4', orientation: 'portrait', scale: 1000, rotation: 0, center: null, showOthers: false, boxes: defaultBoxes() },
  };
}

export function newProject() {
  return {
    app: APP_ID, version: VERSION,
    meta: { name: '', place: '', lat: null, lon: null, date: '', time: '', notesHtml: '' },
    bbox: null,              // [minx, miny, maxx, maxy] in EPSG:5514
    facilities: [],          // { id, kind, label, coords: [[x,y],...] }
    wms: clone(DEFAULT_WMS),
    titlePage: { paper: 'A4', orientation: 'portrait' },
    holes: Array.from({ length: 18 }, (_, i) => newHole(i + 1)),
  };
}

// Fill missing fields when opening an older or hand-edited file
export function normalizeProject(o) {
  const base = newProject();
  const p = { ...base, ...o };
  p.meta = { ...base.meta, ...(o.meta || {}) };
  p.titlePage = { ...base.titlePage, ...(o.titlePage || {}) };
  p.wms = Array.isArray(o.wms) && o.wms.length ? o.wms : base.wms;
  p.facilities = Array.isArray(o.facilities) ? o.facilities : [];
  const holes = Array.isArray(o.holes) && o.holes.length ? o.holes : base.holes;
  p.holes = holes.map((h, i) => {
    const d = newHole(i + 1);
    return {
      ...d, ...h, n: i + 1,
      features: (Array.isArray(h.features) ? h.features : []).map(migrateFeature),
      page: { ...d.page, ...(h.page || {}), boxes: { ...d.page.boxes, ...((h.page || {}).boxes || {}) } },
    };
  });
  p.app = APP_ID; p.version = VERSION;
  return p;
}

// Older files stored the mando object as a point: turn it into a small octagon of its size
function migrateFeature(f) {
  if (f.type !== 'mandoObj' || !f.geom || f.geom.type !== 'Point') return f;
  const [x, y] = f.geom.coordinates;
  const r = Math.max(((f.props && f.props.size) || 1) / 2, 1);
  const ring = [];
  for (let i = 0; i <= 8; i++) { const a = (i % 8) * Math.PI / 4; ring.push([+(x + r * Math.sin(a)).toFixed(2), +(y + r * Math.cos(a)).toFixed(2)]); }
  const props = { ...(f.props || {}) }; delete props.size;
  return { ...f, geom: { type: 'Polygon', coordinates: [ring] }, props };
}

// Strip runtime-only keys (prefixed with _)
export function cleanForSave(p) {
  return JSON.parse(JSON.stringify(p, (k, v) => (k.startsWith('_') ? undefined : v)));
}
