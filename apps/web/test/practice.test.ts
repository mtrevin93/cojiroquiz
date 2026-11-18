import type { SearchIndexEntry } from '@cojiro/shared';
import { describe, expect, it } from 'vitest';
import { trueFalse } from '../src/lib/text.ts';
import { parseMode, parseProgress, pickRound, record, toPracticeQuestions, type PracticeQuestion, type Progress } from '../src/lib/practice.ts';

/** Deterministic rng so rounds are reproducible. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const entry = (id: number, over: Partial<SearchIndexEntry> = {}): SearchIndexEntry => ({
  id,
  slug: `${id}-q`,
  lang: 'en',
  level: null,
  questionText: `Question ${id}?`,
  pictureUrl: null,
  choicePictures: [],
  options: [
    { label: 'A', correct: false },
    { label: 'B', correct: true },
    { label: 'C', correct: false },
  ],
  searchText: '',
  answerLabel: 'B',
  answerImageUrl: null,
  answerChoiceImageUrl: null,
  disputed: false,
  ...over,
});

const questions = (n: number): PracticeQuestion[] => toPracticeQuestions(Array.from({ length: n }, (_, i) => entry(i + 1)));

describe('toPracticeQuestions', () => {
  it('leaves out disputed questions and ones without a single correct choice', () => {
    const qs = toPracticeQuestions([
      entry(1),
      entry(2, { disputed: true }),
      entry(3, { options: [{ label: 'A', correct: false }, { label: 'B', correct: false }] }),
      entry(4, { options: [{ label: 'A', correct: true }] }),
    ]);
    expect(qs.map((q) => q.id)).toEqual([1]);
  });

  it('uses the pictures when every choice is a picture', () => {
    const [q] = toPracticeQuestions([
      entry(1, {
        choicePictures: [
          { url: '/a.webp', label: 'Poe', correct: false },
          { url: '/b.webp', label: 'Fish', correct: true },
        ],
        options: [{ label: 'Poe', correct: false }, { label: 'Fish', correct: true }],
      }),
    ]);
    expect(q!.choices).toEqual([
      { label: 'Poe', imageUrl: '/a.webp', correct: false },
      { label: 'Fish', imageUrl: '/b.webp', correct: true },
    ]);
  });
});

describe('pickRound', () => {
  it('returns distinct questions, each still with one correct choice', () => {
    const round = pickRound(questions(30), {}, 7, seeded());
    expect(round).toHaveLength(7);
    expect(new Set(round.map((q) => q.id)).size).toBe(7);
    for (const q of round) expect(q.choices.filter((c) => c.correct)).toHaveLength(1);
  });

  it('returns everything when there are fewer questions than the round size', () => {
    expect(pickRound(questions(3), {}, 7, seeded())).toHaveLength(3);
  });

  it('asks every unseen question before repeating one, even a missed one', () => {
    const all = questions(30);
    let progress: Progress = {};
    for (let id = 1; id <= 10; id++) progress = record(progress, id, id > 4, id); // 1-4 missed, 5-10 right
    const ids = pickRound(all, progress, 20, seeded(3)).map((q) => q.id);
    expect(ids.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 11));
  });

  it('leaves out questions that are already lined up', () => {
    const ids = pickRound(questions(12), {}, 10, seeded(2), new Set([1, 2, 3, 4, 5])).map((q) => q.id);
    expect(ids.sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it('falls back to the questions answered longest ago once everything is seen', () => {
    const all = questions(10);
    let progress: Progress = {};
    for (let id = 1; id <= 10; id++) progress = record(progress, id, true, id);
    const ids = pickRound(all, progress, 4, seeded(5)).map((q) => q.id);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });
});

describe('round length', () => {
  it('defaults to 10 questions', () => {
    expect([null, '10', 'x', '20', 'endless'].map(parseMode)).toEqual([10, 10, 10, 20, 'endless']);
  });
});

describe('progress', () => {
  it('a correct answer clears an earlier miss', () => {
    let p = record({}, 5, false, 100);
    expect(p[5]).toEqual({ n: 1, missed: true, at: 100 });
    p = record(p, 5, true, 200);
    expect(p[5]).toEqual({ n: 2, missed: false, at: 200 });
  });

  it('ignores broken stored data', () => {
    expect(parseProgress(null)).toEqual({});
    expect(parseProgress('not json')).toEqual({});
    expect(parseProgress('[1,2]')).toEqual({});
    expect(parseProgress('{"3":{"n":1,"missed":true,"at":9},"4":"x"}')).toEqual({ 3: { n: 1, missed: true, at: 9 } });
  });
});

describe('trueFalse', () => {
  it('reads a check / X pair as True and False', () => {
    expect(trueFalse('✓', ['X', '✓'])).toBe('true');
    expect(trueFalse('X', ['X', '✓'])).toBe('false');
  });
  it('leaves a plain X alone when the other choice is not a check mark', () => {
    expect(trueFalse('X', ['Y', 'X'])).toBeNull();
    expect(trueFalse('X', ['A', 'X', 'Y', 'R'])).toBeNull();
  });
});
