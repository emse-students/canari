// @vitest-environment happy-dom
/**
 * A COMMENT, REPLY OR MENTION NOTIFICATION OPENS THE POST AT THAT COMMENT (backlog, notification
 * taps item 1). The push names the comment (`?comment=` on `/posts/[postId]`); this section scrolls
 * to its row once drawn and rings its bubble. happy-dom lays nothing out, so what is pinned is that
 * the scroll is asked of THAT row, once, and that the ring marks it and nothing else.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import PostComments from './PostComments.svelte';
import type { PostComment } from '$lib/posts/api';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const comment = (id: string, parentId: string | null = null) =>
  ({
    id,
    userId: 'u2',
    text: `text ${id}`,
    parentId,
    createdAt: new Date(0).toISOString(),
    likes: [],
  }) as unknown as PostComment;

function mountSection(comments: PostComment[], focusCommentId?: string) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostComments, {
    target,
    props: {
      comments,
      topLevelComments: comments.filter((c) => !c.parentId),
      commentText: '',
      submittingComment: false,
      postId: 'p1',
      currentUserId: 'u1',
      focusCommentId,
      onCommentTextChange: vi.fn(async () => {}),
      onAddComment: vi.fn(async () => 'sent' as const),
      onLikeComment: vi.fn(),
      onEditComment: vi.fn(async () => {}),
      onDeleteComment: vi.fn(async () => {}),
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

it('scrolls to the named reply and rings it, not its parent', async () => {
  const scrolled: string[] = [];
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
    this: HTMLElement
  ) {
    scrolled.push(this.id);
  });
  const target = mountSection([comment('c1'), comment('r1', 'c1'), comment('c2')], 'r1');
  await tick();
  await tick();
  expect(scrolled).toEqual(['comment-r1']);
  const rings = target.querySelectorAll('.ring-2');
  expect(rings).toHaveLength(1);
  expect(rings[0].closest('[id^="comment-"]')?.id).toBe('comment-r1');
});

it('does not move the page when no comment is named, or the named one is gone', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  mountSection([comment('c1')]);
  mountSection([comment('c1')], 'deleted');
  await tick();
  await tick();
  expect(scroll).not.toHaveBeenCalled();
});
