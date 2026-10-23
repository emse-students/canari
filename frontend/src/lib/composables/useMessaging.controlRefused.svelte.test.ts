// @vitest-environment happy-dom
/**
 * A CONTROL ACTION THE DURABLE QUEUE REFUSES IS SHOWN, NOT ABSORBED (WP-CONTROL-NOTICE).
 *
 * Before: `enqueueControlEvent` swallowed the `OutboxEnqueueError`, so a delete the queue could not
 * take was tombstoned locally anyway while the peers kept the message. Now the delete stays visible
 * with a mention, and only a Retry the queue takes writes the tombstone.
 *
 * And the review of #2055: a refusal is kept PER ACT (a later act on the same message no longer
 * erases it), and it is DURABLE like the optimistic state it describes (a reload no longer leaves a
 * reaction shown here that no peer has, with nothing to retry).
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
  clearMessageControlRefusals,
  controlRefusalsFor,
  forgetControlRefusals,
  loadControlRefusals,
  retryControlRefusal,
  MAX_CONTROL_REFUSALS,
  recordControlRefusal,
  setControlRetryExecutor,
} from '$lib/utils/chat/controlRefusals.svelte';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import type { ChatMessage, Conversation } from '$lib/types';

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
type Messaging = ReturnType<typeof import('./useMessaging.svelte').useMessaging>;

function ctxFor(message: Partial<ChatMessage> = {}) {
  const conversations = new SvelteMap<string, Conversation>([
    [
      'alice',
      {
        id: 'g1',
        name: 'alice',
        unreadCount: 0,
        lastMessageAt: 0,
        messages: [
          { id: 'm1', senderId: 'me', content: 'hello', timestamp: new Date(), ...message },
        ],
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

/** Wires the notice's Retry to `messaging` with `ctx`, as the chat page does. */
function wire(messaging: Messaging, ctx: MessagingContext) {
  setControlRetryExecutor((r) => messaging.retryRefusedControl(r, ctx));
}

const refuseNext = () =>
  outboxMock.enqueueOutboxMessage.mockRejectedValueOnce(new OutboxEnqueueError('no storage'));
const keys = () => controlRefusalsFor('m1').map((r) => r.key);
const kinds = () => controlRefusalsFor('m1').map((r) => r.act.kind);

beforeEach(() => {
  localStorage.clear();
  forgetControlRefusals();
  loadControlRefusals('me');
  outboxMock.cancelOutboxMessage.mockReset().mockResolvedValue(false);
  outboxMock.enqueueOutboxMessage.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  setControlRetryExecutor(null);
  forgetControlRefusals();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('a refused delete', () => {
  it('is not tombstoned, carries a notice, and a taken Retry tombstones it', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx, conversations } = ctxFor();
    wire(messaging, ctx);
    refuseNext();

    await messaging.handleDeleteMessage('m1', ctx);

    expect(conversations.get('alice')!.messages[0].isDeleted).toBeFalsy();
    expect(kinds()).toEqual(['delete']);

    // Retry refused again: still not deleted, the notice stays.
    refuseNext();
    expect(await retryControlRefusal(keys()[0])).toBe(false);
    expect(conversations.get('alice')!.messages[0].isDeleted).toBeFalsy();
    expect(kinds()).toEqual(['delete']);

    // Retry taken: the tombstone is written and the notice goes.
    expect(await retryControlRefusal(keys()[0])).toBe(true);
    expect(conversations.get('alice')!.messages[0].isDeleted).toBe(true);
    expect(kinds()).toEqual([]);
  });

  it('a delete the queue takes is tombstoned at once with no notice (control)', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const { ctx, conversations } = ctxFor();
    await useMessaging().handleDeleteMessage('m1', ctx);
    expect(conversations.get('alice')!.messages[0].isDeleted).toBe(true);
    expect(kinds()).toEqual([]);
  });

  it('a local follow-up that throws after the queue took it cannot queue a second delete', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx, conversations } = ctxFor();
    wire(messaging, ctx);
    refuseNext();
    await messaging.handleDeleteMessage('m1', ctx);
    const key = keys()[0];

    vi.spyOn(conversations, 'set').mockImplementationOnce(() => {
      throw new Error('render failed');
    });
    await expect(retryControlRefusal(key)).rejects.toThrow('render failed');
    // The queue took it: the refusal is gone BEFORE the follow-up, so a second tap does nothing.
    expect(await retryControlRefusal(key)).toBe(false);
    expect(outboxMock.enqueueOutboxMessage).toHaveBeenCalledTimes(2);
  });
});

