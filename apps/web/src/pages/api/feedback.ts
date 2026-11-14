import type { APIRoute } from 'astro';
import { Resend } from 'resend';
import { z } from 'zod';
import { getEnv } from '../../lib/env.ts';
import { errorJson, ipHashOf, json, readJson, requireTurnstile } from '../../lib/http.ts';
import { insertFeedback, markFeedbackEmailed } from '../../lib/mutations.ts';
import { LIMITS, rateLimit } from '../../lib/ratelimit.ts';
import { getDb } from '../../lib/services.ts';

const FeedbackInput = z.object({
  message: z.string().trim().min(1).max(4000),
  contact: z.string().trim().max(200).nullish(),
});

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export const POST: APIRoute = async (ctx) => {
  const input = await readJson(ctx.request, FeedbackInput);
  if (input instanceof Response) return input;
  const blocked = await requireTurnstile(ctx);
  if (blocked) return blocked;

  const env = getEnv();
  const db = getDb();
  const ipHash = ipHashOf(ctx);
  if (!rateLimit(db, 'feedback', ipHash, LIMITS.feedback)) {
    return errorJson(429, 'Too many messages from you in the last hour. Please try again later.');
  }

  // Store first so nothing is lost if the email fails.
  const contact = input.contact || null;
  const id = insertFeedback(db, { message: input.message, contact, ipHash });

  if (env.resendApiKey && env.feedbackTo) {
    try {
      const { error } = await new Resend(env.resendApiKey).emails.send({
        from: `Cojiro Quiz <${env.feedbackFrom}>`,
        to: env.feedbackTo,
        subject: `Cojiro Quiz feedback #${id}`,
        text: `${input.message}\n\n--\nReply contact: ${contact ?? '(none given)'}\nFeedback #${id}`,
        ...(contact && EMAIL.test(contact) ? { replyTo: contact } : {}),
      });
      if (error) console.error('[api/feedback] email not sent:', error.name);
      else markFeedbackEmailed(db, id);
    } catch (err) {
      console.error('[api/feedback] email failed:', err instanceof Error ? err.message : err);
    }
  }
  return json({ ok: true });
};
