import type { APIRoute } from 'astro';
import type { UploadResult } from '@cojiro/shared';
import { errorJson, ipHashOf, json, requireTurnstile } from '../../../lib/http.ts';
import { getIngest, UPLOADS_UNAVAILABLE } from '../../../lib/services.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const STATUS_CODES: Record<UploadResult['status'], number> = {
  draft: 200,
  duplicate_file: 200,
  quarantined: 200,
  rate_limited: 429,
  cap_reached: 503,
  invalid_file: 400,
  parser_unavailable: 503,
};

export const POST: APIRoute = async (ctx) => {
  const ingest = await getIngest();
  if (!ingest) return errorJson(503, UPLOADS_UNAVAILABLE);

  const invalid = (message: string) => json({ status: 'invalid_file', message } satisfies UploadResult, 400);
  let file: FormDataEntryValue | null;
  try {
    file = (await ctx.request.formData()).get('file');
  } catch {
    return invalid('Could not read the upload.');
  }
  if (!(file instanceof File)) return invalid('No file was sent.');
  if (!TYPES.has(file.type)) return invalid('Only PNG, JPEG or WebP images can be uploaded.');
  if (file.size === 0 || file.size > MAX_BYTES) return invalid('Images must be smaller than 8 MB.');

  const blocked = await requireTurnstile(ctx);
  if (blocked) return blocked;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ingest.processUpload({ bytes, mimeType: file.type }, { ipHash: ipHashOf(ctx) });
    return json(result, STATUS_CODES[result.status] ?? 200);
  } catch (err) {
    console.error('[api/uploads]', err);
    return errorJson(500, 'Could not read that screenshot. Try again.');
  }
};
