import { createHash, randomUUID } from 'node:crypto';
import {
  type Db,
  type QuestionRow,
  type Tx,
  countRateEvents,
  deleteDraft,
  findImageBySha,
  findQuarantineBySha,
  findQuestionByDedupeKey,
  findQuestionForImage,
  getDraft,
  getImage,
  getQuarantineRow,
  insertDraft,
  insertImage,
  insertQuarantine,
  insertQuestion,
  insertSubmission,
  listSubmissionVotes,
  purgeDraftsOlderThan,
  recordRateEvent,
  setQuarantineStatus,
  takeRateToken,
  updateImage,
  updateQuestion,
} from '@cojiro/db';
import {
  type AnswerSource,
  type BlobStore,
  type ConfirmResult,
  type DraftDTO,
  type IngestService,
  type RequestMeta,
  type StoredChoice,
  type UploadResult,
  ConfirmInput,
  ManualInput,
  ParsedQuiz,
  buildSearchText,
  canonical,
  dedupeMaterial,
  joinSpacedLetters,
} from '@cojiro/shared';
import { checkImage, cropBox, imageSize, processScreenshot } from './image.ts';
import type { QuizParser } from './parser.ts';

export interface IngestConfig {
  /** Uploads (and manual submissions) allowed per ipHash per hour. Default 20. */
  uploadsPerHour?: number;
  /** Parser calls allowed per rolling 24h across everyone. Default 500. */
  dailyParseCap?: number;
  /** Default 8 MB. */
  maxUploadBytes?: number;
  /** Long edge cap of stored screenshots, px. Default 1600. */
  maxImageEdge?: number;
  /** Drafts older than this are purged. Default 24h. */
  draftTtlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export type IngestErrorCode =
  | 'draft_not_found'
  | 'quarantine_not_found'
  | 'invalid_input'
  | 'invalid_answer'
  | 'rate_limited';

/** Thrown by confirmDraft / submitManual / promoteQuarantined for caller-fixable problems (map to 4xx). */
export class IngestError extends Error {
  readonly code: IngestErrorCode;
  constructor(code: IngestErrorCode, message: string) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }
}

const HOUR = 60 * 60 * 1000;
const REVEAL_WEIGHT = 3;
const MANUAL_WEIGHT = 1;

const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/** The text a choice is identified by: its label, or for picture choices its description. */
export function choiceText(c: { label: string; kind: string; description?: string | null }): string {
  return c.kind === 'image' ? c.description || c.label : c.label;
}

export function computeDedupeKey(
  lang: string,
  questionText: string,
  choices: Array<{ label: string; kind: string; description?: string | null }>,
): string {
  return sha256Hex(dedupeMaterial(lang, questionText, choices.map(choiceText)));
}

/** ASCII URL slug; text in non-Latin scripts yields "" (the slug is then just the id). */
export function slugify(text: string, maxLength = 60): string {
  const ascii = joinSpacedLetters(text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase())
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= maxLength) return ascii;
  const cut = ascii.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/**
 * What the uploader is told. Parser/API failure details (which can include
 * provider error text) stay in the quarantine row for the admin only.
 */
function publicReason(reason: string): string {
  return reason.startsWith('parse_error') || reason.startsWith('schema_invalid') ? 'unreadable' : reason;
}

const validIndex = (i: number | null | undefined, length: number): i is number =>
  typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < length;

/** The answer the game itself shows in this parse, or null. */
function detectedAnswer(parsed: ParsedQuiz): number | null {
  return parsed.reveal.present && validIndex(parsed.reveal.correctIndex, parsed.choices.length)
    ? parsed.reveal.correctIndex
    : null;
}

/** Everything needed to insert a question or merge a vote into an existing one. */
interface Candidate {
  lang: string;
  level: string | null;
  questionText: string;
  choices: StoredChoice[];
  answerIndex: number;
  answerSource: AnswerSource;
  imageId: number | null;
  parsed: ParsedQuiz | null;
  ipHash: string;
}

