/* Atlas Arcade — drag flags and names onto the world map.
 * GEO and FLAG_SVG are injected above this file by tools/build.mjs. */
(() => {
'use strict';

// ============================================================= foundations

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};
const svgEl = (tag, attrs) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fmt = new Intl.NumberFormat('en-US');

const W = GEO.w;
const H = GEO.h;
const BY_ID = new Map([...GEO.countries, ...GEO.states.features].map((c) => [c.id, c]));

const CONTINENTS = {
  AF: { name: 'Africa', icon: '🦁', hue: '#f7b267' },
  AS: { name: 'Asia', icon: '🐉', hue: '#ff8f7a' },
  EU: { name: 'Europe', icon: '🏰', hue: '#7aa2f7' },
  NA: { name: 'North America', icon: '🍁', hue: '#5fd39a' },
  SA: { name: 'South America', icon: '🦜', hue: '#c792ea' },
  OC: { name: 'Oceania', icon: '🐚', hue: '#46cfe0' },
};

// Accent hue for a feature, used for sparkles and the plain (no-flag) fill.
// US states aren't in CONTINENTS, so they fall back to a patriotic blue.
const hueOf = (c) => (CONTINENTS[c.c] || {}).hue || '#6c8cff';

const CHIP_MODES = {
  flag: { icon: '🏳️', title: 'Flags only', desc: 'Drag the flag onto its country. Hardest, and the best test.' },
  name: { icon: '🔤', title: 'Names only', desc: 'Drag the country name onto the map. Pure geography.' },
  both: { icon: '🏳️🔤', title: 'Flag + name', desc: 'Both together. Great when you are learning a new continent.' },
};

const GAME_MODES = {
  practice: { icon: '🌱', title: 'Practice', desc: 'No timer, no lives. Learn at your own pace.' },
  rush: { icon: '⚡', title: 'Time rush', desc: 'Beat the clock. Fast answers score more.' },
  survival: { icon: '❤️', title: 'Survival', desc: 'Three lives. One slip and the streak dies.' },
};

// A country narrower than this on screen is stood in for by a pin. Past that
// the pin fades out rather than blinking off, and is gone once the shape is
// PIN_FADE_TO times big enough to aim at directly.
const PIN_SHOW_PX = 26;
const PIN_FADE_TO = 2.4;
const PIN_R_PX = 4.5;
const PIN_HIT_PX = 20;
// Inside this radius a pin wins outright, even over the country it sits in.
const PIN_LOCK_PX = 10;
const PROBE_RADII = [9, 18, 29, 42];
const TRAY_SIZE = 7;
// The magnifier shows a fixed slice of the world rather than a fixed multiple
// of the current zoom, so it never turns into a featureless close-up. Below
// LOUPE_MIN_MAG there is nothing left to magnify and it hides itself.
const LOUPE_MAX_MAG = 6;
const LOUPE_MIN_SPAN = 620;
const LOUPE_MIN_MAG = 1.3;
// Gap between the pointer and the dragged card, so the card never covers the
// spot you are aiming at.
const GHOST_GAP = 16;
// Countries near the western edge get a wrapped copy so the Pacific reads
// as one region instead of being split down the antimeridian.
const WRAP_MAX_X = 0.13 * W;
const WRAP_MAX_AREA = 500000;

// =================================================================== flags

const flagCache = new Map();
function flagURL(id) {
  let url = flagCache.get(id);
  if (!url) {
    const svg = FLAG_SVG[id];
    if (!svg) return '';
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    flagCache.set(id, url);
  }
  return url;
}
// A copy of the flag with a Gaussian blur baked in, used for the states whose
// design spells their own name (Oklahoma, Wisconsin, …). The blur lives in the
// SVG's own units, so it hides the lettering by the same amount at every
// display size while leaving the seal a recognisable shape. Used only in the
// deck, so the crisp flag is still the reward once the state is placed.
const blurCache = new Map();
function flagURLNameHidden(id) {
  if (blurCache.has(id)) return blurCache.get(id);
  const svg = FLAG_SVG[id];
  const m = svg && svg.match(/viewBox="\s*[\d.]+\s+[\d.]+\s+([\d.]+)/);
  let url;
  if (!m) {
    url = flagURL(id);
  } else {
    const sd = (parseFloat(m[1]) / 55).toFixed(2);
    const open = svg.slice(0, svg.indexOf('>') + 1);
    const inner = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));
    const out = `${open}<defs><filter id="hn" x="-8%" y="-8%" width="116%" height="116%">`
      + `<feGaussianBlur stdDeviation="${sd}"/></filter></defs>`
      + `<g filter="url(#hn)">${inner}</g></svg>`;
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out)}`;
  }
  blurCache.set(id, url);
  return url;
}

function flagImg(id, cls, src) {
  const img = el('img', cls);
  img.src = src || flagURL(id);
  img.alt = '';
  img.draggable = false;
  return img;
}

// ================================================================= storage

const STORE_KEY = 'atlas-arcade/v1';
const store = loadStore();

function loadStore() {
  const blank = { prog: {}, best: {}, opts: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { prog: raw.prog || {}, best: raw.best || {}, opts: raw.opts || {} };
  } catch {
    return blank;
  }
}
let saveTimer = 0;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* private mode */ }
  }, 250);
}
function progOf(id) {
  let p = store.prog[id];
  if (!p) p = store.prog[id] = { b: 0, r: 0, w: 0 };
  return p;
}
// Leitner-style boxes: three clean placements to master a country, and a miss
// knocks it back down a level.
const MASTER_BOX = 3;
const isMastered = (id) => (store.prog[id]?.b || 0) >= MASTER_BOX;
/** Countries you have actually got wrong, and not yet re-learnt. */
const isTrouble = (id) => {
  const p = store.prog[id];
  if (!p || p.r + p.w === 0 || p.b >= MASTER_BOX) return false;
  return p.w > 0 || p.b === 0;
};

// =================================================================== state

const opts = Object.assign({
  territories: false,
  sound: true,
  loupe: true,
  flagFill: true,
  revealOnMiss: true,
}, store.opts);

const state = {
  region: 'AF',
  chipMode: 'both',
  gameMode: 'practice',
  playing: false,
  explore: false,
  paused: false,
  pool: [],
  remaining: [],
  solved: new Set(),
  missed: new Map(),
  hinted: new Set(),
  selected: null,
  score: 0,
  streak: 0,
  bestStreak: 0,
  lives: 3,
  attempts: 0,
  hits: 0,
  hintLevel: 0,
  hintFor: null,
  timeLeft: 0,
  startedAt: 0,
  endsAt: 0,
};

// =================================================================== nodes

const app = $('#app');
const stage = $('#stage');
const map = $('#map');
const scene = $('#scene');
const fx = $('#fx');
const loupe = $('#loupe');
const loupeSvg = $('#loupeSvg');
const loupeUse = loupeSvg.querySelector('use');
const ghost = $('#ghost');
const trayInner = $('#trayInner');

const defs = svgEl('defs');
map.insertBefore(defs, map.firstChild);

/** Per-country runtime record: every DOM node that represents it. */
const rec = new Map();

// ================================================================= drawing

// The world lives in #worldScene, the US states in #statesScene, and the app
// shows one or the other. Both are laid out in the same coordinate box, so
// zoom, pins, the magnifier and flag-fill are identical machinery either way.
// The world's interactive layers also exist a second time, a world-width east,
// so the Pacific can be played as one piece.
const layer = {};
const wrapGroups = {};
const slayer = {};

function buildMap() {
  const worldScene = svgEl('g', { id: 'worldScene' });
  worldScene.append(
    svgEl('path', { class: 'ocean', d: GEO.outline }),
    svgEl('path', { class: 'ocean', d: GEO.outline, transform: `translate(${W},0)` }),
    svgEl('path', { class: 'seam', d: GEO.seam }),
  );
  for (const [cls, d] of [['graticule', GEO.graticule], ['antarctica', GEO.antarctica]]) {
    worldScene.append(
      svgEl('path', { class: cls, d }),
      svgEl('path', { class: cls, d, transform: `translate(${W},0)` }),
    );
  }
  for (const name of ['lands', 'pins', 'marks', 'labels']) {
    layer[name] = svgEl('g');
    wrapGroups[name] = svgEl('g', { transform: `translate(${W},0)` });
    worldScene.append(layer[name], wrapGroups[name]);
  }
  scene.appendChild(worldScene);
  for (const c of GEO.countries) addFeature(c, layer, true);

  const statesScene = svgEl('g', { id: 'statesScene' });
  statesScene.appendChild(svgEl('path', { class: 'usbase', d: GEO.states.base }));
  for (const name of ['lands', 'pins', 'marks', 'labels']) {
    slayer[name] = svgEl('g');
    statesScene.appendChild(slayer[name]);
  }
  scene.appendChild(statesScene);
  for (const c of GEO.states.features) addFeature(c, slayer, false);
}

/** Creates every DOM node for one feature and registers it in `rec`. */
function addFeature(c, groups, allowWrap) {
  const wrapped = allowWrap && c.b[0] < WRAP_MAX_X && c.a < WRAP_MAX_AREA;
  const r = {
    c,
    lands: [], halos: [], pins: [], marks: [], labels: [],
    wrapped,
    marksGroup: groups.marks,
    labelsGroup: groups.labels,
    // Characteristic width in world units, which drives whether it needs a pin.
    span: Math.max(Math.sqrt(c.a), 0.5),
    state: 'out',
  };

  const path = svgEl('path', { d: c.d, class: 'land out' });
  path.dataset.id = c.id;
  groups.lands.appendChild(path);
  r.lands.push(path);
  addPin(r, groups.pins);

  if (wrapped) {
    const alt = path.cloneNode(false);
    wrapGroups.lands.appendChild(alt);
    r.lands.push(alt);
    addPin(r, wrapGroups.pins);
  }
  rec.set(c.id, r);
}

function clearMarks() {
  for (const g of [layer.marks, layer.labels, wrapGroups.marks, wrapGroups.labels,
    slayer.marks, slayer.labels]) g.textContent = '';
  for (const r of rec.values()) { r.marks.length = 0; r.labels.length = 0; }
  ringNode = null;
  hotId = null;
}

function addPin(r, group) {
  const [x, y] = r.c.l;
  const halo = svgEl('circle', { cx: x, cy: y, class: 'pin-halo hide' });
  const pin = svgEl('circle', { cx: x, cy: y, class: 'pin hide' });
  group.appendChild(halo);
  group.appendChild(pin);
  r.halos.push(halo);
  r.pins.push(pin);
}

/** Applies a class to every node representing a country. */
function setLandClass(id, cls, on) {
  const r = rec.get(id);
  if (!r) return;
  for (const n of r.lands) n.classList.toggle(cls, on);
  for (const n of r.pins) n.classList.toggle(cls, on);
}

/**
 * A flag stretched across the country's main landmass. The tile is anchored to
 * that landmass rather than the element's own bounding box, so a country split
 * at the antimeridian still shows a whole flag instead of one thin stripe;
 * outlying islands pick up a repeat of the same tile.
 */
function patternFor(id) {
  const pid = `fp-${id}`;
  if (!defs.querySelector(`#${pid}`)) {
    const [x0, y0, x1, y1] = BY_ID.get(id).m;
    const w = Math.max(x1 - x0, 1);
    const h = Math.max(y1 - y0, 1);
    const pat = svgEl('pattern', {
      id: pid,
      patternUnits: 'userSpaceOnUse',
      x: x0, y: y0, width: w, height: h,
    });
    // Content coordinates are relative to the tile, so the image starts at 0,0.
    pat.appendChild(svgEl('image', {
      x: 0, y: 0, width: w, height: h,
      preserveAspectRatio: 'none', href: flagURL(id),
    }));
    defs.appendChild(pat);
  }
  return `url(#${pid})`;
}

