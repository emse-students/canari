// @vitest-environment happy-dom
/**
 * A COMMENT WRITTEN ON ANOTHER SURFACE REACHES THE CARD AS A CHANGE, THE CARD'S COUNT IS THE SERVER'S
 * TOTAL (`posts/commentChange.ts`), AND OLDER COMMENTS COME PAGE BY PAGE.
 *
 * The thread is read in the card's comment SHEET (a portal on `document.body`), so what is counted
 * here is read there. Pinned: the card keeps every row it holds when another surface announces a
 * write (it used to ADOPT that surface's list and collapse); a removal takes only the named
 * comment; the number on the card is `commentCount`, not the twenty rows a feed row carries; and a
 * page of older threads is ADDED to the rows held - never replacing one, never bringing back a
 * comment removed while it was in flight.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { publishPostComments } from '$lib/posts/postCommentThread.svelte';
import { apiFetch } from '$lib/utils/apiFetch';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../../test/flush';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

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

/** The comments the SHEET draws - it is a portal, so they are read from the document. */
const rows = () => document.body.querySelectorAll('[id^="comment-"]').length;
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

it("a comment written elsewhere is ADDED to the rows the card holds, never adopted as that surface's list", () => {
  const target = mountCard(
    row(
      Array.from({ length: 25 }, (_, i) => comment(i)),
      25
    )
  );
  expect(rows()).toBe(25);

  publishPostComments('p1', { kind: 'upsert', comment: comment(40) }, elsewhere);
  flushSync();

  expect(rows()).toBe(26);
  expect(shownCount(target)).toContain('26');
});

it('a removal elsewhere takes only the named comment', () => {
  const target = mountCard(
    row(
      Array.from({ length: 25 }, (_, i) => comment(i)),
      25
    )
  );

  publishPostComments('p1', { kind: 'remove', ids: ['c3'], count: 1 }, elsewhere);
  flushSync();

  expect(rows()).toBe(24);
  expect(document.body.querySelector('#comment-c3')).toBeNull();
  expect(shownCount(target)).toContain('24');
});

describe('older comments, read page by page (through the real ledger)', () => {
  /** What `GET /api/posts/p1/comments` answers once the test says so. */
  function servePage(): (rows: PostComment[]) => void {
    let answer!: (rows: PostComment[]) => void;
    const pending = new Promise<PostComment[]>((resolve) => (answer = resolve));
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/posts/p1/comments') && (init?.method ?? 'GET') === 'GET') {
        const comments = await pending;
        return new Response(JSON.stringify({ comments, nextCursor: null, hasMore: false }), {
          status: 200,
        });
      }
      return new Promise<Response>(() => {});
    });
    return answer;
  }

  /** The 5 older threads the server holds beyond the 25 a feed row carried. */
  const older = (extra: PostComment[] = []) => [
    ...Array.from({ length: 5 }, (_, i) => comment(25 + i)),
    ...extra,
  ];

  async function loadOlder() {
    const button = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.post_comment_load_older_label()
    )!;
    button.click();
    await flushMacrotask();
    flushSync();
  }

  async function settlePage() {
    for (let i = 0; i < 4; i++) await flushMacrotask();
    flushSync();
  }

  /** A feed row of 25 threads, of the 30 the server holds. */
  const mountWithOlder = () =>
    mountCard(
      row(
        Array.from({ length: 25 }, (_, i) => comment(i)),
        30
      )
    );

  it('adds the older threads to the rows held, a comment written since included', async () => {
    const answer = servePage();
    const target = mountWithOlder();
    publishPostComments('p1', { kind: 'upsert', comment: comment(40) }, elsewhere);
    flushSync();

    await loadOlder();
    answer(older());
    await settlePage();

    expect(rows()).toBe(31);
    expect(shownCount(target)).toContain('31');
  });

  it('does not undo a deletion answered while the page was out', async () => {
    const answer = servePage();
    const target = mountWithOlder();

    await loadOlder();
    publishPostComments('p1', { kind: 'remove', ids: ['c3'], count: 1 }, elsewhere);
    flushSync();
    // The page was read before the deletion answered, so it still carries c3.
    answer(older([comment(3)]));
    await settlePage();

    expect(document.body.querySelector('#comment-c3')).toBeNull();
    expect(rows()).toBe(29);
    expect(shownCount(target)).toContain('29');
  });

  it('keeps an addition answered while the page was out', async () => {
    const answer = servePage();
    const target = mountWithOlder();

    await loadOlder();
    publishPostComments('p1', { kind: 'upsert', comment: comment(40) }, elsewhere);
    flushSync();
    answer(older());
    await settlePage();

    expect(rows()).toBe(31);
    expect(shownCount(target)).toContain('31');
  });

  it('hides the button once the server said there is no more', async () => {
    const answer = servePage();
    mountWithOlder();
    await loadOlder();
    answer(older());
    await settlePage();

    const stillThere = [...document.body.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === m.post_comment_load_older_label()
    );
    expect(stillThere).toBe(false);
  });
});
