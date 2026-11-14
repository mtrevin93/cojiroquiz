import type { APIRoute } from 'astro';
import { listLevels, listSitemapEntries } from '@cojiro/db';
import { levelPath, questionPath } from '../components/QuestionCard.tsx';
import { getEnv } from '../lib/env.ts';
import { getDb } from '../lib/services.ts';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const GET: APIRoute = () => {
  const db = getDb();
  const site = getEnv().siteUrl;
  const urls: Array<{ loc: string; lastmod?: number }> = [
    { loc: '/' },
    { loc: '/about' },
    ...listLevels(db).map((l) => ({ loc: levelPath(l.value) })),
    ...listSitemapEntries(db).map((q) => ({ loc: questionPath(q.slug), lastmod: q.updatedAt })),
  ];
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url><loc>${xml(site + u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ''}</url>`,
      )
      .join('\n') +
    '\n</urlset>\n';
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=600' } });
};
