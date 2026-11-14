// Run the REAL Claude vision parser on a screenshot and print the result.
//
//   ANTHROPIC_API_KEY=... node packages/ingest/scripts/parse-fixture.ts fixtures/screenshots/egg-saria-a.png
//
// The image goes through the same sharp step as an upload. If a recorded
// expectation exists at fixtures/parsed/<name>.json, differences are listed.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeParser, DEFAULT_PARSE_MODEL } from '../src/claude-parser.ts';
import { processScreenshot } from '../src/image.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: parse-fixture.ts <image file>');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set; this script calls the live API.');
  process.exit(2);
}

const model = process.env.PARSE_MODEL || DEFAULT_PARSE_MODEL;
const image = await processScreenshot(new Uint8Array(readFileSync(file)), 1600);
const started = Date.now();
const parsed = await createClaudeParser({ model }).parse({ bytes: image.bytes, mimeType: 'image/webp' });
console.log(JSON.stringify(parsed, null, 2));
console.error(`\nmodel=${model} ${Date.now() - started}ms`);

const here = dirname(fileURLToPath(import.meta.url));
const expectedPath = resolve(here, '../../../fixtures/parsed', `${basename(file, extname(file))}.json`);
if (existsSync(expectedPath)) {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  const pick = (p: typeof parsed) => ({
    isQuizScreenshot: p.isQuizScreenshot,
    lang: p.lang,
    level: p.level,
    questionNumber: p.questionNumber,
    questionText: p.questionText,
    choices: p.choices.map((c) => `${c.kind}:${c.label}`),
    reveal: p.reveal,
  });
  const got = pick(parsed);
  const want = pick(expected);
  const diffs = (Object.keys(want) as Array<keyof typeof want>).filter(
    (k) => JSON.stringify(got[k]) !== JSON.stringify(want[k]),
  );
  if (diffs.length === 0) console.error('MATCHES recorded expectation (boxes and confidence not compared).');
  else {
    for (const k of diffs) console.error(`DIFF ${k}:\n  expected ${JSON.stringify(want[k])}\n  got      ${JSON.stringify(got[k])}`);
    process.exitCode = 1;
  }
}
