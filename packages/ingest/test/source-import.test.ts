import { listAllQuestions, openDb } from '@cojiro/db';
import { describe, expect, it } from 'vitest';
import { applyBundle } from '../src/source-apply.ts';
import { type Bundle, type SourceQuestion, foldQuestions, pictureNames, toBundleQuestion } from '../src/source-prepare.ts';

const src = (id: string, question: string, options: string[], over: Partial<SourceQuestion> = {}): SourceQuestion => ({
  id,
  level: 'advanced',
  question,
  options: options.map((text) => ({ text })),
  ...over,
});

describe('preparing source questions', () => {
  it('folds the same wording, picture and answer into one question with the fullest choice set', () => {
    const folded = foldQuestions([
      src('a', 'Which location has a grave?', ['Lake Hylia', 'Gerudo Valley'], { level: 'beginner' }),
      src('b', 'Which location has a grave?', ['Lake Hylia', 'Lon Lon Ranch', 'Castle Town', 'Gerudo Valley']),
      src('c', 'Which location has a grave?', ['Kakariko Village', 'Lake Hylia']),
    ]);
    expect(folded.map((f) => f.ids)).toEqual([['b', 'a'], ['c']]);
  });

  it('keeps the first option as the answer after shuffling', () => {
    const q = toBundleQuestion(src('x1', 'How many?', ['2', '4', '6', '8']), ['x1']);
    expect(q.choices[q.answerIndex]!.label).toBe('2');
    expect(q.choices.map((c) => c.label).sort()).toEqual(['2', '4', '6', '8']);
    expect(toBundleQuestion(src('x1', 'How many?', ['2', '4', '6', '8']), ['x1'])).toEqual(q);
  });

  it("names pictures from the game's own wording", () => {
    const names = pictureNames([
      { id: '1', level: 'advanced', question: 'Which of these is a Stinger?', options: [{ text: '', imageFile: 'Enemy_0086_4x3' }, { text: '', imageFile: 'Enemy_0083_4x3' }] },
      { id: '2', level: 'advanced', question: 'Which of these is easy to break?', options: [{ text: '', imageFile: 'Item_0056_4x3' }, { text: '', imageFile: 'Item_0161_4x3' }] },
      { id: '3', level: 'advanced', question: 'What is this monster called?', questionImageFile: 'Enemy_0136_16x9', options: [{ text: 'Deku Baba' }, { text: 'Deku Papa' }] },
    ]);
    expect(Object.fromEntries(names)).toEqual({ Enemy_0086_4x3: 'Stinger', Enemy_0136_4x3: 'Deku Baba' });
  });
});

describe('applying a bundle', () => {
  const bundle: Bundle = {
    images: {},
    questions: [
      toBundleQuestion(src('s1', 'Which location has a grave?', ['Lake Hylia', 'Lon Lon Ranch', 'Castle Town', 'Gerudo Valley']), ['s1']),
      toBundleQuestion(src('s2', 'This is a statement.', ['X', '✓']), ['s2']),
    ],
  };

  it('adds questions with locked answers and changes nothing when run again', () => {
    const db = openDb(':memory:');
    expect(applyBundle(db, bundle, 1)).toMatchObject({ inserted: 2, linked: 0, refreshed: 0 });
    const first = listAllQuestions(db);
    expect(first.map((q) => q.choices[q.answerIndex]!.label).sort()).toEqual(['Lake Hylia', 'X']);
    expect(first.every((q) => q.answerLocked && q.submissionCount === 0)).toBe(true);
    expect(first.map((q) => q.slug).sort()).toEqual([`${first[0]!.id}-which-location-has-a-grave`, `${first[1]!.id}-this-is-a-statement`].sort());

    expect(applyBundle(db, bundle, 2)).toMatchObject({ inserted: 0, linked: 0, refreshed: 2 });
    expect(listAllQuestions(db).map((q) => [q.id, q.slug, q.answerIndex])).toEqual(first.map((q) => [q.id, q.slug, q.answerIndex]));
  });
});

describe('names the game gives away', () => {
  it('reads a description out of the question', async () => {
    const { describedAs } = await import('../src/source-prepare.ts');
    expect(describedAs("Which is Granny's husband?")).toBe("Granny's husband");
    expect(describedAs('Which of these is the owner of the Potion Shop?')).toBe('the owner of the Potion Shop');
    expect(describedAs("In Kakariko Village, which is the master craftsman's daughter?")).toBe("the master craftsman's daughter");
    for (const q of [
      'Which is not a Kokiri?',
      'Which of these is located in the Fire Temple?',
      'Which is easy to break?',
      'What is Nabooru looking for?',
      'Which of these items is the most expensive to buy at a shop?',
      'Who has a cucco allergy?',
    ]) {
      expect(describedAs(q), q).toBeNull();
    }
  });

  it('names the correct picture, preferring a proper name', () => {
    const pic = (id: string, question: string, answer: string): SourceQuestion => ({
      id,
      level: 'advanced',
      question,
      options: [{ text: '', imageFile: answer }, { text: '', imageFile: 'NPC_0999_4x3' }],
    });
    const names = pictureNames([
      pic('a', "Who is the lake scientist's apprentice?", 'NPC_0128_4x3'),
      pic('b', 'Who is Granny?', 'NPC_0128_4x3'),
      pic('c', 'Which of these is the owner of the Bazaar?', 'NPC_0051_4x3'),
    ]);
    expect(names.get('NPC_0128_4x3')).toBe('Granny');
    expect(names.get('NPC_0051_4x3')).toBe('Owner of the Bazaar');
    expect(names.has('NPC_0999_4x3')).toBe(false);
  });
});
