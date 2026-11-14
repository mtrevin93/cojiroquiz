import type { SearchIndexEntry } from '@cojiro/shared';
import { langName, oneLine, slugify } from '../lib/text.ts';
import { CheckIcon } from './icons.tsx';

export type CardEntry = SearchIndexEntry & {
  answerImageWidth?: number | null;
  answerImageHeight?: number | null;
};

export function levelPath(level: string): string {
  return `/level/${encodeURIComponent(slugify(level) || level)}`;
}

export function questionPath(slug: string): string {
  return `/q/${encodeURIComponent(slug)}`;
}

/** The answer in the game's answer-box style. Used on cards and question pages. */
export function AnswerBox({
  label,
  choiceImageUrl,
  lang,
}: {
  label: string;
  choiceImageUrl: string | null;
  lang: string;
}) {
  return (
    <div className="answer ornate correct">
      <CheckIcon />
      {choiceImageUrl && (
        <img className="answer-choice-img" src={choiceImageUrl} alt={label} width={64} height={64} loading="lazy" decoding="async" />
      )}
      <div className="answer-main">
        <span className="answer-kicker">Answer</span>
        <span className="answer-text" lang={lang}>
          {label}
        </span>
      </div>
    </div>
  );
}

/** Result card echoing the quiz panel: header strip, dark question area, answer box. */
export default function QuestionCard({ entry, showLang = true }: { entry: CardEntry; showLang?: boolean }) {
  const href = questionPath(entry.slug);
  const w = entry.answerImageWidth || undefined;
  const h = entry.answerImageHeight || undefined;
  return (
    <article className="qcard">
      <header className="qcard-head">
        <a className="qcard-num" href={href} aria-label={`Question ${entry.id}: open page`}>
          Question <b>{entry.id}</b>
        </a>
        {entry.level && (
          <a className="qcard-level" href={levelPath(entry.level)} lang={entry.lang}>
            {entry.level}
          </a>
        )}
      </header>
      <a className="qcard-body" href={href}>
        <p className="qcard-text" lang={entry.lang}>
          {entry.questionText}
        </p>
      </a>
      <div className="qcard-foot">
        <div className="answer-row">
          <AnswerBox label={entry.answerLabel} choiceImageUrl={entry.answerChoiceImageUrl} lang={entry.lang} />
          {entry.answerImageUrl && (
            <a className="reveal-shot" href={href} title="Result screenshot: open the question page to see it full size">
              <img
                src={entry.answerImageUrl}
                alt={`Screenshot showing the correct answer “${entry.answerLabel}” to: ${oneLine(entry.questionText, 90)}`}
                width={w}
                height={h}
                loading="lazy"
                decoding="async"
              />
            </a>
          )}
        </div>
        {(showLang || entry.disputed) && (
          <div className="qcard-meta">
            {showLang && (
              <span className="tag" title={langName(entry.lang)}>
                {entry.lang}
              </span>
            )}
            {entry.disputed && (
              <span className="tag disputed" title="Uploads or reports disagree about this answer">
                Disputed answer
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
