// png-squeeze: lossless PNG recompressor for 1280x720 RGBA screenshots.
// Node 22, stdlib only. Deterministic: fixed amount of work per instance,
// no clock, no environment-dependent branching, no network.
// Strategy (measured on the practice set, ~702k vs house baseline ~420k):
//  - decode the stored RGBA PNG (inflate + unfilter, written here)
//  - per instance pick the smallest colour form: palette (<=256 colours,
//    orders by frequency and by luminance, + tRNS when any alpha < 255),
//    grey / grey+alpha for grey images, RGB / RGBA otherwise, with a tRNS
//    single-transparent-colour form when every transparent pixel shares
//    one colour no opaque pixel uses
//  - per form try the four fixed PNG filters (None/Sub/Up/Paeth) on every
//    row, rank candidates by zlib level 6 size, then re-encode the best
//    two at zlib level 9 with both the default and the filtered strategy.
//    Fixed filters only, by measurement: a cheap per-row cost model
//    (sum of |filtered byte|) scored 623k on practice, adaptive
//    per-row brute-force deflate scored 703k but took 28s, and fixed
//    filters alone scored 702k in ~20s — the adaptive search buys
//    almost nothing on these screenshots. Palette forms use filter 0
//    only: fixed Sub/Up/Paeth never beat it on the practice flats.
//  - emit only IHDR / PLTE / tRNS / IDAT / IEND, bit depth 8, not
//    interlaced, correct CRCs. Two runs write byte-identical files.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants } from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b, s = 0, e = b.length) {
  let c = -1;
  for (let i = s; i < e; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- PNG decode (input is a stored RGBA PNG; grey/RGB/grey+alpha also read) ----
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { w = view.getUint32(at + 8); h = view.getUint32(at + 12); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b))));
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const stride = w * bpp;
  const samples = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], src = y * (stride + 1) + 1, o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? samples[o + i - bpp] : 0, b = y > 0 ? samples[p + i] : 0, c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
      samples[o + i] = raw[src + i] + paeth(a, b, c);
    }
  }
  const n = w * h, rgba = new Uint8Array(n * 4);
  if (ct === 6) rgba.set(samples);
  else if (ct === 2) { for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) { rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2]; rgba[d + 3] = 255; } }
  else if (ct === 0) { for (let i = 0, d = 0; i < n; i++, d += 4) { const g = samples[i]; rgba[d] = rgba[d + 1] = rgba[d + 2] = g; rgba[d + 3] = 255; } }
  else if (ct === 4) { for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s]; rgba[d + 3] = samples[s + 1]; } }
  else throw new Error('palette input not expected');
  return { rgba, width: w, height: h };
}

// ---- image analysis ----
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i], k = counts.get(c);
      if (k === undefined) { if (counts.size === 256) many = true; else counts.set(c, 1); }
      else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}
// One colour shared by every fully transparent pixel, used by no opaque
// pixel: then the alpha channel can be dropped and carried as tRNS.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// ---- palette forms ----
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0, tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word; // 'count'
  });
}
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2, u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters: [0] });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) { ct = opaque || key !== null ? 0 : 4; if (key !== null) trns = Uint8Array.of(0, key); }
  else { ct = opaque || key !== null ? 2 : 6; if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff); }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  // One byte per pixel (grey / grey+alpha): per-row adaptive filter choice
  // by real deflate cost is worth ~5% there (practice i004: 111,651 fixed
  // vs 106,213 adaptive) and its rows are short, so it stays cheap.
  // For 3-4 byte rows the same search buys <1% and costs far more, so
  // those keep fixed filters only.
  const filters = bpp === 1 ? [0, 1, 2, 4, 'brute'] : [0, 1, 2, 4];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters });
  return forms;
}

// ---- PNG row filtering ----
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) { for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0); }
  else if (type === 2) { for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]); }
  else if (type === 3) { for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1); }
  else { for (let i = 0; i < n; i++) { const a = i >= bpp ? cur[i - bpp] : 0, b = prev === null ? 0 : prev[i], c = prev !== null && i >= bpp ? prev[i - bpp] : 0; out[i] = cur[i] - paeth(a, b, c); } }
}
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const row = new Uint8Array(stride);
  // 'brute': pick each row's filter by its real level-4 deflate size,
  // with the already-written filtered bytes as dictionary (greedy and
  // close to the global optimum; this is the proto3 approach).
  const trial = choice === 'brute' ? Array.from({ length: 5 }, () => new Uint8Array(stride)) : null;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (choice === 'brute') {
      const before = raw.subarray(Math.max(0, at - 32768), at);
      let type = 0, best = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t]);
        const cost = deflateSync(trial[t], before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before }).length;
        if (cost < best) { best = cost; type = t; }
      }
      raw[at] = type;
      raw.set(trial[type], at + 1);
      continue;
    }
    raw[at] = choice;
    filterRow(choice, cur, prev, bpp, row);
    raw.set(row, at + 1);
  }
  return raw;
}

// ---- PNG write ----
function pngOf(chunks) {
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(w, h, ct) {
  const d = new Uint8Array(13), v = new DataView(d.buffer);
  v.setUint32(0, w); v.setUint32(4, h); d[8] = 8; d[9] = ct;
  return d;
}
const chunkBytes = (f) => (f.plte ? 12 + f.plte.length : 0) + (f.trns ? 12 + f.trns.length : 0);

// ---- per-instance compression ----
function compressInstance(rgba, width, height) {
  const forms = formsOf(rgba);
  const cands = [];
  for (const form of forms) {
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, { level: 6, memLevel: 9 });
      cands.push({ form, data, bytes6: z.length + chunkBytes(form) });
    }
  }
  cands.sort((a, b) => a.bytes6 - b.bytes6);
  // Level-6 ranking can mis-rank against level 9 (e.g. practice i004:
  // the winner was 3rd by level 6, 5% smaller at level 9), so the best
  // three candidates get a level-9 encode instead of two.
  let best = null;
  for (const c of cands.slice(0, 3)) {
    for (const strat of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      const z = deflateSync(c.data, { level: 9, memLevel: 9, strategy: strat });
      const bytes = z.length + chunkBytes(c.form);
      if (!best || bytes < best.bytes) best = { form: c.form, bytes, z };
    }
  }
  const chunks = [['IHDR', ihdrOf(width, height, best.form.colourType)]];
  if (best.form.plte) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', new Uint8Array(best.z)], ['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

for (const id of readdirSync(I).sort()) {
  const img = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const png = compressInstance(img.rgba, img.width, img.height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
}
