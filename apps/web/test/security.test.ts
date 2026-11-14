import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pickInitialLang } from '../src/lib/page-lang.ts';
import { reportEffects } from '../src/lib/reports.ts';
import {
  adminCookieValue,
  clientIpFrom,
  hashIp,
  isAdminCookie,
  isAdminToken,
  isSameOrigin,
  safeEqual,
  safeJsonLd,
} from '../src/lib/security.ts';
import { questionSlug, slugify } from '../src/lib/text.ts';

describe('ip hashing', () => {
  it('is sha256(salt + ip) in hex', () => {
    expect(hashIp('pepper', '203.0.113.9')).toBe(createHash('sha256').update('pepper203.0.113.9').digest('hex'));
  });
  it('depends on the salt and never contains the ip', () => {
    const a = hashIp('a', '203.0.113.9');
    expect(a).not.toBe(hashIp('b', '203.0.113.9'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203.0.113.9');
  });
  it('takes the ip from Fly-Client-IP, then X-Forwarded-For, then the socket', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(clientIpFrom(h({ 'fly-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }), '3.3.3.3')).toBe('1.1.1.1');
    expect(clientIpFrom(h({ 'x-forwarded-for': '2.2.2.2, 10.0.0.1' }), '3.3.3.3')).toBe('2.2.2.2');
    expect(clientIpFrom(h({}), '3.3.3.3')).toBe('3.3.3.3');
    expect(clientIpFrom(h({}), null)).toBe('unknown');
  });
});

describe('admin token', () => {
  it('accepts only the exact token', () => {
    expect(isAdminToken('s3cret-token', 's3cret-token')).toBe(true);
    expect(isAdminToken('s3cret-tokeN', 's3cret-token')).toBe(false);
    expect(isAdminToken('s3cret', 's3cret-token')).toBe(false);
    expect(isAdminToken('', 's3cret-token')).toBe(false);
    expect(isAdminToken(null, 's3cret-token')).toBe(false);
  });
  it('rejects everything when no admin token is configured', () => {
    expect(isAdminToken('', '')).toBe(false);
    expect(isAdminToken('anything', null)).toBe(false);
    expect(isAdminToken('undefined', undefined)).toBe(false);
    expect(isAdminCookie('anything', null)).toBe(false);
  });
  it('compares strings of different lengths without throwing', () => {
    expect(safeEqual('a', 'a much longer string')).toBe(false);
    expect(safeEqual('same', 'same')).toBe(true);
  });
  it('uses a cookie value that is derived from, but is not, the token', () => {
    const cookie = adminCookieValue('s3cret-token');
    expect(cookie).not.toContain('s3cret-token');
    expect(isAdminCookie(cookie, 's3cret-token')).toBe(true);
    expect(isAdminCookie(cookie, 'other-token')).toBe(false);
    expect(isAdminCookie('s3cret-token', 's3cret-token')).toBe(false);
  });
});

describe('same-origin check', () => {
  const allowed = ['https://cojiroquiz.com', 'http://localhost:4321', null];
  it('accepts the site origin', () => {
    expect(isSameOrigin('https://cojiroquiz.com', allowed)).toBe(true);
    expect(isSameOrigin('http://localhost:4321', allowed)).toBe(true);
  });
  it('rejects other, missing and opaque origins', () => {
    expect(isSameOrigin('https://evil.example', allowed)).toBe(false);
    expect(isSameOrigin('https://cojiroquiz.com.evil.example', allowed)).toBe(false);
    expect(isSameOrigin('http://cojiroquiz.com', allowed)).toBe(false);
    expect(isSameOrigin(null, allowed)).toBe(false);
    expect(isSameOrigin('null', allowed)).toBe(false);
    expect(isSameOrigin('not a url', allowed)).toBe(false);
  });
});

describe('JSON-LD serialization', () => {
  it('cannot close the script element', () => {
    const out = safeJsonLd({ text: '</script><script>alert(1)</script>', amp: 'a & b' });
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('&');
    expect(out.toLowerCase()).not.toContain('</script');
  });
  it('round-trips to the same data', () => {
    const data = { text: '</script> <!-- "quotes" \u2028 エポナ', n: 1 };
    expect(JSON.parse(safeJsonLd(data))).toEqual(data);
  });
});

describe('report effects', () => {
  it('does nothing special for a first ordinary report', () => {
    expect(reportEffects('duplicate', ['a'])).toEqual({ hide: false, dispute: false });
  });
  it('marks disputed on a wrong_answer report', () => {
    expect(reportEffects('wrong_answer', ['a'])).toEqual({ hide: false, dispute: true });
  });
  it('hides at three distinct reporters', () => {
    expect(reportEffects('inappropriate', ['a', 'b', 'c'])).toEqual({ hide: true, dispute: false });
    expect(reportEffects('wrong_answer', ['a', 'b', 'c', 'd'])).toEqual({ hide: true, dispute: true });
  });
  it('does not hide when one visitor reports many times', () => {
    expect(reportEffects('inappropriate', ['a', 'a', 'a', 'a', 'b']).hide).toBe(false);
  });
});

describe('slugs', () => {
  it('builds <id>-<ascii text> like the ingest package', () => {
    expect(questionSlug(7, "R A Y R A Y\nThis is the music score for Saria's Song.")).toBe(
      '7-rayray-this-is-the-music-score-for-sarias-song',
    );
    expect(questionSlug(3, 'エポナは馬の名前である。')).toBe('3');
    expect(questionSlug(9, '???')).toBe('9');
  });
  it('keeps non-Latin letters in level slugs', () => {
    expect(slugify('Egg Level')).toBe('egg-level');
    expect(slugify('タマゴ級')).toBe('タマゴ級');
  });
});

describe('initial language', () => {
  it('uses ?lang= when valid, "all" for no filter', () => {
    expect(pickInitialLang('ja', 'en-US', ['en', 'ja'])).toBe('ja');
    expect(pickInitialLang('all', 'ja', ['en', 'ja'])).toBe('');
    expect(pickInitialLang('xx', null, ['en', 'ja'])).toBe('');
  });
  it('falls back to the browser language only when it has entries and there is a choice', () => {
    expect(pickInitialLang(null, 'ja-JP,ja;q=0.9,en;q=0.8', ['en', 'ja'])).toBe('ja');
    expect(pickInitialLang(null, 'fr-FR,fr;q=0.9', ['en', 'ja'])).toBe('');
    expect(pickInitialLang(null, 'fr-FR,en;q=0.5', ['en', 'ja'])).toBe('en');
    expect(pickInitialLang(null, 'ja', ['en'])).toBe('');
  });
});
