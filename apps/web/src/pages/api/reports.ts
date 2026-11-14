import type { APIRoute } from 'astro';
import { errorJson, ipHashOf, json, readJson } from '../../lib/http.ts';
import { createReport } from '../../lib/mutations.ts';
import { LIMITS, rateLimit } from '../../lib/ratelimit.ts';
import { ReportInput } from '../../lib/reports.ts';
import { getDb } from '../../lib/services.ts';

export const POST: APIRoute = async (ctx) => {
  const input = await readJson(ctx.request, ReportInput);
  if (input instanceof Response) return input;
  const db = getDb();
  const ipHash = ipHashOf(ctx);
  if (!rateLimit(db, 'report', ipHash, LIMITS.report)) {
    return errorJson(429, 'Too many reports from you in the last hour. Please try again later.');
  }
  const result = createReport(db, { questionId: input.questionId, reason: input.reason, note: input.note ?? null, ipHash });
  if (!result) return errorJson(404, 'That question no longer exists.');
  return json({ ok: true });
};
