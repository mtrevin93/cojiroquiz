/**
 * Step 2 of importing the game's own question list: load a prepared bundle
 * (source-prepare.ts) into a database. Pure database work, no image processing,
 * so it can run inside the web server. Running it again updates in place.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type Db, type QuestionRow, getQuestion, insertQuestion, listAllQuestions, updateQuestion } from '@cojiro/db';
import { type StoredChoice, buildSearchText, canonical, langKey } from '@cojiro/shared';
import { hamming } from './image.ts';
import { computeDedupeKey, slugify } from './ingest.ts';
import type { Bundle, BundleQuestion } from './source-prepare.ts';

export interface ApplyReport {
  inserted: number;
  /** Existing questions (from uploads) now tied to their source question. */
  linked: number;
  /** Questions from an earlier import, refreshed. */
  refreshed: number;
  /** An upload-based question that looks like a source question but has a different answer. Both are kept. */
  conflicts: Array<{ questionId: number; slug: string; sourceId: string }>;
  /** Upload-based questions with no source question. Left as they are. */
  unmatched: Array<{ id: number; slug: string }>;
}

/** A screenshot crop of the same picture as a clean source picture: hashes this close. */
const SAME_PICTURE = 10;
/** A rough crop of the same picture; only trusted together with the same answer. */
const LOOSE_PICTURE = 24;
/** Picture choices: average distance per choice over the best pairing. */
const SAME_CHOICE_SET = 20;
/** How many more bits (in total) an answer-keeping pairing may differ by and still win. */
const LOOKALIKE_SLACK = 16;

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const dist = (a: string | null | undefined, b: string | null | undefined) => (a && b ? hamming(a, b) : 64);

function* permutations(n: number, k: number, used: boolean[] = [], acc: number[] = []): Generator<number[]> {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = true;
    acc.push(i);
    yield* permutations(n, k, used, acc);
    acc.pop();
    used[i] = false;
  }
}

interface SiteMatch {
  row: QuestionRow;
  agrees: boolean;
  /** For picture choices: index of the source choice each stored choice pairs with. */
  pairs: number[] | null;
  score: number;
}

/** How well an upload-based question `row` fits source question `q`, or null when it is a different question. */
function fit(row: QuestionRow, q: BundleQuestion, bundle: Bundle): SiteMatch | null {
  const srcPicture = q.picture ? (bundle.images[q.picture]?.phash ?? null) : null;
  if ((row.picturePhash == null) !== (q.picture == null)) return null;
  const pictureDist = row.picturePhash ? dist(row.picturePhash, srcPicture) : 0;
  if (pictureDist > LOOSE_PICTURE) return null;

  const rowPictures = row.choices.every((c) => c.kind === 'image');
  const srcPictures = q.choices.every((c) => c.kind === 'image');
  if (rowPictures !== srcPictures || row.choices.length > q.choices.length) return null;

  if (rowPictures) {
    const src = q.choices.map((c) => bundle.images[c.image!]?.phash ?? null);
    // Lookalike pictures (two ocarinas, two swords) can pair either way round, so a pairing
    // that keeps the stored answer wins when it is nearly as close as the closest one.
    let best: { total: number; perm: number[] } | null = null;
    let agreeing: { total: number; perm: number[] } | null = null;
    for (const perm of permutations(src.length, row.choices.length)) {
      const total = perm.reduce((sum, j, i) => sum + dist(row.choices[i]!.phash, src[j]), 0);
      if (!best || total < best.total) best = { total, perm };
      if (perm[row.answerIndex] === q.answerIndex && (!agreeing || total < agreeing.total)) agreeing = { total, perm };
    }
    if (!best || pictureDist > SAME_PICTURE) return null;
    const n = row.choices.length;
    const pick = agreeing && agreeing.total / n <= SAME_CHOICE_SET && agreeing.total - best.total <= LOOKALIKE_SLACK ? agreeing : best;
    if (pick.total / n > SAME_CHOICE_SET) return null;
    return { row, agrees: pick === agreeing, pairs: pick.perm, score: pictureDist + pick.total / n };
  }

  const srcLabels = q.choices.map((c) => canonical(c.label));
  const rowLabels = row.choices.map((c) => canonical(c.label));
  const sameAnswer = rowLabels[row.answerIndex] === srcLabels[q.answerIndex];
  const subset = rowLabels.every((l) => srcLabels.includes(l));
  if (sameAnswer) {
    // Same wording, (roughly) same picture, same answer: the game's one question, whatever the wrong choices.
    return { row, agrees: true, pairs: null, score: pictureDist };
  }
  // A different answer only counts as the same question when everything else is identical.
  if (subset && pictureDist <= SAME_PICTURE) return { row, agrees: false, pairs: null, score: pictureDist };
  return null;
}

type Names = Map<string, { label: string; description: string | null }>;

function storedChoices(q: BundleQuestion, bundle: Bundle, match: SiteMatch | null, names: Names): StoredChoice[] {
  return q.choices.map((c, j) => {
    const image = c.image ? bundle.images[c.image] : undefined;
    // Keep the names people already see for a picture choice; the same picture gets the same name everywhere.
    const old = (match?.pairs ? match.row.choices[match.pairs.indexOf(j)] : undefined) ?? (image ? names.get(image.key) : undefined);
    return {
      // The game's own name for a picture beats one written from a screenshot.
      label: c.label || old?.label || '',
      kind: c.kind,
      description: old?.description ?? null,
      imageKey: image?.key ?? null,
      phash: image?.phash ?? null,
    };
  });
}

