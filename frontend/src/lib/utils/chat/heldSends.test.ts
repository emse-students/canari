/**
 * F1 - A SEND HELD DURING A LOCAL PREVIEW GOES TO THE CONVERSATION IT WAS WRITTEN IN, OR NOWHERE.
 *
 * The ordinary send path sends to whatever is selected when it runs, so a held send replayed after
 * the selection moved would land in the wrong conversation. These pin the queue's two rules:
 * release runs only what still matches the selection, in order, and hands the rest back unsent;
 * drop runs nothing and returns everything, so the caller can say what was lost.
 */
import { createHeldSendQueue } from './heldSends';

describe('the held-send queue', () => {
  it('sends, in order, only what was written in the conversation still selected', () => {
    const q = createHeldSendQueue();
    const ran: string[] = [];
    q.hold({ what: 'a', target: 'g1', run: () => ran.push('a') });
    q.hold({ what: 'b', target: 'g2', run: () => ran.push('b') });
    q.hold({ what: 'c', target: 'g1', run: () => ran.push('c') });
    const { sent, misdirected } = q.release('g1');
    expect(ran).toEqual(['a', 'c']);
    expect(sent.map((h) => h.what)).toEqual(['a', 'c']);
    expect(misdirected.map((h) => h.what)).toEqual(['b']);
    expect(q.size).toBe(0);
  });

  it('sends nothing when the selection is gone', () => {
    const q = createHeldSendQueue();
    const run = vi.fn();
    q.hold({ what: 'a', target: 'g1', run });
    expect(q.release(null).misdirected).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('drops without sending and returns what it held', () => {
    const q = createHeldSendQueue();
    const run = vi.fn();
    q.hold({ what: 'a', target: 'g1', run });
    expect(q.drop().map((h) => h.what)).toEqual(['a']);
    expect(run).not.toHaveBeenCalled();
    expect(q.size).toBe(0);
  });

  it('releases what a send owns when it is NOT run - dropped or misdirected - and only then', () => {
    const q = createHeldSendQueue();
    const discarded: string[] = [];
    const held = (what: string, target: string) => ({
      what,
      target,
      run: () => {},
      discard: () => discarded.push(what),
    });
    q.hold(held('sent', 'g1'));
    q.hold(held('elsewhere', 'g2'));
    q.release('g1');
    expect(discarded).toEqual(['elsewhere']);
    q.hold(held('dropped', 'g1'));
    q.drop();
    expect(discarded).toEqual(['elsewhere', 'dropped']);
  });
});
