import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobStore, Bucket } from '@cojiro/shared';

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.json': 'application/json',
};

/** Content type implied by a key's extension (the disk store keeps no metadata). */
export function contentTypeForKey(key: string): string {
  return CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Keys are relative, forward-slash paths made of plain segments.
 * Throws on anything that could escape the bucket (.., absolute, backslash, NUL).
 */
export function assertSafeKey(key: string): void {
  const bad =
    key.length === 0 ||
    key.length > 512 ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    /[\\\0]/.test(key) ||
    key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
  if (bad) throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export interface DiskStoreOptions {
  /** Root folder; blobs live at <dir>/<bucket>/<key> with bucket = "public" | "private". */
  dir: string;
  /** Prefix for public URLs, e.g. "/media" or "http://localhost:4321/media". */
  publicBaseUrl: string;
}

export function createDiskStore({ dir, publicBaseUrl }: DiskStoreOptions): BlobStore {
  const root = resolve(dir);
  const base = trimSlash(publicBaseUrl);

  const pathFor = (bucket: Bucket, key: string): string => {
    assertSafeKey(key);
    if (bucket !== 'public' && bucket !== 'private') throw new Error(`Invalid bucket: ${String(bucket)}`);
    const bucketDir = resolve(root, bucket);
    const full = resolve(bucketDir, key);
    if (!full.startsWith(bucketDir + sep)) throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
    return full;
  };

  return {
    async put(bucket, key, body) {
      const p = pathFor(bucket, key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    async get(bucket, key) {
      const p = pathFor(bucket, key);
      try {
        const buf = await readFile(p);
        return { body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), contentType: contentTypeForKey(key) };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
        throw err;
      }
    },
    async delete(bucket, key) {
      await rm(pathFor(bucket, key), { force: true });
    },
    publicUrl(key) {
      assertSafeKey(key);
      return `${base}/${key}`;
    },
    async signedUrl(key) {
      assertSafeKey(key);
      return `/admin/blob/${key}`;
    },
  };
}

export interface S3StoreOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBucket: string;
  privateBucket: string;
  /** Separate key for the private bucket (Fly issues one key per Tigris bucket). Defaults to the main key. */
  privateAccessKeyId?: string;
  privateSecretAccessKey?: string;
  /** Public URL prefix of the public bucket, e.g. "https://cojiroquiz-images.fly.storage.tigris.dev". */
  publicBaseUrl: string;
}

export function createS3Store(opts: S3StoreOptions): BlobStore {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  const privateClient =
    opts.privateAccessKeyId && opts.privateSecretAccessKey
      ? new S3Client({
          endpoint: opts.endpoint,
          region: opts.region,
          credentials: { accessKeyId: opts.privateAccessKeyId, secretAccessKey: opts.privateSecretAccessKey },
        })
      : client;
  const clientFor = (b: Bucket) => (b === 'public' ? client : privateClient);
  const base = trimSlash(opts.publicBaseUrl);
  const bucketName = (b: Bucket) => (b === 'public' ? opts.publicBucket : opts.privateBucket);

  return {
    async put(bucket, key, body, contentType) {
      assertSafeKey(key);
      await clientFor(bucket).send(
        new PutObjectCommand({
          Bucket: bucketName(bucket),
          Key: key,
          Body: body,
          ContentType: contentType,
          // Keys are content-addressed, so public objects never change.
          CacheControl: bucket === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store',
        }),
      );
    },
    async get(bucket, key) {
      assertSafeKey(key);
      try {
        const res = await clientFor(bucket).send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }));
        if (!res.Body) return null;
        return {
          body: await res.Body.transformToByteArray(),
          contentType: res.ContentType ?? contentTypeForKey(key),
        };
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async delete(bucket, key) {
      assertSafeKey(key);
      await clientFor(bucket).send(new DeleteObjectCommand({ Bucket: bucketName(bucket), Key: key }));
    },
    publicUrl(key) {
      assertSafeKey(key);
      return `${base}/${key}`;
    },
    async signedUrl(key, expiresInSeconds = 300) {
      assertSafeKey(key);
      return getSignedUrl(privateClient, new GetObjectCommand({ Bucket: opts.privateBucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },
  };
}

type Env = Record<string, string | undefined>;

/**
 * STORAGE_DRIVER=disk (default): STORAGE_DISK_DIR, PUBLIC_IMAGE_BASE_URL (default "/media").
 * STORAGE_DRIVER=s3: AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * BUCKET_PUBLIC, BUCKET_PRIVATE, PUBLIC_IMAGE_BASE_URL.
 */
export function createStoreFromEnv(env: Env = process.env): BlobStore {
  const driver = env.STORAGE_DRIVER || 'disk';
  if (driver === 'disk') {
    return createDiskStore({
      dir: env.STORAGE_DISK_DIR || './data/blobs',
      publicBaseUrl: env.PUBLIC_IMAGE_BASE_URL || '/media',
    });
  }
  if (driver === 's3') {
    const need = (name: string): string => {
      const v = env[name];
      if (!v) throw new Error(`STORAGE_DRIVER=s3 requires ${name}`);
      return v;
    };
    return createS3Store({
      endpoint: need('AWS_ENDPOINT_URL_S3'),
      region: env.AWS_REGION || 'auto',
      accessKeyId: need('AWS_ACCESS_KEY_ID'),
      secretAccessKey: need('AWS_SECRET_ACCESS_KEY'),
      publicBucket: need('BUCKET_PUBLIC'),
      privateBucket: need('BUCKET_PRIVATE'),
      privateAccessKeyId: env.PRIVATE_AWS_ACCESS_KEY_ID || undefined,
      privateSecretAccessKey: env.PRIVATE_AWS_SECRET_ACCESS_KEY || undefined,
      publicBaseUrl: need('PUBLIC_IMAGE_BASE_URL'),
    });
  }
  throw new Error(`Unknown STORAGE_DRIVER: ${driver}`);
}
