import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb, schema } from '@cojiro/db';
import type { BlobStore, ConfirmResult, DraftDTO, ParsedQuiz, UploadResult } from '@cojiro/shared';
import { createDiskStore } from '@cojiro/storage';
import { type IngestConfig, FakeParser, IngestError, createIngest, sha256Hex, slugify } from '../src/index.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const shot = (name: string) => new Uint8Array(readFileSync(join(fixtures, 'screenshots', `${name}.png`)));
const recorded = (name: string): ParsedQuiz => JSON.parse(readFileSync(join(fixtures, 'parsed', `${name}.json`), 'utf8'));

const REVEAL = shot('egg-saria-a'); // player picked X (wrong), ✓ is gold
const PLAIN = shot('egg-saria-b'); // same question, nothing highlighted
const CUCCO = shot('cucco-ybutton-4choice');
const SARIA = "R A Y R A Y\nThis is the music score for Saria's Song.";

const tmp = mkdtempSync(join(tmpdir(), 'cojiro-ingest-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
/** A distinct, valid PNG (unique bytes each call). */
async function png(width = 60, height = 120): Promise<Uint8Array> {
  seq += 1;
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: seq % 256, g: (seq * 7) % 256, b: 90 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

const quiz = (over: Partial<ParsedQuiz> = {}): ParsedQuiz => ({ ...recorded('egg-saria-b'), ...over });
const png_ = { mimeType: 'image/png' };
const ip = (n: number | string) => ({ ipHash: `ip-${n}` });

let db: Db;
let store: BlobStore;
let parser: FakeParser;
let clock: number;

function setup(config: IngestConfig = {}) {
  db = openDb(':memory:');
  store = createDiskStore({ dir: mkdtempSync(join(tmp, 'blobs-')), publicBaseUrl: '/media' });
  parser = new FakeParser().loadFixtures(join(fixtures, 'screenshots'), join(fixtures, 'parsed'));
  clock = 1_800_000_000_000;
  return createIngest({ db, store, parser, config: { now: () => clock, ...config } });
}

let ingest = setup();
beforeEach(() => {
  ingest = setup();
});

function draftOf(r: UploadResult): DraftDTO {
  if (r.status !== 'draft') throw new Error(`expected a draft, got ${JSON.stringify(r)}`);
  return r.draft;
}
const question = (id: number) => db.select().from(schema.questions).all().find((q) => q.id === id)!;
const imageBySha = (sha: string) => db.select().from(schema.images).all().find((i) => i.sha256 === sha)!;
const count = (t: typeof schema.images | typeof schema.drafts | typeof schema.questions | typeof schema.submissions) =>
  db.select().from(t).all().length;

/** Upload + confirm in one go. */
async function publish(bytes: Uint8Array, answerIndex: number, who = ip(1)): Promise<ConfirmResult> {
  const d = draftOf(await ingest.processUpload({ bytes, ...png_ }, who));
  return ingest.confirmDraft(d.draftId, { answerIndex }, who);
}

describe('fixtures', () => {
  it('recorded responses match the screenshots they describe', () => {
    expect(recorded('egg-saria-a').reveal).toEqual({ present: true, correctIndex: 1, selectedIndex: 0 });
    expect(recorded('egg-saria-b').reveal.present).toBe(false);
    expect(recorded('cucco-ybutton-4choice').choices.map((c) => c.label)).toEqual(['B', 'E', 'G', 'C']);
  });
});

describe('processUpload', () => {
  it('returns a draft for a no-reveal screenshot and stores a stripped webp publicly', async () => {
    const d = draftOf(await ingest.processUpload({ bytes: PLAIN, ...png_ }, ip(1)));
    expect(d).toMatchObject({
      lang: 'en',
      level: 'Egg Level',
      questionText: SARIA,
      detectedAnswerIndex: null,
      confidence: 'high',
      duplicateOf: null,
    });
    expect(d.choices.map((c) => c.label)).toEqual(['X', '✓']);

    const img = db.select().from(schema.images).all();
    expect(img).toHaveLength(1);
    expect(img[0]).toMatchObject({ sha256: sha256Hex(PLAIN), bucket: 'public', hasReveal: false });
    const blob = await store.get('public', img[0]!.key);
    const meta = await sharp(blob!.body).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    expect(meta.exif).toBeUndefined();
    expect(img[0]).toMatchObject({ width: meta.width, height: meta.height });
    // the parser saw the processed image, not the original
    expect(parser.calls[0]!.mimeType).toBe('image/webp');
    expect(count(schema.drafts)).toBe(1);
    expect(count(schema.questions)).toBe(0);
  });

  it('detects the answer from a reveal screenshot', async () => {
    const d = draftOf(await ingest.processUpload({ bytes: REVEAL, ...png_ }, ip(1)));
    expect(d.detectedAnswerIndex).toBe(1);
    expect(db.select().from(schema.images).get()!.hasReveal).toBe(true);
  });

  it('ignores an out-of-range reveal index', async () => {
    const bytes = await png();
    parser.set(bytes, quiz({ reveal: { present: true, correctIndex: 5, selectedIndex: 0 } }));
    expect(draftOf(await ingest.processUpload({ bytes, ...png_ }, ip(1))).detectedAnswerIndex).toBeNull();
  });

  it('rejects invalid files without touching the parser', async () => {
    const cases: Array<[Uint8Array, string]> = [
      [new TextEncoder().encode('this is not an image'), 'image/png'],
      [new Uint8Array(0), 'image/png'],
      [PLAIN, 'application/pdf'],
      [new Uint8Array(await sharp(PLAIN).resize(40).gif().toBuffer()), 'image/gif'],
      [new Uint8Array(await sharp(PLAIN).resize(40).gif().toBuffer()), 'image/png'],
      [PLAIN.slice(0, 200), 'image/png'],
    ];
    for (const [bytes, mimeType] of cases) {
      expect((await ingest.processUpload({ bytes, mimeType }, ip(1))).status).toBe('invalid_file');
    }
    ingest = setup({ maxUploadBytes: 1000 });
    expect((await ingest.processUpload({ bytes: PLAIN, ...png_ }, ip(1))).status).toBe('invalid_file');
    expect(parser.calls).toHaveLength(0);
    expect(count(schema.images)).toBe(0);
  });

  it('accepts jpeg and webp', async () => {
    for (const fmt of ['jpeg', 'webp'] as const) {
      const bytes = new Uint8Array(await sharp(await png()).toFormat(fmt).toBuffer());
      parser.set(bytes, quiz({ questionText: `Question in ${fmt}` }));
      expect((await ingest.processUpload({ bytes, mimeType: `image/${fmt}` }, ip(1))).status).toBe('draft');
    }
  });

  it('rate limits per ipHash over a sliding hour', async () => {
    ingest = setup({ uploadsPerHour: 2 });
    parser.fallback = () => quiz({ questionText: `Q ${parser.calls.length}` });
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(1))).status).toBe('draft');
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(1))).status).toBe('draft');
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(1))).status).toBe('rate_limited');
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(2))).status).toBe('draft');
    expect(parser.calls).toHaveLength(3);
    clock += 61 * 60 * 1000;
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(1))).status).toBe('draft');
  });

  it('enforces the daily parse cap across all visitors', async () => {
    ingest = setup({ dailyParseCap: 2 });
    parser.fallback = () => quiz({ questionText: `Q ${parser.calls.length}` });
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(1))).status).toBe('draft');
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(2))).status).toBe('draft');
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(3))).status).toBe('cap_reached');
    expect(parser.calls).toHaveLength(2);
    clock += 25 * 60 * 60 * 1000;
    expect((await ingest.processUpload({ bytes: await png(), ...png_ }, ip(3))).status).toBe('draft');
  });
});

