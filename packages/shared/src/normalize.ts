/**
 * Text normalization. The original quiz text is always stored verbatim;
 * everything here produces derived values for dedupe and search only.
 * All of it is Unicode-aware: letters/digits of any script are kept.
 */

const collapse = (s: string) => s.replace(/\s+/gu, ' ').trim();

const straightQuotes = (s: string) =>
  s.replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"');

/** Lowercased, NFKC, straight quotes, whitespace collapsed. Punctuation kept. */
export function baseNormalize(s: string): string {
  return collapse(straightQuotes(s.normalize('NFKC')).toLowerCase());
}

/**
 * Canonical form for dedupe: baseNormalize with punctuation removed.
 * Accents are NOT folded. Symbol-only strings (e.g. "✓") are kept as-is
 * rather than collapsing to the empty string.
 */
export function canonical(s: string): string {
  const base = baseNormalize(s);
  const stripped = collapse(base.replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' '));
  return stripped === '' ? base : stripped;
}

/** "r a y r a y this is" -> "rayray this is": joins runs of 3+ single letters. */
export function joinSpacedLetters(s: string): string {
  return s.replace(
    /(?<![\p{L}\p{N}])(?:\p{L}\s+){2,}\p{L}(?![\p{L}\p{N}])/gu,
    (run) => run.replace(/\s+/gu, ''),
  );
}

/** Strip combining marks: "canción" -> "cancion". Search only, never dedupe. */
export function foldAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

/** Primary language subtag used for dedupe ("pt-BR" -> "pt"); Chinese keeps its script. */
export function langKey(lang: string): string {
  const parts = lang.trim().toLowerCase().split(/[-_]/);
  const primary = parts[0] || 'und';
  if (primary === 'zh' && parts[1]) return `zh-${parts[1]}`;
  return primary;
}

/** The string that gets hashed (sha256) into questions.dedupe_key. */
export function dedupeMaterial(lang: string, questionText: string, choiceTexts: string[]): string {
  const choices = choiceTexts.map(canonical).sort();
  return [langKey(lang), canonical(questionText), ...choices].join('\u001f');
}

/**
 * Build the searchable blob for a question from its text parts
 * (question, level, choice labels/descriptions, answer text).
 * Contains each part as typed, with spaced letters joined, with punctuation
 * stripped, and accent-folded, so plain substring search finds all of them.
 */
export function buildSearchText(parts: Array<string | null | undefined>): string {
  const out = new Set<string>();
  for (const p of parts) {
    if (!p) continue;
    const base = baseNormalize(p);
    if (!base) continue;
    for (const v of [base, canonical(p)]) {
      for (const w of [v, joinSpacedLetters(v)]) {
        out.add(w);
        out.add(foldAccents(w));
      }
    }
  }
  return [...out].join('\n');
}

/** Split a user query into normalized terms. */
export function queryTerms(query: string): string[] {
  return baseNormalize(query).split(' ').filter(Boolean);
}

/** True when every term of the query is a substring of searchText (any order). */
export function matchesQuery(searchText: string, query: string): boolean {
  const terms = queryTerms(query);
  return terms.every((t) => searchText.includes(t) || searchText.includes(foldAccents(t)));
}
