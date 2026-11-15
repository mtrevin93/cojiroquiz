// Builds the site's mascot images from apps/web/art/cojiro-cutout.png, which is
// apps/web/art/cojiro-source.png with its background removed (rembg, birefnet-general).
//   node scripts/mascot.mjs
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../packages/ingest/package.json', import.meta.url))('sharp');
const src = new URL('../apps/web/art/cojiro-cutout.png', import.meta.url).pathname;
const pub = new URL('../apps/web/public/', import.meta.url).pathname;

const cutout = async (region) => sharp(await sharp(src).extract(region).png().toBuffer());

const NAVY = '#0f1b4a';
const full = await cutout({ left: 250, top: 0, width: 760, height: 720 });
await full.clone().resize({ height: 560 }).webp({ quality: 88 }).toFile(pub + 'cojiro.webp');

const head = await (await cutout({ left: 395, top: 0, width: 400, height: 400 })).png().toBuffer();
const tile = async (size, pad) =>
  sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([{ input: await sharp(head).resize(size - 2 * pad, size - 2 * pad).toBuffer(), left: pad, top: pad }])
    .png();
await (await tile(96, 2)).toFile(pub + 'mark.png');
await (await tile(64, 1)).toFile(pub + 'favicon.png');
await (await tile(180, 6)).toFile(pub + 'icon-180.png');
await (await tile(192, 6)).toFile(pub + 'icon-192.png');
await (await tile(512, 16)).toFile(pub + 'icon-512.png');
await (await tile(512, 80)).toFile(pub + 'icon-maskable-512.png');

const bg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2768"/><stop offset="1" stop-color="#070b22"/></linearGradient></defs><rect width="1200" height="630" fill="url(#g)"/><text x="590" y="290" font-family="Georgia, serif" font-weight="700" font-size="86" fill="#ffd23f" stroke="#101a3f" stroke-width="3">COJIRO QUIZ</text><text x="592" y="366" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="38" fill="#ffffff">Ocarina of Time Quiz answers</text></svg>`,
);
await sharp(bg)
  .composite([{ input: await full.clone().resize({ height: 600 }).png().toBuffer(), left: -10, top: 15 }])
  .png()
  .toFile(pub + 'og.png');
console.log('mascot images written');
