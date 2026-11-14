/**
 * Seeds SAMPLE questions for local development and screenshots.
 *
 *   node scripts/seed.ts           insert the samples (idempotent: wipes old samples first)
 *   node scripts/seed.ts --reset   remove the samples only
 *
 * Everything inserted here is tagged: its submissions row has ip_hash = 'seed'
 * and its image keys start with 'seed/'. Only the Saria's Song answer is real
 * (read from fixtures/screenshots/egg-saria-a.png). Every other answer is a
 * PLACEHOLDER picked for layout purposes, including the Y Button question
 * (real question text from the fixture, answer UNKNOWN, seeded as disputed).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema } from '@cojiro/db';
import { canonical, type StoredChoice } from '@cojiro/shared';
import { eq, inArray, like } from 'drizzle-orm';
import { repoRoot } from '../src/lib/env.ts';
import { choiceIdentity, dedupeKeyFor, searchTextFor } from '../src/lib/mutations.ts';
import { getDb, getStore } from '../src/lib/services.ts';
import { questionSlug } from '../src/lib/text.ts';

const SEED_IP = 'seed';
const { questions, submissions, images } = schema;

const sym = (label: string): StoredChoice => ({ label, kind: 'symbol', description: null, imageKey: null });
const txt = (label: string): StoredChoice => ({ label, kind: 'text', description: null, imageKey: null });
const pic = (label: string, description: string): StoredChoice => ({ label, kind: 'image', description, imageKey: null });
const TF = [sym('X'), sym('✓')];

interface Sample {
  lang: string;
  level: string;
  questionText: string;
  choices: StoredChoice[];
  answerIndex: number;
  answerSource: 'reveal' | 'manual';
  disputed?: boolean;
  submissionCount?: number;
  /** Fixture screenshots to attach: [question, reveal]. */
  shots?: { question?: string; answer?: string };
}

const SAMPLES: Sample[] = [
  {
    // REAL: fixtures/screenshots/egg-saria-a.png shows ✓ in gold.
    lang: 'en',
    level: 'Egg Level',
    questionText: "R A Y R A Y\nThis is the music score for Saria's Song.",
    choices: TF,
    answerIndex: 1,
    answerSource: 'reveal',
    submissionCount: 3,
    shots: { question: 'egg-saria-b.png', answer: 'egg-saria-a.png' },
  },
  {
    // Real question text (fixtures/screenshots/cucco-ybutton-4choice.png).
    // SAMPLE ANSWER: the real answer is unknown, "B" is a placeholder. Seeded as disputed.
    lang: 'en',
    level: 'Cucco Level',
    questionText: 'When playing the ocarina in\nNormal mode, which note is\nassigned to the Y Button?',
    choices: [txt('B'), txt('E'), txt('G'), txt('C')],
    answerIndex: 0,
    answerSource: 'manual',
    disputed: true,
    shots: { question: 'cucco-ybutton-4choice.png' },
  },
  // Everything below is invented sample data (placeholder questions and answers).
  {
    lang: 'en',
    level: 'Egg Level',
    questionText: 'Epona is the name of the horse raised at Lon Lon Ranch.',
    choices: TF,
    answerIndex: 1,
    answerSource: 'manual',
  },
  {
    lang: 'en',
    level: 'Cucco Level',
    questionText: 'Which of these sells for the most?',
    choices: [
      pic('Bottled Poe', 'a bottle with a purple ghost inside'),
      pic('Fish', 'a bottle with a fish inside'),
      pic('Bug', 'a bottle with a small bug inside'),
      pic('Fairy', 'a bottle with a pink fairy inside'),
    ],
    answerIndex: 0,
    answerSource: 'manual',
  },
  {
    lang: 'en',
    level: 'Egg Level',
    questionText: 'How many Gold Skulltula tokens are there to collect in total?',
    choices: [txt('50'), txt('80'), txt('100'), txt('120')],
    answerIndex: 2,
    answerSource: 'manual',
    submissionCount: 2,
  },
  {
    lang: 'en',
    level: 'Cucco Level',
    questionText: "R Y A R Y A\nThis is the music score for Epona's Song.",
    choices: TF,
    answerIndex: 0,
    answerSource: 'manual',
  },
  {
    lang: 'ja',
    level: 'タマゴ級',
    questionText: 'エポナはロンロン牧場で育てられた馬の名前である。',
    choices: [sym('✕'), sym('○')],
    answerIndex: 1,
    answerSource: 'manual',
  },
  {
    lang: 'es',
    level: 'Nivel Huevo',
    questionText: '¿Qué canción hay que tocar para llamar a Epona?',
    choices: [txt('Canción de Saria'), txt('Canción de Epona'), txt('Canción del Sol'), txt('Nana de Zelda')],
    answerIndex: 1,
    answerSource: 'manual',
  },
];

