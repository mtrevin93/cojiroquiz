import { primaryLang } from './text.ts';

/**
 * Language filter to start with: explicit ?lang= wins ("all" = no filter);
 * otherwise the first Accept-Language entry that has questions; otherwise all.
 */
export function pickInitialLang(
  langParam: string | null,
  acceptLanguage: string | null,
  available: string[],
): string {
  if (langParam === 'all') return '';
  if (langParam && available.includes(langParam)) return langParam;
  if (available.length < 2 || !acceptLanguage) return '';
  const wanted = acceptLanguage
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '')
    .filter((t) => t && t !== '*');
  for (const tag of wanted) {
    const exact = available.find((a) => a.toLowerCase() === tag);
    if (exact) return exact;
    const primary = available.find((a) => primaryLang(a) === primaryLang(tag));
    if (primary) return primary;
  }
  return '';
}
