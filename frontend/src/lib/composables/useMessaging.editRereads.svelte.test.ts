// @vitest-environment happy-dom
/**
 * AN EDIT WRITES ONTO ITS CONVERSATION AS IT IS AFTER THE SEND, UNDER THE KEY IT STARTED ON (review
 * of #3988).
 *
 * `handleEditMessage` read the conversation, awaited the control act's enqueue, then wrote the copy
 * from before the await back - under whatever was selected by then. A message that landed during the
 * send was erased from memory, and a reader who had moved to another conversation got this one's
 * rows written under that one's key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { ChatMessage, Conversation } from '$lib/types';

const msg = (id: string, senderId: string, content: string): ChatMessage => ({
  id,
  senderId,
  content,
  timestamp: new Date(1_000),
  isOwn: senderId === 'me',
});

function ctxFor() {
  const conversations = new SvelteMap<string, Conversation>([
    [
      'alice',
      {
        id: 'g1',
        name: 'alice',
        unreadCount: 0,
        lastMessageAt: 0,
        messages: [msg('m1', 'me', 'hello')],
      } as never,
    ],
    ['bob', { id: 'g2', name: 'bob', unreadCount: 0, lastMessageAt: 0, messages: [] } as never],
  ]);
  const ctx = {
    conversations,
    selectedContact: 'alice',
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    userId: 'me',
    deviceKeyB64: 'k',
    log: vi.fn(),
    ensureMls: () => ({}),
  } as unknown as MessagingContext;
  return { ctx, conversations };
}

describe('an edit whose send is in flight', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    outboxMock.enqueueOutboxMessage.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('keeps what landed meanwhile, and writes under the conversation it started on', async () => {
    const { ctx, conversations } = ctxFor();
    // The send is held while a message lands in alice and the reader opens bob.
    outboxMock.enqueueOutboxMessage.mockImplementationOnce(async () => {
      const alice = conversations.get('alice')!;
      conversations.set('alice', {
        ...alice,
        messages: [...alice.messages, msg('m2', 'peer', 'landed meanwhile')],
      });
      (ctx as { selectedContact: string }).selectedContact = 'bob';
    });

    await useMessaging().handleEditMessage('m1', 'hello, edited', ctx);

    const alice = conversations.get('alice')!;
    expect(alice.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(alice.messages[0].isEdited).toBe(true);
    expect(alice.messages[0].content).toContain('hello, edited');
    expect(conversations.get('bob')!.messages).toEqual([]);
  });
});
