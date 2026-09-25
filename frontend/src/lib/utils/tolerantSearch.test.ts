import {
  MatchTier,
  bestTier,
  editTolerance,
  osaDistance,
  rankByTokens,
  searchTokens,
} from './tolerantSearch';

describe('tolerantSearch - the search contract, in the browser', () => {
  it('folds case and accents and splits on punctuation', () => {
    expect(searchTokens('Cœur  ÉCLATÉ, rouge!')).toEqual(['coeur', 'eclate', 'rouge']);
  });

  it('takes the edit budget from the SHORTER word: 0 up to 3, 1 up to 7, 2 from 8', () => {
    expect(editTolerance('chat', 'cha')).toBe(0);
    expect(editTolerance('chien', 'chiens')).toBe(1);
    expect(editTolerance('papillon', 'papillons')).toBe(2);
  });

  it('charges a swap of adjacent characters as one edit', () => {
    expect(osaDistance('jaen', 'jean', 1)).toBe(1);
    expect(osaDistance('chat', 'chien', 1)).toBe(2);
  });

  it('ranks exact before prefix before substring before typo, and charges only the typo', () => {
    expect(bestTier('coeur', ['coeur', 'rouge'])).toBe(MatchTier.EXACT);
    expect(bestTier('coe', ['coeur'])).toBe(MatchTier.PREFIX);
    expect(bestTier('eur', ['coeur'])).toBe(MatchTier.SUBSTRING);
    expect(bestTier('ceour', ['coeur'])).toBe(MatchTier.TYPO);
    // Three letters buy no edit: "cht" must not find "chat".
    expect(bestTier('cht', ['chat'])).toBeNull();
  });

  const items = [
    { name: 'visage qui pleure de rire', words: searchTokens('visage qui pleure de rire rire') },
    { name: 'coeur rouge', words: searchTokens('coeur rouge amour') },
    { name: 'coeur brise', words: searchTokens('coeur brisé tristesse') },
    { name: 'chat', words: searchTokens('chat animal') },
  ];
  const rank = (q: string) => rankByTokens(items, q, (i) => i.words).map((i) => i.name);

  it('is a conjunction: every typed word must match', () => {
    expect(rank('coeur rouge')).toEqual(['coeur rouge']);
    expect(rank('coeur')).toEqual(['coeur rouge', 'coeur brise']);
  });

  it('ignores word order and survives a typo', () => {
    expect(rank('rouge coeur')).toEqual(['coeur rouge']);
    expect(rank('ceour')).toEqual(['coeur rouge', 'coeur brise']);
  });

  it('puts the closest match first rather than only filtering', () => {
    expect(rank('ri')).toEqual(['visage qui pleure de rire', 'coeur brise']);
  });

  it('returns nothing for an empty query', () => {
    expect(rank('   ')).toEqual([]);
  });
});
