/*
 * Generates the app icon from a small vector-ish description — no dependency,
 * no binary assets checked in: `npm run icons` regenerates it.
 *
 * The shape is a squircle with an Apple-like vertical gradient, so it sits
 * comfortably next to native icons in the Dock and the taskbar.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

/* --------------------------------------------------------------- PNG ----- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------ raster ----- */

/* Layers paint in order. A layer is { shape(u,v), color:[r,g,b,a?] } or
 * { shape(u,v), colorAt(u,v) -> [r,g,b,a?] }. Coverage is supersampled 4x4 and
 * accumulated premultiplied, so edges of overlapping shapes stay clean. */
function rasterize(size, layers, ss) {
  const samples = ss * ss;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (const layer of layers) {
            if (!layer.shape(u, v)) continue;
            const source = layer.colorAt ? layer.colorAt(u, v) : layer.color;
            const la = source[3] === undefined ? 1 : source[3];
            r = source[0] * la + r * (1 - la);
            g = source[1] * la + g * (1 - la);
            b = source[2] * la + b * (1 - la);
            a = la + a * (1 - la);
          }
          sumR += r * a;
          sumG += g * a;
          sumB += b * a;
          sumA += a;
        }
      }
      const alpha = sumA / samples;
      const index = (y * size + x) * 4;
      out[index] = alpha > 0 ? Math.round(sumR / samples / alpha) : 0;
      out[index + 1] = alpha > 0 ? Math.round(sumG / samples / alpha) : 0;
      out[index + 2] = alpha > 0 ? Math.round(sumB / samples / alpha) : 0;
      out[index + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------ shapes ----- */

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* Apple's icon silhouette: a superellipse with generous corner rounding. */
function squircle(inset, exponent) {
  const n = exponent || 5;
  const half = 0.5 - (inset === undefined ? 0.09 : inset);
  return (u, v) => {
    const x = Math.abs((u - 0.5) / half);
    const y = Math.abs((v - 0.5) / half);
    return Math.pow(x, n) + Math.pow(y, n) <= 1;
  };
}

/* A microphone: capsule, half-ring, stem, base. `zoom` is a shrink factor, so
 * larger values mean more padding inside the unit box. */
function microphone(zoom) {
  const scale = zoom;
  return (u, v) => {
    const x = (u - 0.5) * scale + 0.5;
    const y = (v - 0.5) * scale + 0.5;

    const capsule = distanceToSegment(x, y, 0.5, 0.185, 0.5, 0.375) <= 0.15;
    const ring = Math.abs(Math.hypot(x - 0.5, y - 0.4) - 0.28) <= 0.055 && y >= 0.4;
    const stem = Math.abs(x - 0.5) <= 0.05 && y >= 0.7 && y <= 0.85;
    const base = Math.abs(y - 0.89) <= 0.035 && x >= 0.33 && x <= 0.67;
    return capsule || ring || stem || base;
  };
}

/* ------------------------------------------------------------- output ---- */

/* The orb's own palettes, copied from src/renderer/orb.js so the icon and the app
 * are the same object. Indigo → cyan is the "working" palette: calm, and it reads
 * on both a light and a dark dock. */
const CLOUD_COLOURS = [
  [255, 108, 118],
  [255, 150, 92],
  [255, 86, 132],
  [255, 196, 112]
];
const CLOUD_LEVELS = [1.0, 0.78, 0.92, 0.7];
/* Placed by hand rather than by angle: one cloud per quadrant, so each colour
 * keeps its own field instead of the four averaging into one hue, and the
 * top-left corner stays clear for the specular. Offsets are in sphere radii. */
const CLOUD_GEOMETRY = [
  { x: 0.34, y: -0.5, size: 0.82, alpha: 0.7 },
  { x: -0.52, y: -0.22, size: 0.74, alpha: 0.62 },
  { x: 0.2, y: 0.52, size: 0.72, alpha: 0.62 },
  { x: -0.34, y: 0.42, size: 0.6, alpha: 0.6 }
];
const TILE_GRADIENT = [
  { at: 0, rgb: [52, 52, 74] },
  { at: 0.5, rgb: [32, 31, 46] },
  { at: 1, rgb: [16, 16, 24] }
];

function tileAt(v) {
  const clamped = Math.max(0, Math.min(1, v));
  for (let i = 1; i < TILE_GRADIENT.length; i++) {
    const from = TILE_GRADIENT[i - 1];
    const to = TILE_GRADIENT[i];
    if (clamped <= to.at) {
      const k = (clamped - from.at) / (to.at - from.at || 1);
      return [0, 1, 2].map((c) => from.rgb[c] + (to.rgb[c] - from.rgb[c]) * k);
    }
  }
  return TILE_GRADIENT[TILE_GRADIENT.length - 1].rgb.slice();
}

const GRADIENT = [
  { at: 0, rgb: [142, 152, 255] },
  { at: 0.38, rgb: [92, 94, 240] },
  { at: 0.72, rgb: [108, 76, 232] },
  { at: 1, rgb: [58, 40, 150] }
];

function gradientAt(v) {
  const clamped = Math.max(0, Math.min(1, v));
  for (let i = 1; i < GRADIENT.length; i++) {
    const from = GRADIENT[i - 1];
    const to = GRADIENT[i];
    if (clamped <= to.at) {
      const k = (clamped - from.at) / (to.at - from.at || 1);
      return [0, 1, 2].map((channel) => from.rgb[channel] + (to.rgb[channel] - from.rgb[channel]) * k);
    }
  }
  return GRADIENT[GRADIENT.length - 1].rgb.slice();
}

/* Soft radial blob, the same shape the canvas draws: full strength at the centre,
 * fading to nothing at the edge through the same intermediate stops. */
function blob(x, y, cx, cy, radius, alpha) {
  const d = Math.hypot(x - cx, y - cy);
  if (d >= radius) return 0;
  const t = d / radius;
  const falloff = t < 0.45 ? 1 - t * (0.32 / 0.45) : t < 0.75 ? 0.68 - ((t - 0.45) / 0.3) * 0.42 : 0.26 * (1 - (t - 0.75) / 0.25);
  return Math.max(0, alpha * falloff);
}

function over(dst, src, alpha) {
  dst[0] = src[0] * alpha + dst[0] * (1 - alpha);
  dst[1] = src[1] * alpha + dst[1] * (1 - alpha);
  dst[2] = src[2] * alpha + dst[2] * (1 - alpha);
  return dst;
}

/* The orb from src/renderer/orb.js, on the app's dark stage: the same base
 * sphere, four drifting colour clouds, top-left specular, bottom shade, rim and
 * the aura it throws around itself. */
function appIcon(size) {
  const sphere = 0.26; // sphere radius in canvas units
  const auraMax = 1.65;

  const orbAt = (u, v) => {
    const x = u - 0.5;
    const y = v - 0.5;
    const distance = Math.hypot(x, y);

    /* The aura first: everything it covers is lifted by the glow. */
    const auraRadius = sphere * (1.3 + (auraMax - 1.3) * 0.62);
    const color = [0, 0, 0];
    if (distance < auraRadius) {
      const t = Math.max(0, (distance - sphere * 0.4) / (auraRadius - sphere * 0.4));
      const alpha = (0.32 + 0.42 * 0.62) * Math.max(0, 1 - t) ** 1.6;
      over(color, [255, 140, 100], alpha);
    }

    /* The base sphere: light at the top-left, deep at the bottom-right. */
    if (distance <= sphere) {
      const light = Math.max(0, 1 - Math.hypot(x + sphere * 0.3, y + sphere * 0.38) / (sphere * 1.1));
      const base = [
        38 + (86 - 38) * light,
        28 + (62 - 28) * light,
        44 + (104 - 44) * light
      ];
      const inset = Math.max(0, 1 - distance / sphere);
      color[0] = base[0] * Math.min(1, 0.55 + inset * 0.45);
      color[1] = base[1] * Math.min(1, 0.55 + inset * 0.45);
      color[2] = base[2] * Math.min(1, 0.55 + inset * 0.45);

      /* A faint warm haze first, so the glass never reads as a bare dark ball
       * between the clouds — the same thing the live orb does when the room is
       * loud enough for all four bands to open. */
      const haze = Math.max(0, 1 - distance / (sphere * 1.02));
      if (haze > 0) over(color, [214, 108, 96], 0.34 * haze);

      /* The clouds, one per band, each orbiting its own way. */
      for (let i = 0; i < CLOUD_GEOMETRY.length; i++) {
        const cloud = CLOUD_GEOMETRY[i];
        const cx = cloud.x * sphere;
        const cy = cloud.y * sphere;
        const radius = sphere * cloud.size * (0.82 + 0.34 * CLOUD_LEVELS[i]);
        const alpha = Math.min(1, cloud.alpha * (0.72 + 0.45 * CLOUD_LEVELS[i]) * 1.3);
        const a = blob(x, y, cx, cy, radius, alpha) * (1 - Math.max(0, (distance - sphere * 0.98) / (sphere * 0.02)));
        if (a > 0) over(color, CLOUD_COLOURS[i], Math.min(1, a));
      }

      /* Top-left specular, then the shade at the bottom, then the rim light. */
      const spec = blob(x, y, -sphere * 0.34, -sphere * 0.46, sphere * 0.62, 0.26);
      if (spec > 0) over(color, [255, 255, 255], spec);
      const shade = blob(x, y, sphere * 0.2, sphere * 0.55, sphere * 1.25, 0.18);
      if (shade > 0) over(color, [10, 8, 20], shade);
      const rim = Math.max(0, 1 - Math.abs(distance - sphere) / (1.1 / size));
      if (rim > 0) over(color, [255, 255, 255], rim * 0.22);
    }

    return color;
  };

  const tile = squircle(0.075, 5);
  return encodePng(
    size,
    size,
    rasterize(
      size,
      [
        // the stage: a near-black tile, slightly lighter at the top
        { shape: tile, colorAt: (u, v) => tileAt(v).concat([1]) },
        { shape: (u, v) => tile(u, v) && v < 0.5, color: [255, 255, 255, 0.035] },
        {
          shape: (u, v) => tile(u, v) && Math.hypot(u - 0.5, v - 0.5) < 0.47,
          colorAt: (u, v) => [255, 130, 110, 0.15 * Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) / 0.47)]
        },
        // the orb, kept inside the tile
        { shape: (u, v) => tile(u, v) && (Math.hypot(u - 0.5, v - 0.5) < sphere * 1.65), colorAt: (u, v) => orbAt(u, v).concat([1]) }
      ],
      4
    )
  );
}

function write(dir, name, buffer) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  console.log('wrote', path.relative(ROOT, file));
}

function main() {
  // build/icon.png is what electron-builder turns into .icns/.ico.
  write(path.join(ROOT, 'build'), 'icon.png', appIcon(1024));
  // assets/icon.png is the Dock icon at runtime and the window icon on Windows.
  write(path.join(ROOT, 'assets'), 'icon.png', appIcon(1024));
  // Linux asks for a folder of named sizes (hicolor theme).
  [256, 512, 1024].forEach((size) => {
    write(path.join(ROOT, 'build', 'icons'), `${size}x${size}.png`, appIcon(size));
  });
}

main();

module.exports = { encodePng, rasterize, microphone, squircle, appIcon };