/**
 * Recompute a question's derived answer fields from all of its submissions.
 * Votes are matched by the canonical text of the chosen choice (never position).
 * Reveal-sourced votes weigh 3, manual votes 1; one visitor counts once per answer.
 */
function recount(tx: Tx, q: QuestionRow, now: number): boolean {
  const votes = listSubmissionVotes(tx, q.id);
  const perVoter = new Map<string, { canon: string; weight: number }>();
  for (const v of votes) {
    const weight = v.answerSource === 'reveal' ? REVEAL_WEIGHT : MANUAL_WEIGHT;
    const key = `${v.ipHash}\u001f${v.answerCanonical}`;
    const prev = perVoter.get(key);
    if (!prev || prev.weight < weight) perVoter.set(key, { canon: v.answerCanonical, weight });
  }
  const totals = new Map<string, number>();
  for (const { canon, weight } of perVoter.values()) totals.set(canon, (totals.get(canon) ?? 0) + weight);

  const canonAt = (i: number) => {
    const c = q.choices[i];
    return c ? canonical(choiceText(c)) : null;
  };
  const current = canonAt(q.answerIndex);
  let winner: string | null = null;
  let best = -1;
  for (const [canon, weight] of totals) {
    // Ties keep the current answer, otherwise the earliest-seen one.
    if (weight > best || (weight === best && canon === current)) {
      winner = canon;
      best = weight;
    }
  }
  let answerIndex = q.choices.findIndex((c) => canonical(choiceText(c)) === winner);
  // An answer the admin set by hand is final: uploads still count as confirmations
  // but can no longer change it.
  if (answerIndex < 0 || q.answerLocked) {
    answerIndex = q.answerIndex;
    winner = current;
  }

  const revealVotes = votes.filter((v) => v.answerSource === 'reveal' && v.answerCanonical === winner);
  const answerImageKept = q.answerImageId != null && revealVotes.some((v) => v.imageId === q.answerImageId);
  const disputed = q.answerLocked ? q.disputed : q.disputed || totals.size > 1;
  updateQuestion(tx, q.id, {
    answerIndex,
    answerSource: revealVotes.length > 0 ? 'reveal' : 'manual',
    // Only ever a reveal screenshot that shows the resolved answer.
    answerImageId: answerImageKept ? q.answerImageId : (revealVotes.find((v) => v.imageId != null)?.imageId ?? null),
    questionImageId: q.questionImageId ?? votes.find((v) => v.imageId != null)?.imageId ?? null,
    submissionCount: votes.length,
    disputed,
    updatedAt: now,
  });
  return disputed;
}

/** Insert a new question or merge into the one with the same dedupe key. Must run inside a transaction. */
function insertOrMerge(tx: Tx, c: Candidate, now: number): ConfirmResult {
  const chosen = c.choices[c.answerIndex];
  if (!chosen) throw new IngestError('invalid_answer', 'answerIndex does not match any choice.');
  const answerCanonical = canonical(choiceText(chosen));
  const dedupeKey = computeDedupeKey(c.lang, c.questionText, c.choices);

  let question = findQuestionByDedupeKey(tx, dedupeKey);
  const merged = question !== undefined;
  if (!question) {
    const inserted = insertQuestion(tx, {
      slug: `tmp-${randomUUID()}`,
      lang: c.lang,
      level: c.level,
      questionText: c.questionText,
      searchText: buildSearchText([
        c.questionText,
        c.level,
        ...c.choices.map((x) => x.label),
        ...c.choices.map((x) => x.description),
      ]),
      dedupeKey,
      choices: c.choices,
      answerIndex: c.answerIndex,
      answerSource: c.answerSource,
      questionImageId: c.imageId,
      answerImageId: null,
      createdAt: now,
      updatedAt: now,
    });
    const text = slugify(c.questionText);
    const slug = text ? `${inserted.id}-${text}` : String(inserted.id);
    updateQuestion(tx, inserted.id, { slug });
    question = { ...inserted, slug };
  } else if (question.level == null && c.level) {
    updateQuestion(tx, question.id, { level: c.level });
  }

  insertSubmission(tx, {
    questionId: question.id,
    imageId: c.imageId,
    parsed: c.parsed,
    answerCanonical,
    answerSource: c.answerSource,
    ipHash: c.ipHash,
    createdAt: now,
  });
  const disputed = recount(tx, question, now);
  return { questionId: question.id, slug: question.slug, merged, disputed };
}

