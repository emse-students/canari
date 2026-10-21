/**
 * The comment writes of one surface, and the PAGING of its thread (`postCommentThread.svelte.ts`):
 * older threads are ADDED page by page from `GET /posts/:id/comments`, a held row is never replaced
 * by a page's copy, and a failure is said rather than swallowed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { addComment, fetchComments } from '$lib/posts/api';
import { PostCommentThread } from './postCommentThread.svelte';

vi.mock('$lib/moderation/muteCheck', () => ({
  assertNotMuted: vi.fn().mockResolvedValue(undefined),
  cachedMuteStatus: () => null,
}));

vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  fetchComments: vi.fn(),
  addComment: vi.fn(),
}));

const c = (n: number): PostComment => ({
  id: `c${n}`,
  userId: 'bob',
  text: `${n}`,
  parentId: null,
  likes: [],
  createdAt: '2026-10-19T00:00:00Z',
});

/** A thread over a post held in a variable, with the rows the host sees written down. */
function threadOn(post: PostEntity) {
  const state = { held: post, rows: [] as PostComment[][], failures: [] as string[] };
  const thread = new PostCommentThread({
    userId: () => 'alice',
    read: () => state.held,
    write: (next) => {
      state.held = next;
      state.rows.push(next.comments ?? []);
    },
    begin: () => {},
    end: () => {},
    answered: () => {},
    fail: (message) => state.failures.push(message),
  });
  return { thread, state };
}

const served = (over: Partial<PostComment>): PostComment => ({ ...c(1), id: 'real', ...over });

it('an anonymous comment is drawn without the writer account, and sent as anonymous', async () => {
  vi.mocked(addComment).mockResolvedValue({ ok: true, comment: served({ anonymous: true }) });
  const { thread, state } = threadOn({
    id: 'p',
    comments: [],
    commentCount: 0,
  } as unknown as PostEntity);

  await thread.add('hello', undefined, undefined, () => {}, { kind: 'anonymous' });

  const pendingRow = state.rows[0][0];
  expect(pendingRow.anonymous).toBe(true);
  expect(pendingRow.userId).toBeUndefined();
  expect(addComment).toHaveBeenLastCalledWith('p', {
    text: 'hello',
    parentId: undefined,
    media: undefined,
    anonymous: true,
  });
});

it('an association comment carries its card on the row and its id in the request', async () => {
  const association = { id: 'a1', name: 'BDE', slug: 'bde', logoUrl: null };
  vi.mocked(addComment).mockResolvedValue({ ok: true, comment: served({ association }) });
  const { thread, state } = threadOn({
    id: 'p',
    comments: [],
    commentCount: 0,
  } as unknown as PostEntity);

  await thread.add('hello', 'parent', undefined, () => {}, { kind: 'association', association });

  expect(state.rows[0][0].association).toEqual(association);
  expect(state.rows[0][0].userId).toBeUndefined();
  expect(addComment).toHaveBeenLastCalledWith('p', {
    text: 'hello',
    parentId: 'parent',
    media: undefined,
    associationId: 'a1',
  });
});

it('a personal comment (the default) is drawn under the reader and sends no identity field', async () => {
  vi.mocked(addComment).mockResolvedValue({ ok: true, comment: served({ userId: 'alice' }) });
  const { thread, state } = threadOn({
    id: 'p',
    comments: [],
    commentCount: 0,
  } as unknown as PostEntity);

  await thread.add('hello', undefined, undefined, () => {});

  expect(state.rows[0][0].userId).toBe('alice');
  expect(state.rows[0][0].anonymous).toBeUndefined();
  expect(addComment).toHaveBeenLastCalledWith('p', {
    text: 'hello',
    parentId: undefined,
    media: undefined,
  });
});

