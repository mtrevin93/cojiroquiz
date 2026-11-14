import type { APIRoute } from 'astro';
import { getEnv } from '../lib/env.ts';

export const GET: APIRoute = () => {
  const body = ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /api/', '', `Sitemap: ${getEnv().siteUrl}/sitemap.xml`, ''].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
};
