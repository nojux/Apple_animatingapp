// Small animated GIF encoder: median-cut palette shared by all frames, LZW compression.

function buildPalette(frames, maxColors = 256) {
  // Histogram on 5 bits per channel.
  const hist = new Uint32Array(32768);
  for (const f of frames) {
    const d = f.data;
    const step = d.length > 4 * 400000 ? 8 : 4; // sample big frames
    for (let i = 0; i < d.length; i += step) hist[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)]++;
  }
  const colors = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) colors.push(k);
  const comp = (k, c) => (c === 0 ? (k >> 10) & 31 : c === 1 ? (k >> 5) & 31 : k & 31);
  let boxes = [colors];
  while (boxes.length < maxColors) {
    let bi = -1, bscore = 0, bch = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      let score = 0, ch = 0;
      for (let c = 0; c < 3; c++) {
        let lo = 31, hi = 0;
        for (const k of b) { const v = comp(k, c); if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo > score) { score = hi - lo; ch = c; }
      }
      let w = 0; for (const k of b) w += hist[k];
      const s = score * Math.sqrt(w);
      if (score > 0 && s > bscore) { bscore = s; bi = i; bch = ch; }
    });
    if (bi < 0) break;
    const b = boxes[bi].sort((x, y) => comp(x, bch) - comp(y, bch));
    let total = 0; for (const k of b) total += hist[k];
    let acc = 0, cut = 1;
    for (let i = 0; i < b.length - 1; i++) { acc += hist[b[i]]; if (acc >= total / 2) { cut = i + 1; break; } }
    boxes.splice(bi, 1, b.slice(0, cut), b.slice(cut));
  }
  const pal = boxes.map((b) => {
    let r = 0, g = 0, bl = 0, w = 0;
    for (const k of b) { const h = hist[k]; r += comp(k, 0) * h; g += comp(k, 1) * h; bl += comp(k, 2) * h; w += h; }
    return [Math.round((r / w) * 8.226), Math.round((g / w) * 8.226), Math.round((bl / w) * 8.226)];
  });
  while (pal.length < 256) pal.push([0, 0, 0]);
  return pal;
}

function lzw(indices, out) {
  const min = 8, clear = 256, eoi = 257;
  let size = 9, next = 258, cur = 0, shift = 0;
  let table = new Map();
  const bytes = [];
  const emit = (code) => {
    cur |= code << shift; shift += size;
    while (shift >= 8) { bytes.push(cur & 255); cur >>>= 8; shift -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (prefix << 8) | k;
    const c = table.get(key);
    if (c !== undefined) { prefix = c; continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); table = new Map(); next = 258; size = 9; }
    else { if (next >= 1 << size) size++; table.set(key, next++); }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) bytes.push(cur & 255);
  out.push(min);
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out.push(n);
    for (let j = 0; j < n; j++) out.push(bytes[i + j]);
  }
  out.push(0);
}

// Options: { width, height, count, fps, getFrame(i) -> ImageData (may be async), colors, loop: 'forever'|'once'|number, onProgress }
export async function encodeGIF(o) {
  const { width: w, height: h, count, fps } = o;
  const onProgress = o.onProgress || (() => {});
  // Build the palette from a sample of frames so memory stays small.
  const sampleIdx = [];
  const want = Math.min(count, 12);
  for (let k = 0; k < want; k++) sampleIdx.push(Math.floor((k * count) / want));
  const samples = [];
  for (const i of sampleIdx) samples.push(await o.getFrame(i));
  const pal = buildPalette(samples, o.colors || 256);
  samples.length = 0;
  const map = new Int16Array(32768).fill(-1);
  const nearest = (key) => {
    const r = ((key >> 10) & 31) * 8.226, g = ((key >> 5) & 31) * 8.226, b = (key & 31) * 8.226;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const p = pal[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const chunks = [];
  const head = [];
  const u16 = (a, v) => a.push(v & 255, (v >> 8) & 255);
  for (const ch of 'GIF89a') head.push(ch.charCodeAt(0));
  u16(head, w); u16(head, h);
  head.push(0xf7, 0, 0);
  for (const p of pal) head.push(p[0], p[1], p[2]);
  if (o.loop !== 'once') {
    head.push(0x21, 0xff, 0x0b);
    for (const ch of 'NETSCAPE2.0') head.push(ch.charCodeAt(0));
    const n = o.loop === 'forever' || o.loop == null ? 0 : Math.max(1, (+o.loop) - 1);
    head.push(3, 1); u16(head, n); head.push(0);
  }
  chunks.push(new Uint8Array(head));
  const idx = new Uint8Array(w * h);
  for (let f = 0; f < count; f++) {
    const d = (await o.getFrame(f)).data;
    for (let i = 0, j = 0; j < idx.length; i += 4, j++) {
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      let m = map[key];
      if (m < 0) m = map[key] = nearest(key);
      idx[j] = m;
    }
    const delay = Math.max(2, Math.round(((f + 1) * 100) / fps) - Math.round((f * 100) / fps));
    const out = [0x21, 0xf9, 4, 0x04, delay & 255, (delay >> 8) & 255, 0, 0, 0x2c, 0, 0, 0, 0];
    u16(out, w); u16(out, h); out.push(0);
    lzw(idx, out);
    chunks.push(new Uint8Array(out));
    onProgress((f + 1) / count);
    await new Promise((r) => setTimeout(r, 0));
  }
  chunks.push(new Uint8Array([0x3b]));
  return new Blob(chunks, { type: 'image/gif' });
}
