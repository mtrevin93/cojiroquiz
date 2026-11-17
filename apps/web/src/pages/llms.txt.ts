import type { APIRoute } from 'astro';
import { listSitemapEntries } from '@cojiro/db';
import { getEnv } from '../lib/env.ts';
import { getDb } from '../lib/services.ts';

/** llms.txt: a short plain-text guide to the site for AI assistants. */
export const GET: APIRoute = () => {
  const site = getEnv().siteUrl;
  const count = listSitemapEntries(getDb()).length;
  const body = `# Cojiro Quiz

> Answer key for the Ocarina of Time Quiz in Zelda Notes, the companion to The Legend of Zelda: Ocarina of Time remake on Nintendo Switch 2. Covers Egg Level, Cucco Level and Cojiro Challenge questions. Questions and answers are submitted by players as screenshots and stored exactly as the app shows them, in their original language. Unofficial fan site; answers are crowdsourced and may be wrong.

${count} ${count === 1 ? 'question' : 'questions'} so far.

## Find an answer

- [All questions and answers as plain text](${site}/llms-full.txt): one question per block, with its choices and the correct answer
- Search: ${site}/?q=WORDS returns every question containing all of the words (any order, any language)
- Each question has its own page at ${site}/q/ID-text with the correct answer, all choices and how many uploads confirm it

## Reading the answers

- "True (✓)" and "False (X)" are the two choices for statement questions
- Lines of single spaced letters such as "R A Y R A Y" are ocarina button sequences and are part of the question
- "Disputed" means uploads or reports disagree about the answer

## Other

- [Practice](${site}/practice): timed rounds of quiz questions, with missed ones repeated
- [Sitemap](${site}/sitemap.xml)
- [About](${site}/about)
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
};
