/** Cloudflare Turnstile server-side verification. Skipped when no secret is set. */
export const TURNSTILE_HEADER = 'x-turnstile-token';

export async function verifyTurnstile(
  secret: string | null,
  token: string | null,
  remoteIp?: string,
): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
