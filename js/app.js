import { icon, fillIcons } from './icons.js';
import {
  drawEl, elSVG, bbox, unionBox, hitEl, fillable, eraseEl, interpolate, EASES, mapPts, cloneEl,
} from './geom.js';
import { encodeGIF } from './gif.js';
import { makeZip } from './zip.js';
import * as DB from './db.js';

const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ state */

const PALETTE = ['#1d1d24', '#ffffff', '#8a8a96', '#e8413c', '#ff8a2a', '#ffd23f', '#5cc86b', '#1f9e89', '#33a7ff', '#3d5afe', '#8e5cff', '#ff5fa2', '#7a4a2a', '#f5c9a8', '#ffe9b0', '#b8f0c8', '#bfe2ff', '#e2d4ff'];

const prefs = loadPrefs();
function loadPrefs() {
  const d = {
    tool: 'brush', color: '#1d1d24', recent: [], finger: 'auto', autoKey: true, onionPrev: 2, onionNext: 1,
    onion: true, loop: true, eraserMode: 'partial', shapeFill: false, helpSeen: false,
    tools: {
      brush: { size: 8, opacity: 100, smoothing: 45, pressure: true },
      pen: { size: 3, opacity: 100, smoothing: 30 },
      eraser: { size: 24 },
      line: { size: 4, opacity: 100 }, rect: { size: 4, opacity: 100 }, ellipse: { size: 4, opacity: 100 },
    },
  };
  try {
    const s = JSON.parse(localStorage.getItem('inkframe.prefs') || '{}');
    return { ...d, ...s, tools: { ...d.tools, ...(s.tools || {}) } };
  } catch { return d; }
}
function savePrefs() { try { localStorage.setItem('inkframe.prefs', JSON.stringify(prefs)); } catch {} }

const S = {
  proj: null,
  cur: 0,
  layer: 0, // index into proj.layers
  sel: [], // indices of selected elements in the active layer's current content
  clipboard: null,
  playing: false,
  view: { s: 1, ox: 0, oy: 0 },
  penSeen: false,
  undo: [], redo: [],
};

function newProject(name = 'Untitled animation') {
  return {
    id: uid(), name, w: 1920, h: 1080, fps: 12, bg: '#ffffff', frameCount: 24,
    layers: [{ id: uid(), name: 'Layer 1', visible: true, locked: false, keys: { 0: { els: [], tw: false } } }],
    created: Date.now(), updated: Date.now(),
  };
}

/* ------------------------------------------------------------ frame model */

const sortedKeys = (L) => Object.keys(L.keys).map(Number).sort((a, b) => a - b);
function keyAt(L, f) { let k = -1; for (const i of sortedKeys(L)) { if (i <= f) k = i; else break; } return k; }
function nextKey(L, f) { for (const i of sortedKeys(L)) if (i > f) return i; return -1; }
function contentAt(L, f) {
  const k = keyAt(L, f);
  if (k < 0) return [];
  const kf = L.keys[k];
  if (kf.tw && f > k) {
    const nk = nextKey(L, k);
    if (nk > 0 && f < nk) {
      const t = (EASES[kf.ease || 'linear'] || EASES.linear)((f - k) / (nk - k));
      return interpolate(kf.els, L.keys[nk].els, t);
    }
  }
  return kf.els;
}
const activeLayer = () => S.proj.layers[S.layer];

// Make sure the active layer has a keyframe at the current frame (if auto-keying), return its element array.
function editableEls() {
  const L = activeLayer(), f = S.cur;
  if (L.keys[f]) return L.keys[f].els;
  const k = keyAt(L, f);
  if (prefs.autoKey || k < 0) {
    const prev = k >= 0 ? L.keys[k] : null;
    L.keys[f] = { els: contentAt(L, f).map(cloneEl), tw: !!(prev && prev.tw && nextKey(L, f) > 0), ease: prev?.ease };
    if (f >= S.proj.frameCount) S.proj.frameCount = f + 1;
    return L.keys[f].els;
  }
  return L.keys[k].els;
}
function canEdit() {
  const L = activeLayer();
  if (!L.visible) { toast('This layer is hidden. Tap the eye to show it.'); return false; }
  if (L.locked) { toast('This layer is locked. Tap the lock to unlock it.'); return false; }
  if (S.playing) stop();
  return true;
}

/* ------------------------------------------------------------ undo / save */

const snap = () => JSON.stringify({ layers: S.proj.layers, frameCount: S.proj.frameCount });
function pushUndo() {
  S.undo.push(snap());
  if (S.undo.length > 80) S.undo.shift();
  S.redo.length = 0;
  updateUndoButtons();
}
function restore(str) {
  const d = JSON.parse(str);
  S.proj.layers = d.layers; S.proj.frameCount = d.frameCount;
  S.layer = clamp(S.layer, 0, S.proj.layers.length - 1);
  S.sel = [];
}
function undo() {
  if (!S.undo.length) return toast('Nothing to undo');
  S.redo.push(snap()); restore(S.undo.pop()); changed(true);
}
function redo() {
  if (!S.redo.length) return toast('Nothing to redo');
  S.undo.push(snap()); restore(S.redo.pop()); changed(true);
}
function updateUndoButtons() {
  $('#btnUndo').disabled = !S.undo.length;
  $('#btnRedo').disabled = !S.redo.length;
}

let saveTimer = null;
function changed(structure = true) {
  S.proj.updated = Date.now();
  if (structure) renderTimeline(); else updatePlayhead();
  updateUndoButtons();
  updatePanel();
  requestRender();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.proj) return;
  try {
    await DB.saveProject(S.proj, { id: S.proj.id, name: S.proj.name, updated: S.proj.updated, frames: S.proj.frameCount, thumb: thumbnail() });
    try { localStorage.setItem('inkframe.last', S.proj.id); } catch {}
  } catch (e) { console.error(e); toast('Could not save. Is storage full?'); }
}
function thumbnail() {
  const p = S.proj, sc = Math.min(240 / p.w, 150 / p.h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(p.w * sc)); c.height = Math.max(1, Math.round(p.h * sc));
  const ctx = c.getContext('2d');
  ctx.scale(sc, sc);
  drawFrame(ctx, 0, true);
  return c.toDataURL('image/jpeg', 0.7);
}
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

/* -------------------------------------------------------------- rendering */

const cv = $('#cv'), ov = $('#overlay'), wrap = $('#stageWrap');
const ctx = cv.getContext('2d'), octx = ov.getContext('2d');
let dpr = 1, W = 0, H = 0;
const tint = document.createElement('canvas'), tctx = tint.getContext('2d');

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = wrap.getBoundingClientRect();
  const first = !W;
  W = r.width; H = r.height;
  for (const c of [cv, ov, tint]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  if (first) fit();
  requestRender();
}
function fit() {
  const p = S.proj; if (!p || !W) return;
  const s = Math.min((W - 40) / p.w, (H - 40) / p.h);
  S.view = { s, ox: (W - p.w * s) / 2, oy: (H - p.h * s) / 2 };
  requestRender();
}
const setView = (c) => c.setTransform(dpr * S.view.s, 0, 0, dpr * S.view.s, dpr * S.view.ox, dpr * S.view.oy);
const toStage = (x, y) => [(x - S.view.ox) / S.view.s, (y - S.view.oy) / S.view.s];
const toScreen = (x, y) => [x * S.view.s + S.view.ox, y * S.view.s + S.view.oy];

