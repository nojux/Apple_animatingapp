import { icon, fillIcons } from './icons.js';
import {
  drawEl, elSVG, bbox, unionBox, hitEl, fillable, eraseEl, interpolate, EASES, mapPts, cloneEl, setImageSource,
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
    onion: true, onionLayers: 'all', onionFront: false, onionOpacity: 35, frameScope: 'layer', loop: true, eraserMode: 'partial', shapeFill: false, helpSeen: false,
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

// A new animation starts as an unsaved draft (DB.DRAFT_ID). The first Save names it and gives it
// its own id; after that every change is saved to that same animation automatically.
function newProject(name = 'Untitled animation') {
  return {
    id: DB.DRAFT_ID, name, w: 1920, h: 1080, fps: 12, bg: '#ffffff', frameCount: 24,
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
  if (L.keys[f]) { delete L.keys[f].auto; return L.keys[f].els; }
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

// Undo entries. Most edits (strokes, shapes, eraser, fill, selection) only touch one keyframe of
// one layer, so they store just that keyframe ("key" entries). Copying the whole animation on
// every stroke made drawing lag on long animations. Timeline and settings changes store everything.
const snapFull = () => ({ k: 'full', d: JSON.stringify({ layers: S.proj.layers, frameCount: S.proj.frameCount }) });
function snapKey(layerId = activeLayer().id, f = S.cur) {
  const L = S.proj.layers.find((x) => x.id === layerId);
  if (!L) return snapFull();
  return { k: 'key', l: layerId, f, d: L.keys[f] ? JSON.stringify(L.keys[f]) : null, fc: S.proj.frameCount };
}
const snap = (scope) => (scope === 'key' ? snapKey() : snapFull());
// The opposite entry for undo/redo: the current state of whatever `e` would overwrite.
const counterpart = (e) => (e.k === 'key' ? snapKey(e.l, e.f) : snapFull());
function addUndo(entry) {
  S.undo.push(entry);
  if (S.undo.length > 80) S.undo.shift();
  S.redo.length = 0;
  editScope = entry.k;
  updateUndoButtons();
}
function pushUndo(scope) { addUndo(snap(scope)); }
function restore(e) {
  if (e.k === 'key') {
    const L = S.proj.layers.find((x) => x.id === e.l);
    if (L) { if (e.d) L.keys[e.f] = JSON.parse(e.d); else delete L.keys[e.f]; }
    S.proj.frameCount = e.fc;
    editScope = 'key';
  } else {
    const d = JSON.parse(e.d);
    S.proj.layers = d.layers; S.proj.frameCount = d.frameCount;
    editScope = 'full';
  }
  S.cur = Math.min(S.cur, S.proj.frameCount - 1);
  S.layer = clamp(S.layer, 0, S.proj.layers.length - 1);
  S.sel = []; S.range = null;
}
function undo() {
  if (!S.undo.length) return toast('Nothing to undo');
  const e = S.undo.pop(); S.redo.push(counterpart(e)); restore(e); changed(true);
}
function redo() {
  if (!S.redo.length) return toast('Nothing to redo');
  const e = S.redo.pop(); S.undo.push(counterpart(e)); restore(e); changed(true);
}
function updateUndoButtons() {
  $('#btnUndo').disabled = !S.undo.length;
  $('#btnRedo').disabled = !S.redo.length;
}

/* Saving.
   Each keyframe is stored as its own JSON string, cached until that keyframe is edited, so an
   autosave only re-encodes what changed. Copying a string into storage is fast; copying a whole
   animation's worth of stroke points froze drawing for a second or more on long animations. */
let keyCache = new WeakMap(); // keyframe object -> JSON string
let editScope = 'full'; // what the latest undo step covers: 'key' (current keyframe) or 'full'
function invalidateEdited() {
  if (editScope === 'key') {
    const L = activeLayer();
    if (L) { keyCache.delete(L.keys[S.cur]); keyCache.delete(L.keys[keyAt(L, S.cur)]); }
  } else keyCache = new WeakMap();
}
function packProject(p) {
  return {
    ...p,
    fmt: 2,
    layers: p.layers.map(({ keys, ...L }) => {
      const packed = {};
      for (const f in keys) {
        const kf = keys[f];
        let str = keyCache.get(kf);
        if (str === undefined) { str = JSON.stringify(kf); keyCache.set(kf, str); }
        packed[f] = str;
      }
      return { ...L, packed };
    }),
  };
}

let saveTimer = null;
function changed(structure = true) {
  S.proj.updated = Date.now();
  invalidateEdited();
  if (structure) renderTimeline(); else updatePlayhead();
  updateUndoButtons();
  updatePanel();
  requestRender();
  markDirty();
}
function markDirty() {
  S.dirty = true; S.thumbStale = true;
  if (S.saveState !== 'error') setSaveState(isDraft() ? 'draft' : 'pending');
  scheduleSave(1500);
}
// Autosave once drawing pauses: never while the Pencil or a finger is down on the canvas.
function scheduleSave(ms) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (action || gesture) return scheduleSave(600);
    if (window.requestIdleCallback) requestIdleCallback(() => { if (action || gesture) scheduleSave(600); else saveNow(); }, { timeout: 1000 });
    else saveNow();
  }, ms);
}
const isDraft = () => S.proj.id === DB.DRAFT_ID;
const draftHasWork = () => isDraft() && S.proj.updated > S.proj.created;
// The list thumbnail is only redrawn when you leave the animation or open the list, not on every autosave.
function projMeta(p, freshThumb) {
  if (freshThumb || !S.thumb) { S.thumb = thumbnail(); S.thumbStale = false; }
  return { id: p.id, name: p.name, updated: p.updated, frames: p.frameCount, thumb: S.thumb };
}
function rememberLast(id) { try { localStorage.setItem('inkframe.last', id); } catch {} }

