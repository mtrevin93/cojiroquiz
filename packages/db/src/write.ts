// Write-side queries used by the ingest pipeline (owned by the ingest track).
// Every helper is synchronous (better-sqlite3) and accepts either the Db or a
// transaction handle, so callers can compose them inside db.transaction().
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { AnswerSource, Bucket, ParsedQuiz, StoredChoice } from '@cojiro/shared';
import type { Db } from './client.ts';
import { drafts, images, quarantine, questions, rateEvents, submissions } from './schema.ts';
import type { DraftVisual } from './schema.ts';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export type ImageRow = typeof images.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type SubmissionRow = typeof submissions.$inferSelect;
export type DraftRow = typeof drafts.$inferSelect;
type QuarantineRecord = typeof quarantine.$inferSelect;

/* ---------- images ---------- */

export function findImageBySha(db: DbOrTx, sha256: string): ImageRow | undefined {
  return db.select().from(images).where(eq(images.sha256, sha256)).get();
}

export function getImage(db: DbOrTx, id: number): ImageRow | undefined {
  return db.select().from(images).where(eq(images.id, id)).get();
}

export function insertImage(
  db: DbOrTx,
  v: { sha256: string; bucket: Bucket; key: string; width: number; height: number; hasReveal: boolean; createdAt: number },
): ImageRow {
  return db.insert(images).values(v).returning().get();
}

export function updateImage(
  db: DbOrTx,
  id: number,
  v: Partial<Pick<ImageRow, 'bucket' | 'key' | 'width' | 'height' | 'hasReveal'>>,
): void {
  db.update(images).set(v).where(eq(images.id, id)).run();
}

/** The question an image is attached to (through a submission), if any. */
export function findQuestionForImage(db: DbOrTx, imageId: number): { id: number; slug: string } | undefined {
  return db
    .select({ id: questions.id, slug: questions.slug })
    .from(submissions)
    .innerJoin(questions, eq(submissions.questionId, questions.id))
    .where(eq(submissions.imageId, imageId))
    .orderBy(asc(submissions.id))
    .get();
}

/* ---------- drafts ---------- */

export function insertDraft(
  db: DbOrTx,
  v: { id: string; imageId: number; parsed: ParsedQuiz; visual?: DraftVisual | null; ipHash: string; createdAt: number },
): void {
  db.insert(drafts).values(v).run();
}

export function getDraft(db: DbOrTx, id: string): DraftRow | undefined {
  return db.select().from(drafts).where(eq(drafts.id, id)).get();
}

export function deleteDraft(db: DbOrTx, id: string): void {
  db.delete(drafts).where(eq(drafts.id, id)).run();
}

/** Delete drafts created before `cutoff` (epoch ms). Returns how many were removed. */
export function purgeDraftsOlderThan(db: DbOrTx, cutoff: number): number {
  return db.delete(drafts).where(lt(drafts.createdAt, cutoff)).run().changes;
}

/* ---------- questions ---------- */

export function findQuestionByDedupeKey(db: DbOrTx, dedupeKey: string): QuestionRow | undefined {
  return db.select().from(questions).where(eq(questions.dedupeKey, dedupeKey)).get();
}

/** Every question with the same text; pictures decide between them. */
export function listQuestionsByTextKey(db: DbOrTx, textKey: string): QuestionRow[] {
  return db.select().from(questions).where(eq(questions.textKey, textKey)).all();
}

export function getQuestion(db: DbOrTx, id: number): QuestionRow | undefined {
  return db.select().from(questions).where(eq(questions.id, id)).get();
}

export function insertQuestion(
  db: DbOrTx,
  v: {
    slug: string;
    lang: string;
    level: string | null;
    questionText: string;
    searchText: string;
    dedupeKey: string;
    textKey: string;
    pictureKey: string | null;
    picturePhash: string | null;
    pictureDescription: string | null;
    choices: StoredChoice[];
    answerIndex: number;
    answerSource: AnswerSource;
    questionImageId: number | null;
    answerImageId: number | null;
    createdAt: number;
    updatedAt: number;
  },
): QuestionRow {
  return db.insert(questions).values(v).returning().get();
}