// Draw frame f (all visible layers) in stage coordinates. Caller sets transform.
function drawFrame(c, f, withBg, opts = {}) {
  const p = S.proj;
  if (withBg) { c.fillStyle = p.bg; c.fillRect(0, 0, p.w, p.h); }
  for (const L of p.layers) {
    if (!L.visible && !opts.includeHidden) continue;
    for (const el of contentAt(L, f)) drawEl(c, el, opts.alpha ?? 1);
  }
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
function render() {
  const p = S.proj; if (!p) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  setView(ctx);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 24 * S.view.s;
  ctx.fillStyle = p.bg; ctx.fillRect(0, 0, p.w, p.h);
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, p.w, p.h); ctx.clip();
  if (prefs.onion && !S.playing) {
    for (let d = prefs.onionPrev; d >= 1; d--) onion(S.cur - d, '#ff3b30', 0.32 / d);
    for (let d = prefs.onionNext; d >= 1; d--) onion(S.cur + d, '#22b14c', 0.32 / d);
  }
  drawFrame(ctx, S.cur, false);
  ctx.restore();
  drawSelection();
  $('#zoomInfo').textContent = Math.round(S.view.s * 100) + '%';
}
function onion(f, color, alpha) {
  const p = S.proj;
  if (f < 0) { if (!prefs.loop || p.frameCount < 3) return; f += p.frameCount; }
  if (f >= p.frameCount) { if (!prefs.loop || p.frameCount < 3) return; f -= p.frameCount; }
  if (f === S.cur) return;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.globalCompositeOperation = 'source-over';
  tctx.clearRect(0, 0, tint.width, tint.height);
  setView(tctx);
  drawFrame(tctx, f, false);
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.globalCompositeOperation = 'source-in';
  tctx.globalAlpha = 1;
  tctx.fillStyle = color; tctx.fillRect(0, 0, tint.width, tint.height);
  tctx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.drawImage(tint, 0, 0);
  ctx.restore();
}

/* -------------------------------------------------------------- selection */

function selEls() {
  const els = contentAt(activeLayer(), S.cur);
  return S.sel.map((i) => els[i]).filter(Boolean);
}
function selBoxScreen() {
  const els = selEls(); if (!els.length) return null;
  const b = unionBox(els);
  const [x0, y0] = toScreen(b.x0, b.y0), [x1, y1] = toScreen(b.x1, b.y1);
  return { x0: x0 - 6, y0: y0 - 6, x1: x1 + 6, y1: y1 + 6, stage: b };
}
function drawSelection() {
  if (prefs.tool !== 'select') return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (marquee) {
    ctx.strokeStyle = '#ff7a45'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
    ctx.strokeRect(marquee.x0, marquee.y0, marquee.x1 - marquee.x0, marquee.y1 - marquee.y0);
    ctx.setLineDash([]);
  }
  const b = selBoxScreen(); if (!b) return;
  ctx.strokeStyle = '#ff7a45'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
  ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  ctx.setLineDash([]);
  const cx = (b.x0 + b.x1) / 2;
  ctx.beginPath(); ctx.moveTo(cx, b.y0); ctx.lineTo(cx, b.y0 - 26); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(cx, b.y0 - 30, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillRect(b.x1 - 8, b.y1 - 8, 16, 16); ctx.strokeRect(b.x1 - 8, b.y1 - 8, 16, 16);
}

/* ---------------------------------------------------------------- input */

const pointers = new Map();
let action = null, gesture = null, marquee = null;

function fingerDraws() {
  if (prefs.finger === 'draw') return true;
  if (prefs.finger === 'pan') return false;
  return !S.penSeen;
}
function localXY(e) { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

ov.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { ov.setPointerCapture(e.pointerId); } catch {}
  const [x, y] = localXY(e);
  pointers.set(e.pointerId, { x, y, type: e.pointerType, sx: x, sy: y });
  if (e.pointerType === 'pen' && !S.penSeen) { S.penSeen = true; }
  const touches = [...pointers.values()].filter((p) => p.type === 'touch');
  if (e.pointerType === 'touch' && touches.length >= 2) {
    if (action && action.touch) cancelAction();
    startGesture();
    return;
  }
  if (gesture) return;
  const panOnly = (e.pointerType === 'touch' && !fingerDraws()) || prefs.tool === 'hand' || e.button === 1 || spaceDown;
  if (panOnly) { startGesture(e.pointerId); return; }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (action) return;
  startAction(e, x, y);
});
ov.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId); if (!p) return;
  const [x, y] = localXY(e);
  p.x = x; p.y = y;
  if (gesture) { moveGesture(); return; }
  if (action && action.id === e.pointerId) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    moveAction(evs.length ? evs : [e]);
  }
});
const endPointer = (e) => {
  const p = pointers.get(e.pointerId); if (!p) return;
  pointers.delete(e.pointerId);
  if (gesture) {
    if (gesture.ids.includes(e.pointerId) && [...pointers.keys()].every((id) => !gesture.ids.includes(id))) endGesture();
    return;
  }
  if (action && action.id === e.pointerId) {
    if (e.type === 'pointercancel') cancelAction(); else endAction(e);
  }
};
ov.addEventListener('pointerup', endPointer);
ov.addEventListener('pointercancel', endPointer);
ov.addEventListener('contextmenu', (e) => e.preventDefault());

// Pan / pinch / multi-finger tap gestures.
function startGesture(singleId) {
  const ids = singleId != null ? [singleId] : [...pointers.entries()].filter(([, p]) => p.type === 'touch').map(([id]) => id);
  if (gesture) { gesture.ids = [...new Set([...gesture.ids, ...ids])]; gesture.maxFingers = Math.max(gesture.maxFingers, ids.length); gesture.base = null; return; }
  gesture = { ids, t0: performance.now(), moved: 0, maxFingers: ids.length, base: null };
}
function gestureCentroid() {
  const ps = gesture.ids.map((id) => pointers.get(id)).filter(Boolean);
  if (!ps.length) return null;
  const cx = ps.reduce((a, p) => a + p.x, 0) / ps.length, cy = ps.reduce((a, p) => a + p.y, 0) / ps.length;
  const d = ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
  return { cx, cy, d, n: ps.length };
}
function moveGesture() {
  const c = gestureCentroid(); if (!c) return;
  if (!gesture.base || gesture.base.n !== c.n) { gesture.base = { ...c, view: { ...S.view } }; return; }
  const b = gesture.base;
  gesture.moved = Math.max(gesture.moved, Math.hypot(c.cx - b.cx, c.cy - b.cy), Math.abs(c.d - b.d));
  let s = b.view.s;
  if (c.n > 1 && b.d > 10) s = clamp(b.view.s * (c.d / b.d), 0.05, 16);
  const sx = (b.cx - b.view.ox) / b.view.s, sy = (b.cy - b.view.oy) / b.view.s;
  S.view = { s, ox: c.cx - sx * s, oy: c.cy - sy * s };
  requestRender();
}
function endGesture() {
  const g = gesture; gesture = null;
  const dt = performance.now() - g.t0;
  if (dt < 300 && g.moved < 12 && g.maxFingers >= 2 && pointers.size === 0) {
    if (g.maxFingers === 2) undo(); else if (g.maxFingers >= 3) redo();
  }
}

ov.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [x, y] = localXY(e);
  if (e.ctrlKey || e.metaKey) {
    const s = clamp(S.view.s * Math.exp(-e.deltaY * 0.01), 0.05, 16);
    const sx = (x - S.view.ox) / S.view.s, sy = (y - S.view.oy) / S.view.s;
    S.view = { s, ox: x - sx * s, oy: y - sy * s };
  } else { S.view.ox -= e.deltaX; S.view.oy -= e.deltaY; }
  requestRender();
}, { passive: false });
// Safari trackpad pinch
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());

/* ---------------------------------------------------------------- tools */

const T = () => prefs.tools[prefs.tool] || {};
function pressureOf(e) {
  if (e.pointerType === 'pen') return clamp(e.pressure || 0.05, 0.05, 1);
  return 1;
}

