/**
 * THE ORPHAN VERDICT COMES FROM THE DURABLE QUEUE, NOT FROM THE IN-MEMORY STATUS (review of #1730).
 * A real queued upload after a reload has no status and must NOT read "never completed" - its Delete
 * would withdraw the real upload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

const queued = vi.fn<(id: string) => Promise<boolean | null>>();
vi.mock('$lib/utils/chat/outbox', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/chat/outbox')>()),
  isOutboxEntryQueued: (id: string) => queued(id),
}));

import MessageBubble from './MessageBubble.svelte';
import { serializeEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
beforeEach(() => queued.mockReset());
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
});

const file: MediaRef = {
  type: 'file',
  mediaId: '',
  key: '',
  iv: '',
  mimeType: 'application/pdf',
  size: 0,
  fileName: 'a.pdf',
};

async function render(props: { isOwn: boolean; status?: 'pending' | 'sent' }) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'm1',
      senderId: props.isOwn ? 'u-me' : 'u-other',
      currentUserId: 'u-me',
      authToken: 'tok',
      content: serializeEnvelope(mkMediaEnvelope(file)),
      timestamp: new Date('2026-10-05T10:00:00Z'),
      ...props,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

const orphanShown = () => document.body.textContent?.includes(m.media_orphan_label()) ?? false;

describe('MessageBubble - the orphan verdict', () => {
  it('own, status undefined, entry present: still queued, NOT an orphan (the false positive)', async () => {
    queued.mockResolvedValue(true);
    await render({ isOwn: true });
    expect(orphanShown()).toBe(false);
  });
  it('own, pending, entry present: the queued ring, not an orphan', async () => {
    queued.mockResolvedValue(true);
    await render({ isOwn: true, status: 'pending' });
    expect(orphanShown()).toBe(false);
  });
  it('own, no entry: an orphan with its delete', async () => {
    queued.mockResolvedValue(false);
    await render({ isOwn: true, status: 'sent' });
    expect(orphanShown()).toBe(true);
  });
  it('own, queue unreadable: not an orphan', async () => {
    queued.mockResolvedValue(null);
    await render({ isOwn: true });
    expect(orphanShown()).toBe(false);
  });
  it('received row: never asks the outbox, never an orphan', async () => {
    await render({ isOwn: false });
    expect(queued).not.toHaveBeenCalled();
    expect(orphanShown()).toBe(false);
  });
});
