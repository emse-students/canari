/**
 * A CONTROL ACTION THE DURABLE QUEUE REFUSES IS SHOWN, NOT ABSORBED (WP-CONTROL-NOTICE).
 *
 * Before: `enqueueControlEvent` swallowed the `OutboxEnqueueError`, so a delete the queue could not
 * take was tombstoned locally anyway while the peers kept the message. Now the delete stays visible
 * with a mention, and only a Retry the queue takes writes the tombstone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const outboxMock = vi.hoisted(() => ({
  cancelOutboxMessage: vi.fn(async () => false),
  enqueueOutboxMessage: vi.fn(async (_entry: unknown, _opts?: unknown) => {}),
}));
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/outbox')>()),
  ...outboxMock,
}));

await import('./useMessaging.svelte');

import { OutboxEnqueueError } from '$lib/utils/chat/outbox';
import {
  clearControlRefusal,
  controlRefusalFor,
  retryControlRefusal,
} from '$lib/utils/chat/controlRefusals.svelte';
import type { Conversation } from '$lib/types';

type MessagingContext = import('./useMessaging.svelte').MessagingContext;

function ctxFor() {
  const conversations = new SvelteMap<string, Conversation>([
    [
      'alice',
      {
        id: 'g1',
        name: 'alice',
        unreadCount: 0,
        lastMessageAt: 0,
        messages: [{ id: 'm1', senderId: 'me', content: 'hello', timestamp: new Date() }],
      } as never,
    ],
  ]);
  const ctx = {
    conversations,
    selectedContact: 'alice',
    userId: 'me',
    deviceKeyB64: 'k',
    log: vi.fn(),
    ensureMls: () => ({}),
  } as unknown as MessagingContext;
  return { ctx, conversations };
}

beforeEach(() => {
  outboxMock.cancelOutboxMessage.mockReset().mockResolvedValue(false);
  outboxMock.enqueueOutboxMessage.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  clearControlRefusal('m1');
  vi.restoreAllMocks();
});

describe('a refused delete', () => {
  it('is not tombstoned, carries a notice, and a taken Retry tombstones it', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const { ctx, conversations } = ctxFor();
    outboxMock.enqueueOutboxMessage.mockRejectedValueOnce(new OutboxEnqueueError('no storage'));

    await useMessaging().handleDeleteMessage('m1', ctx);

    expect(conversations.get('alice')!.messages[0].isDeleted).toBeFalsy();
    expect(controlRefusalFor('m1')?.kind).toBe('delete');

    // Retry refused again: still not deleted, the notice stays.
    outboxMock.enqueueOutboxMessage.mockRejectedValueOnce(new OutboxEnqueueError('no storage'));
    expect(await retryControlRefusal('m1')).toBe(false);
    expect(conversations.get('alice')!.messages[0].isDeleted).toBeFalsy();
    expect(controlRefusalFor('m1')).toBeDefined();

    // Retry taken: the tombstone is written and the notice goes.
    expect(await retryControlRefusal('m1')).toBe(true);
    expect(conversations.get('alice')!.messages[0].isDeleted).toBe(true);
    expect(controlRefusalFor('m1')).toBeUndefined();
  });

  it('a delete the queue takes is tombstoned at once with no notice (control)', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const { ctx, conversations } = ctxFor();
    await useMessaging().handleDeleteMessage('m1', ctx);
    expect(conversations.get('alice')!.messages[0].isDeleted).toBe(true);
    expect(controlRefusalFor('m1')).toBeUndefined();
  });
});

describe('a refused pin', () => {
  it('records a notice whose Retry re-enqueues the same act', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const { ctx } = ctxFor();
    outboxMock.enqueueOutboxMessage.mockRejectedValueOnce(new OutboxEnqueueError('no storage'));

    await useMessaging().handleTogglePin('m1', ctx);
    expect(controlRefusalFor('m1')?.kind).toBe('pin');

    expect(await retryControlRefusal('m1')).toBe(true);
    expect(outboxMock.enqueueOutboxMessage).toHaveBeenCalledTimes(2);
    expect(controlRefusalFor('m1')).toBeUndefined();
  });
});
