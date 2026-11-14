import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '@cojiro/db';
import type { BlobStore, IngestService } from '@cojiro/shared';
import { createClaudeParser } from './claude-parser.ts';
import { type IngestConfig, createIngest } from './ingest.ts';
import { type QuizParser, FakeParser, createFixtureParser } from './parser.ts';

export * from './ingest.ts';
export * from './parser.ts';
export * from './claude-parser.ts';

type Env = Record<string, string | undefined>;

/**
 * The parser for this environment: Claude when ANTHROPIC_API_KEY is set
 * (model from PARSE_MODEL). Without a key it falls back to recorded fixture
 * responses (FIXTURES_DIR, default <repo>/fixtures), so known fixture
 * screenshots parse and every other upload is quarantined as a parse error.
 */
export function createParserFromEnv(env: Env = process.env): QuizParser {
  if (env.ANTHROPIC_API_KEY) {
    return createClaudeParser({ apiKey: env.ANTHROPIC_API_KEY, model: env.PARSE_MODEL || undefined });
  }
  const fixtures =
    env.FIXTURES_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
  console.warn('[ingest] ANTHROPIC_API_KEY is not set: using recorded fixture responses instead of the vision parser.');
  return existsSync(resolve(fixtures, 'screenshots')) ? createFixtureParser(fixtures) : new FakeParser();
}

/** Build the ingest service from env: ANTHROPIC_API_KEY, PARSE_MODEL, DAILY_PARSE_CAP, UPLOADS_PER_HOUR. */
export function createIngestFromEnv(
  deps: { db: Db; store: BlobStore; parser?: QuizParser; config?: IngestConfig },
  env: Env = process.env,
): IngestService {
  const num = (v: string | undefined) => {
    const n = Number(v);
    return v && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  return createIngest({
    db: deps.db,
    store: deps.store,
    parser: deps.parser ?? createParserFromEnv(env),
    config: {
      dailyParseCap: num(env.DAILY_PARSE_CAP),
      uploadsPerHour: num(env.UPLOADS_PER_HOUR),
      ...deps.config,
    },
  });
}
