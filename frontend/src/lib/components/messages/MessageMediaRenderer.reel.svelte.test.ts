/**
 * A CanaReel sent in a conversation is a TILE, and this file MOUNTS the branch that draws it.
 *
 * `MessageMediaRenderer` once lost every photo to a video branch and no test had ever mounted it
 * (#1229); the reel branch sits in front of the generic video one, so the two things a regression
 * would do are pinned here: a reel message drawn as a chat video, and a picked clip drawn as a reel.
 * The viewer the tap opens is replaced by a stand-in - its own tests are `ReelViewer.svelte.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import MessageMediaRenderer from './MessageMediaRenderer.svelte';
import type { MediaRef } from '$lib/media';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/components/reels/ReelViewer.svelte', async () => ({
  default: (await import('../reels/ReelViewerStub.test-helper.svelte')).default,
}));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const SENT_AT = new Date(Date.now() - 3 * 3600_000);

function video(extra: Partial<MediaRef> = {}): MediaRef {
  return {
    type: 'video',
    mediaId: 'media-reel',
    key: '00'.repeat(32),
    iv: '00'.repeat(12),
    mimeType: 'video/mp4',
    size: 4096,
    width: 540,
    height: 960,
    ...extra,
  };
}

function render(mediaRef: MediaRef, props: Record<string, unknown> = {}) {
  const instance = mount(MessageMediaRenderer, {
    target: document.body,
    props: {
      mediaRef,
      blobUrl: null,
      failure: null,
      textContent: '',
      senderId: 'u-ada',
      sentAt: SENT_AT,
      messageId: 'msg-1',
      authToken: 'tok',
      ...props,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
}

const tile = () => document.querySelector<HTMLButtonElement>('[data-reel-tile]');

describe('MessageMediaRenderer - a reel message', () => {
  it('draws a tile with the length and "Appuyer pour voir", and NO video element', () => {
    render(video({ intent: 'reel-message', durationMs: 42_000 }));
    expect(tile()).not.toBeNull();
    expect(tile()!.textContent).toContain(m.reel_chat_tile_tap());
    expect(tile()!.textContent).toContain('0:42');
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('[data-reel-viewer-stub]')).toBeNull();
  });

  it('names itself with the length and the age, never from the caption alone', () => {
    render(video({ intent: 'reel-message', durationMs: 42_000 }), { textContent: 'coucou' });
    const label = tile()!.getAttribute('aria-label')!;
    expect(label).toContain('0:42');
    expect(label).not.toBe('coucou');
  });

  it('opens the viewer on the tap, handing it the message as a post with its key', async () => {
    render(video({ intent: 'reel-message', durationMs: 42_000 }), { textContent: 'la legende' });
    tile()!.click();
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await tick();
    }
    flushSync();
    const stub = document.querySelector<HTMLElement>('[data-reel-viewer-stub]')!;
    expect(stub).not.toBeNull();
    expect(stub.dataset.postId).toBe('msg-1');
    expect(stub.dataset.mediaKey).toBe('00'.repeat(32));
    expect(stub.dataset.caption).toBe('la legende');
    expect(stub.dataset.hasMore).toBe('none');
  });

  it("is a tombstone once the sender's expiry hint has passed: no control, no ThumbHash", () => {
    render(
      video({
        intent: 'reel-message',
        durationMs: 42_000,
        expiresAtMs: Date.now() - 1000,
        placeholder: 'AAgKBAAAAAAAAAAAAAAA',
      })
    );
    expect(tile()).toBeNull();
    const tomb = document.querySelector('[data-reel-tombstone]')!;
    expect(tomb.textContent).toContain(m.reel_chat_expired());
    expect(
      document.querySelector<HTMLElement>('[data-media-frame]')!.getAttribute('style')
    ).not.toContain('url(');
  });

  it('is still watchable when the hint is in the future or absent', () => {
    render(video({ intent: 'reel-message', expiresAtMs: Date.now() + 86_400_000 }));
    expect(tile()).not.toBeNull();
    expect(document.querySelector('[data-reel-tombstone]')).toBeNull();
  });
});

describe('MessageMediaRenderer - a video that is not a reel message', () => {
  it('stays a chat video: a picked clip carries no intent', () => {
    render(video(), { blobUrl: 'blob:https://canari.emse.fr/1' });
    expect(tile()).toBeNull();
    expect(document.querySelector('video')).not.toBeNull();
  });

  it('stays a chat video when the intent is on something that is not a video', () => {
    render(
      { ...video(), type: 'image', mimeType: 'image/webp', intent: 'reel-message' },
      { blobUrl: 'blob:https://canari.emse.fr/1' }
    );
    expect(tile()).toBeNull();
    expect(document.querySelector('img')).not.toBeNull();
  });
});
