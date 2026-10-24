import { beforeEach, describe, expect, it } from 'vitest';
import {
  cachedGifPage,
  clearGifPageCache,
  GIF_PAGE_TTL_MS,
  rememberGifPage,
} from './gifSearchCache';

const page = { gifs: [], hasNext: true };

beforeEach(clearGifPageCache);

describe('gifSearchCache', () => {
  it('serves a page it read, by query (case and spaces ignored) and page number', () => {
    rememberGifPage('Cat ', 1, page, 1000);
    expect(cachedGifPage('cat', 1, 2000)).toBe(page);
    expect(cachedGifPage('cat', 2, 2000)).toBeNull();
    expect(cachedGifPage('dog', 1, 2000)).toBeNull();
  });

  it('forgets a page after the server-declared five minutes', () => {
    rememberGifPage('', 1, page, 0);
    expect(cachedGifPage('', 1, GIF_PAGE_TTL_MS)).toBe(page);
    expect(cachedGifPage('', 1, GIF_PAGE_TTL_MS + 1)).toBeNull();
  });

  it('keeps a bounded number of pages, oldest first out', () => {
    for (let i = 0; i < 50; i++) rememberGifPage(`q${i}`, 1, page, 0);
    expect(cachedGifPage('q0', 1, 1)).toBeNull();
    expect(cachedGifPage('q49', 1, 1)).toBe(page);
  });
});
