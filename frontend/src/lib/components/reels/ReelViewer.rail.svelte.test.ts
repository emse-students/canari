// @vitest-environment happy-dom
/**
 * THE CANAREELS RAIL AND ITS COMMENTS SHEET (user, 2026-10-19, Instagram's Reels): the heart on the
 * card's reaction path (`posts/postReaction.ts`), the comments over the playing reel as a history
 * entry that Back, Escape, the X and a tap above it close - before the viewer, never with it - the
 * send on the post menu's share, and a post of one picture drawn as a page with the same rail.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostComment, PostEntity } from '$lib/posts/api';
import { addReaction, removeReaction } from '$lib/posts/api';
import { pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
import { showToast } from '$lib/stores/toast.svelte';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/reels/reelPreload', () => ({
  ReelPreload: class {
    stop() {}
  },
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  releaseHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));
vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
}));
vi.mock('$lib/components/posts/PostShareSheet.svelte', async () => ({
  default: (await import('./PostShareSheetStub.test-helper.svelte')).default,
}));
// The thread's avatars and names, as `PostComments`'s own tests stand them in: nothing fetched.
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/moderation/muteCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/moderation/muteCheck')>()),
  assertNotMuted: async () => {},
  cachedMuteStatus: () => null,
}));
vi.mock('$lib/stores/toast.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/toast.svelte')>()),
  showToast: vi.fn(),
}));

function comment(id: string): PostComment {
  return {
    id,
    userId: 'bob',
    text: `text ${id}`,
    parentId: null,
    likes: [],
    createdAt: '2026-10-01T00:00:00Z',
  };
}

function post(id: string, fields: Partial<PostEntity> = {}): PostEntity {
  return {
    id,
    kind: 'reel',
    markdown: '',
    mentions: [],
    links: [],
    media: [
      { type: 'video', mediaId: `m-${id}`, key: 'k', iv: 'i', mimeType: 'video/mp4', size: 1 },
    ],
    images: [],
    polls: [],
    reactions: {},
    comments: [],
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...fields,
  };
}

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.mocked(addReaction).mockReset();
  vi.mocked(removeReaction).mockReset();
  vi.mocked(pushHistoryOverlay).mockClear();
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render(startPost: PostEntity, likerId?: string) {
  const onClose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelViewer, {
      target,
      props: { startPost, authToken: 'tok', onClose, loadPage: async () => [], likerId },
    })
  );
  await settle();
  return { onClose };
}

import { videoSound } from '$lib/stores/videoSound.svelte';

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

async function click(sel: string) {
  q(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await settle();
}

it('draws the rail for a signed-in reader, with the counts and names it reads out', async () => {
  await render(
    post('a', { reactions: { bob: 'Rire' }, comments: [comment('c1'), comment('c2')] }),
    'alice'
  );

  expect(q('[data-reel-rail]')).not.toBeNull();
  const heart = q('[data-reel-rail-heart]')!;
  expect(heart.getAttribute('aria-pressed')).toBe('false');
  expect(heart.getAttribute('aria-label')).toBe(m.reels_rail_like({ count: 1 }));
  expect(q('[data-reel-rail-comments]')!.getAttribute('aria-label')).toBe(
    m.reels_rail_comments({ count: 2 })
  );
  // Out of the double tap and of the viewer's swipe.
  expect(q('[data-reel-rail]')!.hasAttribute('data-no-double-tap')).toBe(true);
});

it("a conversation's reel (no reader) has the tools but no social action", async () => {
  await render(post('a'));
  expect(q('[data-reel-rail-heart]')).toBeNull();
  expect(q('[data-reel-rail-comments]')).toBeNull();
  expect(q('[data-reel-rail-send]')).toBeNull();
  expect(q('[data-reel-rail] [data-reel-save]')).not.toBeNull();
  expect(q('[data-reel-rail-sound]')).not.toBeNull();
});

it('orders the rail: heart, comments, share, download under share, sound under that', async () => {
  await render(post('a'), 'alice');
  const keys = [...document.querySelectorAll('[data-reel-rail] button')].map(
    (b) => [...b.attributes].find((a) => /^data-reel-(rail-|save)/.test(a.name))?.name
  );
  expect(keys).toEqual([
    'data-reel-rail-heart',
    'data-reel-rail-comments',
    'data-reel-rail-send',
    'data-reel-save',
    'data-reel-rail-sound',
  ]);
});

it("the rail's sound button flips the app-wide answer", async () => {
  videoSound.setMuted(true);
  await render(post('a'), 'alice');
  const sound = q('[data-reel-rail-sound]')!;
  expect(sound.getAttribute('aria-pressed')).toBe('false');
  await click('[data-reel-rail-sound]');
  expect(videoSound.muted).toBe(false);
  expect(q('[data-reel-rail-sound]')!.getAttribute('aria-pressed')).toBe('true');
  videoSound.setMuted(true);
});

it('the heart gives "J\'aime" in one request, and the double tap does not fire on it', async () => {
  vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: "J'aime" } });
  await render(post('a'), 'alice');

  await click('[data-reel-rail-heart]');

  expect(addReaction).toHaveBeenCalledTimes(1);
  expect(addReaction).toHaveBeenCalledWith('a', "J'aime");
  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelectorAll('[data-double-tap-heart]').length).toBe(0);
});

it("the heart takes the reader's own reaction back, whatever its kind", async () => {
  vi.mocked(removeReaction).mockResolvedValue({ ok: true, reactions: {} });
  await render(post('a', { reactions: { alice: 'Rire' } }), 'alice');
  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-pressed')).toBe('true');

  await click('[data-reel-rail-heart]');

  expect(removeReaction).toHaveBeenCalledTimes(1);
  expect(addReaction).not.toHaveBeenCalled();
  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-pressed')).toBe('false');
});

it("the send opens the post's share sheet on that reel", async () => {
  await render(post('a'), 'alice');
  expect(q('[data-share-sheet]')).toBeNull();
  await click('[data-reel-rail-send]');
  await vi.waitFor(() => expect(q('[data-share-sheet="a"]')).not.toBeNull());
});

it('the comments open in a sheet over the reel, as a history entry of their own', async () => {
  await render(post('a', { comments: [comment('c1')] }), 'alice');
  const pushedBefore = vi.mocked(pushHistoryOverlay).mock.calls.length;

  await click('[data-reel-rail-comments]');

  expect(q('[data-comments-drawer-sheet]')).not.toBeNull();
  expect(q('[data-comments-drawer-sheet]')!.textContent).toContain('text c1');
  // The reel is still mounted under it: the sheet covers its lower part, it does not replace it.
  expect(q('[data-reel-slide="a"]')).not.toBeNull();
  expect(vi.mocked(pushHistoryOverlay).mock.calls.length).toBe(pushedBefore + 1);
});

it('Back closes the sheet and leaves the viewer open', async () => {
  const { onClose } = await render(post('a'), 'alice');
  await click('[data-reel-rail-comments]');

  // The system Back calls the newest entry's close: the sheet's.
  const calls = vi.mocked(pushHistoryOverlay).mock.calls;
  const back = calls[calls.length - 1][0] as () => void;
  back();
  await settle();

  expect(q('[data-comments-drawer-sheet]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it('Escape closes the sheet, not the viewer', async () => {
  const { onClose } = await render(post('a'), 'alice');
  await click('[data-reel-rail-comments]');

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  await settle();

  expect(q('[data-comments-drawer-sheet]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it('the X and a tap on the reel above close the sheet', async () => {
  await render(post('a'), 'alice');

  await click('[data-reel-rail-comments]');
  await click('[data-comments-drawer-close]');
  expect(q('[data-comments-drawer-sheet]')).toBeNull();

  await click('[data-reel-rail-comments]');
  await click('[data-comments-drawer-backdrop]');
  expect(q('[data-comments-drawer-sheet]')).toBeNull();
});

it('a post of one picture is a photo page, with the rail and no player', async () => {
  const picture = post('p', {
    kind: 'post',
    media: [{ type: 'image', mediaId: 'm-p', key: 'k', iv: 'i', mimeType: 'image/webp', size: 1 }],
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await render(picture, 'alice');

  expect(q('[data-reel-page="photo"]')).not.toBeNull();
  expect(q('[data-post-media-stub="m-p"]')).not.toBeNull();
  expect(q('[data-reel-rail]')).not.toBeNull();
  // Not a reel without its video: nothing accuses the row.
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});

it('the comments number is the server total, not the twenty rows a feed row carries', async () => {
  const twenty = Array.from({ length: 20 }, (_, i) => comment(`c${i}`));
  await render(post('a', { comments: twenty, commentCount: 57 }), 'alice');
  expect(q('[data-reel-rail-comments]')!.getAttribute('aria-label')).toBe(
    m.reels_rail_comments({ count: 57 })
  );
});

it('a reader whose reaction is not the heart sees THEIR emoji there, named as theirs', async () => {
  await render(post('a', { reactions: { alice: 'Rire' } }), 'alice');
  expect(q('[data-reel-rail-emoji]')).not.toBeNull();
  expect(q('[data-reel-rail-emoji] img')?.getAttribute('alt')).toBe('😂');
  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-label')).toBe(
    m.reels_rail_mine({ count: 1, reaction: m.post_reaction_name_laugh() })
  );
});

it('a second tap while the first reaction is in flight sends nothing, and the answer is the one adopted', async () => {
  let answer!: (value: { ok: boolean; reactions: Record<string, string> }) => void;
  vi.mocked(addReaction).mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  await render(post('a'), 'alice');

  await click('[data-reel-rail-heart]');
  await click('[data-reel-rail-heart]');

  expect(addReaction).toHaveBeenCalledTimes(1);
  expect(removeReaction).not.toHaveBeenCalled();
  answer({ ok: true, reactions: { alice: "J'aime" } });
  await settle();
  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-pressed')).toBe('true');

  // Landed: the next tap is heard again.
  vi.mocked(removeReaction).mockResolvedValue({ ok: true, reactions: {} });
  await click('[data-reel-rail-heart]');
  expect(removeReaction).toHaveBeenCalledTimes(1);
});

it('a reaction kind this client does not know is named neutrally, never "J\'aime"', async () => {
  await render(post('a', { reactions: { alice: 'Licorne' } }), 'alice');
  expect(q('[data-reel-rail-emoji]')).not.toBeNull();
  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-label')).toBe(
    m.reels_rail_mine_unknown({ count: 1 })
  );
});

it('a request the server never answers is aborted by its deadline: rolled back, said, and the heart works again', async () => {
  // The request's own deadline (`apiFetch` -> `RequestDeadlineError`) aborts it; triggered by hand.
  let abort!: () => void;
  vi.mocked(addReaction).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        abort = () =>
          reject(new RequestDeadlineError('write', 15000, 'POST', '/api/posts/a/reactions', 30));
      })
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await render(post('a'), 'alice');
  vi.mocked(showToast).mockClear();

  await click('[data-reel-rail-heart]');
  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-pressed')).toBe('true');
  abort();
  await settle();

  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-pressed')).toBe('false');
  expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: "J'aime" } });
  await click('[data-reel-rail-heart]');
  expect(addReaction).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});

// The heart's reaction drawer (user, 2026-10-23): a long press, the card's reaction set.

function pointerEvent(type: string): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerType: 'touch',
    button: 0,
    clientX: 0,
    clientY: 0,
  });
}

/** Holds the heart past the long-press threshold, then lets go: the browser's click follows. */
async function holdHeart() {
  vi.useFakeTimers();
  try {
    q('[data-reel-rail-heart]')!.dispatchEvent(pointerEvent('pointerdown'));
    vi.advanceTimersByTime(600);
  } finally {
    vi.useRealTimers();
  }
  q('[data-reel-rail-heart]')!.dispatchEvent(pointerEvent('pointerup'));
  await click('[data-reel-rail-heart]');
}

