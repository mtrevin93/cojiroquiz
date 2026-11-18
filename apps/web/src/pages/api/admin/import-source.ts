import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRoute } from 'astro';
import { type Bundle, applyBundle } from '@cojiro/ingest';
import { getDb, getStore } from '../../../lib/services.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/**
 * Loads a prepared question bundle (packages/ingest/bin/source-prepare.ts) that has been
 * copied to the server. Admin only (src/middleware.ts). Two steps, both safe to repeat:
 *   ?step=images&from=0&count=300   copy that slice of pictures to the public bucket
 *   ?step=questions                 add or refresh the questions
 */
export const POST: APIRoute = async ({ url }) => {
  const dir = process.env.IMPORT_DIR || '/data/import/bundle';
  let bundle: Bundle;
  try {
    bundle = JSON.parse(await readFile(join(dir, 'bundle.json'), 'utf8')) as Bundle;
  } catch {
    return json({ error: `No bundle at ${dir}` }, 404);
  }
  const step = url.searchParams.get('step');

  if (step === 'images') {
    const names = Object.keys(bundle.images).sort();
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    const count = Math.min(500, Math.max(1, Number(url.searchParams.get('count')) || 300));
    const slice = names.slice(from, from + count);
    const store = await getStore();
    let next = 0;
    const failed: string[] = [];
    const worker = async () => {
      while (next < slice.length) {
        const name = slice[next++]!;
        try {
          const bytes = await readFile(join(dir, 'images', `${name}.webp`));
          await store.put('public', bundle.images[name]!.key, new Uint8Array(bytes), 'image/webp');
        } catch {
          failed.push(name);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return json({ total: names.length, from, done: slice.length - failed.length, failed });
  }

  if (step === 'questions') {
    const report = applyBundle(getDb(), bundle);
    return json({ ...report, unmatched: report.unmatched.map((u) => u.id) });
  }

  return json({ error: 'step must be "images" or "questions"' }, 400);
};
