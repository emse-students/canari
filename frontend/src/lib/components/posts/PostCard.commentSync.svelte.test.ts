/**
 * A COMMENT WRITTEN IN THE REEL VIEWER'S SHEET REACHES THE CARD AS A CHANGE, AND THE CARD'S COUNT IS
 * THE SERVER'S TOTAL (`posts/commentChange.ts`).
 *
 * Pinned: a card holding the whole thread keeps every row when the sheet - whose copy is a feed row
 * of the newest twenty - announces a write (it used to ADOPT the sheet's list and collapse); a
 * removal takes only the named comment; the number on the card is `commentCount`, not the twenty
 * rows a feed row carries.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { publishPostComments } from '$lib/posts/postCommentThread.svelte';
import { apiFetch } from '$lib/utils/apiFetch';

vi.mock('$lib/utils/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/apiFetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function comment(n: number): PostComment {
  return {
    id: `c${n}`,
    userId: 'bob',
    text: `comment ${n}`,
    parentId: null,
    likes: [],
    createdAt: `2026-10-15T08:${String(n).padStart(2, '0')}:00.000Z`,
  };
}

function row(comments: PostComment[], commentCount: number): PostEntity {
  return {
    id: 'p1',
    markdown: 'A post',
    mentions: [],
    links: [],
    media: [],
    images: [],
    reactions: {},
    polls: [],
    comments,
    commentCount,
    createdAt: '2026-10-15T08:00:00.000Z',
    publishedAt: '2026-10-15T08:00:00.000Z',
    updatedAt: '2026-10-15T08:00:00.000Z',
  };
}

function mountCard(post: PostEntity) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(PostCard, {
    target,
    props: { post, currentUserId: 'alice', commentsOpen: true },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

const rows = (target: HTMLElement) => target.querySelectorAll('[id^="comment-"]').length;
/** The number the card's comment button shows. */
const shownCount = (target: HTMLElement) =>
  [...target.querySelectorAll('span.text-sm.font-medium')].map((s) => s.textContent?.trim());

const elsewhere = {};

it('shows the server total, not the twenty rows a feed row carries', () => {
  const target = mountCard(
    row(
      Array.from({ length: 20 }, (_, i) => comment(i)),
      57
    )
  );
  expect(shownCount(target)).toContain('57');
});

it("a comment written in the sheet is ADDED to a card holding the whole thread, never adopted as the sheet's list", () => {
  const target = mountCard(
    row(
      Array.from({ length: 25 }, (_, i) => comment(i)),
      25
    )
  );
  expect(rows(target)).toBe(25);

  publishPostComments('p1', { kind: 'upsert', comment: comment(40) }, elsewhere);
  flushSync();

  expect(rows(target)).toBe(26);
  expect(shownCount(target)).toContain('26');
});

it('a removal in the sheet takes only the named comment', () => {
  const target = mountCard(
    row(
      Array.from({ length: 25 }, (_, i) => comment(i)),
      25
    )
  );

  publishPostComments('p1', { kind: 'remove', ids: ['c3'], count: 1 }, elsewhere);
  flushSync();

  expect(rows(target)).toBe(24);
  expect(target.querySelector('#comment-c3')).toBeNull();
  expect(shownCount(target)).toContain('24');
});
