// @vitest-environment happy-dom
/**
 * A POST'S COMMENTS ON A PHONE ARE THE SHARED DRAWER (user, 2026-10-23): the same `CommentsDrawer` a
 * CanaReel's comments open in, rising over the interface, with NOTHING quoted above the thread, a
 * history entry that Back closes, Escape and the X closing it, the focus in it (a dialog, modal over
 * the page) and given back to the opener. The wide layout keeps its dialog (`PostCard.sheet`).
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { apiFetch } from '$lib/utils/apiFetch';
import { pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

vi.mock('$lib/utils/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/apiFetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  releaseHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
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
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  vi.mocked(pushHistoryOverlay).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
  // A phone, and one that asked for reduced motion: every query answers yes, so the drawer slides
  // out at once and the test reads the closing, not a transition.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
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

const post = (comments: PostComment[]): PostEntity =>
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

async function openDrawer() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(PostCard, {
    target,
    props: { post: post([comment(1), comment(2)]), currentUserId: 'alice' },
  });
  mounted.push(() => void unmount(instance));
  flushSync();
  const opener = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(m.post_show_comments_label({ count: 2 }))
  )!;
  opener.focus();
  opener.click();
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    flushSync();
  }
  await tick();
  return opener;
}

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);

it('opens the thread in the shared drawer, over the page, with no quoted post above it', async () => {
  await openDrawer();

  const sheet = q('[data-comments-drawer-sheet]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.getAttribute('role')).toBe('dialog');
  expect(sheet.getAttribute('aria-modal')).toBe('true');
  expect(sheet.classList.contains('motion-sheet-in')).toBe(true);
  expect(sheet.textContent).toContain(m.reels_comments_title());
  expect(sheet.textContent).toContain('comment 2');
  // The reminder of the post is gone entirely.
  expect(sheet.textContent).not.toContain('The post text');
  // Portalled to the body: it does not live inside the card.
  expect(q('[data-comments-drawer]')!.parentElement).toBe(document.body);
  // And it is a history entry, so Back closes it.
  expect(pushHistoryOverlay).toHaveBeenCalledTimes(1);
});

it('closes on the X and gives the focus back to what opened it', async () => {
  const opener = await openDrawer();
  q('[data-comments-drawer-close]')!.click();
  await vi.waitFor(() => expect(q('[data-comments-drawer-sheet]')).toBeNull(), { timeout: 2000 });
  expect(document.activeElement).toBe(opener);
});

it('closes on Escape and on a tap above the drawer', async () => {
  await openDrawer();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  await vi.waitFor(() => expect(q('[data-comments-drawer-sheet]')).toBeNull(), { timeout: 2000 });

  await openDrawer();
  q('[data-comments-drawer-backdrop]')!.click();
  await vi.waitFor(() => expect(q('[data-comments-drawer-sheet]')).toBeNull(), { timeout: 2000 });
});

it('closes on the system Back, through its history entry', async () => {
  await openDrawer();
  const closeEntry = vi.mocked(pushHistoryOverlay).mock.calls[0]![0] as (reason?: string) => void;
  closeEntry('back');
  await vi.waitFor(() => expect(q('[data-comments-drawer-sheet]')).toBeNull(), { timeout: 2000 });
});
