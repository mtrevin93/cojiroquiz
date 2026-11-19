/** Small text helpers shared by server code and islands (no node imports). */

/** URL-safe-ish slug that keeps letters/digits of any script. */
export function slugify(text: string, maxLength = 60): string {
  const s = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return [...s].slice(0, maxLength).join('').replace(/-+$/g, '');
}

/**
 * `<id>-<ascii text>`; mirrors slugify() in packages/ingest/src/ingest.ts
 * (spaced letters joined, ASCII only, so non-Latin questions are just the id).
 */
export function questionSlug(id: number, questionText: string, maxLength = 60): string {
  let ascii = questionText
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(?<![\p{L}\p{N}])(?:\p{L}\s+){2,}\p{L}(?![\p{L}\p{N}])/gu, (run) => run.replace(/\s+/gu, ''))
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length > maxLength) {
    const cut = ascii.slice(0, maxLength);
    const lastDash = cut.lastIndexOf('-');
    ascii = (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
  }
  return ascii ? `${id}-${ascii}` : String(id);
}

const CHECK = /^[✓✔☑]$/u;
const CROSS = /^[xX✗✕✖×]$/u;

/**
 * Statement questions have exactly two choices, a check mark and an X, which read as
 * True and False. Anywhere else a lone "X" is just the letter (e.g. the X Button).
 */
export function trueFalse(label: string, allLabels: readonly string[], lang = 'en'): 'true' | 'false' | null {
  // The words are English; in any other language the game's own symbol is the answer.
  if (primaryLang(lang) !== 'en') return null;
  const all = allLabels.map((l) => l.trim());
  if (all.length !== 2 || !all.some((l) => CHECK.test(l)) || !all.some((l) => CROSS.test(l))) return null;
  const t = label.trim();
  return CHECK.test(t) ? 'true' : CROSS.test(t) ? 'false' : null;
}

/** One-line version of a question, for titles and descriptions. */
export function oneLine(text: string, max = 110): string {
  const s = text.replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : s;
}

const LANG_NAMES: Record<string, string> = {
  en: 'English', ja: '日本語', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano',
  pt: 'Português', nl: 'Nederlands', ko: '한국어', zh: '中文', ru: 'Русский', pl: 'Polski',
};

export function primaryLang(lang: string): string {
  return (lang.trim().toLowerCase().split(/[-_]/)[0] ?? '') || 'und';
}

/** Human name for a BCP-47 tag, falling back to the tag itself. */
export function langName(lang: string): string {
  const tag = lang.trim().toLowerCase();
  if (tag === 'zh-cn') return '简体中文';
  if (tag === 'zh-tw') return '繁體中文';
  const name = LANG_NAMES[primaryLang(lang)];
  if (!name) return lang;
  return lang.includes('-') ? `${name} (${lang})` : name;
}

export const REPORT_REASON_LABELS: Record<string, string> = {
  wrong_answer: 'Wrong answer',
  not_a_question: 'Not a real quiz question',
  duplicate: 'Duplicate',
  inappropriate: 'Inappropriate',
};
