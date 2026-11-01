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
  type QuickReplyStore,
  type SendQuickReply,
} from './quickReplyDrain';

const ME = 'me@x.fr';

const line = (groupId: string, text: string, replyId = `r-${groupId}`) =>
  JSON.stringify({ replyId, accountId: ME, groupId, text, notifiedAt: 5, repliedAt: 9 });

/** A file the native side appends to, taken by a claim, appended back to, and acknowledged. */
function fakeStore(initial: string[] = []) {
  let file = [...initial];
  const acks: [string, boolean][] = [];
  const store: QuickReplyStore & {
    file: () => string[];
    append: (l: string) => void;
    acks: [string, boolean][];
  } = {
    take: vi.fn(async () => {
      const taken = file;
      file = [];
      return taken;
    }),
    putBack: vi.fn(async (lines: string[]) => {
      file = [...file, ...lines];
    }),
    acknowledge: vi.fn(async (replyId: string, queued: boolean) => {
      acks.push([replyId, queued]);
    }),
    file: () => file,
    append: (l) => file.push(l),
    acks,
  };
  return store;
}

const as = (send: SendQuickReply) => ({ accountId: ME, send });

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

  it('drops what names no conversation or no text', () => {
    expect(parseNativeQuickReply('nope')).toBeNull();
    expect(parseNativeQuickReply(line('', 'x'))).toBeNull();
    expect(parseNativeQuickReply(line('g', '   '))).toBeNull();
  });
});

describe('a quick reply handed to the page is never lost', () => {
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
    setNativeQuickReplySender(as(async () => true));
    await settle();
    expect(store.take).toHaveBeenCalledWith(ME);
  });

  it('sends what waited as soon as the session registers, and acknowledges it (A1)', async () => {
    store.append(line('g1', 'hi'));
    const sent: NativeQuickReply[] = [];
    setNativeQuickReplySender(
      as(async (r) => {
        sent.push(r);
        return true;
      })
    );
    await settle();
    expect(sent.map((r) => [r.groupId, r.text])).toEqual([['g1', 'hi']]);
    expect(store.file()).toEqual([]);
    expect(store.acks).toEqual([['r-g1', true]]);
  });

  it('puts back a reply the page could not queue, says so, and sends it on a later take', async () => {
    let conversationLoaded = false;
    const send = vi.fn(async () => conversationLoaded);
    setNativeQuickReplySender(as(send));
    await settle();

    store.append(line('g1', 'first'));
    await drainNativeQuickReplies('event');
    expect(store.putBack).toHaveBeenCalledOnce();
    expect(store.file()).toEqual([line('g1', 'first')]);
    expect(store.acks).toEqual([['r-g1', false]]);

    conversationLoaded = true;
    await drainNativeQuickReplies('conversations loaded');
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.file()).toEqual([]);
    expect(store.acks).toEqual([
      ['r-g1', false],
      ['r-g1', true],
    ]);
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
    expect(store.acks).toEqual([['r-g1', true]]);
  });

  it('drains when the native side says a reply waits', async () => {
    const send = vi.fn(async () => true);
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
});
