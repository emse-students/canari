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

  it('sends neither switch by default', () => {
    expect(buildListPostsSearchParams({ kind: 'reel' })).toBe('?kind=reel');
  });
});