/** Puts a country into one of the visual states. */
function setCountryState(id, next, withMark = true) {
  const r = rec.get(id);
  if (!r) return;
  r.state = next;
  for (const n of r.lands) {
    n.classList.remove('out', 'todo', 'done', 'plain');
    n.style.fill = '';
  }
  for (const n of r.pins) n.classList.remove('done');
  if (next === 'out') {
    for (const n of r.lands) n.classList.add('out');
  } else if (next === 'todo') {
    for (const n of r.lands) n.classList.add('todo');
  } else if (next === 'done') {
    for (const n of r.lands) {
      n.classList.add('done');
      if (opts.flagFill) n.style.fill = patternFor(id);
      else { n.classList.add('plain'); n.style.setProperty('--cc', hueOf(r.c)); }
    }
    for (const n of r.pins) n.classList.add('done');
    if (withMark) addMark(r);
  }
}

/** Flag badge + name label pinned at the feature's anchor point. */
function addMark(r) {
  if (r.marks.length) return;
  const targets = [{ marks: r.marksGroup, labels: r.labelsGroup }];
  if (r.wrapped) targets.push(wrapGroups);

  for (const t of targets) {
    const g = svgEl('g');
    const badge = svgEl('image', {
      href: flagURL(r.c.id), x: -11, y: -8.5, width: 22, height: 17,
      preserveAspectRatio: 'none', class: 'badge-img',
    });
    const frame = svgEl('rect', {
      x: -11, y: -8.5, width: 22, height: 17, rx: 2, class: 'badge-frame',
    });
    g.appendChild(badge);
    g.appendChild(frame);
    t.marks.appendChild(g);
    r.marks.push(g);

    const label = svgEl('text', { class: 'clabel', y: 20 });
    label.textContent = r.c.n;
    const lg = svgEl('g');
    lg.appendChild(label);
    t.labels.appendChild(lg);
    r.labels.push(lg);
  }
  layoutMarks(r);
}

// ============================================================== view (svg)

const view = { x: 0, y: 0, w: W, h: H };
let rect = { left: 0, top: 0, width: 1, height: 1 };
let scale = 1; // screen px per world unit
let fitBox = GEO.fits.WORLD;

function measure() {
  rect = stage.getBoundingClientRect();
  fx.width = Math.round(rect.width * devicePixelRatio);
  fx.height = Math.round(rect.height * devicePixelRatio);
  fx.style.width = `${rect.width}px`;
  fx.style.height = `${rect.height}px`;
}

const toScreenX = (wx) => rect.left + ((wx - view.x) / view.w) * rect.width;
const toScreenY = (wy) => rect.top + ((wy - view.y) / view.h) * rect.height;
const toWorldX = (px) => view.x + ((px - rect.left) / rect.width) * view.w;
const toWorldY = (py) => view.y + ((py - rect.top) / rect.height) * view.h;

function fitTo(box, animate) {
  const aspect = rect.width / Math.max(rect.height, 1);
  const pad = 1.04;
  let w = (box[2] - box[0]) * pad;
  let h = (box[3] - box[1]) * pad;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  const target = {
    x: (box[0] + box[2]) / 2 - w / 2,
    y: (box[1] + box[3]) / 2 - h / 2,
    w, h,
  };
  if (animate) animateView(target); else { Object.assign(view, target); applyView(); }
}

let anim = null;
function animateView(target) {
  const from = { ...view };
  const t0 = performance.now();
  const dur = 520;
  if (anim) cancelAnimationFrame(anim);
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur);
    const k = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    // Interpolate in log space so the zoom feels linear.
    const ratio = target.w / from.w;
    const zoom = from.w * ratio ** k;
    view.w = zoom;
    view.h = (from.h / from.w) * zoom;
    view.x = from.x + (target.x + target.w / 2 - (from.x + from.w / 2)) * k - (view.w - from.w) / 2;
    view.y = from.y + (target.y + target.h / 2 - (from.y + from.h / 2)) * k - (view.h - from.h) / 2;
    applyView();
    if (t < 1) anim = requestAnimationFrame(step); else anim = null;
  };
  anim = requestAnimationFrame(step);
}

function clampView() {
  const minW = W / 900;
  const maxW = W * 1.35;
  view.w = clamp(view.w, minW, maxW);
  view.h = view.w * (rect.height / Math.max(rect.width, 1));
  const padX = view.w * 0.4;
  const padY = view.h * 0.4;
  view.x = clamp(view.x, -padX, W * 1.14 - view.w + padX);
  view.y = clamp(view.y, -padY, H - view.h + padY);
}

let viewQueued = false;
function applyView() {
  clampView();
  map.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  scale = rect.width / view.w;
  if (!viewQueued) {
    viewQueued = true;
    requestAnimationFrame(() => { viewQueued = false; updateScaleBound(); });
  }
}

/** Re-sizes everything that must stay a constant number of screen pixels. */
/**
 * How present a country's pin should be at the current zoom: 1 while the
 * country is too small to aim at, tapering to 0 once the shape itself is a
 * comfortable target. Fading rather than switching means zooming in never
 * makes a dot vanish out from under the cursor.
 */
function pinFade(r) {
  const t = (r.span * scale) / PIN_SHOW_PX;
  if (t <= 1) return 1;
  if (t >= PIN_FADE_TO) return 0;
  return 1 - (t - 1) / (PIN_FADE_TO - 1);
}

function updateScaleBound() {
  const root = document.documentElement;
  root.style.setProperty('--pinr', `${PIN_R_PX / scale}px`);
  const inv = 1 / scale;
  const inMenu = app.classList.contains('is-menu');
  for (const r of rec.values()) {
    const fade = inMenu || r.state === 'out' ? 0 : pinFade(r);
    const shown = fade > 0.02;
    for (const n of r.pins) {
      n.classList.toggle('hide', !shown);
      if (shown) n.style.opacity = fade * (r.state === 'done' ? 0.95 : 0.85);
    }
    // A soft halo makes an unplaced speck findable, but only for the genuine
    // specks - haloing every smallish country buries the map at world zoom.
    const tiny = clamp((10 - r.span * scale) / 6, 0, 1);
    const halo = shown && r.state !== 'done' && tiny > 0.02;
    for (const n of r.halos) {
      n.classList.toggle('hide', !halo);
      if (halo) n.style.opacity = fade * tiny * 0.18;
    }
    if (r.marks.length) layoutMarks(r, inv);
  }
}

function layoutMarks(r, inv) {
  const k = inv || 1 / scale;
  const [x, y] = r.c.l;
  const t = `translate(${x} ${y}) scale(${k})`;
  for (const g of r.marks) g.setAttribute('transform', t);
  // Only show the written name once the country itself is a decent size.
  const roomy = Math.sqrt(r.c.a) * scale > 52;
  for (const g of r.labels) {
    g.setAttribute('transform', t);
    g.style.display = roomy ? '' : 'none';
  }
}

// ============================================================ zoom and pan

function zoomAt(px, py, factor) {
  const wx = toWorldX(px);
  const wy = toWorldY(py);
  const before = view.w;
  view.w = clamp(view.w / factor, W / 900, W * 1.35);
  const k = view.w / before;
  view.h *= k;
  view.x = wx - (wx - view.x) * k;
  view.y = wy - (wy - view.y) * k;
  applyView();
}

