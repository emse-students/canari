import { sendChatMessage } from './messaging';
import { MessagePairWriteError, MessageWrittenError } from './messageWrittenError';
import type { Conversation } from '$lib/types';
import { serializeEnvelope, mkTextEnvelope } from '$lib/envelope';

const enqueueOutboxMessage = vi.fn().mockResolvedValue(undefined);
/** The outbox's own refusal type, kept real: what is asserted is that nobody re-types it. */
class OutboxEnqueueError extends Error {}
vi.mock('./outbox', () => ({
  enqueueOutboxMessage: (...args: unknown[]) => enqueueOutboxMessage(...args),
  cancelOutboxMessage: vi.fn().mockResolvedValue(false),
}));

/**
 * A MESSAGE THE SENDER CAN SEE MUST BE A MESSAGE THE QUEUE WILL SEND.
 *
 * The echo and its outbox entry used to be two awaits in that order: persist the message, then
 * queue it. A document torn down between them - a reload fired inside the send's own async tail -
 * left a `pending` row on disk that no queue knew about. It was never sent, never retried and never
 * reported, and its author kept it on screen for ever.
 *
 * Measured on 2026-09-05 by TAB-5, which reloads 15 ms after the click: the console showed
 * `[SEND] sendChatMessage` with NO `[OUTBOX] Queued` after it, the peer had nothing and the sender
 * had the message. Nothing in the suite could see it, because both writes succeeded in every test
 * that ever ran them - the defect is only in the gap BETWEEN them, so what has to be asserted is
 * that there is no gap: one call carries both.
 */
