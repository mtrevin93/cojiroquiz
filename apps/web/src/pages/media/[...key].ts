import type { APIRoute } from 'astro';
import { getStore } from '../../lib/services.ts';

/** Public blobs for the disk store (dev). With Tigris, images are served from the bucket URL instead. */
export const GET: APIRoute = async ({ params }) => {
  const key = params.key ?? '';
  if (!key || key.split('/').some((seg) => seg === '..' || seg === '')) return new Response('Not found', { status: 404 });
  let blob;
  try {
    blob = await (await getStore()).get('public', key);
  } catch {
    blob = null;
  }
  if (!blob) {
    // Dev with a copy of the live data: pictures that are not on this disk come from the live bucket.
    const fallback = process.env.MEDIA_FALLBACK_URL?.replace(/\/+$/, '');
    if (fallback) return Response.redirect(`${fallback}/${key.split('/').map(encodeURIComponent).join('/')}`, 302);
    return new Response('Not found', { status: 404 });
  }
  return new Response(blob.body as BodyInit, {
    headers: {
      'Content-Type': blob.contentType.startsWith('image/') ? blob.contentType : 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(blob.body.byteLength),
    },
  });
};
