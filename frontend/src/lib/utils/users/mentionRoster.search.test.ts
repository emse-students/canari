/**
 * The roster matcher's two properties asked for on 2026-11-12: a multi-word query ("@Prenom NOM", in
 * either order, accents ignored), and a keystroke on a large population that folds no name it has
 * already folded. Every name here is fictional.
 */
import { describe, expect, it } from 'vitest';
import {
  findMentionQuery,
  MENTION_MAX_ROWS,
  MENTION_QUERY_MAX,
  MentionNameIndex,
  suggestFromRoster,
  wordsMatchQuery,
  type MentionRosterMember,
} from './mentionRoster';

const ROSTER: MentionRosterMember[] = [
  { id: 'jd', displayName: 'Jean Dupont' },
  { id: 'jm', displayName: 'Jeanne Martin' },
  { id: 'ed', displayName: 'Éloïse Durand' },
  { id: 'pl', displayName: "Paul-Émile L'Écuyer" },
];

function suggest(query: string, index?: MentionNameIndex) {
  return suggestFromRoster(ROSTER, query, { excludeIds: [], resolveName: () => null, index }).map(
    (r) => r.id
  );
}

describe('findMentionQuery', () => {
  it('reads a query with spaces after the last @', () => {
    expect(findMentionQuery('salut @Jean Dup')).toEqual({ start: 6, query: 'Jean Dup' });
  });

  it('starts at a bare @', () => {
    expect(findMentionQuery('salut @')).toEqual({ start: 6, query: '' });
  });

  it('is not a mention when a space follows the @ at once', () => {
    expect(findMentionQuery('salut @ ')).toBeNull();
  });

  it('never crosses a newline', () => {
    expect(findMentionQuery('@Jean\nDup')).toBeNull();
  });

  it('ends at a character a name cannot hold', () => {
    expect(findMentionQuery('a@b.')).toBeNull();
  });

  it('is not the inside of a stored @[id] token', () => {
    expect(findMentionQuery(`@[${'a'.repeat(64)}] `)).toBeNull();
  });

  it('gives up past the longest query', () => {
    expect(findMentionQuery(`@${'a'.repeat(MENTION_QUERY_MAX)}`)).not.toBeNull();
    expect(findMentionQuery(`@${'a'.repeat(MENTION_QUERY_MAX + 1)}`)).toBeNull();
  });
});

describe('wordsMatchQuery', () => {
  it('needs each query word to start a different word of the name', () => {
    expect(wordsMatchQuery(['jean', 'dupont'], ['jean', 'dup'])).toBe(true);
    expect(wordsMatchQuery(['jean', 'dupont'], ['dup', 'jean'])).toBe(true);
    expect(wordsMatchQuery(['jean', 'dupont'], ['jean', 'jean'])).toBe(false);
    expect(wordsMatchQuery(['jean', 'dupont'], ['jean', 'xyz'])).toBe(false);
  });
});

describe('suggestFromRoster with several words', () => {
  it('finds a first name followed by the start of a last name', () => {
    expect(suggest('Jean Dup')).toEqual(['jd']);
  });

  it('finds the last name first too', () => {
    expect(suggest('dupont jean')).toEqual(['jd']);
  });

  it('ignores case and accents on both sides', () => {
    expect(suggest('eloise DURAND')).toEqual(['ed']);
    expect(suggest('Élo')).toEqual(['ed']);
    expect(suggest('paul emile ecuyer')).toEqual(['pl']);
  });

  it('keeps every first-name match while only one word is typed, and a trailing space', () => {
    expect(suggest('jean').sort()).toEqual(['jd', 'jm']);
    expect(suggest('jean ').sort()).toEqual(['jd', 'jm']);
  });

  it('finds nobody for a second word nobody has', () => {
    expect(suggest('Jean xyz')).toEqual([]);
  });
});

describe('a large population', () => {
  const N = 5000;
  const big: MentionRosterMember[] = Array.from({ length: N }, (_, i) => ({
    id: `u${i}`,
    displayName: `Prénom${i % 97} Nom${i}`,
    lastSpokeAt: i % 13,
  }));

  it('folds each name once for the life of the picker, not once per keystroke', () => {
    const index = new MentionNameIndex();
    for (const q of ['', 'p', 'pr', 'pre', 'prenom1', 'prenom1 ', 'prenom1 n', 'prenom1 nom1']) {
      const rows = suggestFromRoster(big, q, { excludeIds: [], resolveName: () => null, index });
      expect(rows.length).toBeLessThanOrEqual(MENTION_MAX_ROWS);
    }
    expect(index.folds).toBe(N);
  });

  it('folds again only the member whose name changed', () => {
    const index = new MentionNameIndex();
    const named = big.slice(0, 10);
    suggestFromRoster(named, '', { excludeIds: [], resolveName: () => null, index });
    const renamed = named.map((m, i) => (i === 3 ? { ...m, displayName: 'Autre Nom' } : m));
    suggestFromRoster(renamed, 'a', { excludeIds: [], resolveName: () => null, index });
    expect(index.folds).toBe(11);
  });

  it('keeps the best rows in the full order without sorting every match', () => {
    const rows = suggestFromRoster(big, 'prenom', {
      excludeIds: [],
      resolveName: () => null,
    });
    // lastSpokeAt is i % 13: the latest speakers (12) first, then alphabetical on the folded name.
    const expected = big
      .filter((m) => m.lastSpokeAt === 12)
      .map((m) => ({ id: m.id, folded: m.displayName!.toLowerCase().replace('é', 'e') }))
      .sort((a, b) => a.folded.localeCompare(b.folded))
      .slice(0, MENTION_MAX_ROWS)
      .map((m) => m.id);
    expect(rows.map((r) => r.id)).toEqual(expected);
  });
});

describe('MentionNameIndex.retain', () => {
  it('keeps only the members named, so the index never outgrows the roster', () => {
    const index = new MentionNameIndex();
    index.entry('a', 'Alice Exemple');
    index.entry('b', 'Bruno Exemple');
    index.entry('c', 'Chloe Exemple');
    expect(index.retain(['b'])).toBe(2);
    expect(index.size).toBe(1);
    const folds = index.folds;
    index.entry('b', 'Bruno Exemple');
    expect(index.folds).toBe(folds);
  });
});