async function reset(): Promise<number> {
  const db = getDb();
  const store = await getStore();
  const ids = db
    .selectDistinct({ id: submissions.questionId })
    .from(submissions)
    .where(eq(submissions.ipHash, SEED_IP))
    .all()
    .map((r) => r.id);
  if (ids.length) db.delete(questions).where(inArray(questions.id, ids)).run(); // submissions/reports cascade
  const imgs = db.select().from(images).where(like(images.key, 'seed/%')).all();
  for (const img of imgs) await store.delete(img.bucket, img.key);
  if (imgs.length) db.delete(images).where(like(images.key, 'seed/%')).run();
  return ids.length;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function addFixtureImage(file: string, hasReveal: boolean): Promise<number | null> {
  if (!repoRoot) return null;
  const path = join(repoRoot, 'fixtures/screenshots', file);
  if (!existsSync(path)) return null;
  const bytes = new Uint8Array(readFileSync(path));
  const key = `seed/${file}`;
  const store = await getStore();
  await store.put('public', key, bytes, 'image/png');
  const row = getDb()
    .insert(images)
    .values({
      // Not the file's real sha256, so a later genuine upload of the same screenshot is not treated as a duplicate.
      sha256: createHash('sha256').update(`seed:${file}`).digest('hex'),
      bucket: 'public',
      key,
      ...pngSize(bytes),
      hasReveal,
    })
    .returning({ id: images.id })
    .get();
  return row.id;
}

async function seed(): Promise<void> {
  const db = getDb();
  const removed = await reset();
  if (removed) console.log(`Removed ${removed} old sample questions.`);
  const base = Date.now() - SAMPLES.length * 60_000;
  let n = 0;
  for (const [i, s] of SAMPLES.entries()) {
    const dedupeKey = dedupeKeyFor(s);
    if (db.select({ id: questions.id }).from(questions).where(eq(questions.dedupeKey, dedupeKey)).get()) {
      console.log(`Skipped (a real entry already exists): ${s.questionText.split('\n')[0]}`);
      continue;
    }
    const questionImageId = s.shots?.question ? await addFixtureImage(s.shots.question, false) : null;
    const answerImageId = s.shots?.answer ? await addFixtureImage(s.shots.answer, true) : null;
    const createdAt = base + (SAMPLES.length - i) * 60_000;
    const row = db
      .insert(questions)
      .values({
        slug: `seed-pending-${i}-${createdAt}`,
        lang: s.lang,
        level: s.level,
        questionText: s.questionText,
        searchText: searchTextFor(s),
        dedupeKey,
        choices: s.choices,
        answerIndex: s.answerIndex,
        answerSource: s.answerSource,
        questionImageId,
        answerImageId,
        submissionCount: s.submissionCount ?? 1,
        disputed: s.disputed ?? false,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: questions.id })
      .get();
    db.update(questions).set({ slug: questionSlug(row.id, s.questionText) }).where(eq(questions.id, row.id)).run();
    db.insert(submissions)
      .values({
        questionId: row.id,
        imageId: answerImageId ?? questionImageId,
        parsed: null,
        answerCanonical: canonical(choiceIdentity(s.choices[s.answerIndex]!)),
        answerSource: s.answerSource,
        ipHash: SEED_IP,
      })
      .run();
    n++;
  }
  console.log(`Seeded ${n} SAMPLE questions (answers other than Saria's Song are placeholders).`);
}

if (process.argv.includes('--reset')) {
  console.log(`Removed ${await reset()} sample questions.`);
} else {
  await seed();
}
