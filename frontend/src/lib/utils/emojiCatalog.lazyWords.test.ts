import { buildCatalog, type DatasetEntry } from './emojiCatalog';

/** An entry whose `tags` are read only by the folding of its search words, and counted. */
function countedEntry(reads: { tags: number }, emoji: string, order: number): DatasetEntry {
  return {
    emoji,
    annotation: 'visage',
    group: 0,
    order,
    get tags() {
      reads.tags++;
      return ['Cœur', 'Sourire'];
    },
  };
}

describe('buildCatalog folds search words on first read only', () => {
  it('folds nothing while the catalogue is built (the composer warm-up builds it on every first open)', () => {
    const reads = { tags: 0 };
    const catalog = buildCatalog([countedEntry(reads, '😀', 1), countedEntry(reads, '😃', 2)]);
    expect(catalog).toHaveLength(2);
    expect(reads.tags).toBe(0);
  });

  it('folds an entry once, when its words are first read, and keeps the answer', () => {
    const reads = { tags: 0 };
    const catalog = buildCatalog([countedEntry(reads, '😀', 1), countedEntry(reads, '😃', 2)]);
    const words = catalog[0].words;
    expect(words).toEqual(['visage', 'coeur', 'sourire']);
    expect(catalog[0].words).toBe(words);
    expect(reads.tags).toBe(1);
  });
});