describe('confirm: insert or merge', () => {
  it('creates a question from a no-reveal draft and a manual answer', async () => {
    const r = await publish(PLAIN, 1);
    expect(r).toEqual({ questionId: 1, slug: '1-rayray-this-is-the-music-score-for-sarias-song', merged: false, disputed: false });
    const q = question(1);
    expect(q).toMatchObject({
      lang: 'en',
      level: 'Egg Level',
      questionText: SARIA,
      answerIndex: 1,
      answerSource: 'manual',
      answerImageId: null,
      submissionCount: 1,
      disputed: false,
    });
    expect(q.questionImageId).toBe(db.select().from(schema.images).get()!.id);
    expect(q.choices).toEqual([
      { label: 'X', kind: 'symbol', description: null, imageKey: null },
      { label: '✓', kind: 'symbol', description: null, imageKey: null },
    ]);
    expect(q.searchText).toContain('rayray');
    expect(q.searchText).toContain('egg level');
    const subs = db.select().from(schema.submissions).all();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ answerCanonical: '✓', answerSource: 'manual', ipHash: 'ip-1' });
    expect(count(schema.drafts)).toBe(0);
  });

  it('merges the reveal screenshot, which becomes the answer image and source', async () => {
    await publish(PLAIN, 1, ip(1));
    const d = draftOf(await ingest.processUpload({ bytes: REVEAL, ...png_ }, ip(2)));
    expect(d.duplicateOf).toEqual({ id: 1, slug: '1-rayray-this-is-the-music-score-for-sarias-song', answerLabel: '✓' });
    const r = await ingest.confirmDraft(d.draftId, { answerIndex: d.detectedAnswerIndex! }, ip(2));
    expect(r).toMatchObject({ questionId: 1, merged: true, disputed: false });

    const q = question(1);
    const plainImg = imageBySha(sha256Hex(PLAIN));
    const revealImg = imageBySha(sha256Hex(REVEAL));
    expect(q).toMatchObject({
      answerIndex: 1,
      answerSource: 'reveal',
      questionImageId: plainImg.id,
      answerImageId: revealImg.id,
      submissionCount: 2,
      disputed: false,
    });
    expect(count(schema.questions)).toBe(1);
  });

  it('a reveal-first question gets both images from the reveal screenshot', async () => {
    await publish(REVEAL, 1);
    const q = question(1);
    expect(q.answerSource).toBe('reveal');
    expect(q.answerImageId).toBe(q.questionImageId);
    expect(q.answerImageId).not.toBeNull();
  });

  it('overriding the detected answer makes the submission manual and attaches no answer image', async () => {
    await publish(REVEAL, 0);
    const q = question(1);
    expect(q).toMatchObject({ answerIndex: 0, answerSource: 'manual', answerImageId: null });
    expect(db.select().from(schema.submissions).get()!.answerSource).toBe('manual');
  });

  it('reports an identical file as duplicate_file without parsing again', async () => {
    await publish(PLAIN, 1);
    const calls = parser.calls.length;
    const r = await ingest.processUpload({ bytes: PLAIN, ...png_ }, ip(9));
    expect(r).toEqual({ status: 'duplicate_file', question: { id: 1, slug: '1-rayray-this-is-the-music-score-for-sarias-song' } });
    expect(parser.calls).toHaveLength(calls);
  });

  it('re-uploading a file whose draft was abandoned parses again and reuses the image row', async () => {
    draftOf(await ingest.processUpload({ bytes: PLAIN, ...png_ }, ip(1)));
    const d = draftOf(await ingest.processUpload({ bytes: PLAIN, ...png_ }, ip(1)));
    expect(count(schema.images)).toBe(1);
    expect((await ingest.confirmDraft(d.draftId, { answerIndex: 1 }, ip(1))).merged).toBe(false);
  });

  it('merges when choice order is shuffled and maps the answer by content', async () => {
    await publish(CUCCO, 2, ip(1)); // B E G C -> "G"
    const shuffled = await png();
    const base = recorded('cucco-ybutton-4choice');
    parser.set(shuffled, { ...base, level: 'Cucco Level', choices: [base.choices[3]!, base.choices[2]!, base.choices[0]!, base.choices[1]!] }); // C G B E
    const d = draftOf(await ingest.processUpload({ bytes: shuffled, ...png_ }, ip(2)));
    expect(d.duplicateOf).toMatchObject({ id: 1, answerLabel: 'G' });
    const r = await ingest.confirmDraft(d.draftId, { answerIndex: 1 }, ip(2)); // "G" is at index 1 here
    expect(r).toMatchObject({ questionId: 1, merged: true, disputed: false });
    const q = question(1);
    expect(q.choices.map((c) => c.label)).toEqual(['B', 'E', 'G', 'C']);
    expect(q).toMatchObject({ answerIndex: 2, submissionCount: 2, disputed: false });
    expect(db.select().from(schema.submissions).all().map((s) => s.answerCanonical)).toEqual(['g', 'g']);
  });

  it('marks conflicting answers disputed, and a reveal outweighs manual votes', async () => {
    // two different visitors say X by hand
    await publish(PLAIN, 0, ip(1));
    const again = await png();
    parser.set(again, quiz());
    const r2 = await publish(again, 0, ip(2));
    expect(r2).toMatchObject({ merged: true, disputed: false });
    expect(question(1)).toMatchObject({ answerIndex: 0, answerSource: 'manual' });

    // one reveal screenshot says ✓: 3 > 1 + 1
    const r3 = await publish(REVEAL, 1, ip(3));
    expect(r3).toMatchObject({ merged: true, disputed: true });
    const q = question(1);
    expect(q).toMatchObject({ answerIndex: 1, answerSource: 'reveal', disputed: true, submissionCount: 3 });
    expect(q.answerImageId).toBe(imageBySha(sha256Hex(REVEAL)).id);
  });

  it('a manual vote against a reveal answer disputes it but does not change it', async () => {
    await publish(REVEAL, 1, ip(1));
    const r = await publish(PLAIN, 0, ip(2));
    expect(r.disputed).toBe(true);
    expect(question(1)).toMatchObject({ answerIndex: 1, answerSource: 'reveal', disputed: true });
  });

  it('counts one visitor once per answer', async () => {
    await publish(REVEAL, 1, ip(1));
    for (let i = 0; i < 4; i++) {
      await ingest.submitManual({ lang: 'en', level: null, questionText: SARIA, choiceLabels: ['X', '✓'], answerIndex: 0 }, ip(2));
    }
    expect(question(1)).toMatchObject({ answerIndex: 1, disputed: true, submissionCount: 5 });
  });

  it('does not merge near-identical text (R Y A R Y A)', async () => {
    await publish(PLAIN, 1);
    const other = await png();
    parser.set(other, quiz({ questionText: "R Y A R Y A\nThis is the music score for Saria's Song." }));
    const d = draftOf(await ingest.processUpload({ bytes: other, ...png_ }, ip(1)));
    expect(d.duplicateOf).toBeNull();
    const r = await ingest.confirmDraft(d.draftId, { answerIndex: 0 }, ip(1));
    expect(r).toMatchObject({ questionId: 2, merged: false });
    expect(question(1).answerIndex).toBe(1);
    expect(question(2).answerIndex).toBe(0);
  });

  it('does not merge across languages, and non-Latin questions get an id-only slug', async () => {
    await publish(PLAIN, 1);
    const sameTextOtherLang = await png();
    parser.set(sameTextOtherLang, quiz({ lang: 'es' }));
    expect((await publish(sameTextOtherLang, 1)).merged).toBe(false);

    const ja = await png();
    parser.set(ja, quiz({ lang: 'ja', level: 'タマゴ級', questionText: 'これはサリアの歌の楽譜です。' }));
    const r = await publish(ja, 1);
    expect(r).toMatchObject({ questionId: 3, slug: '3', merged: false });
    expect(question(3).searchText).toContain('サリアの歌');
    expect(count(schema.questions)).toBe(3);
  });

  it('merges regional variants of one language and ignores case/punctuation differences', async () => {
    await publish(PLAIN, 1);
    const variant = await png();
    parser.set(variant, quiz({ lang: 'en-US', questionText: 'R A Y R A Y\nThis is the music score for Saria’s song' }));
    expect((await publish(variant, 1, ip(2))).merged).toBe(true);
  });

  it("applies the uploader's corrections before deduping", async () => {
    const typo = await png();
    parser.set(typo, quiz({ questionText: "R A Y R A Y\nThis is the rnusic score for Saria's Song.", lang: 'fr', level: 'Egg Leve1' }));
    const d = draftOf(await ingest.processUpload({ bytes: typo, ...png_ }, ip(1)));
    const r = await ingest.confirmDraft(
      d.draftId,
      { answerIndex: 1, questionText: SARIA, lang: 'en', level: 'Egg Level', choiceLabels: ['X', '✓'] },
      ip(1),
    );
    expect(question(r.questionId)).toMatchObject({ questionText: SARIA, lang: 'en', level: 'Egg Level' });
    expect((await publish(PLAIN, 1, ip(2))).merged).toBe(true);
  });

  it('validates the confirmation', async () => {
    const d = draftOf(await ingest.processUpload({ bytes: PLAIN, ...png_ }, ip(1)));
    await expect(ingest.confirmDraft(d.draftId, { answerIndex: 2 }, ip(1))).rejects.toMatchObject({ code: 'invalid_answer' });
    await expect(ingest.confirmDraft(d.draftId, { answerIndex: -1 }, ip(1))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(ingest.confirmDraft(d.draftId, { answerIndex: 0, choiceLabels: ['X'] }, ip(1))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(ingest.confirmDraft('nope', { answerIndex: 0 }, ip(1))).rejects.toBeInstanceOf(IngestError);
    // still confirmable after failed attempts, but only once
    await ingest.confirmDraft(d.draftId, { answerIndex: 1 }, ip(1));
    await expect(ingest.confirmDraft(d.draftId, { answerIndex: 1 }, ip(1))).rejects.toMatchObject({ code: 'draft_not_found' });
    expect(count(schema.submissions)).toBe(1);
  });

  it('purges drafts older than 24h', async () => {
    const old = draftOf(await ingest.processUpload({ bytes: PLAIN, ...png_ }, ip(1)));
    clock += 25 * 60 * 60 * 1000;
    const fresh = draftOf(await ingest.processUpload({ bytes: CUCCO, ...png_ }, ip(1)));
    await ingest.confirmDraft(fresh.draftId, { answerIndex: 0 }, ip(1));
    expect(count(schema.drafts)).toBe(0);
    await expect(ingest.confirmDraft(old.draftId, { answerIndex: 1 }, ip(1))).rejects.toMatchObject({ code: 'draft_not_found' });
  });

  it('crops picture choices into their own public images', async () => {
    const bytes = await png(400, 800);
    const box = (y: number) => ({ x: 0.05, y, w: 0.9, h: 0.1 });
    parser.set(
      bytes,
      quiz({
        questionText: 'Which of these sells for the most?',
        choices: [
          { label: 'Poe', kind: 'image', description: 'bottled poe', box: box(0.5) },
          { label: 'Fish', kind: 'image', description: 'fish', box: box(0.62) },
          { label: 'Bug', kind: 'image', description: 'bug', box: { x: 0.5, y: 0.5, w: 0, h: 0 } }, // unusable box
          { label: 'Fairy', kind: 'image', description: 'bottled fairy', box: null },
        ],
      }),
    );
    const r = await publish(bytes, 0);
    const q = question(r.questionId);
    const sha = sha256Hex(bytes);
    expect(q.choices.map((c) => c.imageKey)).toEqual([`choices/${sha}-0.webp`, `choices/${sha}-1.webp`, null, null]);
    const crop = await store.get('public', q.choices[0]!.imageKey!);
    expect(await sharp(crop!.body).metadata()).toMatchObject({ format: 'webp', width: 360, height: 80 });
    expect(q.searchText).toContain('bottled fairy');
    expect(db.select().from(schema.submissions).get()!.answerCanonical).toBe('bottled poe');

    // the same picture question with different short labels still merges (description is the identity)
    const again = await png(400, 800);
    parser.set(
      again,
      quiz({
        questionText: 'Which of these sells for the most?',
        choices: [
          { label: 'bug', kind: 'image', description: 'Bug', box: null },
          { label: 'fairy', kind: 'image', description: 'Bottled fairy', box: null },
          { label: 'poe', kind: 'image', description: 'Bottled Poe', box: null },
          { label: 'fish', kind: 'image', description: 'Fish', box: null },
        ],
      }),
    );
    expect(await publish(again, 2, ip(2))).toMatchObject({ questionId: r.questionId, merged: true, disputed: false });
  });
});

