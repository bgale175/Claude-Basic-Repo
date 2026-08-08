#!/usr/bin/env node
// Builds atlas-arcade/index.html: a single self-contained page containing the
// projected world geometry, every flag, the stylesheet and the game code.
//
//   cd atlas-arcade/tools && npm install && npm run build
//
// Sources: Natural Earth 1:50m via world-atlas, country metadata via
// world-countries, flags via flag-icons.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeArcs, geometryToPolygons, makeProjector, simplify, ringArea,
  polylabel, ringsToPath, cutAntimeridian,
} from './geo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');
const req = (p) => JSON.parse(fs.readFileSync(path.join(HERE, 'node_modules', p), 'utf8'));

const topology = req('world-atlas/countries-50m.json');
const meta = req('world-countries/countries.json');
const FLAG_DIR = path.join(HERE, 'node_modules/flag-icons/flags/4x3');

// world-countries carries no population, so join one in by ISO code.
const population = (() => {
  const byName = new Map(req('country-json/src/country-by-abbreviation.json')
    .map((r) => [r.country, r.abbreviation]));
  const out = new Map();
  for (const row of req('country-json/src/country-by-population.json')) {
    const code = byName.get(row.country);
    if (code && row.population) out.set(code, row.population);
  }
  // Names the source spells differently or omits entirely.
  out.set('TL', out.get('TP') || 1267972);
  out.set('TW', 23570000);
  out.set('XK', 1762000);
  return out;
})();

// World width in projected units. 40000 units across the equator is roughly
// one unit per kilometre, which keeps integer path data compact while staying
// smooth at maximum zoom.
const WORLD_WIDTH = 40000;
// Douglas-Peucker tolerance in those same units (~2.5 km).
const TOLERANCE = 1;

const { project, width: W, height: H } = makeProjector(WORLD_WIDTH);

// --------------------------------------------------------------- metadata --

const OBSERVERS = new Set(['VA', 'PS']);
const PARTIAL = new Set(['XK', 'TW']);
const byNumeric = new Map(meta.map((c) => [c.ccn3, c]));
const byAlpha2 = new Map(meta.map((c) => [c.cca2, c]));
const byAlpha3 = new Map(meta.map((c) => [c.cca3, c]));

// Natural Earth features that carry no ISO code. Only Kosovo is playable.
const NAME_FIXUPS = { Kosovo: 'XK' };

function continentOf(c) {
  if (c.region === 'Africa') return 'AF';
  if (c.region === 'Europe') return 'EU';
  if (c.region === 'Asia') return 'AS';
  if (c.region === 'Oceania') return 'OC';
  if (c.region === 'Antarctic') return 'AN';
  if (c.region === 'Americas') return c.subregion === 'South America' ? 'SA' : 'NA';
  return 'XX';
}

// A few names read better in a game than the dataset's formal common name.
const NAME_OVERRIDES = {
  CD: 'DR Congo',
  CG: 'Republic of the Congo',
  CZ: 'Czechia',
  GB: 'United Kingdom',
  US: 'United States',
  AE: 'United Arab Emirates',
  CF: 'Central African Republic',
  VA: 'Vatican City',
  KP: 'North Korea',
  KR: 'South Korea',
  LA: 'Laos',
  SY: 'Syria',
  MD: 'Moldova',
  TZ: 'Tanzania',
  BN: 'Brunei',
  VN: 'Vietnam',
  RU: 'Russia',
  BO: 'Bolivia',
  VE: 'Venezuela',
  IR: 'Iran',
  MK: 'North Macedonia',
  TL: 'Timor-Leste',
  SZ: 'Eswatini',
  FM: 'Micronesia',
  VC: 'St. Vincent & Grenadines',
  KN: 'St. Kitts & Nevis',
  LC: 'St. Lucia',
  BA: 'Bosnia & Herzegovina',
  ST: 'São Tomé & Príncipe',
  AG: 'Antigua & Barbuda',
  TT: 'Trinidad & Tobago',
  GS: 'South Georgia',
  SH: 'St. Helena',
  PM: 'St. Pierre & Miquelon',
  VG: 'British Virgin Islands',
  VI: 'U.S. Virgin Islands',
  TC: 'Turks & Caicos',
  MP: 'Northern Mariana Islands',
  TF: 'French Southern Territories',
  IO: 'British Indian Ocean Territory',
  HM: 'Heard & McDonald Islands',
  WF: 'Wallis & Futuna',
  BL: 'St. Barthélemy',
  MF: 'St. Martin',
  SX: 'Sint Maarten',
  CC: 'Cocos (Keeling) Islands',
};