describe('sendChatMessage: the echo and its queue entry are one write', () => {
  const conversation = {
    id: 'group-1',
    name: 'alice',
    lifecycle: 'active',
    messages: [],
  } as unknown as Conversation;

  /** Records what each write was handed, and in which order. */
  function harness() {
    const calls: string[] = [];
    let options: Record<string, any> = {};
    return {
      calls,
      get options() {
        return options;
      },
      deps: {
        userId: 'me',
        conversation,
        deviceKeyB64: 'k',
        mlsService: {} as any,
        log: () => {},
        addMessageToChat: async (_s: string, _c: string, _n: string, o: Record<string, any>) => {
          calls.push('echo');
          options = o;
          // What a store that wrote the pair reports (`useMessaging`).
          o.onPairWritten?.();
        },
      } as any,
    };
  }

  beforeEach(() => {
    enqueueOutboxMessage.mockClear();
  });

  it('hands the entry to the write that persists the echo', async () => {
    const h = harness();
    const result = await sendChatMessage('hello', 'alice', null, h.deps);

    expect(result.success).toBe(true);
    // THE ASSERTION THE DEFECT WOULD FAIL: the entry travels WITH the echo, not after it.
    expect(h.options.outboxEntry).toBeDefined();
    expect(h.options.outboxEntry.id).toBe(h.options.messageId);
    expect(h.options.outboxEntry.conversationId).toBe('group-1');
    expect(h.options.outboxEntry.kind).toBe('text');
    expect(h.options.outboxEntry.status).toBe('pending');
    expect(h.options.outboxEntry.attempts).toBe(0);
  });

  it('and then asks the outbox only for the live half, the row being already durable', async () => {
    const h = harness();
    await sendChatMessage('hello', 'alice', null, h.deps);

    expect(enqueueOutboxMessage).toHaveBeenCalledTimes(1);
    const [entry, opts] = enqueueOutboxMessage.mock.calls[0];
    // The same entry, so the mirror and the flush act on the row that was just written.
    expect(entry.id).toBe(h.options.outboxEntry.id);
    // Without this the row is encrypted and written a second time, which is not merely wasteful:
    // it is a second chance to fail AFTER the fact is already durable.
    expect(opts).toEqual({ alreadyDurable: true });
  });

  it('the echo is written before the flush is asked for, never the other way round', async () => {
    const h = harness();
    enqueueOutboxMessage.mockImplementation(async () => {
      h.calls.push('enqueue');
    });
    await sendChatMessage('hello', 'alice', null, h.deps);
    expect(h.calls).toEqual(['echo', 'enqueue']);
  });

  it('a throw AFTER the durable write reaches the caller typed as a written message', async () => {
    // Review of #2843, A3: the quick-reply drain put a reply back on any throw, and the next take
    // sent it a second time beside the copy the outbox already held. The OUTBOX classifies it at
    // the throw (M1, `outbox.test.ts`); the send path passes it on untouched.
    const h = harness();
    enqueueOutboxMessage.mockImplementationOnce(async (entry: { id: string }) => {
      throw new MessageWrittenError(entry.id, new Error('mirror write failed'));
    });
    const sent = sendChatMessage('hello', 'alice', null, h.deps);
    await expect(sent).rejects.toBeInstanceOf(MessageWrittenError);
    await expect(sent).rejects.toMatchObject({ messageId: h.options.messageId });
  });

  it('a refusal before any write is passed on as it is - never called a written message (M1)', async () => {
    const h = harness();
    enqueueOutboxMessage.mockImplementationOnce(async () => {
      throw new OutboxEnqueueError('no storage layer');
    });
    const sent = sendChatMessage('hello', 'alice', null, h.deps);
    await expect(sent).rejects.toBeInstanceOf(OutboxEnqueueError);
    await expect(sent).rejects.not.toBeInstanceOf(MessageWrittenError);
  });

  it('a throw BEFORE the write is not one', async () => {
    const h = harness();
    h.deps.addMessageToChat = async () => {
      throw new Error('storage refused');
    };
    const sent = sendChatMessage('hello', 'alice', null, h.deps);
    await expect(sent).rejects.toThrow('storage refused');
    await expect(sent).rejects.not.toBeInstanceOf(MessageWrittenError);
  });

  it('a pair write that FAILED is not called durable: the outbox writes its own row (M1)', async () => {
    const h = harness();
    h.deps.addMessageToChat = async (_s: string, _c: string, _n: string, o: any) => {
      throw new MessagePairWriteError(o.messageId, new Error('quota'));
    };
    const result = await sendChatMessage('hello', 'alice', null, h.deps);
    expect(result.success).toBe(true);
    expect(enqueueOutboxMessage).toHaveBeenCalledTimes(1);
    expect(enqueueOutboxMessage.mock.calls[0][1]).toBeUndefined();
  });

  it('a store that wrote nothing (no storage) is not called durable either', async () => {
    const h = harness();
    h.deps.addMessageToChat = async () => {};
    await sendChatMessage('hello', 'alice', null, h.deps);
    expect(enqueueOutboxMessage.mock.calls[0][1]).toBeUndefined();
  });

  it('a reply carries its quote into the entry, and still travels with the echo', async () => {
    const h = harness();
    const replyingTo = {
      id: 'm-0',
      senderId: 'alice',
      content: JSON.stringify({ kind: 'text', text: 'first' }),
    } as any;
    await sendChatMessage('answer', 'alice', replyingTo, h.deps);

    expect(h.options.outboxEntry.kind).toBe('reply');
    expect(h.options.outboxEntry.replyTo.id).toBe('m-0');
  });

  it('an empty message writes nothing at all - no echo, no entry', async () => {
    const h = harness();
    const result = await sendChatMessage('   ', 'alice', null, h.deps);
    expect(result.success).toBe(false);
    expect(h.calls).toEqual([]);
    expect(enqueueOutboxMessage).not.toHaveBeenCalled();
  });

  it('a removed conversation is refused before either write', async () => {
    const h = harness();
    h.deps.conversation = { ...conversation, lifecycle: 'removed' };
    const result = await sendChatMessage('hello', 'alice', null, h.deps);
    expect(result.success).toBe(false);
    expect(h.calls).toEqual([]);
    expect(enqueueOutboxMessage).not.toHaveBeenCalled();
  });
});

/**
 * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14), and whether a reply may carry its quote
 * text is decided by the OUTBOX at the send (`decideQuote`). Composing reads nothing: a round trip
 * per reply was a cost, and a compose made offline used to lose its quote for good (second review
 * of #1878).
 */
describe('sendChatMessage - composing a reply asks the server nothing', () => {
  const conversation = { id: 'group-1', lifecycle: 'active' } as unknown as Conversation;
  const quoted = {
    id: 'q1',
    senderId: 'carol',
    content: serializeEnvelope(mkTextEnvelope('said while Bob was out')),
    timestamp: new Date(1_700_000_000_000),
    serverTimestamp: 1_700_000_000_000,
  } as never;

  it('queues the quote text as composed, and reads no exclusion window', async () => {
    let options: Record<string, any> = {};
    const getGroupExclusions = vi.fn();
    await sendChatMessage('replying', 'alice', quoted, {
      userId: 'me',
      conversation,
      log: () => {},
      mlsService: { getGroupExclusions },
      addMessageToChat: async (_s: string, _c: string, _n: string, o: Record<string, any>) => {
        options = o;
      },
    } as any);

    expect(getGroupExclusions).not.toHaveBeenCalled();
    expect(options.outboxEntry.replyTo.preview).toBe('said while Bob was out');
  });
});
