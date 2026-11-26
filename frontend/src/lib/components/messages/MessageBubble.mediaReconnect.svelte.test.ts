// @vitest-environment happy-dom
/**
 * A MEDIA THAT GOT NO ANSWER IS DRAWN AGAIN WHEN THE LINK RETURNS. A 45 MB file whose load failed
 * during an outage stayed on its retry icon more than a minute after the Wi-Fi came back
 * (iPhone 12, 2026-11-18): nothing reloaded it. The bubble now listens for the connectivity
 * store's reconnect event, and only while it holds an `unreachable` failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

const outcomes: ('unreachable' | 'other' | 'ok')[] = [];
let downloads = 0;
vi.mock('$lib/media', async (orig) => {
  const real = await orig<typeof import('$lib/media')>();
  const errors = await import('$lib/utils/mediaErrors');
  return {
    ...real,
    MediaService: class {
      downloadAndDecrypt() {
        downloads += 1;
        const next = outcomes.shift() ?? 'ok';
        if (next === 'unreachable') {
          return Promise.reject(new errors.MediaUnreachableError(new TypeError('Load failed')));
        }
        if (next === 'other') return Promise.reject(new Error('boom'));
        return Promise.resolve('blob:test/ok');
      }
    },
  };
});

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import { connectivity } from '$lib/stores/connectivity.svelte';
import type { MediaRef } from '$lib/media';

const mounted: (() => void)[] = [];

beforeEach(() => {
  downloads = 0;
  outcomes.length = 0;
  connectivity.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
  connectivity.reset();
});

const ref: MediaRef = {
  type: 'file',
  mediaId: 'media-1',
  key: '00'.repeat(32),
  iv: '00'.repeat(12),
  mimeType: 'application/pdf',
  fileName: 'doc.pdf',
  size: 1,
};

function render() {
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
      timestamp: new Date('2026-11-18T10:00:00Z'),
      isOwn: false,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

/** Takes the link down, then brings it back: the store's own reconnect event. */
function cutAndRestore() {
  connectivity.notifyServerUnreachable('transport failure: TypeError');
  connectivity.notifyServerReachable();
  flushSync();
}

describe('MessageBubble - a media that got no answer', () => {
  it('is downloaded again when the link returns, without a tap', async () => {
    outcomes.push('unreachable', 'ok');
    render();
    await vi.waitFor(() => expect(downloads).toBe(1));
    await Promise.resolve();
    flushSync();

    cutAndRestore();
    await vi.waitFor(() => expect(downloads).toBe(2));
  });

  it('is NOT downloaded again for a failure that is not the link (a retry would not change it)', async () => {
    outcomes.push('other');
    render();
    await vi.waitFor(() => expect(downloads).toBe(1));
    await Promise.resolve();
    flushSync();

    cutAndRestore();
    await Promise.resolve();
    expect(downloads).toBe(1);
  });
});
