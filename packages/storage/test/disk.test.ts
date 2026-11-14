import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskStore, createStoreFromEnv } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'cojiro-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = createDiskStore({ dir, publicBaseUrl: '/media/' });
const bytes = new Uint8Array([1, 2, 3, 4]);

describe('disk store', () => {
  it('round-trips a blob under <dir>/<bucket>/<key>', async () => {
    await store.put('public', 'shots/abc.webp', bytes, 'image/webp');
    expect(existsSync(join(dir, 'public', 'shots', 'abc.webp'))).toBe(true);
    const got = await store.get('public', 'shots/abc.webp');
    expect(got?.contentType).toBe('image/webp');
    expect([...got!.body]).toEqual([1, 2, 3, 4]);
  });

  it('keeps buckets separate', async () => {
    await store.put('private', 'quarantine/x.webp', bytes, 'image/webp');
    expect(await store.get('public', 'quarantine/x.webp')).toBeNull();
    expect(await store.get('private', 'quarantine/x.webp')).not.toBeNull();
  });

  it('returns null for missing keys and deletes idempotently', async () => {
    expect(await store.get('public', 'nope.webp')).toBeNull();
    await store.put('public', 'gone.webp', bytes, 'image/webp');
    await store.delete('public', 'gone.webp');
    await store.delete('public', 'gone.webp');
    expect(await store.get('public', 'gone.webp')).toBeNull();
  });

  it('builds URLs', async () => {
    expect(store.publicUrl('shots/abc.webp')).toBe('/media/shots/abc.webp');
    expect(await store.signedUrl('quarantine/x.webp')).toBe('/admin/blob/quarantine/x.webp');
  });

  it.each(['../escape.webp', 'a/../../b', '/abs/path', 'a\\..\\b', '', 'a//b', './a', 'a/', 'a\0b'])(
    'rejects unsafe key %j',
    async (key) => {
      await expect(store.put('public', key, bytes, 'image/webp')).rejects.toThrow(/Invalid blob key/);
      await expect(store.get('private', key)).rejects.toThrow(/Invalid blob key/);
      await expect(store.delete('public', key)).rejects.toThrow(/Invalid blob key/);
      expect(() => store.publicUrl(key)).toThrow(/Invalid blob key/);
    },
  );
});

describe('createStoreFromEnv', () => {
  it('defaults to disk', async () => {
    const s = createStoreFromEnv({ STORAGE_DISK_DIR: join(dir, 'env') });
    await s.put('public', 'a.png', bytes, 'image/png');
    expect(s.publicUrl('a.png')).toBe('/media/a.png');
    expect(existsSync(join(dir, 'env', 'public', 'a.png'))).toBe(true);
  });
  it('builds an s3 store and requires its settings', async () => {
    expect(() => createStoreFromEnv({ STORAGE_DRIVER: 's3' })).toThrow(/AWS_ENDPOINT_URL_S3/);
    const s = createStoreFromEnv({
      STORAGE_DRIVER: 's3',
      AWS_ENDPOINT_URL_S3: 'https://fly.storage.tigris.dev',
      AWS_ACCESS_KEY_ID: 'k',
      AWS_SECRET_ACCESS_KEY: 's',
      BUCKET_PUBLIC: 'pub',
      BUCKET_PRIVATE: 'priv',
      PUBLIC_IMAGE_BASE_URL: 'https://pub.example.com',
    });
    expect(s.publicUrl('shots/a.webp')).toBe('https://pub.example.com/shots/a.webp');
    const url = await s.signedUrl('quarantine/a.webp', 60);
    expect(url).toContain('quarantine/a.webp');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=60');
  });
  it('rejects unknown drivers', () => {
    expect(() => createStoreFromEnv({ STORAGE_DRIVER: 'ftp' })).toThrow(/Unknown STORAGE_DRIVER/);
  });
});
