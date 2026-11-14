import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ParsedQuiz, StoredChoice } from '@cojiro/shared';

const now = sql`(unixepoch() * 1000)`;

/** Every stored image blob. `bucket` says which bucket `key` lives in. */
export const images = sqliteTable(
  'images',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** sha256 of the ORIGINAL uploaded bytes: identical re-uploads are caught here. */
    sha256: text('sha256').notNull(),
    bucket: text('bucket', { enum: ['public', 'private'] }).notNull(),
    key: text('key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    hasReveal: integer('has_reveal', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('images_sha256_uq').on(t.sha256)],
);

export const questions = sqliteTable(
  'questions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    lang: text('lang').notNull(),
    level: text('level'),
    /** Verbatim text as shown in the game. Never normalized or translated. */
    questionText: text('question_text').notNull(),
    searchText: text('search_text').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    choices: text('choices_json', { mode: 'json' }).$type<StoredChoice[]>().notNull(),
    answerIndex: integer('answer_index').notNull(),
    answerSource: text('answer_source', { enum: ['reveal', 'manual'] }).notNull(),
    questionImageId: integer('question_image_id').references(() => images.id),
    answerImageId: integer('answer_image_id').references(() => images.id),
    submissionCount: integer('submission_count').notNull().default(1),
    disputed: integer('disputed', { mode: 'boolean' }).notNull().default(false),
    /** Set when the admin has chosen the answer by hand; later uploads no longer change it. */
    answerLocked: integer('answer_locked', { mode: 'boolean' }).notNull().default(false),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('questions_slug_uq').on(t.slug),
    uniqueIndex('questions_dedupe_uq').on(t.dedupeKey),
    index('questions_lang_idx').on(t.lang),
    index('questions_level_idx').on(t.level),
  ],
);

/** One row per confirmed upload; the vote record behind each question's answer. */
export const submissions = sqliteTable(
  'submissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    imageId: integer('image_id').references(() => images.id),
    parsed: text('parsed_json', { mode: 'json' }).$type<ParsedQuiz | null>(),
    /** Canonical text of the choice this submission says is correct. */
    answerCanonical: text('answer_canonical').notNull(),
    answerSource: text('answer_source', { enum: ['reveal', 'manual'] }).notNull(),
    ipHash: text('ip_hash').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('submissions_question_idx').on(t.questionId)],
);

/** Parsed uploads awaiting the uploader's confirmation. Purged after 24h. */
export const drafts = sqliteTable('drafts', {
  id: text('id').primaryKey(),
  imageId: integer('image_id')
    .notNull()
    .references(() => images.id),
  parsed: text('parsed_json', { mode: 'json' }).$type<ParsedQuiz>().notNull(),
  ipHash: text('ip_hash').notNull(),
  createdAt: integer('created_at').notNull().default(now),
});

/** Uploads the parser could not fit. Private; reviewed in admin. */
export const quarantine = sqliteTable(
  'quarantine',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sha256: text('sha256').notNull(),
    /** Key in the private bucket. */
    key: text('key').notNull(),
    reason: text('reason').notNull(),
    parsed: text('parsed_json', { mode: 'json' }).$type<unknown>(),
    ipHash: text('ip_hash').notNull(),
    status: text('status', { enum: ['new', 'promoted', 'dismissed'] }).notNull().default('new'),
    /** Admin flagged this as a new question type to teach the parser. */
    fixture: integer('fixture', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [index('quarantine_status_idx').on(t.status), index('quarantine_sha_idx').on(t.sha256)],
);

export const reports = sqliteTable(
  'reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    questionId: integer('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    reason: text('reason', { enum: ['wrong_answer', 'not_a_question', 'duplicate', 'inappropriate'] }).notNull(),
    note: text('note'),
    ipHash: text('ip_hash').notNull(),
    resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('reports_question_idx').on(t.questionId)],
);

export const feedback = sqliteTable('feedback', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  message: text('message').notNull(),
  contact: text('contact'),
  ipHash: text('ip_hash').notNull(),
  emailed: integer('emailed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().default(now),
});

/** Sliding-window counters for rate limits and the daily parse cap. */
export const rateEvents = sqliteTable(
  'rate_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** e.g. "upload", "report", "feedback", "parse" */
    kind: text('kind').notNull(),
    ipHash: text('ip_hash').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('rate_kind_ip_idx').on(t.kind, t.ipHash, t.createdAt)],
);
