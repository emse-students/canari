/**
 * The feed a list request runs: `reels` is the CanaReels viewer, and the shape every installed
 * client sends for it - `kind=reel` with no feed, or `all` - is read as `reels` (the shim in
 * docs/wiki/legacy-compatibility.md). No tab sends `kind`, so no tab is moved by it.
 */
import { listKind, resolveListFeed } from './list-feed';

describe('resolveListFeed', () => {
  it('reads an installed client\'s viewer request (kind=reel, no feed) as "reels"', () => {
    expect(resolveListFeed(undefined, 'reel')).toEqual({ feed: 'reels', legacyViewerShape: true });
    expect(resolveListFeed('all', 'reel')).toEqual({ feed: 'reels', legacyViewerShape: true });
  });

  it('serves "reels" as asked, and never moves a tab', () => {
    expect(resolveListFeed('reels', 'reel')).toEqual({ feed: 'reels', legacyViewerShape: false });
    expect(resolveListFeed('reels', undefined)).toEqual({
      feed: 'reels',
      legacyViewerShape: false,
    });
    expect(resolveListFeed(undefined, undefined)).toEqual({
      feed: 'all',
      legacyViewerShape: false,
    });
    expect(resolveListFeed('all', 'post')).toEqual({ feed: 'all', legacyViewerShape: false });
    for (const feed of ['followed', 'associations', 'custom'] as const) {
      expect(resolveListFeed(feed, 'reel')).toEqual({ feed, legacyViewerShape: false });
    }
  });
});

describe('listKind', () => {
  it('is always "reel" on the viewer, whatever was asked, and the request\'s own elsewhere', () => {
    expect(listKind({ feed: 'reels', kind: undefined })).toBe('reel');
    expect(listKind({ feed: 'reels', kind: 'post' })).toBe('reel');
    expect(listKind({ feed: 'all', kind: undefined })).toBeUndefined();
    expect(listKind({ feed: 'followed', kind: 'post' })).toBe('post');
  });
});