describe('paging', () => {
  const withRows = (n: number, extra: Partial<PostComment> = {}) =>
    ({
      id: 'p',
      comments: Array.from({ length: n }, (_, i) => ({ ...c(i), ...extra })),
      commentCount: 50,
    }) as unknown as PostEntity;
  const page = (from: number, to: number, nextCursor: number | null, hasMore: boolean) => ({
    comments: Array.from({ length: to - from }, (_, i) => c(from + i)),
    nextCursor,
    hasMore,
  });

  it('adds the older threads of a page and goes on from where it ended', async () => {
    vi.mocked(fetchComments)
      .mockResolvedValueOnce(page(20, 25, 7, true))
      .mockResolvedValueOnce(page(25, 27, null, false));
    const { thread, state } = threadOn(withRows(20));

    await thread.loadMore();
    expect(state.held.comments).toHaveLength(25);
    expect(thread.hasMore).toBe(true);
    expect(fetchComments).toHaveBeenLastCalledWith('p', {
      cursor: undefined,
      limit: 20,
      order: 'recent',
    });

    await thread.loadMore();
    expect(state.held.comments).toHaveLength(27);
    expect(thread.hasMore).toBe(false);
    expect(fetchComments).toHaveBeenLastCalledWith('p', { cursor: 7, limit: 20, order: 'recent' });
  });

  it("never replaces a row it already holds with the page's copy", async () => {
    // A heart tapped on c0 is newer than the page that was already in flight for it.
    const held = withRows(2);
    held.comments![0] = { ...c(0), likes: ['alice'] };
    vi.mocked(fetchComments).mockResolvedValue({
      comments: [c(0), c(1), c(2)],
      nextCursor: null,
      hasMore: false,
    });
    const { thread, state } = threadOn(held);

    await thread.loadMore();

    expect(state.held.comments).toHaveLength(3);
    expect(state.held.comments![0].likes).toEqual(['alice']);
  });

  it('asks nothing more once the server said there is no more, or while a page is on its way', async () => {
    vi.mocked(fetchComments).mockClear();
    vi.mocked(fetchComments).mockResolvedValue(page(20, 21, null, false));
    const { thread } = threadOn(withRows(20));

    await Promise.all([thread.loadMore(), thread.loadMore()]);
    expect(fetchComments).toHaveBeenCalledTimes(1);

    await thread.loadMore();
    expect(fetchComments).toHaveBeenCalledTimes(1);
  });

  it('says a failure, keeps what is shown, and can be asked again', async () => {
    vi.mocked(fetchComments).mockRejectedValueOnce(new Error('offline'));
    const { thread, state } = threadOn(withRows(20));

    await thread.loadMore();

    expect(state.held.comments).toHaveLength(20);
    expect(state.failures).toHaveLength(1);
    expect(thread.loadingMore).toBe(false);
    expect(thread.hasMore).toBeUndefined();
  });

  it('does not bring back a comment removed while the page was in flight', async () => {
    let release!: (p: Awaited<ReturnType<typeof fetchComments>>) => void;
    vi.mocked(fetchComments).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const { thread, state } = threadOn(withRows(20));

    const loading = thread.loadMore();
    // The deletion answers (here or on another surface) while the page, read before it, is out.
    thread.noteRemoved(['c25']);
    release({ comments: [c(24), c(25), c(26)], nextCursor: null, hasMore: false });
    await loading;

    const ids = (state.held.comments ?? []).map((row) => row.id);
    expect(ids).toContain('c24');
    expect(ids).toContain('c26');
    expect(ids).not.toContain('c25');
  });

  it('keeps the older rows it read when a fresher feed row replaces the newest few', async () => {
    vi.mocked(fetchComments).mockResolvedValueOnce(page(20, 25, null, false));
    const { thread, state } = threadOn(withRows(20));
    await thread.loadMore();
    expect(thread.hasPages).toBe(true);

    // The feed row: the newest three threads, one of them with a new heart.
    const adopted = withRows(3);
    adopted.comments![0] = { ...c(0), likes: ['zoe'] };
    const kept = thread.keepHeld(state.held, adopted);

    expect(kept.comments).toHaveLength(25);
    expect(kept.comments![0].likes).toEqual(['zoe']);
  });

  it('does not keep an older row that was removed meanwhile', async () => {
    vi.mocked(fetchComments).mockResolvedValueOnce(page(20, 25, null, false));
    const { thread, state } = threadOn(withRows(20));
    await thread.loadMore();
    thread.noteRemoved(['c22']);

    const kept = thread.keepHeld(state.held, withRows(3));

    expect((kept.comments ?? []).map((row) => row.id)).not.toContain('c22');
  });
});
