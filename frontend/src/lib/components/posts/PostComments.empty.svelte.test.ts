/**
 * OPENED FROM ZERO, THE COMMENT SECTION IS A COMPOSER AND NOTHING ELSE (user, 2026-10-01, Mi 9T).
 *
 * Measured at 436 px: the composer of a post with no comments sat 45 px under the action row,
 * three paddings stacked over an EMPTY list - the section's `py-4`, the list's `mb-4` and the input
 * area's `pt-3`. happy-dom lays nothing out, so what is pinned is the cause rather than the pixels:
 * no list element (and therefore no list gap) when there is nothing in it, and none of the three
 * paddings on the way to the input.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostComments from './PostComments.svelte';
import type { PostComment } from '$lib/posts/api';

// `Avatar` resolves a name and a picture on mount; stubbed, as `NotificationRow`'s test does, so the
// section never reaches the network and aborts noisily at teardown.
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
});

function mountSection(comments: PostComment[], showComments: boolean) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostComments, {
    target,
    props: {
      comments,
      topLevelComments: comments.filter((c) => !c.parentId),
      showComments,
      commentText: '',
      submittingComment: false,
      currentUserId: 'u1',
      onToggleComments: vi.fn(),
      onCommentTextChange: vi.fn(async () => {}),
      onAddComment: vi.fn(async () => {}),
      onLikeComment: vi.fn(),
      onEditComment: vi.fn(async () => {}),
      onDeleteComment: vi.fn(async () => {}),
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target.firstElementChild as HTMLElement;
}

it('draws no list and no list gap above the composer of a post nobody has commented on', () => {
  const section = mountSection([], true);
  expect(section.querySelector('.space-y-1')).toBeNull();
  expect(section.className).not.toContain('py-4');
  expect(section.querySelector('.pt-3')).toBeNull();
  expect(section.querySelector('[contenteditable], textarea, input')).not.toBeNull();
});

it('keeps the list, and the gap that separates it from the composer, once there are comments', () => {
  const comment = {
    id: 'c1',
    userId: 'u2',
    text: 'Bonjour',
    createdAt: new Date(0).toISOString(),
    likes: [],
  } as unknown as PostComment;
  const section = mountSection([comment], true);
  const list = section.querySelector('.space-y-1');
  expect(list).not.toBeNull();
  expect(list!.className).toContain('mb-3');
});
