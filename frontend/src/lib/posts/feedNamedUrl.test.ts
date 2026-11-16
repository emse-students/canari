import { describe, it, expect } from 'vitest';
import { feedNamedPath } from './feedNamedUrl';

const at = (path: string) => ({ href: `https://canari.test${path}` });

describe('feedNamedPath', () => {
  it('names the drawn tab on a bare address, so a Back reopens THAT list', () => {
    expect(feedNamedPath(at('/posts'), 'associations')).toBe('/posts?feed=associations');
    expect(feedNamedPath(at('/posts'), 'foryou')).toBe('/posts?feed=foryou');
  });

  it('keeps the other parameters and the hash', () => {
    expect(feedNamedPath(at('/posts?promo=3#x'), 'all')).toBe('/posts?promo=3&feed=all#x');
  });

  it('writes nothing when the address already names a tab, even another one than the preference', () => {
    expect(feedNamedPath(at('/posts?feed=all'), 'all')).toBeNull();
    expect(feedNamedPath(at('/posts?feed=followed'), 'foryou')).toBeNull();
  });

  it('replaces a value that names no feed, which load resolved from the preference', () => {
    expect(feedNamedPath(at('/posts?feed=nonsense'), 'associations')).toBe(
      '/posts?feed=associations'
    );
  });

  it('leaves a one-shot command to its own strip', () => {
    expect(feedNamedPath(at('/posts?compose=1'), 'all')).toBeNull();
    expect(feedNamedPath(at('/posts?search=1'), 'all')).toBeNull();
  });
});
