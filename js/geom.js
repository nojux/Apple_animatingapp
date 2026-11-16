// Geometry: stroke outlines, paths, hit testing, resampling, tween interpolation.
// Element shapes:
//   brush: { t:'b', pts:[[x,y,p],...], c:color, w:size, pr:usePressure, a:opacity, f:fillColor|null, st?:style }
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

// Smooth curve through the input points (Catmull-Rom), with pressure carried along.
function spline(pts, step) {
  const n = pts.length;
  if (n < 2) return pts.map((p) => p.slice());
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, n - 1)];
    const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(1, Math.ceil(d / step));
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const c = (q) => 0.5 * (2 * p1[q] + (-p0[q] + p2[q]) * t + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * t2 + (-p0[q] + 3 * p1[q] - 3 * p2[q] + p3[q]) * t3);
      out.push([c(0), c(1), (p1[2] ?? 1) + ((p2[2] ?? 1) - (p1[2] ?? 1)) * t]);
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

// Variable-width outline polygon around a brush stroke's centre line.
export function brushOutline(el) {
  const raw = el.pts;
  if (!raw.length) return [];
  let len = 0;
  for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
  const step = Math.max(0.6, el.w / 10, len / 4000, el.ms || 0);
  const pts = spline(raw, step), n = pts.length;
  // Smooth pressure along the stroke so the edge never "beads" or steps.
  const rad = new Array(n);
  const R = Math.max(1, Math.min(40, Math.round(el.w / (1.5 * step))));
  if (el.pr) {
    let acc = 0, cnt = 0;
    const pr = pts.map((p) => p[2]);
    for (let i = -R; i < n; i++) {
      if (i + R < n) { acc += pr[i + R]; cnt++; }
      if (i - R - 1 >= 0) { acc -= pr[i - R - 1]; cnt--; }
      if (i >= 0) rad[i] = Math.max(0.3, (el.w / 2) * (0.15 + 0.85 * (acc / cnt)));
    }
  } else rad.fill(Math.max(0.3, el.w / 2));
  if (n === 1 || len < 0.5) return circlePts(raw[0][0], raw[0][1], Math.max(...rad), 16);
  const T = 3;
  const normals = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - T)], b = pts[Math.min(n - 1, i + T)];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
    if (d > 1e-6) normals[i] = [-dy / d, dx / d];
  }
  let last = null;
  for (let i = 0; i < n; i++) { if (normals[i]) last = normals[i]; else if (last) normals[i] = last; }
  last = null;
  for (let i = n - 1; i >= 0; i--) { if (normals[i]) last = normals[i]; else if (last) normals[i] = last; }
  if (!normals[0]) return circlePts(raw[0][0], raw[0][1], rad[0], 16);

  const L = [], Rt = [];
  for (let i = 0; i < n; i++) {
    const r = rad[i], [nx, ny] = normals[i], p = pts[i];
    L.push([p[0] + nx * r, p[1] + ny * r]);
    Rt.push([p[0] - nx * r, p[1] - ny * r]);
  }
  const N = 8, poly = L.slice();
  {
    const p = pts[n - 1], r = rad[n - 1], a = Math.atan2(normals[n - 1][1], normals[n - 1][0]);
    for (let k = 1; k < N; k++) { const g = a - (k * Math.PI) / N; poly.push([p[0] + Math.cos(g) * r, p[1] + Math.sin(g) * r]); }
  }
  for (let i = n - 1; i >= 0; i--) poly.push(Rt[i]);
  {
    const p = pts[0], r = rad[0], a = Math.atan2(normals[0][1], normals[0][0]);
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

// Images: { t:'i', src:assetId, iw, ih, pts:[topLeft, topRight, bottomLeft], a, w:0 }
let imageSource = () => null;
export function setImageSource(fn) { imageSource = fn; }
export function imgCorners(el) {
  const [tl, tr, bl] = el.pts;
  return [tl, tr, [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1]], bl];
}
function imgMatrix(el) {
  const [tl, tr, bl] = el.pts;
  return [(tr[0] - tl[0]) / el.iw, (tr[1] - tl[1]) / el.iw, (bl[0] - tl[0]) / el.ih, (bl[1] - tl[1]) / el.ih, tl[0], tl[1]];
}
const r4 = (v) => Math.round(v * 10000) / 10000;

