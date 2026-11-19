import { buildSearchText, matchesQuery } from '@cojiro/shared/normalize';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CloseIcon, SearchIcon } from './icons.tsx';
import QuestionCard, { type CardEntry } from './QuestionCard.tsx';

interface Props {
  entries: CardEntry[];
  initialQuery: string;
  /** Language key of the questions in `entries`. Another language is another page load. */
  initialLang: string;
}

const PAGE = 48;

function syncUrl(q: string) {
  const url = new URL(window.location.href);
  if (q) url.searchParams.set('q', q);
  else url.searchParams.delete('q');
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

export default function SearchApp({ entries, initialQuery, initialLang }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [limit, setLimit] = useState(PAGE);
  const [hydrated, setHydrated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    setHydrated(true);
    // "/" focuses the search box (desktop habit), Escape clears it.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    // The search bar gets a backdrop only while it is pinned to the top.
    const io =
      sentinelRef.current && 'IntersectionObserver' in window
        ? new IntersectionObserver(([e]) => setStuck(!!e && !e.isIntersecting && e.boundingClientRect.top < 0))
        : null;
    if (io && sentinelRef.current) io.observe(sentinelRef.current);
    return () => {
      window.removeEventListener('keydown', onKey);
      io?.disconnect();
    };
  }, []);

  // Searchable text of the question alone, to rank "the question says this" above "a choice says this".
  // Entries arrive without their searchable text (it is bulky); build it on the first search.
  const searchable = useRef<Map<number, string> | null>(null);
  const matches = useMemo(() => {
    if (!deferredQuery.trim()) return entries;
    searchable.current ??= new Map(
      entries.map((e) => [
        e.id,
        e.searchText || buildSearchText([e.questionText, ...e.options.map((o) => o.label), ...(e.searchExtra ?? '').split('\n')]),
      ]),
    );
    const found = entries.filter((e) => matchesQuery(searchable.current!.get(e.id) ?? '', deferredQuery));
    const inQuestion = (e: CardEntry) => matchesQuery(buildSearchText([e.questionText]), deferredQuery);
    return [...found.filter(inQuestion), ...found.filter((e) => !inQuestion(e))];
  }, [entries, deferredQuery]);
  const results = matches;
  const lang = initialLang;
  const shown = results.slice(0, limit);

  const update = (q: string, _lang?: string) => {
    setQuery(q);
    setLimit(PAGE);
    syncUrl(q.trim());
  };
  return (
    <div>
      <div ref={sentinelRef} aria-hidden="true" />
      <div className={stuck ? 'search-sticky is-stuck' : 'search-sticky'}>
        <form
          className="search-form"
          role="search"
          action="/"
          method="get"
          onSubmit={(e) => {
            e.preventDefault();
            inputRef.current?.blur(); // drop the phone keyboard so results are visible
          }}
        >
          <div className="search-box">
            <SearchIcon />
            <label className="sr-only" htmlFor="q">
              Search questions
            </label>
            <input
              ref={inputRef}
              id="q"
              className="search-input"
              type="search"
              name="q"
              value={query}
              onChange={(e) => update(e.target.value, lang)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  update('', lang);
                }
              }}
              placeholder="Search questions"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            {query ? (
              <button
                type="button"
                className="search-clear"
                aria-label="Clear search"
                onClick={() => {
                  update('', lang);
                  inputRef.current?.focus();
                }}
              >
                <CloseIcon />
              </button>
            ) : (
              hydrated && (
                <kbd className="search-kbd" aria-hidden="true">
                  /
                </kbd>
              )
            )}
          </div>
          <noscript>
            <button type="submit" className="btn">
              Search
            </button>
          </noscript>
        </form>
      </div>

      <p className="search-status" role="status" aria-live="polite">
        {results.length === entries.length
          ? `${entries.length} ${entries.length === 1 ? 'question' : 'questions'}`
          : `${results.length} of ${entries.length} questions`}
      </p>

      {shown.length > 0 ? (
        <ul className="card-grid">
          {shown.map((e) => (
            <li key={e.id}>
              <QuestionCard entry={e} showLang={false} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">
          <img className="mascot" src="/cojiro.webp" alt="" width={148} height={140} />
          <p>
            {entries.length === 0
              ? 'No questions yet.'
              : 'No match.'}
          </p>
          <a className="btn" href="/upload">
            Add a screenshot
          </a>
        </div>
      )}

      {results.length > shown.length && (
        <div className="more-row">
          <button type="button" className="btn secondary" onClick={() => setLimit((n) => n + PAGE)}>
            Show more ({results.length - shown.length} left)
          </button>
        </div>
      )}
    </div>
  );
}
