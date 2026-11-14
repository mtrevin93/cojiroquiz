import { describe, expect, it } from 'vitest';
import { buildSearchText, canonical, dedupeMaterial, matchesQuery } from '../src/index.ts';

const saria = "R A Y R A Y\nThis is the music score for Saria's Song.";

describe('search', () => {
  const st = buildSearchText([saria, 'Egg Level', 'X', '✓']);
  it('finds spaced letters as a word', () => expect(matchesQuery(st, 'ray')).toBe(true));
  it('finds saria', () => expect(matchesQuery(st, 'Saria')).toBe(true));
  it('matches all terms in any order', () => expect(matchesQuery(st, 'song rayray egg')).toBe(true));
  it('keeps apostrophes searchable both ways', () => {
    expect(matchesQuery(st, "saria's")).toBe(true);
    expect(matchesQuery(st, 'saria s song')).toBe(true);
  });
  it('rejects non-matches', () => expect(matchesQuery(st, 'zelda')).toBe(false));
  it('is accent-insensitive', () => {
    const es = buildSearchText(['¿Cuál es la canción de Saria?']);
    expect(matchesQuery(es, 'cancion')).toBe(true);
    expect(matchesQuery(es, 'canción')).toBe(true);
  });
  it('works for scripts without spaces', () => {
    const ja = buildSearchText(['サリアの歌の楽譜です。']);
    expect(matchesQuery(ja, 'サリア')).toBe(true);
  });
});

describe('dedupe', () => {
  it('ignores punctuation, case, whitespace and choice order', () => {
    expect(dedupeMaterial('en', saria, ['X', '✓'])).toBe(
      dedupeMaterial('en-US', "r a y r a y this is the music score for saria’s song", ['✓', 'x']),
    );
  });
  it('keeps near-identical statements apart', () => {
    expect(dedupeMaterial('en', saria, ['X', '✓'])).not.toBe(
      dedupeMaterial('en', saria.replace('R A Y R A Y', 'R Y A R Y A'), ['X', '✓']),
    );
  });
  it('keeps languages apart', () => {
    expect(dedupeMaterial('en', 'a', [])).not.toBe(dedupeMaterial('ja', 'a', []));
  });
  it('keeps symbol-only labels', () => expect(canonical('✓')).toBe('✓'));
  it('does not fold accents', () => expect(canonical('canción')).not.toBe(canonical('cancion')));
});