describe('quarantine', () => {
  const quarantineRows = () => db.select().from(schema.quarantine).all();

  it('quarantines a non-quiz image privately and does not re-parse a re-upload', async () => {
    const bytes = await png();
    const raw = quiz({ isQuizScreenshot: false, rejectReason: 'a photo of a cat', questionText: '', choices: [] });
    parser.set(bytes, raw);
    const r = await ingest.processUpload({ bytes, ...png_ }, ip(1));
    expect(r).toEqual({ status: 'quarantined', reason: 'not_quiz: a photo of a cat' });

    const rows = quarantineRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha256: sha256Hex(bytes), reason: 'not_quiz: a photo of a cat', status: 'new', ipHash: 'ip-1', parsed: raw });
    expect(await store.get('private', rows[0]!.key)).not.toBeNull();
    expect(await store.get('public', rows[0]!.key)).toBeNull();
    expect(count(schema.images)).toBe(0);
    expect(count(schema.drafts)).toBe(0);

    const again = await ingest.processUpload({ bytes, ...png_ }, ip(2));
    expect(again).toEqual({ status: 'quarantined', reason: 'not_quiz: a photo of a cat' });
    expect(parser.calls).toHaveLength(1);
    expect(quarantineRows()).toHaveLength(1);
  });

  it('treats a parser outage as retryable: nothing is quarantined or stored', async () => {
    const bytes = await png();
    parser.set(bytes, new Error('upstream 529 overloaded: secret detail'));
    const r = await ingest.processUpload({ bytes, ...png_ }, ip(1));
    expect(r.status).toBe('parser_unavailable');
    expect(JSON.stringify(r)).not.toContain('secret detail');
    expect(db.select().from(schema.quarantine).all()).toHaveLength(0);
    expect(count(schema.images)).toBe(0);
  });

  it('quarantines empty questions, missing choices and malformed output', async () => {
    const cases: Array<[unknown, string, string]> = [
      [quiz({ questionText: '  ' }), 'empty_question', 'empty_question'],
      [quiz({ choices: [] }), 'no_choices', 'no_choices'],
      [{ isQuizScreenshot: true, questionText: 'x' }, 'schema_invalid', 'unreadable'],
      ['not even an object', 'schema_invalid', 'unreadable'],
    ];
    for (const [response, stored, shown] of cases) {
      const bytes = await png();
      parser.set(bytes, response);
      const r = await ingest.processUpload({ bytes, ...png_ }, ip(1));
      expect(r).toEqual({ status: 'quarantined', reason: shown });
      const row = db.select().from(schema.quarantine).all().find((x) => x.sha256 === sha256Hex(bytes))!;
      expect(row.reason.startsWith(stored)).toBe(true);
      expect(await store.get('private', row.key)).not.toBeNull();
    }
    expect(count(schema.images)).toBe(0);
  });

  it('promotes a quarantined upload by hand and publishes its screenshot', async () => {
    const bytes = await png();
    parser.set(bytes, quiz({ isQuizScreenshot: false, rejectReason: 'unknown layout', questionText: '', choices: [] }));
    await ingest.processUpload({ bytes, ...png_ }, ip(1));
    const row = quarantineRows()[0]!;

    const input = { lang: 'en', level: 'Egg Level', questionText: 'Is Epona a horse?', choiceLabels: ['X', '✓'], answerIndex: 1 };
    const r = await ingest.promoteQuarantined(row.id, input, ip('admin'));
    expect(r).toMatchObject({ slug: `${r.questionId}-is-epona-a-horse`, merged: false, disputed: false });

    const q = question(r.questionId);
    const img = db.select().from(schema.images).get()!;
    expect(img).toMatchObject({ sha256: sha256Hex(bytes), bucket: 'public', hasReveal: false });
    expect(q).toMatchObject({ questionImageId: img.id, answerImageId: null, answerIndex: 1, answerSource: 'manual' });
    expect(await store.get('public', img.key)).not.toBeNull();
    expect(await store.get('private', row.key)).not.toBeNull(); // never deleted
    expect(quarantineRows()[0]).toMatchObject({ status: 'promoted', resolvedAt: clock });

    await expect(ingest.promoteQuarantined(row.id, input, ip('admin'))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(ingest.promoteQuarantined(999, input, ip('admin'))).rejects.toMatchObject({ code: 'quarantine_not_found' });
    // the same file is now a known duplicate
    expect(await ingest.processUpload({ bytes, ...png_ }, ip(2))).toMatchObject({ status: 'duplicate_file', question: { id: r.questionId } });
  });
});

