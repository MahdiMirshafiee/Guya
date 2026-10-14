/*
 * Generates the app icon from a small vector-ish description — no dependency,
 * no binary assets checked in: `npm run icons` regenerates it.
 *
 * The icon is the product's own object — the orb — drawn as a lit sphere on a
 * tile sized to Apple's grid, so it sits comfortably next to native icons in the
 * Dock and the taskbar.
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
  { at: 0, rgb: [80, 80, 110] },
  { at: 0.5, rgb: [48, 47, 70] },
  { at: 1, rgb: [28, 28, 42] }
];

function tileGradient(v) {
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

/* ------------------------------------------------------------- the orb ---- */

/* The icon is a lit sphere sitting on a tile, not a flat blob. Everything below
 * is per-pixel: a normal on the sphere, one light, and the terms a physical ball
 * has — diffuse, a tight specular, a rim, a bounce from below and the shadow it
 * casts on the tile. That is what makes it read as an object rather than a
 * circle of colour. */
const LIGHT = (() => {
  const v = [-0.42, -0.62, 0.66];
  const length = Math.hypot(v[0], v[1], v[2]);
  return v.map((n) => n / length);
})();

/* A superellipse distance: 1 at the edge of the shape, larger outside it. */
function shapeDistance(u, v, inset, exponent) {
  const half = 0.5 - inset;
  const x = Math.abs((u - 0.5) / half);
  const y = Math.abs((v - 0.5) / half);
  return Math.pow(Math.pow(x, exponent) + Math.pow(y, exponent), 1 / exponent);
}

/* The interior, as an albedo: the glass the sphere is made of, with the clouds
 * composited over it in order, the way the renderer draws them. Averaging them
 * into one colour is what turns four lights into a single muddy blur. */
const GLASS_BASE = [104, 62, 86]; // the glass itself, already lit from within
const GLASS_TINT = [150, 84, 104];

function cloudAlbedo(nx, ny) {
  const colour = GLASS_BASE.slice();
  const radial = Math.max(0, 1 - Math.hypot(nx, ny));
  for (let channel = 0; channel < 3; channel++) {
    colour[channel] = colour[channel] * (1 - radial * 0.55) + GLASS_TINT[channel] * radial * 0.55;
  }
  for (let i = 0; i < CLOUD_GEOMETRY.length; i++) {
    const cloud = CLOUD_GEOMETRY[i];
    const d = Math.hypot(nx - cloud.x, ny - cloud.y) / cloud.size;
    if (d >= 1) continue;
    const falloff = Math.min(1, Math.pow(1 - d, 1.05) * (cloud.alpha + 0.28));
    for (let channel = 0; channel < 3; channel++) {
      colour[channel] = CLOUD_COLOURS[i][channel] * falloff + colour[channel] * (1 - falloff);
    }
  }
  return colour.map((c) => Math.min(255, c));
}

/* Two artworks come out of this file, because the platforms want opposite things:
 *
 * - macOS 26 masks the icon itself. Art that does not reach the canvas edge is
 *   treated as a photograph: the system discards the baked shape, rescales the
 *   content and puts its own background behind it, which is how you end up with a
 *   tile inside a tile. So macOS gets the art edge to edge, and the silhouette it
 *   is cut to is not ours to draw.
 * - Windows and Linux draw the file as it is, so they get the shaped variant. */
