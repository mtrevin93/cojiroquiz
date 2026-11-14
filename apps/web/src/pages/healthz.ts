import type { APIRoute } from 'astro';
import { ping } from '@cojiro/db';
import { getDb } from '../lib/services.ts';

export const GET: APIRoute = () => {
  try {
    if (ping(getDb())) {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    }
  } catch (err) {
    console.error('[healthz]', err);
  }
  return new Response('db unavailable\n', { status: 503, headers: { 'content-type': 'text/plain' } });
};
