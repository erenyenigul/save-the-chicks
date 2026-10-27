// Re-tints Kenney textures to the game's muted "toy factory" theme.
//
// Kenney kits share a lavender/indigo palette. This remaps those greys to warm
// cream and the blues to sky blue; other hues (greens, oranges, reds) are kept.
// Originals live in assets/originals/ and are never modified; outputs go to public/.
//
//   npm run recolor
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ORIGINALS = path.join(ROOT, 'assets/originals');
const PUBLIC = path.join(ROOT, 'public');

const isLavender = (h) => h >= 200 && h <= 300;

/** Factory kit: structure greys (s ≈ 0.15) become cream, machine blue-greys (s ≈ 0.25+) sky blue. */
function pastelFactory([h, s, l]) {
  if (!isLavender(h)) return [h, s, l];
  const lc = 0.34 + l * 0.56;
  const cream = hslToRgb(38, Math.max(0, 0.22 * (lc - 0.25)), lc);
  const sky = hslToRgb(205, 0.36, 0.36 + l * 0.4);
  // Blend by saturation instead of a hard cut so gradients inside a swatch don't band.
  const t = smoothstep(0.17, 0.27, s);
  return rgbToHsl(...cream.map((c, i) => c + (sky[i] - c) * t));
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** City kits: keep asphalt and buildings neutral (slightly warm), blues to sky blue. */
function pastelCity([h, s, l]) {
  if (!isLavender(h)) return [h, s, l];
  if (s < 0.35) return [35, s * 0.3, l * 0.92];
  return [205, s * 0.7, l * 0.92];
}

/** UI greys become cream so panels match the floor. */
function creamUi([h, s, l]) {
  if (!isLavender(h)) return [h, s, l];
  return [40, Math.min(0.4, s * 0.5 + 0.18), l * 0.94];
}

const JOBS = [
  { from: 'models/factory/colormap.png', to: 'models/factory/Textures/colormap.png', map: pastelFactory },
  ...['roads', 'commercial', 'industrial', 'cars', 'suburban'].map((pack) => ({
    from: `models/${pack}/colormap.png`,
    to: `models/${pack}/Textures/colormap.png`,
    map: pastelCity,
  })),
  ...['tile-grey.png', 'tile-grey-pressed.png', 'arrow-east.png'].map((file) => ({
    from: `ui/${file}`,
    to: `ui/${file.replace('grey', 'cream')}`,
    map: creamUi,
  })),
];

for (const job of JOBS) {
  const png = PNG.sync.read(fs.readFileSync(path.join(ORIGINALS, job.from)));
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = hslToRgb(...job.map(rgbToHsl(png.data[i], png.data[i + 1], png.data[i + 2])));
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
  }
  const out = path.join(PUBLIC, job.to);
  fs.writeFileSync(out, PNG.sync.write(png));
  console.log(`${job.from} -> ${path.relative(ROOT, out)}`);
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((v) => Math.round(v * 255));
}
