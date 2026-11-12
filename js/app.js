import { t, setLang, getLang, applyStatic } from './i18n.js';
import { newProject, newHole, normalizeProject, cleanForSave, uid, TYPES, TOOL_ORDER, FACILITY_KINDS, DEFAULT_WMS, NICE_SCALES, PAPER, MARGIN, APP_ID, defaultBoxes } from './state.js';
import { setupProj, PROJ, toLL, fromLL, PRAGUE, buildBaseLayer, fetchLayerList, dataToFeature, featureToData, facilityFeature, applyAutoRot, overviewFeatures, northAngle, holeLength } from './map.js';
import { featureStyle, legendIcon, bearing } from './styles.js';
import { pageSize, renderHoleOverlays, footerText } from './page.js';
import { exportPdf, printProject, defaultCenter } from './pdf.js';
import { buildGpkg } from './gpkg.js';
import { $, $$, esc, debounce, download, slug, toast, busy, sanitizeHtml } from './util.js';

setupProj();

/* =========================================================
   State
   ========================================================= */
const AUTOSAVE = 'dgl.autosave';
let P = null;           // current project
let cur = 1;            // current hole number
let view = 'start';

const saveLocal = debounce(() => {
  if (!P) return;
  try { localStorage.setItem(AUTOSAVE, JSON.stringify({ savedAt: Date.now(), project: cleanForSave(P) })); } catch { /* quota */ }
}, 500);
const H = () => P.holes[cur - 1];

/* =========================================================
   Language
   ========================================================= */
function initLang() {
  const saved = localStorage.getItem('dgl.lang');
  setLang(saved || ((navigator.language || '').toLowerCase().startsWith('cs') || (navigator.language || '').toLowerCase().startsWith('sk') ? 'cz' : 'en'));
  $$('#lang button').forEach((b) => b.addEventListener('click', () => {
    setLang(b.dataset.lang);
    localStorage.setItem('dgl.lang', b.dataset.lang);
    refreshAll();
  }));
}
function refreshAll() {
  applyStatic();
  $$('#lang button').forEach((b) => b.classList.toggle('active', b.dataset.lang === getLang()));
  renderStart();
  if (!P) return;
  renderTop();
  renderProjectSide(); renderProjectRight();
  if (hmap) { renderHoleSide(); renderEditorBar(); renderProps(); renderOverlays(); }
  renderLayers(); renderExport();
}

/* =========================================================
   Views
   ========================================================= */
function show(v) {
  if (!P && v !== 'start') v = 'start';
  view = v;
  $$('.view').forEach((e) => e.classList.toggle('active', e.id === 'view-' + v));
  $$('#tabs button').forEach((b) => { b.classList.toggle('active', b.dataset.tab === v); b.disabled = !P; });
  $('#btnSave').disabled = !P;
  if (v === 'project') { pmap.updateSize(); }
  if (v === 'holes') { if (!hmapReady) openHole(cur); else layoutFrame(); }
  if (v === 'layers') renderLayers();
  if (v === 'export') renderExport();
}
function renderTop() {
  $('#projName').textContent = P ? (P.meta.name || t('misc.untitled')) : '';
}

/* =========================================================
   Start screen, new / open / save
   ========================================================= */
function renderStart() {
  const box = $('#startContinue');
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(AUTOSAVE) || 'null'); } catch { saved = null; }
  if (saved && saved.project && !P) {
    const d = new Date(saved.savedAt).toLocaleString(getLang() === 'cz' ? 'cs-CZ' : 'en-GB');
    box.innerHTML = `<div class="continue"><div><b>${esc(saved.project.meta?.name || t('misc.untitled'))}</b><div class="muted">${t('start.saved', { date: esc(d) })}</div></div>
      <button class="btn primary" id="startCont">${t('start.continue')}</button></div>`;
    $('#startCont').onclick = () => loadProject(saved.project, false);
  } else box.innerHTML = '';
}

function loadProject(obj, fromFile) {
  P = normalizeProject(obj);
  cur = 1;
  hmapReady = false;
  syncBase();
  loadProjectMap();
  renderTop();
  renderProjectSide(); renderProjectRight();
  saveLocal();
  if (fromFile) toast(t('msg.loaded'));
  show('project');
  fitProjectView();
}

function newProj() {
  if (P && !confirm(t('msg.confirmNew'))) return;
  loadProject(newProject(), false);
}

function saveJson() {
  if (!P) return;
  download(JSON.stringify(cleanForSave(P), null, 1), `${slug(P.meta.name)}.dgl.json`, 'application/json');
  toast(t('msg.saved'));
}

function openFile() { $('#fileOpen').value = ''; $('#fileOpen').click(); }
$('#fileOpen').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    if (!obj || (obj.app !== APP_ID && !Array.isArray(obj.holes))) throw new Error('bad');
    loadProject(obj, true);
  } catch { toast(t('msg.badFile'), 'warn'); }
});

/* =========================================================
   Base layers (shared by both maps)
   ========================================================= */
let pBase, hBase;
async function fillGroup(group) {
  const layers = [];
  for (const cfg of P.wms) layers.push(await buildBaseLayer(cfg, onCorsFail));
  group.setLayers(new ol.Collection(layers));
}
function syncBase() { if (!P) return; fillGroup(pBase); if (hBase) fillGroup(hBase); }
const onCorsFail = debounce(() => { syncBase(); renderLayers(); if (hmap) renderHoleSide(); }, 300);

// Quick update without rebuilding (visibility / opacity)
function updateBaseProps() {
  for (const g of [pBase, hBase]) {
    if (!g) continue;
    g.getLayers().forEach((l) => {
      const cfg = P.wms.find((c) => c.id === l.get('cfgId'));
      if (cfg) { l.setVisible(!!cfg.visible); l.setOpacity(cfg.opacity ?? 1); }
    });
  }
}

/* =========================================================
   PROJECT TAB
   ========================================================= */
let pmap, areaSrc, facSrc, ovSrc, locSrc, facLayer, pDraw = null, pTool = 'select';
const pSel = new ol.Collection();

function initProjectMap() {
  pBase = new ol.layer.Group();
  areaSrc = new ol.source.Vector(); facSrc = new ol.source.Vector(); ovSrc = new ol.source.Vector(); locSrc = new ol.source.Vector();
  const st = (f, r) => featureStyle(f, r, { pxPerMm: 3.4, overview: true, selected: (x) => pSel.getArray().includes(x) });
  facLayer = new ol.layer.Vector({ source: facSrc, style: st });
  pmap = new ol.Map({
    target: 'pmap',
    layers: [pBase, new ol.layer.Vector({ source: ovSrc, style: st }), new ol.layer.Vector({ source: areaSrc, style: st }), facLayer, new ol.layer.Vector({ source: locSrc, style: st })],
    view: new ol.View({ projection: PROJ, center: PRAGUE, resolution: 300 }),
    controls: ol.control.defaults.defaults({ attributionOptions: { collapsible: true } }).extend([new ol.control.ScaleLine()]),
  });
  const tr = new ol.interaction.Translate({ features: pSel });
  const md = new ol.interaction.Modify({ features: pSel });
  pmap.addInteraction(tr); pmap.addInteraction(md);
  pmap.on('singleclick', (e) => {
    if (pTool === 'location') {
      const ll = toLL(e.coordinate);
      P.meta.lon = +ll[0].toFixed(6); P.meta.lat = +ll[1].toFixed(6);
      updateLoc(); setPTool('select'); renderProjectSide(); saveLocal();
      return;
    }
    if (pTool !== 'select') return;
    const f = pmap.forEachFeatureAtPixel(e.pixel, (x) => x, { layerFilter: (l) => l === facLayer, hitTolerance: 4 });
    pSel.clear();
    if (f) pSel.push(f);
    facLayer.changed();
    renderProjectRight();
  });
  facSrc.on('changefeature', (e) => {
    const fc = P.facilities.find((x) => x.id === e.feature.getId());
    if (fc) { fc.coords = e.feature.getGeometry().getCoordinates()[0].map((c) => [+c[0].toFixed(2), +c[1].toFixed(2)]); saveLocal(); }
  });
}

