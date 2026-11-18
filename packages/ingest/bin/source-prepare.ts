/** Usage: node bin/source-prepare.ts <questions.json> <imagesDir> <outDir> */
import { readFile } from 'node:fs/promises';
import { prepareBundle, type SourceQuestion } from '../src/source-prepare.ts';

const [file, imagesDir, outDir] = process.argv.slice(2);
if (!file || !imagesDir || !outDir) {
  console.error('Usage: node bin/source-prepare.ts <questions.json> <imagesDir> <outDir>');
  process.exit(1);
}
const data = JSON.parse(await readFile(file, 'utf8')) as { questions: SourceQuestion[] };
const bundle = await prepareBundle(data.questions, imagesDir, outDir);
console.log(`${data.questions.length} source questions -> ${bundle.questions.length} questions, ${Object.keys(bundle.images).length} pictures`);
