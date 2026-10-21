/**
 * "Load all" adopts the post's own read with its rows as the count (`postCommentThread.svelte.ts`):
 * `GET /api/posts/:id` carries every comment and no `commentCount`, so a feed row's total (57, say,
 * with three since deleted) must not outlive the full thread of 54.
 */
import { expect, it, vi } from 'vitest';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { getPost } from '$lib/posts/api';
import { PostCommentThread } from './postCommentThread.svelte';
import { commentCountOf } from './commentChange';

vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  getPost: vi.fn(),
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
