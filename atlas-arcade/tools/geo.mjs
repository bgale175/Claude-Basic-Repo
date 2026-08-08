// Geometry helpers for the Atlas Arcade build: TopoJSON decoding, Robinson
// projection, Douglas-Peucker simplification and pole-of-inaccessibility labels.

// ---------------------------------------------------------------- topojson --

export function decodeArcs(topology) {
  const { scale, translate } = topology.transform;
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
}

function arcRing(arcs, indexes) {
  const ring = [];
  for (const idx of indexes) {
    const reversed = idx < 0;
    const arc = arcs[reversed ? ~idx : idx];
    const points = reversed ? arc.slice().reverse() : arc;
    // Consecutive arcs share their endpoint, so skip the duplicate.
    for (let i = ring.length ? 1 : 0; i < points.length; i++) ring.push(points[i]);
  }
  return ring;
}

/** Returns an array of polygons; each polygon is [outerRing, ...holes]. */
export function geometryToPolygons(arcs, geometry) {
  if (geometry.type === 'Polygon') return [geometry.arcs.map((r) => arcRing(arcs, r))];
  if (geometry.type === 'MultiPolygon') {
    return geometry.arcs.map((poly) => poly.map((r) => arcRing(arcs, r)));
  }
  return [];
}

// ------------------------------------------------------- antimeridian cut --

/**
 * Rewrites a ring's longitudes as one continuous run, so a shape that crosses
 * 180 degrees reads as (say) 170..190 rather than jumping to -170.
 */
function unwrapLongitudes(ring) {
  const out = [[ring[0][0], ring[0][1]]];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0];
    const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (prev - lon > 180) lon += 360;
    out.push([lon, ring[i][1]]);
  }
  return out;
}

/** Sutherland-Hodgman clip of a polygon against a vertical strip. */
function clipToStrip(points, lo, hi) {
  const clipSide = (pts, keep, intersect) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curIn = keep(cur);
      const prevIn = keep(prev);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
    }
    return out;
  };
  const at = (x) => (a, bPoint) => {
    const t = (x - a[0]) / (bPoint[0] - a[0]);
    return [x, a[1] + (bPoint[1] - a[1]) * t];
  };
  let out = clipToStripInput(points);
  out = clipSide(out, (p) => p[0] >= lo, at(lo));
  if (!out.length) return out;
  return clipSide(out, (p) => p[0] <= hi, at(hi));
}
const clipToStripInput = (points) => {
  // Drop the duplicated closing vertex; the clipper treats rings as cyclic.
  const first = points[0];
  const last = points[points.length - 1];
  return (points.length > 1 && first[0] === last[0] && first[1] === last[1])
    ? points.slice(0, -1)
    : points.slice();
};

/**
 * Splits a lon/lat ring that crosses the antimeridian into pieces that each
 * sit inside [-180, 180]. Without this, projecting the ring directly drags a
 * band right across the map (Russia's Chukotka is the classic offender).
 */
export function cutAntimeridian(ring) {
  const unwrapped = unwrapLongitudes(ring);
  let min = Infinity;
  let max = -Infinity;
  for (const [lon] of unwrapped) {
    if (lon < min) min = lon;
    if (lon > max) max = lon;
  }
  if (min >= -180 && max <= 180) return [ring];

  const pieces = [];
  const first = Math.floor((min + 180) / 360);
  const last = Math.floor((max + 180) / 360);
  for (let k = first; k <= last; k++) {
    const clipped = clipToStrip(unwrapped, -180 + 360 * k, 180 + 360 * k);
    if (clipped.length >= 3) {
      const shifted = clipped.map(([lon, lat]) => [lon - 360 * k, lat]);
      shifted.push(shifted[0].slice());
      pieces.push(shifted);
    }
  }
  return pieces.length ? pieces : [ring];
}

// -------------------------------------------------------------- projection --

// Robinson: the classic compromise projection. Tables are the published
// control points at 5-degree intervals, with a mirrored -5 row so the
// quadratic interpolation behaves at the equator.
const RX = [0.9986, 1.0, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427,
  0.9216, 0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213,
  0.5722, 0.5322];
const RY = [-0.062, 0.0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434,
  0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394,
  0.9761, 1.0];

function interp(table, i0, di) {
  const a = table[i0];
  const b = table[Math.min(19, i0 + 1)];
  const c = table[Math.min(19, i0 + 2)];
  return b + (di * (c - a)) / 2 + (di * di * (c - 2 * b + a)) / 2;
}

