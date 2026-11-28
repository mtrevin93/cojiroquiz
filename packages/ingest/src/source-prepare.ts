/**
 * Step 1 of importing the game's own question list: turn the raw list and its
 * pictures into a bundle (resized pictures + bundle.json) that source-apply.ts
 * can load into a database. Runs locally; needs sharp.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from '@cojiro/shared';
import sharp from 'sharp';
import { dHash } from './image.ts';

/** One question as the game sends it. The first option is the correct one. */
export interface SourceQuestion {
  /** Locale the wording is in, e.g. "en-GB". Absent for a single-language list. */
  locale?: string;
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
  /** Every source id folded into this question (same wording, picture and answer), as "locale:id" when the list has locales. */
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

/** The language a locale's questions are stored under: its primary tag; Chinese keeps its region. */
export function storedLang(locale: string): string {
  const [primary = 'und', region] = locale.trim().split(/[-_]/);
  return primary.toLowerCase() === 'zh' && region ? `zh-${region.toUpperCase()}` : primary.toLowerCase();
}

const sourceId = (q: SourceQuestion) => (q.locale ? `${q.locale}:${q.id}` : q.id);

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
    return { keep, ids: [...new Set([sourceId(keep), ...g.filter((q) => q !== keep).map(sourceId)])] };
  });
}

const NAMING = /^(what is this(?: [\p{L}-]+)* called|who is this|what is this|which [\p{L}-]+ is this)\??$/iu;
const WHICH_IS = /^which of these is (?:(?:a|an|the) )?(\p{Lu}[^?]*)\??$/iu;

const ARTICLE = /^(?:a|an|the) /i;
const IS_QUESTION = /^(?:which(?: of these| one)?|who|what) (?:is|are|was) (.+?)\??$/iu;

/**
 * What a question says its answer is: "Which is the Bazaar's door?" -> "the Bazaar's door".
 * Null unless that reads as a name for the thing: it starts with an article or a capital,
 * and is not a negative ("not a Kokiri"), a superlative or a dangling fragment ("Nabooru looking for").
 */
export function describedAs(question: string): string | null {
  // "In Kakariko Village, which is ...?"
  const m = IS_QUESTION.exec(question.replace(/^[^,?]{3,40}, (?=(?:which|who|what)\b)/iu, ''));
  const name = m?.[1]?.trim();
  if (!name || name.length > 64) return null;
  if (!ARTICLE.test(name) && !/^\p{Lu}/u.test(name)) return null;
  if (/^(?:the (?:most|least|only|odd|correct|right|same)|one of)\b/i.test(name)) return null;
  if (/\b(?:not|never|cannot|isn't|can't|doesn't|don't)\b/i.test(name)) return null;
  if (/ (?:for|to|by|with|of|in|at|from|on)$/i.test(name)) return null;
  return name;
}

/**
 * Names for choice pictures, taken from the game's own wording:
 * - "Which of these is Ruto?" names the correct picture "Ruto";
 * - a choice picture X_0123_4x3 shows the same thing as question picture X_0123_16x9, and
 *   "What is this monster called?" over that picture is answered with its name;
 * - "Which is Granny's husband?" names the correct picture "Granny's husband".
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
  // Descriptions: "Which is Granny's husband?", "Which of these is the owner of the Bazaar?".
  const described = new Map<string, string[]>();
  for (const q of source) {
    const answer = q.options[0];
    if (!answer?.imageFile || names.has(answer.imageFile)) continue;
    const name = describedAs(clean(q.question ?? ''));
    if (name) described.set(answer.imageFile, [...(described.get(answer.imageFile) ?? []), name]);
  }
  for (const [image, found] of described) {
    // A proper name ("Granny") beats a description ("the lake scientist's apprentice"); then the shortest.
    const best = found.reduce((x, y) => (Number(ARTICLE.test(y)) - Number(ARTICLE.test(x)) || y.length - x.length) < 0 ? y : x);
    const bare = best.replace(ARTICLE, '');
    names.set(image, bare.charAt(0).toUpperCase() + bare.slice(1));
  }
  return names;
}

/**
 * Picture names in another language. Only the "same picture, named by a naming question"
 * rule carries over: the naming question is found in `english`, and its answer in `local`
 * (same question id) is the picture's name in that language.
 */