const flagCache = new Map();
function readFlag(code) {
  const key = code.toLowerCase();
  if (flagCache.has(key)) return flagCache.get(key);
  const file = path.join(FLAG_DIR, `${key}.svg`);
  let svg = null;
  if (fs.existsSync(file)) {
    svg = fs.readFileSync(file, 'utf8')
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+id="flag-icons-[a-z-]+"/g, '')
      .replace(/>\s+</g, '><')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  flagCache.set(key, svg);
  return svg;
}

// --------------------------------------------------------------- geometry --

const arcs = decodeArcs(topology);
const shapes = new Map(); // cca2 -> { rings, bbox, label, projArea }

/** @param polygons array of [outerRing, ...holes] in lon/lat. */
function buildShape(polygons) {
  // Project every ring, then keep only the meaningful ones.
  const projected = polygons.map((poly) =>
    poly.map((ring) => ring.map(([lon, lat]) => project(lon, lat))));

  // Score a polygon by its largest ring, not by ring 0: Natural Earth stores
  // Antarctica as a degenerate strip along -90 with the real coastline as the
  // second ring, and ranking on ring 0 would throw the continent away.
  const scored = projected.map((poly) => {
    let area = 0;
    let main = poly[0];
    for (const ring of poly) {
      const a = ringArea(ring);
      if (a > area) { area = a; main = ring; }
    }
    // Put the largest ring first so label placement uses the real outline.
    return { poly: main === poly[0] ? poly : [main, ...poly.filter((r) => r !== main)], area };
  });
  const total = scored.reduce((sum, s) => sum + s.area, 0);
  // Tiny specks are visual noise, but atoll nations are made entirely of
  // specks - only prune when the country is large enough to spare them.
  const minArea = total > 500 ? 4 : 0;
  let kept = scored.filter((s) => s.area >= minArea);
  if (!kept.length) kept = [scored.sort((a, b) => b.area - a.area)[0]];

  const rings = [];
  for (const { poly } of kept) {
    for (const ring of poly) {
      const s = simplify(ring, TOLERANCE);
      if (s.length >= 4) rings.push(s);
    }
  }
  if (!rings.length) for (const ring of kept[0].poly) rings.push(ring);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  // Anchor the label inside the largest landmass.
  const biggest = kept.slice().sort((a, b) => b.area - a.area)[0].poly;
  const coarse = biggest.map((r) => simplify(r, 30)).filter((r) => r.length >= 4);
  const label = polylabel(coarse.length ? coarse : biggest, 4);

  // Bounds of just that landmass. The full bbox is useless for the flag fill
  // of a country split at the antimeridian - Fiji's spans the entire map.
  let mainX0 = Infinity;
  let mainY0 = Infinity;
  let mainX1 = -Infinity;
  let mainY1 = -Infinity;
  for (const [x, y] of biggest[0]) {
    if (x < mainX0) mainX0 = x;
    if (y < mainY0) mainY0 = y;
    if (x > mainX1) mainX1 = x;
    if (y > mainY1) mainY1 = y;
  }

  return {
    rings,
    bbox: [minX, minY, maxX, maxY].map((v) => Math.round(v)),
    mainBox: [mainX0, mainY0, mainX1, mainY1].map((v) => Math.round(v)),
    label: label.map((v) => Math.round(v)),
    projArea: Math.round(kept.reduce((s, x) => s + x.area, 0)),
  };
}

const wrapCuts = [];

/** Splits one polygon at the antimeridian, keeping holes with their piece. */
function splitPolygon(poly, name) {
  const [outer, ...holes] = poly;
  const pieces = cutAntimeridian(outer);
  if (pieces.length === 1) return [[outer, ...holes]];
  if (!wrapCuts.includes(name)) wrapCuts.push(name);
  return pieces.map((piece) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [lon] of piece) {
      if (lon < lo) lo = lon;
      if (lon > hi) hi = lon;
    }
    return [piece, ...holes.filter((h) => h[0][0] >= lo && h[0][0] <= hi)];
  });
}

