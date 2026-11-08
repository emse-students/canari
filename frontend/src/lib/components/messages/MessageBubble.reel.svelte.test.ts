// @vitest-environment happy-dom
/**
 * A CanaReel sent in a conversation, as the BUBBLE treats it: NOTHING is downloaded before the tap
 * (a reel is 9-35 MB and the chat reads media whole), and it is NOT forwarded (forwarding copies the
 * media ref, so the key). An ordinary video in the same bubble keeps both behaviours it always had.
 * The rendering of the tile itself is `MessageMediaRenderer.reel.svelte.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

const downloads: string[] = [];
vi.mock('$lib/media', async (orig) => ({
  ...(await orig<typeof import('$lib/media')>()),
  MediaService: class {
    downloadAndDecrypt(ref: { mediaId: string }) {
      downloads.push(ref.mediaId);
      return new Promise<string>(() => {});
    }
  },
}));

/** The take's reach the outbox answers for "Annuler partout" / "Supprimer partout" (15.2, 15.7). */
const reachMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/chat/outbox')>()),
  outboxReelTakeReachOf: (...args: unknown[]) => reachMock(...args),
}));

vi.mock('$lib/components/reels/ReelViewer.svelte', async () => ({
  default: (await import('../reels/ReelViewerStub.test-helper.svelte')).default,
}));

import MessageBubble from './MessageBubble.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];

// The delete confirmation's outro is cancelled by the teardown (see the helper).
afterAll(adoptTransitionAnimations());