it("a long press opens the drawer with the card's eight reactions and sends nothing", async () => {
  await render(post('a'), 'alice');
  expect(q('[data-reel-rail-drawer]')).toBeNull();

  await holdHeart();

  expect(q('[data-reel-rail-drawer]')).not.toBeNull();
  expect(document.querySelectorAll('[data-reel-rail-drawer-item]').length).toBe(8);
  // The click that ended the hold is swallowed: no heart toggled, no request.
  expect(addReaction).not.toHaveBeenCalled();
  expect(q('[data-reel-rail-heart]')!.getAttribute('aria-expanded')).toBe('true');
});

it('a tap on a reaction in the drawer sends that reaction and closes it', async () => {
  vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: 'Rire' } });
  await render(post('a'), 'alice');
  await holdHeart();

  await click('[data-reel-rail-drawer-item="Rire"]');

  expect(addReaction).toHaveBeenCalledWith('a', 'Rire');
  expect(q('[data-reel-rail-drawer]')).toBeNull();
  expect(q('[data-reel-rail-emoji]')).not.toBeNull();
});

it('picking the kind the reader holds takes it back; another kind replaces it', async () => {
  vi.mocked(removeReaction).mockResolvedValue({ ok: true, reactions: {} });
  await render(post('a', { reactions: { alice: 'Rire' } }), 'alice');
  await holdHeart();
  expect(q('[data-reel-rail-drawer-item="Rire"]')!.getAttribute('aria-checked')).toBe('true');

  await click('[data-reel-rail-drawer-item="Rire"]');
  expect(removeReaction).toHaveBeenCalledTimes(1);

  vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: 'Triste' } });
  await holdHeart();
  await click('[data-reel-rail-drawer-item="Triste"]');
  expect(addReaction).toHaveBeenCalledWith('a', 'Triste');
});

