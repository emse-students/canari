/**
 * A CanaReel sent in a conversation, as the BUBBLE treats it: NOTHING is downloaded before the tap
 * (a reel is 9-35 MB and the chat reads media whole), and it is NOT forwarded (forwarding copies the
 * media ref, so the key). An ordinary video in the same bubble keeps both behaviours it always had.
 * The rendering of the tile itself is `MessageMediaRenderer.reel.svelte.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

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

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];

beforeEach(() => {
  downloads.length = 0;
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

function render(ref: MediaRef, onForward = vi.fn()) {
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
