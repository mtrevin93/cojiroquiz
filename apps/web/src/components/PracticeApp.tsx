import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ENDLESS_BATCH,
  ROUND_MODES,
  parseMode,
  parseProgress,
  pickRound,
  record,
  shuffle,
  withShuffledChoices,
  type PracticeQuestion,
  type Progress,
  type RoundMode,
} from '../lib/practice.ts';
import { CheckIcon, CrossIcon } from './icons.tsx';
import { answerDisplay, questionPath, QuestionText } from './QuestionCard.tsx';
import ReportButton from './ReportButton.tsx';

interface Props {
  questions: PracticeQuestion[];
  initialLang: string;
  seconds: number;
}

/** One answered question in the current round. `picked` is null when time ran out. */
interface Result {
  question: PracticeQuestion;
  picked: number | null;
  correct: boolean;
}

type Phase = 'start' | 'question' | 'reveal' | 'summary';

const STORE_KEY = 'cojiro.practice.v1';
const MODE_KEY = 'cojiro.practice.mode';
const modeName = (m: RoundMode) => (m === 'endless' ? 'Endless' : String(m));
/** A correct answer moves on by itself; a miss waits so the right answer can be read. */
const ADVANCE_MS = 1100;
/** The clock waits for the pictures, but not forever on a slow connection. */
const IMAGE_WAIT_MS = 2500;

function imageUrls(q: PracticeQuestion): string[] {
  return [q.pictureUrl, ...q.choices.map((c) => c.imageUrl)].filter((u): u is string => !!u);
}

function loadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
  });
}

function ChoiceLabel({ label, of }: { label: string; of: PracticeQuestion }) {
  const d = answerDisplay(label, of.choices.map((c) => c.label), of.lang);
  return (
    <>
      {d.text}
      {d.symbol && <span className="answer-symbol"> ({d.symbol})</span>}
    </>
  );
}