/**
 * Load `bundle` into `db`. Source questions become questions with a locked answer;
 * an upload-based question that is the same question is updated in place (its id,
 * address and uploads stay) and gets the clean source pictures.
 */
export function applyBundle(db: Db, bundle: Bundle, now: number = Date.now()): ApplyReport {
  const report: ApplyReport = { inserted: 0, linked: 0, refreshed: 0, conflicts: [], unmatched: [] };
  db.transaction((tx) => {
    const rows = listAllQuestions(tx);
    const bySource = new Map<string, QuestionRow>();
    const free = new Map<string, QuestionRow[]>();
    for (const row of rows) {
      if (row.sourceIds?.length) {
        for (const id of row.sourceIds) bySource.set(id, row);
      } else {
        const key = `${langKey(row.lang)}\u001f${canonical(row.questionText)}`;
        const list = free.get(key);
        if (list) list.push(row);
        else free.set(key, [row]);
      }
    }
    const claimed = new Set<number>();

    // First pass: pair source questions with upload-based ones, and collect the names
    // those uploads gave to pictures.
    const names: Names = new Map();
    for (const row of rows) {
      if (!row.sourceIds?.length) continue;
      for (const c of row.choices) if (c.imageKey && c.label) names.set(c.imageKey, { label: c.label, description: c.description });
    }
    const matches = new Map<BundleQuestion, SiteMatch>();
    for (const q of bundle.questions) {
      if (q.sourceIds.some((id) => bySource.has(id))) continue;
      const candidates = (free.get(`${langKey(q.lang)}\u001f${canonical(q.questionText)}`) ?? [])
        .filter((row) => !claimed.has(row.id))
        .map((row) => fit(row, q, bundle))
        .filter((m): m is SiteMatch => m !== null)
        .sort((a, b) => Number(b.agrees) - Number(a.agrees) || a.score - b.score);
      const match = candidates[0];
      if (!match) continue;
      if (!match.agrees) {
        report.conflicts.push({ questionId: match.row.id, slug: match.row.slug, sourceId: q.sourceIds[0]! });
        continue;
      }
      claimed.add(match.row.id);
      matches.set(q, match);
      match.pairs?.forEach((j, i) => {
        const key = q.choices[j]?.image ? bundle.images[q.choices[j]!.image!]?.key : undefined;
        const old = match.row.choices[i];
        if (key && old?.label && !names.has(key)) names.set(key, { label: old.label, description: old.description });
      });
    }

    for (const q of bundle.questions) {
      const known = q.sourceIds.map((id) => bySource.get(id)).find(Boolean);
      const match = matches.get(q) ?? null;

      const choices = storedChoices(q, bundle, match, names);
      const picture = q.picture ? bundle.images[q.picture] : undefined;
      const textKey = computeDedupeKey(q.lang, q.questionText, choices);
      const target = known ?? match?.row;
      if (target) {
        const kept = known ? target.choices : null;
        // On a refresh keep any picture names an admin has since changed.
        const merged = kept
          ? choices.map((c) => {
              const prev = c.imageKey ? kept.find((k) => k.imageKey === c.imageKey) : undefined;
              return prev ? { ...c, label: prev.label, description: prev.description } : c;
            })
          : choices;
        updateQuestion(tx, target.id, {
          choices: merged,
          answerIndex: q.answerIndex,
          answerLocked: true,
          disputed: false,
          pictureKey: picture?.key ?? null,
          picturePhash: picture?.phash ?? null,
          textKey,
          searchText: buildSearchText([
            target.questionText,
            ...merged.map((c) => c.label),
            ...merged.map((c) => c.description),
            target.pictureDescription,
          ]),
          sourceIds: q.sourceIds,
          level: target.level ?? q.level,
          updatedAt: now,
        });
        if (known) report.refreshed++;
        else report.linked++;
        continue;
      }

      const inserted = insertQuestion(tx, {
        slug: `tmp-${randomUUID()}`,
        lang: q.lang,
        level: q.level,
        questionText: q.questionText,
        searchText: buildSearchText([q.questionText, ...choices.map((c) => c.label), ...choices.map((c) => c.description)]),
        dedupeKey: sha256Hex(`source:${q.sourceIds[0]}`),
        textKey,
        pictureKey: picture?.key ?? null,
        picturePhash: picture?.phash ?? null,
        pictureDescription: null,
        choices,
        answerIndex: q.answerIndex,
        answerSource: 'manual',
        questionImageId: null,
        answerImageId: null,
        submissionCount: 0,
        answerLocked: true,
        sourceIds: q.sourceIds,
        createdAt: now,
        updatedAt: now,
      });
      const text = slugify(q.questionText);
      updateQuestion(tx, inserted.id, { slug: text ? `${inserted.id}-${text}` : String(inserted.id) });
      report.inserted++;
    }

    for (const row of rows) {
      if (!row.sourceIds?.length && !claimed.has(row.id) && getQuestion(tx, row.id)) report.unmatched.push({ id: row.id, slug: row.slug });
    }
  });
  return report;
}
