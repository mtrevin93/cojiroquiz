import type { APIRoute } from 'astro';
import { choiceText, listQuestions } from '@cojiro/db';
import { questionPath } from '../components/QuestionCard.tsx';
import { getEnv } from '../lib/env.ts';
import { answerWords } from '../lib/seo.ts';
import { getDb, getStore } from '../lib/services.ts';

/** Every visible question with its choices and answer, as plain text. */
export const GET: APIRoute = async () => {
  const site = getEnv().siteUrl;
  const store = await getStore();
  const questions = listQuestions(getDb(), (key) => store.publicUrl(key), { limit: 20000 });
  const blocks = questions.map((q) => {
    const answer = choiceText(q.choices[q.answerIndex]);
    return [
      `## ${q.questionText.replace(/\s*\n\s*/g, ' / ')}`,
      ...(q.pictureUrl ? [`Picture: ${q.pictureDescription ?? 'shown with the question'} (${q.pictureUrl})`] : []),
      `Choices: ${q.choices.map((c) => choiceText(c)).join(' | ')}`,
      `Answer: ${answerWords(answer, q.choices.map((c) => choiceText(c)))}${q.disputed ? ' (disputed)' : ''}`,
      `Language: ${q.lang}`,
      `URL: ${site}${questionPath(q.slug)}`,
    ].join('\n');
  });
  const body = `# Cojiro Quiz: Ocarina of Time Quiz answers (Zelda Notes)\n\nUnofficial, crowdsourced. ${questions.length} ${questions.length === 1 ? 'question' : 'questions'}.\n\n${blocks.join('\n\n')}\n`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=600' } });
};
