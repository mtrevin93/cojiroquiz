/** Helpers shared by .astro pages. */
import type { AstroCookies } from 'astro';
import type { UrlFor } from '@cojiro/db';
import { getEnv } from './env.ts';
import { ADMIN_COOKIE, isAdminCookie } from './security.ts';
import { getDb, getStore } from './services.ts';
export { pickInitialLang } from './page-lang.ts';

export async function pageContext() {
  const store = await getStore();
  const urlFor: UrlFor = (key) => store.publicUrl(key);
  return { db: getDb(), store, urlFor, env: getEnv() };
}

export function isAdminRequest(cookies: AstroCookies): boolean {
  return isAdminCookie(cookies.get(ADMIN_COOKIE)?.value, getEnv().adminToken);
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