function startAction(e, x, y) {
  const tool = prefs.tool;
  const [sx, sy] = toStage(x, y);
  action = { id: e.pointerId, tool, touch: e.pointerType === 'touch', x0: sx, y0: sy, sx: x, sy: y };
  if (tool === 'brush' || tool === 'pen') {
    if (!canEdit()) { action = null; return; }
    action.pts = [[sx, sy, pressureOf(e)]];
    action.last = [sx, sy];
    drawLive();
  } else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
    if (!canEdit()) { action = null; return; }
    action.x1 = sx; action.y1 = sy;
  } else if (tool === 'eraser') {
    if (!canEdit()) { action = null; return; }
    action.undoSnap = snap(); action.changed = false;
    action.last = [sx, sy];
    eraseAlong(sx, sy, sx, sy);
    drawEraserCursor(x, y);
  } else if (tool === 'fill') {
    // handled on pointer up (tap)
  } else if (tool === 'select') {
    startSelect(x, y, sx, sy);
  }
}
function moveAction(evs) {
  const a = action;
  for (const e of evs) {
    const [x, y] = localXY(e);
    const [sx, sy] = toStage(x, y);
    if (a.tool === 'brush' || a.tool === 'pen') {
      const sm = (T().smoothing ?? 0) / 100;
      const k = 1 - sm * 0.88;
      const nx = a.last[0] + (sx - a.last[0]) * k, ny = a.last[1] + (sy - a.last[1]) * k;
      const lp = a.pts[a.pts.length - 1];
      const minD = 0.8 / S.view.s;
      if (Math.hypot(nx - lp[0], ny - lp[1]) >= minD) a.pts.push([nx, ny, pressureOf(e)]);
      a.last = [nx, ny];
      a.raw = [sx, sy, pressureOf(e)];
    } else if (a.tool === 'line' || a.tool === 'rect' || a.tool === 'ellipse') {
      a.x1 = sx; a.y1 = sy;
    } else if (a.tool === 'eraser') {
      eraseAlong(a.last[0], a.last[1], sx, sy);
      a.last = [sx, sy];
      drawEraserCursor(x, y);
    } else if (a.tool === 'select') {
      moveSelect(x, y, sx, sy);
    }
  }
  if (a.tool !== 'eraser' && a.tool !== 'select') drawLive();
}
function endAction(e) {
  const a = action; action = null;
  clearOverlay();
  const [x, y] = localXY(e);
  const [sx, sy] = toStage(x, y);
  if (a.tool === 'brush' || a.tool === 'pen') {
    if (a.raw) { const lp = a.pts[a.pts.length - 1]; if (Math.hypot(a.raw[0] - lp[0], a.raw[1] - lp[1]) > 0.5 / S.view.s) a.pts.push(a.raw); }
    const el = makeStroke(a.pts);
    pushUndo();
    editableEls().push(el);
    changed(true);
  } else if (a.tool === 'line' || a.tool === 'rect' || a.tool === 'ellipse') {
    const el = makeShape(a);
    if (!el) return;
    pushUndo();
    editableEls().push(el);
    changed(true);
  } else if (a.tool === 'eraser') {
    if (a.changed) { S.undo.push(a.undoSnap); S.redo.length = 0; changed(true); }
  } else if (a.tool === 'fill') {
    if (!canEdit()) return;
    const els = contentAt(activeLayer(), S.cur);
    let idx = -1;
    for (let i = els.length - 1; i >= 0; i--) if (fillable(els[i], sx, sy)) { idx = i; break; }
    if (idx < 0) { toast('Tap inside a closed shape or loop to fill it'); return; }
    pushUndo();
    editableEls()[idx].f = prefs.color;
    changed(true);
  } else if (a.tool === 'select') {
    endSelect(a);
  }
}
function cancelAction() {
  const a = action; action = null;
  clearOverlay();
  if (!a) return;
  if (a.tool === 'eraser' && a.changed) { restore(a.undoSnap); changed(true); }
  if (a.tool === 'select' && a.started) { restore(a.undoSnap); S.undo.pop(); changed(true); }
  marquee = null;
  requestRender();
}

function makeStroke(pts) {
  const t = prefs.tool, o = T();
  return {
    t: 'b', pts: pts.map((p) => [round1(p[0]), round1(p[1]), Math.round(p[2] * 100) / 100]),
    c: prefs.color, w: o.size, pr: t === 'brush' ? !!o.pressure : false, a: (o.opacity ?? 100) / 100, f: null,
  };
}
const round1 = (v) => Math.round(v * 10) / 10;
function shapePts(a) {
  const { x0, y0, x1, y1 } = a;
  if (a.tool === 'line') return [[x0, y0], [x1, y1]];
  if (a.tool === 'rect') return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  const n = 72, out = [];
  for (let i = 0; i < n; i++) { const g = (i / n) * Math.PI * 2; out.push([cx + Math.cos(g) * rx, cy + Math.sin(g) * ry]); }
  return out;
}
function makeShape(a) {
  if (Math.hypot(a.x1 - a.x0, a.y1 - a.y0) < 2 / S.view.s) return null;
  const o = T();
  return {
    t: 'p', pts: shapePts(a).map((p) => [round1(p[0]), round1(p[1])]), c: prefs.color, w: o.size,
    cl: a.tool !== 'line', a: (o.opacity ?? 100) / 100, f: a.tool !== 'line' && prefs.shapeFill ? prefs.color : null,
  };
}
function clearOverlay() { octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, ov.width, ov.height); }
function drawLive() {
  const a = action; if (!a) return;
  clearOverlay();
  octx.save();
  setView(octx);
  octx.beginPath(); octx.rect(0, 0, S.proj.w, S.proj.h); octx.clip();
  if (a.tool === 'brush' || a.tool === 'pen') drawEl(octx, makeStroke(a.pts));
  else { const el = makeShape(a); if (el) drawEl(octx, el); }
  octx.restore();
}
function drawEraserCursor(x, y) {
  clearOverlay();
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.strokeStyle = 'rgba(255,122,69,.9)'; octx.lineWidth = 1.5;
  octx.beginPath(); octx.arc(x, y, (T().size / 2) * S.view.s, 0, Math.PI * 2); octx.stroke();
}
function eraseAlong(x0, y0, x1, y1) {
  const r = T().size / 2;
  const d = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(d / (r / 2)));
  const L = activeLayer();
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    const els = contentAt(L, S.cur);
    let touched = false;
    for (const el of els) {
      if (prefs.eraserMode === 'whole' ? hitEl(el, x, y, r) : eraseEl(el, x, y, r)) { touched = true; break; }
    }
    if (!touched) continue;
    const target = editableEls();
    const out = [];
    for (const el of target) {
      if (prefs.eraserMode === 'whole') { if (!hitEl(el, x, y, r)) out.push(el); }
      else { const res = eraseEl(el, x, y, r); if (res === null) out.push(el); else out.push(...res); }
    }
    target.length = 0; target.push(...out);
    action.changed = true;
  }
  if (action.changed) requestRender();
}