export function drawEl(ctx, el, alphaMul = 1) {
  if (el.t === 'i') {
    const img = imageSource(el.src);
    const a = (el.a ?? 1) * alphaMul;
    if (!img || a <= 0) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.transform(...imgMatrix(el));
    ctx.drawImage(img, 0, 0, el.iw, el.ih);
    ctx.restore();
    return;
  }
  const a = (el.a ?? 1) * alphaMul;
  if (a <= 0) return;
  ctx.globalAlpha = a;
  if (el.f && el.pts.length > 2) { ctx.fillStyle = el.f; ctx.fill(path2d(el, 'fill')); }
  if (el.t === 'b') {
    if (el.st && PASSES[el.st]) drawStyled(ctx, el, a);
    else { ctx.fillStyle = el.c; ctx.fill(path2d(el, 'ink')); }
  } else if (el.w > 0) {
    ctx.strokeStyle = el.c; ctx.lineWidth = el.w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke(path2d(el, 'ink'));
  }
  ctx.globalAlpha = 1;
}

export function elSVG(el, alphaMul = 1) {
  const a = (el.a ?? 1) * alphaMul;
  if (el.t === 'i') {
    const m = imgMatrix(el).map(r4).join(' ');
    return `<use href="#img-${el.src}" transform="matrix(${m})"${a < 1 ? ` opacity="${r2(a)}"` : ''}/>`;
  }
  let s = '';
  const op = a < 1 ? ` opacity="${r2(a)}"` : '';
  if (el.f && el.pts.length > 2) s += `<path d="${fillD(el)}" fill="${el.f}"${op}/>`;
  if (el.t === 'b') s += el.st && PASSES[el.st] ? styledSVG(el, a) : `<path d="${inkD(el)}" fill="${el.c}"${op}/>`;
  else if (el.w > 0) s += `<path d="${inkD(el)}" fill="none" stroke="${el.c}" stroke-width="${r2(el.w)}" stroke-linecap="round" stroke-linejoin="round"${op}/>`;
  return s;
}

