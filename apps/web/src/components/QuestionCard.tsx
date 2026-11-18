import type { SearchIndexEntry } from '@cojiro/shared';
import { langName, oneLine, slugify, trueFalse } from '../lib/text.ts';
import { CheckIcon, CrossIcon } from './icons.tsx';

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

/** A line made only of single spaced-out characters, e.g. "R A Y R A Y" (ocarina notes). */
const NOTE_LINE = /^(?:[\p{L}\p{N}▲▼◀▶←→↑↓]\s+){2,}[\p{L}\p{N}▲▼◀▶←→↑↓]$/u;

/**
 * Question text, verbatim. Lines of spaced-out single characters are drawn as
 * button chips; the characters and their order are unchanged.
 */
export function QuestionText({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <>
      {lines.map((line, i) =>
        NOTE_LINE.test(line) ? (
          <span className="notes" key={i} role="img" aria-label={line}>
            {line.split(/\s+/).map((ch, j) => (
              <span className="note" key={j} aria-hidden="true">
                {ch}
              </span>
            ))}
          </span>
        ) : (
          <span className="qline" key={i}>
            {line}
          </span>
        ),
      )}
    </>
  );
}

/** ✓ / X answers to a statement read better with a word next to the symbol. */
export function answerDisplay(
  label: string,
  allLabels: readonly string[],
): { icon: 'check' | 'cross'; text: string; symbol: string | null } {
  const tf = trueFalse(label, allLabels);
  if (tf === 'true') return { icon: 'check', text: 'True', symbol: '✓' };
  if (tf === 'false') return { icon: 'cross', text: 'False', symbol: 'X' };
  return { icon: 'check', text: label, symbol: null };
}

/** The answer block. Used on cards and question pages. */
export function AnswerBox({
  label,
  allLabels,
  choiceImageUrl,
  lang,
}: {
  label: string;
  /** Every choice of the question, to tell a True / False pair from a plain "X". */
  allLabels: readonly string[];
  choiceImageUrl: string | null;
  lang: string;
}) {
  // A picture answer without a name: the check mark on the picture is the answer.
  if (!label.trim()) return null;
  const d = answerDisplay(label, allLabels);
  return (
    <div className="answer">
      <span className="answer-badge">{d.icon === 'cross' ? <CrossIcon /> : <CheckIcon />}</span>
      {choiceImageUrl && (
        <img className="answer-choice-img" src={choiceImageUrl} alt={label} width={64} height={64} loading="lazy" decoding="async" />
      )}
      <div className="answer-main">
        <span className="answer-kicker">Answer</span>
        <span className="answer-text" lang={d.symbol ? undefined : lang}>
          {d.text}
          {d.symbol && <span className="answer-symbol"> ({d.symbol})</span>}
        </span>
      </div>
    </div>
  );
}

/** Result card: the question verbatim, then the answer. The whole card links to the question page. */
export default function QuestionCard({ entry, showLang = true }: { entry: CardEntry; showLang?: boolean }) {
  const href = questionPath(entry.slug);
  const w = entry.answerImageWidth || undefined;
  const h = entry.answerImageHeight || undefined;
  return (
    <article className="qcard">
      {(showLang || entry.disputed) && (
        <div className="qcard-top">
          {entry.disputed && (
            <span className="tag disputed" title="Uploads or reports disagree about this answer">
              Disputed
            </span>
          )}
          {showLang && (
            <span className="tag lang-tag" title={langName(entry.lang)}>
              {entry.lang}
            </span>
          )}
        </div>
      )}
      <a className="qcard-link" href={href}>
        {entry.pictureUrl && (
          <img className="qcard-picture" src={entry.pictureUrl} alt="Picture shown with the question" loading="lazy" decoding="async" />
        )}
        <p className="qcard-text" lang={entry.lang}>
          <QuestionText text={entry.questionText} />
        </p>
      </a>
      {entry.choicePictures.length > 0 && (
        <ul className={entry.choicePictures.length > 2 ? 'choice-pics is-grid' : 'choice-pics'} aria-label="Choices">
          {entry.choicePictures.map((c, i) => (
            <li key={i} className={c.correct ? 'is-right' : undefined}>
              <img src={c.url} alt={c.correct ? `${c.label} (correct answer)` : c.label} loading="lazy" decoding="async" />
              {c.correct && (
                <span className="choice-pics-mark">
                  <CheckIcon />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {entry.choicePictures.length > 0 ? (
        entry.answerLabel.trim() !== '' && (
        <div className="qcard-answer">
          <AnswerBox label={entry.answerLabel} allLabels={entry.options.map((o) => o.label)} choiceImageUrl={null} lang={entry.lang} />
        </div>
        )
      ) : (
        <ul className="opts" lang={entry.lang} aria-label="Choices">
          {entry.options.map((o, i) => {
            const d = answerDisplay(o.label, entry.options.map((x) => x.label));
            return (
              <li key={i} className={o.correct ? 'is-right' : undefined}>
                {o.correct && (
                  <span className="opts-mark">
                    <CheckIcon />
                  </span>
                )}
                <span>
                  {d.text}
                  {d.symbol && <span className="answer-symbol"> ({d.symbol})</span>}
                  {o.correct && <span className="sr-only"> (correct answer)</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
