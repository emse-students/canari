// @vitest-environment happy-dom
/**
 * A REFETCH OF THE THREAD MUST NOT RE-DOWNLOAD, RE-DECRYPT OR RE-RENDER AN ATTACHMENT THAT DID NOT
 * CHANGE. Every refetch of a salon's messages hands each row a NEW message object carrying the SAME
 * content; the bubble re-parses it into a new envelope, so a download effect keyed on the media ref
 * OBJECT tore its blob URL down and fetched it again. For a PDF that remounted the first-page
 * thumbnail, which spawned a fresh pdf.js worker: two worker loads per refetch, 36 in three minutes
 * on a salon with two PDFs (web console, 2026-10-12,
 * [web-console-log-audit](docs/wiki/frontend/web-console-log-audit-2026-10-12.md)).
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
      return Promise.resolve(`blob:test/${ref.mediaId}`);
    }
  },
}));

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';

const mounted: (() => void)[] = [];

beforeEach(() => {
  downloads.length = 0;
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

function file(mediaId: string): MediaRef {
  return {
    type: 'file',
    mediaId,
    key: '00'.repeat(32),
    iv: '00'.repeat(12),
    mimeType: 'application/pdf',
    fileName: 'doc.pdf',
    size: 1,
  };
}

/** Mounts a bubble whose props are read through a getter, the way a parent `{#each}` passes them. */
function render(initial: MediaRef) {
  const row = $state({ msg: { id: 'm1', content: serializeEnvelope(mkMediaEnvelope(initial)) } });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'm1',
      senderId: 'u-other',
      currentUserId: 'u-me',
      authToken: 'tok',
      get content() {
        return row.msg.content;
      },
      timestamp: new Date('2026-10-12T10:00:00Z'),
      isOwn: false,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return row;
}

describe('MessageBubble - a refetched thread', () => {
  it('keeps the attachment it already holds when the same message comes back', async () => {
    const row = render(file('media-1'));
    await vi.waitFor(() => expect(downloads).toEqual(['media-1']));

    // What a refetch does: a new message object, the same bytes of content.
    row.msg = { id: 'm1', content: serializeEnvelope(mkMediaEnvelope(file('media-1'))) };
    flushSync();
    await Promise.resolve();

    expect(downloads).toEqual(['media-1']);
  });

  it('still fetches when the attachment itself changes', async () => {
    const row = render(file('media-1'));
    await vi.waitFor(() => expect(downloads).toEqual(['media-1']));

    row.msg = { id: 'm1', content: serializeEnvelope(mkMediaEnvelope(file('media-2'))) };
    flushSync();

    await vi.waitFor(() => expect(downloads).toEqual(['media-1', 'media-2']));
  });
});
