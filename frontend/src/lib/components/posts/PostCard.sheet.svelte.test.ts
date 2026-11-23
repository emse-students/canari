// @vitest-environment happy-dom
/**
 * THE CARD'S COMMENTS ARE A PREVIEW AND A SHEET (the comment refonte, 2026-10-21). Pinned: the card
 * draws the newest comment, not the thread; a tap on the count opens the thread in a sheet; the
 * "write" line and the comment icon of an empty thread open it with the caret in the box; a
 * notification's comment opens it at once; and what was typed survives closing the sheet.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { getPost } from '$lib/posts/api';
import { apiFetch } from '$lib/utils/apiFetch';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

vi.mock('$lib/utils/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/apiFetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  getPost: vi.fn(),
}));
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listMyAssociations: vi.fn().mockResolvedValue([]),
  listAssociations: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));

const mounted: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const comment = (n: number): PostComment => ({
  id: `c${n}`,
  userId: 'bob',
  text: `comment ${n}`,
  parentId: null,
  likes: [],
  createdAt: `2026-10-15T08:${String(n).padStart(2, '0')}:00.000Z`,
});

const row = (comments: PostComment[]): PostEntity =>
  ({
    id: 'p1',
    markdown: 'The post text',
    mentions: [],
    links: [],
    media: [],
    images: [],
    reactions: {},
    polls: [],
    comments,
    commentCount: comments.length,
    createdAt: '2026-10-15T08:00:00.000Z',
    publishedAt: '2026-10-15T08:00:00.000Z',
    updatedAt: '2026-10-15T08:00:00.000Z',
  }) as unknown as PostEntity;

function mountCard(
  post: PostEntity,
  extra: { commentsOpen?: boolean; focusCommentId?: string } = {}
) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(PostCard, {
    target,
    props: { post, currentUserId: 'alice', ...extra },
  });
  mounted.push(() => void unmount(instance));
  flushSync();
  return target;
}

/** The thread's rows live in the sheet, a portal on the document. */
const threadRows = () => document.body.querySelectorAll('[id^="comment-"]').length;
const sheetOpen = () => document.body.querySelector('[role="dialog"]') !== null;
const buttonWith = (text: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const editor = () => document.body.querySelector<HTMLElement>('[contenteditable="true"]');
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    flushSync();
  }
  await tick();
};

