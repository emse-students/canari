// @vitest-environment happy-dom
/**
 * A DOUBLE TAP ON A REEL IN THE VIEWER LIKES IT, AND NEVER UNLIKES IT (user, 2026-10-19) - on the
 * card's own reaction path (`posts/postReaction.ts`): one request for a reel not yet reacted to,
 * none for one already reacted to, nothing at all for a conversation's reel (no `likerId`), a
 * failure said as the card says it, and the server's answer handed to the cards behind.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostEntity } from '$lib/posts/api';
import { addReaction, removeReaction } from '$lib/posts/api';
import { onPostReactions } from '$lib/posts/postReaction';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { GESTURE } from '$lib/utils/viewerGestures';

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
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));
vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
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

function reel(id: string, reactions: Record<string, string> = {}): PostEntity {
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
    reactions,
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.mocked(addReaction).mockReset();
  vi.mocked(removeReaction).mockReset();
  vi.mocked(showToast).mockReset();
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
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelViewer, {
      target,
      props: { startPost, authToken: 'tok', onClose: vi.fn(), loadPage: async () => [], likerId },
    })
  );
  await settle();
}

async function doubleTap(reelId: string) {
  const slide = document.querySelector(`[data-reel-slide="${reelId}"]`)!;
  for (const detail of [1, 2]) {
    slide.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 9, clientY: 9, detail })
    );
  }
  flushSync();
  await settle();
}

const hearts = () => document.querySelectorAll('[data-double-tap-heart]').length;

it('likes a reel not yet reacted to: one request, the heart, and the cards behind are told', async () => {
  vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: "J'aime" } });
  const told = vi.fn();
  const stop = onPostReactions('a', told);
  await render(reel('a'), 'alice');

  await doubleTap('a');

  expect(addReaction).toHaveBeenCalledTimes(1);
  expect(addReaction).toHaveBeenCalledWith('a', "J'aime");
  expect(hearts()).toBe(1);
  expect(told).toHaveBeenCalledWith({ alice: "J'aime" });
  stop();
});

it('a reel already reacted to gets the heart and no request', async () => {
  await render(reel('a', { alice: 'Rire' }), 'alice');

  await doubleTap('a');

  expect(addReaction).not.toHaveBeenCalled();
  expect(removeReaction).not.toHaveBeenCalled();
  expect(hearts()).toBe(1);
});

it("a conversation's reel (no liker) takes no double tap", async () => {
  await render(reel('a'));

  await doubleTap('a');

  expect(addReaction).not.toHaveBeenCalled();
  expect(hearts()).toBe(0);
});

it('a like the server did not record is said as the card says it, and a later double tap asks again', async () => {
  // The gesture's clock and window are faked: the second double tap comes after the first's quiet.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    vi.mocked(addReaction).mockRejectedValueOnce(new Error('refused'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render(reel('a'), 'alice');

    await doubleTap('a');

    expect(showToast).toHaveBeenCalledWith(m.post_reaction_error(), 'error');

    // Rolled back: the reel carries no reaction again, so the next double tap sends one.
    vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: "J'aime" } });
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS + 1);
    await doubleTap('a');
    expect(addReaction).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
