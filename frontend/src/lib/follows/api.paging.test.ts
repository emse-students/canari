/**
 * THE FOLLOW LISTS PAGE BY CURSOR (WP-F5 precondition): a list of any length is reachable whole,
 * page after page, each request naming where the previous one stopped - never an offset.
 */
import { describe, expect, it, vi } from 'vitest';

const social = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('$lib/posts/api', () => ({ socialRequest: social.request }));

import {
  FOLLOW_PAGE_SIZE,
  appendFollowPage,
  listFollowers,
  listFollowRequests,
  listSentFollowRequests,
  nextFollowCursor,
  type FollowListEntry,
} from './api';

const entries = (from: number, n: number): FollowListEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    userId: `u${from + i}`,
    createdAt: '2026-10-31T12:00:00Z',
    cursor: `c${from + i}`,
  }));

describe('follow list paging', () => {
  it('a full page continues after its last row; a short one is the last', () => {
    expect(nextFollowCursor(entries(0, FOLLOW_PAGE_SIZE))).toBe(`c${FOLLOW_PAGE_SIZE - 1}`);
    expect(nextFollowCursor(entries(0, 50))).toBeNull();
    expect(nextFollowCursor([])).toBeNull();
    // A server older than the cursor sends none: the list ends at its first page, never loops.
    const legacy = entries(0, FOLLOW_PAGE_SIZE).map(({ userId, createdAt }) => ({
      userId,
      createdAt,
    }));
    expect(nextFollowCursor(legacy)).toBeNull();
  });

  it.each([
    [listFollowRequests, '/api/posts/me/follow-requests'],
    [listFollowers, '/api/posts/me/followers'],
    [listSentFollowRequests, '/api/posts/me/follow-requests/sent'],
  ] as const)(
    '%o asks the first page, then after a cursor - never an offset',
    async (list, path) => {
      social.request.mockReset();
      social.request.mockResolvedValue([]);
      await list();
      await list('a+b/c=');
      expect(social.request.mock.calls.map((c) => c[0])).toEqual([
        `${path}?limit=${FOLLOW_PAGE_SIZE}`,
        `${path}?limit=${FOLLOW_PAGE_SIZE}&after=${encodeURIComponent('a+b/c=')}`,
      ]);
    }
  );

  it('a list of 250 is read whole in three pages, every person once', async () => {
    const server = entries(0, 250);
    social.request.mockReset();
    social.request.mockImplementation((url: string) => {
      const after = new URL(url, 'https://x').searchParams.get('after');
      const start = after === null ? 0 : server.findIndex((e) => e.cursor === after) + 1;
      return Promise.resolve(server.slice(start, start + FOLLOW_PAGE_SIZE));
    });
    let list = await listFollowers();
    let next = nextFollowCursor(list);
    let pages = 1;
    while (next) {
      const page = await listFollowers(next);
      list = appendFollowPage(list, page);
      next = nextFollowCursor(page);
      pages++;
    }
    expect(pages).toBe(3);
    expect(list.map((e) => e.userId)).toEqual(server.map((e) => e.userId));
  });

  it('appending keeps a person listed once', () => {
    expect(appendFollowPage(entries(0, 2), entries(1, 2)).map((e) => e.userId)).toEqual([
      'u0',
      'u1',
      'u2',
    ]);
  });
});