// Saves run one after another, so a slow save can never land after (and overwrite) a newer one.
let saveChain = Promise.resolve(true);
function queueSave(job) {
  const run = saveChain.then(job, job);
  saveChain = run.catch(() => false);
  return run;
}
// Write the current animation if it has unsaved changes. Resolves true when everything is stored.
// final: also refresh the list thumbnail (leaving the animation, opening the list, app going away).
function saveNow(final = false) {
  clearTimeout(saveTimer);
  return queueSave(async () => {
    const p = S.proj;
    if (!p) return true;
    const thumbOnly = !S.dirty && final && S.thumbStale && !isDraft();
    if (!S.dirty && !thumbOnly) return S.saveState !== 'error';
    S.dirty = false;
    if (!thumbOnly) setSaveState(isDraft() ? 'draft' : 'saving');
    try {
      if (p.id === DB.DRAFT_ID) await DB.saveDraft(packProject(p));
      else await DB.saveProject(packProject(p), projMeta(p, final && S.thumbStale));
      if (S.proj === p && !S.dirty) setSaveState(isDraft() ? 'draft' : 'saved');
      return true;
    } catch (e) {
      console.error(e);
      if (S.proj === p) { S.dirty = true; setSaveState('error'); }
      toast(e && e.name === 'QuotaExceededError'
        ? 'Not saved: this iPad’s storage for Inkframe is full. Delete old animations or free up space.'
        : 'Could not save your latest changes. They’ll be tried again.');
      return false;
    }
  });
}
// First save of a draft, or saving a copy under a new name: give it its own id and store it.
function saveAs(name) {
  return queueSave(async () => {
    const p = S.proj, oldId = p.id, wasDraft = oldId === DB.DRAFT_ID;
    p.id = uid(); p.name = name; p.updated = Date.now();
    try {
      await DB.saveProject(packProject(p), projMeta(p, true), wasDraft ? DB.DRAFT_ID : null);
    } catch (e) {
      console.error(e);
      p.id = oldId;
      toast(e && e.name === 'QuotaExceededError' ? 'Not saved: storage is full.' : 'Could not save. Please try again.');
      return false;
    }
    S.dirty = false; rememberLast(p.id);
    setSaveState('saved'); updatePanel();
    return true;
  });
}
function setSaveState(st) {
  S.saveState = st;
  const b = $('#btnSave'); if (!b) return;
  const label = { draft: 'Save', pending: 'Edited', saving: 'Saving…', saved: 'Saved', error: 'Not saved' }[st];
  b.querySelector('.lbl').textContent = label;
  b.className = 'tb save ' + st;
  b.title = st === 'draft' ? 'Save this animation (⌘S)'
    : st === 'error' ? 'Your latest changes could not be saved. Tap to try again.'
      : 'Changes are saved to this animation automatically';
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
window.addEventListener('pagehide', () => { saveNow(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(true); });

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
    if (opts.only && !opts.only(L)) continue;
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
  const showOnion = prefs.onion && !S.playing;
  if (showOnion && !prefs.onionFront) drawOnions();
  drawFrame(ctx, S.cur, false);
  if (showOnion && prefs.onionFront) drawOnions();
  ctx.restore();
  drawSelection();
  $('#zoomInfo').textContent = Math.round(S.view.s * 100) + '%';
}
function onionFilter() {
  if (prefs.onionLayers === 'current') { const A = activeLayer(); return (L) => L === A; }
  if (prefs.onionLayers === 'chosen') return (L) => L.onion !== false;
  return null;
}
function drawOnions() {
  const k = (prefs.onionOpacity ?? 35) / 100;
  for (let d = prefs.onionPrev; d >= 1; d--) onion(S.cur - d, '#ff3b30', k / Math.sqrt(d));
  for (let d = prefs.onionNext; d >= 1; d--) onion(S.cur + d, '#22b14c', k / Math.sqrt(d));
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
  const only = onionFilter();
  drawFrame(tctx, f, false, only ? { only } : {});
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
let lastPressure = 0.5;
function pressureOf(e, start = false) {
  if (e.pointerType !== 'pen') return 1;
  // Safari sometimes reports 0 mid-stroke; reuse the last real value instead of dropping to nothing.
  if (e.pressure > 0) lastPressure = start ? e.pressure : lastPressure * 0.4 + e.pressure * 0.6;
  else if (start) lastPressure = 0.3;
  return clamp(lastPressure, 0.05, 1);
}

function startAction(e, x, y) {
  const tool = prefs.tool;
  const [sx, sy] = toStage(x, y);
  action = { id: e.pointerId, tool, touch: e.pointerType === 'touch', x0: sx, y0: sy, sx: x, sy: y };
  if (tool === 'brush' || tool === 'pen') {
    if (!canEdit()) { action = null; return; }
    action.pts = [[sx, sy, pressureOf(e, true)]];
    action.last = [sx, sy];
    drawLive();
  } else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
    if (!canEdit()) { action = null; return; }
    action.x1 = sx; action.y1 = sy;
  } else if (tool === 'eraser') {
    if (!canEdit()) { action = null; return; }
    action.undoSnap = snap('key'); action.changed = false; editScope = 'key';
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
      const minD = 1 / S.view.s;
      const pr = pressureOf(e);
      if (Math.hypot(nx - lp[0], ny - lp[1]) >= minD) a.pts.push([nx, ny, pr]);
      a.last = [nx, ny];
      a.raw = [sx, sy, pr];
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
    pushUndo('key');
    editableEls().push(el);
    changed(true);
  } else if (a.tool === 'line' || a.tool === 'rect' || a.tool === 'ellipse') {
    const el = makeShape(a);
    if (!el) return;
    pushUndo('key');
    editableEls().push(el);
    changed(true);
  } else if (a.tool === 'eraser') {
    if (a.changed) { addUndo(a.undoSnap); changed(true); }
  } else if (a.tool === 'fill') {
    if (!canEdit()) return;
    const els = contentAt(activeLayer(), S.cur);
    let idx = -1;
    for (let i = els.length - 1; i >= 0; i--) if (fillable(els[i], sx, sy)) { idx = i; break; }
    if (idx < 0) { toast('Tap inside a closed shape or loop to fill it'); return; }
    pushUndo('key');
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
  if (a.tool === 'select' && a.started) { S.undo.pop(); restore(a.undoSnap); changed(true); updateUndoButtons(); }
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
  a.undoSnap = snap('key');
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
    addUndo(a.undoSnap);
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
  pushUndo('key');
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
      `<button class="oni${onionOn(L) ? ' on' : ''}" data-lo="${li}" title="Show onion skin for this layer">${icon('onion')}</button>` +
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
        // keyframes added by frame paste/insert just to keep a drawing going look like held frames
        if (k === f && !kf.auto) cls.push(kf.els.length ? 'k' : 'ke');
        if (kf.tw && nk > 0 && f < nk) cls.push('tw');
        else if (kf.els.length) cls.push('h');
        const spanEnd = (nk > 0 ? Math.min(nk, p.frameCount) : p.frameCount) - 1;
        if (f === spanEnd && f !== k && kf.els.length && !(nk > 0 && L.keys[nk].auto)) cls.push('end');
      }
      if ((f + 1) % 5 === 0) cls.push('f5');
      h += `<div class="${cls.join(' ')}" data-f="${f}"></div>`;
    }
    h += '</div>';
  }
  h += '<div id="playhead"></div><div id="rangeSel" hidden></div><div id="cellSel"></div>';
  grid.innerHTML = h;
  grid.style.width = 170 + total * cellWidth() + 'px';
  updatePlayhead();
}
function onionOn(L) {
  if (!prefs.onion) return false;
  if (prefs.onionLayers === 'current') return L === activeLayer();
  if (prefs.onionLayers === 'chosen') return L.onion !== false;
  return true;
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
  const rs = $('#rangeSel');
  if (rs) {
    rs.hidden = !S.range;
    if (S.range) {
      const { a, b } = frameRange(), all = allScope();
      rs.style.left = 170 + a * cw + 'px';
      rs.style.width = (b - a + 1) * cw + 'px';
      rs.style.top = 26 + (all ? 0 : (p.layers.length - 1 - S.layer) * 34) + 'px';
      rs.style.height = (all ? p.layers.length : 1) * 34 + 'px';
    }
  }
  syncFramePop();
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
  if (suppressClick) { suppressClick = false; return; }
  const t = e.target.closest('[data-la],[data-lv],[data-lk],[data-lo],[data-ln],[data-f]');
  if (!t) return;
  if (S.playing) stop();
  const p = S.proj;
  if (t.dataset.la) return layerAction(t.dataset.la);
  if (t.dataset.lv) { const L = p.layers[+t.dataset.lv]; L.visible = !L.visible; S.sel = []; return changed(true); }
  if (t.dataset.lo) {
    const L = p.layers[+t.dataset.lo];
    if (prefs.onionLayers !== 'chosen') { p.layers.forEach((x) => { x.onion = onionOn(x); }); prefs.onionLayers = 'chosen'; }
    if (!prefs.onion) { prefs.onion = true; p.layers.forEach((x) => { x.onion = x === L; }); }
    else L.onion = L.onion === false;
    savePrefs(); syncOnionPop(); return changed(true);
  }
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
  if (row && !$('#framePop').hidden) { // frame menu open: tap the first frame, then the last frame
    const li = +row.dataset.l; if (S.layer !== li) { S.layer = li; S.sel = []; }
    if (S.pickFrom == null) { S.range = { a: f, b: f }; S.pickFrom = f; }
    else { S.range = { a: S.pickFrom, b: f }; S.pickFrom = null; }
    goto(f, true); renderTimeline();
    return;
  }
  if (e.shiftKey && row) { // shift-click picks a run of frames
    S.range = { a: S.range ? S.range.a : S.cur, b: f };
  } else S.range = null;
  if (row) { const li = +row.dataset.l; if (S.layer !== li) { S.layer = li; S.sel = []; } }
  const grew = f >= p.frameCount;
  goto(f, !!S.range);
  if (grew || row) renderTimeline();
});

