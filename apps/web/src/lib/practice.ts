/** Practice mode: choosing and ordering questions. Pure, no DOM or node imports. */
import type { SearchIndexEntry } from '@cojiro/shared';

export interface PracticeChoice {
  label: string;
  /** Set when the choice is a picture; the label is then hidden until the answer is shown. */
  imageUrl: string | null;
  correct: boolean;
}

export interface PracticeQuestion {
  id: number;
  slug: string;
  lang: string;
  text: string;
  pictureUrl: string | null;
  choices: PracticeChoice[];
}

/** What the browser remembers about one question. */
export interface Seen {
  /** Times answered. */
  n: number;
  /** True when the latest answer was wrong or timed out. */
  missed: boolean;
  /** When it was last answered (ms). */
  at: number;
}
export type Progress = Record<string, Seen>;

/** How long a round is. Endless keeps going until the player stops. */
export type RoundMode = 10 | 20 | 'endless';
export const ROUND_MODES: readonly RoundMode[] = [10, 20, 'endless'];
export const DEFAULT_MODE: RoundMode = 10;
/** Questions fetched at a time in endless mode. */
export const ENDLESS_BATCH = 10;
export const SECONDS_PER_QUESTION = 15;

export function parseMode(raw: string | null): RoundMode {
  return raw === 'endless' ? 'endless' : raw === '20' ? 20 : DEFAULT_MODE;
}

/** Questions that can be practised: settled answer, at least two choices, exactly one correct. */
export function toPracticeQuestions(entries: SearchIndexEntry[]): PracticeQuestion[] {
  const out: PracticeQuestion[] = [];
  for (const e of entries) {
    if (e.disputed) continue;
    const pictures = e.choicePictures.length >= 2 && e.choicePictures.length === e.options.length;
    const choices: PracticeChoice[] = pictures
      ? e.choicePictures.map((c) => ({ label: c.label, imageUrl: c.url, correct: c.correct }))
      : e.options.map((o) => ({ label: o.label, imageUrl: null, correct: o.correct }));
    if (choices.length < 2 || choices.filter((c) => c.correct).length !== 1) continue;
    out.push({ id: e.id, slug: e.slug, lang: e.lang, text: e.questionText, pictureUrl: e.pictureUrl, choices });
  }
  return out;
}

export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** The same question with its choices in a fresh order. */
export function withShuffledChoices(q: PracticeQuestion, rng: () => number = Math.random): PracticeQuestion {
  return { ...q, choices: shuffle(q.choices, rng) };
}

/**
 * Next questions, in random order: ones never asked first. A question only comes back
 * once every question has been asked (then the ones asked longest ago go first), or
 * after the player resets. `exclude` keeps out questions already lined up.
 */
export function pickRound(
  questions: readonly PracticeQuestion[],
  progress: Progress,
  size: number,
  rng: () => number = Math.random,
  exclude: ReadonlySet<number> = new Set(),
): PracticeQuestion[] {
  const pool = shuffle(questions, rng).filter((q) => !exclude.has(q.id));
  const unseen = pool.filter((q) => !progress[q.id]);
  const seen = pool.filter((q) => progress[q.id]).sort((a, b) => progress[a.id]!.at - progress[b.id]!.at);
  const picked = [...unseen, ...seen].slice(0, size);
  return shuffle(picked, rng).map((q) => withShuffledChoices(q, rng));
}

export function record(progress: Progress, id: number, correct: boolean, now: number): Progress {
  return { ...progress, [id]: { n: (progress[id]?.n ?? 0) + 1, missed: !correct, at: now } };
}

/** Stored progress, tolerating anything unexpected in localStorage. */
export function parseProgress(raw: string | null): Progress {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: Progress = {};
    for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
      const s = v as Partial<Seen> | null;
      if (s && typeof s.n === 'number' && typeof s.missed === 'boolean' && typeof s.at === 'number') {
        out[id] = { n: s.n, missed: s.missed, at: s.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}