function appIcon(size, options) {
  const bleed = Boolean(options && options.bleed);
  const inset = 0.0977; // Apple's grid: an 824 body inside a 1024 canvas
  /* Fitted to the mask macOS 26 renders here, measured against one of Apple's own
   * icons (Chess): the corner profile matches a superellipse at exponent 4.3 to
   * 1.1px over 1024. Exponent 5 — the usual rule of thumb — is measurably squarer
   * than what the system actually ships. */
  const exponent = 4.3;
  /* The ball fills a good share of the tile so it still reads as a sphere at 32
   * px, and its aura stops right at the body's edge — a glow cut off by the tile
   * would show as a hard line. */
  const sphere = 0.3; // sphere radius in canvas units
  const auraMax = (0.5 - inset) / sphere;

  /* The tile: a lit surface, so the sphere has something to sit on. */
  function tileAt(u, v) {
    const base = tileGradient(v);
    const edge = shapeDistance(u, v, inset, exponent);
    /* An inner highlight along the top edge and a darker bottom, the way a
     * material catches light from above. The highlight follows the body the
     * system masks to, not the canvas, so it lands on the icon's own edge — and
     * it is left out of the full-bleed art, where the system draws its own edge
     * light and a second one reads as a frame inside the icon. */
    const topLight = Math.max(0, 1 - Math.abs(v - 0.16) / 0.16) * 0.06;
    const bottomShade = Math.max(0, (v - 0.62) / 0.38) * 0.1;
    const gloss = bleed ? 0 : Math.pow(Math.max(0, 1 - Math.abs(edge - 0.94) / 0.06), 2) * 0.05;
    return base.map((c, i) => Math.min(255, Math.max(0, c + 255 * (topLight + gloss - bottomShade) * (i === 2 ? 1.05 : 1))));
  }

  return encodePng(
    size,
    size,
    rasterize(
      size,
      [
        /* The shadow the whole icon casts. Only where nothing will draw it for us:
         * on macOS the system adds its own, outside the mask. */
        {
          shape: (u, v) => !bleed && shapeDistance(u, v, inset, exponent) > 1,
          colorAt: (u, v) => {
            const d = shapeDistance(u, v, inset, exponent) - 1;
            const below = v > 0.5 ? 1 : 0.35;
            const alpha = Math.exp(-Math.pow(d / 0.045, 1.6)) * 0.5 * below;
            return [4, 5, 9, Math.min(0.5, alpha)];
          }
        },
        {
          shape: (u, v) => bleed || shapeDistance(u, v, inset, exponent) <= 1,
          colorAt: (u, v) => tileAt(u, v).concat([1])
        },

        /* The orb. */
        {
          shape: (u, v) => (bleed || shapeDistance(u, v, inset, exponent) <= 1) && Math.hypot(u - 0.5, v - 0.5) < sphere * auraMax,
          colorAt: (u, v) => {
            const x = u - 0.5;
            const y = v - 0.5;
            const distance = Math.hypot(x, y);
            const out = [0, 0, 0];
            let alpha = 0;

            /* The glow it throws on the tile, and the contact shadow beneath it. */
            if (distance >= sphere) {
              const t = Math.min(1, (distance - sphere) / (sphere * auraMax - sphere));
              const glow = Math.pow(1 - t, 1.3) * 0.75;
              out[0] = 255 * 0.62 * glow;
              out[1] = 255 * 0.34 * glow;
              out[2] = 255 * 0.26 * glow;
              alpha = glow;
              const contact = Math.exp(-Math.pow((distance - sphere) / (sphere * 0.55), 2)) * Math.max(0, y + 0.12) * 1.6;
              out[0] *= 1 - contact;
              out[1] *= 1 - contact;
              out[2] *= 1 - contact;
              return out.concat([Math.min(1, alpha)]);
            }

            /* On the sphere: one normal, one light. */
            const nx = x / sphere;
            const ny = y / sphere;
            const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
            const lambert = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
            const diffuse = 0.58 + 0.52 * Math.pow(lambert, 0.85);
            /* Specular: the light mirrored about the normal, seen from the front. */
            const dotNL = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
            const rx = 2 * dotNL * nx - LIGHT[0];
            const ry = 2 * dotNL * ny - LIGHT[1];
            const rz = 2 * dotNL * nz - LIGHT[2];
            const specular = Math.pow(Math.max(0, rz), 64) * 1.05;
            const sheen = Math.pow(Math.max(0, rz), 8) * 0.16;
            /* A rim where the surface turns away, brighter on the lit side, plus a
             * little light bouncing back from the tile below it. */
            const rim = Math.pow(1 - nz, 3) * (0.18 + 0.4 * Math.max(0, dotNL));
            const bounce = Math.pow(Math.max(0, -ny), 2) * Math.pow(1 - nz, 4) * 0.35;

            /* The interior: glass, so the clouds sit behind a lit surface. */
            const albedo = cloudAlbedo(nx, ny);
            const body = albedo.map((c) => c * diffuse);
            out[0] = body[0] + 255 * (specular + sheen + bounce) * 0.95 + 255 * rim * 0.5;
            out[1] = body[1] + 255 * (specular + sheen + bounce) * 0.95 + 255 * rim * 0.46;
            out[2] = body[2] + 255 * (specular + sheen + bounce) + 255 * rim * 0.42;
            return out.map((c) => Math.min(255, c)).concat([1]);
          }
        }
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
  const BLEED = { bleed: true };
  const SHAPED = { bleed: false };
  /* build/icon.png is what electron-builder turns into the .icns macOS masks. */
  write(path.join(ROOT, 'build'), 'icon.png', appIcon(1024, BLEED));
  // assets/icon.png is the Dock icon at runtime, drawn by the same system.
  write(path.join(ROOT, 'assets'), 'icon.png', appIcon(1024, BLEED));
  // Windows and Linux take the artwork as it is, so it comes pre-shaped.
  write(path.join(ROOT, 'build'), 'icon-shape.png', appIcon(1024, SHAPED));
  // Linux asks for a folder of named sizes (hicolor theme).
  [256, 512, 1024].forEach((size) => {
    write(path.join(ROOT, 'build', 'icons'), `${size}x${size}.png`, appIcon(size, SHAPED));
  });
}

main();
