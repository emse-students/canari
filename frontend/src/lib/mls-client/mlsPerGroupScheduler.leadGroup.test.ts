import { MlsPerGroupScheduler, type MlsQueuedMessage } from './mlsPerGroupScheduler';

/**
 * A LEADING GROUP IS SERVED FIRST, IN ITS OWN ORDER (calls.md, "The answer joins on its own group"):
 * a call answered on the ring needs one group current while a resume's catch-up applies every other
 * conversation's frames, and the round-robin served it one turn in N.
 */

function msg(groupId: string, label: string): MlsQueuedMessage {
  return {
    senderId: 'u1',
    ciphertext: new TextEncoder().encode(label),
    groupId,
    isWelcome: false,
    isCommit: false,
  };
}

const labelOf = (m: MlsQueuedMessage) => new TextDecoder().decode(m.ciphertext);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(['web', 'tauri'] as const)('leadGroup (%s)', (mode) => {
  it('applies the leading group first, in its own order, then resumes the round-robin', async () => {
    const scheduler = new MlsPerGroupScheduler(mode);
    for (const m of [msg('a', 'a1'), msg('b', 'b1'), msg('call', 'c1'), msg('a', 'a2')]) {
      scheduler.enqueue(m);
    }
    scheduler.enqueue(msg('call', 'c2'));
    const release = scheduler.leadGroup('call');

    const applied: string[] = [];
    await scheduler.drain(async (m) => {
      applied.push(labelOf(m));
    });

    expect(applied.slice(0, 2)).toEqual(['c1', 'c2']);
    expect(applied.slice(2).sort()).toEqual(['a1', 'a2', 'b1']);
    expect(applied.indexOf('a1')).toBeLessThan(applied.indexOf('a2'));
    release();
  });

  it('a released lead is the round-robin again, and a second release changes nothing', async () => {
    const scheduler = new MlsPerGroupScheduler(mode);
    const release = scheduler.leadGroup('call');
    release();
    release();
    for (const m of [msg('a', 'a1'), msg('call', 'c1'), msg('a', 'a2'), msg('call', 'c2')]) {
      scheduler.enqueue(m);
    }

    const applied: string[] = [];
    await scheduler.drain(async (m) => {
      applied.push(labelOf(m));
    });

    expect(applied).toEqual(['a1', 'c1', 'a2', 'c2']);
  });

  it('two holders of the same lead: it ends only when both released', async () => {
    const scheduler = new MlsPerGroupScheduler(mode);
    const first = scheduler.leadGroup('call');
    scheduler.leadGroup('call');
    first();
    for (const m of [msg('a', 'a1'), msg('a', 'a2'), msg('call', 'c1')]) scheduler.enqueue(m);

    const applied: string[] = [];
    await scheduler.drain(async (m) => {
      applied.push(labelOf(m));
    });

    expect(applied[0]).toBe('c1');
  });
});

describe('whenGroupFrameApplied', () => {
  it("resolves after the group's next frame is applied, not before, and not on another group's", async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    scheduler.enqueue(msg('other', 'o1'));
    scheduler.enqueue(msg('call', 'c1'));
    const seen: string[] = [];
    void scheduler.whenGroupFrameApplied('call').then(() => seen.push('call frame applied'));

    await scheduler.drain(async (m) => {
      seen.push(labelOf(m));
      await Promise.resolve();
    });

    expect(seen).toEqual(['o1', 'c1', 'call frame applied']);
  });

  it('is rejected when the client ends, pending or asked after', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const pending = scheduler.whenGroupFrameApplied('call');

    scheduler.abandonGroupIdleWaiters((groupId) => new Error(`ended before ${groupId}`));

    await expect(pending).rejects.toThrow('ended before call');
    await expect(scheduler.whenGroupFrameApplied('call')).rejects.toThrow('ended before call');
  });
});

describe('a removable frame waiter', () => {
  it('an aborted waiter is removed at once and rejected with the reason', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const stop = new AbortController();
    const pending = scheduler.whenGroupFrameApplied('call', stop.signal);
    expect(scheduler.groupFrameWaiterCount).toBe(1);

    stop.abort(new Error('the call ended'));

    await expect(pending).rejects.toThrow('the call ended');
    expect(scheduler.groupFrameWaiterCount).toBe(0);
  });

  it('an already aborted signal registers nothing', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const stop = new AbortController();
    stop.abort(new Error('gone'));
    await expect(scheduler.whenGroupFrameApplied('call', stop.signal)).rejects.toThrow('gone');
    expect(scheduler.groupFrameWaiterCount).toBe(0);
  });
});

describe.each(['web', 'tauri'] as const)(
  'the round-robin index follows its bucket (%s)',
  (mode) => {
    it('a bucket emptied ahead of the index does not cost the next group its turn', async () => {
      const scheduler = new MlsPerGroupScheduler(mode);
      for (const m of [msg('a', 'a1'), msg('b', 'b1'), msg('b', 'b2'), msg('c', 'c1')]) {
        scheduler.enqueue(m);
      }
      scheduler.enqueue(msg('c', 'c2'));

      const applied: string[] = [];
      await scheduler.drain(async (m) => {
        applied.push(labelOf(m));
      });

      // `a` empties at its first turn: `b` is next, never skipped for `c`.
      expect(applied).toEqual(['a1', 'b1', 'c1', 'b2', 'c2']);
    });
  }
);
