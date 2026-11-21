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
  settleNativeQuickRepliesAtSignOut,
  type NativeQuickReply,
  type QuickReplyOutcome,
  type QuickReplySender,
  type QuickReplyStore,
  type SendQuickReply,
} from './quickReplyDrain';

const ME = 'me@x.fr';

const line = (groupId: string, text: string, replyId = `r-${groupId}`) =>
  JSON.stringify({ replyId, accountId: ME, groupId, text, notifiedAt: 5, repliedAt: 9 });

/**
 * A file the native side appends to, taken by a claim, appended back to, and acknowledged; `order`
 * records the listings of unclaimed replies and the takes in the order they ran. `unclaimedIds` is
 * what the native record answers; `told` whether an acknowledgement reached a native listener.
 */
function fakeStore(initial: string[] = []) {
  let file = [...initial];
  const acks: [string, QuickReplyOutcome][] = [];
  const order: string[] = [];
  const store: QuickReplyStore & {
    file: () => string[];
    append: (l: string) => void;
    acks: [string, QuickReplyOutcome][];
    order: string[];
  } = {
    take: vi.fn(async (accountId: string) => {
      order.push(`take:${accountId}`);
      const taken = file;
      file = [];
      return taken;
    }),
    putBack: vi.fn(async (lines: string[]) => {
      file = [...file, ...lines];
    }),
    acknowledge: vi.fn(async (replyId: string, outcome: QuickReplyOutcome) => {
      acks.push([replyId, outcome]);
      return true;
    }),
    unclaimed: vi.fn(async (accountId: string) => {
      order.push(`unclaimed:${accountId}`);
      return [] as string[];
    }),
    file: () => file,
    append: (l) => file.push(l),
    acks,
    order,
  };
  return store;
}