/* select tool */
function startSelect(x, y, sx, sy) {
  const a = action;
  const b = selBoxScreen();
  const L = activeLayer();
  if (b) {
    const cx = (b.x0 + b.x1) / 2;
    if (Math.hypot(x - cx, y - (b.y0 - 30)) < 20) a.mode = 'rotate';
    else if (Math.abs(x - b.x1) < 20 && Math.abs(y - b.y1) < 20) a.mode = 'scale';
    else if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) a.mode = 'move';
  }
  if (!a.mode) {
    const els = contentAt(L, S.cur);
    const tol = 8 / S.view.s;
    let hit = -1;
    if (L.visible) for (let i = els.length - 1; i >= 0; i--) if (hitEl(els[i], sx, sy, tol)) { hit = i; break; }
    if (hit >= 0) { S.sel = [hit]; a.mode = 'move'; }
    else { S.sel = []; a.mode = 'marquee'; marquee = { x0: x, y0: y, x1: x, y1: y }; updatePanel(); requestRender(); return; }
  }
  if (L.locked) { toast('This layer is locked.'); a.mode = 'none'; return; }
  a.undoSnap = snap();
  a.started = false;
  a.box = unionBox(selEls());
  a.orig = null;
  updatePanel();
  requestRender();
}
function moveSelect(x, y, sx, sy) {
  const a = action;
  if (a.mode === 'marquee') {
    marquee.x1 = x; marquee.y1 = y; requestRender(); return;
  }
  if (a.mode === 'none' || !a.mode) return;
  if (!a.started) {
    if (Math.hypot(x - a.sx, y - a.sy) < 3) return;
    a.started = true;
    S.undo.push(a.undoSnap); S.redo.length = 0;
    const els = editableEls();
    a.orig = S.sel.map((i) => cloneEl(els[i]));
  }
  const els = editableEls();
  const b = a.box, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  let fn, ws = 1;
  if (a.mode === 'move') { const dx = sx - a.x0, dy = sy - a.y0; fn = (px, py) => [px + dx, py + dy]; }
  else if (a.mode === 'scale') {
    const d0 = Math.hypot(a.x0 - b.x0, a.y0 - b.y0) || 1, d1 = Math.hypot(sx - b.x0, sy - b.y0);
    const f = Math.max(0.02, d1 / d0); ws = f;
    fn = (px, py) => [b.x0 + (px - b.x0) * f, b.y0 + (py - b.y0) * f];
  } else if (a.mode === 'rotate') {
    const g = Math.atan2(sy - cy, sx - cx) - Math.atan2(a.y0 - cy, a.x0 - cx);
    const c = Math.cos(g), s = Math.sin(g);
    fn = (px, py) => [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c];
  }
  S.sel.forEach((i, k) => { els[i] = mapPts(a.orig[k], fn, ws); });
  requestRender();
}
function endSelect(a) {
  if (a.mode === 'marquee') {
    const [x0, y0] = toStage(Math.min(marquee.x0, marquee.x1), Math.min(marquee.y0, marquee.y1));
    const [x1, y1] = toStage(Math.max(marquee.x0, marquee.x1), Math.max(marquee.y0, marquee.y1));
    marquee = null;
    const els = activeLayer().visible ? contentAt(activeLayer(), S.cur) : [];
    S.sel = [];
    els.forEach((el, i) => {
      if (el.pts.some((p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)) S.sel.push(i);
    });
    updatePanel(); requestRender();
    return;
  }
  if (a.started) changed(true); else requestRender();
}
function selOp(fn, needsSel = true) {
  if (needsSel && !S.sel.length) return toast('Select something first');
  if (!canEdit()) return;
  pushUndo();
  const els = editableEls();
  fn(els);
  changed(true);
}

/* ------------------------------------------------------------- timeline */

const grid = $('#tlGrid'), scroller = $('#tlScroll');
function cellWidth() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) || 22; }
function renderTimeline() {
  const p = S.proj;
  const total = Math.max(p.frameCount + 30, Math.ceil((scroller.clientWidth - 170) / cellWidth()) + 2);
  let h = '<div class="tlRow tlHead"><div class="tlName">' +
    `<button data-la="add" title="Add layer">${icon('plus')}</button>` +
    `<button data-la="del" title="Delete layer">${icon('trash')}</button>` +
    `<button data-la="up" title="Move layer up">${icon('up')}</button>` +
    `<button data-la="down" title="Move layer down">${icon('down')}</button></div>`;
  for (let f = 0; f < total; f++) {
    const cls = ['num'];
    if ((f + 1) % 5 === 0 || f === 0) cls.push('five');
    if (f >= p.frameCount) cls.push('out');
    h += `<div class="${cls.join(' ')}" data-f="${f}">${(f + 1) % 5 === 0 || f === 0 ? f + 1 : ''}</div>`;
  }
  h += '</div>';
  for (let li = p.layers.length - 1; li >= 0; li--) {
    const L = p.layers[li];
    h += `<div class="tlRow${li === S.layer ? ' active' : ''}" data-l="${li}"><div class="tlName">` +
      `<button class="vis${L.visible ? '' : ' off'}" data-lv="${li}" title="Show / hide">${icon(L.visible ? 'eye' : 'eyeoff')}</button>` +
      `<button class="lock${L.locked ? ' locked' : ''}" data-lk="${li}" title="Lock">${icon(L.locked ? 'lock' : 'unlock')}</button>` +
      `<span class="nm" data-ln="${li}">${esc(L.name)}</span></div>`;
    const keys = sortedKeys(L);
    let ki = -1;
    for (let f = 0; f < total; f++) {
      while (ki + 1 < keys.length && keys[ki + 1] <= f) ki++;
      const cls = ['c'];
      if (f >= p.frameCount) cls.push('out');
      else if (ki >= 0) {
        const k = keys[ki], kf = L.keys[k];
        const nk = ki + 1 < keys.length ? keys[ki + 1] : -1;
        if (k === f) cls.push(kf.els.length ? 'k' : 'ke');
        if (kf.tw && nk > 0 && f < nk) cls.push('tw');
        else if (kf.els.length) cls.push('h');
        const spanEnd = (nk > 0 ? Math.min(nk, p.frameCount) : p.frameCount) - 1;
        if (f === spanEnd && f !== k && kf.els.length) cls.push('end');
      }
      if ((f + 1) % 5 === 0) cls.push('f5');
      h += `<div class="${cls.join(' ')}" data-f="${f}"></div>`;
    }
    h += '</div>';
  }
  h += '<div id="playhead"></div><div id="cellSel"></div>';
  grid.innerHTML = h;
  grid.style.width = 170 + total * cellWidth() + 'px';
  updatePlayhead();
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function updatePlayhead(scrollIntoView = true) {
  const cw = cellWidth(), p = S.proj;
  const ph = $('#playhead'), cs = $('#cellSel');
  if (ph) ph.style.left = 170 + S.cur * cw + 'px';
  if (cs) {
    const row = p.layers.length - 1 - S.layer;
    cs.style.left = 170 + S.cur * cw + 'px';
    cs.style.top = 26 + row * 34 + 'px';
  }
  $('#frameInfo').textContent = `${S.cur + 1} / ${p.frameCount}`;
  if (scrollIntoView) {
    const x = 170 + S.cur * cw;
    if (x < scroller.scrollLeft + 170) scroller.scrollLeft = x - 170 - cw * 2;
    else if (x + cw > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = x + cw * 4 - scroller.clientWidth;
  }
  // timeline buttons that depend on the current frame
  const L = activeLayer(), k = keyAt(L, S.cur), kf = k >= 0 ? L.keys[k] : null;
  $('#tTween').classList.toggle('on', !!(kf && kf.tw));
  $('#tEase').hidden = !(kf && kf.tw);
  if (kf) $('#tEase').value = kf.ease || 'linear';
}
function goto(f, keepSel = false) {
  const p = S.proj;
  f = Math.max(0, f);
  if (f >= p.frameCount) p.frameCount = f + 1;
  if (S.cur !== f && !keepSel) S.sel = [];
  S.cur = f;
  updatePlayhead();
  updatePanel();
  requestRender();
}

// Tap on a cell / name; double-tap a name to rename.
let lastNameTap = { li: -1, t: 0 };
grid.addEventListener('click', (e) => {
  const t = e.target.closest('[data-la],[data-lv],[data-lk],[data-ln],[data-f]');
  if (!t) return;
  if (S.playing) stop();
  const p = S.proj;
  if (t.dataset.la) return layerAction(t.dataset.la);
  if (t.dataset.lv) { const L = p.layers[+t.dataset.lv]; L.visible = !L.visible; S.sel = []; return changed(true); }
  if (t.dataset.lk) { const L = p.layers[+t.dataset.lk]; L.locked = !L.locked; return changed(true); }
  if (t.dataset.ln) {
    const li = +t.dataset.ln, now = Date.now();
    if (lastNameTap.li === li && now - lastNameTap.t < 400) {
      const n = prompt('Layer name', p.layers[li].name);
      if (n && n.trim()) { p.layers[li].name = n.trim().slice(0, 40); changed(true); }
      lastNameTap = { li: -1, t: 0 };
      return;
    }
    lastNameTap = { li, t: now };
    if (S.layer !== li) { S.layer = li; S.sel = []; renderTimeline(); updatePanel(); requestRender(); }
    return;
  }
  const f = +t.dataset.f;
  const row = t.closest('[data-l]');
  if (row) { const li = +row.dataset.l; if (S.layer !== li) { S.layer = li; S.sel = []; } }
  const grew = f >= p.frameCount;
  goto(f);
  if (grew || row) renderTimeline();
});
// Scrub by dragging along the frame numbers.
let scrubbing = false;
grid.addEventListener('pointerdown', (e) => { if (e.target.closest('.tlHead .num')) { scrubbing = true; grid.setPointerCapture(e.pointerId); } });
grid.addEventListener('pointermove', (e) => {
  if (!scrubbing) return;
  const r = grid.getBoundingClientRect();
  const f = Math.floor((e.clientX - r.left - 170) / cellWidth());
  if (f >= 0 && f < S.proj.frameCount && f !== S.cur) goto(f);
});
grid.addEventListener('pointerup', () => { scrubbing = false; });
grid.addEventListener('pointercancel', () => { scrubbing = false; });

function layerAction(a) {
  const p = S.proj;
  if (a === 'add') {
    pushUndo();
    p.layers.splice(S.layer + 1, 0, { id: uid(), name: 'Layer ' + (p.layers.length + 1), visible: true, locked: false, keys: { 0: { els: [], tw: false } } });
    S.layer++;
  } else if (a === 'del') {
    if (p.layers.length === 1) return toast('An animation needs at least one layer');
    if (!confirm(`Delete “${activeLayer().name}”?`)) return;
    pushUndo();
    p.layers.splice(S.layer, 1);
    S.layer = clamp(S.layer, 0, p.layers.length - 1);
  } else if (a === 'up' || a === 'down') {
    const to = S.layer + (a === 'up' ? 1 : -1);
    if (to < 0 || to >= p.layers.length) return;
    pushUndo();
    const [L] = p.layers.splice(S.layer, 1); p.layers.splice(to, 0, L); S.layer = to;
  }
  S.sel = [];
  changed(true);
}

function frameOp(op) {
  if (S.playing) stop();
  const p = S.proj, L = activeLayer(), f = S.cur;
  if (L.locked && op !== 'tween') return toast('This layer is locked.');
  if (op === 'key') {
    if (L.keys[f]) return toast('This frame is already a keyframe');
    pushUndo();
    const k = keyAt(L, f), prev = k >= 0 ? L.keys[k] : null;
    L.keys[f] = { els: contentAt(L, f).map(cloneEl), tw: !!(prev && prev.tw && nextKey(L, f) > 0), ease: prev?.ease };
  } else if (op === 'blank') {
    pushUndo();
    L.keys[f] = { els: [], tw: false };
  } else if (op === 'newblank') {
    pushUndo();
    const nf = f + 1;
    // Make sure the drawing on this frame holds just one frame, then start fresh.
    if (nf >= p.frameCount) p.frameCount = nf + 1;
    if (!L.keys[nf]) L.keys[nf] = { els: [], tw: false };
    S.cur = nf; S.sel = [];
  } else if (op === 'insert') {
    pushUndo();
    const nk = {};
    for (const k of sortedKeys(L)) nk[k > f ? k + 1 : k] = L.keys[k];
    L.keys = nk;
    p.frameCount++;
  } else if (op === 'delete') {
    pushUndo();
    const nk = {};
    for (const k of sortedKeys(L)) {
      if (k === f) continue;
      nk[k > f ? k - 1 : k] = L.keys[k];
    }
    if (!nk[0]) nk[0] = { els: [], tw: false };
    L.keys = nk;
    // shrink the timeline if every layer ends earlier
    const lastKey = Math.max(...p.layers.map((l) => Math.max(...sortedKeys(l))));
    p.frameCount = Math.max(1, lastKey + 1, p.frameCount - 1);
    S.cur = Math.min(S.cur, p.frameCount - 1);
  } else if (op === 'tween') {
    const k = keyAt(L, f);
    if (k < 0) return;
    if (nextKey(L, k) < 0) return toast('Make a second keyframe later in this layer first, then tween between them');
    pushUndo();
    L.keys[k].tw = !L.keys[k].tw;
    if (L.keys[k].tw) toast('Tween on: the frames in between are drawn for you');
  }
  changed(true);
}

/* ------------------------------------------------------------- playback */

let playRaf = 0, playT0 = 0, playF0 = 0;
function play() {
  const p = S.proj;
  if (p.frameCount < 2) return toast('Add more frames to play');
  S.playing = true; S.sel = [];
  if (S.cur >= p.frameCount - 1) S.cur = 0;
  playT0 = performance.now(); playF0 = S.cur;
  $('#tPlay').innerHTML = icon('pause');
  const tick = (now) => {
    if (!S.playing) return;
    let f = playF0 + Math.floor(((now - playT0) / 1000) * p.fps);
    if (f >= p.frameCount) {
      if (prefs.loop) { playT0 = now; playF0 = 0; f = 0; }
      else { S.cur = p.frameCount - 1; stop(); return; }
    }
    if (f !== S.cur) { S.cur = f; updatePlayhead(); render(); }
    playRaf = requestAnimationFrame(tick);
  };
  render();
  playRaf = requestAnimationFrame(tick);
}
function stop() {
  S.playing = false; cancelAnimationFrame(playRaf);
  $('#tPlay').innerHTML = icon('play');
  updatePlayhead(); requestRender();
}
const togglePlay = () => (S.playing ? stop() : play());

/* ---------------------------------------------------------------- panel */

const TOOLS = [
  ['brush', 'Brush (B)'], ['pen', 'Pen — even line (N)'], ['eraser', 'Eraser (E)'], '-',
  ['select', 'Select & move (V)'], ['fill', 'Fill (K)'], '-',
  ['line', 'Line (L)'], ['rect', 'Rectangle (R)'], ['ellipse', 'Ellipse (O)'], '-', ['hand', 'Move view (H)'],
];
function buildTools() {
  $('#tools').innerHTML = TOOLS.map((t) => (t === '-' ? '<div class="tsep"></div>' : `<button data-tool="${t[0]}" title="${t[1]}">${icon(t[0])}</button>`)).join('');
  $('#tools').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
}
function setTool(t) {
  if (prefs.tool !== t) { S.sel = []; marquee = null; }
  prefs.tool = t; savePrefs();
  document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  updatePanel(); requestRender();
}
function show(id, on) { $(id).hidden = !on; }
function updatePanel() {
  const t = prefs.tool, o = T();
  show('#secSize', 'size' in o);
  show('#secOpacity', 'opacity' in o);
  show('#secSmooth', 'smoothing' in o);
  show('#secPressure', t === 'brush');
  show('#secShapeFill', t === 'rect' || t === 'ellipse');
  show('#secEraser', t === 'eraser');
  show('#secSel', t === 'select');
  show('#secFillHint', t === 'fill');
  show('#secHandHint', t === 'hand');
  show('#secColor', t !== 'eraser' && t !== 'hand');
  if ('size' in o) { $('#size').value = o.size; $('#sizeVal').textContent = o.size + ' px'; }
  if ('opacity' in o) { $('#opacity').value = o.opacity; $('#opVal').textContent = o.opacity + '%'; }
  if ('smoothing' in o) { $('#smoothing').value = o.smoothing; $('#smVal').textContent = o.smoothing + '%'; }
  $('#pressure').checked = !!prefs.tools.brush.pressure;
  $('#shapeFill').checked = !!prefs.shapeFill;
  document.querySelectorAll('#eraserMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.eraserMode));
  $('#selCount').textContent = S.sel.length ? `${S.sel.length} item${S.sel.length > 1 ? 's' : ''}` : 'none';
  $('#selPaste').disabled = !S.clipboard;
  ['#selDelete', '#selDup', '#selCopy', '#selFlipH', '#selFlipV', '#selFront', '#selBack', '#selColor'].forEach((id) => { $(id).disabled = !S.sel.length; });
  $('#curColor').style.background = prefs.color;
  $('#colorInput').value = prefs.color;
  document.querySelectorAll('.sw').forEach((s) => s.classList.toggle('cur', s.dataset.c === prefs.color));
  $('#tOnion').classList.toggle('on', prefs.onion);
  $('#tLoop').classList.toggle('on', prefs.loop);
  $('#fps').value = S.proj.fps;
  $('#projName').textContent = S.proj.name;
}
function setColor(c, addRecent = true) {
  prefs.color = c.toLowerCase();
  if (addRecent && !PALETTE.includes(prefs.color)) {
    prefs.recent = [prefs.color, ...prefs.recent.filter((x) => x !== prefs.color)].slice(0, 8);
    renderRecent();
  }
  savePrefs(); updatePanel();
}
function renderRecent() {
  $('#recent').innerHTML = prefs.recent.map((c) => `<button class="sw" data-c="${c}" style="background:${c}"></button>`).join('');
}
function buildPanel() {
  $('#palette').innerHTML = PALETTE.map((c) => `<button class="sw" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
  renderRecent();
  $('#panel').addEventListener('click', (e) => { const s = e.target.closest('.sw'); if (s) setColor(s.dataset.c, false); });
  $('#colorInput').addEventListener('input', (e) => { prefs.color = e.target.value; $('#curColor').style.background = prefs.color; });
  $('#colorInput').addEventListener('change', (e) => setColor(e.target.value));
  const bindRange = (id, key) => $(id).addEventListener('input', (e) => { T()[key] = +e.target.value; savePrefs(); updatePanel(); });
  bindRange('#size', 'size'); bindRange('#opacity', 'opacity'); bindRange('#smoothing', 'smoothing');
  $('#pressure').addEventListener('change', (e) => { prefs.tools.brush.pressure = e.target.checked; savePrefs(); });
  $('#shapeFill').addEventListener('change', (e) => { prefs.shapeFill = e.target.checked; savePrefs(); });
  $('#eraserMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { prefs.eraserMode = b.dataset.v; savePrefs(); updatePanel(); } });

  $('#selDelete').onclick = () => selOp((els) => { const s = new Set(S.sel); const keep = els.filter((_, i) => !s.has(i)); els.length = 0; els.push(...keep); S.sel = []; });
  $('#selDup').onclick = () => selOp((els) => {
    const d = 20 / S.view.s;
    const copies = S.sel.map((i) => mapPts(els[i], (x, y) => [x + d, y + d]));
    const start = els.length; els.push(...copies); S.sel = copies.map((_, k) => start + k);
  });
  $('#selCopy').onclick = () => { if (!S.sel.length) return; S.clipboard = selEls().map(cloneEl); toast('Copied. Go to another frame and tap Paste.'); updatePanel(); };
  $('#selPaste').onclick = () => { if (!S.clipboard) return; selOp((els) => { const start = els.length; els.push(...S.clipboard.map(cloneEl)); S.sel = S.clipboard.map((_, k) => start + k); }, false); };
  const flip = (h) => selOp((els) => {
    const b = unionBox(S.sel.map((i) => els[i])), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    S.sel.forEach((i) => { els[i] = mapPts(els[i], (x, y) => (h ? [2 * cx - x, y] : [x, 2 * cy - y])); });
  });
  $('#selFlipH').onclick = () => flip(true);
  $('#selFlipV').onclick = () => flip(false);
  const order = (front) => selOp((els) => {
    const s = new Set(S.sel), picked = S.sel.slice().sort((a, b) => a - b).map((i) => els[i]);
    const rest = els.filter((_, i) => !s.has(i));
    els.length = 0;
    if (front) { els.push(...rest, ...picked); S.sel = picked.map((_, k) => rest.length + k); }
    else { els.push(...picked, ...rest); S.sel = picked.map((_, k) => k); }
  });
  $('#selFront').onclick = () => order(true);
  $('#selBack').onclick = () => order(false);
  $('#selAll').onclick = () => { S.sel = contentAt(activeLayer(), S.cur).map((_, i) => i); updatePanel(); requestRender(); };
  $('#selColor').onclick = () => selOp((els) => { S.sel.forEach((i) => { els[i] = { ...els[i], c: prefs.color, f: els[i].f ? prefs.color : null }; }); });
}

/* ---------------------------------------------------------- toast/dialogs */

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});

/* projects */
async function openProjects() {
  await saveNow();
  const list = await DB.listMeta();
  $('#pList').innerHTML = list.map((m) => `
    <div class="pItem${m.id === S.proj.id ? ' cur' : ''}" data-id="${m.id}">
      <img src="${m.thumb || ''}" alt="" data-open="${m.id}">
      <div class="pn">${esc(m.name)}</div>
      <div class="pd">${m.frames || 1} frames · ${new Date(m.updated).toLocaleDateString()}</div>
      <div class="pa"><button data-open="${m.id}">Open</button><button data-dup="${m.id}">Copy</button><button data-save="${m.id}">Save file</button><button data-del="${m.id}">Delete</button></div>
    </div>`).join('') || '<p class="hint">No animations yet.</p>';
  $('#dlgProjects').showModal();
}
$('#pList').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-open],[data-dup],[data-del],[data-save]'); if (!t) return;
  if (t.dataset.open) { await loadById(t.dataset.open); $('#dlgProjects').close(); }
  else if (t.dataset.dup) {
    const p = await DB.loadProject(t.dataset.dup);
    const c = { ...JSON.parse(JSON.stringify(p)), id: uid(), name: p.name + ' copy', updated: Date.now() };
    await setProject(c); await saveNow(); openProjects();
  } else if (t.dataset.save) {
    const p = await DB.loadProject(t.dataset.save);
    shareBlob(new Blob([JSON.stringify(p)], { type: 'application/json' }), safeName(p.name) + '.inkframe');
  } else if (t.dataset.del) {
    if (!confirm('Delete this animation? This can’t be undone.')) return;
    await DB.deleteProject(t.dataset.del);
    if (t.dataset.del === S.proj.id) {
      const list = await DB.listMeta();
      if (list.length) await loadById(list[0].id); else { await setProject(newProject()); await saveNow(); }
    }
    openProjects();
  }
});
$('#pNew').onclick = async () => { await saveNow(); await setProject(newProject()); await saveNow(); $('#dlgProjects').close(); toast('New animation'); };
$('#pImport').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const p = JSON.parse(await file.text());
    if (!p.layers || !p.w) throw new Error('bad');
    p.id = uid(); p.updated = Date.now();
    await saveNow(); await setProject(p); await saveNow();
    $('#dlgProjects').close(); toast('Opened ' + p.name);
  } catch { toast('That file isn’t an Inkframe project'); }
});
async function loadById(id) {
  await saveNow();
  const p = await DB.loadProject(id);
  if (p) await setProject(p);
}
async function setProject(p) {
  if (S.playing) stop();
  S.proj = p; S.cur = 0; S.layer = Math.max(0, p.layers.length - 1); S.sel = []; S.undo = []; S.redo = [];
  fit(); renderTimeline(); updatePanel(); updateUndoButtons(); requestRender();
}

/* settings */
function openSettings() {
  const p = S.proj;
  $('#sName').value = p.name;
  const key = `${p.w}x${p.h}`;
  $('#sPreset').value = [...$('#sPreset').options].some((o) => o.value === key) ? key : 'custom';
  $('#sW').value = p.w; $('#sH').value = p.h;
  $('#sCustom').hidden = $('#sPreset').value !== 'custom';
  $('#sFps').value = p.fps; $('#sLen').value = p.frameCount; $('#sBg').value = p.bg;
  $('#sFinger').value = prefs.finger; $('#sAutoKey').checked = prefs.autoKey;
  $('#sOnPrev').value = prefs.onionPrev; $('#sOnNext').value = prefs.onionNext;
  $('#dlgSettings').showModal();
}
$('#sPreset').addEventListener('change', (e) => {
  $('#sCustom').hidden = e.target.value !== 'custom';
  if (e.target.value !== 'custom') { const [w, h] = e.target.value.split('x'); $('#sW').value = w; $('#sH').value = h; }
});
$('#sApply').onclick = () => {
  const p = S.proj;
  const nw = clamp(+$('#sW').value || p.w, 16, 4096), nh = clamp(+$('#sH').value || p.h, 16, 4096);
  const len = clamp(Math.round(+$('#sLen').value || p.frameCount), 1, 2000);
  const sizeChanged = nw !== p.w || nh !== p.h;
  if (len !== p.frameCount || sizeChanged) pushUndo();
  p.name = ($('#sName').value || 'Untitled').trim().slice(0, 60);
  p.w = nw; p.h = nh;
  p.fps = clamp(Math.round(+$('#sFps').value || 12), 1, 60);
  p.frameCount = len; S.cur = Math.min(S.cur, len - 1);
  p.bg = $('#sBg').value;
  prefs.finger = $('#sFinger').value; prefs.autoKey = $('#sAutoKey').checked;
  prefs.onionPrev = clamp(+$('#sOnPrev').value, 0, 5); prefs.onionNext = clamp(+$('#sOnNext').value, 0, 5);
  savePrefs();
  $('#dlgSettings').close();
  if (sizeChanged) fit();
  changed(true);
};

/* -------------------------------------------------------------- export */

const safeName = (s) => (s || 'animation').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'animation';
let exportResult = null;

function renderFrameCanvas(f, scale, transparent = false) {
  const p = S.proj;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(p.w * scale)); c.height = Math.max(1, Math.round(p.h * scale));
  const x = c.getContext('2d');
  x.setTransform(scale, 0, 0, scale, 0, 0);
  drawFrame(x, f, !transparent);
  return c;
}
const canvasBlob = (c, type = 'image/png') => new Promise((r) => c.toBlob(r, type));

function frameSVG(f, withBg = true) {
  const p = S.proj;
  let s = withBg ? `<rect width="${p.w}" height="${p.h}" fill="${p.bg}"/>` : '';
  for (const L of p.layers) if (L.visible) for (const el of contentAt(L, f)) s += elSVG(el);
  return s;
}
function svgDoc(inner) {
  const p = S.proj;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${p.w}" height="${p.h}" viewBox="0 0 ${p.w} ${p.h}">${inner}</svg>`;
}
function animatedSVG() {
  const p = S.proj, n = p.frameCount, dur = n / p.fps;
  let s = `<rect width="${p.w}" height="${p.h}" fill="${p.bg}"/>`;
  for (let f = 0; f < n; f++) {
    const vals = Array.from({ length: n }, (_, i) => (i === f ? 'inline' : 'none')).join(';');
    const times = Array.from({ length: n }, (_, i) => (i / n).toFixed(5)).join(';');
    s += `<g display="${f === 0 ? 'inline' : 'none'}"><animate attributeName="display" values="${vals}" keyTimes="${times}" dur="${dur}s" calcMode="discrete" repeatCount="indefinite"/>${frameSVG(f, false)}</g>`;
  }
  return svgDoc(s);
}
function pickVideoType() {
  if (!window.MediaRecorder) return null;
  for (const t of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {}
  }
  return null;
}
async function encodeMP4(scale, onProgress) {
  if (!window.VideoEncoder || !window.VideoFrame) return null;
  const p = S.proj;
  const width = Math.max(2, Math.round((p.w * scale) / 2) * 2), height = Math.max(2, Math.round((p.h * scale) / 2) * 2);
  let codec = null;
  for (const c of ['avc1.640033', 'avc1.640028', 'avc1.4d0033', 'avc1.4d0028', 'avc1.42e01f']) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c, width, height, bitrate: 6_000_000, framerate: p.fps });
      if (r.supported) { codec = c; break; }
    } catch {}
  }
  if (!codec) return null;
  const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer.mjs');
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height, frameRate: p.fps }, fastStart: 'in-memory' });
  let failure = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  enc.configure({ codec, width, height, bitrate: Math.min(12_000_000, Math.max(1_500_000, width * height * 4)), framerate: p.fps, avc: { format: 'avc' } });
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const x = c.getContext('2d');
  const dur = 1e6 / p.fps;
  for (let f = 0; f < p.frameCount; f++) {
    if (failure) throw failure;
    x.setTransform(width / p.w, 0, 0, height / p.h, 0, 0);
    drawFrame(x, f, true);
    const frame = new VideoFrame(c, { timestamp: Math.round(f * dur), duration: Math.round(dur) });
    enc.encode(frame, { keyFrame: f % (p.fps * 2) === 0 });
    frame.close();
    while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
    onProgress((f + 1) / p.frameCount);
    if (f % 3 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush();
  if (failure) throw failure;
  muxer.finalize();
  enc.close();
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4' };
}
async function recordVideo(scale, onProgress) {
  const type = pickVideoType();
  if (!type) throw new Error('Video export isn’t supported in this browser. Try GIF instead.');
  const p = S.proj;
  const c = document.createElement('canvas');
  c.width = Math.round((p.w * scale) / 2) * 2; c.height = Math.round((p.h * scale) / 2) * 2;
  const x = c.getContext('2d');
  const draw = (f) => { x.setTransform(c.width / p.w, 0, 0, c.height / p.h, 0, 0); drawFrame(x, f, true); };
  draw(0);
  const stream = c.captureStream(p.fps);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start(250);
  const t0 = performance.now(), frameMs = 1000 / p.fps;
  for (let f = 0; f < p.frameCount; f++) {
    draw(f);
    onProgress((f + 1) / p.frameCount);
    const target = t0 + (f + 1) * frameMs;
    await new Promise((r) => setTimeout(r, Math.max(0, target - performance.now())));
  }
  rec.stop();
  stream.getTracks().forEach((t) => t.stop());
  await done;
  return { blob: new Blob(chunks, { type: type.split(';')[0] }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}

async function runExport() {
  const fmt = document.querySelector('input[name=fmt]:checked').value;
  const scale = +$('#exScale').value, transparent = $('#exTransparent').checked;
  const p = S.proj, base = safeName(p.name);
  if (S.playing) stop();
  $('#exChoose').hidden = true; $('#exWork').hidden = false; $('#exDone').hidden = true;
  const prog = (v, msg) => { $('#exBar').style.width = Math.round(v * 100) + '%'; if (msg) $('#exStatus').textContent = msg; };
  prog(0, 'Working…');
  try {
    let blob, name, preview = 'img';
    if (fmt === 'gif') {
      const frames = [];
      for (let f = 0; f < p.frameCount; f++) {
        const c = renderFrameCanvas(f, scale);
        frames.push(c.getContext('2d').getImageData(0, 0, c.width, c.height));
        prog((f + 1) / p.frameCount * 0.3, `Drawing frame ${f + 1} of ${p.frameCount}…`);
        if (f % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      blob = await encodeGIF(frames, p.fps, (v) => prog(0.3 + v * 0.7, 'Making GIF…'));
      name = base + '.gif';
    } else if (fmt === 'video') {
      prog(0, 'Making video…');
      let r = null;
      try { r = await encodeMP4(scale, (v) => prog(v)); } catch (e) { console.warn('WebCodecs failed, falling back', e); }
      if (!r) { prog(0, 'Recording video in real time…'); r = await recordVideo(scale, (v) => prog(v)); }
      blob = r.blob; name = `${base}.${r.ext}`; preview = 'video';
    } else if (fmt === 'pngseq') {
      const files = [];
      const digits = String(p.frameCount).length;
      for (let f = 0; f < p.frameCount; f++) {
        const b = await canvasBlob(renderFrameCanvas(f, scale, transparent));
        files.push({ name: `${base}_${String(f + 1).padStart(Math.max(4, digits), '0')}.png`, data: new Uint8Array(await b.arrayBuffer()) });
        prog((f + 1) / p.frameCount, `Frame ${f + 1} of ${p.frameCount}…`);
      }
      blob = makeZip(files); name = base + '-frames.zip'; preview = null;
    } else if (fmt === 'png') {
      blob = await canvasBlob(renderFrameCanvas(S.cur, scale, transparent));
      name = `${base}-frame${S.cur + 1}.png`;
    } else if (fmt === 'svg') {
      blob = new Blob([svgDoc(frameSVG(S.cur))], { type: 'image/svg+xml' });
      name = `${base}-frame${S.cur + 1}.svg`;
    } else if (fmt === 'svganim') {
      blob = new Blob([animatedSVG()], { type: 'image/svg+xml' });
      name = base + '.svg';
    } else if (fmt === 'project') {
      blob = new Blob([JSON.stringify(p)], { type: 'application/json' });
      name = base + '.inkframe'; preview = null;
    }
    prog(1);
    showExportResult(blob, name, preview);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Export failed');
    $('#exChoose').hidden = false; $('#exWork').hidden = true;
  }
}
function showExportResult(blob, name, preview) {
  if (exportResult) URL.revokeObjectURL(exportResult.url);
  const url = URL.createObjectURL(blob);
  exportResult = { blob, name, url };
  $('#exWork').hidden = true; $('#exDone').hidden = false;
  $('#exPreview').innerHTML = preview === 'img' ? `<img src="${url}" alt="">` : preview === 'video' ? `<video src="${url}" autoplay loop muted playsinline controls></video>` : '';
  $('#exPreview').hidden = !preview;
  $('#exInfo').textContent = `${name} · ${(blob.size / 1024 / 1024).toFixed(blob.size > 1e6 ? 1 : 2)} MB`;
  const a = $('#exDownload'); a.href = url; a.download = name;
  $('#exShare').hidden = !canShareFiles(blob, name);
}
function canShareFiles(blob, name) {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: blob.type })] })); } catch { return false; }
}
async function shareBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (canShareFiles(blob, name)) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
$('#exShare').onclick = () => exportResult && shareBlob(exportResult.blob, exportResult.name);
$('#exBack').onclick = () => { $('#exChoose').hidden = false; $('#exDone').hidden = true; };
$('#exGo').onclick = runExport;
function openExport() {
  $('#exChoose').hidden = false; $('#exWork').hidden = true; $('#exDone').hidden = true;
  const vt = pickVideoType();
  $('#vidDesc').textContent = window.VideoEncoder ? 'MP4 video, ready for any app or social site' : vt ? `${vt.includes('mp4') ? 'MP4' : 'WebM'} video. Records in real time, so it takes as long as the animation.` : 'Not supported in this browser';
  $('#dlgExport').showModal();
}