// Long-press a frame to pick it and open the frame menu; keep the finger down and drag to pick more frames.
// With a mouse, just drag across the frames.
let rangeDrag = null, suppressClick = false;
function frameAtX(x) { return Math.max(0, Math.floor((x - grid.getBoundingClientRect().left - 170) / cellWidth())); }
function startRangeDrag() {
  const d = rangeDrag; if (!d) return;
  d.active = true;
  if (S.playing) stop();
  if (S.layer !== d.li) { S.layer = d.li; S.sel = []; }
  S.range = { a: d.f, b: d.f };
  closeFramePop();
  // Don't rebuild the timeline mid-gesture: the touched cell must stay in the page or the browser takes over the touch.
  grid.querySelectorAll('.tlRow[data-l]').forEach((r) => r.classList.toggle('active', +r.dataset.l === S.layer));
  goto(d.f, true);
  if (navigator.vibrate) navigator.vibrate(8);
}
grid.addEventListener('pointerdown', (e) => {
  suppressClick = false;
  const c = e.target.closest('.tlRow[data-l] .c');
  if (!c || (e.pointerType === 'mouse' && e.button !== 0) || e.shiftKey) return;
  clearTimeout(rangeDrag?.timer);
  rangeDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, f: +c.dataset.f, li: +c.closest('[data-l]').dataset.l, active: false, mouse: e.pointerType === 'mouse' };
  if (!rangeDrag.mouse) rangeDrag.timer = setTimeout(startRangeDrag, 420);
});
document.addEventListener('pointermove', (e) => {
  const d = rangeDrag;
  if (!d || e.pointerId !== d.id) return;
  if (!d.active) {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
    if (d.mouse && Math.abs(e.clientX - d.x) > Math.abs(e.clientY - d.y)) startRangeDrag();
    else { clearTimeout(d.timer); rangeDrag = null; return; } // it's a scroll
  }
  const sr = scroller.getBoundingClientRect();
  if (e.clientX > sr.right - 40) scroller.scrollLeft += 14;
  else if (e.clientX < sr.left + 210) scroller.scrollLeft -= 14;
  // ignore small finger wobble so a long-press doesn't pick the neighbouring frame too
  const f = Math.abs(e.clientX - d.x) < cellWidth() * 0.6 ? d.f : frameAtX(e.clientX);
  if (f !== S.range.b) { S.range.b = f; updatePlayhead(false); }
});
const endRangeDrag = (e) => {
  const d = rangeDrag;
  if (!d || e.pointerId !== d.id) return;
  clearTimeout(d.timer); rangeDrag = null;
  if (!d.active) return;
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 400);
  const r = frameRange();
  if (r.b >= S.proj.frameCount) S.proj.frameCount = r.b + 1;
  S.pickFrom = r.a === r.b ? r.a : null; // a tap on another frame now picks everything in between
  renderTimeline(); updatePanel();
  if (e.type === 'pointerup') openFramePop();
};
document.addEventListener('pointerup', endRangeDrag);
document.addEventListener('pointercancel', endRangeDrag);
// While picking frames the finger must not scroll the timeline.
scroller.addEventListener('touchmove', (e) => { if (rangeDrag?.active) e.preventDefault(); }, { passive: false });
grid.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const c = e.target.closest('.tlRow[data-l] .c'); if (!c) return;
  const f = +c.dataset.f, li = +c.closest('[data-l]').dataset.l;
  if (S.layer !== li) { S.layer = li; S.sel = []; }
  const r = frameRange();
  if (!(S.range && f >= r.a && f <= r.b)) S.range = { a: f, b: f };
  goto(f, true); renderTimeline(); openFramePop();
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
    if (L.keys[f]?.auto) { pushUndo(); delete L.keys[f].auto; return changed(true); }
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

/* ------------------------------------------------- copy / paste / insert frames */

// S.range is the run of frames picked in the timeline ({a, b}, inclusive), or null for just the current frame.
// prefs.frameScope says whether frame commands work on the current layer or on every layer.
function frameRange() {
  const r = S.range;
  return r ? { a: Math.min(r.a, r.b), b: Math.max(r.a, r.b) } : { a: S.cur, b: S.cur };
}
const allScope = () => prefs.frameScope === 'all';
// auto: a keyframe added only so a drawing keeps looking the same; the timeline shows it as a held frame.
const bakeKey = (L, f) => ({ els: contentAt(L, f).map(cloneEl), tw: false, auto: true });

// Bake every in-between frame of the tween that starts at key k into its own keyframe (looks identical).
function bakeTween(L, k) {
  const nk = nextKey(L, k), out = [];
  for (let g = k + 1; g < nk; g++) out.push([g, bakeKey(L, g)]);
  L.keys[k].tw = false;
  for (const [g, kf] of out) L.keys[g] = kf;
}
// Add keyframes so that frames before f and frames from f on no longer depend on each other.
// Nothing visible changes. Linear tweens are split in two; eased tweens are baked frame by frame.
function cutAt(L, f) {
  if (f <= 0) return;
  if (!L.keys[f]) {
    const k = keyAt(L, f);
    if (k < 0) return; // nothing drawn up to f
    const kf = L.keys[k], tweening = kf.tw && nextKey(L, k) > 0;
    if (tweening && (kf.ease || 'linear') !== 'linear') bakeTween(L, k);
    else L.keys[f] = { els: contentAt(L, f).map(cloneEl), tw: tweening, ease: kf.ease, auto: true };
  }
  // the drawing just before f must not tween into f
  const k = keyAt(L, f - 1);
  if (k < 0 || !L.keys[k].tw || nextKey(L, k) !== f) return;
  if (k === f - 1) L.keys[k].tw = false;
  else if ((L.keys[k].ease || 'linear') === 'linear') L.keys[f - 1] = bakeKey(L, f - 1);
  else bakeTween(L, k);
}
function shiftKeys(L, from, by) {
  const nk = {};
  for (const k of sortedKeys(L)) nk[k < from ? k : k + by] = L.keys[k];
  L.keys = nk;
}
function removeKeys(L, a, n) { for (const k of sortedKeys(L)) if (k >= a && k < a + n) delete L.keys[k]; }
function ensureFirstKey(L) { if (!sortedKeys(L).length) L.keys[0] = { els: [], tw: false }; }

// Copy frames a..b of a layer so they look the same wherever they are pasted.
// Cell i is a keyframe for frame a+i, or null where the drawing before it just holds.
function copyLayerFrames(L, a, b) {
  const cells = [];
  for (let f = a; f <= b; f++) {
    const k = keyAt(L, f);
    if (k < 0) { cells.push(f === a ? { els: [], tw: false } : null); continue; }
    const kf = L.keys[k], nk = nextKey(L, k);
    const inTween = kf.tw && nk > 0;
    const tweenInside = inTween && k >= a && nk <= b; // both ends of the tween are copied
    if (k === f) cells.push({ els: kf.els.map(cloneEl), tw: tweenInside, ease: kf.ease, auto: f !== a && kf.auto });
    else if (f === a) cells.push({ els: contentAt(L, f).map(cloneEl), tw: false });
    else if (inTween && !tweenInside) cells.push(bakeKey(L, f));
    else cells.push(null);
  }
  return cells;
}
// Lay copied cells into a layer at frame p (the frames there were cleared or shifted out of the way first).
function writeCells(L, p, cells) {
  cells.forEach((c, i) => { if (c) L.keys[p + i] = { els: c.els.map(cloneEl), tw: c.tw, ease: c.ease, ...(c.auto ? { auto: true } : {}) }; });
}

function copyFrames(quiet) {
  const p = S.proj, { a, b } = frameRange();
  const lis = allScope() ? p.layers.map((_, i) => i) : [S.layer];
  const layers = lis.map((li) => ({ id: p.layers[li].id, idx: li, cells: copyLayerFrames(p.layers[li], a, b) }));
  const assets = {};
  for (const l of layers) for (const c of l.cells) if (c) for (const el of c.els) if (el.t === 'i' && p.assets?.[el.src]) assets[el.src] = p.assets[el.src];
  S.frameClip = { n: b - a + 1, all: allScope(), layers, assets };
  if (!quiet) toast(`Copied ${plural(b - a + 1)}${allScope() ? ' from all layers' : ''}. Now tap the frame where they should go.`);
  syncFramePop();
}
const plural = (n) => `${n} frame${n === 1 ? '' : 's'}`;

// Which layer gets which copied layer: one layer goes to the current layer; all layers match by layer, then by position.
function clipTargets(clip) {
  const p = S.proj;
  if (!clip.all) return [[S.layer, clip.layers[0].cells]];
  const used = new Set(), out = [];
  for (const cl of clip.layers) {
    let li = p.layers.findIndex((L) => L.id === cl.id);
    if (li < 0 || used.has(li)) li = cl.idx < p.layers.length && !used.has(cl.idx) ? cl.idx : -1;
    if (li >= 0) { used.add(li); out.push([li, cl.cells]); }
  }
  return out;
}

// mode: 'over' replaces frames from the start of the selection, 'before' / 'after' insert new frames.
function pasteFrames(mode) {
  const clip = S.frameClip;
  if (!clip) return toast('Copy some frames first');
  if (S.playing) stop();
  const p = S.proj, { a, b } = frameRange(), n = clip.n;
  const at = mode === 'after' ? b + 1 : a;
  const targets = clipTargets(clip).filter(([li]) => !p.layers[li].locked);
  if (!targets.length) return toast('That layer is locked. Tap the lock to unlock it.');
  const skipped = clipTargets(clip).length - targets.length;
  pushUndo();
  Object.assign((p.assets = p.assets || {}), clip.assets);
  loadAssets(p);
  if (mode === 'over') {
    for (const [li, cells] of targets) {
      const L = p.layers[li];
      cutAt(L, at); cutAt(L, at + n);
      removeKeys(L, at, n);
      writeCells(L, at, cells);
    }
    p.frameCount = Math.max(p.frameCount, at + n);
  } else {
    // inserting into every layer keeps the layers in step; otherwise just the pasted layers move
    const shift = new Set(clip.all || allScope() ? p.layers.map((_, i) => i) : targets.map(([li]) => li));
    for (const li of shift) { const L = p.layers[li]; cutAt(L, at); shiftKeys(L, at, n); }
    for (const [li, cells] of targets) writeCells(p.layers[li], at, cells);
    p.frameCount = Math.max(p.frameCount, at) + n;
  }
  S.range = { a: at, b: at + n - 1 }; S.cur = at; S.sel = [];
  changed(true);
  toast((mode === 'over' ? `Pasted ${plural(n)}` : `Inserted ${plural(n)}`) + (skipped ? ' (skipped locked layers)' : ''));
}

