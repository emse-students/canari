/**
 * A REPLY WHOSE CONVERSATION WILL NEVER TAKE IT IS `gone`, READ FROM THE FACTS (round-4 review of
 * #2843).
 *
 * `sendTextTo` answered `not-queued` for a conversation that was not in memory, and the quick-reply
 * drain put such a reply back - for ever when the conversation was removed or unknown to this
 * device. It now reads the row: in memory, else in storage. Removed or absent is `gone` (acked LOST,
 * so the user sees "reply not sent"); stored but not loaded yet, or unreadable, stays `not-queued`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle break as the other useMessaging tests.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

function makeContext(
  inMemory: Conversation | null,
  getConversation: () => Promise<unknown>
): MessagingContext {
  const conversations = new SvelteMap<string, Conversation>(inMemory ? [['g1', inMemory]] : []);
  return {
    conversations,
    userId: 'me',
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: null,
    storage: { getConversation: vi.fn(getConversation) } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
}

const removed = {
  id: 'g1',
  name: 'g1',
  lifecycle: 'removed',
  messages: [],
} as unknown as Conversation;

describe('sendTextTo classifies a conversation that will never take the reply', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('a REMOVED conversation in memory is gone - nothing is written', async () => {
    const ctx = makeContext(removed, async () => null);
    const { outcome } = await useMessaging().sendTextTo('hi', 'g1', ctx);
    expect(outcome).toBe('gone');
  });

  it('a conversation unknown to this device is gone', async () => {
    const ctx = makeContext(null, async () => null);
    expect((await useMessaging().sendTextTo('hi', 'g1', ctx)).outcome).toBe('gone');
  });

  it('a stored row that is removed is gone', async () => {
    const ctx = makeContext(null, async () => ({ id: 'g1', lifecycle: 'removed' }));
    expect((await useMessaging().sendTextTo('hi', 'g1', ctx)).outcome).toBe('gone');
  });

  it('a stored conversation not loaded yet is not-queued: a later take sends it', async () => {
    const ctx = makeContext(null, async () => ({ id: 'g1', lifecycle: 'active' }));
    expect((await useMessaging().sendTextTo('hi', 'g1', ctx)).outcome).toBe('not-queued');
  });

  it('an unreadable row proves nothing: not-queued', async () => {
    const ctx = makeContext(null, async () => {
      throw new Error('db closed');
    });
    expect((await useMessaging().sendTextTo('hi', 'g1', ctx)).outcome).toBe('not-queued');
  });
});