/* ------------------------------------------------------------ keyboard */

let spaceDown = false;
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'c') { $('#selCopy').click(); return; }
  if (mod && k === 'v') { e.preventDefault(); $('#selPaste').click(); return; }
  if (mod && k === 'a') { e.preventDefault(); setTool('select'); $('#selAll').click(); return; }
  if (mod) return;
  const map = { b: 'brush', n: 'pen', e: 'eraser', v: 'select', k: 'fill', l: 'line', r: 'rect', o: 'ellipse', h: 'hand' };
  if (map[k]) { setTool(map[k]); return; }
  if (k === ' ') { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
  if (k === ',' || k === 'arrowleft') { goto(S.cur - 1 < 0 ? S.proj.frameCount - 1 : S.cur - 1); return; }
  if (k === '.' || k === 'arrowright') { goto(S.cur + 1 >= S.proj.frameCount ? 0 : S.cur + 1); return; }
  if ((k === 'delete' || k === 'backspace') && S.sel.length) { $('#selDelete').click(); return; }
  if (e.key === 'F6') { e.preventDefault(); frameOp('key'); }
  if (e.key === 'F7') { e.preventDefault(); frameOp('blank'); }
  if (e.key === 'F5') { e.preventDefault(); frameOp('insert'); }
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });

/* --------------------------------------------------------------- wiring */

