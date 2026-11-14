/** Pure security helpers (unit-tested in test/security.test.ts). */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** sha256(salt + ip), hex. Raw IPs are never stored. */
export function hashIp(salt: string, ip: string): string {
  return createHash('sha256').update(salt + ip).digest('hex');
}

/** Client IP: Fly-Client-IP, then first X-Forwarded-For hop, then the socket. */
export function clientIpFrom(headers: Headers, socketAddress?: string | null): string {
  const fly = headers.get('fly-client-ip')?.trim();
  if (fly) return fly;
  const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  return socketAddress || 'unknown';
}

/** Constant-time string compare (hashes both sides so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True only when an admin token is configured and `candidate` equals it. */
export function isAdminToken(candidate: string | null | undefined, adminToken: string | null | undefined): boolean {
  if (!adminToken || !candidate) return false;
  return safeEqual(candidate, adminToken);
}

export const ADMIN_COOKIE = 'cq_admin';

/** Cookie value derived from the token, so the token itself is not stored in the browser. */
export function adminCookieValue(adminToken: string): string {
  return createHmac('sha256', adminToken).update('cojiro-admin-session-v1').digest('hex');
}

export function isAdminCookie(value: string | null | undefined, adminToken: string | null | undefined): boolean {
  if (!adminToken || !value) return false;
  return safeEqual(value, adminCookieValue(adminToken));
}

/**
 * Same-origin check for state-changing requests: the Origin header must be
 * present and equal to one of the origins this site is served from.
 */
export function isSameOrigin(origin: string | null, allowedOrigins: Array<string | null | undefined>): boolean {
  if (!origin || origin === 'null') return false;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  return allowedOrigins.some((a) => {
    if (!a) return false;
    try {
      return new URL(a).origin === normalized;
    } catch {
      return false;
    }
  });
}

/**
 * Serialize data for a <script type="application/ld+json"> block. Escapes
 * characters that could close the script element or break JS parsers.
 */
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
