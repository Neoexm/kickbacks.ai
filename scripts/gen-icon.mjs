// Zero-dependency icon generator for the Kickbacks extension.
// Renders media/icon.png (128×128, 4× supersampled) procedurally — a white "K"
// on a rounded green square, matching the kickbacks.ai site nav logo. No SVG
// rasterizer or native deps (just Node's built-in zlib). Run: `npm run icon`.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 128;
const SS = 4; // supersampling factor (anti-aliasing via averaging)

const GREEN = [24, 138, 69];   // #188a45 — site --accent
const WHITE = [255, 255, 255]; // K strokes

// Signed distance to a rounded rectangle centred at (cx,cy).
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Signed distance to a thick line segment a→b (round caps), minus half-width.
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1,
    (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

// The "K": vertical spine + upper and lower diagonals, all round-capped.
const SPINE_TOP = [45, 34], SPINE_BOT = [45, 94];
const JOIN = [45, 64];
const UPPER_TIP = [90, 34], LOWER_TIP = [90, 94];
const STROKE = 8.5; // half of site's stroke-width=17

function sample(x, y) {
  if (sdRoundRect(x, y, 64, 64, 60, 60, 32) > 0) return [0, 0, 0, 0]; // outside box
  const inK =
    sdCapsule(x, y, SPINE_TOP[0], SPINE_TOP[1], SPINE_BOT[0], SPINE_BOT[1], STROKE) <= 0 ||
    sdCapsule(x, y, JOIN[0], JOIN[1], UPPER_TIP[0], UPPER_TIP[1], STROKE) <= 0 ||
    sdCapsule(x, y, JOIN[0], JOIN[1], LOWER_TIP[0], LOWER_TIP[1], STROKE) <= 0;
  const c = inK ? WHITE : GREEN;
  return [c[0], c[1], c[2], 255];
}

// Render with SS×SS supersampling → straight-alpha RGBA buffer.
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const s = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
        r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
      }
    }
    const n = SS * SS;
    const o = (py * SIZE + px) * 4;
    rgba[o] = a ? Math.round(r / a) : 0;
    rgba[o + 1] = a ? Math.round(g / a) : 0;
    rgba[o + 2] = a ? Math.round(b / a) : 0;
    rgba[o + 3] = Math.round(a / n);
  }
}

// --- Minimal PNG encoder (RGBA, 8-bit, filter 0) ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tb = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // colour type RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "icon.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}×${SIZE})`);
