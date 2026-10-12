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
import { beginOutboxEnqueue } from '$lib/utils/chat/outboxActivity.svelte';

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

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    flushSync();
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

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

describe('MessageBubble - the upload label of an entry the outbox has not started', () => {
  it('online it is QUEUED, never an accusation of the connection', async () => {
    queued.mockResolvedValue(true);
    await render({ isOwn: true, status: 'pending' });
    expect(document.body.textContent).toContain(m.upload_queued());
    expect(document.body.textContent).not.toContain(m.upload_waiting());
  });
  it('known offline it says waiting for a connection', async () => {
    const { connectivity } = await import('$lib/stores/connectivity.svelte');
    connectivity.notifyServerUnreachable();
    expect(connectivity.isOffline).toBe(true);
    queued.mockResolvedValue(true);
    await render({ isOwn: true, status: 'pending' });
    connectivity.reset();
    expect(document.body.textContent).toContain(m.upload_waiting());
  });
});

describe('MessageBubble - a normal send never flashes the orphan card', () => {
  it('in flight: never asked, never red; the row lands: asked again, still not red', async () => {
    queued.mockResolvedValue(false);
    const end = beginOutboxEnqueue('m1');
    await render({ isOwn: true, status: 'sent' });
    expect(queued).not.toHaveBeenCalled();
    expect(orphanShown()).toBe(false);
    queued.mockResolvedValue(true);
    end();
    await settle();
    expect(queued).toHaveBeenCalledWith('m1');
    expect(orphanShown()).toBe(false);
  });
  it('enqueue cleared with no row (rejected, not withdrawn): the re-ask shows the orphan', async () => {
    queued.mockResolvedValue(false);
    const end = beginOutboxEnqueue('m1');
    await render({ isOwn: true, status: 'sent' });
    expect(orphanShown()).toBe(false);
    end();
    await settle();
    expect(orphanShown()).toBe(true);
  });
});