stage.addEventListener('wheel', (e) => {
  if (app.classList.contains('is-menu')) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 400 : 1;
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0016));
}, { passive: false });

stage.addEventListener('dblclick', (e) => {
  if (app.classList.contains('is-menu')) return;
  zoomAt(e.clientX, e.clientY, 2.1);
});

$('#zoomPad').addEventListener('click', (e) => {
  const btn = e.target.closest('.zbtn');
  if (!btn) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  if (btn.dataset.zoom === 'in') zoomAt(cx, cy, 1.7);
  else if (btn.dataset.zoom === 'out') zoomAt(cx, cy, 1 / 1.7);
  else fitTo(fitBox, true);
});

// --- pointer handling: pan, pinch, drag-to-place, tap-to-place ---

const pointers = new Map();
let pan = null;
let pinch = null;

stage.addEventListener('pointerdown', (e) => {
  if (app.classList.contains('is-menu')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), w: view.w };
    pan = null;
    return;
  }
  if (drag) return;
  pan = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y, moved: false, id: e.pointerId };
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch.dist > 4) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      zoomAt(mx, my, (dist / pinch.dist) ** 0.9);
      pinch.dist = dist;
    }
    return;
  }
  if (!pan || drag) return;
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  if (!pan.moved && Math.hypot(dx, dy) < 5) return;
  pan.moved = true;
  stage.classList.add('is-panning');
  view.x = pan.ox - (dx / rect.width) * view.w;
  view.y = pan.oy - (dy / rect.height) * view.h;
  applyView();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pan && pan.id === e.pointerId) {
    const tapped = !pan.moved;
    pan = null;
    stage.classList.remove('is-panning');
    if (tapped) onStageTap(e.clientX, e.clientY);
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

// ============================================================ hit resolving

/** Which country would a drop at this screen point land on? */
function resolveTarget(px, py) {
  // Nearest visible pin, and how far away it is.
  let best = null;
  const pool = state.explore ? [...rec.values()] : state.remaining.map((id) => rec.get(id));
  for (const r of pool) {
    if (!r || r.state === 'out' || pinFade(r) <= 0.02) continue;
    const dy = toScreenY(r.c.l[1]) - py;
    const consider = (dx) => {
      const d = Math.hypot(dx, dy);
      if (d < PIN_HIT_PX && (!best || d < best.d)) best = { id: r.c.id, d };
    };
    consider(toScreenX(r.c.l[0]) - px);
    if (r.wrapped) consider(toScreenX(r.c.l[0] + W) - px);
  }

  // 1. Right on a pin: that dot is unambiguously what you were aiming at,
  //    even when it sits inside a bigger country (Vatican, Lesotho).
  if (best && best.d <= PIN_LOCK_PX) return best.id;

  // 2. The shape directly under the pointer. This has to beat a merely
  //    nearby pin, or dropping in the middle of Senegal would land on
  //    The Gambia.
  const direct = landAt(px, py);
  if (direct) return direct;

  // 3. A pin close by, with nothing solid under the pointer.
  if (best) return best.id;

  // 4. Otherwise sweep outwards, so being a few pixels into the sea or just
  //    outside a small border still counts as aiming at that country.
  for (const radius of PROBE_RADII) {
    for (let a = 0; a < 8; a++) {
      const t = (a / 8) * Math.PI * 2;
      const hit = landAt(px + Math.cos(t) * radius, py + Math.sin(t) * radius);
      if (hit) return hit;
    }
  }
  return null;
}

function landAt(px, py) {
  if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) return null;
  const node = document.elementFromPoint(px, py);
  const id = node && node.dataset ? node.dataset.id : null;
  if (!id) return null;
  if (state.explore) return id;
  return state.remaining.includes(id) ? id : null;
}

// ================================================================== hover

let hotId = null;
let ringNode = null;

function setHot(id) {
  if (hotId === id) return;
  if (hotId) setLandClass(hotId, 'hot', false);
  hotId = id;
  if (ringNode) { ringNode.remove(); ringNode = null; }
  if (!id) return;
  setLandClass(id, 'hot', true);
  const r = rec.get(id);
  if (pinFade(r) > 0.02) {
    ringNode = svgEl('circle', {
      cx: r.c.l[0], cy: r.c.l[1], r: 15 / scale, class: 'ring',
    });
    r.marksGroup.appendChild(ringNode);
  }
}

// =================================================================== loupe

function showLoupe(px, py) {
  if (!opts.loupe) { hideLoupe(); return; }
  const size = loupe.offsetWidth || 154;

  // Show a fixed slice of the world, capped so the magnifier never becomes a
  // blurry close-up of one country's interior. When you are already zoomed in
  // far enough that it would show nothing new, it gets out of the way.
  const rawSpan = size / scale;
  const span = Math.max(rawSpan / LOUPE_MAX_MAG, LOUPE_MIN_SPAN);
  const mag = rawSpan / span;
  if (mag < LOUPE_MIN_MAG) { hideLoupe(); return; }

  const cx = toWorldX(px);
  const cy = toWorldY(py);
  loupeSvg.setAttribute('viewBox', `${cx - span / 2} ${cy - span / 2} ${span} ${span}`);
  // Hold the pins at their normal on-screen size inside the lens. Magnifying
  // them along with the map would keep a cluster exactly as crowded as before,
  // which is the one thing the lens exists to fix.
  loupeUse.style.setProperty('--pinr', `${PIN_R_PX / (scale * mag)}px`);

  // Up and to the left of the pointer; the dragged card sits down and right.
  let lx = px - rect.left - size - 14;
  let ly = py - rect.top - size - 14;
  if (lx < 8) lx = px - rect.left + 14;
  if (ly < 8) ly = py - rect.top + 14;
  loupe.style.left = `${clamp(lx, 8, rect.width - size - 8)}px`;
  loupe.style.top = `${clamp(ly, 8, rect.height - size - 8)}px`;
  loupe.hidden = false;
}
const hideLoupe = () => { loupe.hidden = true; };

// ==================================================================== drag

let drag = null;

function beginDrag(id, chip, e) {
  drag = { id, chip, pointerId: e.pointerId, moved: false, start: [e.clientX, e.clientY] };
  ghost.textContent = '';
  const clone = chip.cloneNode(true);
  clone.classList.remove('sel', 'queued');
  delete clone.dataset.chip;
  ghost.appendChild(clone);
  ghost.hidden = false;
  moveGhost(e.clientX, e.clientY);
  chip.setPointerCapture(e.pointerId);
}

/**
 * The dragged card trails below and right of the pointer instead of sitting
 * under it, so the crosshair and the spot you are aiming at stay visible.
 */
function moveGhost(px, py) {
  const gw = ghost.offsetWidth;
  const gh = ghost.offsetHeight;
  let x = px - rect.left + GHOST_GAP;
  let y = py - rect.top + GHOST_GAP;
  if (x + gw > rect.width - 8) x = px - rect.left - GHOST_GAP - gw;
  if (y + gh > rect.height - 8) y = py - rect.top - GHOST_GAP - gh;
  ghost.style.transform = `translate(${clamp(x, 8, Math.max(8, rect.width - gw - 8))}px, ${clamp(y, 8, Math.max(8, rect.height - gh - 8))}px)`;
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.start[0], e.clientY - drag.start[1]) < 6) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.chip.classList.add('dragging');
    stage.classList.add('is-dragging');
  }
  e.preventDefault();
  moveGhost(e.clientX, e.clientY);
  const over = e.clientY > rect.top && e.clientY < rect.bottom;
  if (over) {
    const target = resolveTarget(e.clientX, e.clientY);
    setHot(target);
    ghost.classList.toggle('snap', !!target);
    showLoupe(e.clientX, e.clientY);
  } else {
    setHot(null);
    ghost.classList.remove('snap');
    hideLoupe();
  }
}

function onDragEnd(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  ghost.hidden = true;
  ghost.textContent = '';
  ghost.classList.remove('snap');
  hideLoupe();
  stage.classList.remove('is-dragging');
  d.chip.classList.remove('dragging');
  setHot(null);

  if (!d.moved) {
    selectChip(state.selected === d.id ? null : d.id);
    return;
  }
  if (e.clientY <= rect.top || e.clientY >= rect.bottom) return;
  const target = resolveTarget(e.clientX, e.clientY);
  submit(d.id, target, e.clientX, e.clientY);
}

window.addEventListener('pointermove', onDragMove, { passive: false });
window.addEventListener('pointerup', onDragEnd);
window.addEventListener('pointercancel', onDragEnd);

function onStageTap(px, py) {
  const target = resolveTarget(px, py);
  if (state.explore) {
    showInfo(target);
    return;
  }
  if (!state.playing || !state.selected) return;
  submit(state.selected, target, px, py, true);
}

// ================================================================ the game

function poolFor(region) {
  if (region === 'USA') {
    return GEO.states.features.filter((c) => opts.territories || !c.t).map((c) => c.id);
  }
  const all = GEO.countries.filter((c) => opts.territories || !c.t);
  if (region === 'WORLD') return all.map((c) => c.id);
  if (region === 'TINY') {
    return all.slice().sort((a, b) => a.a - b.a).slice(0, 45).map((c) => c.id);
  }
  if (region === 'TROUBLE') {
    return all
      .filter((c) => isTrouble(c.id))
      .sort((a, b) => weakness(b.id) - weakness(a.id))
      .slice(0, 40)
      .map((c) => c.id);
  }
  return all.filter((c) => c.c === region).map((c) => c.id);
}

function weakness(id) {
  const p = store.prog[id] || { b: 0, r: 0, w: 0 };
  return p.w * 2 - p.b;
}

