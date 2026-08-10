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

/**
 * @param polygons array of [outerRing, ...holes]
 * @param opts.project  map each [a,b] through the Robinson projector (default
 *   true for lon/lat country data; false for the already-projected Albers
 *   state data)
 * @param opts.tolerance / opts.speck / opts.gate  simplification and
 *   speck-pruning thresholds in the output coordinate space
 */
function buildShape(polygons, opts = {}) {
  const { project: doProject = true, tolerance = TOLERANCE, speck = 4, gate = 500 } = opts;
  const projected = polygons.map((poly) =>
    poly.map((ring) => (doProject ? ring.map(([lon, lat]) => project(lon, lat)) : ring.map(([x, y]) => [x, y]))));

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
  const minArea = total > gate ? speck : 0;
  let kept = scored.filter((s) => s.area >= minArea);
  if (!kept.length) kept = [scored.sort((a, b) => b.area - a.area)[0]];

  const rings = [];
  for (const { poly } of kept) {
    for (const ring of poly) {
      const s = simplify(ring, tolerance);
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
  const coarseTol = doProject ? 30 : tolerance * 4;
  const coarse = biggest.map((r) => simplify(r, coarseTol)).filter((r) => r.length >= 4);
  const label = polylabel(coarse.length ? coarse : biggest, doProject ? 4 : 0.5);

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

// ------------------------------------------------------- US states mode ----

// The 50 states + DC, drawn from us-atlas's Albers USA composite (which packs
// Alaska and Hawaii into insets so every state stays readable) and paired with
// the traced flags from us-state-flags. They are scaled and offset into the
// same coordinate box as the world so the whole game engine — pins, magnifier,
// flag-fill, zoom — works on them unchanged; the app just shows the states
// layer instead of the world when this mode is on.
const FIPS_TO_USPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', 10: 'DE',
  11: 'DC', 12: 'FL', 13: 'GA', 15: 'HI', 16: 'ID', 17: 'IL', 18: 'IN', 19: 'IA', 20: 'KS',
  21: 'KY', 22: 'LA', 23: 'ME', 24: 'MD', 25: 'MA', 26: 'MI', 27: 'MN', 28: 'MS', 29: 'MO',
  30: 'MT', 31: 'NE', 32: 'NV', 33: 'NH', 34: 'NJ', 35: 'NM', 36: 'NY', 37: 'NC', 38: 'ND',
  39: 'OH', 40: 'OK', 41: 'OR', 42: 'PA', 44: 'RI', 45: 'SC', 46: 'SD', 47: 'TN', 48: 'TX',
  49: 'UT', 50: 'VT', 51: 'VA', 53: 'WA', 54: 'WV', 55: 'WI', 56: 'WY',
};

function buildStates() {
  const topo = req('us-atlas/states-albers-10m.json');
  const stArcs = decodeArcs(topo);

  // Census divisions, keyed by USPS code — the state equivalent of a subregion.
  const DIVISION = {
    CT: 'New England', ME: 'New England', MA: 'New England', NH: 'New England', RI: 'New England', VT: 'New England',
    NJ: 'Mid-Atlantic', NY: 'Mid-Atlantic', PA: 'Mid-Atlantic',
    IL: 'East North Central', IN: 'East North Central', MI: 'East North Central', OH: 'East North Central', WI: 'East North Central',
    IA: 'West North Central', KS: 'West North Central', MN: 'West North Central', MO: 'West North Central', NE: 'West North Central', ND: 'West North Central', SD: 'West North Central',
    DE: 'South Atlantic', FL: 'South Atlantic', GA: 'South Atlantic', MD: 'South Atlantic', NC: 'South Atlantic', SC: 'South Atlantic', VA: 'South Atlantic', WV: 'South Atlantic', DC: 'South Atlantic',
    AL: 'East South Central', KY: 'East South Central', MS: 'East South Central', TN: 'East South Central',
    AR: 'West South Central', LA: 'West South Central', OK: 'West South Central', TX: 'West South Central',
    AZ: 'Mountain', CO: 'Mountain', ID: 'Mountain', MT: 'Mountain', NV: 'Mountain', NM: 'Mountain', UT: 'Mountain', WY: 'Mountain',
    AK: 'Pacific', CA: 'Pacific', HI: 'Pacific', OR: 'Pacific', WA: 'Pacific',
  };
  // 2020 census resident population.
  const POP = {
    CA: 39538223, TX: 29145505, FL: 21538187, NY: 20201249, PA: 13002700, IL: 12812508, OH: 11799448,
    GA: 10711908, NC: 10439388, MI: 10077331, NJ: 9288994, VA: 8631393, WA: 7705281, AZ: 7151502,
    MA: 7029917, TN: 6910840, IN: 6785528, MD: 6177224, MO: 6154913, WI: 5893718, CO: 5773714,
    MN: 5706494, SC: 5118425, AL: 5024279, LA: 4657757, KY: 4505836, OR: 4237256, OK: 3959353,
    CT: 3605944, UT: 3271616, IA: 3190369, NV: 3104614, AR: 3011524, MS: 2961279, KS: 2937880,
    NM: 2117522, NE: 1961504, ID: 1839106, WV: 1793716, HI: 1455271, NH: 1377529, ME: 1362359,
    RI: 1097379, MT: 1084225, DE: 989948, SD: 886667, ND: 779094, AK: 733391, DC: 689545,
    VT: 643077, WY: 576851,
  };
  const AREA_KM2 = {
    AK: 1723337, TX: 695662, CA: 423967, MT: 380831, NM: 314917, AZ: 295234, NV: 286380, CO: 269601,
    OR: 254799, WY: 253335, MI: 250487, MN: 225163, UT: 219882, ID: 216443, KS: 213100, NE: 200330,
    SD: 199729, WA: 184661, ND: 183108, OK: 181037, MO: 180540, FL: 170312, WI: 169635, GA: 153910,
    IL: 149995, IA: 145746, NY: 141297, NC: 139391, AR: 137732, AL: 135767, LA: 135659, MS: 125438,
    PA: 119280, OH: 116098, VA: 110787, TN: 109153, KY: 104656, IN: 94326, ME: 91633, SC: 82933,
    WV: 62756, MD: 32131, HI: 28313, MA: 27336, VT: 24906, NH: 24214, NJ: 22591, CT: 14357,
    DE: 6446, RI: 4001, DC: 177,
  };

  const stateMeta = req('us-state-flags/src/data/states.json');
  const capByName = new Map(stateMeta.map((s) => [s.name, s.capital]));
  const sflags = {};

  const flagDir = path.join(HERE, 'node_modules/us-state-flags/src/components/flags');
  const readStateFlag = (code) => {
    const file = path.join(flagDir, `Flag${code}.js`);
    if (!fs.existsSync(file)) return null;
    const src = fs.readFileSync(file, 'utf8');
    const vb = (src.match(/viewBox:\s*'([^']+)'/) || [])[1] || '0 0 250 167';
    const html = (src.match(/__html:\s*`([\s\S]*?)`\s*\}/) || [])[1] || '';
    if (!html) return null;
    const inner = html
      .replace(/<!--[\s\S]*?-->/g, '')
      // Trim path/point coordinates to one decimal; at flag scale the loss is
      // invisible and it roughly halves the payload.
      .replace(/-?\d+\.\d{2,}/g, (n) => (+n).toFixed(1))
      .replace(/>\s+</g, '><')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="none">${inner}</svg>`;
  };

  // Decode every state, find the raw Albers bounds, then scale+offset the
  // whole set into the world coordinate box so pin thresholds and zoom limits
  // behave the same as they do for countries.
  const raw = [];
  for (const geom of topo.objects.states.geometries) {
    const usps = FIPS_TO_USPS[geom.id];
    if (!usps) continue;
    raw.push({ usps, name: geom.properties.name, polygons: geometryToPolygons(stArcs, geom), arcIds: collectArcs(geom) });
  }
  let ax0 = Infinity;
  let ay0 = Infinity;
  let ax1 = -Infinity;
  let ay1 = -Infinity;
  for (const r of raw) for (const poly of r.polygons) for (const [x, y] of poly[0]) {
    if (x < ax0) ax0 = x;
    if (y < ay0) ay0 = y;
    if (x > ax1) ax1 = x;
    if (y > ay1) ay1 = y;
  }
  // Fill ~75% of the world width; keep the block clear of the antimeridian
  // wrap zone (x < 13% of W) so no state ever gets a spurious wrapped copy.
  const k = (W * 0.75) / (ax1 - ax0);
  const offX = W * 0.16;
  const offY = (H - (ay1 - ay0) * k) / 2;
  const put = ([x, y]) => [offX + (x - ax0) * k, offY + (y - ay0) * k];

  const features = [];
  const tol = 0.4 * k; // ~0.4 Albers px
  for (const r of raw) {
    const projected = r.polygons.map((poly) => poly.map((ring) => ring.map(put)));
    const shape = buildShape(projected, { project: false, tolerance: tol, speck: 2 * k * k, gate: 40 * k * k });
    features.push({
      id: `US-${r.usps}`,
      n: r.name,
      o: `State of ${r.name}`,
      c: 'US',
      s: DIVISION[r.usps] || 'United States',
      cap: capByName.get(r.name) || '',
      pop: POP[r.usps] || 0,
      km: AREA_KM2[r.usps] || 0,
      ll: [],
      nb: [],
      t: r.usps === 'DC' ? 1 : 0,
      b: shape.bbox,
      m: shape.mainBox,
      l: shape.label,
      a: shape.projArea,
      d: ringsToPath(shape.rings),
      _arcs: r.arcIds,
    });
    sflags[`US-${r.usps}`] = readStateFlag(r.usps);
  }

  // Adjacency from shared arcs — nice for the explore card, cheap to compute.
  for (const a of features) {
    for (const b of features) {
      if (a === b) continue;
      if ([...a._arcs].some((id) => b._arcs.has(id))) a.nb.push(b.id);
    }
  }
  for (const a of features) delete a._arcs;

  const noFlag = features.filter((f) => !sflags[f.id]).map((f) => f.id);
  if (noFlag.length) console.warn('! states missing a flag:', noFlag.join(', '));

  // Flags whose design spells the state's own name in legible letters — the
  // dead giveaway when you are meant to recognise the flag alone. Marked so
  // the app can blur them in the deck (only in flag-only mode). The seal-ring
  // names on other flags trace out illegibly, so they need no help.
  const NAME_ON_FLAG = new Set(['AR', 'CA', 'IA', 'KS', 'MT', 'ND', 'OK', 'OR', 'SD', 'WI']);
  for (const f of features) if (NAME_ON_FLAG.has(f.id.slice(3))) f.hn = 1;

  features.sort((a, b) => a.n.localeCompare(b.n));

  // Faint silhouette of the whole country, drawn under the states.
  const nation = geometryToPolygons(stArcs, topo.objects.nation.geometries[0])
    .map((poly) => poly.map((ring) => simplify(ring.map(put), tol)).filter((ring) => ring.length >= 4))
    .flatMap((rings) => rings);

  const bb = [
    Math.round(offX), Math.round(offY),
    Math.round(offX + (ax1 - ax0) * k), Math.round(offY + (ay1 - ay0) * k),
  ];
  return {
    fit: bb,
    base: ringsToPath(nation),
    features,
    flags: sflags,
  };
}

/** Arc indices touched by a geometry, sign-normalised, as a Set. */
function collectArcs(geom) {
  const out = new Set();
  const walk = (a) => {
    if (typeof a === 'number') out.add(a < 0 ? ~a : a);
    else if (Array.isArray(a)) a.forEach(walk);
  };
  walk(geom.arcs);
  return out;
}

// ------------------------------------------------------------------ emit ---

const statesData = buildStates();

const flags = {};
for (const c of countries) flags[c.id] = readFlag(c.id);
Object.assign(flags, statesData.flags);

const geoData = {
  w: Math.round(W),
  h: Math.round(H),
  outline,
  seam,
  graticule,
  antarctica: antarctica ? ringsToPath(antarctica.rings) : '',
  fits,
  countries,
  states: {
    fit: statesData.fit,
    base: statesData.base,
    features: statesData.features,
  },
};

const stats = {
  countries: countries.filter((c) => !c.t).length,
  territories: countries.filter((c) => c.t).length,
  states: statesData.features.length,
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
console.log(`countries: ${stats.countries}  territories: ${stats.territories}  states: ${stats.states}  vertices: ${stats.points}`);
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