const cleanLang = (lang: string) => lang.trim() || 'und';
const cleanLevel = (level: string | null | undefined) => level?.trim() || null;

function manualCandidate(input: ManualInput, meta: RequestMeta, imageId: number | null): Candidate {
  const parsed = ManualInput.safeParse(input);
  if (!parsed.success) throw new IngestError('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input.');
  const v = parsed.data;
  const labels = v.choiceLabels.map((l) => l.trim());
  if (labels.some((l) => !l)) throw new IngestError('invalid_input', 'Choices cannot be empty.');
  if (!v.questionText.trim()) throw new IngestError('invalid_input', 'Question text cannot be empty.');
  if (v.answerIndex >= labels.length) throw new IngestError('invalid_answer', 'answerIndex does not match any choice.');
  return {
    lang: cleanLang(v.lang),
    level: cleanLevel(v.level),
    questionText: v.questionText.trim(),
    choices: labels.map((label) => ({ label, kind: 'text', description: null, imageKey: null })),
    answerIndex: v.answerIndex,
    answerSource: 'manual',
    imageId,
    parsed: null,
    ipHash: meta.ipHash,
  };
}

export interface IngestDeps {
  db: Db;
  store: BlobStore;
  parser: QuizParser;
  config?: IngestConfig;
}

export function createIngest({ db, store, parser, config = {} }: IngestDeps): IngestService {
  const uploadsPerHour = config.uploadsPerHour ?? 20;
  const dailyParseCap = config.dailyParseCap ?? 500;
  const maxUploadBytes = config.maxUploadBytes ?? 8 * 1024 * 1024;
  const maxImageEdge = config.maxImageEdge ?? 1600;
  const draftTtlMs = config.draftTtlMs ?? 24 * HOUR;
  const now = config.now ?? (() => Date.now());

  async function quarantineUpload(
    sha: string,
    image: Uint8Array,
    reason: string,
    raw: unknown,
    meta: RequestMeta,
  ): Promise<UploadResult> {
    const key = `quarantine/${sha}.webp`;
    await store.put('private', key, image, 'image/webp');
    insertQuarantine(db, { sha256: sha, key, reason, parsed: raw ?? null, ipHash: meta.ipHash, createdAt: now() });
    return { status: 'quarantined', reason: publicReason(reason) };
  }

  function toDraftDTO(draftId: string, parsed: ParsedQuiz): DraftDTO {
    const existing = findQuestionByDedupeKey(db, computeDedupeKey(parsed.lang, parsed.questionText, parsed.choices));
    return {
      draftId,
      lang: parsed.lang,
      level: parsed.level,
      questionText: parsed.questionText,
      choices: parsed.choices.map((c) => ({
        label: c.label,
        kind: c.kind,
        description: c.description,
        previewUrl: null,
      })),
      detectedAnswerIndex: detectedAnswer(parsed),
      confidence: parsed.confidence,
      duplicateOf: existing
        ? { id: existing.id, slug: existing.slug, answerLabel: existing.choices[existing.answerIndex]?.label ?? '' }
        : null,
    };
  }

  return {
    async processUpload(file, meta) {
      // 1. validate
      const problem = await checkImage(file.bytes, file.mimeType, maxUploadBytes);
      if (problem) return { status: 'invalid_file', message: problem };

      // 2. per-visitor rate limit
      if (!takeRateToken(db, 'upload', meta.ipHash, uploadsPerHour, HOUR, now())) {
        return { status: 'rate_limited', message: 'Too many uploads. Try again later.' };
      }

      // 3. identical file seen before?
      const sha = sha256Hex(file.bytes);
      const existingImage = findImageBySha(db, sha);
      if (existingImage) {
        const question = findQuestionForImage(db, existingImage.id);
        if (question) return { status: 'duplicate_file', question };
      }
      const quarantined = findQuarantineBySha(db, sha);
      if (quarantined) return { status: 'quarantined', reason: publicReason(quarantined.reason) };

      // 4. global parse budget
      if (countRateEvents(db, 'parse', null, now() - 24 * HOUR) >= dailyParseCap) {
        return { status: 'cap_reached', message: 'Daily limit reached. Try again tomorrow.' };
      }

      // 5. normalize the image
      let image;
      try {
        image = await processScreenshot(file.bytes, maxImageEdge);
      } catch {
        return { status: 'invalid_file', message: 'Not a usable image.' };
      }

      // 6. parse
      recordRateEvent(db, 'parse', meta.ipHash, now());
      let raw: unknown;
      try {
        raw = await parser.parse({ bytes: image.bytes, mimeType: 'image/webp', sourceSha256: sha });
      } catch (err) {
        // The parsing service failed (outage, billing, network). That says nothing about the
        // image, so do not quarantine it: let the uploader retry later.
        console.error('[ingest] parser failed:', err instanceof Error ? err.message : err);
        return {
          status: 'parser_unavailable',
          message: "Can't read screenshots right now. Try again in a few minutes.",
        };
      }

      // 7. anything that does not fit goes to the private quarantine
      const checked = ParsedQuiz.safeParse(raw);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        const where = issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid';
        return quarantineUpload(sha, image.bytes, `schema_invalid: ${where}`.slice(0, 300), raw, meta);
      }
      const parsed = checked.data;
      const reject = !parsed.isQuizScreenshot
        ? `not_quiz: ${parsed.rejectReason?.trim() || 'not a quiz screenshot'}`.slice(0, 300)
        : parsed.questionText.trim() === ''
          ? 'empty_question'
          : parsed.choices.length < 2
            ? 'no_choices'
            : parsed.choices.some((c) => choiceText(c).trim() === '')
              ? 'empty_choice'
              : null;
      if (reject) return quarantineUpload(sha, image.bytes, reject, parsed, meta);

      // 8. publish the screenshot and hand back a draft for review
      const key = `shots/${sha}.webp`;
      await store.put('public', key, image.bytes, 'image/webp');
      const hasReveal = detectedAnswer(parsed) !== null;
      const draftId = randomUUID();
      db.transaction((tx) => {
        const row = findImageBySha(tx, sha);
        const dims = { bucket: 'public' as const, key, width: image.width, height: image.height, hasReveal };
        if (row) updateImage(tx, row.id, dims);
        const imageId = row?.id ?? insertImage(tx, { sha256: sha, ...dims, createdAt: now() }).id;
        insertDraft(tx, { id: draftId, imageId, parsed, ipHash: meta.ipHash, createdAt: now() });
      });
      return { status: 'draft', draft: toDraftDTO(draftId, parsed) };
    },

    async confirmDraft(draftId, input, meta) {
      purgeDraftsOlderThan(db, now() - draftTtlMs);
      const checked = ConfirmInput.safeParse(input);
      if (!checked.success) throw new IngestError('invalid_input', checked.error.issues[0]?.message ?? 'Invalid input.');
      const v = checked.data;
      const draft = getDraft(db, draftId);
      if (!draft) throw new IngestError('draft_not_found', 'This upload has expired or was already confirmed.');
      const parsed = draft.parsed;

      // Apply the uploader's corrections.
      if (v.choiceLabels && v.choiceLabels.length !== parsed.choices.length) {
        throw new IngestError('invalid_input', 'choiceLabels must have one entry per choice.');
      }
      if (v.answerIndex >= parsed.choices.length) {
        throw new IngestError('invalid_answer', 'answerIndex does not match any choice.');
      }
      const questionText = (v.questionText ?? parsed.questionText).trim();
      if (!questionText) throw new IngestError('invalid_input', 'Question text cannot be empty.');
      const choices: StoredChoice[] = parsed.choices.map((c, i) => ({
        label: v.choiceLabels?.[i]?.trim() || c.label,
        kind: c.kind,
        description: c.description,
        imageKey: null,
      }));
      const lang = cleanLang(v.lang ?? parsed.lang);
      const level = cleanLevel(v.level === undefined ? parsed.level : v.level);
      const answerSource: AnswerSource = detectedAnswer(parsed) === v.answerIndex ? 'reveal' : 'manual';

      // Blob work happens before the transaction: crop picture choices for a brand-new question.
      const imageRow = getImage(db, draft.imageId);
      const isNew = !findQuestionByDedupeKey(db, computeDedupeKey(lang, questionText, choices));
      if (isNew && imageRow && parsed.choices.some((c) => c.kind === 'image' && c.box)) {
        const shot = await store.get(imageRow.bucket, imageRow.key);
        if (shot) {
          for (const [i, c] of parsed.choices.entries()) {
            if (c.kind !== 'image' || !c.box) continue;
            const crop = await cropBox(shot.body, c.box);
            if (!crop) continue;
            const key = `choices/${imageRow.sha256}-${i}.webp`;
            try {
              await store.put('public', key, crop, 'image/webp');
              choices[i]!.imageKey = key;
            } catch {
              // leave imageKey null: the page falls back to the full screenshot
            }
          }
        }
      }

      return db.transaction((tx) => {
        // Re-check inside the transaction so a draft can only be confirmed once.
        if (!getDraft(tx, draftId)) {
          throw new IngestError('draft_not_found', 'This upload has expired or was already confirmed.');
        }
        const result = insertOrMerge(
          tx,
          { lang, level, questionText, choices, answerIndex: v.answerIndex, answerSource, imageId: draft.imageId, parsed, ipHash: meta.ipHash },
          now(),
        );
        deleteDraft(tx, draftId);
        return result;
      });
    },

    async submitManual(input, meta) {
      const candidate = manualCandidate(input, meta, null);
      if (!takeRateToken(db, 'upload', meta.ipHash, uploadsPerHour, HOUR, now())) {
        throw new IngestError('rate_limited', 'Too many uploads. Try again later.');
      }
      return db.transaction((tx) => insertOrMerge(tx, candidate, now()));
    },

    async promoteQuarantined(quarantineId, input, meta) {
      const row = getQuarantineRow(db, quarantineId);
      if (!row) throw new IngestError('quarantine_not_found', 'No such quarantined upload.');
      if (row.status === 'promoted') throw new IngestError('invalid_input', 'This upload was already promoted.');
      const candidate = manualCandidate(input, meta, null);

      // Copy the screenshot to the public bucket (the private copy is kept).
      const publicKey = `shots/${row.sha256}.webp`;
      let published: { width: number; height: number } | null = null;
      const blob = await store.get('private', row.key);
      if (blob) {
        published = await imageSize(blob.body);
        if (published) await store.put('public', publicKey, blob.body, 'image/webp');
      }

      return db.transaction((tx) => {
        if (published) {
          const dims = { bucket: 'public' as const, key: publicKey, ...published, hasReveal: false };
          const existing = findImageBySha(tx, row.sha256);
          if (existing) updateImage(tx, existing.id, dims);
          candidate.imageId = existing?.id ?? insertImage(tx, { sha256: row.sha256, ...dims, createdAt: now() }).id;
        }
        const result = insertOrMerge(tx, candidate, now());
        setQuarantineStatus(tx, quarantineId, 'promoted', now());
        return result;
      });
    },
  };
}