beforeEach(() => {
  downloads.length = 0;
  reachMock.mockReset();
  reachMock.mockResolvedValue(null);
  // Every row is "near the viewport" at once, so the only thing left to hold a download back is the
  // bubble's own rule - which is what these tests are about.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.cb([{ isIntersecting: true }]);
      }
      disconnect() {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

function video(extra: Partial<MediaRef> = {}): MediaRef {
  return {
    type: 'video',
    mediaId: 'media-1',
    key: '00'.repeat(32),
    iv: '00'.repeat(12),
    mimeType: 'video/mp4',
    size: 1,
    width: 540,
    height: 960,
    ...extra,
  };
}

function render(ref: MediaRef, onForward = vi.fn(), extra: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'm1',
      senderId: 'u-other',
      currentUserId: 'u-me',
      authToken: 'tok',
      content: serializeEnvelope(mkMediaEnvelope(ref)),
      timestamp: new Date('2026-10-05T10:00:00Z'),
      isOwn: false,
      onForward,
      ...extra,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

/** The desktop "..." menu entries, forward included. */
function menuLabels(): string[] {
  document
    .querySelector<HTMLButtonElement>(`[aria-label="${m.msg_more_actions_label()}"]`)
    ?.click();
  flushSync();
  return [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');
}

describe('MessageBubble - a reel message', () => {
  it('downloads nothing while it is only a tile', () => {
    render(video({ intent: 'reel-message', durationMs: 30_000 }));
    expect(document.querySelector('[data-reel-tile]')).not.toBeNull();
    expect(downloads).toEqual([]);
  });

  it('offers no forward: the media ref carries the key', () => {
    render(video({ intent: 'reel-message' }));
    expect(menuLabels().some((l) => l.includes(m.msg_forward_label()))).toBe(false);
  });

  it("hands the viewer's 410 up with ITS message id, and draws the tombstone (RC-6)", async () => {
    const onReelPurged = vi.fn();
    render(video({ intent: 'reel-message', expiresAtMs: Date.now() + 86_400_000 }), vi.fn(), {
      onReelPurged,
    });
    document.querySelector<HTMLButtonElement>('[data-reel-tile]')!.click();
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await tick();
    }
    flushSync();
    document.querySelector<HTMLButtonElement>('[data-reel-viewer-stub-gone]')!.click();
    flushSync();
    expect(onReelPurged).toHaveBeenCalledTimes(1);
    expect(onReelPurged.mock.calls[0][0]).toBe('m1');
    expect(typeof onReelPurged.mock.calls[0][1]).toBe('number');
    expect(
      document.querySelector<HTMLElement>('[data-reel-tombstone]')!.dataset.reelTombstone
    ).toBe('deleted');
  });

  it('draws a recorded 410 (reelPurgedAt) as the tombstone with no tap', () => {
    render(video({ intent: 'reel-message', expiresAtMs: Date.now() + 86_400_000 }), vi.fn(), {
      reelPurgedAt: Date.now() - 1000,
    });
    expect(document.querySelector('[data-reel-tile]')).toBeNull();
    expect(
      document.querySelector<HTMLElement>('[data-reel-tombstone]')!.dataset.reelTombstone
    ).toBe('deleted');
  });
});

/** Opens the delete confirmation from the desktop menu, and lets the reach question answer. */
async function openDelete(): Promise<void> {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.includes(m.common_delete_button())
  );
  if (!item) menuLabels();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes(m.common_delete_button()))!
    .click();
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

const send = (n: number) => ({ id: `s-${n}`, conversationId: `g-${n}` });

describe('MessageBubble - my reel sent to several conversations (15.2, 15.7)', () => {
  const own = { isOwn: true, senderId: 'u-me', onDelete: vi.fn() };

  it('offers "Supprimer partout" in the delete confirmation once a send went, and hands the message up', async () => {
    reachMock.mockResolvedValue({
      takeId: 't',
      queued: [send(3)],
      standing: [send(1), send(2)],
    });
    const onDeleteReelEverywhere = vi.fn();
    render(video({ intent: 'reel-message' }), vi.fn(), { ...own, onDeleteReelEverywhere });
    await openDelete();
    expect(reachMock).toHaveBeenCalledWith('m1');
    const button = document.querySelector<HTMLButtonElement>('[data-reel-everywhere]')!;
    expect(button.textContent).toContain(m.reel_sendto_delete_everywhere());
    expect(document.querySelector('[data-reel-everywhere-hint]')!.textContent).toContain(
      m.reel_sendto_delete_everywhere_hint({ count: 3 })
    );
    button.click();
    // A second tap during the confirmation's outro ends nothing: the press is taken once.
    button.click();
    flushSync();
    expect(onDeleteReelEverywhere).toHaveBeenCalledTimes(1);
    expect(onDeleteReelEverywhere).toHaveBeenCalledWith('m1');
  });

  it('offers "Annuler partout" while no send has gone', async () => {
    reachMock.mockResolvedValue({ takeId: 't', queued: [send(1), send(2)], standing: [] });
    render(video({ intent: 'reel-message' }), vi.fn(), {
      ...own,
      onDeleteReelEverywhere: vi.fn(),
    });
    await openDelete();
    expect(document.querySelector('[data-reel-everywhere]')!.textContent).toContain(
      m.reel_sendto_cancel_all()
    );
  });

  it('offers nothing more for a take naming one message, nor on another device (no reach)', async () => {
    reachMock.mockResolvedValue({ takeId: 't', queued: [], standing: [send(1)] });
    render(video({ intent: 'reel-message' }), vi.fn(), {
      ...own,
      onDeleteReelEverywhere: vi.fn(),
    });
    await openDelete();
    expect(document.querySelector('[data-reel-everywhere]')).toBeNull();
  });

  it("never asks for an ordinary video's reach", async () => {
    render(video(), vi.fn(), { ...own, onDeleteReelEverywhere: vi.fn() });
    await openDelete();
    expect(reachMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-reel-everywhere]')).toBeNull();
  });
});

describe('MessageBubble - an ordinary video', () => {
  it('still downloads when it comes near the viewport', async () => {
    render(video());
    // The control of the test above: the same row, minus the intent, DOES ask for its bytes.
    await vi.waitFor(() => expect(downloads).toEqual(['media-1']));
  });

  it('still offers the forward', () => {
    render(video());
    expect(menuLabels().some((l) => l.includes(m.msg_forward_label()))).toBe(true);
  });
});
