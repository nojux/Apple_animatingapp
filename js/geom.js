// Geometry: stroke outlines, paths, hit testing, resampling, tween interpolation.
// Element shapes:
//   brush: { t:'b', pts:[[x,y,p],...], c:color, w:size, pr:usePressure, a:opacity, f:fillColor|null }
//   poly : { t:'p', pts:[[x,y],...],   c:color, w:width, cl:closed,     a:opacity, f:fillColor|null }

const r2 = (v) => Math.round(v * 100) / 100;

export function radiusAt(el, i) {
  const p = el.pr ? el.pts[i][2] : 1;
  return Math.max(0.3, (el.w / 2) * (0.15 + 0.85 * p));
}

function circlePts(x, y, r, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
  }
  return out;
}

// Variable-width outline polygon around a brush stroke's centre line.
export function brushOutline(el) {
  const pts = el.pts, n = pts.length;
  if (!n) return [];
  const normals = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
    if (d > 1e-6) normals[i] = [-dy / d, dx / d];
  }
  let last = null;
  for (let i = 0; i < n; i++) { if (normals[i]) last = normals[i]; else if (last) normals[i] = last; }
  last = null;
  for (let i = n - 1; i >= 0; i--) { if (normals[i]) last = normals[i]; else if (last) normals[i] = last; }
  if (!normals[0]) return circlePts(pts[0][0], pts[0][1], radiusAt(el, 0), 14);

  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const r = radiusAt(el, i), [nx, ny] = normals[i], p = pts[i];
    L.push([p[0] + nx * r, p[1] + ny * r]);
    R.push([p[0] - nx * r, p[1] - ny * r]);
  }
  const N = 6, poly = L.slice();
  {
    const p = pts[n - 1], r = radiusAt(el, n - 1), a = Math.atan2(normals[n - 1][1], normals[n - 1][0]);
    for (let k = 1; k < N; k++) { const g = a - (k * Math.PI) / N; poly.push([p[0] + Math.cos(g) * r, p[1] + Math.sin(g) * r]); }
  }
  for (let i = n - 1; i >= 0; i--) poly.push(R[i]);
  {
    const p = pts[0], r = radiusAt(el, 0), a = Math.atan2(normals[0][1], normals[0][0]);
    for (let k = 1; k < N; k++) { const g = a + Math.PI - (k * Math.PI) / N; poly.push([p[0] + Math.cos(g) * r, p[1] + Math.sin(g) * r]); }
  }
  return poly;
}

function smoothClosedD(poly) {
  const n = poly.length;
  if (n < 3) return '';
  const mid = (i, j) => `${r2((poly[i][0] + poly[j][0]) / 2)} ${r2((poly[i][1] + poly[j][1]) / 2)}`;
  let d = `M${mid(n - 1, 0)}`;
  for (let i = 0; i < n; i++) d += `Q${r2(poly[i][0])} ${r2(poly[i][1])} ${mid(i, (i + 1) % n)}`;
  return d + 'Z';
}

export function lineD(pts, closed) {
  if (!pts.length) return '';
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  if (pts.length === 1) d += `L${r2(pts[0][0] + 0.01)} ${r2(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${r2(pts[i][0])} ${r2(pts[i][1])}`;
  return closed ? d + 'Z' : d;
}

const cache = new WeakMap();
function cached(el) {
  let c = cache.get(el);
  if (!c) { c = {}; cache.set(el, c); }
  return c;
}

// SVG path data for the visible ink of an element.
export function inkD(el) {
  const c = cached(el);
  if (c.ink === undefined) c.ink = el.t === 'b' ? smoothClosedD(brushOutline(el)) : lineD(el.pts, el.cl);
  return c.ink;
}
// SVG path data for the fill region of an element (its centre line, closed).
export function fillD(el) {
  const c = cached(el);
  if (c.fill === undefined) c.fill = lineD(el.pts, true);
  return c.fill;
}
function path2d(el, kind) {
  const c = cached(el), key = kind + 'P';
  if (!c[key]) c[key] = new Path2D(kind === 'ink' ? inkD(el) : fillD(el));
  return c[key];
}

export function drawEl(ctx, el, alphaMul = 1) {
  const a = (el.a ?? 1) * alphaMul;
  if (a <= 0) return;
  ctx.globalAlpha = a;
  if (el.f && el.pts.length > 2) { ctx.fillStyle = el.f; ctx.fill(path2d(el, 'fill')); }
  if (el.t === 'b') { ctx.fillStyle = el.c; ctx.fill(path2d(el, 'ink')); }
  else if (el.w > 0) {
    ctx.strokeStyle = el.c; ctx.lineWidth = el.w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke(path2d(el, 'ink'));
  }
  ctx.globalAlpha = 1;
}

export function elSVG(el, alphaMul = 1) {
  const a = (el.a ?? 1) * alphaMul;
  let s = '';
  const op = a < 1 ? ` opacity="${r2(a)}"` : '';
  if (el.f && el.pts.length > 2) s += `<path d="${fillD(el)}" fill="${el.f}"${op}/>`;
  if (el.t === 'b') s += `<path d="${inkD(el)}" fill="${el.c}"${op}/>`;
  else if (el.w > 0) s += `<path d="${inkD(el)}" fill="none" stroke="${el.c}" stroke-width="${r2(el.w)}" stroke-linecap="round" stroke-linejoin="round"${op}/>`;
  return s;
}

export function bbox(el) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of el.pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  const pad = el.w / 2;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
export function unionBox(els) {
  let b = null;
  for (const el of els) {
    const e = bbox(el);
    if (!b) b = { ...e };
    else { b.x0 = Math.min(b.x0, e.x0); b.y0 = Math.min(b.y0, e.y0); b.x1 = Math.max(b.x1, e.x1); b.y1 = Math.max(b.y1, e.y1); }
  }
  return b;
}

function distSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  let t = l ? ((px - a[0]) * dx + (py - a[1]) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function hitEl(el, x, y, tol) {
  const b = bbox(el);
  if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) return false;
  if (el.f && el.pts.length > 2 && pointInPoly(x, y, el.pts)) return true;
  const pts = el.pts;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= el.w / 2 + tol;
  const n = el.t === 'p' && el.cl ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % pts.length];
    const r = el.t === 'b' ? radiusAt(el, i) : el.w / 2;
    if (distSeg(x, y, a, c) <= r + tol) return true;
  }
  return false;
}
// Can the fill tool fill this element at (x,y)?
export function fillable(el, x, y) {
  return el.pts.length > 2 && pointInPoly(x, y, el.pts);
}

// Insert points so no gap is larger than `step` (keeps pressure).
export function densify(pts, closed, step) {
  const out = [];
  const n = pts.length, m = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    out.push(pts[i].slice());
    if (i >= m) continue;
    const a = pts[i], b = pts[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.floor(d / step);
    for (let j = 1; j <= k; j++) {
      const t = j / (k + 1);
      out.push(a.map((v, q) => v + (b[q] - v) * t));
    }
  }
  if (closed && n) out.push(pts[0].slice());
  return out;
}

// Erase the parts of an element within radius r of (x,y). Returns null if untouched,
// otherwise an array of replacement elements (possibly empty).
export function eraseEl(el, x, y, r) {
  const b = bbox(el);
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return null;
  const step = Math.max(1.5, r / 3);
  const pts = densify(el.pts, el.t === 'p' && el.cl, step);
  const rr = r + (el.t === 'p' ? el.w / 4 : 0);
  const hit = pts.map((p) => (p[0] - x) ** 2 + (p[1] - y) ** 2 <= rr * rr);
  if (!hit.some(Boolean)) return null;
  const runs = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    if (hit[i]) { if (cur.length) runs.push(cur); cur = []; }
    else cur.push(pts[i]);
  }
  if (cur.length) runs.push(cur);
  if (el.t === 'p' && el.cl && runs.length > 1 && !hit[0] && !hit[pts.length - 1]) {
    const first = runs.shift();
    runs[runs.length - 1] = runs[runs.length - 1].concat(first);
  }
  return runs.filter((r) => r.length >= 2).map((run) => ({ ...el, pts: run, cl: false, f: null }));
}

export function resample(pts, n, closed) {
  const src = closed ? pts.concat([pts[0]]) : pts;
  if (src.length === 1) return Array.from({ length: n }, () => src[0].slice());
  const cum = [0];
  for (let i = 1; i < src.length; i++) cum.push(cum[i - 1] + Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1]));
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  const count = closed ? n : n; // for closed shapes the last sample doesn't repeat the first
  for (let k = 0; k < count; k++) {
    const d = closed ? (k / n) * total : (n === 1 ? 0 : (k / (n - 1)) * total);
    while (j < src.length - 2 && cum[j + 1] < d) j++;
    const a = src[j], b = src[Math.min(j + 1, src.length - 1)];
    const seg = cum[j + 1] - cum[j] || 1;
    const t = Math.max(0, Math.min(1, (d - cum[j]) / seg));
    out.push(a.map((v, q) => v + ((b[q] ?? v) - v) * t));
  }
  return out;
}

function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function lerpColor(a, b, t) {
  if (a === b) return a;
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function lerpEl(a, b, t) {
  if (a.t !== b.t || (a.t === 'p' && !!a.cl !== !!b.cl)) return t < 0.5 ? a : b;
  const closed = a.t === 'p' && a.cl;
  const n = Math.min(500, Math.max(a.pts.length, b.pts.length, 2));
  const pa = resample(a.pts, n, closed), pb = resample(b.pts, n, closed);
  let best = 0;
  if (closed) {
    // Rotate the target loop so its starting point lines up with the source, to avoid twisting.
    let bd = Infinity;
    const stepK = Math.max(1, Math.floor(n / 64));
    for (let k = 0; k < n; k += stepK) {
      let s = 0;
      for (let i = 0; i < n; i += stepK) { const q = pb[(i + k) % n]; s += (pa[i][0] - q[0]) ** 2 + (pa[i][1] - q[1]) ** 2; }
      if (s < bd) { bd = s; best = k; }
    }
  }
  const pts = pa.map((p, i) => { const q = pb[(i + best) % n]; return p.map((v, k) => v + ((q[k] ?? v) - v) * t); });
  const f = a.f && b.f ? lerpColor(a.f, b.f, t) : (t < 0.5 ? a.f : b.f);
  return {
    t: a.t, pts, c: lerpColor(a.c, b.c, t), w: a.w + (b.w - a.w) * t, pr: a.pr,
    a: (a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * t, f, cl: a.cl,
  };
}

export const EASES = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inout: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

export function interpolate(A, B, t) {
  const out = [];
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const a = A[i], b = B[i];
    if (a && b) out.push(lerpEl(a, b, t));
    else if (a) out.push({ ...a, a: (a.a ?? 1) * (1 - t) });
    else out.push({ ...b, a: (b.a ?? 1) * t });
  }
  return out;
}

export function mapPts(el, fn, wScale = 1) {
  return { ...el, pts: el.pts.map((p) => { const [x, y] = fn(p[0], p[1]); return p.length > 2 ? [x, y, p[2]] : [x, y]; }), w: el.w * wScale };
}

export function cloneEl(el) {
  return { ...el, pts: el.pts.map((p) => p.slice()) };
}