function deleteFrames() {
  if (S.playing) stop();
  const p = S.proj, r = frameRange(), a = r.a, b = Math.min(r.b, p.frameCount - 1), n = b - a + 1;
  if (n < 1) return false;
  const lis = allScope() ? p.layers.map((_, i) => i) : [S.layer];
  if (!allScope() && activeLayer().locked) { toast('This layer is locked.'); return false; }
  if (allScope() && n >= p.frameCount) { toast('An animation needs at least one frame'); return false; }
  pushUndo();
  for (const li of lis) {
    const L = p.layers[li];
    cutAt(L, a); cutAt(L, a + n);
    removeKeys(L, a, n);
    shiftKeys(L, a + n, -n);
    ensureFirstKey(L);
  }
  const lastKey = Math.max(...p.layers.map((l) => Math.max(...sortedKeys(l))));
  p.frameCount = allScope() ? Math.max(1, p.frameCount - n) : Math.max(1, lastKey + 1, p.frameCount - n);
  S.range = null; S.sel = [];
  S.cur = Math.min(a, p.frameCount - 1);
  changed(true);
  return true;
}

function frameAction(act) {
  S.pickFrom = null; // the next tap on a frame starts a new pick (e.g. where to paste)
  if (act === 'copy') return copyFrames();
  if (act === 'cut') { const keep = S.frameClip; copyFrames(true); if (!deleteFrames()) { S.frameClip = keep; return; } return toast(`Cut ${plural(S.frameClip.n)}. Tap the frame where they should go, then Paste or Insert.`); }
  if (act === 'del') { deleteFrames(); return syncFramePop(); }
  if (act === 'dup') { const keep = S.frameClip; copyFrames(true); pasteFrames('after'); S.frameClip = keep; return syncFramePop(); }
  pasteFrames(act);
  syncFramePop();
}

// Popover with the frame commands. It opens from the Frames button, or by long-pressing a frame.
function openFramePop() {
  const pop = $('#framePop');
  pop.hidden = false; $('#tFrames').classList.add('on'); syncFramePop();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const sel = $('#rangeSel'), cs = $('#cellSel');
  const anchor = (sel && !sel.hidden ? sel : cs)?.getBoundingClientRect();
  const tl = $('#timeline').getBoundingClientRect();
  const cx = anchor ? anchor.left + anchor.width / 2 : innerWidth / 2;
  pop.style.left = clamp(cx - w / 2, 8, innerWidth - w - 8) + 'px';
  pop.style.top = Math.max(8, tl.top - h - 8) + 'px';
}
function closeFramePop() {
  $('#framePop').hidden = true; $('#tFrames').classList.remove('on'); S.pickFrom = null;
}
function syncFramePop() {
  const pop = $('#framePop');
  if (!pop || pop.hidden) return;
  const { a, b } = frameRange(), n = b - a + 1;
  $('#fpTitle').textContent = n === 1 ? `Frame ${a + 1}` : `Frames ${a + 1}–${b + 1}`;
  $('#fpLen').textContent = n;
  $('#fpHint').textContent = S.pickFrom != null
    ? `Tap another frame to pick every frame from ${S.pickFrom + 1} up to it.`
    : S.frameClip ? 'Tap the frame where the copied frames should go, then Paste over or Insert. Tap a frame, then another, to pick a run of frames.'
      : 'Tap a frame, then tap another frame to pick every frame in between. Or long-press a frame and drag.';
  pop.querySelectorAll('[data-fs]').forEach((x) => x.classList.toggle('on', x.dataset.fs === (allScope() ? 'all' : 'layer')));
  const clip = S.frameClip;
  $('#fpClip').textContent = clip ? `Paste ${plural(clip.n)}${clip.all ? ' (all layers)' : ''}` : 'Paste (copy frames first)';
  pop.querySelectorAll('[data-fa=over],[data-fa=before],[data-fa=after]').forEach((x) => { x.disabled = !clip; });
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
  $('#selColor').onclick = () => selOp((els) => { S.sel.forEach((i) => { if (els[i].t !== 'i') els[i] = { ...els[i], c: prefs.color, f: els[i].f ? prefs.color : null }; }); });
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
const DEFAULT_NAMES = ['Untitled animation', 'My first animation', 'Untitled'];
const nameKey = (n) => n.trim().toLowerCase();
async function uniqueName(base) {
  const taken = new Set((await DB.listMeta()).map((m) => nameKey(m.name)));
  if (!taken.has(nameKey(base))) return base;
  for (let i = 2; ; i++) if (!taken.has(nameKey(`${base} ${i}`))) return `${base} ${i}`;
}
// Show a dialog and resolve with the value of the button that closed it ('' when dismissed).
function ask(dlg) {
  return new Promise((res) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => res(dlg.returnValue), { once: true });
    dlg.showModal();
  });
}
// Ask for a name for the first save. Resolves the chosen name, or null if cancelled.
async function askSaveName() {
  const p = S.proj, input = $('#saveName'), err = $('#saveErr');
  input.value = DEFAULT_NAMES.includes(p.name) ? '' : p.name;
  input.placeholder = p.name;
  err.hidden = true;
  const taken = new Set((await DB.listMeta()).map((m) => nameKey(m.name)));
  const dlg = $('#dlgSave');
  let chosen = null;
  const check = (e) => {
    const n = (input.value || input.placeholder).trim().slice(0, 60);
    if (!n) { e.preventDefault(); input.focus(); return; }
    if (taken.has(nameKey(n))) {
      e.preventDefault();
      err.textContent = `You already have an animation called “${n}”. Pick another name.`;
      err.hidden = false; input.focus(); return;
    }
    chosen = n;
  };
  $('#saveForm').addEventListener('submit', check);
  setTimeout(() => input.focus(), 50);
  const r = await ask(dlg);
  $('#saveForm').removeEventListener('submit', check);
  return r === 'save' ? chosen : null;
}
async function saveCommand() {
  if (isDraft()) {
    const name = await askSaveName();
    if (name && await saveAs(name)) toast(`Saved as “${name}”. Changes will now save automatically.`);
  } else {
    S.dirty = S.dirty || S.saveState === 'error';
    if (await saveNow()) { setSaveState('saved'); toast('All changes saved'); }
  }
}
// Before switching away from the current animation. Resolves false if the switch should not happen.
async function leaveCurrent() {
  const ok = await saveNow(true);
  if (!isDraft()) return ok || confirm('Your latest changes could not be saved. Continue anyway and lose them?');
  if (draftHasWork()) {
    $('#unsavedMsg').textContent = `Do you want to save “${S.proj.name}”? If you don’t, your drawing will be lost.`;
    const c = await ask($('#dlgUnsaved'));
    if (c === 'save') {
      const name = await askSaveName();
      return !!name && saveAs(name);
    }
    if (c !== 'discard') return false;
  }
  S.dirty = false;
  await DB.deleteDraft().catch(() => {});
  return true;
}
async function openProjects() {
  await saveNow(true);
  let list = [];
  try { list = await DB.listMeta(); } catch (e) { console.error(e); toast('Could not read your saved animations'); }
  $('#pDraft').hidden = !isDraft();
  $('#pList').innerHTML = list.map((m) => `
    <div class="pItem${m.id === S.proj.id ? ' cur' : ''}" data-id="${m.id}">
      <img src="${m.thumb || ''}" alt="" data-open="${m.id}">
      <div class="pn">${esc(m.name)}</div>
      <div class="pd">${m.frames || 1} frames · ${new Date(m.updated).toLocaleDateString()}</div>
      <div class="pa"><button data-open="${m.id}">Open</button><button data-dup="${m.id}">Copy</button><button data-save="${m.id}">Save file</button><button data-del="${m.id}">Delete</button></div>
    </div>`).join('') || '<p class="hint">No saved animations yet.</p>';
  if (!$('#dlgProjects').open) $('#dlgProjects').showModal();
}
// Project-list actions can be slow (big animations); ignore taps while one is running.
let busy = false;
const guard = (fn) => async (...a) => { if (busy) return; busy = true; try { return await fn(...a); } finally { busy = false; } };
$('#pDraftSave').onclick = guard(async () => { $('#dlgProjects').close(); await saveCommand(); });
$('#pList').addEventListener('click', guard(async (e) => {
  const t = e.target.closest('[data-open],[data-dup],[data-del],[data-save]'); if (!t) return;
  if (t.dataset.open) {
    if (t.dataset.open === S.proj.id) { $('#dlgProjects').close(); return; }
    $('#dlgProjects').close();
    if (!await leaveCurrent()) return;
    await loadById(t.dataset.open);
  } else if (t.dataset.dup) {
    await saveNow();
    const p = await DB.loadProject(t.dataset.dup);
    if (!p) return toast('That animation could not be found');
    const c = { ...JSON.parse(JSON.stringify(p)), id: uid(), name: await uniqueName(p.name + ' copy'), created: Date.now(), updated: Date.now() };
    $('#dlgProjects').close();
    if (!await leaveCurrent()) return;
    setProject(c); S.dirty = true;
    if (await saveNow()) toast(`Opened “${c.name}”`);
  } else if (t.dataset.save) {
    await saveNow();
    const p = await DB.loadProject(t.dataset.save);
    if (p) shareBlob(new Blob([JSON.stringify(p)], { type: 'application/json' }), safeName(p.name) + '.inkframe');
  } else if (t.dataset.del) {
    if (!confirm('Delete this animation? This can’t be undone.')) return;
    const cur = t.dataset.del === S.proj.id;
    if (cur) { clearTimeout(saveTimer); S.dirty = false; await saveChain; }
    try { await DB.deleteProject(t.dataset.del); } catch (err) { console.error(err); return toast('Could not delete it'); }
    if (cur) {
      const list = await DB.listMeta();
      if (!list.length || !await loadById(list[0].id)) setProject(newProject());
    }
    openProjects();
  }
}));
$('#pNew').onclick = guard(async () => {
  $('#dlgProjects').close();
  if (!await leaveCurrent()) return;
  setProject(newProject());
  toast('New animation');
});
$('#pImport').addEventListener('change', guard(async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  let p;
  try {
    p = JSON.parse(await file.text());
    if (!p.layers || !p.w) throw new Error('bad');
  } catch { return toast('That file isn’t an Inkframe project'); }
  $('#dlgProjects').close();
  if (!await leaveCurrent()) return;
  p.id = uid(); p.name = await uniqueName(p.name || file.name.replace(/\.[^.]+$/, '') || 'Imported animation');
  p.created = p.created || Date.now(); p.updated = Date.now();
  setProject(p); S.dirty = true;
  if (await saveNow()) toast('Opened ' + p.name);
}));
async function loadById(id) {
  let p = null;
  try { p = await DB.loadProject(id); } catch (e) { console.error(e); }
  if (!p) { toast('That animation could not be opened'); return false; }
  setProject(p);
  return true;
}
function setProject(p) {
  if (S.playing) stop();
  clearTimeout(saveTimer);
  pruneAssets(p);
  loadAssets(p);
  S.proj = p; S.cur = 0; S.layer = Math.max(0, p.layers.length - 1); S.sel = []; S.range = null; S.undo = []; S.redo = [];
  S.dirty = false; setSaveState(isDraft() ? 'draft' : 'saved');
  rememberLast(p.id);
  fit(); renderTimeline(); updatePanel(); updateUndoButtons(); requestRender();
}

