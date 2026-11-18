import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { defineMiddleware } from 'astro:middleware';
import { getEnv } from './lib/env.ts';
import { ADMIN_COOKIE, adminCookieValue, isAdminCookie, isAdminToken, isSameOrigin } from './lib/security.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function withSecurityHeaders(res: Response): Response {
  try {
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.headers.set('X-Frame-Options', 'DENY');
  } catch {
    /* immutable headers (e.g. redirects): leave as is */
  }
  return res;
}

const COMPRESSIBLE = /^(text\/|application\/(json|xml|javascript|manifest\+json)|image\/svg\+xml)/;

/** Compress text responses: the host does not, and the question list makes pages large. */
async function compressed(request: Request, res: Response): Promise<Response> {
  try {
    if (request.method !== 'GET' || res.status !== 200 || !res.body || res.headers.has('content-encoding')) return res;
    if (!COMPRESSIBLE.test(res.headers.get('content-type') ?? '')) return res;
    const accept = request.headers.get('accept-encoding') ?? '';
    const encoding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    if (!encoding) return res;
    const raw = Buffer.from(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    headers.append('Vary', 'Accept-Encoding');
    if (raw.byteLength < 1024) return new Response(raw, { status: res.status, headers });
    const body =
      encoding === 'br'
        ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength } })
        : gzipSync(raw, { level: 6 });
    headers.set('Content-Encoding', encoding);
    headers.delete('Content-Length');
    return new Response(body, { status: res.status, headers });
  } catch {
    return res;
  }
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  const env = getEnv();
  const { request, url } = ctx;
  const path = url.pathname;

  // One canonical host: www.cojiroquiz.com -> cojiroquiz.com
  const reqHost = (request.headers.get('host') ?? '').toLowerCase();
  if (reqHost.startsWith('www.') && SAFE_METHODS.has(request.method)) {
    return Response.redirect(`https://${reqHost.slice(4)}${path}${url.search}`, 301);
  }

  // State-changing requests must come from this site.
  if (!SAFE_METHODS.has(request.method)) {
    const host = request.headers.get('host');
    const allowed = [env.siteUrl, url.origin, host ? `http://${host}` : null, host ? `https://${host}` : null];
    if (!isSameOrigin(request.headers.get('origin'), allowed)) {
      return withSecurityHeaders(
        new Response(JSON.stringify({ error: 'Cross-origin request refused.' }), {
          status: 403,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    }
  }

  // Admin area: 404 unless the token (once, via ?token=) or the session cookie is valid.
  const isAdminPath = path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin/');
  if (isAdminPath) {
    const token = url.searchParams.get('token');
    if (token !== null && request.method === 'GET' && isAdminToken(token, env.adminToken)) {
      ctx.cookies.set(ADMIN_COOKIE, adminCookieValue(env.adminToken!), {
        httpOnly: true,
        secure: true,
        // Lax, not strict: a strict cookie is withheld when you arrive from another site,
        // so the review links in report emails would show "Not found" even when logged in.
        // Admin actions are POSTs, which lax cookies are not sent with cross-site, and the
        // same-origin check above covers them as well.
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
      const clean = new URL(url);
      clean.searchParams.delete('token');
      return withSecurityHeaders(ctx.redirect(clean.pathname + clean.search, 303));
    }
    if (!isAdminCookie(ctx.cookies.get(ADMIN_COOKIE)?.value, env.adminToken)) {
      // Same response as any unknown URL.
      return withSecurityHeaders(await ctx.rewrite('/404'));
    }
    ctx.locals.isAdmin = true;
  }

  const res = await next();
  if (isAdminPath) {
    try {
      res.headers.set('Cache-Control', 'private, no-store');
      res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    } catch {
      /* ignore */
    }
  }
  return withSecurityHeaders(await compressed(request, res));
});
