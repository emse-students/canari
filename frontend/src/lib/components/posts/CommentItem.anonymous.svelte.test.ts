// @vitest-environment happy-dom
/**
 * WHO A COMMENT SAYS WROTE IT (user, 2026-10-24): an anonymous comment is named "Anonyme" for every
 * reader; the reader the server served its `userId` to (the writer, a content moderator, a platform
 * admin - `serveComment`) also sees the writer's name, small, under it, resolved from that id since
 * an anonymous comment stores no name. Everyone else sees "Anonyme" alone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CommentItem from './CommentItem.svelte';
import type { PostComment } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string, fallback?: string) => fallback || `User ${id}`,
  resolveUserDisplayName: async (id: string) => `Resolved ${id}`,
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

const comment = (extra: Partial<PostComment>): PostComment => ({
  id: 'c1',
  text: 'hello',
  parentId: null,
  likes: [],
  createdAt: '2026-10-21T09:00:00Z',
  ...extra,
});

async function render(c: PostComment) {
  const target = document.body.appendChild(document.createElement('div'));
  const app = mount(CommentItem, {
    target,
    props: {
      comment: c,
      comments: [c],
      currentUserId: 'reader',
      onLike: () => {},
      onReply: () => {},
      onEdit: async () => {},
      onDelete: async () => {},
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  // Let the name lookup answer.
  await Promise.resolve();
  flushSync();
  return target;
}

/** The bold name line at the top of the bubble. */
const nameLine = (t: HTMLElement) => t.querySelector('.text-xs.font-bold')!;

describe('CommentItem author', () => {
  it('a regular reader (no userId served) sees "Anonyme" alone', async () => {
    const t = await render(comment({ anonymous: true }));
    expect(nameLine(t).textContent!.trim()).toBe(m.post_create_anonymous_label());
    expect(t.querySelector('[data-revealed-author]')).toBeNull();
    expect(t.querySelector('a[href^="/profile/"]')).toBeNull();
  });

  it('a reader served the userId (writer, moderator, admin) sees "Anonyme" big and the writer small under it', async () => {
    const t = await render(comment({ anonymous: true, userId: 'u7' }));
    expect(nameLine(t).textContent!.trim()).toBe(m.post_create_anonymous_label());
    // The avatar stays the mask and links nowhere; the small line links the profile.
    const line = t.querySelector('[data-revealed-author="u7"]')!;
    expect(line.classList.contains('text-2xs')).toBe(true);
    expect(line.textContent).toContain('Resolved u7');
    const links = [...t.querySelectorAll('a[href^="/profile/"]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/profile/u7']);
    expect(line.contains(links[0])).toBe(true);
  });

  it('an anonymous comment by the post author keeps its label, and the writer line under it when served', async () => {
    const t = await render(comment({ anonymous: true, byPostAuthor: true, userId: 'u7' }));
    expect(nameLine(t).textContent!.trim()).toBe(m.post_comment_anonymous_author_label());
    expect(t.querySelector('[data-revealed-author="u7"]')).not.toBeNull();
  });

  it('an ordinary comment is named by its writer, with no second line', async () => {
    const t = await render(comment({ userId: 'u2', firstName: 'Ada', lastName: 'L' }));
    expect(nameLine(t).textContent!.trim()).toBe('Ada L');
    expect(t.querySelector('[data-revealed-author]')).toBeNull();
  });

  it('an association comment is named by the association, with no second line, even with a userId', async () => {
    const association = { id: 'a1', name: 'BDE', slug: 'bde', logoUrl: null };
    const t = await render(comment({ association, userId: 'u2' }));
    expect(nameLine(t).textContent!.trim()).toBe('BDE');
    expect(t.querySelector('[data-revealed-author]')).toBeNull();
  });
});