/* images */
const images = new Map();
setImageSource((id) => { const im = images.get(id); return im && im.complete && im.naturalWidth ? im : null; });
function getImage(id, url) {
  let im = images.get(id);
  if (!im) {
    im = new Image();
    im.src = url;
    images.set(id, im);
    im._ready = (im.decode ? im.decode() : new Promise((r) => { im.onload = r; })).catch(() => {}).then(() => requestRender());
  }
  return im._ready;
}
function loadAssets(p) {
  p.assets = p.assets || {};
  return Promise.all(Object.entries(p.assets).map(([id, url]) => getImage(id, url)));
}
function pruneAssets(p) {
  if (!p.assets) return;
  const used = new Set();
  for (const L of p.layers) for (const k in L.keys) for (const el of L.keys[k].els) if (el.t === 'i') used.add(el.src);
  for (const id of Object.keys(p.assets)) if (!used.has(id)) delete p.assets[id];
}
const readDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
async function importImageFile(file) {
  if (!file || !(file.type || '').startsWith('image/')) return toast('That file isn’t an image');
  if (!canEdit()) return;
  const p = S.proj;
  toast('Adding image…');
  let url, iw, ih;
  try {
    const tmp = new Image();
    const objUrl = URL.createObjectURL(file);
    tmp.src = objUrl;
    await tmp.decode();
    iw = tmp.naturalWidth; ih = tmp.naturalHeight;
    const maxSide = Math.min(4096, Math.max(2048, Math.max(p.w, p.h) * 2));
    const keep = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) && Math.max(iw, ih) <= maxSide && file.size < 12e6;
    if (keep) url = await readDataURL(file);
    else {
      const s = Math.min(1, maxSide / Math.max(iw, ih));
      iw = Math.max(1, Math.round(iw * s)); ih = Math.max(1, Math.round(ih * s));
      const c = document.createElement('canvas'); c.width = iw; c.height = ih;
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(tmp, 0, 0, iw, ih);
      url = file.type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png');
    }
    URL.revokeObjectURL(objUrl);
  } catch (e) { console.error(e); return toast('Couldn’t open that image'); }
  const id = uid();
  p.assets = p.assets || {};
  p.assets[id] = url;
  await getImage(id, url);
  const s = Math.min(1, (0.8 * p.w) / iw, (0.8 * p.h) / ih), dw = iw * s, dh = ih * s;
  const x0 = (p.w - dw) / 2, y0 = (p.h - dh) / 2;
  const el = { t: 'i', src: id, iw, ih, pts: [[x0, y0], [x0 + dw, y0], [x0, y0 + dh]], a: 1, w: 0, c: '#000000', f: null };
  pushUndo('key');
  const els = editableEls();
  els.push(el);
  setTool('select');
  S.sel = [els.length - 1];
  changed(true);
  toast('Image added. Drag to move it, and use the handles to resize or rotate.');
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
const canvasBlob = (c, type = 'image/png', q) => new Promise((r) => c.toBlob(r, type, q));
const tick = () => new Promise((r) => setTimeout(r, 0));

const FORMATS = {
  video: { label: 'Video', sub: 'MP4 · H.264 or H.265', size: 1, fps: 1, range: 1, video: 1, bg: ['project', 'custom'] },
  gif: { label: 'GIF', sub: 'Looping animation for chats and the web', size: 1, fps: 1, range: 1, gif: 1, bg: ['project', 'custom'] },
  seq: { label: 'Image sequence', sub: 'Every frame as PNG or JPEG, in a .zip', size: 1, fps: 1, range: 1, img: 1, bg: ['project', 'transparent', 'custom'] },
  still: { label: 'Still image', sub: 'The current frame as PNG or JPEG', size: 1, img: 1, bg: ['project', 'transparent', 'custom'] },
  svganim: { label: 'Animated SVG', sub: 'Sharp vector animation for websites', size: 1, range: 1, bg: ['project', 'transparent', 'custom'] },
  svg: { label: 'SVG frame', sub: 'The current frame as editable vectors', size: 1, bg: ['project', 'transparent', 'custom'] },
  project: { label: 'Project file', sub: 'Backup to open again later (.inkframe)' },
};
const PRESETS = [
  ['project', 'Same as canvas'], ['half', 'Half size'], ['1080p', 'Full HD · 1920 × 1080', 1920, 1080], ['720p', 'HD · 1280 × 720', 1280, 720],
  ['4k', '4K UHD · 3840 × 2160', 3840, 2160], ['square', 'Square · 1080 × 1080', 1080, 1080], ['vertical', 'Vertical / Stories · 1080 × 1920', 1080, 1920],
  ['portrait', 'Portrait 4:5 · 1080 × 1350', 1080, 1350], ['small', 'Small · 480 wide', 480], ['custom', 'Custom size'],
];
const QUALITY = { low: 0.04, medium: 0.08, high: 0.15, max: 0.3 };
const EX_DEFAULT = {
  fmt: 'video', preset: 'project', w: 0, h: 0, link: true, fit: 'fit', fps: 0, range: 'all', from: 1, to: 0,
  quality: 'high', codec: 'avc', repeat: 1, colors: 256, loop: 'forever', bg: 'project', bgColor: '#ffffff', img: 'png', jpgQ: 90,
};
const X = () => prefs.exp;

