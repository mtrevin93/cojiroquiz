import type { APIRoute } from 'astro';
import { Resend } from 'resend';
import { getQuestionById } from '@cojiro/db';
import { getEnv } from '../../lib/env.ts';
import { REPORT_REASON_LABELS } from '../../lib/text.ts';
import { errorJson, ipHashOf, json, readJson } from '../../lib/http.ts';
import { createReport } from '../../lib/mutations.ts';
import { LIMITS, rateLimit } from '../../lib/ratelimit.ts';
import { ReportInput } from '../../lib/reports.ts';
import { getDb, getStore } from '../../lib/services.ts';

export const POST: APIRoute = async (ctx) => {
  const input = await readJson(ctx.request, ReportInput);
  if (input instanceof Response) return input;
  const db = getDb();
  const ipHash = ipHashOf(ctx);
  if (!rateLimit(db, 'report', ipHash, LIMITS.report)) {
    return errorJson(429, 'Too many reports. Try again later.');
  }
  const result = createReport(db, { questionId: input.questionId, reason: input.reason, note: input.note ?? null, ipHash });
  if (!result) return errorJson(404, 'That question no longer exists.');

  // Tell the owner. The report is already saved, so a failed email loses nothing.
  const env = getEnv();
  if (env.resendApiKey && env.feedbackTo) {
    try {
      const store = await getStore();
      const q = getQuestionById(db, (key) => store.publicUrl(key), input.questionId);
      const answer = q?.choices[q.answerIndex];
      const reason = REPORT_REASON_LABELS[input.reason] ?? input.reason;
      const { error } = await new Resend(env.resendApiKey).emails.send({
        from: `Cojiro Quiz <${env.feedbackFrom}>`,
        to: env.feedbackTo,
        subject: `Report: ${reason} on question #${input.questionId}`,
        text: [
          `Reason: ${reason}`,
          `Note: ${input.note?.trim() || '(none)'}`,
          '',
          `Question #${input.questionId}:`,
          q?.questionText ?? '(not found)',
          '',
          `Current answer: ${answer ? answer.label || answer.description || '?' : '?'}`,
          result.hidden ? 'The question is now hidden (3 reports).' : '',
          '',
          `Review: ${env.siteUrl}/admin/review/${input.questionId}`,
        ]
          .filter((l, i, a) => l !== '' || a[i - 1] !== '')
          .join('\n'),
      });
      if (error) console.error('[api/reports] email not sent:', error.name);
    } catch (err) {
      console.error('[api/reports] email failed:', err instanceof Error ? err.message : err);
    }
  }
  return json({ ok: true });
};
