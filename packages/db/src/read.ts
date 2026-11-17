// Read-side queries used by pages (owned by the web track).
import { and, count, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { buildSearchText, matchesQuery } from '@cojiro/shared';
import type { QuestionDTO, ReportReason, SearchIndexEntry, StoredChoice } from '@cojiro/shared';
import type { Db } from './client.ts';
import { feedback, images, quarantine, questions, reports, submissions } from './schema.ts';

/** Maps a key in the public bucket to a URL (normally `BlobStore.publicUrl`). */
export type UrlFor = (key: string) => string;

export interface ImageRef {
  url: string;
  width: number;
  height: number;
}

/** QuestionDTO plus what pages need beyond the public contract. */
export interface QuestionView extends QuestionDTO {
  hidden: boolean;
  answerLocked: boolean;
  questionImage: ImageRef | null;
  answerImage: ImageRef | null;
}

/** SearchIndexEntry plus the answer image's intrinsic size (for width/height attributes). */
export interface SearchEntry extends SearchIndexEntry {
  answerImageWidth: number | null;
  answerImageHeight: number | null;
}

export interface QuestionFilter {
  lang?: string;
  level?: string;
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
}

const qImg = alias(images, 'q_img');
const aImg = alias(images, 'a_img');

const questionSelection = {
  q: questions,
  qKey: qImg.key,
  qBucket: qImg.bucket,
  qW: qImg.width,
  qH: qImg.height,
  aKey: aImg.key,
  aBucket: aImg.bucket,
  aW: aImg.width,
  aH: aImg.height,
};

type Row = {
  q: typeof questions.$inferSelect;
  qKey: string | null;
  qBucket: 'public' | 'private' | null;
  qW: number | null;
  qH: number | null;
  aKey: string | null;
  aBucket: 'public' | 'private' | null;
  aW: number | null;
  aH: number | null;
};

function imageRef(
  key: string | null,
  bucket: string | null,
  w: number | null,
  h: number | null,
  urlFor: UrlFor,
): ImageRef | null {
  // Only blobs in the public bucket ever get a public URL.
  if (!key || bucket !== 'public') return null;
  return { url: urlFor(key), width: w ?? 0, height: h ?? 0 };
}

function toView(row: Row, urlFor: UrlFor): QuestionView {
  const q = row.q;
  const questionImage = imageRef(row.qKey, row.qBucket, row.qW, row.qH, urlFor);
  const answerImage = imageRef(row.aKey, row.aBucket, row.aW, row.aH, urlFor);
  const choices = (q.choices ?? []).map((c: StoredChoice) => ({
    ...c,
    imageUrl: c.imageKey ? urlFor(c.imageKey) : null,
  }));
  return {
    id: q.id,
    slug: q.slug,
    lang: q.lang,
    level: q.level,
    questionText: q.questionText,
    pictureUrl: q.pictureKey ? urlFor(q.pictureKey) : null,
    pictureDescription: q.pictureDescription,
    choices,
    answerIndex: q.answerIndex,
    answerSource: q.answerSource,
    questionImageUrl: questionImage?.url ?? null,
    answerImageUrl: answerImage?.url ?? null,
    submissionCount: q.submissionCount,
    disputed: q.disputed,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    hidden: q.hidden,
    answerLocked: q.answerLocked,
    questionImage,
    answerImage,
  };
}

function baseQuery(db: Db) {
  return db
    .select(questionSelection)
    .from(questions)
    .leftJoin(qImg, eq(questions.questionImageId, qImg.id))
    .leftJoin(aImg, eq(questions.answerImageId, aImg.id));
}

function filterWhere(f: QuestionFilter) {
  return and(
    f.includeHidden ? undefined : eq(questions.hidden, false),
    f.lang ? eq(questions.lang, f.lang) : undefined,
    f.level ? eq(questions.level, f.level) : undefined,
  );
}

/** Questions, newest first. Hidden ones are excluded unless asked for. */
export function listQuestions(db: Db, urlFor: UrlFor, filter: QuestionFilter = {}): QuestionView[] {
  const rows = baseQuery(db)
    .where(filterWhere(filter))
    .orderBy(desc(questions.createdAt), desc(questions.id))
    .limit(filter.limit ?? 5000)
    .offset(filter.offset ?? 0)
    .all();
  return rows.map((r) => toView(r, urlFor));
}

/** One question by slug, including hidden ones (the page decides what to show). */
export function getQuestionBySlug(db: Db, urlFor: UrlFor, slug: string): QuestionView | null {
  const row = baseQuery(db).where(eq(questions.slug, slug)).get();
  return row ? toView(row, urlFor) : null;
}

export function getQuestionById(db: Db, urlFor: UrlFor, id: number): QuestionView | null {
  const row = baseQuery(db).where(eq(questions.id, id)).get();
  return row ? toView(row, urlFor) : null;
}

/** Text shown for a choice: its label, or its description for unlabeled image choices. */
export function choiceText(c: Pick<StoredChoice, 'label' | 'description'> | undefined): string {
  if (!c) return '';
  return c.label || c.description || '';
}

function toSearchEntry(row: Row, urlFor: UrlFor): SearchEntry {
  const v = toView(row, urlFor);
  const answer = v.choices[v.answerIndex];
  return {
    id: v.id,
    slug: v.slug,
    lang: v.lang,
    level: v.level,
    questionText: v.questionText,
    pictureUrl: v.pictureUrl,
    choicePictures: v.choices.every((c) => c.imageUrl)
      ? v.choices.map((c, i) => ({ url: c.imageUrl!, label: choiceText(c), correct: i === v.answerIndex }))
      : [],
    options: v.choices.map((c, i) => ({ label: choiceText(c), correct: i === v.answerIndex })),
    // Built here, not read from the stored column, so what is searchable is decided in one place:
    // the question, its choices and picture names. The level label is not part of it.
    searchText: buildSearchText([
      v.questionText,
      ...v.choices.map((c) => c.label),
      ...v.choices.map((c) => c.description),
      v.pictureDescription,
    ]),
    answerLabel: choiceText(answer),
    answerImageUrl: v.answerImage?.url ?? null,
    answerChoiceImageUrl: answer?.imageUrl ?? null,
    disputed: v.disputed,
    answerImageWidth: v.answerImage?.width ?? null,
    answerImageHeight: v.answerImage?.height ?? null,
  };
}

/**
 * The text a vote for this choice is recorded under (submissions.answer_canonical is the
 * canonical form of this): a picture choice's description, otherwise the label.
 */
export function choiceVoteText(c: Pick<StoredChoice, 'label' | 'kind' | 'description'>): string {
  return c.kind === 'image' ? c.description || c.label : c.label;
}

/** The public card's data for one question (admin pages render the same card as visitors see). */
export function entryFromView(v: QuestionView): SearchEntry {
  const answer = v.choices[v.answerIndex];
  return {
    id: v.id,
    slug: v.slug,
    lang: v.lang,
    level: v.level,
    questionText: v.questionText,
    pictureUrl: v.pictureUrl,
    choicePictures: v.choices.every((c) => c.imageUrl)
      ? v.choices.map((c, i) => ({ url: c.imageUrl!, label: choiceText(c), correct: i === v.answerIndex }))
      : [],
    options: v.choices.map((c, i) => ({ label: choiceText(c), correct: i === v.answerIndex })),
    searchText: '',
    answerLabel: choiceText(answer),
    answerImageUrl: v.answerImage?.url ?? null,
    answerChoiceImageUrl: answer?.imageUrl ?? null,
    disputed: v.disputed,
    answerImageWidth: v.answerImage?.width ?? null,
    answerImageHeight: v.answerImage?.height ?? null,
  };
}

/** Compact index of every visible question, newest first, for the search island. */
export function buildSearchIndex(db: Db, urlFor: UrlFor, filter: Omit<QuestionFilter, 'includeHidden'> = {}): SearchEntry[] {
  const rows = baseQuery(db)
    .where(filterWhere(filter))
    .orderBy(desc(questions.createdAt), desc(questions.id))
    .limit(filter.limit ?? 20000)
    .all();
  return rows.map((r) => toSearchEntry(r, urlFor));
}

/**
 * Questions whose choice pictures were cropped from a result screenshot. Those crops
 * carry the game's own check mark and X, so they give the answer away before it is picked.
 * (Crop keys are `choices/<sha256 of the screenshot>-<n>.webp`.)
 */
export function questionsWithMarkedChoicePictures(db: Db): Set<number> {
  const resultShots = new Set(
    db.select({ sha: images.sha256 }).from(images).where(eq(images.hasReveal, true)).all().map((r) => r.sha),
  );
  const marked = new Set<number>();
  for (const q of db.select({ id: questions.id, choices: questions.choices }).from(questions).all()) {
    const fromResultShot = q.choices.some((c) => {
      const sha = c.imageKey && /^choices\/([0-9a-f]{64})-/.exec(c.imageKey)?.[1];
      return !!sha && resultShots.has(sha);
    });
    if (fromResultShot) marked.add(q.id);
  }
  return marked;
}

/** Filter index entries with the shared matcher (same code runs in the browser). */
export function filterEntries<T extends SearchIndexEntry>(entries: T[], query: string, lang?: string | null): T[] {
  return entries.filter((e) => (!lang || e.lang === lang) && matchesQuery(e.searchText, query));
}

/** Server-side search: every query term must be a substring of search_text. */
export function searchQuestions(db: Db, urlFor: UrlFor, query: string, opts: { lang?: string } = {}): SearchEntry[] {
  return filterEntries(buildSearchIndex(db, urlFor, { lang: opts.lang }), query);
}

export interface Facet {
  value: string;
  count: number;
}

/** Levels of visible questions with counts, most questions first. */
export function listLevels(db: Db): Facet[] {
  return db
    .select({ value: questions.level, count: count() })
    .from(questions)
    .where(and(eq(questions.hidden, false), isNotNull(questions.level)))
    .groupBy(questions.level)
    .orderBy(desc(count()), questions.level)
    .all()
    .filter((r): r is Facet => !!r.value);
}

/** Languages of visible questions with counts, most questions first. */
export function listLanguages(db: Db): Facet[] {
  return db
    .select({ value: questions.lang, count: count() })
    .from(questions)
    .where(eq(questions.hidden, false))
    .groupBy(questions.lang)
    .orderBy(desc(count()), questions.lang)
    .all();
}

/** Slugs + timestamps of visible questions, for the sitemap. */
export function listSitemapEntries(db: Db): Array<{ slug: string; updatedAt: number }> {
  return db
    .select({ slug: questions.slug, updatedAt: questions.updatedAt })
    .from(questions)
    .where(eq(questions.hidden, false))
    .orderBy(desc(questions.updatedAt))
    .all();
}

/** Trivial query for the health check. */
export function ping(db: Db): boolean {
  const row = db.get<{ ok: number }>(sql`select 1 as ok`);
  return row?.ok === 1;
}

/* ---------- admin ---------- */

export interface AdminReport {
  id: number;
  reason: ReportReason;
  note: string | null;
  resolved: boolean;
  createdAt: number;
  ipHash: string;
  question: { id: number; slug: string; questionText: string; hidden: boolean; disputed: boolean };
}

export function listReports(db: Db, opts: { includeResolved?: boolean; limit?: number } = {}): AdminReport[] {
  return db
    .select({
      id: reports.id,
      reason: reports.reason,
      note: reports.note,
      resolved: reports.resolved,
      createdAt: reports.createdAt,
      ipHash: reports.ipHash,
      qId: questions.id,
      qSlug: questions.slug,
      qText: questions.questionText,
      qHidden: questions.hidden,
      qDisputed: questions.disputed,
    })
    .from(reports)
    .innerJoin(questions, eq(reports.questionId, questions.id))
    .where(opts.includeResolved ? undefined : eq(reports.resolved, false))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(opts.limit ?? 200)
    .all()
    .map((r) => ({
      id: r.id,
      reason: r.reason,
      note: r.note,
      resolved: r.resolved,
      createdAt: r.createdAt,
      ipHash: r.ipHash,
      question: { id: r.qId, slug: r.qSlug, questionText: r.qText, hidden: r.qHidden, disputed: r.qDisputed },
    }));
}

export type QuarantineRow = typeof quarantine.$inferSelect;

export function listQuarantine(
  db: Db,
  opts: { status?: QuarantineRow['status']; limit?: number } = {},
): QuarantineRow[] {
  return db
    .select()
    .from(quarantine)
    .where(opts.status ? eq(quarantine.status, opts.status) : undefined)
    .orderBy(desc(quarantine.createdAt), desc(quarantine.id))
    .limit(opts.limit ?? 100)
    .all();
}

export function getQuarantine(db: Db, id: number): QuarantineRow | null {
  return db.select().from(quarantine).where(eq(quarantine.id, id)).get() ?? null;
}

/** Most recently created questions, hidden ones included. */
export function listRecentQuestions(db: Db, urlFor: UrlFor, limit = 50): QuestionView[] {
  return listQuestions(db, urlFor, { includeHidden: true, limit });
}

export type FeedbackRow = typeof feedback.$inferSelect;

export function listFeedback(db: Db, limit = 100): FeedbackRow[] {
  return db.select().from(feedback).orderBy(desc(feedback.createdAt), desc(feedback.id)).limit(limit).all();
}

/* ---------- admin review ---------- */

export interface EvidenceRow {
  id: number;
  answerCanonical: string;
  answerSource: 'reveal' | 'manual';
  ipHash: string;
  createdAt: number;
  imageUrl: string | null;
}

/** Every upload behind a question: what each one said the answer was, and its screenshot. */
export function listEvidence(db: Db, urlFor: UrlFor, questionId: number): EvidenceRow[] {
  return db
    .select({
      id: submissions.id,
      answerCanonical: submissions.answerCanonical,
      answerSource: submissions.answerSource,
      ipHash: submissions.ipHash,
      createdAt: submissions.createdAt,
      imageKey: images.key,
      imageBucket: images.bucket,
    })
    .from(submissions)
    .leftJoin(images, eq(submissions.imageId, images.id))
    .where(eq(submissions.questionId, questionId))
    .orderBy(desc(submissions.createdAt))
    .all()
    .map(({ imageKey, imageBucket, ...r }) => ({
      ...r,
      imageUrl: imageKey && imageBucket === 'public' ? urlFor(imageKey) : null,
    }));
}

export type ReportRow = typeof reports.$inferSelect;

export function listReportsForQuestion(db: Db, questionId: number): ReportRow[] {
  return db.select().from(reports).where(eq(reports.questionId, questionId)).orderBy(desc(reports.createdAt)).all();
}