const isStatesRegion = (region) => region === 'USA';
const fitBoxFor = (region) => (isStatesRegion(region) ? GEO.states.fit : (GEO.fits[region] || GEO.fits.WORLD));
// Shows the US states in place of the world.
const setStatesMode = (on) => app.classList.toggle('states', on);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startGame(customPool) {
  state.explore = false;
  state.playing = true;
  state.paused = false;
  state.pool = customPool || poolFor(state.region);
  if (!state.pool.length) return;
  setStatesMode(isStatesRegion(state.region));
  // Weakest first when drilling; otherwise mix it up.
  state.remaining = state.region === 'TROUBLE' && !customPool
    ? state.pool.slice()
    : shuffle(state.pool);
  state.solved = new Set();
  state.missed = new Map();
  state.hinted = new Set();
  state.selected = null;
  state.score = 0;
  state.streak = 0;
  state.bestStreak = 0;
  state.lives = 3;
  state.attempts = 0;
  state.hits = 0;
  state.hintLevel = 0;
  state.hintFor = null;
  state.startedAt = performance.now();
  state.placedAt = performance.now();

  const seconds = clamp(Math.round(state.pool.length * 4), 60, 420);
  state.timeLeft = seconds;
  state.endsAt = performance.now() + seconds * 1000;

  clearMarks();
  const poolSet = new Set(state.pool);
  for (const id of rec.keys()) setCountryState(id, poolSet.has(id) ? 'todo' : 'out');

  app.classList.remove('is-menu', 'is-explore');
  $('#menu').hidden = true;
  $('#results').hidden = true;
  $('#searchWrap').hidden = true;
  $('#btnHint').disabled = false;
  $('#btnSkip').disabled = false;

  fitBox = fitBoxFor(state.region);
  measure();
  fitTo(fitBox, false);
  renderTray();
  updateHud();
  tickLoop();
  explainPins();
}

// The dots are the one part of the map that isn't self-explanatory, so say
// what they are the first time a round actually has some.
let pinsExplained = false;
function explainPins() {
  if (pinsExplained) return;
  if (state.remaining.filter((id) => pinFade(rec.get(id)) > 0.9).length < 3) return;
  pinsExplained = true;
  const noun = isStatesRegion(state.region) ? 'states' : 'countries';
  setTimeout(() => {
    if (state.playing) {
      toast(`Dots stand in for ${noun} too small to click — drop right on the dot. They fade away as you zoom in.`, '');
    }
  }, 700);
}

function submit(chipId, targetId, px, py, fromTap) {
  if (!state.playing || state.paused) return;
  if (!targetId) {
    toast('Aim a little closer to a country', 'bad');
    return;
  }
  state.attempts++;
  const now = performance.now();
  const seconds = (now - state.placedAt) / 1000;
  state.placedAt = now;

  if (targetId === chipId) {
    onCorrect(chipId, seconds, px, py, fromTap);
  } else {
    onWrong(chipId, targetId, px, py);
  }
  updateHud();
  if (!state.remaining.length) finish('cleared');
}

function onCorrect(id, seconds, px, py, fromTap) {
  const c = BY_ID.get(id);
  state.hits++;
  state.streak++;
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  state.solved.add(id);
  state.remaining = state.remaining.filter((x) => x !== id);

  const fast = seconds < 2.5 ? 60 : seconds < 5 ? 30 : 0;
  const mult = Math.min(1 + state.streak * 0.1, 3);
  const penalty = state.hinted.has(id) ? 0.4 : 1;
  state.score += Math.round((100 + fast) * mult * penalty);

  if (!state.hinted.has(id)) {
    const p = progOf(id);
    p.r++;
    p.b = Math.min(5, p.b + 1);
    saveStore();
  }

  setCountryState(id, 'done');
  updateScaleBound();
  sparkle(px, py, hueOf(c));
  sfx('good');
  toast(`<img src="${flagURL(id)}" alt=""> <b>${c.n}</b> — nailed it`, 'good');
  if (state.streak >= 3 && state.streak % 3 === 0) {
    banner(`${state.streak} in a row!`);
    sfx('streak');
  }
  const chip = trayInner.querySelector(`[data-chip="${id}"]`);
  if (chip) {
    chip.classList.add('gone');
    setTimeout(renderTray, 240);
  } else renderTray();
  // In tap-to-place, hand the player straight to the next card so they can
  // keep tapping the map without going back to the deck each time.
  if (fromTap && state.remaining.length) {
    selectChip(state.remaining[0]);
  } else if (state.selected === id) {
    state.selected = null;
  }
  state.hintLevel = 0;
  state.hintFor = null;
}

function onWrong(id, targetId, px, py) {
  const c = BY_ID.get(id);
  state.streak = 0;
  state.missed.set(id, (state.missed.get(id) || 0) + 1);
  const p = progOf(id);
  p.w++;
  p.b = Math.max(0, p.b - 1);
  saveStore();
  state.score = Math.max(0, state.score - 25);

  sfx('bad');
  flash(targetId, 'miss', 620);
  if (opts.revealOnMiss) {
    flash(id, 'reveal', 1100);
    pulseAt(id);
  }
  const wrongName = BY_ID.get(targetId) ? BY_ID.get(targetId).n : 'the sea';
  toast(`That's ${wrongName}. <b>${c.n}</b> is highlighted.`, 'bad');
  const chip = trayInner.querySelector(`[data-chip="${id}"]`);
  if (chip) {
    chip.classList.remove('shake');
    void chip.offsetWidth;
    chip.classList.add('shake');
  }
  if (state.gameMode === 'survival') {
    state.lives--;
    if (state.lives <= 0) { updateHud(); finish('out of lives'); }
  }
}

function flash(id, cls, ms) {
  if (!id || !rec.has(id)) return;
  setLandClass(id, cls, true);
  setTimeout(() => setLandClass(id, cls, false), ms);
}

function pulseAt(id, radiusPx) {
  const r = rec.get(id);
  if (!r) return;
  const ring = svgEl('circle', {
    cx: r.c.l[0], cy: r.c.l[1],
    r: (radiusPx || 46) / scale,
    class: 'ring pulse',
  });
  r.marksGroup.appendChild(ring);
  setTimeout(() => ring.remove(), 1100);
}

function skipCurrent() {
  if (!state.playing || state.remaining.length < 2) return;
  const id = state.selected || state.remaining[0];
  state.remaining = state.remaining.filter((x) => x !== id).concat(id);
  state.selected = null;
  state.hintLevel = 0;
  renderTray();
}

function useHint() {
  if (!state.playing) return;
  const id = state.selected || state.remaining[0];
  if (!id) return;
  if (state.hintFor !== id) { state.hintFor = id; state.hintLevel = 0; }
  state.hintLevel++;
  state.hinted.add(id);
  state.score = Math.max(0, state.score - 20);
  const c = BY_ID.get(id);

  if (state.hintLevel === 1) {
    toast(`<b>${c.n}</b> is in ${c.s}${c.cap ? ` · capital ${c.cap}` : ''}`, '');
    pulseAt(id, 190);
  } else if (state.hintLevel === 2) {
    pulseAt(id, 90);
    toast(`Getting warmer — it's right around here`, '');
  } else {
    flash(id, 'reveal', 1400);
    pulseAt(id, 46);
    toast(`There it is: <b>${c.n}</b>`, '');
  }
  updateHud();
}

function finish(reason) {
  if (!state.playing) return;
  state.playing = false;
  state.selected = null;
  const elapsed = Math.round((performance.now() - state.startedAt) / 1000);
  const total = state.pool.length;
  const done = state.solved.size;
  const acc = state.attempts ? Math.round((state.hits / state.attempts) * 100) : 0;
  const cleared = done === total;

  const bestKey = `${state.region}|${state.gameMode}|${state.chipMode}`;
  const prevBest = store.best[bestKey] || 0;
  const newBest = state.score > prevBest;
  if (newBest) { store.best[bestKey] = state.score; saveStore(); }

  if (cleared) { confetti(); sfx('win'); }

  const clearedTitle = isStatesRegion(state.region) ? '🎉 Every state placed!'
    : state.region in CONTINENTS ? '🎉 Continent cleared!'
      : '🎉 Cleared!';
  const head = $('#resultHead');
  head.innerHTML = `
    <div class="rtitle">${cleared ? clearedTitle : reason === 'time' ? "⏱ Time's up" : '💔 Out of lives'}</div>
    <div class="rsub">${regionLabel(state.region)} · ${CHIP_MODES[state.chipMode].title} · ${GAME_MODES[state.gameMode].title}</div>
    ${newBest ? '<div class="newbest">★ NEW PERSONAL BEST</div>' : ''}`;

  $('#resultStats').innerHTML = [
    ['Score', fmt.format(state.score)],
    ['Placed', `${done}/${total}`],
    ['Accuracy', `${acc}%`],
    ['Best streak', state.bestStreak],
    ['Time', `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`],
  ].map(([l, v]) => `<div class="stat"><div class="sv">${v}</div><div class="sl">${l}</div></div>`).join('');

  const misses = [...state.missed.keys()].concat(state.remaining.filter((id) => !state.missed.has(id)));
  const missBox = $('#resultMisses');
  if (misses.length) {
    missBox.innerHTML = `<h3>Worth another look (${misses.length})</h3><div class="miss-grid">${
      misses.map((id) => `<div class="miss"><img src="${flagURL(id)}" alt=""><span>${BY_ID.get(id).n}</span></div>`).join('')
    }</div>`;
    $('#btnDrill').hidden = false;
    $('#btnDrill').onclick = () => startGame(shuffle(misses));
  } else {
    missBox.innerHTML = '<h3>Flawless — not a single miss 🏆</h3>';
    $('#btnDrill').hidden = true;
  }
  $('#results').hidden = false;
}

