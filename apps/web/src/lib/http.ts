import type { APIContext } from 'astro';
import type { ZodType } from 'zod';
import { getEnv } from './env.ts';
import { clientIpFrom, hashIp } from './security.ts';
import { TURNSTILE_HEADER, verifyTurnstile } from './turnstile.ts';

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export const errorJson = (status: number, error: string) => json({ error }, status);

function socketAddress(ctx: APIContext): string | null {
  try {
    return ctx.clientAddress;
  } catch {
    return null;
  }
}

export function clientIp(ctx: APIContext): string {
  return clientIpFrom(ctx.request.headers, socketAddress(ctx));
}

/** Salted hash of the caller's IP; the raw IP never leaves this function's callers' stack. */
export function ipHashOf(ctx: APIContext): string {
  return hashIp(getEnv().ipHashSalt, clientIp(ctx));
}

/** Parse a JSON body and validate it. Returns a Response on failure. */
export async function readJson<T>(request: Request, schema: ZodType<T>, maxBytes = 64 * 1024): Promise<T | Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return errorJson(400, 'Could not read the request body.');
  }
  if (text.length > maxBytes) return errorJson(413, 'Request too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return errorJson(400, 'Body must be JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return errorJson(400, `Invalid input. ${where}${first?.message ?? ''}`.trim());
  }
  return parsed.data;
}

/** Caller-fixable errors thrown by @cojiro/ingest (IngestError) become 4xx with their message. */
export function ingestErrorResponse(err: unknown): Response | null {
  if (!(err instanceof Error) || err.name !== 'IngestError') return null;
  const code = (err as Error & { code?: string }).code;
  const status = code === 'rate_limited' ? 429 : code === 'draft_not_found' || code === 'quarantine_not_found' ? 404 : 400;
  return errorJson(status, err.message);
}

/** Null when the Turnstile check passes (or is not configured); else a 403. */
export async function requireTurnstile(ctx: APIContext): Promise<Response | null> {
  const ok = await verifyTurnstile(
    getEnv().turnstileSecret,
    ctx.request.headers.get(TURNSTILE_HEADER),
    clientIp(ctx),
  );
  return ok ? null : errorJson(403, 'Verification failed. Try again.');
}