it('a tap outside and Escape close the drawer without sending, and Escape keeps the viewer open', async () => {
  const { onClose } = await render(post('a'), 'alice');
  await holdHeart();
  await click('[data-reel-rail-drawer-dismiss]');
  expect(q('[data-reel-rail-drawer]')).toBeNull();

  await holdHeart();
  q('[data-reel-rail-drawer-item="Rire"]')!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
  await settle();
  expect(q('[data-reel-rail-drawer]')).toBeNull();
  expect(addReaction).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('the keyboard reaches the drawer: ArrowUp on the heart, and the context menu key', async () => {
  await render(post('a'), 'alice');
  q('[data-reel-rail-heart]')!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
  );
  await settle();
  expect(q('[data-reel-rail-drawer]')).not.toBeNull();
  expect(q('[data-reel-rail-drawer]')!.getAttribute('role')).toBe('menu');

  q('[data-reel-rail-drawer]')!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
  await settle();
  expect(q('[data-reel-rail-drawer]')).toBeNull();

  const menu = new Event('contextmenu', { bubbles: true, cancelable: true });
  q('[data-reel-rail-heart]')!.dispatchEvent(menu);
  await settle();
  expect(menu.defaultPrevented).toBe(true);
  expect(q('[data-reel-rail-drawer]')).not.toBeNull();
});
