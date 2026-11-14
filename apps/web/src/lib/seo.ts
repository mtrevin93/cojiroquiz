import type { QuestionDTO } from '@cojiro/shared';
import { oneLine } from './text.ts';

export const SITE_NAME = 'Cojiro Quiz';
export const SITE_TAGLINE = 'Ocarina of Time Quiz answers for Zelda Notes';
/** Home page <title>: the phrases people search for, most important first. */
export const HOME_TITLE = 'Ocarina of Time Quiz Answers (Zelda Notes) | Cojiro Quiz';
export const SITE_DESCRIPTION =
  'Answers to the Ocarina of Time Quiz in Zelda Notes: Egg Level, Cucco Level and Cojiro Challenge. Search any word from the question to get the answer.';

/** "✓" and "X" read as True / False in titles and descriptions. */
export function answerWords(label: string): string {
  const t = label.trim();
  if (/^[✓✔☑]$/u.test(t)) return 'True (✓)';
  if (/^[xX✗✕✖×]$/u.test(t)) return 'False (X)';
  return label;
}

export function websiteJsonLd(siteUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    alternateName: ['Ocarina of Time Quiz answers', 'Zelda Notes quiz answers', 'OoT quiz cheat sheet'],
    url: `${siteUrl}/`,
    description: SITE_DESCRIPTION,
    inLanguage: 'en',
    about: { '@type': 'VideoGame', name: 'The Legend of Zelda: Ocarina of Time' },
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl}/?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
}

export function qaPageJsonLd(siteUrl: string, q: QuestionDTO, answerText: string) {
  const url = `${siteUrl}/q/${encodeURIComponent(q.slug)}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'QAPage',
    mainEntity: {
      '@type': 'Question',
      name: oneLine(q.questionText, 200),
      text: q.questionText,
      inLanguage: q.lang,
      answerCount: 1,
      datePublished: new Date(q.createdAt).toISOString(),
      acceptedAnswer: {
        '@type': 'Answer',
        text: answerText,
        url,
        upvoteCount: q.submissionCount,
        datePublished: new Date(q.updatedAt).toISOString(),
      },
    },
  };
}
