// Map symbology. Sizes are in millimetres on paper so the screen preview and the
// printed page match: o.pxPerMm says how many pixels one paper-millimetre is.
import { TYPES, FACILITY_KINDS } from './state.js';

const S = ol.style;
const G = ol.geom;
const FONT = 'Arial, Helvetica, sans-serif';
const SEL = '#00b8d4';

export function hexA(hex, a) {
  let h = String(hex || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function shade(hex, k) {
  let h = String(hex || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16) || 0;
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
const rad = (d) => (d * Math.PI) / 180;

// Unit vectors for a grid azimuth (clockwise from north)
function axes(az) { return [[Math.sin(az), Math.cos(az)], [Math.cos(az), -Math.sin(az)]]; }
const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];

function orientedRect(p, az, len, wid) {
  const [u, v] = axes(az);
  const a = add(add(p, u, len / 2), v, wid / 2), b = add(add(p, u, len / 2), v, -wid / 2);
  const c = add(add(p, u, -len / 2), v, -wid / 2), d = add(add(p, u, -len / 2), v, wid / 2);
  return new G.Polygon([[a, b, c, d, a]]);
}
function arrow(p, az, L, sw, hw, hl) {
  const [u, v] = axes(az);
  const tail = add(p, u, -L / 2), tip = add(p, u, L / 2), neck = add(tip, u, -hl);
  const pts = [add(tail, v, sw), add(neck, v, sw), add(neck, v, hw), tip, add(neck, v, -hw), add(neck, v, -sw), add(tail, v, -sw)];
  pts.push(pts[0]);
  return new G.Polygon([pts]);
}
function halo(px, w = 0.7) { return new S.Stroke({ color: 'rgba(255,255,255,0.95)', width: px(w) }); }

export function bearing(a, b) { // grid azimuth a→b in degrees
  const d = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  return (d + 360) % 360;
}

/**
 * o = { pxPerMm, legend?, overview?, selected?(f) }
 */
export function featureStyle(f, res, o) {
  const type = f.get('type');
  const def = TYPES[type] || {};
  const c = f.get('color') || def.color || '#000000';
  const pm = o.pxPerMm;
  const px = (mm) => mm * pm;           // paper mm → pixels
  const mu = (mm) => mm * pm * res;     // paper mm → map units (metres)
  const g = f.getGeometry();
  const st = [];
  const val = (k) => (f.get(k) ?? def[k]);
  const realR = (sizeM, minMm) => (o.legend ? mu(minMm * 1.4) : Math.max((sizeM || 1) / 2, mu(minMm)));

  switch (type) {
    case 'tee': {
      const p = g.getCoordinates();
      const az = rad(f.get('rotation') ?? f.get('autoRot') ?? 0);
      if (o.overview) { // numbered disc, readable at overview scales
        st.push(new S.Style({
          image: new S.Circle({ radius: px(2.3), fill: new S.Fill({ color: c }), stroke: new S.Stroke({ color: '#ffffff', width: px(0.35) }) }),
          text: new S.Text({ text: String(f.get('holeN') ?? ''), font: `bold ${px(2.5)}px ${FONT}`, fill: new S.Fill({ color: '#ffffff' }), overflow: true }),
        }));
        break;
      }
      st.push(new S.Style({ geometry: orientedRect(p, az, mu(5.4), mu(2.8)), fill: new S.Fill({ color: c }), stroke: new S.Stroke({ color: '#ffffff', width: px(0.35) }) }));
      const n = o.legend ? '' : String(f.get('holeN') ?? '');
      if (n) st.push(new S.Style({ geometry: new G.Point(p), text: new S.Text({ text: n, font: `bold ${px(2.3)}px ${FONT}`, fill: new S.Fill({ color: '#ffffff' }), overflow: true }) }));
      const lbl = !o.legend && !o.overview && f.get('label');
      if (lbl) st.push(new S.Style({ geometry: new G.Point(p), text: new S.Text({ text: lbl, font: `bold ${px(2)}px ${FONT}`, fill: new S.Fill({ color: c }), stroke: halo(px), offsetY: px(4.2), overflow: true }) }));
      break;
    }
    case 'basket': {
      const p = g.getCoordinates();
      if (!o.overview && !o.legend) {
        if (val('c2') !== false) st.push(new S.Style({ geometry: new G.Circle(p, 20), fill: new S.Fill({ color: hexA(c, 0.04) }), stroke: new S.Stroke({ color: hexA(c, 0.85), width: px(0.25), lineDash: [px(0.7), px(0.9)] }) }));
        if (val('c1') !== false) st.push(new S.Style({ geometry: new G.Circle(p, 10), fill: new S.Fill({ color: hexA(c, 0.08) }), stroke: new S.Stroke({ color: c, width: px(0.35), lineDash: [px(1.6), px(0.8)] }) }));
      }
      st.push(new S.Style({ image: new S.Circle({ radius: px(1.8), fill: new S.Fill({ color: '#ffffff' }), stroke: new S.Stroke({ color: c, width: px(0.6) }) }) }));
      st.push(new S.Style({ image: new S.Circle({ radius: px(0.75), fill: new S.Fill({ color: c }) }) }));
      break;
    }
    case 'fairway': {
      const w = val('width') || 0.6;
      if (o.overview) {
        st.push(new S.Style({ stroke: new S.Stroke({ color: 'rgba(0,0,0,0.45)', width: px(0.9) }) }));
        st.push(new S.Style({ stroke: new S.Stroke({ color: '#ffffff', width: px(0.45) }) }));
      } else {
        st.push(new S.Style({ stroke: new S.Stroke({ color: 'rgba(0,0,0,0.45)', width: px(w + 0.35), lineCap: 'butt' }) }));
        st.push(new S.Style({ stroke: new S.Stroke({ color: c, width: px(w), lineDash: [px(2.2), px(1.3)], lineCap: 'butt' }) }));
      }
      break;
    }
    case 'ob':
    case 'hazard':
    case 'water': {
      const fillA = type === 'ob' ? 0.16 : type === 'hazard' ? 0.22 : 0.45;
      st.push(new S.Style({
        fill: new S.Fill({ color: hexA(c, fillA) }),
        stroke: new S.Stroke({ color: c, width: px(type === 'water' ? 0.3 : 0.6), lineDash: type === 'hazard' ? [px(1.5), px(0.8)] : undefined }),
      }));
      if (!o.legend && type !== 'water') {
        st.push(new S.Style({ text: new S.Text({ text: type === 'ob' ? 'OB' : 'H', font: `bold ${px(2)}px ${FONT}`, fill: new S.Fill({ color: shade(c, 0.85) }), stroke: halo(px, 0.6), overflow: true }) }));
      }
      break;
    }
    case 'mando': {
      const p = g.getCoordinates();
      const az = rad(f.get('rotation') ?? 0);
      st.push(new S.Style({ geometry: arrow(p, az, mu(7), mu(0.55), mu(1.7), mu(2.6)), fill: new S.Fill({ color: c }), stroke: new S.Stroke({ color: '#ffffff', width: px(0.3) }) }));
      break;
    }
    case 'mandoObj': {
      const p = g.getCoordinates();
      st.push(new S.Style({ geometry: new G.Circle(p, realR(val('size'), 1.1)), fill: new S.Fill({ color: hexA(c, 0.85) }), stroke: new S.Stroke({ color: '#ffffff', width: px(0.35) }) }));
      const lbl = !o.legend && f.get('label');
      if (lbl) st.push(new S.Style({ geometry: new G.Point(p), text: new S.Text({ text: lbl, font: `bold ${px(2.2)}px ${FONT}`, fill: new S.Fill({ color: c }), stroke: halo(px), textAlign: 'left', offsetX: px(2.2), overflow: true }) }));
      break;
    }
    case 'dropzone': {
      st.push(new S.Style({
        image: new S.RegularShape({ points: 4, radius: px(2.6), angle: Math.PI / 4, fill: new S.Fill({ color: c }), stroke: new S.Stroke({ color: '#000000', width: px(0.25) }) }),
        text: o.legend ? undefined : new S.Text({ text: 'DZ', font: `bold ${px(1.7)}px ${FONT}`, fill: new S.Fill({ color: '#000000' }), overflow: true }),
      }));
      break;
    }
    case 'tree': {
      const p = g.getCoordinates();
      st.push(new S.Style({ geometry: new G.Circle(p, realR(val('size'), 0.8)), fill: new S.Fill({ color: hexA(c, 0.55) }), stroke: new S.Stroke({ color: shade(c, 0.6), width: px(0.25) }) }));
      st.push(new S.Style({ geometry: new G.Point(p), image: new S.Circle({ radius: px(0.3), fill: new S.Fill({ color: shade(c, 0.45) }) }) }));
      break;
    }
    case 'object': {
      const p = g.getCoordinates();
      st.push(new S.Style({ geometry: new G.Circle(p, realR(val('size'), 0.6)), fill: new S.Fill({ color: c }), stroke: new S.Stroke({ color: 'rgba(0,0,0,0.7)', width: px(0.2) }) }));
      const lbl = !o.legend && f.get('label');
      if (lbl) st.push(new S.Style({ geometry: new G.Point(p), text: new S.Text({ text: lbl, font: `${px(2)}px ${FONT}`, fill: new S.Fill({ color: '#111' }), stroke: halo(px), textAlign: 'left', offsetX: px(2), overflow: true }) }));
      break;
    }
    case 'line': {
      st.push(new S.Style({ stroke: new S.Stroke({ color: c, width: px(val('width') || 0.5), lineCap: 'round', lineJoin: 'round' }) }));
      break;
    }
    case 'text': {
      const size = val('size') || 3.5;
      st.push(new S.Style({ text: new S.Text({ text: o.legend ? 'Aa' : (f.get('label') || ''), font: `bold ${px(size)}px ${FONT}`, fill: new S.Fill({ color: c }), stroke: halo(px, 0.6), overflow: true }) }));
      break;
    }
    case 'facility': {
      const fc = f.get('color') || FACILITY_KINDS[f.get('kind')] || '#546e7a';
      st.push(new S.Style({
        fill: new S.Fill({ color: hexA(fc, 0.32) }),
        stroke: new S.Stroke({ color: fc, width: px(0.5) }),
        text: o.legend ? undefined : new S.Text({ text: f.get('label') || '', font: `bold ${px(2.4)}px ${FONT}`, fill: new S.Fill({ color: shade(fc, 0.7) }), stroke: halo(px), overflow: true }),
      }));
      break;
    }
    case 'area': {
      st.push(new S.Style({ stroke: new S.Stroke({ color: '#e46c2b', width: 2.5, lineDash: [10, 6] }), fill: new S.Fill({ color: 'rgba(228,108,43,0.04)' }) }));
      break;
    }
    case 'location': {
      st.push(new S.Style({ image: new S.Circle({ radius: 7, fill: new S.Fill({ color: '#e46c2b' }), stroke: new S.Stroke({ color: '#fff', width: 2.5 }) }) }));
      break;
    }
    default:
      st.push(new S.Style({ stroke: new S.Stroke({ color: c, width: 2 }), image: new S.Circle({ radius: 4, fill: new S.Fill({ color: c }) }) }));
  }

  if (o.selected && o.selected(f)) {
    const gt = g.getType();
    if (gt === 'Point') {
      st.push(new S.Style({ image: new S.Circle({ radius: Math.max(px(3.5), 9), stroke: new S.Stroke({ color: SEL, width: 2.5 }), fill: new S.Fill({ color: 'rgba(0,184,212,0.12)' }) }) }));
    } else {
      st.push(new S.Style({ stroke: new S.Stroke({ color: SEL, width: 2, lineDash: [6, 4] }) }));
      st.push(new S.Style({
        image: new S.Circle({ radius: 4, fill: new S.Fill({ color: '#fff' }), stroke: new S.Stroke({ color: SEL, width: 2 }) }),
        geometry: (ft) => {
          const gg = ft.getGeometry();
          const cs = gg.getType() === 'Polygon' ? gg.getCoordinates()[0] : gg.getCoordinates();
          return new G.MultiPoint(cs);
        },
      }));
    }
  }
  return st;
}

// Small symbol image for legends and the tool palette
export function legendIcon(type, props = {}, pm = 7, wmm = 9, hmm = 5) {
  const w = Math.round(wmm * pm), h = Math.round(hmm * pm);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const vc = ol.render.toContext(ctx, { size: [w, h], pixelRatio: 1 });
  const gt = type === 'facility' ? 'Polygon' : (TYPES[type] || {}).geom || 'Polygon';
  let geom;
  const ins = pm * 0.9;
  if (gt === 'Point') geom = new G.Point([w / 2, h / 2]);
  else if (gt === 'LineString') geom = new G.LineString([[ins, h / 2], [w - ins, h / 2]]);
  else geom = new G.Polygon([[[ins, ins * 0.8], [w - ins, ins * 0.8], [w - ins, h - ins * 0.8], [ins, h - ins * 0.8], [ins, ins * 0.8]]]);
  const f = new ol.Feature({ ...props, type, geometry: geom });
  if (type === 'tee' || type === 'mando') f.set('rotation', 90);
  for (const s of featureStyle(f, 1, { pxPerMm: pm, legend: true })) {
    vc.setStyle(s);
    const gf = s.getGeometryFunction();
    const gg = gf(f);
    if (gg) vc.drawGeometry(gg);
  }
  return cv.toDataURL('image/png');
}