export function bbox(el) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of (el.t === 'i' ? imgCorners(el) : el.pts)) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  const pad = (el.w / 2) * stylePad(el);
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
  if (el.t === 'i') return pointInPoly(x, y, imgCorners(el));
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
  return el.t !== 'i' && el.pts.length > 2 && pointInPoly(x, y, el.pts);
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
  if (el.t === 'i') return null; // images are removed with the "Whole strokes" eraser or Delete
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
  if (a.t === 'i' || b.t === 'i') {
    if (a.t !== b.t || a.src !== b.src) return t < 0.5 ? a : b;
    return { ...a, pts: a.pts.map((p, i) => [p[0] + (b.pts[i][0] - p[0]) * t, p[1] + (b.pts[i][1] - p[1]) * t]), a: (a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * t };
  }
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
    t: a.t, pts, c: lerpColor(a.c, b.c, t), w: a.w + (b.w - a.w) * t, pr: a.pr, ...(a.st ? { st: a.st } : {}),
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

/* ----------------------------------------------------------- brush styles
   A brush stroke may carry a style `st` (missing = plain ink). Every style keeps the same centre
   line and outline, so select, erase, tween and fill work the same; only the painting differs.
   Each style is a list of passes over the stroke: a pass can widen it, wobble it sideways, soften
   its edge (blur, in stage pixels), fade it, tint it, or give it a grain. */

export const BRUSH_STYLES = ['ink', 'smoke', 'air', 'charcoal', 'water', 'glow'];

const PASSES = {
  //            width  wobble  freq  phase  blur   alpha  grow  tint  grain  edge
  smoke: [
    { w: 2.4, wob: 0.6, fq: 0.12, ph: 0.0, blur: 1.0, a: 0.13, grow: 1 },
    { w: 0.75, wob: 0.9, fq: 0.22, ph: 1.7, blur: 0.32, a: 0.22, grow: 0.9 },
    { w: 0.45, wob: -0.85, fq: 0.19, ph: 4.1, blur: 0.2, a: 0.25, grow: 0.7 },
    { w: 0.3, wob: 1.25, fq: 0.31, ph: 2.6, blur: 0.12, a: 0.22, grow: 0.5 },
    { w: 0.18, wob: 0.3, fq: 0.4, ph: 0.9, blur: 0.05, a: 0.28, grow: 0.2 },
  ],
  air: [
    { w: 1.25, blur: 0.42, a: 0.55 },
    { w: 0.6, blur: 0.2, a: 0.45 },
  ],
  charcoal: [
    { w: 0.9, rough: 0.22, a: 0.35 },
    { w: 1.1, rough: 0.35, grain: true, a: 1 },
  ],
  water: [
    { w: 1, rough: 0.15, fq: 0.08, blur: 0.05, a: 0.3 },
    { w: 0.8, wob: 0.12, fq: 0.15, ph: 2, rough: 0.12, blur: 0.12, a: 0.22 },
    { w: 1, rough: 0.15, fq: 0.08, edge: 0.09, blur: 0.05, a: 0.55, shade: -0.3 },
  ],
  glow: [
    { w: 1.6, blur: 1.1, a: 0.85 },
    { w: 1, blur: 0.45, a: 0.9 },
    { w: 0.55, a: 1, tint: 0.7 },
  ],
};
const PAD = { smoke: 2.2, air: 1.4, glow: 2.4, water: 1.2, charcoal: 1.2 };
export const stylePad = (el) => (el.st && PAD[el.st]) || 1;

// Smooth, repeatable wobble (no randomness, so redraws, tweens and exports match).
const wave = (s, fq, ph) => Math.sin(s * fq + ph) * 0.6 + Math.sin(s * fq * 2.3 + ph * 1.9 + 1.3) * 0.3 + Math.sin(s * fq * 5.1 + ph * 0.7) * 0.1;
// Quick pseudo-random grain along the stroke (stable per position).
const hashN = (i) => { const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };

// The stroke reshaped for one pass, as a plain brush element (outline computed by brushOutline).
function passEl(el, P) {
  const pts = el.pts, n = pts.length, w = el.w;
  if (!P.wob && !P.rough && !P.grow && P.w === 1 && !(P.blur >= 0.15)) return el;
  // ms: how finely the outline is traced. Thin passes are traced as coarsely as the whole stroke,
  // and blurred ones coarser still since the blur hides the detail. Points closer together than
  // that are skipped, which keeps long strokes fast.
  const ms = P.blur >= 0.15 ? Math.min(w * P.blur * 0.5, 12) : Math.min(w / 10, 4);
  const out = [];
  let kept = -Infinity;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (i) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    let x = p[0], y = p[1];
    // 0 at the start of the stroke, easing to 1 after ~15 widths. It only depends on the distance
    // travelled, so the part already drawn keeps its shape while the stroke is still growing.
    const far = 1 - Math.exp(-s / (w * 15));
    const pr = el.pr ? (p[2] ?? 1) : 1;
    if (P.wob) {
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
      // Smoke drifts more the further it travels.
      const off = P.wob * w * wave(s / w, P.fq, P.ph) * (0.4 + 0.9 * far) * (0.5 + 0.5 * pr);
      x += (-dy / d) * off; y += (dx / d) * off;
    }
    let k = 1;
    if (P.grow) k *= 1 - P.grow * 0.45 + P.grow * 0.9 * far; // thin at the start, billowing further on
    if (P.rough) k *= 1 + P.rough * (P.fq ? wave(s / w, P.fq * 10, P.ph || 0) : hashN(Math.round(s * 0.7)) * 2 - 1);
    if (s - kept < ms * 0.5 && i < n - 1) continue;
    kept = s;
    out.push([x, y, Math.max(0.05, pr * k)]);
  }
  return { t: 'b', pts: out, c: el.c, w: w * P.w, pr: true, a: 1, f: null, ms };
}

const passCache = new WeakMap();
function passPaths(el) {
  let c = passCache.get(el);
  if (!c) {
    c = PASSES[el.st].map((P) => {
      const pe = passEl(el, P);
      return { P, d: inkD(pe) };
    });
    passCache.set(el, c);
  }
  return c;
}