describe('the card', () => {
  it('draws the newest comment and the count, not the thread, and no sheet', () => {
    mountCard(row([comment(1), comment(2), comment(3)]));
    expect(sheetOpen()).toBe(false);
    expect(threadRows()).toBe(0);
    expect(document.body.textContent).toContain('comment 3');
    expect(buttonWith(m.post_show_comments_label({ count: 3 }))).toBeDefined();
  });

  it('opens the thread in a dialog from the count, WITHOUT the post quoted above it', async () => {
    mountCard(row([comment(1), comment(2)]));
    buttonWith(m.post_show_comments_label({ count: 2 }))!.click();
    await settle();

    expect(sheetOpen()).toBe(true);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(m.post_comments_sheet_title());
    expect(dialog.textContent).not.toContain('The post text');
    expect(threadRows()).toBe(2);
  });

  it('opens it with the caret in the box from the write line', async () => {
    mountCard(row([comment(1)]));
    buttonWith(m.post_comment_placeholder())!.click();
    await settle();

    expect(sheetOpen()).toBe(true);
    expect(document.activeElement).toBe(editor());
  });

  it('opens it with the caret in the box from the comment icon of a post nobody commented on', async () => {
    mountCard(row([]));
    expect(document.body.querySelector('[data-comments-preview]')).toBeNull();
    document.body
      .querySelector<HTMLButtonElement>(`button[aria-label="${m.post_commenter()}"]`)!
      .click();
    await settle();

    expect(sheetOpen()).toBe(true);
    expect(document.activeElement).toBe(editor());
  });

  it('does not put the caret in the box when the thread is only read', async () => {
    mountCard(row([comment(1), comment(2)]));
    buttonWith(m.post_show_comments_label({ count: 2 }))!.click();
    await settle();
    expect(document.activeElement).not.toBe(editor());
  });

  it('opens at once on the comment a notification named, and scrolls to it', async () => {
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement
    ) {
      scrolled.push(this.id);
    });
    mountCard(row([comment(1), comment(2), comment(3)]), {
      commentsOpen: true,
      focusCommentId: 'c2',
    });
    await settle();

    expect(sheetOpen()).toBe(true);
    expect(scrolled).toEqual(['comment-c2']);
  });

  it('opens on the comment a notification names for the post ALREADY on screen, and rings it', async () => {
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement
    ) {
      scrolled.push(this.id);
    });
    const props = $state<{ post: PostEntity; currentUserId: string; focusCommentId?: string }>({
      post: row([comment(1), comment(2)]),
      currentUserId: 'alice',
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const instance = mount(PostCard, { target, props });
    mounted.push(() => void unmount(instance));
    flushSync();
    expect(sheetOpen()).toBe(false);

    props.focusCommentId = 'c2';
    await settle();

    expect(sheetOpen()).toBe(true);
    expect(scrolled).toEqual(['comment-c2']);
    expect(getPost).not.toHaveBeenCalled();
  });

  it('reads the post again when the named comment arrived after it was read, then rings it', async () => {
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement
    ) {
      scrolled.push(this.id);
    });
    vi.mocked(getPost).mockResolvedValue(row([comment(1), comment(2), comment(3)]));
    const props = $state<{ post: PostEntity; currentUserId: string; focusCommentId?: string }>({
      post: row([comment(1), comment(2)]),
      currentUserId: 'alice',
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const instance = mount(PostCard, { target, props });
    mounted.push(() => void unmount(instance));
    flushSync();

    props.focusCommentId = 'c3';
    await settle();

    expect(getPost).toHaveBeenCalledWith('p1');
    expect(sheetOpen()).toBe(true);
    expect(threadRows()).toBe(3);
    expect(scrolled).toEqual(['comment-c3']);
  });

  it('reopens on the SAME comment pushed again after the sheet was closed (the count is the event)', async () => {
    const props = $state<{
      post: PostEntity;
      currentUserId: string;
      focusCommentId?: string;
      focusNonce: number;
    }>({
      post: row([comment(1), comment(2)]),
      currentUserId: 'alice',
      focusCommentId: 'c2',
      focusNonce: 1,
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const instance = mount(PostCard, { target, props });
    mounted.push(() => void unmount(instance));
    flushSync();
    expect(sheetOpen()).toBe(false);

    props.focusNonce = 2;
    await settle();
    expect(sheetOpen()).toBe(true);

    document.body.querySelector<HTMLButtonElement>('button[aria-label="Fermer"]')!.click();
    await vi.waitFor(() => expect(sheetOpen()).toBe(false), { timeout: 2000 });

    props.focusNonce = 3;
    await settle();
    expect(sheetOpen()).toBe(true);
  });

  it('reads the post ONCE when the re-read still lacks the comment, and logs the miss once', async () => {
    const debug = vi.spyOn(console, 'debug');
    vi.mocked(getPost).mockResolvedValue(row([comment(1), comment(2)]));
    const props = $state<{ post: PostEntity; currentUserId: string; focusCommentId?: string }>({
      post: row([comment(1), comment(2)]),
      currentUserId: 'alice',
    });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const instance = mount(PostCard, { target, props });
    mounted.push(() => void unmount(instance));
    flushSync();

    props.focusCommentId = 'c9';
    await settle();
    await settle();

    expect(getPost).toHaveBeenCalledTimes(1);
    expect(sheetOpen()).toBe(true);
    const misses = debug.mock.calls.filter((c) =>
      String(c.join(' ')).includes('c9 not in the thread')
    );
    expect(misses).toHaveLength(1);
  });

  it('keeps what was typed when the sheet is closed and opened again', async () => {
    mountCard(row([comment(1), comment(2)]));
    buttonWith(m.post_show_comments_label({ count: 2 }))!.click();
    await settle();
    const box = editor()!;
    box.textContent = 'half a thought';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    document.body.querySelector<HTMLButtonElement>('button[aria-label="Fermer"]')!.click();
    await vi.waitFor(() => expect(sheetOpen()).toBe(false), { timeout: 2000 });

    buttonWith(m.post_show_comments_label({ count: 2 }))!.click();
    await settle();
    expect(editor()!.textContent).toContain('half a thought');
  });
});
