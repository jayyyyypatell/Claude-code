/**
 * Render the app icon at every size the manifest and iOS ask for.
 *
 * One SVG source rather than a folder of hand-exported PNGs, so changing the
 * icon is a one-line edit and a re-run.
 *
 *   node scripts/gen-icons.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const OUT = "public/icons";
mkdirSync(OUT, { recursive: true });

/** A ring (the activity motif) over a dark ground, in the app's blue. */
const svg = (size, padding) => {
  const c = size / 2;
  const r = (size / 2) * (1 - padding);
  const stroke = size * 0.11;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0d0d0d"/>
  <circle cx="${c}" cy="${c}" r="${r * 0.72}" fill="none" stroke="#1c3d63" stroke-width="${stroke}"/>
  <path d="M ${c} ${c - r * 0.72}
           A ${r * 0.72} ${r * 0.72} 0 1 1 ${c - r * 0.72 * 0.866} ${c + r * 0.72 * 0.5}"
        fill="none" stroke="#3987e5" stroke-width="${stroke}" stroke-linecap="round"/>
</svg>`;
};

const targets = [
  // Padding differs: maskable icons must keep their content inside a safe
  // zone, because Android crops them to whatever shape it likes.
  { name: "icon-192.png", size: 192, padding: 0.14 },
  { name: "icon-512.png", size: 512, padding: 0.14 },
  { name: "icon-512-maskable.png", size: 512, padding: 0.28 },
  { name: "apple-touch-icon.png", size: 180, padding: 0.12 },
];

for (const t of targets) {
  await sharp(Buffer.from(svg(t.size, t.padding))).png().toFile(`${OUT}/${t.name}`);
  console.log(`  ${OUT}/${t.name}`);
}

writeFileSync(`${OUT}/icon.svg`, svg(512, 0.14));
console.log(`  ${OUT}/icon.svg (source)`);
