/**
 * Server-only configuration. Reads process.env (Fly secrets in production) and,
 * in local dev, the repo-root `.env`. Never import this from a React island.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Monorepo root when running from a checkout; null in the deployed image. */
export const repoRoot = findRepoRoot(process.cwd());

let loaded = false;
function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const dir of [repoRoot, process.cwd()]) {
    if (!dir) continue;
    const file = join(dir, '.env');
    if (!existsSync(file)) continue;
    try {
      // Does not override variables that are already set.
      process.loadEnvFile(file);
    } catch {
      /* unreadable .env: ignore, real env still applies */
    }
  }
}

/** Relative paths in env are relative to the repo root (or cwd when deployed). */
function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot ?? process.cwd(), p);
}

export interface AppEnv {
  siteUrl: string;
  databasePath: string;
  migrationsDir: string | undefined;
  adminToken: string | null;
  ipHashSalt: string;
  turnstileSiteKey: string | null;
  turnstileSecret: string | null;
  resendApiKey: string | null;
  feedbackTo: string | null;
  feedbackFrom: string;
  anthropicApiKey: string | null;
  parseModel: string;
  dailyParseCap: number;
  /** process.env with path-like values made absolute; handed to the storage factory. */
  raw: Record<string, string | undefined>;
}

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cached) return cached;
  loadDotEnv();
  const e = process.env;
  const opt = (k: string) => (e[k] && e[k]!.trim() !== '' ? e[k]!.trim() : null);
  const databasePath = resolvePath(opt('DATABASE_PATH') ?? './data/cojiro.db');
  const diskDir = resolvePath(opt('STORAGE_DISK_DIR') ?? './data/blobs');
  const repoMigrations = repoRoot ? join(repoRoot, 'packages/db/migrations') : null;
  cached = {
    siteUrl: (opt('SITE_URL') ?? 'http://localhost:4321').replace(/\/+$/, ''),
    databasePath,
    migrationsDir: opt('MIGRATIONS_DIR') ?? (repoMigrations && existsSync(repoMigrations) ? repoMigrations : undefined),
    adminToken: opt('ADMIN_TOKEN'),
    ipHashSalt: opt('IP_HASH_SALT') ?? '',
    turnstileSiteKey: opt('TURNSTILE_SITE_KEY'),
    turnstileSecret: opt('TURNSTILE_SECRET'),
    resendApiKey: opt('RESEND_API_KEY'),
    feedbackTo: opt('FEEDBACK_TO'),
    feedbackFrom: opt('FEEDBACK_FROM') ?? 'feedback@cojiroquiz.com',
    anthropicApiKey: opt('ANTHROPIC_API_KEY'),
    parseModel: opt('PARSE_MODEL') ?? 'claude-haiku-5-5',
    dailyParseCap: Number(opt('DAILY_PARSE_CAP') ?? 500) || 500,
    raw: {
      ...e,
      ...(!e.FIXTURES_DIR && repoRoot && existsSync(join(repoRoot, 'fixtures')) ? { FIXTURES_DIR: join(repoRoot, 'fixtures') } : {}),
      DATABASE_PATH: databasePath, STORAGE_DISK_DIR: diskDir, STORAGE_DRIVER: opt('STORAGE_DRIVER') ?? 'disk',
    },
  };
  return cached;
}
