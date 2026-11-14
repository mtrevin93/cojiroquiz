import type { APIRoute } from 'astro';
import { ManualInput } from '@cojiro/shared';
import { errorJson, ingestErrorResponse, ipHashOf, json, readJson, requireTurnstile } from '../../lib/http.ts';
import { getIngest, UPLOADS_UNAVAILABLE } from '../../lib/services.ts';

export const POST: APIRoute = async (ctx) => {
  const ingest = await getIngest();
  if (!ingest) return errorJson(503, UPLOADS_UNAVAILABLE);
  const input = await readJson(ctx.request, ManualInput);
  if (input instanceof Response) return input;
  if (input.answerIndex >= input.choiceLabels.length) return errorJson(400, 'Pick one of the choices as the answer.');
  const blocked = await requireTurnstile(ctx);
  if (blocked) return blocked;
  try {
    return json(await ingest.submitManual(input, { ipHash: ipHashOf(ctx) }));
  } catch (err) {
    const known = ingestErrorResponse(err);
    if (known) return known;
    console.error('[api/questions]', err);
    return errorJson(500, 'Could not save. Try again.');
  }
};
