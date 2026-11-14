// @vitest-environment happy-dom
/**
 * The conversation viewer walks a list: Left/Right and the arrow buttons move, the ends stop, a
 * video stops when the next item replaces it, and the known url of the opened item is used.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import type { SharedMediaItem } from '$lib/utils/chat/sharedContent';
import type { MediaRef } from '$lib/media';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/media', () => ({
  MediaService: class {
    downloadAndDecrypt(ref: MediaRef) {
      return Promise.resolve(`blob:${ref.mediaId}`);
    }
  },
}));
vi.mock('../shared/VideoPlayer.svelte', async () => ({
  default: (await import('./ConversationMediaViewer.videoStub.test-helper.svelte')).default,
}));

import ConversationMediaViewer from './ConversationMediaViewer.svelte';
import { viewerItemKey } from '$lib/utils/chat/viewerSequence';
import { videoStubEvents } from './ConversationMediaViewer.videoStub.test-helper.svelte';

afterAll(adoptTransitionAnimations());

const handles: (() => void)[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!();
  document.body.innerHTML = '';
  videoStubEvents.length = 0;
});

function entry(id: string, type: 'image' | 'video' = 'image'): SharedMediaItem {
  return {
    messageId: id,
    senderId: 'u',
    timestamp: 1,
    media: { mediaId: `m-${id}`, type } as MediaRef,
  };
}

const settle = async () => {
  flushSync();
  await tick();
  await tick();
};

async function open(items: SharedMediaItem[], start: string, extra: object = {}) {
  const startItem = items.find((i) => i.messageId === start)!;
  const instance = mount(ConversationMediaViewer, {
    target: document.body,
    props: {
      items,
      startKey: viewerItemKey(startItem),
      onClose: () => {},
      authToken: 't',
      ...extra,
    },
  });
  handles.push(() => unmount(instance));
  await settle();
}

const shownSrc = () => document.querySelector('img')?.getAttribute('src');
const press = (key: string) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

describe('ConversationMediaViewer', () => {
  const list = [entry('a'), entry('b'), entry('c')];

  it('opens on the asked item', async () => {
    await open(list, 'b');
    expect(shownSrc()).toBe('blob:m-b');
  });

  it('moves with Right (next) and Left (previous)', async () => {
    await open(list, 'b');
    press('ArrowRight');
    await settle();
    expect(shownSrc()).toBe('blob:m-c');
    press('ArrowLeft');
    await settle();
    press('ArrowLeft');
    await settle();
    expect(shownSrc()).toBe('blob:m-a');
  });

  it('stops at both ends, without wrapping', async () => {
    await open(list, 'a');
    press('ArrowLeft');
    await settle();
    expect(shownSrc()).toBe('blob:m-a');
    for (let i = 0; i < 3; i++) {
      press('ArrowRight');
      await settle();
    }
    expect(shownSrc()).toBe('blob:m-c');
  });

  it('draws an arrow button only where a move is possible', async () => {
    await open(list, 'a');
    expect(
      document.querySelector('button[aria-label="' + m.media_lightbox_prev_aria() + '"]')
    ).toBeNull();
    expect(
      document.querySelector('button[aria-label="' + m.media_lightbox_next_aria() + '"]')
    ).not.toBeNull();
  });

  it('stops a video when the next item replaces it', async () => {
    await open([entry('a', 'video'), entry('b')], 'a');
    expect(videoStubEvents).toContain('mount');
    expect(videoStubEvents).not.toContain('destroy');
    press('ArrowRight');
    await settle();
    expect(videoStubEvents).toContain('destroy');
    expect(shownSrc()).toBe('blob:m-b');
  });

  it('shows the known url of the opened item and offers no move for a single item', async () => {
    const own = entry('b');
    await open([own], 'b', { known: { key: viewerItemKey(own), url: 'blob:known' } });
    expect(shownSrc()).toBe('blob:known');
    expect(
      document.querySelector('button[aria-label="' + m.media_lightbox_next_aria() + '"]')
    ).toBeNull();
  });
});
