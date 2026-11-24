import type { APIRoute } from 'astro';
import { ManualInput } from '@cojiro/shared';
import { getQuarantine } from '@cojiro/db';
import { ipHashOf } from '../../../lib/http.ts';
import {
  deleteQuarantine,
  deleteQuestion,
  editQuestion,
  renameChoices,
  resolveReport,
  resolveReportsForQuestion,
  setAnswerByAdmin,
  setQuarantineFixture,
  setQuarantineStatus,
  setQuestionDisputed,
  setQuestionHidden,
} from '../../../lib/mutations.ts';
import { getDb, getIngest, getStore, UPLOADS_UNAVAILABLE } from '../../../lib/services.ts';

/**
 * Admin actions. POST only, form-encoded, gated by the admin cookie in
 * src/middleware.ts (which also enforces same-origin). Redirects back to /admin.
 */
export const POST: APIRoute = async (ctx) => {
  const db = getDb();
  const action = ctx.params.action ?? '';
  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };
  const toAdmin = (section: string, msg: string, error = false) =>
    ctx.redirect(`/admin?${error ? 'error' : 'msg'}=${encodeURIComponent(msg)}#${section}`, 303);
  if (action === 'duplicates-merge') {
    const ingest = await getIngest();
    if (!ingest) return toAdmin('duplicates', UPLOADS_UNAVAILABLE, true);
    const keepId = Number(str('keep'));
    const dropId = Number(str('drop'));
    // "all" merges every pair the finder currently lists; otherwise just the one named.
    const pairs = str('all') === '1' ? await ingest.listDuplicates() : [{ keepId, dropId }];
    let done = 0;
    for (const p of pairs) if (await ingest.mergeDuplicate(p.keepId, p.dropId)) done++;
    return toAdmin('duplicates', done ? `Merged ${done} ${done === 1 ? 'duplicate' : 'duplicates'}.` : 'Nothing to merge.', done === 0);
  }
  if (action === 'questions-delete') {
    const ids = [...new Set(form.getAll('ids').map((v) => Number(v)))].filter((n) => Number.isSafeInteger(n) && n > 0);
    if (ids.length === 0) return toAdmin('questions', 'Nothing selected.', true);
    for (const qid of ids) deleteQuestion(db, qid);
    return toAdmin('questions', `Deleted ${ids.length} ${ids.length === 1 ? 'question' : 'questions'}.`);
  }
  const id = Number(str('id'));
  const back = (section: string, msg: string, error = false) =>
    ctx.redirect(`/admin?${error ? 'error' : 'msg'}=${encodeURIComponent(msg)}#${section}`, 303);
  if (!Number.isSafeInteger(id) || id <= 0) return back('top', 'Missing id.', true);
  const review = (msg: string, error = false) =>
    ctx.redirect(`/admin/review/${id}?${error ? 'error' : 'msg'}=${encodeURIComponent(msg)}`, 303);

  switch (action) {
    case 'report-resolve':
      resolveReport(db, id);
      return back('reports', `Report #${id} resolved.`);
    case 'review-set-answer': {
      const res = setAnswerByAdmin(db, id, Number(str('answerIndex')), { unhide: str('unhide') === '1' });
      return res.ok ? review(`Answer set to ${res.label}. Reports closed.`) : review(res.error, true);
    }
    case 'question-rename-choices': {
      const res = renameChoices(db, id, form.getAll('name').map((v) => String(v)));
      return res.ok ? review('Picture names saved.') : review(res.error, true);
    }
    case 'question-relabel': {
      const ingest = await getIngest();
      if (!ingest) return review(UPLOADS_UNAVAILABLE, true);
      try {
        return (await ingest.relabelPictures(id)) ? review('Picture names refreshed.') : review('Nothing to refresh for this question.', true);
      } catch (err) {
        console.error('[admin] relabel failed', err);
        return review('Could not re-read the screenshot. Try again.', true);
      }
    }
    case 'review-dismiss':
      resolveReportsForQuestion(db, id);
      // Keeping the answer is a ruling that it is right.
      setQuestionDisputed(db, id, false);
      return review('Reports closed. Answer unchanged.');
    case 'review-hide':
      setQuestionHidden(db, id, str('value') !== '0');
      return review(str('value') !== '0' ? 'Question hidden.' : 'Question visible.');
    case 'question-hide':
      setQuestionHidden(db, id, true);
      return back(str('section') || 'questions', `Question #${id} hidden.`);
    case 'question-unhide':
      setQuestionHidden(db, id, false);
      return back(str('section') || 'questions', `Question #${id} is visible again.`);
    case 'question-undispute':
      setQuestionDisputed(db, id, false);
      return back('questions', `Question #${id} is no longer marked disputed.`);
    case 'question-delete':
      deleteQuestion(db, id);
      return back('questions', `Question #${id} deleted.`);
    case 'question-edit': {
      const answerIndex = Number(str('answerIndex'));
      const res = editQuestion(db, id, {
        questionText: str('questionText').replace(/\r\n/g, '\n').trim() || undefined,
        lang: str('lang').trim() || undefined,
        level: str('level').trim() || null,
        // No answer field (the review screen's text form) leaves the answer alone.
        answerIndex: str('answerIndex') !== '' && Number.isInteger(answerIndex) ? answerIndex : undefined,
      });
      return res.ok ? back('questions', `Question #${id} updated.`) : back('questions', res.error, true);
    }
    case 'quarantine-dismiss':
      setQuarantineStatus(db, id, 'dismissed');
      return back('quarantine', `Upload #${id} dismissed.`);
    case 'quarantine-fixture': {
      const on = str('value') !== '0';
      setQuarantineFixture(db, id, on);
      return back('quarantine', on ? `Upload #${id} flagged as a fixture.` : `Fixture flag removed from #${id}.`);
    }
    case 'quarantine-delete': {
      const key = deleteQuarantine(db, id);
      if (key) {
        try {
          await (await getStore()).delete('private', key);
        } catch (err) {
          console.error('[admin] could not delete quarantine blob', err);
        }
      }
      return back('quarantine', `Upload #${id} deleted.`);
    }
    case 'quarantine-promote': {
      if (!getQuarantine(db, id)) return back('quarantine', 'That upload no longer exists.', true);
      const choiceLabels = str('choiceLabels')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const parsed = ManualInput.safeParse({
        lang: str('lang').trim(),
        level: str('level').trim() || null,
        questionText: str('questionText').replace(/\r\n/g, '\n').trim(),
        choiceLabels,
        answerIndex: Number(str('answerNumber')) - 1,
      });
      if (!parsed.success || parsed.data.answerIndex >= choiceLabels.length) {
        return back('quarantine', `Could not promote #${id}: check the text, choices and answer number.`, true);
      }
      const ingest = await getIngest();
      if (!ingest) return back('quarantine', UPLOADS_UNAVAILABLE, true);
      try {
        const res = await ingest.promoteQuarantined(id, parsed.data, { ipHash: ipHashOf(ctx) });
        return back('quarantine', `Upload #${id} published as question #${res.questionId}${res.merged ? ' (merged)' : ''}.`);
      } catch (err) {
        if (err instanceof Error && err.name === 'IngestError') return back('quarantine', `Could not promote #${id}: ${err.message}`, true);
        console.error('[admin] promote failed', err);
        return back('quarantine', `Could not promote #${id}.`, true);
      }
    }
    default:
      return new Response('Not found', { status: 404 });
  }
};
