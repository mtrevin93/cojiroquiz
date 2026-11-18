/**
 * Step 1 of importing the game's own question list: turn the raw list and its
 * pictures into a bundle (resized pictures + bundle.json) that source-apply.ts
 * can load into a database. Runs locally; needs sharp.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from '@cojiro/shared';
import sharp from 'sharp';
import { dHash } from './image.ts';

/** One question as the game sends it. The first option is the correct one. */
export interface SourceQuestion {
  id: string;
  level: string;
  question: string;
  questionImageFile?: string | null;
  options: Array<{ text: string; imageFile?: string | null }>;
}

export interface BundleImage {
  /** Key in the public bucket. */
  key: string;
  phash: string | null;
  width: number;
  height: number;
}

export interface BundleQuestion {
  /** Every source id folded into this question (same wording, picture and answer). */
  sourceIds: string[];
  lang: string;
  level: string | null;
  questionText: string;
  /** Name of the question's picture in `images`, if it has one. */
  picture: string | null;
  choices: Array<{ label: string; kind: 'text' | 'symbol' | 'image'; image: string | null }>;
  answerIndex: number;
}

export interface Bundle {
  images: Record<string, BundleImage>;
  questions: BundleQuestion[];
}

const LEVELS: Record<string, string> = { beginner: 'Egg Level', advanced: 'Cucco Level' };
const SYMBOLS = new Set(['✓', 'X']);
/** Long edge of stored pictures: question pictures are shown wide, choices in a grid. */
const QUESTION_EDGE = 960;
const CHOICE_EDGE = 640;

export const sourceImageKey = (name: string) => `src/${name}.webp`;

/** Deterministic shuffle, so a re-import gives the same choice order. */
function seededOrder(n: number, seed: string): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  const bytes = createHash('sha256').update(seed).digest();
  for (let i = n - 1; i > 0; i--) {
    const j = bytes[i % bytes.length]! % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

const answerId = (q: SourceQuestion) => q.options[0]!.imageFile || canonical(q.options[0]!.text);

/**
 * The game repeats a question with different wrong choices (two at one level, four
 * at another). The site keeps one question per wording + picture + answer, with the
 * fullest choice set.
 */
export function foldQuestions(source: SourceQuestion[]): Array<{ keep: SourceQuestion; ids: string[] }> {
  const groups = new Map<string, SourceQuestion[]>();
  for (const q of source) {
    if (!q.question?.trim() || q.options.length < 2) continue;
    const key = [canonical(q.question), q.questionImageFile ?? '', answerId(q)].join('\u001f');
    const g = groups.get(key);
    if (g) g.push(q);
    else groups.set(key, [q]);
  }
  return [...groups.values()].map((g) => {
    const keep = g.reduce((a, b) => (b.options.length > a.options.length ? b : a));
    return { keep, ids: [keep.id, ...g.filter((q) => q !== keep).map((q) => q.id)] };
  });
}

const NAMING = /^(what is this(?: [\p{L}-]+)* called|who is this|what is this|which [\p{L}-]+ is this)\??$/iu;
const WHICH_IS = /^which of these is (?:(?:a|an|the) )?(\p{Lu}[^?]*)\??$/iu;

/**
 * Names for choice pictures, taken from the game's own wording:
 * - "Which of these is Ruto?" names the correct picture "Ruto";
 * - a choice picture X_0123_4x3 shows the same thing as question picture X_0123_16x9, and
 *   "What is this monster called?" over that picture is answered with its name.
 */
export function pictureNames(source: SourceQuestion[]): Map<string, string> {
  const names = new Map<string, string>();
  const clean = (s: string) => s.replace(/\s+/gu, ' ').trim();
  for (const q of source) {
    const text = clean(q.question ?? '');
    const answer = q.options[0];
    if (!answer) continue;
    if (q.questionImageFile && !answer.imageFile && answer.text && NAMING.test(text)) {
      const twin = q.questionImageFile.replace(/_16x9$/, '_4x3');
      if (twin !== q.questionImageFile && !names.has(twin)) names.set(twin, clean(answer.text));
    }
  }
  for (const q of source) {
    const answer = q.options[0];
    // The name must start with a capital in the original: "Ruto", "a Stinger", not "easy to break".
    const m = WHICH_IS.exec(clean(q.question ?? ''));
    const name = m?.[1] && /^\p{Lu}/u.test(m[1]) ? clean(m[1]) : null;
    if (answer?.imageFile && name && !names.has(answer.imageFile)) names.set(answer.imageFile, name);
  }
  return names;
}

export function toBundleQuestion(q: SourceQuestion, ids: string[], names: Map<string, string> = new Map()): BundleQuestion {
  const order = seededOrder(q.options.length, q.id);
  const choices = order.map((i) => {
    const o = q.options[i]!;
    const image = o.imageFile || null;
    const label = image ? (names.get(image) ?? '') : o.text;
    return { label, kind: image ? ('image' as const) : SYMBOLS.has(label) ? ('symbol' as const) : ('text' as const), image };
  });
  return {
    sourceIds: ids,
    lang: 'en',
    level: LEVELS[q.level] ?? null,
    questionText: q.question,
    picture: q.questionImageFile || null,
    choices,
    answerIndex: order.indexOf(0),
  };
}

/** Resize every referenced picture into `outDir/images` and write `outDir/bundle.json`. */
export async function prepareBundle(source: SourceQuestion[], imagesDir: string, outDir: string): Promise<Bundle> {
  const names = pictureNames(source);
  const questions = foldQuestions(source).map(({ keep, ids }) => toBundleQuestion(keep, ids, names));
  const edges = new Map<string, number>();
  for (const q of questions) {
    if (q.picture) edges.set(q.picture, QUESTION_EDGE);
    for (const c of q.choices) if (c.image && !edges.has(c.image)) edges.set(c.image, CHOICE_EDGE);
  }
  await mkdir(join(outDir, 'images'), { recursive: true });
  const images: Record<string, BundleImage> = {};
  for (const [name, edge] of edges) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Unexpected picture name: ${JSON.stringify(name)}`);
    const raw = await readFile(join(imagesDir, `${name}.webp`));
    const { data, info } = await sharp(raw)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    await writeFile(join(outDir, 'images', `${name}.webp`), data);
    images[name] = { key: sourceImageKey(name), phash: await dHash(new Uint8Array(data)), width: info.width, height: info.height };
  }
  const bundle: Bundle = { images, questions };
  await writeFile(join(outDir, 'bundle.json'), JSON.stringify(bundle));
  return bundle;
}
