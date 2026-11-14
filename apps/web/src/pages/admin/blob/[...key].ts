import type { APIRoute } from 'astro';
import { getStore } from '../../../lib/services.ts';

/** Private (quarantine) blobs for the disk store. Admin-gated by src/middleware.ts. */
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.isAdmin) return new Response('Not found', { status: 404 });
  const key = params.key ?? '';
  if (!key || key.split('/').some((seg) => seg === '..' || seg === '')) return new Response('Not found', { status: 404 });
  let blob;
  try {
    blob = await (await getStore()).get('private', key);
  } catch {
    blob = null;
  }
  if (!blob) return new Response('Not found', { status: 404 });
  return new Response(blob.body as BodyInit, {
    headers: {
      'Content-Type': blob.contentType.startsWith('image/') ? blob.contentType : 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
    },
  });
};