function loadProjectMap() {
  areaSrc.clear(); facSrc.clear(); ovSrc.clear(); pSel.clear();
  refreshArea();
  P.facilities.forEach((fc) => facSrc.addFeature(facilityFeature(fc)));
  refreshOverview();
  updateLoc();
}
function refreshArea() {
  areaSrc.clear();
  if (P.bbox) {
    const f = new ol.Feature(ol.geom.Polygon.fromExtent(P.bbox));
    f.set('type', 'area');
    areaSrc.addFeature(f);
  }
}
function refreshOverview() {
  ovSrc.clear();
  const fs = overviewFeatures(P);
  ovSrc.addFeatures(fs);
}
function updateLoc() {
  locSrc.clear();
  const m = P.meta;
  if (m.lat != null && m.lon != null && !isNaN(m.lat) && !isNaN(m.lon)) {
    const f = new ol.Feature(new ol.geom.Point(fromLL([m.lon, m.lat])));
    f.set('type', 'location');
    locSrc.addFeature(f);
  }
}
function fitProjectView() {
  setTimeout(() => {
    pmap.updateSize();
    const v = pmap.getView();
    if (P.bbox) v.fit(P.bbox, { padding: [40, 40, 40, 40], maxZoom: 22 });
    else if (P.meta.lat != null && P.meta.lon != null) { v.setCenter(fromLL([P.meta.lon, P.meta.lat])); v.setResolution(1.5); }
    else { v.setCenter(fromLL([15.45, 49.8])); v.setResolution(900); }
  }, 30);
}

function setPTool(tool, kind) {
  if (pDraw) { pmap.removeInteraction(pDraw); pDraw = null; }
  pTool = tool;
  $('#pHint').textContent = tool === 'location' ? t('proj.picking') : (tool === 'area' || tool === 'facility') ? t('proj.drawing') : '';
  $('#pmap').style.cursor = tool === 'select' ? '' : 'crosshair';
  if (tool === 'area' || tool === 'facility') {
    pDraw = new ol.interaction.Draw({ type: 'Circle', geometryFunction: ol.interaction.Draw.createBox(), freehand: true });
    pDraw.on('drawend', (e) => {
      const g = e.feature.getGeometry();
      if (tool === 'area') {
        P.bbox = g.getExtent().map((v) => +v.toFixed(2));
        refreshArea();
      } else {
        const fc = { id: uid(), kind: kind || 'parking', label: t('fac.' + (kind || 'parking')), coords: g.getCoordinates()[0].map((c) => [+c[0].toFixed(2), +c[1].toFixed(2)]) };
        P.facilities.push(fc);
        const f = facilityFeature(fc);
        facSrc.addFeature(f);
        pSel.clear(); pSel.push(f);
      }
      saveLocal();
      setTimeout(() => { setPTool('select'); renderProjectRight(); });
    });
    pmap.addInteraction(pDraw);
  }
  renderProjectRight(true);
}