// Grain texture for charcoal: a tile of speckles, coloured per stroke colour.
let grainTile = null;
const grainPats = new Map();
function grainPattern(ctx, color) {
  if (!grainTile) {
    grainTile = document.createElement('canvas');
    grainTile.width = grainTile.height = 96;
    const g = grainTile.getContext('2d'), im = g.createImageData(96, 96);
    for (let i = 0; i < 96 * 96; i++) {
      const v = hashN(i * 1.37 + 0.5), u = hashN(i * 0.73 + 9.1);
      im.data[i * 4 + 3] = v < 0.7 ? Math.round(150 + u * 105) : Math.round(u * 40);
    }
    g.putImageData(im, 0, 0);
  }
  let pat = grainPats.get(color);
  if (!pat) {
    const t = document.createElement('canvas');
    t.width = t.height = 96;
    const g = t.getContext('2d');
    g.drawImage(grainTile, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color; g.fillRect(0, 0, 96, 96);
    pat = { canvas: t };
    if (grainPats.size > 40) grainPats.clear();
    grainPats.set(color, pat);
  }
  return ctx.createPattern(pat.canvas, 'repeat');
}

const shade = (c, k) => (k > 0 ? lerpColor(c, '#ffffff', k) : lerpColor(c, '#000000', -k));
const p2d = new WeakMap();
function pathOf(rec) { let p = p2d.get(rec); if (!p) { p = new Path2D(rec.d); p2d.set(rec, p); } return p; }

// Paint a styled brush stroke on a canvas. Blur uses a shadow cast from a copy drawn far off to the
// side: it is fast on iPad and works on every Safari version (canvas filters do not).
function drawStyled(ctx, el, a) {
  const m = ctx.getTransform(), sc = Math.hypot(m.a, m.b) || 1;
  for (const rec of passPaths(el)) {
    const P = rec.P, alpha = a * P.a;
    if (alpha <= 0.003) continue;
    let col = el.c;
    if (P.tint) col = shade(col, P.tint);
    if (P.shade) col = shade(col, P.shade);
    const path = pathOf(rec);
    ctx.globalAlpha = alpha;
    const blur = Math.min(80, (P.blur || 0) * el.w * sc); // very wide blurs cost a lot and look the same
    if (blur > 0.6) {
      const D = 20000; // device pixels
      ctx.save();
      ctx.shadowColor = col; ctx.shadowBlur = blur; ctx.shadowOffsetX = D; ctx.shadowOffsetY = 0;
      ctx.translate(-D / sc, 0);
      ctx.fillStyle = '#000';
      if (P.edge) { ctx.strokeStyle = '#000'; ctx.lineWidth = P.edge * el.w; ctx.lineJoin = 'round'; ctx.stroke(path); }
      else ctx.fill(path);
      ctx.restore();
    } else if (P.edge) {
      ctx.strokeStyle = col; ctx.lineWidth = P.edge * el.w; ctx.lineJoin = 'round'; ctx.stroke(path);
    } else {
      ctx.fillStyle = P.grain ? grainPattern(ctx, col) : col;
      ctx.fill(path);
    }
  }
  ctx.globalAlpha = 1;
}

let svgSeq = 0;
function styledSVG(el, a) {
  let s = '';
  for (const rec of passPaths(el)) {
    const P = rec.P, alpha = a * P.a;
    if (alpha <= 0.003) continue;
    let col = el.c;
    if (P.tint) col = shade(col, P.tint);
    if (P.shade) col = shade(col, P.shade);
    let filt = '', fa = '';
    const sd = (P.blur || 0) * el.w / 2;
    if (sd > 0.3 || P.grain) {
      const id = `ifs${(++svgSeq).toString(36)}`;
      let body = '';
      if (P.grain) body = `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="3" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -3 2.1" result="m"/><feComposite in="SourceGraphic" in2="m" operator="in"/>`;
      else body = `<feGaussianBlur stdDeviation="${r2(sd)}"/>`;
      filt = `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%">${body}</filter>`;
      fa = ` filter="url(#${id})"`;
    }
    const paint = P.edge ? `fill="none" stroke="${col}" stroke-width="${r2(P.edge * el.w)}" stroke-linejoin="round"` : `fill="${col}"`;
    s += `${filt}<path d="${rec.d}" ${paint} opacity="${r2(alpha)}"${fa}/>`;
  }
  return s;
}