function presetSize(id) {
  const p = S.proj, pr = PRESETS.find((x) => x[0] === id);
  if (id === 'project') return [p.w, p.h];
  if (id === 'half') return [Math.round(p.w / 2), Math.round(p.h / 2)];
  if (id === 'small') return [480, Math.round((480 * p.h) / p.w)];
  if (pr && pr[2]) return [pr[2], pr[3]];
  return [X().w || p.w, X().h || p.h];
}
function outSize() {
  let [w, h] = X().preset === 'custom' ? [X().w, X().h] : presetSize(X().preset);
  w = clamp(Math.round(w) || S.proj.w, 2, 7680); h = clamp(Math.round(h) || S.proj.h, 2, 7680);
  if (X().fmt === 'video') { w = Math.round(w / 2) * 2; h = Math.round(h / 2) * 2; }
  return [w, h];
}
const outFps = () => (FORMATS[X().fmt].fps && X().fps) || S.proj.fps;
function outRange() {
  const n = S.proj.frameCount;
  if (X().range !== 'custom') return [0, n - 1];
  const a = clamp(Math.round(X().from) - 1, 0, n - 1), b = clamp(Math.round(X().to || n) - 1, 0, n - 1);
  return a <= b ? [a, b] : [b, a];
}
// Project frame for every output frame, after frame-rate conversion and repeats.
function outFrames() {
  const [a, b] = outRange(), fps = S.proj.fps, of = outFps();
  const dur = (b - a + 1) / fps, n = Math.max(1, Math.round(dur * of));
  const one = Array.from({ length: n }, (_, i) => a + Math.min(b - a, Math.floor((i * fps) / of + 1e-6)));
  const rep = X().fmt === 'video' ? clamp(+X().repeat || 1, 1, 50) : 1;
  return [].concat(...Array.from({ length: rep }, () => one));
}
function bgColor() {
  const f = FORMATS[X().fmt], mode = (f.bg || []).includes(X().bg) ? X().bg : 'project';
  if (mode === 'transparent' && !(X().fmt === 'still' || X().fmt === 'seq') ) return null;
  if (mode === 'transparent') return X().img === 'jpeg' ? S.proj.bg : null;
  return mode === 'custom' ? X().bgColor : S.proj.bg;
}
function makeRenderer(w, h, fit, bg) {
  const p = S.proj, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  let sx = w / p.w, sy = h / p.h;
  if (fit === 'fit') sx = sy = Math.min(sx, sy); else if (fit === 'fill') sx = sy = Math.max(sx, sy);
  const ox = (w - p.w * sx) / 2, oy = (h - p.h * sy) / 2;
  return {
    canvas: c, ctx: x,
    draw(f) {
      x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1;
      x.clearRect(0, 0, w, h);
      if (bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); }
      x.setTransform(sx, 0, 0, sy, ox, oy);
      x.save(); x.beginPath(); x.rect(0, 0, p.w, p.h); x.clip();
      drawFrame(x, f, false);
      x.restore();
    },
  };
}

function frameSVG(f, bg) {
  const p = S.proj;
  let s = bg ? `<rect width="${p.w}" height="${p.h}" fill="${bg}"/>` : '';
  for (const L of p.layers) if (L.visible) for (const el of contentAt(L, f)) s += elSVG(el);
  return s;
}
function svgDoc(inner, w, h) {
  const p = S.proj;
  const used = [...new Set([...inner.matchAll(/href="#img-([\w]+)"/g)].map((m) => m[1]))];
  const defs = used.length ? `<defs>${used.map((id) => { const im = images.get(id); return `<image id="img-${id}" width="${im?.naturalWidth || 1}" height="${im?.naturalHeight || 1}" href="${(p.assets || {})[id] || ''}"/>`; }).join('')}</defs>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${p.w} ${p.h}">${defs}${inner}</svg>`;
}
function animatedSVG(w, h, bg) {
  const [a, b] = outRange(), n = b - a + 1, dur = n / S.proj.fps;
  let s = bg ? `<rect width="${S.proj.w}" height="${S.proj.h}" fill="${bg}"/>` : '';
  for (let i = 0; i < n; i++) {
    const vals = Array.from({ length: n }, (_, k) => (k === i ? 'inline' : 'none')).join(';');
    const times = Array.from({ length: n }, (_, k) => (k / n).toFixed(5)).join(';');
    s += `<g display="${i === 0 ? 'inline' : 'none'}"><animate attributeName="display" values="${vals}" keyTimes="${times}" dur="${dur}s" calcMode="discrete" repeatCount="indefinite"/>${frameSVG(a + i, null)}</g>`;
  }
  return svgDoc(s, w, h);
}
function pickVideoType() {
  if (!window.MediaRecorder) return null;
  for (const t of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {}
  }
  return null;
}
const CODECS = {
  avc: ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d0033', 'avc1.4d0028', 'avc1.42e01f'],
  hevc: ['hvc1.1.6.L153.B0', 'hvc1.1.6.L123.B0', 'hev1.1.6.L153.B0', 'hev1.1.6.L123.B0'],
};
async function findCodec(kind, width, height, bitrate, framerate) {
  if (!window.VideoEncoder) return null;
  for (const c of CODECS[kind]) {
    try {
      const cfg = { codec: c, width, height, bitrate, framerate };
      if (kind === 'avc') cfg.avc = { format: 'avc' };
      if (kind === 'hevc') cfg.hevc = { format: 'hevc' };
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
    } catch {}
  }
  return null;
}
const videoBitrate = (w, h, fps) => Math.round(clamp(w * h * fps * QUALITY[X().quality || 'high'] * (X().codec === 'hevc' ? 0.6 : 1), 300_000, 80_000_000));

async function encodeVideo(r, frames, w, h, fps, onProgress) {
  const bitrate = videoBitrate(w, h, fps);
  const cfg = await findCodec(X().codec, w, h, bitrate, fps) || (X().codec === 'hevc' ? await findCodec('avc', w, h, bitrate, fps) : null);
  if (!cfg) return null;
  const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer.mjs');
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: cfg.codec.startsWith('avc') ? 'avc' : 'hevc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
  let failure = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  enc.configure(cfg);
  const dur = 1e6 / fps;
  for (let i = 0; i < frames.length; i++) {
    if (failure) throw failure;
    r.draw(frames[i]);
    const vf = new VideoFrame(r.canvas, { timestamp: Math.round(i * dur), duration: Math.round(dur) });
    enc.encode(vf, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
    vf.close();
    while (enc.encodeQueueSize > 6) await new Promise((res) => setTimeout(res, 5));
    onProgress((i + 1) / frames.length);
    if (i % 3 === 0) await tick();
  }
  await enc.flush();
  if (failure) throw failure;
  muxer.finalize(); enc.close();
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4', codec: cfg.codec.startsWith('avc') ? 'H.264' : 'H.265' };
}
async function recordVideo(r, frames, fps, onProgress) {
  const type = pickVideoType();
  if (!type) throw new Error('Video export isn’t supported in this browser. Try GIF instead.');
  r.draw(frames[0]);
  const stream = r.canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: videoBitrate(r.canvas.width, r.canvas.height, fps) });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  rec.start(250);
  const t0 = performance.now(), frameMs = 1000 / fps;
  for (let i = 0; i < frames.length; i++) {
    r.draw(frames[i]);
    onProgress((i + 1) / frames.length);
    await new Promise((res) => setTimeout(res, Math.max(0, t0 + (i + 1) * frameMs - performance.now())));
  }
  rec.stop(); stream.getTracks().forEach((t) => t.stop());
  await done;
  return { blob: new Blob(chunks, { type: type.split(';')[0] }), ext: type.includes('mp4') ? 'mp4' : 'webm', codec: 'recorded' };
}