export function localPictureNames(english: SourceQuestion[], local: SourceQuestion[]): Map<string, string> {
  const byId = new Map(local.map((q) => [q.id, q]));
  const names = new Map<string, string>();
  for (const q of english) {
    const answer = q.options[0];
    if (!q.questionImageFile || !answer || answer.imageFile || !NAMING.test((q.question ?? '').replace(/\s+/gu, ' ').trim())) continue;
    const twin = q.questionImageFile.replace(/_16x9$/, '_4x3');
    const name = byId.get(q.id)?.options[0]?.text?.replace(/\s+/gu, ' ').trim();
    if (twin !== q.questionImageFile && name && !names.has(twin)) names.set(twin, name);
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
    lang: q.locale ? storedLang(q.locale) : 'en',
    // The level names are only known in English.
    level: !q.locale || storedLang(q.locale) === 'en' ? (LEVELS[q.level] ?? null) : null,
    questionText: q.question,
    picture: q.questionImageFile || null,
    choices,
    answerIndex: order.indexOf(0),
  };
}

export interface LocaleSource {
  locale: string;
  questions: SourceQuestion[];
}

/**
 * Questions for every language. Locales of one language (en-GB + en-US, es-ES + es-MX)
 * are folded together: where the wording is the same there is one question, where it
 * differs both are kept. The first locale listed for a language is its main one.
 */
export function bundleQuestions(sources: LocaleSource[]): BundleQuestion[] {
  const english = sources.find((s) => storedLang(s.locale) === 'en')?.questions ?? [];
  const groups = new Map<string, LocaleSource[]>();
  for (const s of sources) {
    const lang = storedLang(s.locale);
    groups.set(lang, [...(groups.get(lang) ?? []), s]);
  }
  const out: BundleQuestion[] = [];
  for (const [lang, group] of groups) {
    const main = group[0]!.questions;
    const names = lang === 'en' ? pictureNames(main) : localPictureNames(english, main);
    const all = group.flatMap((s) => s.questions.map((q) => ({ ...q, locale: s.locale })));
    for (const { keep, ids } of foldQuestions(all)) out.push(toBundleQuestion(keep, ids, names));
  }
  return out;
}

/** Resize every referenced picture into `outDir/images` and write `outDir/bundle.json`. Pictures already there are kept. */
export async function prepareBundle(sources: LocaleSource[] | SourceQuestion[], imagesDir: string, outDir: string): Promise<Bundle> {
  const questions =
    sources.length > 0 && 'questions' in sources[0]!
      ? bundleQuestions(sources as LocaleSource[])
      : foldQuestions(sources as SourceQuestion[]).map(({ keep, ids }) => toBundleQuestion(keep, ids, pictureNames(sources as SourceQuestion[])));
  const edges = new Map<string, number>();
  for (const q of questions) {
    if (q.picture) edges.set(q.picture, QUESTION_EDGE);
    for (const c of q.choices) if (c.image && !edges.has(c.image)) edges.set(c.image, CHOICE_EDGE);
  }
  await mkdir(join(outDir, 'images'), { recursive: true });
  let previous: Record<string, BundleImage> = {};
  try {
    previous = (JSON.parse(await readFile(join(outDir, 'bundle.json'), 'utf8')) as Bundle).images;
  } catch {
    /* first run */
  }
  const images: Record<string, BundleImage> = {};
  for (const [name, edge] of edges) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Unexpected picture name: ${JSON.stringify(name)}`);
    const file = join(outDir, 'images', `${name}.webp`);
    if (previous[name] && existsSync(file)) {
      images[name] = previous[name]!;
      continue;
    }
    const raw = await readFile(join(imagesDir, `${name}.webp`));
    const { data, info } = await sharp(raw)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    await writeFile(file, data);
    images[name] = { key: sourceImageKey(name), phash: await dHash(new Uint8Array(data)), width: info.width, height: info.height };
  }
  const bundle: Bundle = { images, questions };
  await writeFile(join(outDir, 'bundle.json'), JSON.stringify(bundle));
  return bundle;
}