/** Robinson in unit space: x spans +/-0.8487*PI, y spans +/-1.3523. */
export function robinson(lon, lat) {
  const abs = Math.min(Math.abs(lat), 90);
  const i = (abs / 5);
  const i0 = Math.min(18, Math.floor(i));
  const di = i - i0;
  const x = 0.8487 * (lon * Math.PI / 180) * interp(RX, i0, di);
  const y = 1.3523 * interp(RY, i0, di) * (lat < 0 ? -1 : 1);
  return [x, y];
}

export const ROBINSON_HALF_WIDTH = 0.8487 * Math.PI;
export const ROBINSON_HALF_HEIGHT = 1.3523;

/** Builds a projector mapping lon/lat into a `width` x height pixel box. */
export function makeProjector(width) {
  const k = width / (2 * ROBINSON_HALF_WIDTH);
  const height = 2 * ROBINSON_HALF_HEIGHT * k;
  const project = (lon, lat) => {
    const [x, y] = robinson(lon, lat);
    return [x * k + width / 2, height / 2 - y * k];
  };
  return { project, width, height };
}

// ------------------------------------------------------------ simplifying --

function sqSegDist(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Iterative Douglas-Peucker (recursion would blow the stack on Russia). */
export function simplify(points, tolerance) {
  if (points.length <= 4) return points;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > sqTol && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

export function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(sum / 2);
}

// ----------------------------------------------------------- label points --

// polylabel: find the point inside a polygon furthest from any edge. Gives a
// far better anchor than a centroid for shapes like Norway, Chile or Croatia.
function pointToPolygonDist(x, y, polygon) {
  let inside = false;
  let minSq = Infinity;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if ((a[1] > y) !== (b[1] > y) &&
          x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
      minSq = Math.min(minSq, sqSegDist([x, y], a, b));
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

export function polylabel(polygon, precision = 1) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon[0]) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const cellSize = Math.max(Math.min(width, height), 1e-6);
  const makeCell = (x, y, h) => {
    const d = pointToPolygonDist(x + h, y + h, polygon);
    return { x: x + h, y: y + h, h, d, max: d + h * Math.SQRT2 };
  };

  const queue = [];
  let step = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) queue.push(makeCell(x, y, step));
  }

  // Centroid of the bounding box is a reasonable starting guess.
  let best = makeCell(minX + width / 2 - step, minY + height / 2 - step, step);
  let guard = 0;
  while (queue.length && guard++ < 12000) {
    queue.sort((a, b) => a.max - b.max);
    const cell = queue.pop();
    if (cell.d > best.d) best = cell;
    if (cell.max - best.d <= precision) continue;
    step = cell.h / 2;
    queue.push(
      makeCell(cell.x - cell.h - step, cell.y - cell.h - step, step),
      makeCell(cell.x - step, cell.y - cell.h - step, step),
      makeCell(cell.x - cell.h - step, cell.y - step, step),
      makeCell(cell.x - step, cell.y - step, step),
    );
  }
  return [best.x, best.y];
}

// ------------------------------------------------------------ path output --

/**
 * Serialises rings as an SVG path of integer relative commands. Coordinates
 * are rounded first and the deltas are taken between rounded points, so the
 * relative encoding never accumulates drift.
 */
export function ringsToPath(rings) {
  const subpaths = [];
  for (const ring of rings) {
    const pts = [];
    for (const [px, py] of ring) {
      const x = Math.round(px);
      const y = Math.round(py);
      const last = pts[pts.length - 1];
      if (!last || last[0] !== x || last[1] !== y) pts.push([x, y]);
    }
    // Drop the repeated closing vertex; `z` re-closes the ring for us.
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (pts.length > 1 && first[0] === last[0] && first[1] === last[1]) pts.pop();
    if (pts.length >= 3) subpaths.push(pts);
  }

  let out = '';
  // After `z` the current point is the start of the closed subpath, so
  // relative movetos chain from there.
  let cx = 0;
  let cy = 0;
  for (const pts of subpaths) {
    out += `m${pts[0][0] - cx} ${pts[0][1] - cy}`;
    let px = pts[0][0];
    let py = pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      out += `l${pts[i][0] - px} ${pts[i][1] - py}`;
      px = pts[i][0];
      py = pts[i][1];
    }
    out += 'z';
    cx = pts[0][0];
    cy = pts[0][1];
  }
  return out;
}