async function runExport() {
  readExportForm();
  await loadAssets(S.proj);
  const x = X(), p = S.proj, fmt = x.fmt;
  const name = safeName($('#exName').value || p.name);
  const [w, h] = outSize(), fps = outFps(), bg = bgColor();
  if (S.playing) stop();
  $('#exChoose').hidden = true; $('#exFoot').hidden = true; $('#exWork').hidden = false; $('#exDone').hidden = true;
  const prog = (v, msg) => { $('#exBar').style.width = Math.round(v * 100) + '%'; if (msg) $('#exStatus').textContent = msg; };
  prog(0, 'Working…');
  await tick();
  try {
    let blob, file, preview = 'img';
    if (fmt === 'video') {
      const frames = outFrames(), r = makeRenderer(w, h, x.fit, bg);
      prog(0, 'Making video…');
      let res = null;
      try { res = await encodeVideo(r, frames, w, h, fps, (v) => prog(v)); } catch (e) { console.warn('encoder failed, falling back', e); }
      if (!res) { prog(0, 'Recording video in real time…'); res = await recordVideo(r, frames, fps, (v) => prog(v)); }
      blob = res.blob; file = `${name}.${res.ext}`; preview = 'video';
    } else if (fmt === 'gif') {
      const frames = outFrames(), r = makeRenderer(w, h, x.fit, bg);
      blob = await encodeGIF({
        width: w, height: h, count: frames.length, fps, colors: +x.colors, loop: x.loop,
        getFrame: (i) => { r.draw(frames[i]); return r.ctx.getImageData(0, 0, w, h); },
        onProgress: (v) => prog(v, `Making GIF… ${Math.round(v * 100)}%`),
      });
      file = name + '.gif';
    } else if (fmt === 'seq') {
      const frames = outFrames(), r = makeRenderer(w, h, x.fit, bg);
      const type = x.img === 'jpeg' ? 'image/jpeg' : 'image/png', ext = x.img === 'jpeg' ? 'jpg' : 'png';
      const digits = Math.max(4, String(frames.length).length), files = [];
      for (let i = 0; i < frames.length; i++) {
        r.draw(frames[i]);
        const b = await canvasBlob(r.canvas, type, x.jpgQ / 100);
        files.push({ name: `${name}_${String(i + 1).padStart(digits, '0')}.${ext}`, data: new Uint8Array(await b.arrayBuffer()) });
        prog((i + 1) / frames.length, `Frame ${i + 1} of ${frames.length}…`);
      }
      blob = makeZip(files); file = `${name}-frames.zip`; preview = null;
    } else if (fmt === 'still') {
      const r = makeRenderer(w, h, x.fit, bg);
      r.draw(S.cur);
      const jpg = x.img === 'jpeg';
      blob = await canvasBlob(r.canvas, jpg ? 'image/jpeg' : 'image/png', x.jpgQ / 100);
      file = `${name}-frame${S.cur + 1}.${jpg ? 'jpg' : 'png'}`;
    } else if (fmt === 'svg') {
      blob = new Blob([svgDoc(frameSVG(S.cur, bg), w, h)], { type: 'image/svg+xml' });
      file = `${name}-frame${S.cur + 1}.svg`;
    } else if (fmt === 'svganim') {
      blob = new Blob([animatedSVG(w, h, bg)], { type: 'image/svg+xml' });
      file = name + '.svg';
    } else {
      blob = new Blob([JSON.stringify(p)], { type: 'application/json' });
      file = name + '.inkframe'; preview = null;
    }
    prog(1);
    showExportResult(blob, file, preview);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Export failed');
    $('#exChoose').hidden = false; $('#exFoot').hidden = false; $('#exWork').hidden = true;
  }
}
function showExportResult(blob, name, preview) {
  if (exportResult) URL.revokeObjectURL(exportResult.url);
  const url = URL.createObjectURL(blob);
  exportResult = { blob, name, url };
  $('#exWork').hidden = true; $('#exDone').hidden = false;
  $('#exPreview').innerHTML = preview === 'img' ? `<img src="${url}" alt="">` : preview === 'video' ? `<video src="${url}" autoplay loop muted playsinline controls></video>` : '';
  $('#exPreview').hidden = !preview;
  const mb = blob.size / 1024 / 1024;
  $('#exInfo').textContent = `${name} · ${mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(blob.size / 1024)) + ' KB'}`;
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

/* export dialog form */
function buildExportForm() {
  $('#exFormats').innerHTML = Object.entries(FORMATS).map(([k, f]) => `<button data-fmt="${k}"><b>${f.label}</b><span>${f.sub}</span></button>`).join('');
  $('#exPreset').innerHTML = PRESETS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('#exFormats').addEventListener('click', (e) => { const b = e.target.closest('[data-fmt]'); if (b) { X().fmt = b.dataset.fmt; syncExportForm(); } });
  $('#exChoose').addEventListener('click', (e) => {
    const b = e.target.closest('.seg [data-v]'); if (!b) return;
    const key = b.parentElement.dataset.key; X()[key] = b.dataset.v; syncExportForm();
  });
  $('#exChoose').addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'exW' || id === 'exH') {
      const p = S.proj, [cw, ch] = outSize();
      let w = +$('#exW').value || cw, h = +$('#exH').value || ch;
      if (X().link) { if (id === 'exW') h = Math.round((w * p.h) / p.w); else w = Math.round((h * p.w) / p.h); }
      X().preset = 'custom'; X().w = w; X().h = h;
      if (id === 'exW') $('#exH').value = h; else $('#exW').value = w;
      $('#exPreset').value = 'custom';
      syncSummary(); savePrefs();
      return;
    }
    readExportForm(); syncExportForm(false);
  });
  $('#exLink').onclick = () => { X().link = !X().link; syncExportForm(); };
}
function readExportForm() {
  const x = X();
  x.preset = $('#exPreset').value;
  if (x.preset === 'custom') { x.w = +$('#exW').value || x.w; x.h = +$('#exH').value || x.h; }
  x.fit = $('#exFit').value; x.fps = +$('#exFps').value; x.repeat = +$('#exRepeat').value;
  x.from = +$('#exFrom').value; x.to = +$('#exTo').value;
  x.codec = $('#exCodec').value; x.quality = $('#exQuality').value;
  x.colors = +$('#exColors').value; x.loop = $('#exLoop').value;
  x.img = $('#exImg').value; x.jpgQ = +$('#exJpgQ').value; x.bgColor = $('#exBgColor').value;
  savePrefs();
}
function syncExportForm(fillInputs = true) {
  const x = X(), f = FORMATS[x.fmt], p = S.proj;
  document.querySelectorAll('#exFormats [data-fmt]').forEach((b) => b.classList.toggle('on', b.dataset.fmt === x.fmt));
  document.querySelectorAll('#exChoose [data-show]').forEach((el) => {
    el.hidden = !el.dataset.show.split(' ').some((k) => {
      if (k === 'bg') return !!f.bg;
      if (k === 'fitrow') return f.size && x.fmt !== 'svg' && x.fmt !== 'svganim';
      if (k === 'jpgq') return f.img && x.img === 'jpeg';
      if (k === 'none') return x.fmt === 'project';
      return !!f[k];
    });
  });
  if (fillInputs) {
    $('#exPreset').value = x.preset;
    const [w, h] = outSize(); $('#exW').value = w; $('#exH').value = h;
    $('#exFit').value = x.fit;
    $('#exFps').innerHTML = `<option value="0">Same as project (${p.fps})</option>` + [6, 8, 10, 12, 15, 24, 25, 30, 50, 60].map((v) => `<option value="${v}">${v} fps</option>`).join('');
    $('#exFps').value = String(x.fps || 0);
    $('#exRepeat').value = String(x.repeat || 1);
    $('#exFrom').value = x.from || 1; $('#exTo').value = x.to || p.frameCount;
    $('#exFrom').max = $('#exTo').max = p.frameCount;
    $('#exCodec').value = x.codec; $('#exQuality').value = x.quality;
    $('#exColors').value = String(x.colors); $('#exLoop').value = String(x.loop);
    $('#exImg').value = x.img; $('#exJpgQ').value = x.jpgQ; $('#exBgColor').value = x.bgColor;
  } else if (x.preset !== 'custom') {
    const [w, h] = outSize(); $('#exW').value = w; $('#exH').value = h;
  }
  $('#exJpgQv').textContent = x.jpgQ + '%';
  $('#exLink').classList.toggle('on', !!x.link);
  document.querySelectorAll('#exChoose .seg[data-key]').forEach((s) => s.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === x[s.dataset.key])));
  const bgs = f.bg || [];
  document.querySelectorAll('#exBgSeg [data-v]').forEach((b) => { b.hidden = !bgs.includes(b.dataset.v); });
  if (!bgs.includes(x.bg)) { x.bg = 'project'; document.querySelectorAll('#exBgSeg [data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === 'project')); }
  $('#exBgColor').hidden = x.bg !== 'custom';
  $('#exRangeCustom').hidden = x.range !== 'custom';
  const [w, h] = outSize();
  $('#exFitRow').hidden = $('#exFitRow').hidden || Math.abs(w / h - p.w / p.h) < 0.01;
  if (!$('#exName').value) $('#exName').value = p.name;
  syncSummary();
  savePrefs();
}
function syncSummary() {
  const x = X(), f = FORMATS[x.fmt], p = S.proj;
  const [w, h] = outSize(), fps = outFps();
  const parts = [];
  if (x.fmt === 'project') parts.push(`${p.layers.length} layer${p.layers.length > 1 ? 's' : ''}`, `${p.frameCount} frames`);
  else if (f.fps || x.fmt === 'svganim') {
    const n = outFrames().length, [a, b] = outRange();
    const dur = x.fmt === 'svganim' ? (b - a + 1) / p.fps : n / fps;
    parts.push(`${w} × ${h}`, `${x.fmt === 'svganim' ? p.fps : fps} fps`, `${x.fmt === 'svganim' ? b - a + 1 : n} frames`, `${dur.toFixed(dur < 10 ? 1 : 0)} s`);
    if (x.fmt === 'video') parts.push(`about ${((videoBitrate(w, h, fps) * dur) / 8 / 1024 / 1024).toFixed(1)} MB or less`);
  } else parts.push(`${w} × ${h}`, `frame ${S.cur + 1}`);
  $('#exSummary').textContent = parts.join(' · ');
}
async function checkHevc() {
  const opt = $('#exCodec').querySelector('[value=hevc]');
  const ok = !!(await findCodec('hevc', 1280, 720, 4_000_000, 30));
  opt.disabled = !ok;
  opt.textContent = ok ? 'H.265 / HEVC (smaller files)' : 'H.265 / HEVC (not available here)';
  if (!ok && X().codec === 'hevc') { X().codec = 'avc'; $('#exCodec').value = 'avc'; }
}
function openExport() {
  prefs.exp = { ...EX_DEFAULT, ...(prefs.exp || {}) };
  $('#exName').value = S.proj.name;
  $('#exChoose').hidden = false; $('#exFoot').hidden = false; $('#exWork').hidden = true; $('#exDone').hidden = true;
  syncExportForm();
  $('#dlgExport').showModal();
  checkHevc();
}
$('#exShare').onclick = () => exportResult && shareBlob(exportResult.blob, exportResult.name);
$('#exBack').onclick = () => { $('#exChoose').hidden = false; $('#exFoot').hidden = false; $('#exDone').hidden = true; };
$('#exGo').onclick = runExport;
buildExportForm();

function openOnionPop() {
  const pop = $('#onionPop'), r = $('#tOnionMenu').getBoundingClientRect();
  pop.hidden = false; syncOnionPop();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(r.right - w, 8, innerWidth - w - 8) + 'px';
  pop.style.top = Math.max(8, r.top - h - 8) + 'px';
}
function syncOnionPop() {
  document.querySelectorAll('#onionPop [data-ol]').forEach((b) => b.classList.toggle('on', b.dataset.ol === prefs.onionLayers));
  document.querySelectorAll('#onionPop [data-of]').forEach((b) => b.classList.toggle('on', (b.dataset.of === '1') === !!prefs.onionFront));
  $('#onPrevN').textContent = prefs.onionPrev; $('#onNextN').textContent = prefs.onionNext;
  $('#onionOpacity').value = prefs.onionOpacity ?? 35;
}

/* ------------------------------------------------------------ keyboard */

let spaceDown = false;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!document.querySelector('dialog[open]')) saveCommand(); return; }
  if (e.target.matches('input, select, textarea') || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  const framesPicked = S.range && !S.sel.length;
  if (mod && k === 'c') { if (framesPicked) frameAction('copy'); else $('#selCopy').click(); return; }
  if (mod && k === 'x' && framesPicked) { e.preventDefault(); frameAction('cut'); return; }
  if (mod && k === 'v') { e.preventDefault(); if (framesPicked && S.frameClip) frameAction(e.shiftKey ? 'before' : 'over'); else $('#selPaste').click(); return; }
  if (mod && k === 'd' && framesPicked) { e.preventDefault(); frameAction('dup'); return; }
  if (mod && k === 'a') { e.preventDefault(); setTool('select'); $('#selAll').click(); return; }
  if (mod) return;
  const map = { b: 'brush', n: 'pen', e: 'eraser', v: 'select', k: 'fill', l: 'line', r: 'rect', o: 'ellipse', h: 'hand' };
  if (map[k]) { setTool(map[k]); return; }
  if (k === ' ') { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
  if (k === ',' || k === 'arrowleft') { goto(S.cur - 1 < 0 ? S.proj.frameCount - 1 : S.cur - 1); return; }
  if (k === '.' || k === 'arrowright') { goto(S.cur + 1 >= S.proj.frameCount ? 0 : S.cur + 1); return; }
  if ((k === 'delete' || k === 'backspace') && S.sel.length) { $('#selDelete').click(); return; }
  if ((k === 'delete' || k === 'backspace') && S.range) { frameAction('del'); return; }
  if (k === 'escape' && S.range) { S.range = null; closeFramePop(); updatePlayhead(false); return; }
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
  $('#btnSave').onclick = saveCommand;
  $('#btnExport').onclick = openExport;
  $('#btnHelp').onclick = () => $('#dlgHelp').showModal();
  $('#btnImage').onclick = () => $('#imgInput').click();
  $('#imgInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importImageFile(f); });
  document.addEventListener('paste', (e) => {
    if (e.target.matches && e.target.matches('input, textarea')) return;
    if (S.range && S.frameClip && !S.sel.length) return; // ⌘V pastes frames here
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); importImageFile(item.getAsFile()); }
  });
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('drop', (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/')); if (f) importImageFile(f); });
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
  $('#tOnion').onclick = () => { prefs.onion = !prefs.onion; savePrefs(); updatePanel(); renderTimeline(); requestRender(); };
  $('#tOnionMenu').onclick = (e) => { e.stopPropagation(); const pop = $('#onionPop'); if (pop.hidden) openOnionPop(); else pop.hidden = true; };
  document.addEventListener('pointerdown', (e) => { const pop = $('#onionPop'); if (!pop.hidden && !e.target.closest('#onionPop, #tOnionMenu')) pop.hidden = true; });
  $('#onionPop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ol],[data-of],[data-os]'); if (!b) return;
    if (b.dataset.ol) prefs.onionLayers = b.dataset.ol;
    if (b.dataset.of) prefs.onionFront = b.dataset.of === '1';
    if (b.dataset.os) { const [key, d] = b.dataset.os.split(':'); prefs[key] = clamp(prefs[key] + +d, 0, 6); }
    prefs.onion = true;
    savePrefs(); syncOnionPop(); updatePanel(); renderTimeline(); requestRender();
  });
  $('#onionOpacity').addEventListener('input', (e) => { prefs.onionOpacity = +e.target.value; savePrefs(); requestRender(); });
  $('#tFrames').onclick = (e) => { e.stopPropagation(); if ($('#framePop').hidden) { S.pickFrom = null; if (!S.range) S.range = { a: S.cur, b: S.cur }; updatePlayhead(false); openFramePop(); } else closeFramePop(); };
  $('#fpClose').onclick = closeFramePop;
  document.addEventListener('pointerdown', (e) => { if (!$('#framePop').hidden && !e.target.closest('#framePop, #tFrames, .tlRow[data-l] .c, #tlScroll')) closeFramePop(); });
  $('#framePop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fa],[data-fs],[data-fx]'); if (!b || b.disabled) return;
    if (b.dataset.fa) return frameAction(b.dataset.fa);
    if (b.dataset.fs) { prefs.frameScope = b.dataset.fs; savePrefs(); updatePlayhead(false); return; }
    const r = frameRange();
    S.range = { a: r.a, b: clamp(r.b + +b.dataset.fx, r.a, Math.max(r.a, S.proj.frameCount - 1)) };
    updatePlayhead(false);
  });
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
  // Reopen what was open last: a saved animation, or the unsaved draft (so nothing is lost if iPadOS
  // closed the app before the first Save).
  let p = null, first = false;
  try {
    let last = null;
    try { last = localStorage.getItem('inkframe.last'); } catch {}
    if (last) p = await DB.loadProject(last);
    if (!p) p = await DB.loadProject(DB.DRAFT_ID);
    if (!p) { const list = await DB.listMeta(); if (list.length) p = await DB.loadProject(list[0].id); }
  } catch (e) { console.warn(e); toast('Could not open your saved animations'); }
  if (!p) { p = newProject('My first animation'); first = true; }
  S.proj = p;
  pruneAssets(p);
  loadAssets(p);
  S.layer = p.layers.length - 1;
  S.dirty = false; setSaveState(isDraft() ? 'draft' : 'saved');
  if (!first) rememberLast(p.id);
  resize();
  fit();
  setTool(prefs.tool);
  renderTimeline();
  updatePanel();
  updateUndoButtons();
  if (!prefs.helpSeen) { prefs.helpSeen = true; savePrefs(); $('#dlgHelp').showModal(); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
    // When a new version installs, save and reload once so the update shows straight away.
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (!hadController || window.__reloading) return;
      window.__reloading = true;
      await saveNow();
      location.reload();
    });
  }
}
init();
