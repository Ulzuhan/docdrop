#!/usr/bin/env node
/**
 * Generates the PWA icons.
 *
 * No ImageMagick or Pillow required: the icon is rasterised by hand and the PNG is
 * written with zlib, which ships with Node. One-shot script — the resulting PNGs are
 * committed, so it only needs re-running when the design changes.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Minimal PNG (RGBA, no filtering) ────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // RGBA
  // Each row is preceded by its filter byte (0 = none).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── Drawing ─────────────────────────────────────────────────────────
// The DocDrop mark: a drop landing on a line, white over the ember gradient
// the interface uses for everything that expires. Same shape as `Mark` in
// src/components/brand.tsx, rasterised here.
const EMBER_TOP = [248, 170, 60];
const EMBER_BOTTOM = [226, 90, 32];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Signed distance to a rounded rectangle, for smooth edges. */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to a convex triangle: negative inside. */
function triangleSdf(px, py, a, b, c) {
  const cx = (a[0] + b[0] + c[0]) / 3;
  const cy = (a[1] + b[1] + c[1]) / 3;
  let worst = -Infinity;
  for (const [p, q] of [[a, b], [b, c], [c, a]]) {
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len = Math.hypot(ex, ey);
    // Distance to the edge line, signed so the centroid is inside.
    const side = (ex * (py - p[1]) - ey * (px - p[0])) / len;
    const centroidSide = (ex * (cy - p[1]) - ey * (cx - p[0])) / len;
    worst = Math.max(worst, centroidSide < 0 ? side : -side);
  }
  return worst;
}

/**
 * Drop-on-a-line silhouette. Coordinates are normalised to the canvas so it
 * scales to any size.
 */
function markSdf(x, y, size, scale) {
  const c = size / 2;
  const u = size * scale; // design unit

  // The drop: a circle and the triangle that reaches up to the apex, joined
  // at the tangent points.
  const cx = c;
  const cy = c + u * 0.08;
  const r = u * 0.3;
  const circle = Math.hypot(x - cx, y - cy) - r;
  const apex = [c, c - u * 0.52];
  const d = cy - apex[1];
  const theta = Math.acos(r / d);
  const t1 = [cx + r * Math.sin(theta), cy - r * Math.cos(theta)];
  const t2 = [cx - r * Math.sin(theta), cy - r * Math.cos(theta)];
  const cone = triangleSdf(x, y, apex, t1, t2);

  // The line it lands on.
  const tray = roundedRectSdf(x, y, c, c + u * 0.54, u * 0.3, u * 0.05, u * 0.05);

  return Math.min(circle, cone, tray);
}

function renderIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  // The maskable icon leaves margin: launchers crop up to 20% of the edge.
  const symbolScale = maskable ? 0.44 : 0.58;
  const radius = maskable ? size / 2 : size * 0.22;
  const SS = 3; // supersampling to smooth the edges

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCover = 0;
      let symCover = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          const bg = maskable
            ? Math.hypot(px - size / 2, py - size / 2) - size / 2
            : roundedRectSdf(px, py, size / 2, size / 2, size / 2, size / 2, radius);
          if (bg <= 0) bgCover++;
          if (markSdf(px, py, size, symbolScale) <= 0) symCover++;
        }
      }

      const total = SS * SS;
      const bgAlpha = bgCover / total;
      const symAlpha = symCover / total;

      // Diagonal gradient, lighter at the top left.
      const [r, g, b] = mix(EMBER_TOP, EMBER_BOTTOM, (x + y) / (2 * size));
      const i = (y * size + x) * 4;
      // The symbol is white over the gradient.
      rgba[i] = Math.round(r + (255 - r) * symAlpha);
      rgba[i + 1] = Math.round(g + (255 - g) * symAlpha);
      rgba[i + 2] = Math.round(b + (255 - b) * symAlpha);
      rgba[i + 3] = Math.round(255 * bgAlpha);
    }
  }

  return encodePng(size, size, rgba);
}

// ─── Output ──────────────────────────────────────────────────────────
mkdirSync(join(root, "public", "icons"), { recursive: true });

const outputs = [
  ["public/icons/icon-192.png", renderIcon(192)],
  ["public/icons/icon-512.png", renderIcon(512)],
  ["public/icons/icon-maskable-512.png", renderIcon(512, { maskable: true })],
  // Standalone touch icon; served as a public resource.
  ["public/apple-icon.png", renderIcon(180)],
  // Standalone favicon; served as a public resource.
  ["public/icon.png", renderIcon(64)],
];

for (const [relative, buffer] of outputs) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  console.log(`  ${relative}  (${(buffer.length / 1024).toFixed(1)} KB)`);
}
console.log("Icons generated.");
