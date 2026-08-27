// Generates the PWA icons.
//
// Written as a script rather than committed binaries so the icon can follow the
// brand colours without anyone hand-editing a PNG. It draws the same waveform
// mark the site header uses: a dark rounded tile with a teal-to-blue gradient
// bar chart across the middle.
//
//   node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [7, 11, 20];          // --bg
const ACCENT = [53, 224, 208];   // --accent
const ACCENT2 = [91, 141, 255];  // --accent-2

/** Relative bar heights, mirroring the visualiser in the app. */
const BARS = [0.30, 0.55, 0.85, 1.0, 0.72, 0.45, 0.62, 0.35];

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function drawIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);

  // Maskable icons get cropped to a circle by the launcher, so the artwork has
  // to sit inside a safe zone of roughly the middle 80%.
  const inset = maskable ? size * 0.12 : 0;
  const radius = maskable ? 0 : size * 0.22;

  const set = (x, y, [r, g, b], a = 255) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };

  // Background: rounded tile, or full bleed when maskable.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (radius > 0) {
        const dx = Math.max(radius - x, 0, x - (size - radius - 1));
        const dy = Math.max(radius - y, 0, y - (size - radius - 1));
        if (dx > 0 && dy > 0 && dx * dx + dy * dy > radius * radius) {
          set(x, y, BG, 0); // transparent outside the corner curve
          continue;
        }
      }
      set(x, y, BG);
    }
  }

  // Waveform bars, gradient left to right.
  const usable = size - inset * 2;
  const slot = usable / BARS.length;
  const barW = Math.max(2, Math.round(slot * 0.46));
  const midY = size / 2;
  const maxH = usable * 0.42;

  BARS.forEach((h, index) => {
    const colour = lerp(ACCENT, ACCENT2, index / (BARS.length - 1));
    const cx = Math.round(inset + slot * (index + 0.5));
    const half = Math.round((maxH * h) / 2);
    const r = Math.floor(barW / 2);

    for (let y = Math.round(midY - half); y <= Math.round(midY + half); y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        // Round the bar ends so they match the app's rounded bars.
        const distTop = Math.round(midY - half) + r - y;
        const distBottom = y - (Math.round(midY + half) - r);
        const dx = Math.abs(x - cx);
        if (distTop > 0 && dx * dx + distTop * distTop > r * r) continue;
        if (distBottom > 0 && dx * dx + distBottom * distBottom > r * r) continue;
        set(x, y, colour);
      }
    }
  });

  return px;
}

/** Minimal PNG encoder: RGBA, no interlacing. */
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon.png', size: 180, maskable: true } // iOS crops, no alpha
];

for (const t of targets) {
  const png = encodePng(t.size, drawIcon(t.size, { maskable: t.maskable }));
  writeFileSync(path.join(outDir, t.name), png);
  console.log('wrote', t.name, `(${t.size}x${t.size}, ${(png.length / 1024).toFixed(1)}KB)`);
}
