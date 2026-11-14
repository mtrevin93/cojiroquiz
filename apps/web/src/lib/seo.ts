import type { QuestionDTO } from '@cojiro/shared';
import { oneLine } from './text.ts';

export const SITE_NAME = 'Cojiro Quiz';
export const SITE_TAGLINE = 'Searchable answers for the Ocarina of Time companion app quizzes';

export function websiteJsonLd(siteUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: `${siteUrl}/`,
    description: SITE_TAGLINE,
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
