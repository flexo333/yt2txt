// Renders the PWA icon set in public/icons/ from the same geometry as
// public/yt2txt.svg. Dependency-free (node:zlib only) so it runs under the
// plain `node` container: `node scripts/generate-icons.mjs`.
//
// Re-run this whenever public/yt2txt.svg changes — the shapes below are a
// hand-port of that file's paths, not a parse of it.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const RED = [0xff, 0x00, 0x00];
const WHITE = [0xff, 0xff, 0xff];

// yt2txt.svg is drawn in a 64×64 viewBox: a rounded red plate, three vertical
// "video" bars on the left, three horizontal "text" rules on the right.
const VIEWBOX = 64;
const PLATE_RADIUS = 14;
const STROKE = 4;
const STROKES = [
  [16, 22, 16, 42],
  [22, 16, 22, 48],
  [28, 26, 28, 38],
  [38, 22, 52, 22],
  [38, 32, 52, 32],
  [38, 42, 46, 42],
];

const SAMPLES = 4; // supersampling factor per axis

// ── Signed distance fields (negative inside) ────────────────────────────────
const roundedRectSdf = (px, py, w, h, r) => {
  const dx = Math.abs(px - w / 2) - (w / 2 - r);
  const dy = Math.abs(py - h / 2) - (h / 2 - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
};

// Round-capped line segment, matching SVG's stroke-linecap="round".
const capsuleSdf = (px, py, ax, ay, bx, by, r) => {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) - r;
};

// ── Rasteriser ──────────────────────────────────────────────────────────────
// `glyphScale` shrinks the artwork toward the centre so maskable icons keep
// their content inside the 80% safe zone that launchers may crop to.
function render(size, { maskable = false, glyphScale = 1 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const unit = VIEWBOX / size; // viewBox units per device pixel
  const inv = 1 / SAMPLES;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let plateCoverage = 0;
      let glyphCoverage = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const ux = (x + (sx + 0.5) * inv) * unit;
          const uy = (y + (sy + 0.5) * inv) * unit;

          if (maskable) {
            plateCoverage += 1; // full-bleed: the launcher applies its own mask
          } else if (roundedRectSdf(ux, uy, VIEWBOX, VIEWBOX, PLATE_RADIUS) <= 0) {
            plateCoverage += 1;
          }

          // Map the sample back into unscaled glyph space.
          const gx = (ux - VIEWBOX / 2) / glyphScale + VIEWBOX / 2;
          const gy = (uy - VIEWBOX / 2) / glyphScale + VIEWBOX / 2;
          const hit = STROKES.some(([ax, ay, bx, by]) =>
            capsuleSdf(gx, gy, ax, ay, bx, by, STROKE / 2) <= 0);
          if (hit) glyphCoverage += 1;
        }
      }

      const total = SAMPLES * SAMPLES;
      const plate = plateCoverage / total;
      const glyph = glyphCoverage / total;
      const alpha = Math.max(plate, glyph);
      const i = (y * size + x) * 4;

      if (alpha === 0) continue;
      // Composite white over red, then premultiply nothing — straight alpha.
      const mix = glyph / alpha;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(RED[c] * (1 - mix) + WHITE[c] * mix);
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }

  return rgba;
}

// ── Minimal PNG encoder (RGBA8, no interlace) ───────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  // Filter type 0 (None) prefixed to every scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Outputs ─────────────────────────────────────────────────────────────────
const TARGETS = [
  { file: "icon-192.png", size: 192, opts: {} },
  { file: "icon-512.png", size: 512, opts: {} },
  { file: "icon-maskable-192.png", size: 192, opts: { maskable: true, glyphScale: 0.68 } },
  { file: "icon-maskable-512.png", size: 512, opts: { maskable: true, glyphScale: 0.68 } },
  // iOS applies its own rounding, so ship a full-bleed square.
  { file: "apple-touch-icon-180.png", size: 180, opts: { maskable: true, glyphScale: 0.82 } },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, opts } of TARGETS) {
  const png = encodePng(size, render(size, opts));
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`wrote ${file} (${size}×${size}, ${png.length} bytes)`);
}
