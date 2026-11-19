import { primaryLang } from './text.ts';

/** Cookie that remembers the language picked in the header. */
export const LANG_COOKIE = 'lang';

/**
 * The language a page shows. `available` holds language keys ("en", "pt", "zh-cn").
 * An explicit ?lang= wins, then the language picked earlier (cookie), then English.
 * A page always shows one language: the full list in every language is far too big to send.
 */
export function pickInitialLang(langParam: string | null, remembered: string | null, available: string[]): string {
  const find = (tag: string | null): string | undefined => {
    const t = (tag ?? '').trim().toLowerCase();
    if (!t) return undefined;
    return available.find((a) => a.toLowerCase() === t) ?? available.find((a) => primaryLang(a) === primaryLang(t));
  };
  return find(langParam) ?? find(remembered) ?? available.find((a) => a === 'en') ?? available[0] ?? 'en';
}

/** Language keys in picker order: English first, then by code. */
export function sortLanguages(keys: string[]): string[] {
  return [...keys].sort((a, b) => Number(b === 'en') - Number(a === 'en') || a.localeCompare(b));
}
