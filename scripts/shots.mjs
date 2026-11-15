// Visual check: screenshots of the real pages at phone and desktop sizes.
//   node --env-file=.env scripts/shots.mjs [baseUrl] [name-filter]
// Writes PNGs to .shots/ and prints, per page, horizontal overflow and console errors.
// Admin pages are included when ADMIN_TOKEN is set. Read-only: it never submits a form.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = (process.argv[2] || 'https://cojiroquiz.com').replace(/\/$/, '');
const only = process.argv[3];
const out = new URL('../.shots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: chrome });
const sizes = { phone: { width: 390, height: 844, mobile: true }, desktop: { width: 1440, height: 900, mobile: false } };

async function firstQuestionPath(page) {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  return page.locator('a.qcard-link').first().getAttribute('href').catch(() => null);
}

for (const [sizeName, size] of Object.entries(sizes)) {
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.mobile ? 2 : 1,
    isMobile: size.mobile,
    hasTouch: size.mobile,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 120)));
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));

  const q = await firstQuestionPath(page);
  const pages = [['home', '/'], ['upload', '/upload'], ['about', '/about']];
  if (q) pages.push(['question', q]);
  if (process.env.ADMIN_TOKEN) {
    await page.goto(`${base}/admin?token=${process.env.ADMIN_TOKEN}`, { waitUntil: 'networkidle' });
    pages.push(['admin', '/admin']);
    const review = await page.locator('a[href^="/admin/review/"]').first().getAttribute('href').catch(() => null);
    if (review) pages.push(['admin-review', review]);
  }
  for (const [name, path] of pages) {
    if (only && !name.includes(only)) continue;
    errors.length = 0;
    await page.goto(base + path, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const file = `${out}${name}-${sizeName}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(`${name}-${sizeName}: overflow ${overflow}px${errors.length ? ` | errors: ${errors.join(' ; ')}` : ''} -> ${file}`);
  }
  await ctx.close();
}
await browser.close();
