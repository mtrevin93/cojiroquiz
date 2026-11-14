/**
 * The ONE place where the database, blob store and ingest service are built.
 *
 * Expected from the sibling packages (they may not exist yet; everything here
 * degrades gracefully until they do):
 *
 *   @cojiro/storage  createStoreFromEnv(env: Record<string, string | undefined>): BlobStore
 *   @cojiro/ingest   createIngestFromEnv({ db, store }, env): IngestService   (preferred when present)
 *                    createClaudeParser({ apiKey, model }): parser
 *                    createIngest({ db, store, parser, config }): IngestService
 *
 * `env` is process.env with DATABASE_PATH / STORAGE_DISK_DIR made absolute.
 * For the disk driver, publicUrl(key) is expected to be `/media/<key>` and
 * signedUrl(key) `/admin/blob/<key>` (both routes live in this app).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { openDb, type Db } from '@cojiro/db';
import type { BlobStore, Bucket, IngestService } from '@cojiro/shared';
import { getEnv } from './env.ts';

/* ---------- database ---------- */

let db: Db | null = null;

export function getDb(): Db {
  if (!db) {
    const env = getEnv();
    db = openDb(env.databasePath, env.migrationsDir ? { migrationsFolder: env.migrationsDir } : {});
  }
  return db;
}

/* ---------- blob store ---------- */

const CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  avif: 'image/avif',
};

/** Encode a blob key for use in a URL path, keeping the slashes. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Minimal disk store used ONLY while @cojiro/storage does not export
 * createStoreFromEnv, so the read side (and the seed script) work today.
 */
export function createFallbackDiskStore(rootDir: string, publicBaseUrl?: string | null): BlobStore {
  const pathFor = (bucket: Bucket, key: string) => {
    const rel = normalize(key);
    if (rel.startsWith('..') || rel.startsWith(sep) || rel.includes(`..${sep}`)) throw new Error('invalid blob key');
    return join(rootDir, bucket, rel);
  };
  return {
    async put(bucket, key, body) {
      const file = pathFor(bucket, key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    },
    async get(bucket, key) {
      try {
        const body = await readFile(pathFor(bucket, key));
        const ext = key.split('.').pop()?.toLowerCase() ?? '';
        return { body: new Uint8Array(body), contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' };
      } catch {
        return null;
      }
    },
    async delete(bucket, key) {
      await rm(pathFor(bucket, key), { force: true });
    },
    publicUrl(key) {
      const base = publicBaseUrl ? publicBaseUrl.replace(/\/+$/, '') : '/media';
      return `${base}/${encodeKey(key)}`;
    },
    async signedUrl(key) {
      return `/admin/blob/${encodeKey(key)}`;
    },
  };
}

type AnyModule = Record<string, unknown>;

let storePromise: Promise<BlobStore> | null = null;

export function getStore(): Promise<BlobStore> {
  storePromise ??= (async () => {
    const env = getEnv();
    try {
      const mod = (await import('@cojiro/storage')) as AnyModule;
      if (typeof mod.createStoreFromEnv === 'function') {
        const create = mod.createStoreFromEnv as (e: Record<string, string | undefined>) => BlobStore;
        return create(env.raw);
      }
    } catch (err) {
      console.warn('[services] @cojiro/storage failed to load, using fallback disk store:', err);
    }
    if (env.raw.STORAGE_DRIVER !== 'disk') {
      console.warn('[services] STORAGE_DRIVER is not "disk" but @cojiro/storage is unavailable; using disk fallback.');
    }
    return createFallbackDiskStore(env.raw.STORAGE_DISK_DIR!, env.raw.PUBLIC_IMAGE_BASE_URL || null);
  })();
  return storePromise;
}

/* ---------- ingest ---------- */

let ingestPromise: Promise<IngestService | null> | null = null;

/** The ingest service, or null while it is not available (API routes answer 503). */
export function getIngest(): Promise<IngestService | null> {
  ingestPromise ??= (async () => {
    const env = getEnv();
    try {
      const mod = (await import('@cojiro/ingest')) as AnyModule;
      const deps = { db: getDb(), store: await getStore() };
      // Preferred: the package's own env wiring (Claude parser when ANTHROPIC_API_KEY is set,
      // recorded fixture responses otherwise; DAILY_PARSE_CAP / UPLOADS_PER_HOUR from env).
      if (typeof mod.createIngestFromEnv === 'function') {
        const fromEnv = mod.createIngestFromEnv as (
          d: { db: Db; store: BlobStore },
          e: Record<string, string | undefined>,
        ) => IngestService;
        return fromEnv(deps, env.raw);
      }
      if (typeof mod.createIngest !== 'function' || typeof mod.createClaudeParser !== 'function') return null;
      const createParser = mod.createClaudeParser as (o: { apiKey: string; model: string }) => unknown;
      const createIngest = mod.createIngest as (o: {
        db: Db;
        store: BlobStore;
        parser: unknown;
        config: Record<string, unknown>;
      }) => IngestService;
      return createIngest({
        ...deps,
        parser: createParser({ apiKey: env.anthropicApiKey ?? '', model: env.parseModel }),
        config: { dailyParseCap: env.dailyParseCap, uploadsPerHour: 20, maxUploadBytes: 8 * 1024 * 1024 },
      });
    } catch (err) {
      console.warn('[services] ingest unavailable:', err);
      return null;
    }
  })();
  return ingestPromise;
}

export const UPLOADS_UNAVAILABLE = 'uploads not available yet';
