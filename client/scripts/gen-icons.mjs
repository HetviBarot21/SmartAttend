/**
 * Generates the PWA icon set with zero dependencies (Node's built-in zlib only).
 *
 * The manifest referenced pwa-192x192.png / pwa-512x512.png but public/ shipped
 * none, so the app failed Chrome's installability check. This draws a simple,
 * on-brand mark - indigo rounded square, white check - at the sizes a PWA needs,
 * including a maskable variant with safe-zone padding and an Apple touch icon.
 *
 * Re-run after changing the brand color or mark:  node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(OUT, { recursive: true });

const INDIGO = [79, 70, 229];   // #4f46e5 - matches the app's --indigo
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(size, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // raw scanlines, each prefixed with a filter byte (0 = none)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * (size * 4 + 1) + 1 + x * 4;
      raw[dst] = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// signed distance to a rounded rectangle centred in the canvas
function sdRoundRect(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - radius;
}

// distance from a point to a line segment
function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function blend(out, i, rgb, a) {
  out[i] = Math.round(out[i] * (1 - a) + rgb[0] * a);
  out[i + 1] = Math.round(out[i + 1] * (1 - a) + rgb[1] * a);
  out[i + 2] = Math.round(out[i + 2] * (1 - a) + rgb[2] * a);
  out[i + 3] = Math.max(out[i + 3], Math.round(255 * a));
}

function draw(size, { padding = 0, bleed = false }) {
  const px = new Uint8ClampedArray(size * size * 4); // transparent
  const c = size / 2;
  // Maskable icons must fill the whole canvas (the OS crops to its own shape);
  // the mark then lives inside the ~80% safe zone. Non-maskable icons inset the
  // rounded square itself.
  const half = bleed ? size : size * (0.5 - padding);
  const radius = bleed ? 0 : size * 0.22;
  const stroke = size * 0.075;

  // check mark geometry (in a -0.5..0.5 box, scaled to the tile)
  const markHalf = size * (0.5 - Math.max(padding, bleed ? 0.16 : 0.06));
  const s = markHalf * 1.15;
  const p1 = [c - 0.42 * s, c + 0.02 * s];
  const p2 = [c - 0.12 * s, c + 0.30 * s];
  const p3 = [c + 0.44 * s, c - 0.32 * s];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;

      const bg = sdRoundRect(dx, dy, half, radius);
      const bgA = Math.max(0, Math.min(1, 0.5 - bg));
      if (bgA > 0) blend(px, i, INDIGO, bgA);

      const d = Math.min(
        sdSegment(x + 0.5, y + 0.5, p1[0], p1[1], p2[0], p2[1]),
        sdSegment(x + 0.5, y + 0.5, p2[0], p2[1], p3[0], p3[1]),
      );
      const chkA = Math.max(0, Math.min(1, (stroke - d) + 0.5)) * Math.max(0, Math.min(1, 0.5 - bg));
      if (chkA > 0) blend(px, i, WHITE, chkA);
    }
  }
  return px;
}

const targets = [
  { file: 'pwa-192x192.png', size: 192, padding: 0.02 },
  { file: 'pwa-512x512.png', size: 512, padding: 0.02 },
  { file: 'pwa-maskable-512x512.png', size: 512, bleed: true },
  { file: 'apple-touch-icon.png', size: 180, padding: 0.0 },
  { file: 'favicon-96x96.png', size: 96, padding: 0.02 },
];

for (const t of targets) {
  writeFileSync(join(OUT, t.file), png(t.size, draw(t.size, t)));
  console.log('wrote public/' + t.file);
}
