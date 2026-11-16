import { z } from 'zod';

/** What kind of thing a choice box contains. */
export const ChoiceKind = z.enum(['text', 'symbol', 'image']);
export type ChoiceKind = z.infer<typeof ChoiceKind>;

/** Raw structured output of the vision parser for one screenshot. */
export const ParsedQuiz = z.object({
  isQuizScreenshot: z.boolean(),
  /** Why it is not usable, when isQuizScreenshot is false or the layout is unknown. */
  rejectReason: z.string().nullable(),
  /** BCP-47 tag of the quiz text itself, e.g. "en", "ja", "pt-BR". */
  lang: z.string(),
  /** Level label exactly as displayed, e.g. "Egg Level". */
  level: z.string().nullable(),
  questionNumber: z.number().int().nullable(),
  /** Exact question text, line breaks preserved, no translation. */
  questionText: z.string(),
  /** A picture shown as part of the question (e.g. above "Where is this?"), or null. */
  questionImage: z
    .object({
      box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      /** Plain description of what the picture shows, in the quiz's language. */
      description: z.string(),
    })
    .nullable(),
  choices: z.array(
    z.object({
      /** Exact text for text choices; "X" / "✓" for symbols; short name for images. */
      label: z.string(),
      kind: ChoiceKind,
      /** Plain description of an image choice, in the screenshot's language. */
      description: z.string().nullable(),
      /** Choice box as fractions of image width/height (0..1), for cropping. */
      box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
    }),
  ),
  reveal: z.object({
    /** True when the game is showing the result (pink = wrong, gold = correct). */
    present: z.boolean(),
    /** Index of the choice the game marks correct (gold). */
    correctIndex: z.number().int().nullable(),
    /** Index of the choice the player picked (white border). */
    selectedIndex: z.number().int().nullable(),
  }),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type ParsedQuiz = z.infer<typeof ParsedQuiz>;

/** A choice as stored on a question (questions.choices_json). */
export const StoredChoice = z.object({
  label: z.string(),
  kind: ChoiceKind,
  description: z.string().nullable(),
  /** Key in the public bucket of the cropped choice image, for image choices. */
  imageKey: z.string().nullable(),
  /** Perceptual hash of that image; picture choices are matched by look, not by description. */
  phash: z.string().nullable().optional(),
});
export type StoredChoice = z.infer<typeof StoredChoice>;

export type AnswerSource = 'reveal' | 'manual';

/** Public shape of a question, used by pages and the search island. */
export interface QuestionDTO {
  id: number;
  slug: string;
  lang: string;
  level: string | null;
  questionText: string;
  choices: Array<StoredChoice & { imageUrl: string | null }>;
  answerIndex: number;
  answerSource: AnswerSource;
  /** The picture that is part of the question itself (public URL), if it has one. */
  pictureUrl: string | null;
  pictureDescription: string | null;
  /** Screenshot of the question (public URL), if any. */
  questionImageUrl: string | null;
  /** Reveal screenshot showing the correct answer (public URL), if any. */
  answerImageUrl: string | null;
  submissionCount: number;
  disputed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Compact row shipped to the browser for instant filtering. */
export interface SearchIndexEntry {
  id: number;
  slug: string;
  lang: string;
  level: string | null;
  questionText: string;
  /** The picture that is part of the question itself, if it has one. */
  pictureUrl: string | null;
  /** When the choices are pictures: every choice's picture, with the correct one flagged. */
  choicePictures: Array<{ url: string; label: string; correct: boolean }>;
  /** Every choice in the order shown, with the correct one flagged. */
  options: Array<{ label: string; correct: boolean }>;
  searchText: string;
  answerLabel: string;
  answerImageUrl: string | null;
  answerChoiceImageUrl: string | null;
  disputed: boolean;
}

/* ---------- upload flow contract (apps/web <-> packages/ingest) ---------- */

export interface RequestMeta {
  /** Salted hash of the client IP; never the raw IP. */
  ipHash: string;
}

/** What the review step shows after a screenshot is parsed. */
export interface DraftDTO {
  draftId: string;
  lang: string;
  level: string | null;
  questionText: string;
  /** The picture that is part of the question, cropped from the screenshot. */
  pictureUrl: string | null;
  choices: Array<{ label: string; kind: ChoiceKind; description: string | null; previewUrl: string | null }>;
  /** Answer read from a reveal screenshot; null means the uploader must pick. */
  detectedAnswerIndex: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** Existing question this would merge into, if any. */
  duplicateOf: { id: number; slug: string; answerLabel: string } | null;
}

export type UploadResult =
  | { status: 'draft'; draft: DraftDTO }
  | { status: 'duplicate_file'; question: { id: number; slug: string } }
  | { status: 'quarantined'; reason: string }
  | { status: 'rate_limited' | 'cap_reached' | 'invalid_file' | 'parser_unavailable'; message: string };

/** Uploader's confirmation of a draft (text fields are optional corrections). */
export const ConfirmInput = z.object({
  answerIndex: z.number().int().min(0),
  questionText: z.string().min(1).max(2000).optional(),
  lang: z.string().min(2).max(16).optional(),
  level: z.string().max(100).nullable().optional(),
  choiceLabels: z.array(z.string().max(300)).optional(),
});
export type ConfirmInput = z.infer<typeof ConfirmInput>;

/** "Type it in" upload with no screenshot. */
export const ManualInput = z.object({
  lang: z.string().min(2).max(16),
  level: z.string().max(100).nullable(),
  questionText: z.string().min(1).max(2000),
  choiceLabels: z.array(z.string().min(1).max(300)).min(2).max(8),
  answerIndex: z.number().int().min(0),
});
export type ManualInput = z.infer<typeof ManualInput>;

export interface ConfirmResult {
  questionId: number;
  slug: string;
  /** True when this merged into an existing question instead of creating one. */
  merged: boolean;
  disputed: boolean;
}

/** The ingest service the web app calls. Implemented in @cojiro/ingest. */
export interface IngestService {
  processUpload(file: { bytes: Uint8Array; mimeType: string }, meta: RequestMeta): Promise<UploadResult>;
  confirmDraft(draftId: string, input: ConfirmInput, meta: RequestMeta): Promise<ConfirmResult>;
  submitManual(input: ManualInput, meta: RequestMeta): Promise<ConfirmResult>;
  /** Admin: re-read a question's screenshot and refresh the names of its pictures. Returns false if nothing could be changed. */
  relabelPictures(questionId: number): Promise<boolean>;
  /** Admin: pairs of questions that count as the same one (same wording, same picture, same answer or same choices). */
  listDuplicates(): Promise<Array<{ keepId: number; dropId: number }>>;
  /** Admin: fold `dropId` into `keepId` (uploads and reports move over). False if they no longer match. */
  mergeDuplicate(keepId: number, dropId: number): Promise<boolean>;
  /** Admin: publish a quarantined upload by hand. */
  promoteQuarantined(quarantineId: number, input: ManualInput, meta: RequestMeta): Promise<ConfirmResult>;
}

/* ---------- blob storage contract (implemented in @cojiro/storage) ---------- */

export type Bucket = 'public' | 'private';

export interface BlobStore {
  put(bucket: Bucket, key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(bucket: Bucket, key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  delete(bucket: Bucket, key: string): Promise<void>;
  /** Stable public URL for a key in the public bucket. */
  publicUrl(key: string): string;
  /** Short-lived URL for a key in the private bucket (admin only). */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

export const REPORT_REASONS = ['wrong_answer', 'not_a_question', 'duplicate', 'inappropriate'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
