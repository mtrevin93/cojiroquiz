/** Writes made by the web app itself (reports, feedback, admin actions). */
import { createHash } from 'node:crypto';
import { schema, type Db } from '@cojiro/db';
import { buildSearchText, dedupeMaterial, type ReportReason, type StoredChoice } from '@cojiro/shared';
import { and, eq } from 'drizzle-orm';
import { reportEffects } from './reports.ts';

const { questions, reports, feedback, quarantine } = schema;

/*
 * Derived columns. These mirror packages/ingest/src/ingest.ts (insertOrMerge,
 * computeDedupeKey, choiceText) so admin edits and seeded rows dedupe and
 * search exactly like ingested ones. Keep them in sync.
 */

/** The text a choice is identified by: its label, or for picture choices its description. */
export function choiceIdentity(c: StoredChoice): string {
  return c.kind === 'image' ? c.description || c.label : c.label;
}

export function searchTextFor(q: { questionText: string; level: string | null; choices: StoredChoice[] }): string {
  return buildSearchText([q.questionText, q.level, ...q.choices.map((c) => c.label), ...q.choices.map((c) => c.description)]);
}

export function dedupeKeyFor(q: { lang: string; questionText: string; choices: StoredChoice[] }): string {
  return createHash('sha256').update(dedupeMaterial(q.lang, q.questionText, q.choices.map(choiceIdentity))).digest('hex');
}

/** Insert a report and apply its safety valves. Returns null if the question does not exist. */
export function createReport(
  db: Db,
  input: { questionId: number; reason: ReportReason; note: string | null; ipHash: string },
): { id: number; hidden: boolean; disputed: boolean } | null {
  return db.transaction((tx) => {
    const q = tx.select({ id: questions.id }).from(questions).where(eq(questions.id, input.questionId)).get();
    if (!q) return null;
    const row = tx
      .insert(reports)
      .values({ questionId: input.questionId, reason: input.reason, note: input.note || null, ipHash: input.ipHash })
      .returning({ id: reports.id })
      .get();
    const open = tx
      .select({ ipHash: reports.ipHash })
      .from(reports)
      .where(and(eq(reports.questionId, input.questionId), eq(reports.resolved, false)))
      .all();
    const fx = reportEffects(input.reason, open.map((r) => r.ipHash));
    if (fx.hide || fx.dispute) {
      tx.update(questions)
        .set({ ...(fx.hide ? { hidden: true } : {}), ...(fx.dispute ? { disputed: true } : {}) })
        .where(eq(questions.id, input.questionId))
        .run();
    }
    return { id: row.id, hidden: fx.hide, disputed: fx.dispute };
  });
}

export function insertFeedback(db: Db, input: { message: string; contact: string | null; ipHash: string }): number {
  return db.insert(feedback).values(input).returning({ id: feedback.id }).get().id;
}

export function markFeedbackEmailed(db: Db, id: number): void {
  db.update(feedback).set({ emailed: true }).where(eq(feedback.id, id)).run();
}

/* ---------- admin ---------- */

export function resolveReport(db: Db, id: number): void {
  db.update(reports).set({ resolved: true }).where(eq(reports.id, id)).run();
}

export function setQuestionHidden(db: Db, id: number, hidden: boolean): void {
  db.update(questions).set({ hidden, updatedAt: Date.now() }).where(eq(questions.id, id)).run();
}

export function setQuestionDisputed(db: Db, id: number, disputed: boolean): void {
  db.update(questions).set({ disputed, updatedAt: Date.now() }).where(eq(questions.id, id)).run();
}

export function deleteQuestion(db: Db, id: number): void {
  // submissions and reports cascade; image rows/blobs are left for the ingest side to reuse or purge.
  db.delete(questions).where(eq(questions.id, id)).run();
}

/** Admin edit of text/answer. Search text and dedupe key are rebuilt; the slug (URL) stays stable. */
export function editQuestion(
  db: Db,
  id: number,
  patch: { questionText?: string; lang?: string; level?: string | null; answerIndex?: number },
): { ok: true } | { ok: false; error: string } {
  const q = db.select().from(questions).where(eq(questions.id, id)).get();
  if (!q) return { ok: false, error: 'Question not found.' };
  const next = {
    questionText: patch.questionText ?? q.questionText,
    lang: patch.lang ?? q.lang,
    level: patch.level === undefined ? q.level : patch.level,
    answerIndex: patch.answerIndex ?? q.answerIndex,
    choices: q.choices,
  };
  if (next.answerIndex < 0 || next.answerIndex >= next.choices.length) {
    return { ok: false, error: 'Answer index is out of range.' };
  }
  const dedupeKey = dedupeKeyFor(next);
  const clash = db.select({ id: questions.id }).from(questions).where(eq(questions.dedupeKey, dedupeKey)).get();
  if (clash && clash.id !== id) return { ok: false, error: `That text duplicates question #${clash.id}.` };
  db.update(questions)
    .set({
      questionText: next.questionText,
      lang: next.lang,
      level: next.level,
      answerIndex: next.answerIndex,
      searchText: searchTextFor(next),
      dedupeKey,
      updatedAt: Date.now(),
    })
    .where(eq(questions.id, id))
    .run();
  return { ok: true };
}

export function setQuarantineStatus(db: Db, id: number, status: 'new' | 'promoted' | 'dismissed'): void {
  db.update(quarantine)
    .set({ status, resolvedAt: status === 'new' ? null : Date.now() })
    .where(eq(quarantine.id, id))
    .run();
}

export function setQuarantineFixture(db: Db, id: number, fixture: boolean): void {
  db.update(quarantine).set({ fixture }).where(eq(quarantine.id, id)).run();
}

/** Removes the row and returns the blob key so the caller can delete the file. */
export function deleteQuarantine(db: Db, id: number): string | null {
  const row = db.delete(quarantine).where(eq(quarantine.id, id)).returning({ key: quarantine.key }).get();
  return row?.key ?? null;
}

/**
 * Admin decision after reviewing reports and evidence: set the correct answer and lock it,
 * clear the disputed flag, and close the question's open reports.
 */
export function setAnswerByAdmin(
  db: Db,
  id: number,
  answerIndex: number,
  opts: { unhide?: boolean } = {},
): { ok: true; label: string } | { ok: false; error: string } {
  return db.transaction((tx) => {
    const q = tx.select().from(questions).where(eq(questions.id, id)).get();
    if (!q) return { ok: false as const, error: 'Question not found.' };
    const choice = q.choices[answerIndex];
    if (!Number.isInteger(answerIndex) || !choice) return { ok: false as const, error: 'Pick one of the choices.' };
    const changed = answerIndex !== q.answerIndex;
    tx.update(questions)
      .set({
        answerIndex,
        answerLocked: true,
        disputed: false,
        // A result screenshot of the old answer would now contradict the page.
        ...(changed ? { answerImageId: null, answerSource: 'manual' as const } : {}),
        ...(opts.unhide ? { hidden: false } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(questions.id, id))
      .run();
    tx.update(reports).set({ resolved: true }).where(and(eq(reports.questionId, id), eq(reports.resolved, false))).run();
    return { ok: true as const, label: choice.label || choice.description || `choice ${answerIndex + 1}` };
  });
}

export function resolveReportsForQuestion(db: Db, questionId: number): void {
  db.update(reports).set({ resolved: true }).where(and(eq(reports.questionId, questionId), eq(reports.resolved, false))).run();
}
