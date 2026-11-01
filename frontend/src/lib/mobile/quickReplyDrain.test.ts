// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

import { MessageWrittenError } from '$lib/utils/chat/messageWrittenError';
import {
  NATIVE_QUICK_REPLY_EVENT,
  drainNativeQuickReplies,
  listenForNativeQuickReplies,
  parseNativeQuickReply,
  resetQuickReplyDrainForTest,
  setNativeQuickReplySender,
  type NativeQuickReply,
  type QuickReplyOutcome,
  type QuickReplySender,
  type QuickReplyStore,
  type SendQuickReply,
} from './quickReplyDrain';

const ME = 'me@x.fr';

const line = (groupId: string, text: string, replyId = `r-${groupId}`) =>
  JSON.stringify({ replyId, accountId: ME, groupId, text, notifiedAt: 5, repliedAt: 9 });

/** A file the native side appends to, taken by a claim, appended back to, and acknowledged. */
function fakeStore(initial: string[] = []) {
  let file = [...initial];
  const acks: [string, QuickReplyOutcome][] = [];
  const store: QuickReplyStore & {
    file: () => string[];
    append: (l: string) => void;
    acks: [string, QuickReplyOutcome][];
  } = {
    take: vi.fn(async () => {
      const taken = file;
      file = [];
      return taken;
    }),
    putBack: vi.fn(async (lines: string[]) => {
      file = [...file, ...lines];
    }),
    acknowledge: vi.fn(async (replyId: string, outcome: QuickReplyOutcome) => {
      acks.push([replyId, outcome]);
    }),
    file: () => file,
    append: (l) => file.push(l),
    acks,
  };
  return store;
}