describe('submitManual', () => {
  const input = { lang: 'en', level: 'Egg Level', questionText: SARIA, choiceLabels: ['X', '✓'], answerIndex: 1 };

  it('creates a question with no image', async () => {
    const r = await ingest.submitManual(input, ip(1));
    expect(r).toMatchObject({ questionId: 1, merged: false, disputed: false });
    expect(question(1)).toMatchObject({ questionImageId: null, answerImageId: null, answerIndex: 1, answerSource: 'manual' });
    expect(db.select().from(schema.submissions).get()).toMatchObject({ imageId: null, parsed: null, answerCanonical: '✓' });
  });

  it('merges with a screenshot of the same question, which then supplies the images', async () => {
    await ingest.submitManual(input, ip(1));
    const r = await publish(REVEAL, 1, ip(2));
    expect(r).toMatchObject({ questionId: 1, merged: true, disputed: false });
    const q = question(1);
    expect(q.answerSource).toBe('reveal');
    expect(q.questionImageId).not.toBeNull();
    expect(q.answerImageId).toBe(q.questionImageId);
  });

  it('validates input and shares the upload rate limit', async () => {
    await expect(ingest.submitManual({ ...input, answerIndex: 2 }, ip(1))).rejects.toMatchObject({ code: 'invalid_answer' });
    await expect(ingest.submitManual({ ...input, choiceLabels: ['only one'] }, ip(1))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(ingest.submitManual({ ...input, questionText: '   ' }, ip(1))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(count(schema.questions)).toBe(0);
    ingest = setup({ uploadsPerHour: 1 });
    await ingest.submitManual(input, ip(1));
    await expect(ingest.submitManual(input, ip(1))).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('slugify', () => {
  it('makes ASCII slugs and truncates on a word boundary', () => {
    expect(slugify('¿Cuál es la canción de Saria?')).toBe('cual-es-la-cancion-de-saria');
    expect(slugify('サリアの歌')).toBe('');
    const long = slugify('When playing the ocarina in\nNormal mode, which note is\nassigned to the Y Button?');
    expect(long).toBe('when-playing-the-ocarina-in-normal-mode-which-note-is');
    expect(long.length).toBeLessThanOrEqual(60);
  });
});

describe('admin-locked answers', () => {
  it('later uploads count as confirmations but cannot change a locked answer', async () => {
    const png_ = { mimeType: 'image/png' };
    const a = await png();
    parser.set(a, quiz());
    const d = draftOf(await ingest.processUpload({ bytes: a, ...png_ }, ip(1)));
    const first = await ingest.confirmDraft(d.draftId, { answerIndex: 0 }, ip(1));
    const { questions } = schema;
    db.update(questions).set({ answerLocked: true }).run();

    for (const n of [2, 3, 4]) {
      const b = await png();
      parser.set(b, quiz({ reveal: { present: true, correctIndex: 1, selectedIndex: 0 } }));
      const dd = draftOf(await ingest.processUpload({ bytes: b, ...png_ }, ip(n)));
      await ingest.confirmDraft(dd.draftId, { answerIndex: 1 }, ip(n));
    }
    const q = question(first.questionId);
    expect(q.answerIndex).toBe(0);
    expect(q.submissionCount).toBe(4);
    expect(q.disputed).toBe(false);
  });
});