function wire() {
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#btnFit').onclick = fit;
  $('#btnProjects').onclick = openProjects;
  $('#btnSettings').onclick = openSettings;
  $('#projName').onclick = openSettings;
  $('#btnExport').onclick = openExport;
  $('#btnHelp').onclick = () => $('#dlgHelp').showModal();
  $('#tPlay').onclick = togglePlay;
  $('#tPrev').onclick = () => { if (S.playing) stop(); goto(S.cur > 0 ? S.cur - 1 : S.proj.frameCount - 1); };
  $('#tNext').onclick = () => { if (S.playing) stop(); goto(S.cur + 1 < S.proj.frameCount ? S.cur + 1 : 0); };
  $('#tFirst').onclick = () => { if (S.playing) stop(); goto(0); };
  $('#tLast').onclick = () => { if (S.playing) stop(); goto(S.proj.frameCount - 1); };
  $('#tKey').onclick = () => frameOp('key');
  $('#tBlank').onclick = () => frameOp('blank');
  $('#tNew').onclick = () => frameOp('newblank');
  $('#tInsert').onclick = () => frameOp('insert');
  $('#tDelete').onclick = () => frameOp('delete');
  $('#tTween').onclick = () => frameOp('tween');
  $('#tEase').onchange = (e) => {
    const L = activeLayer(), k = keyAt(L, S.cur); if (k < 0) return;
    pushUndo(); L.keys[k].ease = e.target.value; changed(true);
  };
  $('#tOnion').onclick = () => { prefs.onion = !prefs.onion; savePrefs(); updatePanel(); requestRender(); };
  $('#tLoop').onclick = () => { prefs.loop = !prefs.loop; savePrefs(); updatePanel(); requestRender(); };
  $('#fps').addEventListener('change', (e) => { S.proj.fps = clamp(Math.round(+e.target.value || 12), 1, 60); changed(false); });
  new ResizeObserver(() => { resize(); }).observe(wrap);
  window.addEventListener('resize', () => setTimeout(renderTimeline, 50));
}

async function init() {
  fillIcons();
  buildTools();
  buildPanel();
  wire();
  let p = null;
  try {
    const last = localStorage.getItem('inkframe.last');
    if (last) p = await DB.loadProject(last);
    if (!p) { const list = await DB.listMeta(); if (list.length) p = await DB.loadProject(list[0].id); }
  } catch (e) { console.warn(e); }
  if (!p) p = newProject('My first animation');
  S.proj = p;
  S.layer = p.layers.length - 1;
  resize();
  fit();
  setTool(prefs.tool);
  renderTimeline();
  updatePanel();
  updateUndoButtons();
  if (!prefs.helpSeen) { prefs.helpSeen = true; savePrefs(); $('#dlgHelp').showModal(); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
