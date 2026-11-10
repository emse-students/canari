import { describe, expect, it } from 'vitest';
import { buildListPostsSearchParams } from './api';

describe('buildListPostsSearchParams', () => {
  it('asks for pictures AND videos with the new switch, and the old one for an older server', () => {
    const q = new URLSearchParams(
      buildListPostsSearchParams({ kind: 'reel', singleMedia: true, feed: 'all', limit: 10 })
    );
    expect(q.get('kind')).toBe('reel');
    expect(q.get('singleMedia')).toBe('true');
    expect(q.get('singlePhotos')).toBe('true');
  });

  it('asks for carousels with the newest switch, and both older ones for older servers', () => {
    const q = new URLSearchParams(
      buildListPostsSearchParams({ kind: 'reel', multiMedia: true, feed: 'all', limit: 10 })
    );
    expect(q.get('multiMedia')).toBe('true');
    expect(q.get('singleMedia')).toBe('true');
    expect(q.get('singlePhotos')).toBe('true');
  });

  it('asks for posts with a link only alongside the carousels', () => {
    const withCarousels = new URLSearchParams(
      buildListPostsSearchParams({ kind: 'reel', multiMedia: true, withLinks: true, limit: 10 })
    );
    expect(withCarousels.get('withLinks')).toBe('true');
    expect(withCarousels.get('multiMedia')).toBe('true');
    const alone = new URLSearchParams(
      buildListPostsSearchParams({ kind: 'reel', singleMedia: true, withLinks: true, limit: 10 })
    );
    expect(alone.get('withLinks')).toBeNull();
  });

  it('sends neither switch by default', () => {
    expect(buildListPostsSearchParams({ kind: 'reel' })).toBe('?kind=reel');
  });

  it('asks the ranked lists of an estate that serves them, with their snapshot', () => {
    const forYou = new URLSearchParams(
      buildListPostsSearchParams({ feed: 'foryou', rankedFeeds: true, offset: 4, asOf: 'T' })
    );
    expect(forYou.get('feed')).toBe('foryou');
    expect(forYou.get('asOf')).toBe('T');
    const tail = new URLSearchParams(
      buildListPostsSearchParams({
        feed: 'foryou',
        rankedFeeds: true,
        offset: 30,
        asOf: 'T',
        cursor: 'C',
      })
    );
    expect(tail.get('cursor')).toBe('C');
    // A cursor is never sent without the ranking it belongs to.
    expect(
      new URLSearchParams(
        buildListPostsSearchParams({ feed: 'foryou', rankedFeeds: true, cursor: 'C' })
      ).get('cursor')
    ).toBeNull();
    const reels = new URLSearchParams(
      buildListPostsSearchParams({ feed: 'reels', kind: 'reel', ranked: true, rankedFeeds: true })
    );
    expect(reels.get('feed')).toBe('reels');
    expect(reels.get('ranked')).toBe('true');
  });

  it('asks an older estate the shapes it serves: Suivis for Pour toi, the old CanaReels list', () => {
    const forYou = new URLSearchParams(
      buildListPostsSearchParams({ feed: 'foryou', rankedFeeds: false, asOf: 'T' })
    );
    expect(forYou.get('feed')).toBe('followed');
    expect(forYou.get('asOf')).toBeNull();
    expect(
      buildListPostsSearchParams({ feed: 'reels', kind: 'reel', ranked: true, rankedFeeds: false })
    ).toBe('?kind=reel');
  });
});