describe('one refusal per act, never one per message (P2-a)', () => {
  it('a refused reaction survives a pin the queue takes, and its Retry still sends it', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx } = ctxFor();
    wire(messaging, ctx);

    refuseNext();
    await messaging.handleAddReaction('m1', '👍', ctx);
    await messaging.handleTogglePin('m1', ctx);
    await messaging.handleAddReaction('m1', '❤️', ctx);

    expect(kinds()).toEqual(['reaction']);
    expect(await retryControlRefusal(keys()[0])).toBe(true);
    expect(outboxMock.enqueueOutboxMessage).toHaveBeenCalledTimes(4);
    expect(kinds()).toEqual([]);
  });

  it('a refused pin and a refused reaction are both offered, each with its own Retry', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx } = ctxFor();
    wire(messaging, ctx);

    refuseNext();
    await messaging.handleTogglePin('m1', ctx);
    refuseNext();
    await messaging.handleAddReaction('m1', '👍', ctx);
    expect(kinds()).toEqual(['pin', 'reaction']);

    expect(await retryControlRefusal(keys()[0])).toBe(true);
    expect(kinds()).toEqual(['reaction']);
  });

  it('a newer act with the same key supersedes the refusal (the same emoji taken back)', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx } = ctxFor();
    // Two distinct instants, so the take-back is a newer state of the pair (not a wall clock).
    let instant = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++instant);
    refuseNext();
    await messaging.handleAddReaction('m1', '👍', ctx);
    await messaging.handleAddReaction('m1', '👍', ctx);
    expect(kinds()).toEqual([]);
  });

  it('a delete landing from elsewhere drops every refusal of the message', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx } = ctxFor();
    refuseNext();
    await messaging.handleTogglePin('m1', ctx);
    refuseNext();
    await messaging.handleAddReaction('m1', '👍', ctx);
    clearMessageControlRefusals('m1');
    expect(kinds()).toEqual([]);
  });
});

describe('a refusal is as durable as the state it describes (P2-b)', () => {
  it('survives a reload, and its Retry runs from the stored act with a fresh context', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const { ctx } = ctxFor();
    refuseNext();
    await useMessaging().handleAddReaction('m1', '👍', ctx);
    const refused = controlRefusalsFor('m1')[0];
    expect(refused.act.kind).toBe('reaction');
    const at = (refused.act as { at: number }).at;

    // RELOAD: memory gone, a new composable, the row read back from storage with its reaction.
    forgetControlRefusals();
    expect(kinds()).toEqual([]);
    loadControlRefusals('me');
    expect(kinds()).toEqual(['reaction']);

    const after = ctxFor({ reactions: [{ emoji: '👍', userId: 'me', at }] });
    wire(useMessaging(), after.ctx);
    expect(await retryControlRefusal(keys()[0])).toBe(true);
    expect(outboxMock.enqueueOutboxMessage).toHaveBeenCalledTimes(2);
    expect(kinds()).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.controlRefusals('me'))).toBeNull();
  });

  it('a refusal whose act the reloaded row no longer shows is moot: dropped, nothing sent', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const { ctx } = ctxFor();
    refuseNext();
    await useMessaging().handleAddReaction('m1', '👍', ctx);

    forgetControlRefusals();
    loadControlRefusals('me');
    const after = ctxFor();
    wire(useMessaging(), after.ctx);
    expect(await retryControlRefusal(keys()[0])).toBe(false);
    expect(outboxMock.enqueueOutboxMessage).toHaveBeenCalledTimes(1);
    expect(kinds()).toEqual([]);
  });

  it('an edit is retried with the text the row holds, never a stored copy of it', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx } = ctxFor();
    wire(messaging, ctx);
    refuseNext();
    await messaging.handleEditMessage('m1', 'hello again', ctx);
    expect(localStorage.getItem(ACCOUNT_KEY.controlRefusals('me'))).not.toContain('hello');

    expect(await retryControlRefusal(keys()[0])).toBe(true);
    const { decodeAppMessage } = await import('$lib/proto/codec');
    const entry = outboxMock.enqueueOutboxMessage.mock.calls[1][0] as { controlProto: Uint8Array };
    const data = JSON.parse(decodeAppMessage(entry.controlProto)!.system!.data!);
    expect(data.newContent).toBe('hello again');
  });

  it('a sign-out unbinds the notices from memory and keeps them for the account', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx } = ctxFor();
    refuseNext();
    await messaging.handleTogglePin('m1', ctx);
    messaging.forgetAccount(() => {});
    expect(kinds()).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.controlRefusals('me'))).toContain('"pin"');
  });
});

