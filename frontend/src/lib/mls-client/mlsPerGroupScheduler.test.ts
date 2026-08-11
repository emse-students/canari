import { MlsPerGroupScheduler, type MlsQueuedMessage } from './mlsPerGroupScheduler';

function msg(
  groupId: string,
  label: string,
  overrides: Partial<MlsQueuedMessage> = {}
): MlsQueuedMessage {
  return {
    senderId: 'u1',
    ciphertext: new Uint8Array([label.charCodeAt(0)]),
    groupId,
    isWelcome: false,
    isCommit: false,
    ...overrides,
  };
}

describe('MlsPerGroupScheduler', () => {
  it('round-robins application messages across groups (web mode)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    scheduler.enqueue(msg('group-a', 'a1'));
    scheduler.enqueue(msg('group-b', 'b1'));
    scheduler.enqueue(msg('group-a', 'a2'));
    scheduler.enqueue(msg('group-b', 'b2'));

    const order: string[] = [];
    await scheduler.drain(async (m) => {
      order.push(String.fromCharCode(m.ciphertext[0]));
    });

    expect(order).toEqual(['a', 'b', 'a', 'b']);
  });

  it('drains Welcome without waiting on the held MLS lock (handler self-locks)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    // Simulate a catch-up decrypt session holding the lock.
    const release = await scheduler.acquireMlsLock();

    let welcomeProcessed = false;
    scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
    await scheduler.drain(async () => {
      welcomeProcessed = true;
    });

    expect(welcomeProcessed).toBe(true); // Welcome is not auto-locked, so it is not blocked.
    release();
  });

  it('blocks application messages while the MLS lock is held (auto-locked)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const release = await scheduler.acquireMlsLock();

    let processed = false;
    scheduler.enqueue(msg('group-a', 'a1')); // non-Welcome -> auto-locked by the drain
    const drainP = scheduler.drain(async () => {
      processed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(processed).toBe(false); // blocked behind the held lock

    release();
    await drainP;
    expect(processed).toBe(true);
  });

  it('processes group B while group A waits on Welcome (web mode)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
    scheduler.enqueue(msg('group-a', 'a1'));
    scheduler.enqueue(msg('group-b', 'b1'));

    const order: string[] = [];
    await scheduler.drain(async (m) => {
      order.push(m.groupId ?? '?');
      if (m.isWelcome && m.groupId) {
        scheduler.reinjectAfterWelcome(m.groupId);
      }
    });

    expect(order[0]).toBe('group-a');
    expect(order).toContain('group-b');
    expect(order.indexOf('group-b')).toBeLessThan(order.lastIndexOf('group-a'));
  });

  it('round-robins across groups at each priority tier (tauri mode)', async () => {
    const scheduler = new MlsPerGroupScheduler('tauri');
    scheduler.enqueue(msg('g1', 'c', { type: 'group_reset' }));
    scheduler.enqueue(msg('g2', 'c', { type: 'group_reset' }));
    scheduler.enqueue(msg('g1', 'w', { isWelcome: true }));
    scheduler.enqueue(msg('g2', 'm'));

    const order: string[] = [];
    await scheduler.drain(async (m) => {
      if (m.type === 'group_reset') order.push(`reset-${m.groupId}`);
      else if (m.isWelcome) order.push(`welcome-${m.groupId}`);
      else order.push(`msg-${m.groupId}`);
    });

    expect(order[0]).toMatch(/^reset-/);
    expect(order[1]).toMatch(/^reset-/);
    expect(order[0]).not.toBe(order[1]);
    expect(order.some((x) => x.startsWith('welcome-'))).toBe(true);
    expect(order.some((x) => x.startsWith('msg-'))).toBe(true);
  });

  it('serializes concurrent drain under MLS lock', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    let concurrent = 0;
    let maxConcurrent = 0;

    scheduler.enqueue(msg('g1', 'a'));
    scheduler.enqueue(msg('g2', 'b'));

    await scheduler.drain(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
    });

    expect(maxConcurrent).toBe(1);
  });

  it('waitUntilIdle resolves after drain completes', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    scheduler.enqueue(msg('g1', 'x'));

    const idle = scheduler.waitUntilIdle();
    await scheduler.drain(async () => {});
    await expect(idle).resolves.toBeUndefined();
    expect(scheduler.isIdle()).toBe(true);
  });

  it('serialises concurrent MLS lock acquires (no reentrant grant)', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const order: string[] = [];

    const releaseA = await scheduler.acquireMlsLock();
    order.push('A-acquired');

    // B must NOT be granted while A holds the lock (would be a concurrency bug).
    let bAcquired = false;
    const bPromise = scheduler.acquireMlsLock().then((releaseB) => {
      bAcquired = true;
      order.push('B-acquired');
      return releaseB;
    });

    // Let any microtasks settle: B must still be blocked.
    await Promise.resolve();
    await Promise.resolve();
    expect(bAcquired).toBe(false);

    releaseA();
    const releaseB = await bPromise;
    expect(bAcquired).toBe(true);
    expect(order).toEqual(['A-acquired', 'B-acquired']);
    releaseB();
  });

  it('release is idempotent', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const release = await scheduler.acquireMlsLock();
    release();
    release(); // second call is a no-op, must not throw or double-release

    // Lock is free again: next acquire resolves promptly.
    const next = await scheduler.acquireMlsLock();
    next();
  });

  /**
   * WP-DRAIN-2. `isDraining` is lowered only when the whole drain has returned, so any await
   * inside it can freeze every inbound message with nothing in the log. Two different awaits have
   * already done that on production; what is pinned here is that a third one cannot do it in
   * silence, whichever phase it is in.
   *
   * The freeze itself is NOT fixed - deliberately, see `guarded` - so these tests assert the
   * REPORT, and the negative control (a healthy drain saying nothing) is what makes the report
   * mean anything.
   */
  describe('a frozen drain reports itself', () => {
    const STUCK_MS = 60_000;
    let errors: string[];

    beforeEach(() => {
      vi.useFakeTimers();
      errors = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const stuck = () => errors.filter((e) => e.includes('[QUEUE] STUCK'));

    it('names the message and the group when the handler never settles', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'x', { queuedMessageId: 'q-42' }));

      // Never awaited: the whole point is that it never resolves.
      void scheduler.drain(() => new Promise<void>(() => {}));
      await vi.advanceTimersByTimeAsync(STUCK_MS + 1);

      expect(stuck()).toHaveLength(1);
      expect(stuck()[0]).toContain('processMessage');
      expect(stuck()[0]).toContain('group=group-a');
      expect(stuck()[0]).toContain('qId=q-42');
    });

    it('keeps reporting, because the elapsed time is the diagnosis', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'x'));

      void scheduler.drain(() => new Promise<void>(() => {}));
      await vi.advanceTimersByTimeAsync(STUCK_MS * 3 + 1);

      expect(stuck()).toHaveLength(3);
      expect(stuck()[2]).toContain('180s');
    });

    it('distinguishes waiting for the MLS lock from a hung handler', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      // Somebody outside the drain holds the mutex and never gives it back - WP-DRAIN-1's shape,
      // where a recovery awaited inside the callback re-entered the lock the drain already held.
      await scheduler.acquireMlsLock();
      scheduler.enqueue(msg('group-a', 'x'));

      let handlerRan = false;
      void scheduler.drain(async () => {
        handlerRan = true;
      });
      await vi.advanceTimersByTimeAsync(STUCK_MS + 1);

      expect(handlerRan).toBe(false);
      expect(stuck()).toHaveLength(1);
      expect(stuck()[0]).toContain('mlsLock');
      expect(stuck()[0]).not.toContain('processMessage');
    });

    it('reports the FLUSH, which is the one await that cannot be moved out of the window', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'x'));

      void scheduler.drain(async () => {}, { onDrainEnd: () => new Promise<void>(() => {}) });
      await vi.advanceTimersByTimeAsync(STUCK_MS + 1);

      expect(stuck()).toHaveLength(1);
      expect(stuck()[0]).toContain('onDrainEnd');
      // The exclusion is still held - that is the freeze this line is reporting, not a bug in it.
      expect(scheduler.draining).toBe(true);
    });

    it('says nothing about a drain that completes', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'x'));
      scheduler.enqueue(msg('group-b', 'y'));

      await scheduler.drain(async () => {}, { onDrainEnd: async () => {} });
      await vi.advanceTimersByTimeAsync(STUCK_MS * 2);

      expect(stuck()).toEqual([]);
      expect(scheduler.draining).toBe(false);
    });
  });
});
