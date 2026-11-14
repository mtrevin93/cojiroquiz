import type { APIRoute } from 'astro';
import { ConfirmInput } from '@cojiro/shared';
import { errorJson, ingestErrorResponse, ipHashOf, json, readJson } from '../../../../lib/http.ts';
import { getIngest, UPLOADS_UNAVAILABLE } from '../../../../lib/services.ts';

export const POST: APIRoute = async (ctx) => {
  const ingest = await getIngest();
  if (!ingest) return errorJson(503, UPLOADS_UNAVAILABLE);
  const draftId = ctx.params.draftId ?? '';
  if (!draftId || draftId.length > 100) return errorJson(400, 'Unknown draft.');
  const input = await readJson(ctx.request, ConfirmInput);
  if (input instanceof Response) return input;
  try {
    // Uploaders only choose the answer; the text always comes from the screenshot.
    return json(await ingest.confirmDraft(draftId, { answerIndex: input.answerIndex }, { ipHash: ipHashOf(ctx) }));
  } catch (err) {
    const known = ingestErrorResponse(err);
    if (known) return known;
    console.error('[api/uploads/confirm]', err);
    return errorJson(500, 'Could not save. Try again.');
  }
};
