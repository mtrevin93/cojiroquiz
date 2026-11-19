/**
 * Usage:
 *   node bin/source-prepare.ts <imagesDir> <outDir> <questions.json>                 one English list
 *   node bin/source-prepare.ts <imagesDir> <outDir> en-GB=<file> en-US=<file> ...    one file per locale;
 *                                                                                  the first locale of a language is its main one
 */
import { readFile } from 'node:fs/promises';
import { type LocaleSource, type SourceQuestion, prepareBundle } from '../src/source-prepare.ts';

const [imagesDir, outDir, ...files] = process.argv.slice(2);
if (!imagesDir || !outDir || files.length === 0) {
  console.error('Usage: node bin/source-prepare.ts <imagesDir> <outDir> <questions.json | locale=file ...>');
  process.exit(1);
}
const read = async (file: string) => (JSON.parse(await readFile(file, 'utf8')) as { questions: SourceQuestion[] }).questions;
let input: LocaleSource[] | SourceQuestion[];
if (files.length === 1 && !files[0]!.includes('=')) input = await read(files[0]!);
else {
  input = [];
  for (const arg of files) {
    const [locale, file] = arg.split('=');
    if (!locale || !file) throw new Error(`Expected locale=file, got ${arg}`);
    input.push({ locale, questions: await read(file) });
  }
}
const bundle = await prepareBundle(input, imagesDir, outDir);
const perLang = new Map<string, number>();
for (const q of bundle.questions) perLang.set(q.lang, (perLang.get(q.lang) ?? 0) + 1);
console.log(`${bundle.questions.length} questions, ${Object.keys(bundle.images).length} pictures`, Object.fromEntries(perLang));