let facKind = 'parking';
function renderProjectSide() {
  const m = P.meta;
  const box = $('#projSide');
  box.innerHTML = `
    <h2>${t('proj.basics')}</h2>
    <label class="fld"><span>${t('proj.name')}</span><input data-bind="name" value="${esc(m.name)}"></label>
    <label class="fld"><span>${t('proj.place')}</span><input data-bind="place" value="${esc(m.place)}"></label>
    <div class="fld"><span>${t('proj.search')}</span>
      <div class="row"><input id="geoQ" placeholder="${esc(t('proj.searchPh'))}"><button class="btn sm" id="geoGo" aria-label="search">⌕</button></div>
      <div class="georesults" id="geoRes"></div></div>
    <div class="row2">
      <label class="fld"><span>${t('proj.lat')}</span><input data-bind="lat" type="number" step="0.00001" value="${m.lat ?? ''}"></label>
      <label class="fld"><span>${t('proj.lon')}</span><input data-bind="lon" type="number" step="0.00001" value="${m.lon ?? ''}"></label>
    </div>
    <button class="btn sm ${pTool === 'location' ? 'on' : ''}" id="pickLoc">⌖ ${t('proj.pick')}</button>
    <h2>${t('proj.when')}</h2>
    <div class="row2">
      <label class="fld"><span>${t('proj.date')}</span><input type="date" data-bind="date" value="${esc(m.date)}"></label>
      <label class="fld"><span>${t('proj.time')}</span><input data-bind="time" value="${esc(m.time)}" placeholder="${esc(t('proj.timePh'))}"></label>
    </div>
    <label class="fld"><span>${t('proj.holes')}</span><input id="holeCount" type="number" min="1" max="36" value="${P.holes.length}"></label>
    <h2>${t('proj.notes')}</h2>
    <div class="rte-bar" id="rteBar">
      <button data-cmd="bold" title="Bold"><b>B</b></button>
      <button data-cmd="italic" title="Italic"><i>I</i></button>
      <button data-cmd="underline" title="Underline"><u>U</u></button>
      <button data-cmd="formatBlock" data-val="H3" title="Heading">H</button>
      <button data-cmd="formatBlock" data-val="P" title="Paragraph">¶</button>
      <button data-cmd="insertUnorderedList" title="List">• ≡</button>
      <button data-cmd="insertOrderedList" title="Numbered list">1.</button>
      <select data-cmd="fontSize" title="Size"><option value="">A</option><option value="2">S</option><option value="3">M</option><option value="4">L</option><option value="5">XL</option><option value="6">XXL</option></select>
      <input type="color" data-cmd="foreColor" value="#c62828" title="Colour">
      <button data-cmd="removeFormat" title="Clear">⨯</button>
    </div>
    <div class="rte" id="notesEd" contenteditable="true">${sanitizeHtml(m.notesHtml)}</div>
  `;
  box.oninput = (e) => {
    const k = e.target.dataset.bind;
    if (!k) return;
    let v = e.target.value;
    if (k === 'lat' || k === 'lon') { v = v === '' ? null : parseFloat(v); updateLocLater(); }
    P.meta[k] = v;
    if (k === 'name') renderTop();
    saveLocal();
  };
  $('#holeCount').onchange = (e) => setHoleCount(parseInt(e.target.value, 10));
  $('#pickLoc').onclick = () => setPTool(pTool === 'location' ? 'select' : 'location');
  const ed = $('#notesEd');
  ed.addEventListener('input', () => { P.meta.notesHtml = sanitizeHtml(ed.innerHTML); saveLocal(); });
  const bar = $('#rteBar');
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ed.focus();
    document.execCommand(b.dataset.cmd, false, b.dataset.val ? `<${b.dataset.val}>` : null);
    ed.dispatchEvent(new Event('input'));
  });
  bar.addEventListener('change', (e) => {
    const c = e.target.dataset.cmd;
    if (!c || !e.target.value) return;
    ed.focus();
    document.execCommand('styleWithCSS', false, c === 'foreColor');
    document.execCommand(c, false, e.target.value);
    if (e.target.tagName === 'SELECT') e.target.value = '';
    ed.dispatchEvent(new Event('input'));
  });
  const doSearch = async () => {
    const q = $('#geoQ').value.trim();
    if (!q) return;
    const res = $('#geoRes');
    res.innerHTML = '<div class="muted">…</div>';
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=${getLang() === 'cz' ? 'cs' : 'en'}&q=${encodeURIComponent(q)}`);
      const list = await r.json();
      if (!list.length) { res.innerHTML = `<div class="muted">${t('msg.searchNone')}</div>`; return; }
      res.innerHTML = list.map((x, i) => `<button data-i="${i}">${esc(x.display_name)}</button>`).join('');
      res.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const x = list[+b.dataset.i];
        P.meta.lat = +(+x.lat).toFixed(6); P.meta.lon = +(+x.lon).toFixed(6);
        if (!P.meta.place) P.meta.place = x.display_name.split(',').slice(0, 2).join(',').trim();
        updateLoc(); saveLocal();
        pmap.getView().animate({ center: fromLL([P.meta.lon, P.meta.lat]), resolution: 1.5, duration: 400 });
        renderProjectSide();
      };
    } catch (err) { res.innerHTML = `<div class="muted">${esc(err.message)}</div>`; }
  };
  $('#geoGo').onclick = doSearch;
  $('#geoQ').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
}
const updateLocLater = debounce(() => updateLoc(), 300);

function setHoleCount(n) {
  if (!n || n < 1) return;
  n = Math.min(36, n);
  const cnt = P.holes.length;
  if (n < cnt) {
    const lost = P.holes.slice(n).some((h) => h.features.length);
    if (lost && !confirm(t('msg.confirmHoles', { n, from: n + 1, to: cnt }))) { renderProjectSide(); return; }
    P.holes = P.holes.slice(0, n);
  } else for (let i = cnt; i < n; i++) P.holes.push(newHole(i + 1));
  if (cur > n) cur = n;
  hmapReady = false;
  refreshOverview();
  saveLocal();
}

function renderProjectRight(soft) {
  const box = $('#projRight');
  const sel = pSel.item(0);
  const area = P.bbox ? t('proj.areaSize', { w: Math.round(P.bbox[2] - P.bbox[0]), h: Math.round(P.bbox[3] - P.bbox[1]) }) : null;
  box.innerHTML = `
    <h2>${t('proj.area')}</h2>
    ${area ? `<div class="muted" style="margin-bottom:6px">▭ ${area}</div>` : `<div class="muted" style="margin-bottom:6px">${t('proj.areaNone')}</div>`}
    <div class="btns">
      <button class="btn sm ${pTool === 'area' ? 'on' : ''}" id="drawArea">▭ ${t('proj.drawArea')}</button>
      ${P.bbox ? `<button class="btn sm" id="zoomArea">${t('proj.zoomArea')}</button>` : ''}
    </div>
    <h2>${t('proj.facilities')}</h2>
    <div class="row" style="margin-bottom:8px">
      <select id="facKind">${Object.keys(FACILITY_KINDS).map((k) => `<option value="${k}" ${k === facKind ? 'selected' : ''}>${t('fac.' + k)}</option>`).join('')}</select>
      <button class="btn sm ${pTool === 'facility' ? 'on' : ''}" id="addFac">＋ ${t('proj.addFacility')}</button>
    </div>
    ${P.facilities.length ? '' : `<div class="muted">${t('proj.noFac')}</div>`}
    <div id="facList">${P.facilities.map((fc) => `
      <div class="fac-item ${sel && sel.getId() === fc.id ? 'sel' : ''}" data-id="${fc.id}">
        <div class="row" style="margin-bottom:6px"><span class="swatch" style="background:${FACILITY_KINDS[fc.kind]}"></span>
          <select data-f="kind">${Object.keys(FACILITY_KINDS).map((k) => `<option value="${k}" ${k === fc.kind ? 'selected' : ''}>${t('fac.' + k)}</option>`).join('')}</select>
          <button class="icon-btn" data-f="del" title="${t('props.delete')}">🗑</button></div>
        <input data-f="label" value="${esc(fc.label)}" placeholder="${t('proj.facLabel')}">
      </div>`).join('')}</div>`;
  $('#drawArea').onclick = () => setPTool(pTool === 'area' ? 'select' : 'area');
  if ($('#zoomArea')) $('#zoomArea').onclick = () => pmap.getView().fit(P.bbox, { padding: [40, 40, 40, 40], duration: 300 });
  $('#facKind').onchange = (e) => { facKind = e.target.value; };
  $('#addFac').onclick = () => setPTool(pTool === 'facility' ? 'select' : 'facility', facKind);
  const list = $('#facList');
  list.oninput = (e) => {
    const it = e.target.closest('.fac-item'); if (!it) return;
    const fc = P.facilities.find((x) => x.id === it.dataset.id);
    const f = facSrc.getFeatureById(fc.id);
    if (e.target.dataset.f === 'label') { fc.label = e.target.value; f.set('label', fc.label); }
    saveLocal();
  };
  list.onchange = (e) => {
    const it = e.target.closest('.fac-item'); if (!it) return;
    const fc = P.facilities.find((x) => x.id === it.dataset.id);
    if (e.target.dataset.f === 'kind') {
      const old = t('fac.' + fc.kind);
      fc.kind = e.target.value;
      if (!fc.label || fc.label === old) fc.label = t('fac.' + fc.kind);
      const f = facSrc.getFeatureById(fc.id);
      f.setProperties({ kind: fc.kind, color: FACILITY_KINDS[fc.kind], label: fc.label });
      saveLocal(); renderProjectRight();
    }
  };
  list.onclick = (e) => {
    const it = e.target.closest('.fac-item'); if (!it) return;
    const id = it.dataset.id;
    const f = facSrc.getFeatureById(id);
    if (e.target.closest('[data-f=del]')) {
      P.facilities = P.facilities.filter((x) => x.id !== id);
      pSel.clear(); facSrc.removeFeature(f); saveLocal(); renderProjectRight();
      return;
    }
    if (e.target.tagName === 'DIV' || e.target.classList.contains('swatch')) {
      pSel.clear(); pSel.push(f); facLayer.changed();
      pmap.getView().fit(f.getGeometry().getExtent(), { padding: [120, 120, 120, 120], maxZoom: 22, duration: 300 });
      renderProjectRight();
    }
  };
  void soft;
}

/* =========================================================
   HOLES TAB — editor
   ========================================================= */
let hmap, hSrc, othersSrc, hLayer, othersLayer, hDraw = null, hTool = 'select', hTranslate, hModify, hSnap;
let hmapReady = false, loadingHole = false, pxPerMm = 3, applyingView = false;
const hSel = new ol.Collection();
let undoStack = [], redoStack = [], lastSnap = '[]';

function initHoleMap() {
  hBase = new ol.layer.Group();
  hSrc = new ol.source.Vector();
  othersSrc = new ol.source.Vector();
  hLayer = new ol.layer.Vector({
    source: hSrc, renderBuffer: 600, updateWhileInteracting: true, updateWhileAnimating: true,
    style: (f, r) => featureStyle(f, r, { pxPerMm, selected: (x) => hSel.getArray().includes(x) }),
  });
  othersLayer = new ol.layer.Vector({ source: othersSrc, opacity: 0.45, style: (f, r) => featureStyle(f, r, { pxPerMm, overview: true }) });
  hmap = new ol.Map({ target: 'hmap', layers: [hBase, othersLayer, hLayer], controls: [], view: new ol.View({ projection: PROJ, center: PRAGUE, resolution: 1 }) });
  hTranslate = new ol.interaction.Translate({ features: hSel });
  hModify = new ol.interaction.Modify({ features: hSel, pixelTolerance: 9 });
  hSnap = new ol.interaction.Snap({ source: hSrc, pixelTolerance: 8 });
  hmap.addInteraction(hTranslate); hmap.addInteraction(hModify); hmap.addInteraction(hSnap);
  hmap.on('singleclick', (e) => {
    if (hTool !== 'select') return;
    const f = hmap.forEachFeatureAtPixel(e.pixel, (x) => x, { layerFilter: (l) => l === hLayer, hitTolerance: 6 });
    hSel.clear();
    if (f) hSel.push(f);
    hLayer.changed();
    renderProps();
  });
  hSrc.on(['addfeature', 'removefeature', 'changefeature'], () => { if (!loadingHole) scheduleCommit(); });
  hmap.on('moveend', () => {
    if (!P || !hmapReady) return;
    const v = hmap.getView(), pg = H().page;
    pg.center = v.getCenter().map((x) => +x.toFixed(2));
    pg.rotation = v.getRotation();
    saveLocal();
    renderOverlays();
    syncPageInputs();
  });
  fillGroup(hBase);
  new ResizeObserver(debounce(() => { if (view === 'holes') layoutFrame(); }, 60)).observe($('#frameWrap'));
}

function openHole(n) {
  if (!hmap) initHoleMap();
  if (hmapReady) scheduleCommit.flush();
  cur = Math.max(1, Math.min(P.holes.length, n));
  const h = H();
  loadingHole = true;
  hSel.clear();
  hSrc.clear();
  hSrc.addFeatures(h.features.map((d) => dataToFeature(d, h.n)));
  applyAutoRot(hSrc.getFeatures());
  othersSrc.clear();
  othersSrc.addFeatures(overviewFeatures(P, h.n));
  othersLayer.setVisible(!!h.page.showOthers);
  loadingHole = false;
  undoStack = []; redoStack = [];
  lastSnap = JSON.stringify(h.features);
  if (!h.page.center) h.page.center = defaultCenter(P, h);
  hmapReady = true;
  setTool(hTool === 'select' ? 'select' : hTool);
  layoutFrame();
  renderHoleSide(); renderEditorBar(); renderProps();
}

// Fit the paper sheet into the available space and derive the view resolution from the print scale
function layoutFrame() {
  if (!hmapReady) return;
  const pg = H().page;
  const [pw, ph] = pageSize(pg);
  const wrap = $('#frameWrap');
  const W = wrap.clientWidth - 40, Hh = wrap.clientHeight - 40;
  if (W <= 0 || Hh <= 0) return;
  pxPerMm = Math.max(0.5, Math.min(W / pw, Hh / ph));
  const page = $('#holePage'), area = $('#holeArea');
  page.style.setProperty('--mm', pxPerMm + 'px');
  page.style.width = pw * pxPerMm + 'px';
  page.style.height = ph * pxPerMm + 'px';
  area.style.left = area.style.top = MARGIN * pxPerMm + 'px';
  area.style.width = (pw - 2 * MARGIN) * pxPerMm + 'px';
  area.style.height = (ph - 2 * MARGIN) * pxPerMm + 'px';
  $('#holeFoot').innerHTML = `<span>${esc(footerText(P))}</span><span>${cur} / ${P.holes.length}</span>`;
  hmap.updateSize();
  makeHoleView();
  hLayer.changed(); othersLayer.changed();
  renderOverlays();
}

function makeHoleView() {
  const pg = H().page;
  const scales = [...new Set([...NICE_SCALES, Math.round(pg.scale)])].sort((a, b) => b - a);
  applyingView = true;
  const v = new ol.View({
    projection: PROJ,
    center: pg.center || defaultCenter(P, H()),
    rotation: pg.rotation || 0,
    resolutions: scales.map((s) => s / 1000 / pxPerMm),
    resolution: pg.scale / 1000 / pxPerMm,
    constrainResolution: true,
  });
  v.on('change:resolution', () => {
    if (applyingView) return;
    const s = Math.round(v.getResolution() * pxPerMm * 1000);
    if (s !== H().page.scale) { H().page.scale = s; saveLocal(); hLayer.changed(); renderOverlays(); syncPageInputs(); renderEditorBar(); }
  });
  hmap.setView(v);
  applyingView = false;
}

const scheduleCommit = debounce(commitHole, 120);
function commitHole() {
  if (!hmapReady) return;
  const h = H();
  applyAutoRot(hSrc.getFeatures());
  h.features = hSrc.getFeatures().map(featureToData);
  const snap = JSON.stringify(h.features);
  if (snap !== lastSnap) {
    undoStack.push(lastSnap);
    if (undoStack.length > 100) undoStack.shift();
    lastSnap = snap; redoStack = [];
  }
  hLayer.changed();
  saveLocal();
  renderOverlays();
  updateHoleGrid();
  renderEditorBar();
  updateMeasure();
  const L = holeLength(h);
  if ($('#hLen')) $('#hLen').textContent = L ? L + ' m' : '–';
}
function restoreSnap(s) {
  const h = H();
  h.features = JSON.parse(s);
  loadingHole = true;
  hSel.clear(); hSrc.clear();
  hSrc.addFeatures(h.features.map((d) => dataToFeature(d, h.n)));
  applyAutoRot(hSrc.getFeatures());
  loadingHole = false;
  saveLocal(); renderOverlays(); updateHoleGrid(); renderProps(); renderEditorBar();
}
function undo() { if (!undoStack.length) return; scheduleCommit.flush(); redoStack.push(lastSnap); lastSnap = undoStack.pop(); restoreSnap(lastSnap); }
function redo() { if (!redoStack.length) return; undoStack.push(lastSnap); lastSnap = redoStack.pop(); restoreSnap(lastSnap); }

function setTool(tool) {
  if (hDraw) { hmap.removeInteraction(hDraw); hDraw = null; }
  hTool = tool;
  if (tool !== 'select') {
    const def = TYPES[tool];
    hDraw = new ol.interaction.Draw({ source: hSrc, type: def.geom, stopClick: true });
    hDraw.on('drawend', (e) => {
      const f = e.feature;
      f.setId(uid());
      const props = { ...def }; delete props.geom;
      f.setProperties({ type: tool, ...props, holeN: cur }, true);
      setTimeout(() => { hSel.clear(); hSel.push(f); hLayer.changed(); renderProps(); }, 0);
    });
    hmap.addInteraction(hDraw);
    hmap.removeInteraction(hSnap); hmap.addInteraction(hSnap);
  }
  $('#hmap').style.cursor = tool === 'select' ? '' : 'crosshair';
  $$('#toolGrid button').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  renderEditorBar();
}

function renderOverlays() {
  if (!hmapReady) return;
  const pg = H().page;
  renderHoleOverlays($('#holeArea'), P, H(), {
    pxPerMm, editable: true, north: northAngle(hmap.getView().getCenter() || pg.center, hmap.getView().getRotation()),
    onBoxMove: (key, box) => { pg.boxes[key] = { ...box, show: pg.boxes[key].show }; saveLocal(); renderOverlays(); },
  });
}

function renderEditorBar() {
  if (!hmapReady) return;
  const h = H();
  const len = holeLength(h);
  $('#editorBar').innerHTML = `
    <button class="icon-btn" id="ebPrev" title="${t('hole.prev')}" ${cur <= 1 ? 'disabled' : ''}>◀</button>
    <span class="ttl">${t('hole.hole')} ${cur} / ${P.holes.length}</span>
    <button class="icon-btn" id="ebNext" title="${t('hole.next')}" ${cur >= P.holes.length ? 'disabled' : ''}>▶</button>
    <span class="muted">${t('hole.par')} ${h.par}${len ? ` · ${len} m` : ''} · 1:${h.page.scale}</span>
    <button class="icon-btn" id="ebUndo" title="${t('hole.undo')} (Ctrl+Z)" ${undoStack.length ? '' : 'disabled'}>↶</button>
    <button class="icon-btn" id="ebRedo" title="${t('hole.redo')} (Ctrl+Y)" ${redoStack.length ? '' : 'disabled'}>↷</button>
    <span class="hint">${hTool === 'select' ? t('hole.hintSelect') : t('hole.hintDraw')}</span>`;
  $('#ebPrev').onclick = () => openHole(cur - 1);
  $('#ebNext').onclick = () => openHole(cur + 1);
  $('#ebUndo').onclick = undo;
  $('#ebRedo').onclick = redo;
}

let iconsCache = null;
function toolIcons() {
  if (iconsCache) return iconsCache;
  iconsCache = {};
  for (const tp of TOOL_ORDER) { const p = { ...TYPES[tp] }; delete p.geom; iconsCache[tp] = legendIcon(tp, p, 4); }
  return iconsCache;
}

function updateHoleGrid() {
  $$('#holeGrid button').forEach((b) => {
    const h = P.holes[+b.dataset.n - 1];
    if (!h) return;
    b.classList.toggle('done', h.features.some((f) => f.type === 'tee') && h.features.some((f) => f.type === 'basket'));
    b.querySelector('small').textContent = 'P' + h.par;
  });
}

function renderHoleSide() {
  if (!hmapReady) return;
  const h = H(), pg = h.page;
  const ic = toolIcons();
  const open = (k) => (sideOpen[k] !== false ? 'open' : '');
  const scaleOpts = [...new Set([...NICE_SCALES, pg.scale])].sort((a, b) => a - b);
  $('#holeSide').innerHTML = `
    <h2>${t('hole.hole')}</h2>
    <div class="hole-grid" id="holeGrid">${P.holes.map((x) => `<button data-n="${x.n}" class="${x.n === cur ? 'cur' : ''}">${x.n}<small>P${x.par}</small></button>`).join('')}</div>
    <div class="row2" style="margin-top:10px">
      <label class="fld"><span>${t('hole.par')}</span><select id="hPar">${[2, 3, 4, 5, 6, 7].map((p) => `<option ${p === h.par ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <div class="fld"><span>${t('hole.length')}</span><div style="padding:8px 0;font-weight:600" id="hLen">${holeLength(h) ? holeLength(h) + ' m' : '–'}</div></div>
    </div>
    <label class="fld"><span>${t('hole.info')}</span><textarea id="hInfo" placeholder="${esc(t('hole.infoPh'))}">${esc(h.info)}</textarea></label>

    <details class="sec" data-sec="tools" ${open('tools')}><summary>${t('hole.tools')}</summary>
      <div class="tools" id="toolGrid">
        <button class="sel ${hTool === 'select' ? 'on' : ''}" data-tool="select">⬚ ${t('tool.select')}</button>
        ${TOOL_ORDER.map((tp) => `<button data-tool="${tp}" class="${hTool === tp ? 'on' : ''}" title="${esc(t('type.' + tp))}"><img src="${ic[tp]}" alt="">${t('type.' + tp)}</button>`).join('')}
      </div>
    </details>

    <details class="sec" data-sec="page" ${open('page')}><summary>${t('hole.page')}</summary>
      <div class="row2">
        <label class="fld"><span>${t('hole.paper')}</span><select id="pgPaper">${Object.keys(PAPER).map((k) => `<option ${k === pg.paper ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <div class="fld"><span>&nbsp;</span><div class="seg" id="pgOrient">
          <button data-o="portrait" class="${pg.orientation === 'portrait' ? 'on' : ''}" title="${t('hole.portrait')}">▯</button>
          <button data-o="landscape" class="${pg.orientation === 'landscape' ? 'on' : ''}" title="${t('hole.landscape')}">▭</button></div></div>
      </div>
      <label class="fld"><span>${t('hole.scale')}</span>
        <div class="row"><span>1 :</span><select id="pgScale">${scaleOpts.map((s) => `<option value="${s}" ${s === pg.scale ? 'selected' : ''}>${s}</option>`).join('')}<option value="custom">${t('hole.custom')}</option></select></div></label>
      <div class="fld"><span>${t('hole.rotation')}</span>
        <div class="range-row"><input type="range" id="pgRot" min="-180" max="180" step="1" value="${Math.round((pg.rotation || 0) * 180 / Math.PI)}"><input type="number" id="pgRotN" min="-180" max="180" value="${Math.round((pg.rotation || 0) * 180 / Math.PI)}"></div></div>
      <div class="btns"><button class="btn sm" id="pgFit">⤢ ${t('hole.fit')}</button><button class="btn sm" id="pgAlign">⬆ ${t('hole.align')}</button></div>
      <label class="check"><input type="checkbox" id="pgOthers" ${pg.showOthers ? 'checked' : ''}>${t('hole.showOthers')}</label>
      <div class="fld" style="margin-top:8px"><span>${t('hole.boxes')}</span>
        ${['notes', 'legend', 'scale'].map((k) => `<label class="check"><input type="checkbox" data-box="${k}" ${pg.boxes[k].show ? 'checked' : ''}>${t('hole.box.' + k)}</label>`).join('')}
      </div>
      <p class="muted">${t('hole.dragHint')}</p>
      <button class="btn sm" id="pgReset">${t('hole.resetBoxes')}</button>
    </details>

    <details class="sec" data-sec="layers" ${open('layers')}><summary>${t('hole.layers')}</summary>
      <div id="miniLayers">${miniLayersHtml()}</div>
    </details>`;

  $('#holeSide details') && $$('#holeSide details').forEach((d) => d.addEventListener('toggle', () => { sideOpen[d.dataset.sec] = d.open; }));
  $('#holeGrid').onclick = (e) => { const b = e.target.closest('button'); if (b) openHole(+b.dataset.n); };
  updateHoleGrid();
  $('#hPar').onchange = (e) => { h.par = +e.target.value; saveLocal(); renderOverlays(); updateHoleGrid(); renderEditorBar(); };
  $('#hInfo').oninput = (e) => { h.info = e.target.value; saveLocal(); renderOverlaysLater(); };
  $('#toolGrid').onclick = (e) => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); };
  $('#pgPaper').onchange = (e) => { pg.paper = e.target.value; saveLocal(); layoutFrame(); };
  $('#pgOrient').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; pg.orientation = b.dataset.o; saveLocal(); renderHoleSide(); layoutFrame(); };
  $('#pgScale').onchange = (e) => {
    let s = e.target.value;
    if (s === 'custom') { s = parseInt(prompt('1 : ?', pg.scale), 10); if (!s || s < 50) { syncPageInputs(); return; } }
    pg.scale = +s; saveLocal(); layoutFrame(); renderHoleSide(); renderEditorBar();
  };
  const rot = (deg) => { hmap.getView().setRotation((deg * Math.PI) / 180); };
  $('#pgRot').oninput = (e) => { $('#pgRotN').value = e.target.value; rot(+e.target.value); };
  $('#pgRotN').onchange = (e) => { $('#pgRot').value = e.target.value; rot(+e.target.value); };
  $('#pgFit').onclick = fitHole;
  $('#pgAlign').onclick = alignHole;
  $('#pgOthers').onchange = (e) => { pg.showOthers = e.target.checked; othersLayer.setVisible(pg.showOthers); saveLocal(); };
  $$('#holeSide [data-box]').forEach((c) => { c.onchange = () => { pg.boxes[c.dataset.box].show = c.checked; saveLocal(); renderOverlays(); }; });
  $('#pgReset').onclick = () => { pg.boxes = defaultBoxes(); saveLocal(); renderHoleSide(); renderOverlays(); };
  bindMiniLayers($('#miniLayers'));
}
const sideOpen = {};
const renderOverlaysLater = debounce(() => renderOverlays(), 250);

function syncPageInputs() {
  const pg = H().page;
  const sc = $('#pgScale');
  if (sc) {
    if (![...sc.options].some((o) => o.value === String(pg.scale))) { renderHoleSide(); return; }
    sc.value = String(pg.scale);
  }
  const deg = Math.round(((pg.rotation || 0) * 180) / Math.PI);
  if ($('#pgRot')) { $('#pgRot').value = deg; $('#pgRotN').value = deg; }
}

function fitHole() {
  const fs = hSrc.getFeatures();
  if (!fs.length) return;
  const coords = [];
  for (const f of fs) {
    const g = f.getGeometry();
    if (g.getType() === 'Point') {
      const c = g.getCoordinates();
      coords.push(c);
      if (f.get('type') === 'basket') coords.push([c[0] - 21, c[1] - 21], [c[0] + 21, c[1] + 21]);
    } else if (g.getType() === 'LineString') coords.push(...g.getCoordinates());
    else coords.push(...g.getCoordinates()[0]);
  }
  const v = hmap.getView();
  const s = hmap.getSize();
  v.fit(new ol.geom.MultiPoint(coords), { size: s, padding: [s[1] * 0.16, s[0] * 0.08, s[1] * 0.16, s[0] * 0.08], nearest: false });
}
function alignHole() {
  const t1 = hSrc.getFeatures().find((f) => f.get('type') === 'tee');
  const b1 = hSrc.getFeatures().find((f) => f.get('type') === 'basket');
  if (!t1 || !b1) return;
  const az = bearing(t1.getGeometry().getCoordinates(), b1.getGeometry().getCoordinates());
  let r = -az;
  if (r < -180) r += 360;
  hmap.getView().setRotation((r * Math.PI) / 180);
  setTimeout(fitHole, 0);
}

/* ---------- properties panel ---------- */
function renderProps() {
  const box = $('#propPanel');
  const f = hSel.item(0);
  if (!f) {
    box.innerHTML = `<h2>${t('props.title')}</h2><p class="muted">${t('props.none')}</p>
      <h2>${t('props.shortcuts')}</h2><div class="kbd">${t('props.keys')}</div>`;
    return;
  }
  const tp = f.get('type'), def = TYPES[tp] || {};
  const has = (k) => k in def;
  const v = (k) => f.get(k) ?? def[k];
  const sizeLabel = tp === 'text' ? t('props.textSize') : t('props.size');
  const rot = tp === 'tee' ? (f.get('rotation') ?? Math.round(f.get('autoRot') || 0)) : (f.get('rotation') ?? 0);
  box.innerHTML = `
    <h2>${t('props.title')}</h2>
    <div class="prop-head"><img src="${toolIcons()[tp]}" alt=""><b>${t('type.' + tp)}</b></div>
    <div class="measure" id="pMeasure"></div>
    ${has('label') ? `<label class="fld"><span>${t('props.label')}</span><input data-p="label" value="${esc(v('label'))}"></label>` : ''}
    ${has('color') ? `<label class="fld"><span>${t('props.color')}</span><input type="color" data-p="color" value="${v('color')}" style="height:36px;padding:2px"></label>` : ''}
    ${has('size') ? `<label class="fld"><span>${sizeLabel}</span><div class="range-row"><input type="range" data-p="size" min="${tp === 'text' ? 1.5 : 0.3}" max="${tp === 'text' ? 12 : 30}" step="${tp === 'text' ? 0.5 : 0.1}" value="${v('size')}"><input type="number" data-p="size" step="0.1" value="${v('size')}"></div></label>` : ''}
    ${has('width') ? `<label class="fld"><span>${t('props.width')}</span><div class="range-row"><input type="range" data-p="width" min="0.1" max="3" step="0.05" value="${v('width')}"><input type="number" data-p="width" step="0.05" value="${v('width')}"></div></label>` : ''}
    ${has('rotation') ? `
      ${tp === 'tee' ? `<label class="check"><input type="checkbox" id="pAuto" ${f.get('rotation') == null ? 'checked' : ''}>${t('props.auto')}</label>` : ''}
      <label class="fld"><span>${t('props.rotation')}</span><div class="range-row"><input type="range" data-p="rotation" min="0" max="359" step="1" value="${Math.round(rot)}" ${tp === 'tee' && f.get('rotation') == null ? 'disabled' : ''}><input type="number" data-p="rotation" min="0" max="359" value="${Math.round(rot)}" ${tp === 'tee' && f.get('rotation') == null ? 'disabled' : ''}></div></label>` : ''}
    ${has('c1') ? `<label class="check"><input type="checkbox" data-p="c1" ${v('c1') !== false ? 'checked' : ''}>${t('props.c1')}</label>
      <label class="check"><input type="checkbox" data-p="c2" ${v('c2') !== false ? 'checked' : ''}>${t('props.c2')}</label>` : ''}
    <div class="btns" style="margin-top:14px"><button class="btn sm danger" id="pDel">🗑 ${t('props.delete')}</button></div>
    <h2>${t('props.shortcuts')}</h2><div class="kbd">${t('props.keys')}</div>`;
  updateMeasure();
  box.oninput = (e) => {
    const k = e.target.dataset.p;
    if (!k) return;
    let val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (['size', 'width', 'rotation'].includes(k)) { val = parseFloat(val); if (isNaN(val)) return; }
    $$(`#propPanel [data-p=${k}]`).forEach((x) => { if (x !== e.target && x.type !== 'checkbox') x.value = val; });
    f.set(k, val);
  };
  if ($('#pAuto')) $('#pAuto').onchange = (e) => {
    f.set('rotation', e.target.checked ? null : Math.round(f.get('autoRot') || 0));
    renderProps();
  };
  $('#pDel').onclick = deleteSelected;
}
function updateMeasure() {
  const m = $('#pMeasure'), f = hSel.item(0);
  if (!m || !f) return;
  const g = f.getGeometry();
  if (g.getType() === 'LineString') m.textContent = t('props.length', { v: Math.round(g.getLength()) });
  else if (g.getType() === 'Polygon') m.textContent = t('props.area', { v: Math.round(g.getArea()) });
  else m.textContent = '';
}
function deleteSelected() {
  const f = hSel.item(0);
  if (!f) return;
  hSel.clear();
  hSrc.removeFeature(f);
  renderProps();
}

/* =========================================================
   LAYERS
   ========================================================= */
function miniLayersHtml() {
  return [...P.wms].reverse().map((c) => `
    <div class="lyr-mini" data-id="${c.id}">
      <input type="checkbox" data-l="visible" ${c.visible ? 'checked' : ''}>
      <span title="${esc(c.name)}">${esc(c.name)} ${c._noCors ? `<b class="warn-dot" title="${esc(t('layers.noCors'))}">!</b>` : ''}</span>
      <input type="range" data-l="opacity" min="0" max="1" step="0.05" value="${c.opacity ?? 1}" title="${t('layers.opacity')}">
    </div>`).join('');
}
function bindMiniLayers(box) {
  box.oninput = (e) => {
    const row = e.target.closest('[data-id]'); if (!row) return;
    const c = P.wms.find((x) => x.id === row.dataset.id);
    if (e.target.dataset.l === 'visible') c.visible = e.target.checked;
    if (e.target.dataset.l === 'opacity') c.opacity = +e.target.value;
    updateBaseProps(); saveLocal();
  };
}

const editing = new Set();
const capsLists = {};
function renderLayers() {
  if (!P) return;
  const box = $('#layersPanel');
  const list = [...P.wms].reverse();
  box.innerHTML = `
    <h1>${t('layers.title')}</h1>
    <p class="muted">${t('layers.lead')}</p>
    <div class="card" id="lyrList">${list.map((c) => {
      const idx = P.wms.indexOf(c);
      return `<div class="lyr" data-id="${c.id}">
        <div class="lyr-top">
          <input type="checkbox" data-l="visible" ${c.visible ? 'checked' : ''} >
          <div class="nm">${esc(c.name)} ${c._noCors ? `<b class="warn-dot" title="${esc(t('layers.noCors'))}">!</b>` : ''}<small>${esc(c.type === 'xyz' ? 'XYZ' : 'WMS')} · ${esc(c.url)}</small></div>
          <input type="range" data-l="opacity" min="0" max="1" step="0.05" value="${c.opacity ?? 1}" title="${t('layers.opacity')}">
          <button class="icon-btn" data-a="up" ${idx === P.wms.length - 1 ? 'disabled' : ''} title="↑">↑</button>
          <button class="icon-btn" data-a="down" ${idx === 0 ? 'disabled' : ''} title="↓">↓</button>
          <button class="icon-btn" data-a="edit" title="${t('layers.edit')}">✎</button>
          <button class="icon-btn" data-a="del" title="${t('layers.remove')}">🗑</button>
        </div>
        ${c._noCors ? `<div class="note" style="margin:0 11px 10px">${t('layers.noCors')}</div>` : ''}
        ${editing.has(c.id) ? `<div class="lyr-edit">
          <div class="grid">
            <label class="fld"><span>${t('layers.name')}</span><input data-e="name" value="${esc(c.name)}"></label>
            <label class="fld"><span>${t('layers.type')}</span><select data-e="type"><option value="wms" ${c.type !== 'xyz' ? 'selected' : ''}>WMS</option><option value="xyz" ${c.type === 'xyz' ? 'selected' : ''}>XYZ tiles</option></select></label>
            <label class="fld full"><span>${t('layers.url')}</span><input data-e="url" value="${esc(c.url)}"></label>
            ${c.type !== 'xyz' ? `
            <label class="fld"><span>${t('layers.layers')}</span><input data-e="layers" value="${esc(c.layers === '*' ? '' : c.layers)}" placeholder="${esc(t('layers.auto'))}"></label>
            <label class="fld"><span>${t('layers.format')}</span><select data-e="format">${['image/png', 'image/jpeg'].map((f) => `<option ${f === c.format ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
            <div class="full"><button class="btn sm" data-a="caps">${t('layers.load')}</button>
              ${capsLists[c.id] ? `<div class="caps-list"><div class="muted">${t('layers.pickLayers')}</div>${capsLists[c.id].map((l) => `<label style="padding-left:${l.depth * 12}px"><input type="checkbox" data-cap="${esc(l.name)}" ${(c.layers || '').split(',').includes(l.name) ? 'checked' : ''}>${esc(l.title)} <span class="muted">(${esc(l.name)})</span></label>`).join('')}</div>` : ''}</div>` : ''}
          </div></div>` : ''}
      </div>`;
    }).join('')}</div>
    <div class="btns"><button class="btn" id="lyrAdd">＋ ${t('layers.add')}</button><button class="btn" id="lyrReset">${t('layers.reset')}</button></div>`;

  const lst = $('#lyrList');
  const cfgOf = (e) => P.wms.find((x) => x.id === e.target.closest('[data-id]')?.dataset.id);
  lst.oninput = (e) => {
    const c = cfgOf(e); if (!c) return;
    if (e.target.dataset.l === 'visible') { c.visible = e.target.checked; updateBaseProps(); }
    if (e.target.dataset.l === 'opacity') { c.opacity = +e.target.value; updateBaseProps(); }
    saveLocal();
  };
  lst.onchange = (e) => {
    const c = cfgOf(e); if (!c) return;
    const k = e.target.dataset.e;
    if (k) {
      c[k] = e.target.value.trim();
      if (k === 'layers' && !c.layers) c.layers = '*';
      delete c._noCors; delete c._triedNoCors;
      saveLocal(); syncBase();
      if (k === 'type' || k === 'name') renderLayers();
    }
    if (e.target.dataset.cap != null) {
      c.layers = $$(`.lyr[data-id="${c.id}"] [data-cap]`).filter((x) => x.checked).map((x) => x.dataset.cap).join(',') || '*';
      delete c._noCors; delete c._triedNoCors;
      saveLocal(); syncBase(); renderLayers();
    }
  };
  lst.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const c = cfgOf(e); const i = P.wms.indexOf(c);
    const a = b.dataset.a;
    if (a === 'up' && i < P.wms.length - 1) [P.wms[i], P.wms[i + 1]] = [P.wms[i + 1], P.wms[i]];
    else if (a === 'down' && i > 0) [P.wms[i], P.wms[i - 1]] = [P.wms[i - 1], P.wms[i]];
    else if (a === 'del') P.wms.splice(i, 1);
    else if (a === 'edit') { editing.has(c.id) ? editing.delete(c.id) : editing.add(c.id); renderLayers(); return; }
    else if (a === 'caps') {
      b.textContent = t('layers.loading');
      try { capsLists[c.id] = await fetchLayerList(c.url); }
      catch (err) { toast(t('layers.capsFail', { e: err.message }), 'warn'); }
      renderLayers(); return;
    }
    saveLocal(); syncBase(); renderLayers(); if (hmapReady) renderHoleSide();
  };
  $('#lyrAdd').onclick = () => {
    const c = { id: uid(), name: 'WMS', type: 'wms', url: 'https://', layers: '*', format: 'image/png', visible: true, opacity: 1 };
    P.wms.push(c); editing.add(c.id); saveLocal(); renderLayers();
  };
  $('#lyrReset').onclick = () => {
    const custom = P.wms.filter((c) => !c.builtin);
    P.wms = [...JSON.parse(JSON.stringify(DEFAULT_WMS)), ...custom];
    saveLocal(); syncBase(); renderLayers(); if (hmapReady) renderHoleSide();
  };
}

/* =========================================================
   EXPORT
   ========================================================= */
const exportOpts = { dpi: 200, title: true, range: 'all' };
function renderExport() {
  if (!P) return;
  const tp = P.titlePage;
  $('#exportPanel').innerHTML = `
    <h1>${t('tab.export')}</h1>
    <div class="card">
      <h2>${t('export.pdf')}</h2>
      <p class="muted">${t('export.pdfLead')}</p>
      ${!P.bbox ? `<div class="note">${t('msg.noArea')}</div>` : ''}
      <div class="export-grid">
        <label class="fld"><span>${t('export.dpi')}</span><select id="exDpi">${[150, 200, 300].map((d) => `<option value="${d}" ${d === exportOpts.dpi ? 'selected' : ''}>${d} dpi</option>`).join('')}</select></label>
        <label class="fld"><span>${t('export.range')}</span><select id="exRange"><option value="all">${t('export.all')}</option><option value="current" ${exportOpts.range === 'current' ? 'selected' : ''}>${t('export.current')} (${cur})</option></select></label>
        <label class="fld"><span>${t('export.titlePaper')}</span><div class="row">
          <select id="exTpPaper">${Object.keys(PAPER).map((k) => `<option ${k === tp.paper ? 'selected' : ''}>${k}</option>`).join('')}</select>
          <select id="exTpOr"><option value="portrait" ${tp.orientation === 'portrait' ? 'selected' : ''}>${t('hole.portrait')}</option><option value="landscape" ${tp.orientation === 'landscape' ? 'selected' : ''}>${t('hole.landscape')}</option></select></div></label>
      </div>
      <label class="check"><input type="checkbox" id="exTitle" ${exportOpts.title ? 'checked' : ''}>${t('export.titleOpt')}</label>
      <div class="export-out">
        <div><button class="btn primary big" id="exPrint">🖶 ${t('export.print')}</button><p class="muted">${t('export.printLead')}</p></div>
        <div><button class="btn big" id="exPdf">⬇ ${t('export.download')}</button><p class="muted">${t('export.downloadLead')}</p></div>
      </div>
    </div>
    <div class="card">
      <h2>${t('export.gpkg')}</h2>
      <p class="muted">${t('export.gpkgLead')}</p>
      <button class="btn primary" id="exGpkg">⬇ ${t('export.gpkgGo')}</button>
    </div>
    <div class="card">
      <h2>${t('export.json')}</h2>
      <p class="muted">${t('export.jsonLead')}</p>
      <div class="btns"><button class="btn" id="exJson">⬇ ${t('btn.save')}</button><button class="btn" id="exOpen">${t('btn.open')}</button></div>
    </div>`;
  $('#exDpi').onchange = (e) => { exportOpts.dpi = +e.target.value; };
  $('#exRange').onchange = (e) => { exportOpts.range = e.target.value; };
  $('#exTitle').onchange = (e) => { exportOpts.title = e.target.checked; };
  $('#exTpPaper').onchange = (e) => { tp.paper = e.target.value; saveLocal(); };
  $('#exTpOr').onchange = (e) => { tp.orientation = e.target.value; saveLocal(); };
  $('#exJson').onclick = saveJson;
  $('#exOpen').onclick = openFile;
  $('#exPdf').onclick = doPdf;
  $('#exPrint').onclick = doPrint;
  $('#exGpkg').onclick = doGpkg;
}

async function doPdf() {
  if (hmapReady) scheduleCommit.flush();
  try {
    const holes = exportOpts.range === 'current' ? [H()] : null;
    const { blob, skipped } = await exportPdf(P, { dpi: exportOpts.dpi, title: exportOpts.title, holes });
    download(blob, `${slug(P.meta.name)}.pdf`);
    if (skipped.length) {
      if (confirm(t('msg.tryPrint', { list: skipped.join(', ') }))) { doPrint(); return; }
      toast(t('msg.corsSkipped', { list: skipped.join(', ') }), 'warn');
    } else toast(t('msg.pdfDone'));
    renderLayers();
  } catch (err) {
    console.error(err);
    busy(null);
    toast(t('msg.fail', { e: err.message || err }), 'warn');
  }
}
async function doPrint() {
  if (hmapReady) scheduleCommit.flush();
  try {
    const holes = exportOpts.range === 'current' ? [H()] : null;
    const { skipped } = await printProject(P, { dpi: exportOpts.dpi, title: exportOpts.title, holes });
    if (skipped.length) toast(t('msg.printSkipped', { list: skipped.join(', ') }), 'warn');
  } catch (err) {
    console.error(err);
    busy(null);
    toast(t('msg.fail', { e: err.message || err }), 'warn');
  }
}
async function doGpkg() {
  if (hmapReady) scheduleCommit.flush();
  try {
    busy(t('busy.gpkg'));
    const bytes = await buildGpkg(P);
    download(new Blob([bytes], { type: 'application/geopackage+sqlite3' }), `${slug(P.meta.name)}.gpkg`);
    toast(t('msg.gpkgDone'));
  } catch (err) {
    console.error(err);
    toast(t('msg.fail', { e: err.message || err }), 'warn');
  } finally { busy(null); }
}

/* =========================================================
   Keyboard
   ========================================================= */
document.addEventListener('keydown', (e) => {
  if (view !== 'holes' || !hmapReady) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && !typing) {
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
  }
  if (typing) return;
  if (e.key === 'Escape') {
    if (hDraw) hDraw.abortDrawing();
    setTool('select');
  } else if (e.key === 'Enter' && hDraw) hDraw.finishDrawing();
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
});

/* =========================================================
   Boot
   ========================================================= */
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  if (view === 'holes' && hmapReady) scheduleCommit.flush();
  if (b.dataset.tab === 'project' && P) { refreshOverview(); }
  show(b.dataset.tab);
}));
$('#btnNew').onclick = newProj;
$('#btnOpen').onclick = openFile;
$('#btnSave').onclick = saveJson;
$('#startNew').onclick = newProj;
$('#startOpen').onclick = openFile;
window.addEventListener('beforeunload', () => { saveLocal.flush(); });

initLang();
initProjectMap();
refreshAll();
show('start');

// expose for debugging / tests
window.DGL = { get project() { return P; }, openHole, setTool, show, loadProject, exportPdf, printProject, buildGpkg };