export function updateQuestion(
  db: DbOrTx,
  id: number,
  v: Partial<
    Pick<
      QuestionRow,
      | 'slug'
      | 'level'
      | 'choices'
      | 'searchText'
      | 'answerIndex'
      | 'answerSource'
      | 'questionImageId'
      | 'answerImageId'
      | 'submissionCount'
      | 'disputed'
      | 'hidden'
      | 'updatedAt'
    >
  >,
): void {
  db.update(questions).set(v).where(eq(questions.id, id)).run();
}

/* ---------- submissions ---------- */

export function insertSubmission(
  db: DbOrTx,
  v: {
    questionId: number;
    imageId: number | null;
    parsed: ParsedQuiz | null;
    answerCanonical: string;
    answerSource: AnswerSource;
    ipHash: string;
    createdAt: number;
  },
): SubmissionRow {
  return db.insert(submissions).values(v).returning().get();
}

/** All votes for a question, oldest first. */
export function listSubmissionVotes(
  db: DbOrTx,
  questionId: number,
): Array<Pick<SubmissionRow, 'id' | 'imageId' | 'answerCanonical' | 'answerSource' | 'ipHash'>> {
  return db
    .select({
      id: submissions.id,
      imageId: submissions.imageId,
      answerCanonical: submissions.answerCanonical,
      answerSource: submissions.answerSource,
      ipHash: submissions.ipHash,
    })
    .from(submissions)
    .where(eq(submissions.questionId, questionId))
    .orderBy(asc(submissions.id))
    .all();
}

/* ---------- quarantine ---------- */

export function insertQuarantine(
  db: DbOrTx,
  v: { sha256: string; key: string; reason: string; parsed: unknown; ipHash: string; createdAt: number },
): QuarantineRecord {
  return db.insert(quarantine).values(v).returning().get();
}

export function findQuarantineBySha(db: DbOrTx, sha256: string): QuarantineRecord | undefined {
  return db.select().from(quarantine).where(eq(quarantine.sha256, sha256)).orderBy(asc(quarantine.id)).get();
}

export function getQuarantineRow(db: DbOrTx, id: number): QuarantineRecord | undefined {
  return db.select().from(quarantine).where(eq(quarantine.id, id)).get();
}

export function setQuarantineStatus(
  db: DbOrTx,
  id: number,
  status: QuarantineRecord['status'],
  resolvedAt: number | null,
): void {
  db.update(quarantine).set({ status, resolvedAt }).where(eq(quarantine.id, id)).run();
}

/* ---------- rate events ---------- */

export function recordRateEvent(db: DbOrTx, kind: string, ipHash: string, createdAt: number): void {
  db.insert(rateEvents).values({ kind, ipHash, createdAt }).run();
}

/** Events of `kind` since `since` (epoch ms); for one ipHash, or across everyone when ipHash is null. */
export function countRateEvents(db: DbOrTx, kind: string, ipHash: string | null, since: number): number {
  const where =
    ipHash === null
      ? and(eq(rateEvents.kind, kind), gte(rateEvents.createdAt, since))
      : and(eq(rateEvents.kind, kind), eq(rateEvents.ipHash, ipHash), gte(rateEvents.createdAt, since));
  return db.select({ n: sql<number>`count(*)` }).from(rateEvents).where(where).get()?.n ?? 0;
}

/**
 * Sliding-window limiter: records an event and returns true when the caller is
 * under `limit` events of `kind` in the last `windowMs`; returns false (and
 * records nothing) when over.
 */
export function takeRateToken(
  db: Db,
  kind: string,
  ipHash: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  return db.transaction((tx) => {
    if (countRateEvents(tx, kind, ipHash, now - windowMs) >= limit) return false;
    recordRateEvent(tx, kind, ipHash, now);
    return true;
  });
}

/** Housekeeping: drop rate events older than `cutoff` (epoch ms). */
export function purgeRateEventsOlderThan(db: DbOrTx, cutoff: number): number {
  return db.delete(rateEvents).where(lt(rateEvents.createdAt, cutoff)).run().changes;
}