// ==================================================================== tray

function renderTray() {
  trayInner.innerHTML = '';
  const shown = state.remaining.slice(0, TRAY_SIZE);
  for (let i = 0; i < shown.length; i++) {
    trayInner.appendChild(makeChip(shown[i], i > 0));
  }
  if (!shown.length) trayInner.innerHTML = '<div style="color:var(--ink-faint);padding:0 14px">All placed!</div>';
  $('#btnSkip').disabled = state.remaining.length < 2;
}

function makeChip(id, queued) {
  const c = BY_ID.get(id);
  const chip = el('div', `chip mode-${state.chipMode}${queued ? ' queued' : ''}`);
  chip.dataset.chip = id;
  if (state.chipMode !== 'name') {
    // Hide the printed name only when the flag alone is the question.
    const src = (c.hn && state.chipMode === 'flag') ? flagURLNameHidden(id) : flagURL(id);
    chip.appendChild(flagImg(id, null, src));
  }
  if (state.chipMode !== 'flag') {
    const box = el('div');
    const name = el('div', 'cname');
    name.textContent = c.n;
    box.appendChild(name);
    if (state.chipMode === 'both') {
      const sub = el('div', 'csub');
      sub.textContent = c.s;
      box.appendChild(sub);
    }
    chip.appendChild(box);
  }
  if (state.selected === id) chip.classList.add('sel');
  chip.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    e.preventDefault();
    beginDrag(id, chip, e);
  });
  return chip;
}

function selectChip(id) {
  state.selected = id;
  for (const chip of trayInner.children) {
    if (chip.classList) chip.classList.toggle('sel', chip.dataset.chip === id);
  }
}

// ===================================================================== hud

function regionLabel(region) {
  if (region === 'WORLD') return 'The whole world';
  if (region === 'USA') return 'US states';
  if (region === 'TINY') return 'Tiny nations';
  if (region === 'TROUBLE') return 'Trouble spots';
  return CONTINENTS[region] ? CONTINENTS[region].name : region;
}

function regionIcon(region) {
  if (region in CONTINENTS) return CONTINENTS[region].icon;
  return { USA: '🇺🇸', TINY: '🔬', TROUBLE: '🎯' }[region] || '🌍';
}

function updateHud() {
  const done = state.solved.size;
  const total = state.pool.length;
  $('#hudRegion').innerHTML = `${regionIcon(state.region)} <b>${regionLabel(state.region)}</b>`;
  $('#hudProgress').innerHTML = `<b>${done}</b> / ${total}`;
  $('#hudScore').innerHTML = `Score <b>${fmt.format(state.score)}</b>${state.streak > 1 ? ` · 🔥${state.streak}` : ''}`;
  const timer = $('#hudTimer');
  timer.hidden = state.gameMode !== 'rush';
  if (state.gameMode === 'rush') {
    const t = Math.max(0, Math.ceil(state.timeLeft));
    timer.innerHTML = `<b>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</b>`;
    timer.classList.toggle('low', t <= 15);
  }
  const lives = $('#hudLives');
  lives.hidden = state.gameMode !== 'survival';
  if (state.gameMode === 'survival') lives.innerHTML = '❤️'.repeat(Math.max(0, state.lives)) || '💀';
}

function tickLoop() {
  if (!state.playing) return;
  if (state.gameMode === 'rush' && !state.paused) {
    state.timeLeft = (state.endsAt - performance.now()) / 1000;
    updateHud();
    if (state.timeLeft <= 0) { finish('time'); return; }
  }
  setTimeout(tickLoop, 200);
}

let toastTimer = 0;
function toast(html, kind) {
  const t = $('#toast');
  t.className = kind || '';
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

function banner(text) {
  const b = $('#streakBadge');
  b.textContent = text;
  b.hidden = false;
  b.style.animation = 'none';
  void b.offsetWidth;
  b.style.animation = '';
  setTimeout(() => { b.hidden = true; }, 950);
}

// ================================================================== effects

const ctx = fx.getContext('2d');
let particles = [];
let fxRunning = false;

function fxLoop() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, fx.width, fx.height);
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.life -= 1;
    p.vy += p.g;
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.99;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 30));
    ctx.fillStyle = p.color;
    if (p.rect) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.life * 0.15);
      ctx.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 7);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  if (particles.length) requestAnimationFrame(fxLoop);
  else fxRunning = false;
}
function runFx() {
  if (!fxRunning) { fxRunning = true; requestAnimationFrame(fxLoop); }
}

function sparkle(px, py, color) {
  const x = px - rect.left;
  const y = py - rect.top;
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1.5 + Math.random() * 4.5;
    particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5,
      g: 0.14, r: 1.5 + Math.random() * 2.5, life: 30 + Math.random() * 22,
      color: Math.random() < 0.4 ? '#ffffff' : color,
    });
  }
  runFx();
}

function confetti() {
  const colors = ['#4fd1c5', '#7aa2f7', '#ffd166', '#ff8f7a', '#c792ea', '#5fd39a'];
  for (let i = 0; i < 180; i++) {
    particles.push({
      x: Math.random() * rect.width,
      y: -20 - Math.random() * 200,
      vx: (Math.random() - 0.5) * 3,
      vy: 2 + Math.random() * 4,
      g: 0.08,
      r: 3 + Math.random() * 4,
      life: 130 + Math.random() * 90,
      rect: true,
      color: colors[i % colors.length],
    });
  }
  runFx();
}

// ==================================================================== audio