/** A session that sends with `send` and records what it shows the member. */
function as(send: SendQuickReply) {
  const told: [string, string | null][] = [];
  const sender: QuickReplySender & { told: typeof told } = {
    accountId: ME,
    send,
    tell: (kind, reply) => told.push([kind, reply?.replyId ?? null]),
    told,
  };
  return sender;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('parseNativeQuickReply', () => {
  it('reads the line the native side writes', () => {
    expect(parseNativeQuickReply(line('g1', '  hello '))).toEqual({
      replyId: 'r-g1',
      groupId: 'g1',
      text: 'hello',
      notifiedAt: 5,
      repliedAt: 9,
    });
  });

  it('drops what names no id, no conversation or no text', () => {
    expect(parseNativeQuickReply('nope')).toBeNull();
    expect(parseNativeQuickReply(line('g', 'x', ''))).toBeNull();
    expect(parseNativeQuickReply(line('', 'x'))).toBeNull();
    expect(parseNativeQuickReply(line('g', '   '))).toBeNull();
  });
});

describe('a quick reply handed to the page is never lost, never sent twice, never silent', () => {
  let store: ReturnType<typeof fakeStore>;
  beforeEach(() => {
    store = fakeStore();
    resetQuickReplyDrainForTest(store);
  });

  it('takes nothing while no session can send it - the file waits', async () => {
    store.append(line('g1', 'hi'));
    await drainNativeQuickReplies('test');
    expect(store.take).not.toHaveBeenCalled();
    expect(store.file()).toHaveLength(1);
  });

  it('takes only the signed-in account replies (A2)', async () => {
    setNativeQuickReplySender(as(async () => 'sent'));
    await settle();
    expect(store.take).toHaveBeenCalledWith(ME);
  });

  it.each(['sent', 'failed', 'pending'] as const)(
    'acknowledges a reply with how the queue SETTLED it: %s (H1)',
    async (outcome) => {
      store.append(line('g1', 'hi'));
      const sent: NativeQuickReply[] = [];
      const session = as(async (r) => {
        sent.push(r);
        return outcome;
      });
      setNativeQuickReplySender(session);
      await settle();
      expect(sent.map((r) => [r.groupId, r.text])).toEqual([['g1', 'hi']]);
      expect(store.file()).toEqual([]);
      expect(store.acks).toEqual([['r-g1', outcome]]);
      // The page shows a failed or pending message itself, and the native side tells the rest.
      expect(session.told).toEqual([]);
    }
  );

  it('does not acknowledge before the send has settled (H1)', async () => {
    let settleSend: (o: 'sent') => void = () => {};
    setNativeQuickReplySender(as(() => new Promise((r) => (settleSend = r))));
    await settle();
    store.append(line('g1', 'hi'));
    const drained = drainNativeQuickReplies('event');
    await settle();
    expect(store.acks).toEqual([]);
    settleSend('sent');
    await drained;
    expect(store.acks).toEqual([['r-g1', 'sent']]);
  });

  it('puts back a reply the page could not queue, says it waits, and sends it on a later take', async () => {
    let conversationLoaded = false;
    const send = vi.fn(async () =>
      conversationLoaded ? ('sent' as const) : ('not-queued' as const)
    );
    const session = as(send);
    setNativeQuickReplySender(session);
    await settle();

    store.append(line('g1', 'first'));
    await drainNativeQuickReplies('event');
    expect(store.putBack).toHaveBeenCalledOnce();
    expect(store.file()).toEqual([line('g1', 'first')]);
    expect(store.acks).toEqual([['r-g1', 'returned']]);
    expect(session.told).toEqual([['waiting', 'r-g1']]);

    // Taken again and still not queued: said once, not on every take.
    await drainNativeQuickReplies('again');
    expect(session.told).toEqual([['waiting', 'r-g1']]);

    conversationLoaded = true;
    await drainNativeQuickReplies('conversations loaded');
    expect(send).toHaveBeenCalledTimes(3);
    expect(store.file()).toEqual([]);
    expect(store.acks.at(-1)).toEqual(['r-g1', 'sent']);
  });

  it('puts back a reply whose send threw before any write', async () => {
    setNativeQuickReplySender(
      as(async () => {
        throw new Error('outbox gone');
      })
    );
    await settle();
    store.append(line('g1', 'x'));
    await drainNativeQuickReplies('event');
    expect(store.file()).toEqual([line('g1', 'x')]);
    expect(store.acks).toEqual([['r-g1', 'returned']]);
  });

  it('never puts back a reply whose send threw AFTER writing it - it would go twice (A3)', async () => {
    setNativeQuickReplySender(
      as(async () => {
        throw new MessageWrittenError('m-1', new Error('mirror failed'));
      })
    );
    await settle();
    store.append(line('g1', 'x'));
    await drainNativeQuickReplies('event');
    expect(store.putBack).not.toHaveBeenCalled();
    expect(store.file()).toEqual([]);
    expect(store.acks).toEqual([['r-g1', 'pending']]);
  });

  it('acknowledges an unreadable line LOST at once - the native side tells the user', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const session = as(send);
    setNativeQuickReplySender(session);
    await settle();
    store.append(JSON.stringify({ replyId: 'r-bad', accountId: ME, groupId: 'g', text: '  ' }));
    await drainNativeQuickReplies('event');
    expect(send).not.toHaveBeenCalled();
    expect(store.acks).toEqual([['r-bad', 'lost']]);
    // One surface: the native side shows its "not sent" notice for a reply it is told is lost.
    expect(session.told).toEqual([]);
  });

  it('shows a lost line itself when it names no id - nobody else could', async () => {
    const session = as(async () => 'sent');
    setNativeQuickReplySender(session);
    await settle();
    store.append('not json');
    await drainNativeQuickReplies('event');
    expect(store.acks).toEqual([]);
    expect(session.told).toEqual([['lost', null]]);
  });

  it('shows a lost reply itself when the native side could not be told', async () => {
    const session = as(async () => 'not-queued');
    setNativeQuickReplySender(session);
    await settle();
    vi.mocked(store.putBack).mockRejectedValueOnce(new Error('no cache key'));
    vi.mocked(store.acknowledge).mockRejectedValueOnce(new Error('bridge gone'));
    store.append(line('g1', 'x'));
    await drainNativeQuickReplies('event');
    expect(session.told).toEqual([['lost', 'r-g1']]);
  });

  it('a reply neither queued nor put back is acknowledged lost', async () => {
    const session = as(async () => 'not-queued');
    setNativeQuickReplySender(session);
    await settle();
    vi.mocked(store.putBack).mockRejectedValueOnce(new Error('no cache key'));
    store.append(line('g1', 'x'));
    await drainNativeQuickReplies('event');
    expect(store.acks).toEqual([['r-g1', 'lost']]);
    expect(session.told).toEqual([]);
  });

  it('drains when the native side says a reply waits', async () => {
    const send = vi.fn(async () => 'sent' as const);
    setNativeQuickReplySender(as(send));
    await settle();
    const stop = listenForNativeQuickReplies();
    store.append(line('g2', 'yo'));
    window.dispatchEvent(new CustomEvent(NATIVE_QUICK_REPLY_EVENT));
    await settle();
    stop();
    expect(send).toHaveBeenCalledOnce();
    expect(store.file()).toEqual([]);
  });

  it('drains when the app comes back to the front - a put-back reply is sent by opening it (M2)', async () => {
    const send = vi.fn(async () => 'sent' as const);
    setNativeQuickReplySender(as(send));
    await settle();
    const stop = listenForNativeQuickReplies();
    store.append(line('g3', 'later'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    stop();
    expect(send).toHaveBeenCalledOnce();
    expect(store.acks).toEqual([['r-g3', 'sent']]);
  });
});