// Group first: a few ISO codes appear on more than one Natural Earth feature
// (Australia also owns the Ashmore and Cartier Islands), and every polygon
// belonging to a country has to end up in the same shape.
const polygonsByCode = new Map();
for (const geometry of topology.objects.countries.geometries) {
  const info = byNumeric.get(String(geometry.id));
  const code = info ? info.cca2 : NAME_FIXUPS[geometry.properties.name];
  if (!code) continue;
  const list = polygonsByCode.get(code) || [];
  for (const poly of geometryToPolygons(arcs, geometry)) {
    list.push(...splitPolygon(poly, geometry.properties.name));
  }
  polygonsByCode.set(code, list);
}

// Tuvalu is absent from Natural Earth 1:50m. It is nine atolls totalling
// 26 km2, so synthesise a marker-sized shape at its coordinates; the game
// renders anything this small as a pin anyway.
if (!polygonsByCode.has('TV')) {
  const [lat, lon] = byAlpha2.get('TV').latlng;
  const ring = [];
  for (let a = 0; a <= 24; a++) {
    const t = (a / 24) * Math.PI * 2;
    ring.push([lon + 0.13 * Math.cos(t), lat + 0.13 * Math.sin(t)]);
  }
  polygonsByCode.set('TV', [[ring]]);
}

for (const [code, polygons] of polygonsByCode) shapes.set(code, buildShape(polygons));

// ----------------------------------------------------------- country list --

const countries = [];
const skipped = [];
for (const info of meta) {
  const code = info.cca2;
  const shape = shapes.get(code);
  const continent = continentOf(info);
  if (continent === 'AN' || continent === 'XX') continue;

  const sovereign = info.unMember || OBSERVERS.has(code) || PARTIAL.has(code);
  const flag = readFlag(code);
  if (!shape || !flag) {
    if (sovereign) skipped.push(`${info.name.common} (${code})`);
    continue;
  }

  countries.push({
    id: code,
    n: NAME_OVERRIDES[code] || info.name.common,
    o: info.name.official,
    c: continent,
    s: info.subregion || info.region,
    cap: (info.capital && info.capital[0]) || '',
    pop: population.get(code) || 0,
    km: Math.round(info.area),
    ll: info.latlng,
    nb: (info.borders || []).map((a3) => (byAlpha3.get(a3) || {}).cca2).filter(Boolean),
    t: sovereign ? 0 : 1,
    b: shape.bbox,
    m: shape.mainBox,
    l: shape.label,
    a: shape.projArea,
    d: ringsToPath(shape.rings),
  });
}
countries.sort((a, b) => a.n.localeCompare(b.n));

if (skipped.length) console.warn('! sovereign states with no shape/flag:', skipped.join(', '));
const noPop = countries.filter((c) => !c.t && !c.pop).map((c) => c.id);
if (noPop.length) console.warn(`! no population for ${noPop.length}:`, noPop.join(', '));

// Antarctica is scenery: drawn, never quizzed.
const antarctica = shapes.get('AQ');

// ---------------------------------------------------------- graticule etc --

function lineToPath(points) {
  let out = '';
  let px = 0;
  let py = 0;
  points.forEach(([lon, lat], i) => {
    const [x, y] = project(lon, lat).map(Math.round);
    out += i === 0 ? `M${x} ${y}` : `l${x - px} ${y - py}`;
    px = x;
    py = y;
  });
  return out;
}

let graticule = '';
for (let lon = -180; lon <= 180; lon += 20) {
  const pts = [];
  for (let lat = -90; lat <= 90; lat += 2) pts.push([lon, lat]);
  graticule += lineToPath(pts);
}
for (let lat = -80; lat <= 80; lat += 20) {
  const pts = [];
  for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, lat]);
  graticule += lineToPath(pts);
}

// Outline of the projected globe, used as the ocean shape.
const outline = (() => {
  const pts = [];
  for (let lat = -90; lat <= 90; lat += 2) pts.push([-180, lat]);
  for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, 90]);
  for (let lat = 90; lat >= -90; lat -= 2) pts.push([180, lat]);
  for (let lon = 180; lon >= -180; lon -= 2) pts.push([lon, -90]);
  return `${lineToPath(pts)}z`;
})();

