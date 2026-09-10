import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_POST_FEED, POST_FEEDS, parsePostFeed } from './api';

/**
 * The feed vocabulary, which now has three readers: the `?feed=` query parameter, the persisted
 * preference in `localStorage`, and the tab bar. Two of the three hand it a string that came from
 * outside the program, so the narrowing is the only thing standing between them and a feed name
 * the API does not serve.
 */
describe('post feeds', () => {
  it('accepts every name it publishes, and the default is one of them', () => {
    for (const feed of POST_FEEDS) expect(parsePostFeed(feed)).toBe(feed);
    expect(POST_FEEDS).toContain(DEFAULT_POST_FEED);
  });

  // NULL AND NOT THE DEFAULT: the posts page tries the URL, then the remembered tab, then the
  // default, and a parser that answered `associations` to a miss would stop that chain at its
  // first link - a reader who had chosen `all` would be sent back to `associations` by any URL
  // with no `?feed=`, which is exactly the bug this feature exists to fix.
  it('says NOTHING rather than the default when the name is not a feed', () => {
    expect(parsePostFeed(null)).toBeNull();
    expect(parsePostFeed(undefined)).toBeNull();
    expect(parsePostFeed('')).toBeNull();
    expect(parsePostFeed('Associations')).toBeNull();
    expect(parsePostFeed('toString')).toBeNull();
  });

  /**
   * ONE PLACE RESOLVES THE FEED, AND IT IS `load`.
   *
   * The chain url -> preference -> default lives in `routes/posts/+page.ts`. The page component
   * had TWO more copies of it, both spelled `searchParams.get('feed') || 'associations'` - the
   * tab highlight and the pagination query. They agreed for as long as the URL always carried
   * `?feed=`, and stopped agreeing the day a bare `/posts` started meaning "the tab you chose
   * last": measured 2026-09-10, a reload with `followed` remembered fetched the followed feed
   * and drew Associations as selected.
   *
   * A source guard rather than a rendering test, because what must not come back is the LINE.
   * `process.cwd()` for the reason `layout/sessionExpiredRelease.test.ts` records.
   */
  it('leaves the resolution to `load` - the page never re-derives the feed', () => {
    const source = readFileSync(join(process.cwd(), 'src/routes/posts/+page.svelte'), 'utf8');
    // COMMENTS FIRST, and not as a convenience: the doc above the fixed line QUOTES the line it
    // replaced, so a guard reading the raw file fails on the explanation of the bug it guards.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/get\(['"]feed['"]\)/);
    // And it does use the resolved answer, so the guard cannot pass by the page dropping the
    // feature altogether.
    expect(code).toContain('data.feedParams');
  });
});
