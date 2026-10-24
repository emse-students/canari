// @vitest-environment happy-dom
/**
 * WHAT A CARD SHOWS OF ITS COMMENTS (`CommentsPreview`): nothing for a post nobody commented on, else
 * the newest comment, the count and a line to write one - and every tap opens the sheet.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CommentsPreview from './CommentsPreview.svelte';
import type { PostComment } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';

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

const comment = (id: string, minute: number, extra: Partial<PostComment> = {}): PostComment => ({
  id,
  userId: 'u2',
  text: `text ${id}`,
  parentId: null,
  likes: [],
  createdAt: new Date(Date.UTC(2026, 9, 21, 9, minute)).toISOString(),
  ...extra,
});

function mountPreview(comments: PostComment[], commentCount = comments.length) {
  const onOpen = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CommentsPreview, {
    target,
    props: { comments, commentCount, currentUserId: 'u1', onOpen },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return { target, onOpen };
}

const buttonWith = (t: HTMLElement, text: string) =>
  [...t.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('CommentsPreview', () => {
  it('draws NOTHING for a post nobody has commented on (a permanent field cost 90 px a card)', () => {
    const { target } = mountPreview([], 0);
    expect(target.querySelector('[data-comments-preview]')).toBeNull();
    expect(target.textContent?.trim()).toBe('');
  });

  it('shows the newest top-level comment, never a reply', () => {
    const { target } = mountPreview([
      comment('old', 1),
      comment('newest', 30),
      comment('reply', 59, { parentId: 'old' }),
    ]);
    expect(target.textContent).toContain('text newest');
    expect(target.textContent).not.toContain('text old');
    expect(target.textContent).not.toContain('text reply');
  });

  it('counts the comments only when there is more than one', () => {
    const one = mountPreview([comment('a', 1)], 1);
    expect(buttonWith(one.target, m.post_show_comments_label({ count: 1 }))).toBeUndefined();
    const many = mountPreview([comment('a', 1)], 7);
    expect(buttonWith(many.target, m.post_show_comments_label({ count: 7 }))).toBeDefined();
  });

  it('opens the sheet to READ from the count and from the comment, and to WRITE from its own line', () => {
    const { target, onOpen } = mountPreview([comment('a', 1)], 3);
    buttonWith(target, m.post_show_comments_label({ count: 3 }))!.click();
    expect(onOpen).toHaveBeenLastCalledWith({ write: false });

    target.querySelector<HTMLElement>('[role="presentation"]')!.click();
    expect(onOpen).toHaveBeenLastCalledWith({ write: false });

    buttonWith(target, m.post_comment_placeholder())!.click();
    expect(onOpen).toHaveBeenLastCalledWith({ write: true });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('does not open from a link inside the comment: a mention goes to its profile', () => {
    const { target, onOpen } = mountPreview([
      comment('a', 1, { text: '[Ada](https://example.org)' }),
    ]);
    const link = target.querySelector<HTMLAnchorElement>('a[href="https://example.org"]');
    expect(link).not.toBeNull();
    link!.addEventListener('click', (e) => e.preventDefault());
    link!.click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('names an anonymous comment "Anonyme", and its writer small under it only when the server sent the id', () => {
    const hidden = mountPreview([comment('a', 1, { anonymous: true, userId: undefined })]);
    expect(hidden.target.textContent).toContain(m.post_create_anonymous_label());
    expect(hidden.target.querySelector('[data-revealed-author]')).toBeNull();

    const served = mountPreview([comment('b', 1, { anonymous: true, userId: 'u9' })]);
    expect(served.target.textContent).toContain(m.post_create_anonymous_label());
    const line = served.target.querySelector('[data-revealed-author="u9"]')!;
    expect(line.textContent).toContain('User u9');
  });
});