let audio = null;
function sfx(kind) {
  if (!opts.sound) return;
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { return; }
  const notes = {
    good: [[660, 0, 0.09], [990, 0.07, 0.13]],
    bad: [[190, 0, 0.16], [140, 0.06, 0.2]],
    streak: [[660, 0, 0.08], [880, 0.06, 0.08], [1170, 0.12, 0.16]],
    win: [[523, 0, 0.12], [659, 0.11, 0.12], [784, 0.22, 0.12], [1046, 0.33, 0.34]],
    tick: [[440, 0, 0.05]],
  }[kind] || [];
  for (const [freq, delay, dur] of notes) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = kind === 'bad' ? 'sawtooth' : 'triangle';
    osc.frequency.value = freq;
    const t0 = audio.currentTime + delay;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(kind === 'bad' ? 0.06 : 0.11, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

// ================================================================== explore

function startExplore() {
  state.playing = false;
  state.explore = true;
  state.pool = GEO.countries.filter((c) => opts.territories || !c.t).map((c) => c.id);
  clearMarks();
  setStatesMode(false);
  const poolSet = new Set(state.pool);
  for (const id of rec.keys()) {
    setCountryState(id, poolSet.has(id) ? (isMastered(id) ? 'done' : 'todo') : 'out', false);
  }
  app.classList.remove('is-menu');
  app.classList.add('is-explore');
  $('#menu').hidden = true;
  $('#results').hidden = true;
  $('#searchWrap').hidden = false;
  $('#btnHint').disabled = true;
  $('#btnSkip').disabled = true;
  fitBox = GEO.fits.WORLD;
  measure();
  fitTo(fitBox, false);
  toast('Tap any country to learn about it', '');
}

function showInfo(id) {
  const card = $('#infoCard');
  if (!id) { card.hidden = true; return; }
  const c = BY_ID.get(id);
  const p = store.prog[id] || { b: 0, r: 0, w: 0 };
  const neighbours = c.nb.map((n) => BY_ID.get(n)).filter(Boolean);
  card.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <img class="big" src="${flagURL(id)}" alt="Flag of ${c.n}">
    <h3>${c.n}</h3>
    <div class="off">${c.o}</div>
    <dl>
      <dt>Capital</dt><dd>${c.cap || '—'}</dd>
      <dt>Region</dt><dd>${c.s}</dd>
      <dt>Population</dt><dd>${c.pop ? fmt.format(c.pop) : '—'}</dd>
      <dt>Area</dt><dd>${fmt.format(c.km)} km²</dd>
      <dt>Your record</dt><dd>${p.r}✓ / ${p.w}✗${isMastered(id) ? ' 🏅' : ''}</dd>
    </dl>
    ${neighbours.length ? `<div class="nbs">${neighbours.map((n) => `<span>${n.n}</span>`).join('')}</div>`
      : '<div class="nbs"><span>No land borders</span></div>'}`;
  card.hidden = false;
  card.querySelector('.close').onclick = () => { card.hidden = true; };
  flyTo(id);
}

function flyTo(id) {
  const c = BY_ID.get(id);
  const span = Math.max(c.b[2] - c.b[0], c.b[3] - c.b[1]);
  const pad = Math.max(span * 0.35, 700);
  fitTo([c.b[0] - pad, c.b[1] - pad, c.b[2] + pad, c.b[3] + pad], true);
}

// --- search ---
const search = $('#search');
const searchResults = $('#searchResults');
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  if (q.length < 2) { searchResults.classList.remove('show'); return; }
  const hits = GEO.countries
    .filter((c) => (opts.territories || !c.t) && (c.n.toLowerCase().includes(q) || c.o.toLowerCase().includes(q) || (c.cap || '').toLowerCase().includes(q)))
    .slice(0, 12);
  searchResults.innerHTML = hits.map((c) =>
    `<button data-go="${c.id}"><img src="${flagURL(c.id)}" alt=""><span>${c.n}</span></button>`).join('')
    || '<button disabled style="color:var(--ink-faint)">No match</button>';
  searchResults.classList.add('show');
});
searchResults.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-go]');
  if (!btn) return;
  searchResults.classList.remove('show');
  search.value = '';
  showInfo(btn.dataset.go);
});
search.addEventListener('blur', () => setTimeout(() => searchResults.classList.remove('show'), 180));

// ===================================================================== menu

function openMenu() {
  state.playing = false;
  state.explore = false;
  app.classList.add('is-menu');
  app.classList.remove('is-explore');
  $('#menu').hidden = false;
  $('#results').hidden = true;
  $('#infoCard').hidden = true;
  $('#toast').hidden = true;
  paintMenuBackdrop();
  renderMenu();
  measure();
  fitTo(fitBox, true);
}

// The map behind the menu doubles as a trophy cabinet: everything you have
// mastered is already flying its flag. It previews whichever universe the
// selected region belongs to, so choosing "US States" shows the US filling in.
function paintMenuBackdrop() {
  const states = isStatesRegion(state.region);
  setStatesMode(states);
  clearMarks();
  for (const c of (states ? GEO.states.features : GEO.countries)) {
    if (c.t && !opts.territories) setCountryState(c.id, 'out');
    else setCountryState(c.id, isMastered(c.id) ? 'done' : 'todo', false);
  }
  fitBox = states ? GEO.states.fit : GEO.fits.WORLD;
}

const REGION_LIST = [
  ['WORLD', '🌍', 'The whole world', '#4fd1c5'],
  ...Object.entries(CONTINENTS).map(([k, v]) => [k, v.icon, v.name, v.hue]),
  ['USA', '🇺🇸', 'US states', '#6c8cff'],
  ['TINY', '🔬', 'Tiny nations', '#ffd166'],
  ['TROUBLE', '🎯', 'Trouble spots', '#ff6b7a'],
];

function renderMenu() {
  const grid = $('#regionGrid');
  grid.innerHTML = '';
  for (const [key, icon, name, hue] of REGION_LIST) {
    const ids = poolFor(key);
    const card = el('button', `rcard${state.region === key ? ' sel' : ''}${!ids.length ? ' disabled' : ''}`);
    card.style.setProperty('--rc', hue);
    // Partial credit: one clean placement is a third of the way to mastered,
    // so a good round always moves the bar.
    const boxes = ids.reduce((sum, id) => sum + Math.min(store.prog[id]?.b || 0, MASTER_BOX), 0);
    const pct = ids.length ? Math.round((boxes / (ids.length * MASTER_BOX)) * 100) : 0;
    const empty = key === 'TROUBLE' ? 'Nothing to fix — nice' : 'Play a round first';
    const noun = key === 'USA' ? 'states' : 'places';
    card.innerHTML = `
      <div class="rname">${icon} ${name}</div>
      <div class="rmeta">${ids.length ? `${ids.length} ${noun} · ${pct}% learned` : empty}</div>
      <div class="rbar"><i style="width:${pct}%"></i></div>`;
    card.onclick = () => { state.region = key; renderMenu(); paintMenuBackdrop(); fitTo(fitBox, true); };
    grid.appendChild(card);
  }

  renderOpts($('#chipModes'), CHIP_MODES, 'chipMode');
  renderOpts($('#gameModes'), GAME_MODES, 'gameMode');

  const toggles = $('#toggles');
  toggles.innerHTML = '';
  const defs2 = [
    ['flagFill', '🎨 Fill solved countries with their flag'],
    ['revealOnMiss', '👀 Show me the answer when I miss'],
    ['loupe', '🔍 Magnifier while dragging'],
    ['territories', '🏝 Include territories & dependencies'],
    ['sound', '🔊 Sound effects'],
  ];
  for (const [key, label] of defs2) {
    const b = el('button', `tgl${opts[key] ? ' on' : ''}`);
    b.textContent = label;
    b.onclick = () => {
      opts[key] = !opts[key];
      store.opts = opts;
      saveStore();
      renderMenu();
      syncButtons();
    };
    toggles.appendChild(b);
  }

  const ids = poolFor(state.region);
  const key = `${state.region}|${state.gameMode}|${state.chipMode}`;
  const best = store.best[key];
  $('#startSub').textContent =
    `${ids.length} ${isStatesRegion(state.region) ? 'states' : 'countries'}${best ? ` · best ${fmt.format(best)}` : ''}`;
  $('#btnStart').disabled = !ids.length;
  $('#totalCount').textContent = GEO.countries.filter((c) => !c.t).length;
}

function renderOpts(host, table, stateKey) {
  host.innerHTML = '';
  for (const [key, info] of Object.entries(table)) {
    const b = el('button', `opt${state[stateKey] === key ? ' sel' : ''}`);
    b.innerHTML = `<div class="oico">${info.icon}</div>
      <div><div class="otitle">${info.title}</div><div class="odesc">${info.desc}</div></div>`;
    b.onclick = () => { state[stateKey] = key; renderMenu(); };
    host.appendChild(b);
  }
}

function syncButtons() {
  $('#btnSound').classList.toggle('is-on', opts.sound);
  $('#btnLoupe').classList.toggle('is-on', opts.loupe);
}

// ================================================================== wiring

$('#btnStart').onclick = () => startGame();
$('#btnExplore').onclick = startExplore;
$('#btnMenu').onclick = openMenu;
$('#btnAgain').onclick = () => startGame();
$('#btnBackMenu').onclick = openMenu;
$('#btnHint').onclick = useHint;
$('#btnSkip').onclick = skipCurrent;
$('#btnSound').onclick = () => { opts.sound = !opts.sound; store.opts = opts; saveStore(); syncButtons(); sfx('tick'); };
$('#btnLoupe').onclick = () => { opts.loupe = !opts.loupe; store.opts = opts; saveStore(); syncButtons(); };
$('#btnReset').onclick = () => {
  if (!confirm('Erase all progress and personal bests?')) return;
  store.prog = {};
  store.best = {};
  saveStore();
  renderMenu();
};
$('#pauseVeil').onclick = () => {
  state.paused = false;
  state.endsAt = performance.now() + state.timeLeft * 1000;
  $('#pauseVeil').hidden = true;
};

document.addEventListener('keydown', (e) => {
  // Study runs its own keyboard handling and covers the whole screen.
  if (!$('#study').hidden || !$('#studySetup').hidden) return;
  if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') e.target.blur(); return; }
  const k = e.key.toLowerCase();
  if (k === 'escape') openMenu();
  else if (k === 'h') useHint();
  else if (k === 's') skipCurrent();
  else if (k === 'm') $('#btnSound').click();
  else if (k === 'l') $('#btnLoupe').click();
  else if (k === '0') fitTo(fitBox, true);
  else if (k === '+' || k === '=') zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.7);
  else if (k === '-') zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.7);
  else if (k === 'p' && state.playing && state.gameMode === 'rush') {
    state.paused = true;
    $('#pauseVeil').hidden = false;
  } else return;
  e.preventDefault();
});

let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    measure();
    view.h = view.w * (rect.height / rect.width);
    view.x = cx - view.w / 2;
    view.y = cy - view.h / 2;
    applyView();
  }, 120);
});
addEventListener('scroll', measure, true);

// ==================================================================== study
//
// A Quizlet-style deck for learning flags, countries and capitals before you
// go place them on the map. You pick a prompt facet and an answer facet
// (flag / country / capital) and a format: multiple choice, typing, matching,
// or an adaptive "Learn" that repeats what you miss and steps up from
// multiple choice to typing.

const FACETS = {
  flag: { icon: '🏳️', label: 'Flag' },
  name: { icon: '🗺️', label: 'Country' },
  cap: { icon: '🏛️', label: 'Capital' },
};

const STUDY_FORMATS = {
  learn: { icon: '🎓', title: 'Learn', desc: 'Adaptive — repeats what you miss until it sticks.' },
  mc: { icon: '🔤', title: 'Multiple choice', desc: 'Pick the right answer from four.' },
  type: { icon: '⌨️', title: 'Type it', desc: 'Spell the answer out. Accents and case are forgiven.' },
  match: { icon: '🧩', title: 'Match', desc: 'Tap the pairs as fast as you can.' },
};

// Extra spellings accepted when typing, keyed by feature id.
const ALIASES = {
  US: ['usa', 'us', 'united states of america', 'america'],
  GB: ['uk', 'britain', 'great britain'],
  AE: ['uae'],
  KR: ['south korea', 'korea'], KP: ['north korea'],
  CD: ['drc', 'congo kinshasa', 'democratic republic of congo'],
  CG: ['congo', 'congo brazzaville'],
  CZ: ['czech republic'], CI: ['ivory coast', "cote d'ivoire"],
  TL: ['east timor'], CV: ['cape verde'], SZ: ['swaziland'], MM: ['burma'],
  MK: ['macedonia'], NL: ['holland'], RU: ['russian federation'],
  LA: ['lao'], VA: ['holy see', 'vatican'], TR: ['turkey'], VN: ['viet nam'],
  'US-DC': ['dc', 'washington dc'],
};

const MATCH_PER_BOARD = 6;

const study = {
  prompt: 'flag',
  answer: 'name',
  format: 'learn',
  items: [],
  order: [],
  box: new Map(),
  need: 1,
  queue: [],
  i: 0,
  correct: 0,
  wrong: 0,
  answered: 0,
  total: 0,
  missed: new Map(),
  locked: false,
  keyHandler: null,
  // match
  boards: [],
  boardIdx: 0,
  sel: null,
  matchMistakes: 0,
  startedAt: 0,
};

const nameNoun = () => (isStatesRegion(state.region) ? 'state' : 'country');

/** Normalises a typed answer: fold accents, unify punctuation and spacing. */
function norm(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(st|ste)\b\.?/g, 'saint')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const studyFlag = (id) => (BY_ID.get(id).hn ? flagURLNameHidden(id) : flagURL(id));
const facetText = (c, facet) => (facet === 'cap' ? c.cap : c.n);

/** Strings that count as a correct typed answer for this item. */
function acceptable(id) {
  const c = BY_ID.get(id);
  const set = study.answer === 'cap' ? [c.cap] : [c.n, c.o, ...(ALIASES[id] || [])];
  return set.filter(Boolean).map(norm);
}

// -------------------------------------------------------------- study setup

function openStudySetup() {
  $('#menu').hidden = true;
  $('#study').hidden = true;
  $('#studySetup').hidden = false;
  if (study.answer === study.prompt) study.answer = study.prompt === 'name' ? 'cap' : 'name';
  renderStudySetup();
}

function renderStudySetup() {
  // region cards (reuse the map's set and progress bars)
  const grid = $('#studyRegion');
  grid.innerHTML = '';
  for (const [key, icon, name, hue] of REGION_LIST) {
    const ids = poolFor(key);
    const card = el('button', `rcard${state.region === key ? ' sel' : ''}${!ids.length ? ' disabled' : ''}`);
    card.style.setProperty('--rc', hue);
    const noun = key === 'USA' ? 'states' : 'places';
    card.innerHTML = `<div class="rname">${icon} ${name}</div>
      <div class="rmeta">${ids.length ? `${ids.length} ${noun}` : 'Nothing here yet'}</div>`;
    card.onclick = () => { state.region = key; renderStudySetup(); };
    grid.appendChild(card);
  }

  const nounCap = isStatesRegion(state.region) ? 'State' : 'Country';
  renderFacetRow('#studyPrompt', 'prompt', nounCap);
  renderFacetRow('#studyAnswer', 'answer', nounCap);

  const fmt = $('#studyFormat');
  fmt.innerHTML = '';
  for (const [key, info] of Object.entries(STUDY_FORMATS)) {
    const b = el('button', `opt${study.format === key ? ' sel' : ''}`);
    b.innerHTML = `<div class="oico">${info.icon}</div>
      <div><div class="otitle">${info.title}</div><div class="odesc">${info.desc}</div></div>`;
    b.onclick = () => { study.format = key; reconcileFacets(); renderStudySetup(); };
    fmt.appendChild(b);
  }

  const n = poolFor(state.region).length;
  $('#studySub').textContent = `${n} ${isStatesRegion(state.region) ? 'states' : 'cards'} · ${FACETS[study.prompt].label} → ${FACETS[study.answer].label}`;
  $('#btnStudyStart').disabled = !n;
}

function renderFacetRow(sel, role, nounCap) {
  const host = $(sel);
  host.innerHTML = '';
  for (const [key, info] of Object.entries(FACETS)) {
    const b = el('button', `facet${study[role] === key ? ' sel' : ''}`);
    const label = key === 'name' ? nounCap : info.label;
    // Can't type a flag, and prompt/answer must differ.
    const disabled = (role === 'answer' && key === study.prompt)
      || (role === 'prompt' && key === study.answer)
      || (role === 'answer' && key === 'flag' && study.format === 'type');
    b.disabled = disabled;
    b.innerHTML = `<span class="fico">${info.icon}</span><span class="flbl">${label}</span>`;
    b.onclick = () => {
      study[role] = key;
      // Keep the pair distinct.
      if (study.prompt === study.answer) {
        const other = role === 'prompt' ? 'answer' : 'prompt';
        study[other] = key === 'flag' ? 'name' : 'flag';
      }
      reconcileFacets();
      renderStudySetup();
    };
    host.appendChild(b);
  }
}

/** Formats and facets that can't coexist get nudged into a valid combo. */
function reconcileFacets() {
  if (study.format === 'type' && study.answer === 'flag') {
    study.answer = study.prompt === 'name' ? 'cap' : 'name';
  }
  if (study.prompt === study.answer) study.answer = study.prompt === 'flag' ? 'name' : 'flag';
}

// ------------------------------------------------------------- study session

function startStudy() {
  reconcileFacets();
  study.items = shuffle(poolFor(state.region));
  if (!study.items.length) return;
  study.correct = 0;
  study.wrong = 0;
  study.answered = 0;
  study.missed = new Map();
  study.locked = false;
  study.startedAt = performance.now();

  $('#studySetup').hidden = true;
  $('#menu').hidden = true;
  $('#study').hidden = false;
  $('#studyTitle').textContent = `${regionIcon(state.region)} ${regionLabel(state.region)} · ${STUDY_FORMATS[study.format].title}`;

  if (study.format === 'match') {
    startMatch();
  } else if (study.format === 'learn') {
    study.need = study.answer === 'flag' ? 2 : 2;
    study.box = new Map(study.items.map((id) => [id, 0]));
    study.order = study.items.slice();
    study.total = study.items.length * study.need;
    nextLearn();
  } else {
    study.queue = study.items.slice();
    study.total = study.items.length;
    study.i = 0;
    nextDrill();
  }
  installStudyKeys();
}

function studyProgress(done, total) {
  $('#studyProg').innerHTML = `<b>${done}</b> / ${total}`;
  $('#studyScore').innerHTML = `<span class="sc-good">${study.correct}✓</span> · ${study.wrong}✗`;
  $('#studyProgBar').firstElementChild.style.width = `${total ? (done / total) * 100 : 0}%`;
}

// --- straight drills: multiple choice / type, each card once ---
function nextDrill() {
  study.locked = false;
  if (study.i >= study.queue.length) { studySummary(); return; }
  studyProgress(study.answered, study.total);
  renderQuestion(study.queue[study.i], study.format);
}

function advanceDrill() {
  study.i++;
  nextDrill();
}

// --- adaptive learn: box per item, mc then type, requeue misses ---
function nextLearn() {
  study.locked = false;
  const done = [...study.box.values()].reduce((s, b) => s + Math.min(b, study.need), 0);
  studyProgress(done, study.total);
  if (done >= study.total) { studySummary(); return; }
  // Next item still below mastery, cycling through the order.
  let pick = null;
  for (let n = 0; n < study.order.length; n++) {
    const id = study.order[(study.learnPtr = ((study.learnPtr || 0) + 1) % study.order.length)];
    if (study.box.get(id) < study.need) { pick = id; break; }
  }
  if (!pick) { studySummary(); return; }
  const box = study.box.get(pick);
  const textAnswer = study.answer !== 'flag';
  const mode = box === 0 || !textAnswer ? 'mc' : 'type';
  renderQuestion(pick, mode);
}

function onLearnResult(id, correct) {
  const b = study.box.get(id);
  study.box.set(id, correct ? b + 1 : Math.max(0, b - 1));
  if (!correct) {
    // Re-queue soon by moving it a few slots ahead in the order.
    const idx = study.order.indexOf(id);
    if (idx !== -1) {
      study.order.splice(idx, 1);
      study.order.splice(Math.min(idx + 3, study.order.length), 0, id);
    }
  }
}

// ------------------------------------------------------ question rendering

function renderQuestion(id, mode) {
  const c = BY_ID.get(id);
  const body = $('#studyBody');
  body.innerHTML = '';
  const q = el('div', 'q');

  const ans = study.answer;
  const askLabel = ans === 'flag' ? 'Pick its flag'
    : ans === 'cap' ? 'Which capital?'
      : (isStatesRegion(state.region) ? 'Which state?' : 'Which country?');
  const kind = study.prompt === 'cap' ? 'CAPITAL' : study.prompt === 'name' ? nameNoun().toUpperCase() : '';

  q.innerHTML = `<div class="q-label">${askLabel}</div>`;
  const prompt = el('div', 'q-prompt');
  if (study.prompt === 'flag') {
    const img = el('img');
    img.src = studyFlag(id);
    img.alt = '';
    prompt.appendChild(img);
  } else {
    const t = el('div', 'q-text');
    t.textContent = facetText(c, study.prompt);
    prompt.appendChild(t);
  }
  q.appendChild(prompt);
  if (kind && study.prompt !== 'flag') {
    const s = el('div', 'q-sub');
    s.textContent = kind === 'CAPITAL' ? 'capital city' : kind.toLowerCase();
    q.appendChild(s);
  }

  if (mode === 'mc') renderMC(q, id);
  else renderType(q, id);

  body.appendChild(q);
}

function renderMC(q, id) {
  const opts = shuffle([id, ...distractors(id, 3)]);
  const wrap = el('div', `q-opts${study.answer === 'flag' ? ' flags' : ''}`);
  opts.forEach((oid, n) => {
    const c = BY_ID.get(oid);
    const b = el('button', `opt-btn${study.answer === 'flag' ? ' flag' : ''}`);
    b.dataset.oid = oid;
    if (study.answer === 'flag') {
      const img = el('img');
      img.src = studyFlag(oid);
      img.alt = '';
      b.appendChild(img);
    } else {
      b.innerHTML = `<span>${facetText(c, study.answer)}</span><span class="kbd">${n + 1}</span>`;
    }
    b.onclick = () => judgeMC(b, wrap, oid, id);
    wrap.appendChild(b);
  });
  q.appendChild(wrap);
  study._mcButtons = [...wrap.children];
}

function judgeMC(btn, wrap, chosenId, correctId) {
  if (study.locked) return;
  study.locked = true;
  const correct = chosenId === correctId;
  for (const b of wrap.children) {
    b.disabled = true;
    if (b.dataset.oid === correctId) b.classList.add('correct');
    else if (b === btn) b.classList.add('wrong');
    else b.classList.add('dim');
  }
  sfx(correct ? 'good' : 'bad');
  recordAnswer(correctId, correct);
  scheduleContinue(correct ? 600 : 1500);
}

function renderType(q, id) {
  const box = el('div', 'q-type');
  const input = el('input', 'q-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.placeholder = study.answer === 'cap' ? 'capital…' : `${nameNoun()}…`;
  const fb = el('div', 'q-feedback');
  const submit = () => {
    if (study.locked) return;
    const val = norm(input.value);
    if (!val) return;
    study.locked = true;
    const correct = acceptable(id).includes(val);
    input.classList.add(correct ? 'correct' : 'wrong');
    input.disabled = true;
    const c = BY_ID.get(id);
    fb.innerHTML = correct
      ? '<span class="ok">Correct!</span>'
      : `<span class="no">Not quite</span> — <b>${facetText(c, study.answer)}</b>`;
    sfx(correct ? 'good' : 'bad');
    recordAnswer(id, correct);
    scheduleContinue(correct ? 650 : 1700);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  box.appendChild(input);
  box.appendChild(fb);
  q.appendChild(box);
  setTimeout(() => input.focus(), 30);
  study._submit = submit;
}

function distractors(correctId, n) {
  const c = BY_ID.get(correctId);
  const val = (id) => (study.answer === 'flag' ? id : facetText(BY_ID.get(id), study.answer));
  const seen = new Set([val(correctId)]);
  const pool = study.items.filter((id) => id !== correctId);
  const same = shuffle(pool.filter((id) => BY_ID.get(id).s === c.s));
  const rest = shuffle(pool.filter((id) => BY_ID.get(id).s !== c.s));
  const out = [];
  for (const id of [...same, ...rest]) {
    const v = val(id);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(id);
    if (out.length >= n) break;
  }
  return out;
}

function recordAnswer(id, correct) {
  if (correct) study.correct++; else { study.wrong++; if (!study.missed.has(id)) study.missed.set(id, true); }
  if (study.format === 'learn') onLearnResult(id, correct);
  else study.answered++;
}

let continueTimer = 0;
function scheduleContinue(delay) {
  clearTimeout(continueTimer);
  study._continue = () => { clearTimeout(continueTimer); study._continue = null; nextTask(); };
  continueTimer = setTimeout(() => { if (study._continue) study._continue(); }, delay);
}

function nextTask() {
  if (study.format === 'learn') nextLearn();
  else advanceDrill();
}

// -------------------------------------------------------------------- match

function startMatch() {
  const chunks = [];
  const ids = study.items.slice();
  for (let i = 0; i < ids.length; i += MATCH_PER_BOARD) chunks.push(ids.slice(i, i + MATCH_PER_BOARD));
  study.boards = chunks;
  study.boardIdx = 0;
  study.matchMistakes = 0;
  study.total = ids.length;
  study.matched = 0;
  renderMatch();
}

function renderMatch() {
  const body = $('#studyBody');
  body.innerHTML = '';
  studyProgress(study.matched, study.total);
  const ids = study.boards[study.boardIdx];
  const wrap = el('div', 'match-wrap');
  wrap.innerHTML = `<div class="match-head">Tap a ${FACETS[study.prompt].label.toLowerCase()} and its matching ${FACETS[study.answer].label.toLowerCase()} · board ${study.boardIdx + 1} of ${study.boards.length}</div>`;
  const grid = el('div', 'match-grid');
  const tiles = [];
  for (const id of ids) {
    tiles.push({ id, side: 'p' });
    tiles.push({ id, side: 'a' });
  }
  study.sel = null;
  for (const t of shuffle(tiles)) {
    const facet = t.side === 'p' ? study.prompt : study.answer;
    const tile = el('div', 'tile');
    tile.dataset.id = t.id;
    tile.dataset.side = t.side;
    if (facet === 'flag') {
      const img = el('img');
      img.src = studyFlag(t.id);
      img.alt = '';
      tile.appendChild(img);
    } else {
      tile.textContent = facetText(BY_ID.get(t.id), facet);
    }
    tile.onclick = () => onMatchTap(tile);
    grid.appendChild(tile);
  }
  wrap.appendChild(grid);
  body.appendChild(wrap);
}

function onMatchTap(tile) {
  if (tile.classList.contains('gone') || tile.classList.contains('sel')) return;
  const sel = study.sel;
  if (!sel) { study.sel = tile; tile.classList.add('sel'); return; }
  study.sel = null;
  sel.classList.remove('sel');
  const pair = sel.dataset.id === tile.dataset.id && sel.dataset.side !== tile.dataset.side;
  if (pair) {
    sfx('good');
    for (const t of [sel, tile]) { t.classList.add('hit'); setTimeout(() => t.classList.add('gone'), 180); }
    study.matched++;
    study.correct++;
    studyProgress(study.matched, study.total);
    // Board is done once no tiles remain (the two just matched included).
    setTimeout(() => {
      if (![...$('#studyBody').querySelectorAll('.tile:not(.gone)')].length) nextBoard();
    }, 240);
  } else {
    sfx('bad');
    study.matchMistakes++;
    study.wrong++;
    for (const t of [sel, tile]) {
      t.classList.add('miss');
      setTimeout(() => t.classList.remove('miss'), 380);
    }
  }
}

function nextBoard() {
  if (study.boardIdx >= study.boards.length - 1) { studySummary(); return; }
  study.boardIdx++;
  renderMatch();
}

// ------------------------------------------------------------------ summary

function studySummary() {
  removeStudyKeys();
  const total = study.format === 'match' ? study.total : (study.format === 'learn' ? study.items.length : study.total);
  const acc = (study.correct + study.wrong) ? Math.round((study.correct / (study.correct + study.wrong)) * 100) : 100;
  const secs = Math.round((performance.now() - study.startedAt) / 1000);
  const missedIds = [...study.missed.keys()];
  if (acc >= 90 && !missedIds.length) confetti();
  sfx('win');

  const body = $('#studyBody');
  const ringClass = acc >= 85 ? 'good' : acc >= 60 ? 'mid' : 'low';
  const headline = study.format === 'match' ? 'Board cleared!' : 'Deck complete!';
  const wrap = el('div', 'study-summary');
  wrap.innerHTML = `
    <div class="ring ${ringClass}">${acc}%</div>
    <div class="big">${headline}</div>
    <div class="sub">${regionLabel(state.region)} · ${FACETS[study.prompt].label} → ${FACETS[study.answer].label}
      · ${study.correct} right${study.wrong ? ` · ${study.wrong} to review` : ''}
      · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</div>`;

  if (missedIds.length) {
    const rev = el('div', 'study-review');
    rev.innerHTML = `<h3>Worth another look (${missedIds.length})</h3>`
      + missedIds.map((id) => {
        const c = BY_ID.get(id);
        return `<div class="row"><img src="${flagURL(id)}" alt=""><b>${c.n}</b><span class="arrow">·</span>${c.cap}</div>`;
      }).join('');
    wrap.appendChild(rev);
  }

  const row = el('div', 'start-row');
  const again = el('button', 'q-btn');
  again.textContent = 'Study again';
  again.onclick = startStudy;
  row.appendChild(again);

  if (missedIds.length && study.format !== 'match') {
    const drill = el('button', 'q-btn ghost');
    drill.textContent = 'Review missed';
    drill.onclick = () => { study.items = shuffle(missedIds); studyReplayMissed(); };
    row.appendChild(drill);
  }
  const toMap = el('button', 'q-btn ghost');
  toMap.textContent = '🗺 Play it on the map';
  toMap.onclick = () => { $('#study').hidden = true; startGame(); };
  row.appendChild(toMap);

  const setup = el('button', 'q-btn ghost');
  setup.textContent = 'Change setup';
  setup.onclick = openStudySetup;
  row.appendChild(setup);

  wrap.appendChild(row);
  body.innerHTML = '';
  body.appendChild(wrap);
}

function studyReplayMissed() {
  study.correct = 0;
  study.wrong = 0;
  study.answered = 0;
  study.missed = new Map();
  study.startedAt = performance.now();
  installStudyKeys();
  if (study.format === 'learn') {
    study.need = study.answer === 'flag' ? 2 : 2;
    study.box = new Map(study.items.map((id) => [id, 0]));
    study.order = study.items.slice();
    study.total = study.items.length * study.need;
    nextLearn();
  } else if (study.format === 'match') {
    startMatch();
  } else {
    study.queue = study.items.slice();
    study.total = study.items.length;
    study.i = 0;
    nextDrill();
  }
}

// ------------------------------------------------------------------- keys

function installStudyKeys() {
  removeStudyKeys();
  study.keyHandler = (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (study._continue) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); study._continue(); } return; }
    if (/^[1-4]$/.test(e.key)) {
      const b = study._mcButtons && study._mcButtons[+e.key - 1];
      if (b && !b.disabled) b.click();
    }
  };
  document.addEventListener('keydown', study.keyHandler);
}
function removeStudyKeys() {
  if (study.keyHandler) document.removeEventListener('keydown', study.keyHandler);
  study.keyHandler = null;
}

function quitStudy() {
  removeStudyKeys();
  clearTimeout(continueTimer);
  study._continue = null;
  $('#study').hidden = true;
  openStudySetup();
}

$('#btnStudy').onclick = openStudySetup;
$('#btnStudyBack').onclick = () => { $('#studySetup').hidden = true; openMenu(); };
$('#btnStudyStart').onclick = startStudy;
$('#studyQuit').onclick = quitStudy;

// =================================================================== launch

buildMap();
measure();
applyView();
syncButtons();
openMenu();
document.body.dataset.ready = '1';
})();
