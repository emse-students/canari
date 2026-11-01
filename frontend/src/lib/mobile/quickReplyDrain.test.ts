// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

import {
  NATIVE_QUICK_REPLY_EVENT,
  drainNativeQuickReplies,
  listenForNativeQuickReplies,
  parseNativeQuickReply,
  resetQuickReplyDrainForTest,
  setNativeQuickReplySender,
  type NativeQuickReply,
  type QuickReplyStore,
} from './quickReplyDrain';

const line = (groupId: string, text: string) =>
  JSON.stringify({ groupId, text, notifiedAt: 5, repliedAt: 9 });

/** A file the native side appends to, taken by a claim, and appended back to. */
function fakeStore(initial: string[] = []) {
  let file = [...initial];
  const store: QuickReplyStore & { file: () => string[]; append: (l: string) => void } = {
    take: vi.fn(async () => {
      const taken = file;
      file = [];
      return taken;
    }),
    putBack: vi.fn(async (lines: string[]) => {
      file = [...file, ...lines];
    }),
    file: () => file,
    append: (l) => file.push(l),
  };
  return store;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('parseNativeQuickReply', () => {
  it('reads the line the native side writes', () => {
    expect(parseNativeQuickReply(line('g1', '  hello '))).toEqual({
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

  it('sends what waited as soon as the session registers', async () => {
    store.append(line('g1', 'hi'));
    const sent: NativeQuickReply[] = [];
    setNativeQuickReplySender(async (r) => {
      sent.push(r);
      return true;
    });
    await settle();
    expect(sent.map((r) => [r.groupId, r.text])).toEqual([['g1', 'hi']]);
    expect(store.file()).toEqual([]);
  });

  it('puts back a reply the page could not queue, and sends it on a later take', async () => {
    let conversationLoaded = false;
    const send = vi.fn(async () => conversationLoaded);
    setNativeQuickReplySender(send);
    await settle();

    store.append(line('g1', 'first'));
    await drainNativeQuickReplies('event');
    expect(store.putBack).toHaveBeenCalledOnce();
    expect(store.file()).toEqual([line('g1', 'first')]);

    conversationLoaded = true;
    await drainNativeQuickReplies('conversations loaded');
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.file()).toEqual([]);
  });

  it('puts back a reply whose send threw', async () => {
    setNativeQuickReplySender(async () => {
      throw new Error('outbox gone');
    });
    await settle();
    store.append(line('g1', 'x'));
    await drainNativeQuickReplies('event');
    expect(store.file()).toEqual([line('g1', 'x')]);
  });

  it('drains when the native side says a reply waits', async () => {
    const send = vi.fn(async () => true);
    setNativeQuickReplySender(send);
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
