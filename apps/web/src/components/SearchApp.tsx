import { matchesQuery } from '@cojiro/shared/normalize';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { langName } from '../lib/text.ts';
import { CloseIcon, SearchIcon } from './icons.tsx';
import QuestionCard, { type CardEntry } from './QuestionCard.tsx';

interface Props {
  entries: CardEntry[];
  languages: Array<{ value: string; count: number }>;
  initialQuery: string;
  /** '' means all languages. */
  initialLang: string;
}

const PAGE = 48;

function syncUrl(q: string, lang: string, explicitLang: boolean) {
  const url = new URL(window.location.href);
  if (q) url.searchParams.set('q', q);
  else url.searchParams.delete('q');
  if (explicitLang) url.searchParams.set('lang', lang || 'all');
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

export default function SearchApp({ entries, languages, initialQuery, initialLang }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [lang, setLang] = useState(initialLang);
  const [limit, setLimit] = useState(PAGE);
  const [hydrated, setHydrated] = useState(false);
  const explicitLang = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const deferredQuery = useDeferredValue(query);
  const multiLang = languages.length > 1;

  useEffect(() => {
    setHydrated(true);
    explicitLang.current = new URL(window.location.href).searchParams.has('lang');
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
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const matches = useMemo(
    () => entries.filter((e) => matchesQuery(e.searchText, deferredQuery)),
    [entries, deferredQuery],
  );
  const results = useMemo(() => (lang ? matches.filter((e) => e.lang === lang) : matches), [matches, lang]);
  const otherLangCount = matches.length - results.length;
  const shown = results.slice(0, limit);

  const update = (q: string, l: string) => {
    setQuery(q);
    setLang(l);
    setLimit(PAGE);
    syncUrl(q.trim(), l, explicitLang.current);
  };

  return (
    <div>
      <div className="search-sticky">
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
              placeholder="Type any word from the question"
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
          {multiLang && (
            <>
              <label className="sr-only" htmlFor="lang">
                Language
              </label>
              <select
                id="lang"
                name="lang"
                className="search-lang"
                value={lang || 'all'}
                onChange={(e) => {
                  explicitLang.current = true;
                  update(query, e.target.value === 'all' ? '' : e.target.value);
                }}
              >
                <option value="all">All languages</option>
                {languages.map((l) => (
                  <option key={l.value} value={l.value}>
                    {langName(l.value)} ({l.count})
                  </option>
                ))}
              </select>
            </>
          )}
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
        {lang && otherLangCount > 0 && (
          <>
            {' · '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                explicitLang.current = true;
                update(query, '');
              }}
            >
              {otherLangCount} more in other languages
            </button>
          </>
        )}
      </p>

      {shown.length > 0 ? (
        <ul className="card-grid">
          {shown.map((e) => (
            <li key={e.id}>
              <QuestionCard entry={e} showLang={multiLang} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty ornate">
          <p>
            {entries.length === 0
              ? 'No questions yet. Be the first to add one.'
              : 'No question matches that. If you are looking at it right now, add it for the next person.'}
          </p>
          <a className="btn" href="/upload">
            Upload a screenshot
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
