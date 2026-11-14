import type { SearchIndexEntry } from '@cojiro/shared';
import { langName, oneLine, slugify } from '../lib/text.ts';
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
          <span className="notes" key={i} aria-label={line}>
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
function answerDisplay(label: string): { icon: 'check' | 'cross'; text: string; symbol: string | null } {
  const t = label.trim();
  if (/^[✓✔☑]$/u.test(t)) return { icon: 'check', text: 'True', symbol: '✓' };
  if (/^[xX✗✕✖×]$/u.test(t)) return { icon: 'cross', text: 'False', symbol: 'X' };
  return { icon: 'check', text: label, symbol: null };
}

/** The answer block. Used on cards and question pages. */
export function AnswerBox({
  label,
  choiceImageUrl,
  lang,
}: {
  label: string;
  choiceImageUrl: string | null;
  lang: string;
}) {
  const d = answerDisplay(label);
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

/** Result card: level, the question verbatim, then the answer. The whole card links to the question page. */
export default function QuestionCard({ entry, showLang = true }: { entry: CardEntry; showLang?: boolean }) {
  const href = questionPath(entry.slug);
  const w = entry.answerImageWidth || undefined;
  const h = entry.answerImageHeight || undefined;
  return (
    <article className="qcard">
      {(entry.level || showLang || entry.disputed) && (
        <div className="qcard-top">
          {entry.level && (
            <a className="qcard-level" href={levelPath(entry.level)} lang={entry.lang}>
              {entry.level}
            </a>
          )}
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
        <p className="qcard-text" lang={entry.lang}>
          <QuestionText text={entry.questionText} />
        </p>
      </a>
      <div className="qcard-answer">
        <AnswerBox label={entry.answerLabel} choiceImageUrl={entry.answerChoiceImageUrl} lang={entry.lang} />
        {entry.answerImageUrl && (
          <a className="reveal-shot" href={href} title="Result screenshot">
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
    </article>
  );
}