export default function PracticeApp({ questions, initialLang, seconds }: Props) {
  const lang = initialLang;
  const [phase, setPhase] = useState<Phase>('start');
  const [mode, setMode] = useState<RoundMode>(10);
  /** True while the current run keeps adding questions until the player ends it. */
  const [endless, setEndless] = useState(false);
  const [progress, setProgress] = useState<Progress>({});
  const [round, setRound] = useState<PracticeQuestion[]>([]);
  const [roundNo, setRoundNo] = useState(0);
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  /** False while the current question's pictures are still loading; the clock has not started. */
  const [ready, setReady] = useState(false);
  const nextRef = useRef<HTMLButtonElement>(null);

  // The page sends one language's questions; another language is another page load.
  const pool = questions;
  const current = round[index];
  const last = results[results.length - 1];
  const answered = phase === 'reveal' && last?.question === current ? last : null;

  useEffect(() => {
    try {
      setProgress(parseProgress(window.localStorage.getItem(STORE_KEY)));
      setMode(parseMode(window.localStorage.getItem(MODE_KEY)));
    } catch {
      /* storage blocked: progress just lasts for this visit */
    }
  }, []);

  const save = (next: Progress) => {
    setProgress(next);
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const chooseMode = (m: RoundMode) => {
    setMode(m);
    try {
      window.localStorage.setItem(MODE_KEY, String(m));
    } catch {
      /* ignore */
    }
  };

  const begin = (qs: PracticeQuestion[], keepGoing = false) => {
    if (qs.length === 0) return;
    setEndless(keepGoing);
    setRound(qs);
    setRoundNo((n) => n + 1);
    setIndex(0);
    setResults([]);
    setReady(false);
    setPhase('question');
  };
  const newRound = () => begin(pickRound(pool, progress, mode === 'endless' ? ENDLESS_BATCH : mode), mode === 'endless');
  const missed = results.filter((r) => !r.correct).map((r) => r.question);
  const retryMissed = () => begin(shuffle(missed).map((q) => withShuffledChoices(q)));

  const answer = useCallback(
    (picked: number | null) => {
      if (phase !== 'question' || !current) return;
      const correct = picked !== null && !!current.choices[picked]?.correct;
      setResults((r) => [...r, { question: current, picked, correct }]);
      save(record(progress, current.id, correct, Date.now()));
      setPhase('reveal');
    },
    [phase, current, progress],
  );

  const next = useCallback(() => {
    if (phase !== 'reveal') return;
    let total = round.length;
    if (endless && index + 1 >= round.length) {
      // Line up the next few, leaving out everything already asked in this run while unasked ones remain.
      const more = pickRound(pool, progress, ENDLESS_BATCH, Math.random, new Set(round.slice(-ENDLESS_BATCH).map((q) => q.id)));
      if (more.length > 0) {
        setRound([...round, ...more]);
        total += more.length;
      }
    }
    if (index + 1 < total) {
      setIndex(index + 1);
      setReady(false);
      setPhase('question');
    } else {
      setPhase('summary');
    }
  }, [phase, index, round, endless, pool, progress]);

  // Start the clock once the pictures are on screen; warm up the next question's pictures.
  useEffect(() => {
    if (phase !== 'question' || !current) return;
    let live = true;
    const urls = imageUrls(current);
    const go = () => live && setReady(true);
    if (urls.length === 0) go();
    else {
      const cap = window.setTimeout(go, IMAGE_WAIT_MS);
      void Promise.all(urls.map(loadImage)).then(() => {
        window.clearTimeout(cap);
        go();
      });
    }
    const upcoming = round[index + 1];
    if (upcoming) imageUrls(upcoming).forEach((u) => void loadImage(u));
    return () => {
      live = false;
    };
  }, [phase, current, round, index]);

  // Time limit.
  useEffect(() => {
    if (phase !== 'question' || !ready) return;
    const t = window.setTimeout(() => answer(null), seconds * 1000);
    return () => window.clearTimeout(t);
  }, [phase, ready, seconds, answer]);

  // After the answer: move on by itself when right, otherwise put focus on Next.
  useEffect(() => {
    if (!answered) return;
    if (!answered.correct) {
      nextRef.current?.focus({ preventScroll: true });
      return;
    }
    const t = window.setTimeout(next, ADVANCE_MS);
    return () => window.clearTimeout(t);
  }, [answered, next]);

  // Number keys pick a choice.
  useEffect(() => {
    if (phase !== 'question' || !ready || !current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= current.choices.length) answer(n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, ready, current, answer]);

  if (pool.length === 0) {
    return (
      <div className="practice">
        <div className="empty">
          <img className="mascot" src="/cojiro.webp" alt="" width={148} height={140} />
          <p>No questions yet.</p>
          <a className="btn" href="/upload">
            Add a screenshot
          </a>
        </div>
      </div>
    );
  }

  const seenCount = pool.filter((q) => progress[q.id]).length;

  if (phase === 'start') {
    return (
      <div className="practice practice-start">
        <img className="mascot" src="/cojiro.webp" alt="" width={148} height={140} />
        <h1>Practice</h1>
        <div className="practice-modes" role="radiogroup" aria-label="Number of questions">
          {ROUND_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? 'practice-mode is-on' : 'practice-mode'}
              onClick={() => chooseMode(m)}
            >
              {modeName(m)}
            </button>
          ))}
        </div>
        <p className="practice-rules">
          {mode === 'endless' ? 'Keeps going until you end it.' : `${Math.min(mode, pool.length)} questions.`} {seconds} seconds each.
        </p>
        <button type="button" className="btn practice-go" onClick={newRound}>
          Start
        </button>
        {seenCount > 0 && (
          <p className="practice-seen">
            {seenCount} of {pool.length} questions seen{' · '}
            <button type="button" className="link-btn" onClick={() => save({})}>
              Reset
            </button>
          </p>
        )}
      </div>
    );
  }

  if (phase === 'summary') {
    const right = results.length - missed.length;
    const seen = pool.filter((q) => progress[q.id]).length;
    return (
      <div className="practice practice-summary" key={`summary-${roundNo}`}>
        <p className="practice-score" aria-label={`${right} of ${results.length} correct`}>
          <span>{right}</span>
          <span className="practice-score-of">/ {results.length}</span>
        </p>
        {missed.length > 0 ? (
          <>
            <h2 className="practice-missed-title">Missed</h2>
            <ul className="practice-missed">
              {missed.map((q, i) => {
                const a = q.choices.find((c) => c.correct)!;
                return (
                  <li key={q.id} style={{ animationDelay: `${120 + i * 70}ms` }}>
                    <a href={questionPath(q.slug)} lang={q.lang}>
                      {q.pictureUrl && <img className="practice-missed-pic" src={q.pictureUrl} alt="" loading="lazy" />}
                      <span className="practice-missed-q">
                        <QuestionText text={q.text} />
                      </span>
                      <span className="practice-missed-a">
                        {a.imageUrl && <img src={a.imageUrl} alt="" loading="lazy" />}
                        <span className="opts-mark">
                          <CheckIcon />
                        </span>
                        <span>
                          <ChoiceLabel label={a.label} of={q} />
                        </span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <img className="mascot" src="/cojiro.webp" alt="" width={148} height={140} />
        )}
        <div className="practice-actions">
          {missed.length > 0 && (
            <button type="button" className="btn" onClick={retryMissed} autoFocus>
              Try missed again
            </button>
          )}
          <button type="button" className={missed.length > 0 ? 'btn secondary' : 'btn'} onClick={newRound} autoFocus={missed.length === 0}>
            New round
          </button>
        </div>
        <p className="practice-seen">
          {seen} of {pool.length} questions seen
          {seen > 0 && (
            <>
              {' · '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  save({});
                  setPhase('start');
                }}
              >
                Reset
              </button>
            </>
          )}
        </p>
      </div>
    );
  }

  if (!current) return null;
  const pictures = current.choices.every((c) => c.imageUrl);
  const rightCount = results.filter((r) => r.correct).length;
  const status = !answered ? '' : answered.correct ? 'Correct' : answered.picked === null ? "Time's up" : 'Wrong';

  return (
    <div className="practice">
      <div className="practice-hud">
        {endless || round.length > 10 ? (
          <div className="practice-count">
            <span aria-label={endless ? `Question ${index + 1}` : `Question ${index + 1} of ${round.length}`}>
              {index + 1}
              {!endless && <span className="practice-count-of"> / {round.length}</span>}
            </span>
            <span className="practice-tally" aria-label={`${rightCount} right, ${results.length - rightCount} wrong`}>
              <span className="is-right">
                <CheckIcon /> {rightCount}
              </span>
              <span className="is-wrong">
                <CrossIcon /> {results.length - rightCount}
              </span>
            </span>
            {endless && (
              <button type="button" className="btn small secondary" onClick={() => setPhase('summary')}>
                End
              </button>
            )}
          </div>
        ) : (
          <ol className="practice-dots" aria-label={`Question ${index + 1} of ${round.length}`}>
            {round.map((q, i) => {
              const r = results[i];
              return <li key={q.id} className={r ? (r.correct ? 'is-right' : 'is-wrong') : i === index ? 'is-now' : undefined} />;
            })}
          </ol>
        )}
        <div className={`practice-timer${answered ? ' is-stopped' : ''}`} aria-hidden="true">
          <span
            key={`${roundNo}-${index}`}
            className={ready ? 'is-running' : undefined}
            style={{ animationDuration: `${seconds}s` }}
          />
        </div>
      </div>

      <div className="practice-stage" key={`${roundNo}-${index}`}>
        <div className="practice-q" lang={current.lang}>
          {current.pictureUrl && <img className="practice-q-pic" src={current.pictureUrl} alt="Picture shown with the question" />}
          <p className="practice-q-text">
            <QuestionText text={current.text} />
          </p>
        </div>

        <ul className={pictures ? 'practice-choices is-pictures' : 'practice-choices'} lang={current.lang}>
          {current.choices.map((c, i) => {
            const state = !answered
              ? ''
              : c.correct
                ? ' is-right'
                : answered.picked === i
                  ? ' is-wrong'
                  : ' is-dim';
            return (
              <li key={i} style={{ animationDelay: `${90 + i * 55}ms` }}>
                <button
                  type="button"
                  className={`practice-choice${state}${answered?.picked === i ? ' is-picked' : ''}`}
                  onClick={() => answer(i)}
                  disabled={!!answered || !ready}
                  aria-label={c.imageUrl && !answered ? `Picture ${i + 1}` : undefined}
                >
                  {c.imageUrl ? (
                    <>
                      <img src={c.imageUrl} alt="" />
                      {answered && (
                        <span className="practice-choice-name">
                          <ChoiceLabel label={c.label} of={current} />
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="practice-choice-text">
                      <ChoiceLabel label={c.label} of={current} />
                    </span>
                  )}
                  {answered && c.correct && (
                    <span className="practice-mark is-right">
                      <CheckIcon />
                    </span>
                  )}
                  {answered && !c.correct && answered.picked === i && (
                    <span className="practice-mark is-wrong">
                      <CrossIcon />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="practice-foot">
          <p className={`practice-status${answered ? (answered.correct ? ' is-right' : ' is-wrong') : ''}`} role="status">
            {status}
          </p>
          {answered && !answered.correct && (
            <div className="practice-foot-actions">
              <ReportButton questionId={current.id} />
              <button type="button" className="btn" ref={nextRef} onClick={next}>
                {endless || index + 1 < round.length ? 'Next' : 'Finish'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
