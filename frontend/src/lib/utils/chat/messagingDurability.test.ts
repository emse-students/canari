import { sendChatMessage } from './messaging';
import type { Conversation } from '$lib/types';

const enqueueOutboxMessage = vi.fn().mockResolvedValue(undefined);
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
