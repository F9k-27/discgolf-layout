// Minimal GeoPackage 1.3 writer (sql.js) — one feature table per object type, EPSG:5514
import { holeLength, holeLine } from './map.js';
import { TYPES } from './state.js';
import { bearing } from './styles.js';

const SRS_5514 = 'PROJCS["S-JTSK / Krovak East North",GEOGCS["S-JTSK",DATUM["System_of_the_Jednotne_Trigonometricke_Site_Katastralni",SPHEROID["Bessel 1841",6377397.155,299.1528128,AUTHORITY["EPSG","7004"]],TOWGS84[570.8,85.7,462.8,4.998,1.587,5.261,3.56],AUTHORITY["EPSG","6156"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4156"]],PROJECTION["Krovak"],PARAMETER["latitude_of_center",49.5],PARAMETER["longitude_of_center",24.8333333333333],PARAMETER["azimuth",30.2881397527778],PARAMETER["pseudo_standard_parallel_1",78.5],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","5514"]]';
const SRS_4326 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';
const SRID = 5514;

/* ---------- geometry encoding ---------- */

function wkb(geom) {
  const t = geom.type;
  const parts = [];
  let size = 5;
  if (t === 'Point') size += 16;
  else if (t === 'LineString') size += 4 + geom.coordinates.length * 16;
  else size += 4 + geom.coordinates.reduce((s, r) => s + 4 + r.length * 16, 0);
  const buf = new DataView(new ArrayBuffer(size));
  let o = 0;
  buf.setUint8(o, 1); o += 1;
  buf.setUint32(o, t === 'Point' ? 1 : t === 'LineString' ? 2 : 3, true); o += 4;
  const pt = (c) => { buf.setFloat64(o, c[0], true); buf.setFloat64(o + 8, c[1], true); o += 16; };
  if (t === 'Point') pt(geom.coordinates);
  else if (t === 'LineString') { buf.setUint32(o, geom.coordinates.length, true); o += 4; geom.coordinates.forEach(pt); }
  else {
    buf.setUint32(o, geom.coordinates.length, true); o += 4;
    for (const ring of geom.coordinates) { buf.setUint32(o, ring.length, true); o += 4; ring.forEach(pt); }
  }
  void parts;
  return new Uint8Array(buf.buffer);
}
function coordsOf(geom) {
  if (geom.type === 'Point') return [geom.coordinates];
  if (geom.type === 'LineString') return geom.coordinates;
  return geom.coordinates.flat();
}
function envelope(geom) {
  const cs = coordsOf(geom);
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const p of cs) { a = Math.min(a, p[0]); b = Math.max(b, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[1]); }
  return [a, b, c, d]; // minx maxx miny maxy
}
function gpkgGeom(geom) {
  const body = wkb(geom);
  const hasEnv = geom.type !== 'Point';
  const head = new DataView(new ArrayBuffer(8 + (hasEnv ? 32 : 0)));
  head.setUint8(0, 0x47); head.setUint8(1, 0x50); head.setUint8(2, 0);
  head.setUint8(3, (hasEnv ? 1 : 0) << 1 | 1); // little endian, envelope xy
  head.setInt32(4, SRID, true);
  if (hasEnv) envelope(geom).forEach((v, i) => head.setFloat64(8 + i * 8, v, true));
  const out = new Uint8Array(head.byteLength + body.length);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(body, head.byteLength);
  return out;
}

/* ---------- layers ---------- */

function circlePoly(c, r, n = 72) {
  const ring = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; ring.push([c[0] + r * Math.sin(a), c[1] + r * Math.cos(a)]); }
  return { type: 'Polygon', coordinates: [ring] };
}

