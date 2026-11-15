import type { APIRoute } from 'astro';
import { SITE_NAME, SITE_TAGLINE } from '../lib/seo.ts';

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      name: SITE_NAME,
      short_name: SITE_NAME,
      description: SITE_TAGLINE,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#0d1640',
      theme_color: '#0d1640',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
      shortcuts: [{ name: 'Upload a screenshot', short_name: 'Upload', url: '/upload' }],
    }),
    { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=86400' } },
  );
