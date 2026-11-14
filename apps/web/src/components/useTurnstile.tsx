import { useCallback, useEffect, useRef, type ReactNode } from 'react';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error('Could not load the verification widget.'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export const TURNSTILE_HEADER = 'x-turnstile-token';

/**
 * Cloudflare Turnstile, only when a site key is configured.
 * `slot` is where the widget renders; `take()` resolves with a fresh token
 * (waiting for the challenge if needed) and resets the widget, since tokens
 * are single-use. With no site key, `slot` is null and `take()` gives null.
 */
export function useTurnstile(siteKey: string | null | undefined, active = true) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  const waiters = useRef<Array<(t: string | null) => void>>([]);

  useEffect(() => {
    if (!siteKey || !active) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !elRef.current || !window.turnstile || widgetId.current) return;
        widgetId.current = window.turnstile.render(elRef.current, {
          sitekey: siteKey,
          theme: 'dark',
          callback: (t: string) => {
            token.current = t;
            const w = waiters.current.shift();
            if (w) {
              token.current = null;
              w(t);
              window.turnstile?.reset(widgetId.current ?? undefined);
            }
          },
          'expired-callback': () => {
            token.current = null;
          },
          'error-callback': () => {
            token.current = null;
          },
        });
      })
      .catch(() => {
        for (const w of waiters.current.splice(0)) w(null);
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
      token.current = null;
    };
  }, [siteKey, active]);

  const take = useCallback((): Promise<string | null> => {
    if (!siteKey) return Promise.resolve(null);
    if (token.current) {
      const t = token.current;
      token.current = null;
      window.turnstile?.reset(widgetId.current ?? undefined);
      return Promise.resolve(t);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.current = waiters.current.filter((w) => w !== done);
        resolve(null);
      }, 60_000);
      const done = (t: string | null) => {
        clearTimeout(timer);
        resolve(t);
      };
      waiters.current.push(done);
    });
  }, [siteKey]);

  const slot: ReactNode = siteKey ? <div className="turnstile-slot" ref={elRef} /> : null;
  return { slot, take };
}

/** fetch() with JSON body and the Turnstile header when a token is given. */
export async function postJson(url: string, body: unknown, turnstileToken?: string | null): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (turnstileToken) headers[TURNSTILE_HEADER] = turnstileToken;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error page */
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error. Check your connection and try again.' } };
  }
}
