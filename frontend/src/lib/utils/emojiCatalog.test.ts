import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMOJI_CATEGORIES, buildCatalog, withSkinTone, type DatasetEntry } from './emojiCatalog';
import { rankByTokens } from './tolerantSearch';

const dataset = (locale: 'fr' | 'en'): DatasetEntry[] =>
  JSON.parse(readFileSync(join(process.cwd(), `static/emoji-data-${locale}.json`), 'utf8'));

describe('emojiCatalog, built from the committed datasets', () => {
  const fr = buildCatalog(dataset('fr'));

  it('offers every entry but the component swatches, and every category', () => {
    const all = dataset('fr');
    expect(fr.length).toBe(all.filter((e) => e.group !== 2).length);
    expect(new Set(fr.map((e) => e.category))).toEqual(new Set(EMOJI_CATEGORIES));
  });

  it('keeps the dataset order', () => {
    expect(fr[0].emoji).toBe('😀');
  });

  it('applies one skin tone, and falls back to the default for an entry without skins', () => {
    const wave = fr.find((e) => e.emoji === '👋')!;
    expect(withSkinTone(wave, 0)).toBe('👋');
    expect(withSkinTone(wave, 3)).toBe('👋🏽');
    const cat = fr.find((e) => e.emoji === '🐈️')!;
    expect(withSkinTone(cat, 3)).toBe('🐈️');
  });

  it('gives a multi-person entry the variant where everyone has that tone', () => {
    const handshake = fr.find((e) => e.emoji === '🤝')!;
    expect(withSkinTone(handshake, 5)).toBe('🤝🏿');
  });

  it('finds French keywords, accents and ligatures folded, with a typo', () => {
    const find = (q: string) => rankByTokens(fr, q, (e) => e.words).map((e) => e.emoji);
    expect(find('coeur')).toContain('❤️');
    expect(find('cœur rouge')[0]).toBe('❤️');
    expect(find('chiien')).toContain('🐕️');
  });

  it('builds the English catalogue the same way', () => {
    const en = buildCatalog(dataset('en'));
    expect(en.length).toBe(fr.length);
    expect(rankByTokens(en, 'heart', (e) => e.words).map((e) => e.emoji)).toContain('❤️');
  });
});
