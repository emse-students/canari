/**
 * "Load all" adopts the post's own read with its rows as the count (`postCommentThread.svelte.ts`):
 * `GET /api/posts/:id` carries every comment and no `commentCount`, so a feed row's total (57, say,
 * with three since deleted) must not outlive the full thread of 54.
 */
import { expect, it, vi } from 'vitest';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { addComment, getPost } from '$lib/posts/api';
import { PostCommentThread } from './postCommentThread.svelte';
import { commentCountOf } from './commentChange';

vi.mock('$lib/moderation/muteCheck', () => ({
  assertNotMuted: vi.fn().mockResolvedValue(undefined),
  cachedMuteStatus: () => null,
}));

vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  getPost: vi.fn(),
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

it('after "load all", the count is the rows the full read carries', async () => {
  let held = {
    id: 'p',
    comments: Array.from({ length: 20 }, (_, i) => c(i)),
    commentCount: 57,
  } as PostEntity;
  vi.mocked(getPost).mockResolvedValue({
    id: 'p',
    comments: Array.from({ length: 54 }, (_, i) => c(i)),
  } as PostEntity);
  const thread = new PostCommentThread({
    userId: () => 'alice',
    read: () => held,
    write: (next) => (held = next),
    begin: () => {},
    end: () => {},
    answered: () => {},
    holdThread: () => {},
    adoptThread: (full) =>
      (held = { ...held, comments: full.comments, commentCount: full.commentCount }),
    fail: () => {},
  });

  await thread.loadAll();

  expect(held.comments).toHaveLength(54);
  expect(commentCountOf(held)).toBe(54);
});

/** A thread over a post held in a variable, with the rows the host sees written down. */
function threadOn(post: PostEntity) {
  const state = { held: post, rows: [] as PostComment[][] };
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
    holdThread: () => {},
    adoptThread: () => {},
    fail: () => {},
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
