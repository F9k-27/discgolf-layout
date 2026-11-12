# Disc Golf Layout

A static web app for designing disc golf course layouts. It runs entirely in the browser with no server or build step, so it is ready for **GitHub Pages**.
[You can visit it on this page](https://f9k-27.github.io/discgolf-layout/)

**Workflow:** create a project → lay out every hole on a print-ready page → export a **PDF course guide** and a **GeoPackage** for GIS → save the project as **JSON** and continue later. UI in **čeština / English**.

## Features

**Project**
- Layout name, place, approximate GPS (Nominatim search or pick on map), date and time, number of holes (1–36)
- Rich-text notes (bold, headings, lists, colour, size) for prices, schedule and rules, printed on the title page
- Map area (min/max box) drawn on the map; used for the title-page overview
- Facilities as rectangles: parking, toilets, registration, refreshments, first aid, other (label editable)

**Map layers**
- Built in: Ortofoto ČÚZK, ZTM5, ZABAGED polohopis, OpenStreetMap
- Add or remove WMS / XYZ layers, load the layer list from GetCapabilities, reorder, visibility and opacity
- Layer settings are saved in the project and used in the PDF

**Hole editor (WYSIWYG)**
- The hole is edited directly on a paper sheet (A4/A3, portrait/landscape), so the preview is the print
- Zooming changes the print scale (snaps to 1:500, 1:750, 1:1000 …); custom scales are possible
- Map rotation, "Fit hole", and "Tee → basket upward"
- Tools: tee pad (faces the basket automatically), basket with C1/C2 (10/20 m), fairway line, OB, hazard, water, mando arrow (direction), mando object (triple/quad), drop zone, tree (size in m), object (colour and size), line (colour and width), text
- Par, hole info text (printed in the notes box), automatic length (fairway, or straight tee→basket)
- Hole number + par fixed top-left; notes, legend and scale bar (with true-north arrow) can be dragged anywhere on the page and toggled
- Optional faded display of the other holes, plus undo/redo, snapping and keyboard shortcuts

**Export**
- **PDF** contains a title page (name, place, date, overview map with numbered holes and facilities, scorecard in rows of 9 with Σ, notes), then one page per hole. The WMS basemap is printed under the disc golf features. There are two ways to get it:
  - **Print / Save as PDF** (recommended): opens the browser print dialog with the exact page sizes and zero margins already set; choose *Save as PDF*. Each WMS layer is placed as a plain GetMap image, rotated to match the page, so the basemap prints even when the server doesn't allow CORS. Text stays vector.
  - **Download PDF file**: builds the PDF directly from page images at 150/200/300 dpi. Basemaps appear only if their server allows CORS; if not, the app offers to switch to printing.
- **GeoPackage** (`.gpkg`, EPSG:5514): layers `holes`, `tees`, `baskets`, `basket_circles`, `fairways`, `ob_zones`, `hazards`, `water`, `mandos`, `mando_objects`, `drop_zones`, `trees`, `objects`, `lines`, `texts`, `facilities`, `course_area`, all with hole/par attributes. Opens in QGIS and ArcGIS Pro.
- **JSON**: the whole project; open it again with "Open". The project is also autosaved in the browser (localStorage).

## Deploy to GitHub Pages

1. Create a repository and copy in the contents of this folder, so that `index.html` is at the root.
2. Commit and push.
3. In **Settings → Pages**, set *Source: Deploy from a branch*, choose `main` and `/ (root)`, then save.
4. After a minute the app is live at `https://<user>.github.io/<repo>/`.

`.nojekyll` is included so GitHub serves every file unchanged.

## Run locally

ES modules don't load from `file://`, so serve the folder:

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Notes

- **Coordinate system**: the map, the stored geometry and the GeoPackage are all in S-JTSK / Křovák East North (EPSG:5514), with 7-parameter towgs84 for display. GPS input is WGS84 lat/lon.
- **CORS**: *Print / Save as PDF* doesn't need it for WMS layers. *Download PDF file* does, because it reads the map pixels; a layer whose server blocks this is left out of that file with a warning. XYZ tile layers (OSM) are reprojected to Křovák in the browser, so they always need CORS, which OSM allows.
- **ZABAGED** uses `layers: *`: the app reads GetCapabilities and requests all leaf layers. You can pick specific layers in *Map layers → ✎ → Load layer list*.
- **Place search** uses the public Nominatim service (OpenStreetMap); please keep usage light.
- **Large PDFs**: 18 holes at 300 dpi takes a while and produces a bigger file. 200 dpi is a good default.

## Structure

```
index.html          app shell
css/style.css       UI + page (print) styles — page elements are sized in paper mm via --mm
js/app.js           UI: project, hole editor, layers, export
js/state.js         project model, defaults, object types
js/i18n.js          CZ / EN strings
js/map.js           EPSG:5514 setup, WMS layers, feature (de)serialisation, off-screen print rendering
js/styles.js        map symbology (sizes in paper mm → identical on screen and on paper)
js/page.js          page layout shared by preview and PDF (header, legend, scale bar, title page)
js/pdf.js           printing: browser print with WMS GetMap images under a feature layer, or direct PDF (html2canvas + jsPDF)
js/gpkg.js          GeoPackage writer (sql.js)
lib/                vendored OpenLayers 10, proj4, jsPDF, html2canvas, sql.js (no CDN needed)
```

## Project file format (JSON)

```jsonc
{
  "app": "discgolf-layout", "version": 1,
  "meta": { "name", "place", "lat", "lon", "date", "time", "notesHtml" },
  "bbox": [minx, miny, maxx, maxy],            // EPSG:5514
  "facilities": [{ "id", "kind", "label", "coords": [[x,y],…] }],
  "wms": [{ "id", "name", "type": "wms|xyz", "url", "layers", "format", "visible", "opacity" }],
  "titlePage": { "paper", "orientation" },
  "holes": [{
    "n", "par", "info",
    "features": [{ "id", "type", "geom": GeoJSON geometry, "props": { "color", "size", "width", "rotation", "label", "c1", "c2" } }],
    "page": { "paper", "orientation", "scale", "rotation", "center", "showOthers", "boxes": { "notes|legend|scale": { "corner", "dx", "dy", "show" } } }
  }]
}
```

Libraries: OpenLayers (BSD-2), proj4js (MIT), jsPDF (MIT), html2canvas (MIT), sql.js (MIT).