describe('the review of 2d5a041f7', () => {
  it('a retry that settles late keeps a NEWER refusal recorded under the same key', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const messaging = useMessaging();
    const { ctx } = ctxFor();
    wire(messaging, ctx);
    let instant = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++instant);

    refuseNext();
    await messaging.handleAddReaction('m1', '👍', ctx);
    let releaseRetry!: () => void;
    outboxMock.enqueueOutboxMessage.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseRetry = resolve))
    );
    const retried = retryControlRefusal(keys()[0]);
    await vi.waitFor(() => expect(outboxMock.enqueueOutboxMessage).toHaveBeenCalledTimes(2));

    // Meanwhile the 👍 is taken back, and that removal is refused too.
    refuseNext();
    await messaging.handleAddReaction('m1', '👍', ctx);
    releaseRetry();
    expect(await retried).toBe(true);

    const left = controlRefusalsFor('m1');
    expect(left).toHaveLength(1);
    expect(left[0].act).toMatchObject({ kind: 'reaction', emoji: '👍', remove: true });
  });

  it('an act settling after an account switch writes to its own account and never rebinds', async () => {
    const { useMessaging } = await import('./useMessaging.svelte');
    const { ctx } = ctxFor();
    let refuse!: () => void;
    outboxMock.enqueueOutboxMessage.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => (refuse = () => reject(new OutboxEnqueueError('slow'))))
    );
    const pinning = useMessaging().handleTogglePin('m1', ctx);
    await vi.waitFor(() => expect(outboxMock.enqueueOutboxMessage).toHaveBeenCalledTimes(1));

    forgetControlRefusals();
    loadControlRefusals('other');
    refuse();
    await pinning;

    expect(kinds()).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.controlRefusals('other'))).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.controlRefusals('me'))).toContain('"pin"');
    // Still bound to `other`: a refusal of it shows, `me`'s does not come back.
    recordControlRefusal('other', {
      conversationId: 'g1',
      messageId: 'm1',
      act: { kind: 'delete' },
    });
    expect(kinds()).toEqual(['delete']);
  });

  it('keeps at most MAX_CONTROL_REFUSALS, the oldest evicted', () => {
    for (let i = 0; i <= MAX_CONTROL_REFUSALS; i++) {
      recordControlRefusal('me', {
        conversationId: 'g1',
        messageId: `x${i}`,
        act: { kind: 'delete' },
      });
    }
    const stored = JSON.parse(localStorage.getItem(ACCOUNT_KEY.controlRefusals('me'))!);
    expect(stored).toHaveLength(MAX_CONTROL_REFUSALS);
    expect(controlRefusalsFor('x0')).toEqual([]);
    expect(controlRefusalsFor(`x${MAX_CONTROL_REFUSALS}`)).toHaveLength(1);
  });

  it('a purged conversation takes its refusals with it', async () => {
    const { purgeConversation } = await import('$lib/utils/chat/conversations');
    const { conversations } = ctxFor();
    recordControlRefusal('me', { conversationId: 'g1', messageId: 'm1', act: { kind: 'delete' } });
    await purgeConversation({ conversations, key: 'alice' });
    expect(kinds()).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.controlRefusals('me'))).toBeNull();
  });
});
