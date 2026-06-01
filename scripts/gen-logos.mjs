// Generates a full set of Kickbacks logo assets from the procedural green-K design.
// Outputs to extension/media/logos/. Run: `node extension/scripts/gen-logos.mjs`
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GREEN = [24, 138, 69];   // #188a45
const WHITE = [255, 255, 255];
const SS = 4; // supersampling factor

// --- SDF primitives ---
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1,
    (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

// K geometry (in 128×128 space)
const SPINE_TOP = [45, 34], SPINE_BOT = [45, 94];
const JOIN = [45, 64];
const UPPER_TIP = [90, 34], LOWER_TIP = [90, 94];
const STROKE = 8.5;

function sample(x, y) {
  if (sdRoundRect(x, y, 64, 64, 60, 60, 32) > 0) return [0, 0, 0, 0];
  const inK =
    sdCapsule(x, y, SPINE_TOP[0], SPINE_TOP[1], SPINE_BOT[0], SPINE_BOT[1], STROKE) <= 0 ||
    sdCapsule(x, y, JOIN[0], JOIN[1], UPPER_TIP[0], UPPER_TIP[1], STROKE) <= 0 ||
    sdCapsule(x, y, JOIN[0], JOIN[1], LOWER_TIP[0], LOWER_TIP[1], STROKE) <= 0;
  const c = inK ? WHITE : GREEN;
  return [c[0], c[1], c[2], 255];
}

// --- Render at arbitrary size ---
function render(size) {
  const scale = size / 128;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const cx = (px + (sx + 0.5) / SS) / scale;
          const cy = (py + (sy + 0.5) / SS) / scale;
          const s = sample(cx, cy);
          r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
        }
      }
      const n = SS * SS;
      const o = (py * size + px) * 4;
      rgba[o] = a ? Math.round(r / a) : 0;
      rgba[o + 1] = a ? Math.round(g / a) : 0;
      rgba[o + 2] = a ? Math.round(b / a) : 0;
      rgba[o + 3] = Math.round(a / n);
    }
  }
  return rgba;
}

// --- PNG encoder ---
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
function toPNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- ICO encoder (multi-size) ---
function toICO(entries) {
  // entries: [{size, png}]
  const count = entries.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const { size, png } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4);  // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...entries.map(e => e.png)]);
}

// --- Generate all assets ---
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "logos");
mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 180, 192, 256, 512];
const generated = [];

for (const size of sizes) {
  const rgba = render(size);
  const png = toPNG(rgba, size);
  const name = `kickbacks-${size}.png`;
  writeFileSync(join(outDir, name), png);
  generated.push({ size, png, name });
  console.log(`  ${name} (${png.length} bytes)`);
}

// favicon.ico (16, 32, 48)
const icoEntries = generated
  .filter(g => [16, 32, 48].includes(g.size))
  .map(g => ({ size: g.size, png: g.png }));
const ico = toICO(icoEntries);
writeFileSync(join(outDir, "favicon.ico"), ico);
console.log(`  favicon.ico (${ico.length} bytes, ${icoEntries.length} sizes)`);

// favicon-32.png (common web favicon)
const fav32 = generated.find(g => g.size === 32);
writeFileSync(join(outDir, "favicon-32.png"), fav32.png);

// apple-touch-icon (180×180)
const apple = generated.find(g => g.size === 180);
writeFileSync(join(outDir, "apple-touch-icon.png"), apple.png);
console.log(`  apple-touch-icon.png (${apple.png.length} bytes)`);

// og-image / social card (512×512 is good for Open Graph)
const og = generated.find(g => g.size === 512);
writeFileSync(join(outDir, "og-logo.png"), og.png);
console.log(`  og-logo.png (${og.png.length} bytes)`);

// Android/PWA icons (192, 512)
const pwa192 = generated.find(g => g.size === 192);
writeFileSync(join(outDir, "icon-192.png"), pwa192.png);
const pwa512 = generated.find(g => g.size === 512);
writeFileSync(join(outDir, "icon-512.png"), pwa512.png);
console.log(`  icon-192.png + icon-512.png (PWA)`);

// SVG copies for easy access
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Kickbacks.ai">
  <rect x="4" y="4" width="120" height="120" rx="32" fill="#188a45"/>
  <g stroke="#ffffff" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <line x1="45" y1="34" x2="45" y2="94"/>
    <line x1="45" y1="64" x2="90" y2="34"/>
    <line x1="45" y1="64" x2="90" y2="94"/>
  </g>
</svg>`;
writeFileSync(join(outDir, "kickbacks.svg"), svg);

// Monochrome white SVG (for dark backgrounds)
const svgWhite = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Kickbacks.ai">
  <g stroke="#ffffff" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <line x1="45" y1="34" x2="45" y2="94"/>
    <line x1="45" y1="64" x2="90" y2="34"/>
    <line x1="45" y1="64" x2="90" y2="94"/>
  </g>
</svg>`;
writeFileSync(join(outDir, "kickbacks-white.svg"), svgWhite);

// Monochrome green SVG (K only, no background — for light backgrounds)
const svgGreen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Kickbacks.ai">
  <g stroke="#188a45" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <line x1="45" y1="34" x2="45" y2="94"/>
    <line x1="45" y1="64" x2="90" y2="34"/>
    <line x1="45" y1="64" x2="90" y2="94"/>
  </g>
</svg>`;
writeFileSync(join(outDir, "kickbacks-green.svg"), svgGreen);

// Favicon SVG (for <link rel="icon" type="image/svg+xml">)
writeFileSync(join(outDir, "favicon.svg"), svg);

console.log(`\nDone! All assets in: ${outDir}`);
console.log(`\nUsage in HTML:`);
console.log(`  <link rel="icon" type="image/svg+xml" href="/logos/favicon.svg">`);
console.log(`  <link rel="icon" type="image/png" sizes="32x32" href="/logos/favicon-32.png">`);
console.log(`  <link rel="apple-touch-icon" href="/logos/apple-touch-icon.png">`);
console.log(`  <meta property="og:image" content="/logos/og-logo.png">`);
