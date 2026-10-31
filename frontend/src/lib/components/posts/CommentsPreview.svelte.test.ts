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

vi.mock('./PostMedia.svelte', async () => ({
  default: (await import('./PostMediaOpenStub.test-helper.svelte')).default,
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
  const onLike = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CommentsPreview, {
    target,
    props: { comments, commentCount, currentUserId: 'u1', authToken: 'tok', onLike, onOpen },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return { target, onOpen, onLike };
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

  it('draws the picture of a comment that is only a GIF, as a compact thumbnail', () => {
    const gif = {
      type: 'image' as const,
      mediaId: 'g1',
      key: 'k',
      iv: 'i',
      mimeType: 'image/gif',
      size: 10,
      width: 200,
      height: 150,
    };
    const { target } = mountPreview([comment('g', 1, { text: '', media: gif })]);
    const thumb = target.querySelector('[data-comment-media]');
    expect(thumb).not.toBeNull();
    expect(thumb!.className).toContain('max-w-32');
  });

  it('holds the picture back until the card comes near the viewport', () => {
    const observers: { cb: IntersectionObserverCallback }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          observers.push({ cb });
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    try {
      const gif = {
        type: 'image' as const,
        mediaId: 'g2',
        key: 'k',
        iv: 'i',
        mimeType: 'image/gif',
        size: 10,
        width: 200,
        height: 150,
      };
      const { target } = mountPreview([comment('g', 1, { text: '', media: gif })]);
      const stub = () => target.querySelector('[data-post-media-open]')!;
      expect(stub().getAttribute('data-deferred')).toBe('true');
      for (const o of observers) {
        o.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
      flushSync();
      expect(stub().getAttribute('data-deferred')).toBe('false');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws no picture slot for a text-only comment', () => {
    const { target } = mountPreview([comment('t', 1)]);
    expect(target.querySelector('[data-comment-media]')).toBeNull();
  });

  it('likes from the heart without opening the sheet, and says who has liked', () => {
    const { target, onOpen, onLike } = mountPreview([comment('a', 1, { likes: ['u1', 'u7'] })]);
    const heart = target.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    expect(heart.getAttribute('aria-pressed')).toBe('true');
    expect(heart.getAttribute('aria-label')).toBe(m.post_likes_count_label({ count: 2 }));
    expect(heart.textContent).toContain('2');
    heart.click();
    expect(onLike).toHaveBeenCalledWith('a');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows an unliked comment with no count and a pressed state of false', () => {
    const { target } = mountPreview([comment('a', 1)]);
    const heart = target.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    expect(heart.getAttribute('aria-pressed')).toBe('false');
    expect(heart.getAttribute('aria-label')).toBe(m.post_like_label());
  });
});