function collect(project) {
  const L = {}; // name → { gtype, cols: {name:type}, rows: [{geom, ...attrs}] }
  const layer = (name, gtype, cols) => (L[name] ||= { gtype, cols, rows: [] });
  const hcols = { hole: 'INTEGER', par: 'INTEGER' };

  for (const h of project.holes) {
    const base = { hole: h.n, par: h.par };
    const line = holeLine(h);
    if (line) layer('holes', 'LINESTRING', { ...hcols, length_m: 'INTEGER', info: 'TEXT' })
      .rows.push({ geom: { type: 'LineString', coordinates: line }, ...base, length_m: holeLength(h), info: h.info || '' });

    for (const f of h.features) {
      const p = { ...(TYPES[f.type] || {}), ...(f.props || {}) };
      const g = f.geom;
      switch (f.type) {
        case 'tee': {
          let dir = p.rotation;
          if (dir == null) {
            const bs = h.features.filter((x) => x.type === 'basket').map((x) => x.geom.coordinates);
            bs.sort((a, b) => Math.hypot(a[0] - g.coordinates[0], a[1] - g.coordinates[1]) - Math.hypot(b[0] - g.coordinates[0], b[1] - g.coordinates[1]));
            dir = bs.length ? Math.round(bearing(g.coordinates, bs[0]) * 10) / 10 : null;
          }
          layer('tees', 'POINT', { ...hcols, label: 'TEXT', direction_deg: 'REAL' }).rows.push({ geom: g, ...base, label: p.label || '', direction_deg: dir });
          break;
        }
        case 'basket':
          layer('baskets', 'POINT', hcols).rows.push({ geom: g, ...base });
          layer('basket_circles', 'POLYGON', { ...hcols, circle: 'TEXT', radius_m: 'REAL' }).rows.push(
            { geom: circlePoly(g.coordinates, 10), ...base, circle: 'C1', radius_m: 10 },
            { geom: circlePoly(g.coordinates, 20), ...base, circle: 'C2', radius_m: 20 });
          break;
        case 'fairway': layer('fairways', 'LINESTRING', { ...hcols, color: 'TEXT', width_mm: 'REAL' }).rows.push({ geom: g, ...base, color: p.color, width_mm: p.width }); break;
        case 'ob': layer('ob_zones', 'POLYGON', { ...hcols, color: 'TEXT' }).rows.push({ geom: g, ...base, color: p.color }); break;
        case 'hazard': layer('hazards', 'POLYGON', { ...hcols, color: 'TEXT' }).rows.push({ geom: g, ...base, color: p.color }); break;
        case 'water': layer('water', 'POLYGON', { ...hcols, color: 'TEXT' }).rows.push({ geom: g, ...base, color: p.color }); break;
        case 'mando': layer('mandos', 'POINT', { ...hcols, direction_deg: 'REAL', color: 'TEXT' }).rows.push({ geom: g, ...base, direction_deg: p.rotation ?? 0, color: p.color }); break;
        case 'mandoObj': layer('mando_objects', 'POINT', { ...hcols, label: 'TEXT', size_m: 'REAL', color: 'TEXT' }).rows.push({ geom: g, ...base, label: p.label || '', size_m: p.size, color: p.color }); break;
        case 'dropzone': layer('drop_zones', 'POINT', hcols).rows.push({ geom: g, ...base }); break;
        case 'tree': layer('trees', 'POINT', { ...hcols, size_m: 'REAL', color: 'TEXT' }).rows.push({ geom: g, ...base, size_m: p.size, color: p.color }); break;
        case 'object': layer('objects', 'POINT', { ...hcols, label: 'TEXT', size_m: 'REAL', color: 'TEXT' }).rows.push({ geom: g, ...base, label: p.label || '', size_m: p.size, color: p.color }); break;
        case 'line': layer('lines', 'LINESTRING', { ...hcols, color: 'TEXT', width_mm: 'REAL' }).rows.push({ geom: g, ...base, color: p.color, width_mm: p.width }); break;
        case 'text': layer('texts', 'POINT', { ...hcols, label: 'TEXT', size_mm: 'REAL', color: 'TEXT' }).rows.push({ geom: g, ...base, label: p.label || '', size_mm: p.size, color: p.color }); break;
      }
    }
  }
  for (const fc of project.facilities) {
    layer('facilities', 'POLYGON', { kind: 'TEXT', label: 'TEXT' }).rows.push({ geom: { type: 'Polygon', coordinates: [fc.coords] }, kind: fc.kind, label: fc.label || '' });
  }
  if (project.bbox) {
    const [a, b, c, d] = project.bbox;
    layer('course_area', 'POLYGON', { name: 'TEXT', place: 'TEXT', date: 'TEXT' }).rows.push({
      geom: { type: 'Polygon', coordinates: [[[a, b], [c, b], [c, d], [a, d], [a, b]]] },
      name: project.meta.name || '', place: project.meta.place || '', date: project.meta.date || '',
    });
  }
  return L;
}

let SQLp = null;
const loadSql = () => (SQLp ||= initSqlJs({ locateFile: (f) => 'lib/' + f }));

export async function buildGpkg(project) {
  const SQL = await loadSql();
  const db = new SQL.Database();
  db.run('PRAGMA application_id = 1196444487; PRAGMA user_version = 10300;');
  db.run(`CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT uk_gc_table_name UNIQUE (table_name), CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));`);
  const srs = db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)');
  srs.run(['Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system']);
  srs.run(['Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system']);
  srs.run(['WGS 84 geodetic', 4326, 'EPSG', 4326, SRS_4326, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid']);
  srs.run(['S-JTSK / Krovak East North', SRID, 'EPSG', SRID, SRS_5514, 'S-JTSK / Krovak East North (EPSG:5514)']);
  srs.free();

  const layers = collect(project);
  for (const [name, L] of Object.entries(layers)) {
    if (!L.rows.length) continue;
    const cols = Object.entries(L.cols);
    db.run(`CREATE TABLE "${name}" (fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, geom ${L.gtype}${cols.map(([c, ty]) => `, "${c}" ${ty}`).join('')})`);
    const ins = db.prepare(`INSERT INTO "${name}" (geom${cols.map(([c]) => `, "${c}"`).join('')}) VALUES (?${cols.map(() => ',?').join('')})`);
    let ex = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of L.rows) {
      const e = envelope(r.geom);
      ex = [Math.min(ex[0], e[0]), Math.min(ex[1], e[2]), Math.max(ex[2], e[1]), Math.max(ex[3], e[3])];
      ins.run([gpkgGeom(r.geom), ...cols.map(([c]) => (r[c] === undefined ? null : r[c]))]);
    }
    ins.free();
    db.run('INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, 'features', name, '', ...ex, SRID]);
    db.run('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,0,0)', [name, 'geom', L.gtype, SRID]);
  }
  const bytes = db.export();
  db.close();
  return bytes;
}