// Robinson is not cylindrical, so the map cannot tile: between the primary
// map's 180E edge and the wrapped copy's 180W edge sits a lens-shaped gap
// that widens away from the equator. This polygon covers exactly that gap so
// the Pacific reads as continuous ocean.
const seam = (() => {
  const pts = [];
  for (let lat = -90; lat <= 90; lat += 2) {
    const [x, y] = project(180, lat);
    pts.push([Math.round(x), Math.round(y)]);
  }
  for (let lat = 90; lat >= -90; lat -= 2) {
    const [x, y] = project(-180, lat);
    pts.push([Math.round(x + W), Math.round(y)]);
  }
  let out = '';
  let px = 0;
  let py = 0;
  pts.forEach(([x, y], i) => {
    out += i === 0 ? `M${x} ${y}` : `l${x - px} ${y - py}`;
    px = x;
    py = y;
  });
  return `${out}z`;
})();

// ------------------------------------------------------------- framing ----

// Hand-tuned lon/lat windows per region. Deriving these from country bounds
// fails for Oceania and Kiribati, which straddle the antimeridian; a window
// may therefore run past +180, landing in the wrapped copy of the map that
// the game renders to the right of the primary one.
const REGION_WINDOWS = {
  WORLD: [-180, -58, 180, 84],
  AF: [-26, -37, 56, 39],
  AS: [25, -11, 151, 57],
  EU: [-27, 33, 46, 72],
  NA: [-172, 5, -50, 74],
  SA: [-83, -57, -32, 14],
  OC: [110, -49, 200, 23],
};

const fits = {};
for (const [key, [lon0, lat0, lon1, lat1]] of Object.entries(REGION_WINDOWS)) {
  // Robinson x is linear in longitude, so the equator gives the widest span
  // and extrapolates cleanly past the antimeridian.
  const xAt = (lon) => (W / 2) * (1 + lon / 180);
  fits[key] = [
    Math.round(xAt(lon0)),
    Math.round(project(0, lat1)[1]),
    Math.round(xAt(lon1)),
    Math.round(project(0, lat0)[1]),
  ];
}

// ------------------------------------------------------------------ emit ---

const flags = {};
for (const c of countries) flags[c.id] = readFlag(c.id);

const geoData = {
  w: Math.round(W),
  h: Math.round(H),
  outline,
  seam,
  graticule,
  antarctica: antarctica ? ringsToPath(antarctica.rings) : '',
  fits,
  countries,
};

const stats = {
  countries: countries.filter((c) => !c.t).length,
  territories: countries.filter((c) => c.t).length,
  points: countries.reduce((n, c) => n + (c.d.match(/l/g) || []).length, 0),
};

const template = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');

const out = template
  .replace('/*__CSS__*/', () => css)
  .replace('/*__GEO__*/', () => `const GEO=${JSON.stringify(geoData)};`)
  .replace('/*__FLAGS__*/', () => `const FLAG_SVG=${JSON.stringify(flags)};`)
  .replace('/*__APP__*/', () => app);

const dest = path.join(ROOT, 'index.html');
fs.writeFileSync(dest, out);


const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
if (wrapCuts.length) console.log(`antimeridian cuts: ${wrapCuts.join(', ')}`);
console.log(`countries: ${stats.countries}  territories: ${stats.territories}  vertices: ${stats.points}`);
console.log(`geometry:  ${kb(JSON.stringify(geoData).length)}`);
console.log(`flags:     ${kb(JSON.stringify(flags).length)} (${Object.keys(flags).length})`);
console.log(`wrote ${path.relative(process.cwd(), dest)}  ${kb(out.length)}`);

// `--artifact <path>` also writes a fragment with no document wrapper, for
// hosts that supply their own <head> and <body>. Not committed.
const artifactFlag = process.argv.indexOf('--artifact');
if (artifactFlag !== -1 && process.argv[artifactFlag + 1]) {
  const style = out.slice(out.indexOf('<style>'), out.indexOf('</style>') + 8);
  const body = out.slice(out.indexOf('<body>') + 6, out.lastIndexOf('</body>'));
  const target = process.argv[artifactFlag + 1];
  fs.writeFileSync(target, `${style}\n${body.trim()}\n`);
  console.log(`wrote ${target}  ${kb(style.length + body.length)}`);
}
