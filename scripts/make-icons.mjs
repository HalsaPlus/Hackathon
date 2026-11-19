// Draws the app icons (the MMD metro mark on indigo) as PNG files, with no
// dependencies: a small signed-distance rasteriser and a PNG encoder.
// Run: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x18, 0x11, 0x44];
const CYAN = [0x03, 0xd4, 0xd1];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel((x + 0.5) / size, (y + 0.5) / size, 1 / size);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const cover = (d, aa) => Math.max(0, Math.min(1, 0.5 - d / aa));

/** scale < 1 shrinks the mark into the safe zone of a maskable icon. */
function mark(scale) {
  const s = (v) => 0.5 + (v - 0.5) * scale;
  const pts = [[0.16, 0.68], [0.38, 0.68], [0.62, 0.32], [0.84, 0.32]].map(([x, y]) => [s(x), s(y)]);
  const stops = [[0.18, 0.68], [0.5, 0.5], [0.82, 0.32]].map(([x, y]) => [s(x), s(y)]);
  const line = 0.035 * scale, ring = 0.07 * scale, ringW = 0.028 * scale;
  return (x, y, aa) => {
    let c = BG;
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segment(x, y, ...pts[i], ...pts[i + 1]));
    c = mix(c, CYAN, cover(d - line, aa * 1.5));
    for (const [cx, cy] of stops) {
      const r = Math.hypot(x - cx, y - cy);
      c = mix(c, BG, cover(r - ring, aa * 1.5));
      c = mix(c, CYAN, cover(Math.abs(r - ring) - ringW, aa * 1.5));
    }
    return c;
  };
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, mark(1)));
writeFileSync('public/icons/icon-512.png', png(512, mark(1)));
writeFileSync('public/icons/icon-maskable-512.png', png(512, mark(0.72)));
writeFileSync('public/icons/apple-touch-icon.png', png(180, mark(0.86)));
console.log('Wrote public/icons/*.png');