/** A session that sends with `send`, holds what `held` says, and records what it shows the member. */
function as(send: SendQuickReply, held: QuickReplySender['heldAs'] = async () => null) {
  const told: [string, string | null][] = [];
  const sender: QuickReplySender & { told: typeof told } = {
    accountId: ME,
    send,
    heldAs: vi.fn(held),
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

  it('a reply whose conversation is GONE is acknowledged lost, never put back (round 4)', async () => {
    const send = vi.fn(async () => 'gone' as const);
    const session = as(send);
    setNativeQuickReplySender(session);
    await settle();
    store.append(line('removed-group', 'x'));
    await drainNativeQuickReplies('event');
    expect(store.putBack).not.toHaveBeenCalled();
    expect(store.file()).toEqual([]);
    expect(store.acks).toEqual([['r-removed-group', 'lost']]);
    // The native side shows its "not sent" notice for a lost reply; the page adds nothing.
    expect(session.told).toEqual([]);
    // Never comes round again.
    await drainNativeQuickReplies('again');
    expect(send).toHaveBeenCalledOnce();
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

describe('Android: the banner follows the page, and a dead page is settled before any take', () => {
  let store: ReturnType<typeof fakeStore>;
  beforeEach(() => {
    store = fakeStore();
    resetQuickReplyDrainForTest(store);
  });

  it('sends a handed-over reply on the native event and acknowledges how it settled', async () => {
    const send = vi.fn(async () => 'pending' as const);
    const session = as(send);
    setNativeQuickReplySender(session);
    await settle();
    const stop = listenForNativeQuickReplies();
    store.append(line('g1', 'from the banner'));
    window.dispatchEvent(new CustomEvent(NATIVE_QUICK_REPLY_EVENT));
    await settle();
    stop();
    expect(send).toHaveBeenCalledOnce();
    expect(store.file()).toEqual([]);
    // Queued in the page's outbox is durably the page's: the banner is answered on this.
    expect(store.acks).toEqual([['r-g1', 'pending']]);
    expect(session.told).toEqual([]);
  });

  it('settles what a dead page took BEFORE the first take of the account, once per page life', async () => {
    store.append(line('g1', 'waiting'));
    setNativeQuickReplySender(as(async () => 'sent'));
    await settle();
    expect(store.order).toEqual(['unclaimed:me@x.fr', 'take:me@x.fr']);
    setNativeQuickReplySender(null);
    setNativeQuickReplySender(as(async () => 'sent'));
    await settle();
    expect(store.order).toEqual(['unclaimed:me@x.fr', 'take:me@x.fr', 'take:me@x.fr']);
  });

  it('takes nothing while the sweep runs - no reply of this life is in flight while it weighs', async () => {
    let answer: (ids: string[]) => void = () => {};
    store.unclaimed = vi.fn(
      (accountId: string) =>
        new Promise<string[]>((r) => {
          store.order.push(`unclaimed:${accountId}`);
          answer = r;
        })
    );
    store.append(line('g1', 'waiting'));
    setNativeQuickReplySender(as(async () => 'sent'));
    await settle();
    await drainNativeQuickReplies('event');
    expect(store.take).not.toHaveBeenCalled();
    answer([]);
    await settle();
    expect(store.take).toHaveBeenCalledOnce();
  });

  it('a registration withdrawn during the sweep takes nothing', async () => {
    let answer: (ids: string[]) => void = () => {};
    store.unclaimed = vi.fn(() => new Promise<string[]>((r) => (answer = r)));
    setNativeQuickReplySender(as(async () => 'sent'));
    setNativeQuickReplySender(null);
    answer([]);
    await settle();
    await drainNativeQuickReplies('event');
    expect(store.take).not.toHaveBeenCalled();
  });

  it('drains a put-back reply on the activity coming back to the front (canari:foreground)', async () => {
    const send = vi.fn(async () => 'sent' as const);
    setNativeQuickReplySender(as(send));
    await settle();
    const stop = listenForNativeQuickReplies();
    store.append(line('g4', 'later'));
    window.dispatchEvent(new CustomEvent('canari:foreground', { detail: { foreground: false } }));
    await settle();
    expect(send).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent('canari:foreground', { detail: { foreground: true } }));
    await settle();
    stop();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('a reply whose acknowledgement was lost is settled from what the page holds (review of #3927)', () => {
  let store: ReturnType<typeof fakeStore>;
  beforeEach(() => {
    store = fakeStore();
    resetQuickReplyDrainForTest(store);
  });

  it('shows a loss itself when the native side answers it was NOT told', async () => {
    // The Android record was never written (its hand-over could not record it): nobody else says it.
    vi.mocked(store.acknowledge).mockResolvedValueOnce(false);
    const session = as(async () => 'gone');
    setNativeQuickReplySender(session);
    await settle();
    store.append(line('g1', 'x'));
    await drainNativeQuickReplies('event');
    expect(store.acks).toEqual([]);
    expect(session.told).toEqual([['lost', 'r-g1']]);
  });

  it('settles each unclaimed reply from the store: sent, failed or pending when held, lost only when not', async () => {
    store.unclaimed = vi.fn(async () => ['was-sent', 'parked', 'queued', 'gone']);
    const held: Record<string, 'sent' | 'failed' | 'pending' | null> = {
      'was-sent': 'sent',
      parked: 'failed',
      queued: 'pending',
      gone: null,
    };
    const session = as(
      async () => 'sent',
      async (id) => held[id]
    );
    setNativeQuickReplySender(session);
    await settle();
    // A reply SENT whose acknowledgement never landed is answered sent - never "retype it", which
    // would have the member send it twice.
    expect(store.acks).toEqual([
      ['was-sent', 'sent'],
      ['parked', 'failed'],
      ['queued', 'pending'],
      ['gone', 'lost'],
    ]);
    expect(session.told).toEqual([]);
  });

  it('settles nothing it cannot read - the record stays for the next ask', async () => {
    store.unclaimed = vi.fn(async () => ['unknown']);
    const session = as(
      async () => 'sent',
      async () => {
        throw new Error('store closed');
      }
    );
    setNativeQuickReplySender(session);
    await settle();
    expect(store.acks).toEqual([]);
    expect(session.told).toEqual([]);
    // The registration goes on: the sweep never blocks the session's own takes.
    expect(store.take).toHaveBeenCalledOnce();
  });

  it('never weighs a reply this page is still sending', async () => {
    let finish: (o: 'sent') => void = () => {};
    const session = as(
      () => new Promise<'sent'>((r) => (finish = r)),
      async () => null
    );
    setNativeQuickReplySender(session);
    await settle();
    store.append(line('g1', 'in flight'));
    const draining = drainNativeQuickReplies('event');
    await settle();
    // Claimed from the file, not written yet: the native record lists it as unclaimed.
    store.unclaimed = vi.fn(async () => ['r-g1']);
    await settleNativeQuickRepliesAtSignOut(ME, session.heldAs);
    expect(store.acks).toEqual([]);
    finish('sent');
    await draining;
    expect(store.acks).toEqual([['r-g1', 'sent']]);
  });

  it('a sign-out withdraws the sender and settles the account from the store it captured', async () => {
    const session = as(async () => 'sent');
    setNativeQuickReplySender(session);
    await settle();
    store.unclaimed = vi.fn(async () => ['taken-before']);
    const leavingStore = vi.fn(async () => 'pending' as const);
    await settleNativeQuickRepliesAtSignOut(ME, leavingStore);
    expect(leavingStore).toHaveBeenCalledWith('taken-before');
    expect(store.acks).toEqual([['taken-before', 'pending']]);
    store.append(line('g1', 'after'));
    await drainNativeQuickReplies('event');
    expect(store.file()).toHaveLength(1);
  });

  it('never toasts a sign-out loss to the session in front by then - the banner and the log say it', async () => {
    const session = as(async () => 'sent');
    setNativeQuickReplySender(session);
    await settle();
    store.unclaimed = vi.fn(async () => ['nothing-held']);
    vi.mocked(store.acknowledge).mockResolvedValueOnce(false);
    await settleNativeQuickRepliesAtSignOut(ME, async () => null);
    expect(store.acks).toEqual([]);
    expect(session.told).toEqual([]);
  });
});
