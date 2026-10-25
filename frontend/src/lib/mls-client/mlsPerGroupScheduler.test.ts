import {
  MLS_QUEUE_ORPHAN_KEY,
  MlsPerGroupScheduler,
  type MlsQueuedMessage,
} from './mlsPerGroupScheduler';
import { flushMacrotask } from '../../test/flush';

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
        scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome complete');
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
      await flushMacrotask();
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

  it('release is idempotent: a second call neither throws nor frees the next holder', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const releaseA = await scheduler.acquireMlsLock();
    let bAcquired = false;
    let cAcquired = false;
    const bPromise = scheduler.acquireMlsLock().then((r) => {
      bAcquired = true;
      return r;
    });
    const cPromise = scheduler.acquireMlsLock().then((r) => {
      cAcquired = true;
      return r;
    });

    releaseA();
    expect(() => releaseA()).not.toThrow(); // second call is a no-op
    const releaseB = await bPromise;
    await Promise.resolve();
    await Promise.resolve();

    // B holds the lock: A's stray second release must not have let C in beside it.
    expect(bAcquired).toBe(true);
    expect(cAcquired).toBe(false);

    releaseB();
    (await cPromise)();
    expect(cAcquired).toBe(true);
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

  /**
   * THE WELCOME BUFFER IS THE WORK THIS CLASS HOLDS OUTSIDE ITS QUEUES.
   *
   * A group's frames are parked while its Welcome is in flight so they are applied after the key
   * material that makes them readable. The window is opened by a Welcome and must be closed by that
   * same Welcome - RELEASING what it held, never discarding it. Two paths used to discard, both in
   * silence, and a live WebSocket frame need not carry the `queuedMessageId` a re-fetch would need
   * to bring it back.
   */
  describe('the Welcome buffering window', () => {
    /** Drains, releasing each group's buffer as its Welcome completes - the healthy shape. */
    const drainReleasing = (scheduler: MlsPerGroupScheduler, order: string[]) =>
      scheduler.drain(async (m) => {
        order.push(`${m.isWelcome ? 'welcome' : 'msg'}-${String.fromCharCode(m.ciphertext[0])}`);
        if (m.isWelcome && m.groupId) scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome complete');
      });

    it('parks a frame that arrives while its Welcome is in flight, and counts it as work', () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      // The frame is NOT in a queue - it is held - and both halves have to be true or the
      // assertions below could pass on a scheduler that simply queued it normally.
      expect(scheduler.getPendingCount()).toBe(1);
      expect(scheduler.getHeldCount()).toBe(1);
      expect(scheduler.isIdle()).toBe(false);
    });

    it('applies a parked frame after the Welcome, not before it', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      const order: string[] = [];
      await drainReleasing(scheduler, order);

      expect(order).toEqual(['welcome-w', 'msg-1']);
      expect(scheduler.isIdle()).toBe(true);
      expect(scheduler.getHeldCount()).toBe(0);
    });

    it('a second Welcome does not throw away what the first one was holding', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));
      // A re-add or a server re-delivery. This used to `set(groupId, [])` and drop frame 1.
      scheduler.enqueue(msg('group-a', 'W', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '2'));

      expect(scheduler.getHeldCount()).toBe(2);

      const order: string[] = [];
      await drainReleasing(scheduler, order);

      expect(order).toContain('msg-1');
      expect(order).toContain('msg-2');
      expect(scheduler.isIdle()).toBe(true);
    });

    it('says a window opened once, and the count once when it closes - never once per frame', async () => {
      // Pixel 6a, prod 1.2.7, 2026-10-14: 150 frames parked behind one redelivered Welcome printed
      // 150 identical "Buffering" lines, then the release line that already carried the count.
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      for (let i = 0; i < 150; i++) scheduler.enqueue(msg('group-a', String(i % 10)));

      await drainReleasing(scheduler, []);

      expect(lines.filter((l) => l.includes('Buffering'))).toHaveLength(1);
      expect(lines.filter((l) => l.includes('re-queued 150 buffered message(s)'))).toHaveLength(1);
      vi.restoreAllMocks();
    });

    it('opens a new window with its own line once the previous one has closed', async () => {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
      const scheduler = new MlsPerGroupScheduler('web');
      for (const round of ['w', 'W']) {
        scheduler.enqueue(msg('group-a', round, { isWelcome: true }));
        scheduler.enqueue(msg('group-a', '1'));
        scheduler.enqueue(msg('group-a', '2'));
        await drainReleasing(scheduler, []);
      }

      expect(lines.filter((l) => l.includes('Buffering'))).toHaveLength(2);
      vi.restoreAllMocks();
    });

    it('re-queues rather than drops when the window closes on a FAILED Welcome', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      const order: string[] = [];
      await scheduler.drain(async (m) => {
        order.push(String.fromCharCode(m.ciphertext[0]));
        // What `BaseMlsService` does when the Welcome handler throws: the window closes, and what
        // it held goes back in the queue for the unknown-group seam to record and re-fetch.
        if (m.isWelcome && m.groupId) scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome failed');
      });

      expect(order).toEqual(['w', '1']);
      expect(scheduler.isIdle()).toBe(true);
    });
  });

  /**
   * The closing invariant, and it is a PROOF rather than a deadline: at the end of a drain that
   * emptied every queue, a surviving Welcome window has nothing left anywhere to close it. Its
   * frames would never be applied, and every later frame for that group would be parked behind it
   * for the life of the tab - the freeze `guarded` cannot see, because nothing is awaiting.
   */
  describe('a Welcome window nothing can close', () => {
    let errors: string[];

    beforeEach(() => {
      errors = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const stranded = () => errors.filter((e) => e.includes('Welcome buffering window survived'));

    it('is reported and released, naming the group and the count', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      // A handler that consumes the Welcome and never closes the window it opened.
      await scheduler.drain(async () => {});

      expect(stranded()).toHaveLength(1);
      expect(stranded()[0]).toContain('group-a');
      expect(stranded()[0]).toContain('holding 1 message(s)');
      // Released, not dropped: it is back in the queue for the restart guard to pick up.
      expect(scheduler.getHeldCount()).toBe(0);
      expect(scheduler.getPendingCount()).toBe(1);
    });

    it('says nothing when the Welcome closes its own window', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-a', '1'));

      await scheduler.drain(async (m) => {
        if (m.isWelcome && m.groupId) scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome complete');
      });

      expect(stranded()).toEqual([]);
      expect(scheduler.isIdle()).toBe(true);
    });

    it('says nothing about a drain with no Welcome in it at all', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', '1'));
      scheduler.enqueue(msg('group-b', '2'));

      await scheduler.drain(async () => {});

      expect(stranded()).toEqual([]);
      expect(scheduler.isIdle()).toBe(true);
    });
  });
  describe('the group-scoped barrier', () => {
    /**
     * ONE GROUP'S WORK FINISHES LONG BEFORE THE ACCOUNT'S, and that difference was three minutes.
     *
     * A device rejoining twenty-nine conversations reached whole-mailbox idle 189 s after a peer
     * asked it to describe ONE of them, and answered that long after the question. Frames for the
     * other twenty-eight cannot change that group's manifest, so the leg that describes it waits for
     * its own group and nothing else.
     */
    it('resolves for a group whose frames are applied, while others are still queued', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'a1'));
      for (let i = 0; i < 20; i += 1) scheduler.enqueue(msg(`group-${i}`, 'x'));

      let aIdleAfter: number | null = null;
      let applied = 0;
      const waiting = scheduler.waitUntilGroupIdle('group-a').then(() => {
        aIdleAfter = applied;
      });

      await scheduler.drain(async () => {
        applied += 1;
      });
      await waiting;

      expect(aIdleAfter).not.toBeNull();
      // It woke inside the drain, not at the end of it: `group-a` holds one frame of twenty-one.
      expect(aIdleAfter as unknown as number).toBeLessThan(21);
    });

    it('does NOT resolve while the drain is applying a frame of that group', async () => {
      // Out of its bucket and not yet applied is the one window a bucket-only check would miss.
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'a1'));

      let resolved = false;
      let sawInsideApply: boolean | null = null;
      const waiting = scheduler.waitUntilGroupIdle('group-a').then(() => {
        resolved = true;
      });

      await scheduler.drain(async () => {
        sawInsideApply = resolved;
        expect(scheduler.isGroupIdle('group-a')).toBe(false);
      });
      await waiting;

      expect(sawInsideApply).toBe(false);
      expect(resolved).toBe(true);
    });

    it('waits for the UNTAGGED bucket too, because nothing here can say whose it is', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue({ ...msg('group-a', 'o'), groupId: undefined });

      expect(scheduler.isGroupIdle('group-a')).toBe(false);

      await scheduler.drain(async () => {});

      expect(scheduler.isGroupIdle('group-a')).toBe(true);
    });

    it('resolves immediately for a group with nothing queued', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-b', 'b1'));

      expect(scheduler.isGroupIdle('group-a')).toBe(true);
      await expect(scheduler.waitUntilGroupIdle('group-a')).resolves.toBeUndefined();
    });

    it('does not strand a group whose frame THREW - the key is cleared either way', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      scheduler.enqueue(msg('group-a', 'a1'));

      // The drain propagates it, which is the point: the `finally` still has to run.
      await expect(
        scheduler.drain(async () => {
          throw new Error('handler exploded');
        })
      ).rejects.toThrow('handler exploded');

      expect(scheduler.isGroupIdle('group-a')).toBe(true);
    });
  });

  /**
   * DUP-6 (2026-10-25): A COMMIT WAITING ON THE NETWORK HELD EVERY OTHER CONVERSATION'S FRAMES.
   *
   * The commit holds the mutex from stage to merge and its request may wait two write deadlines. It
   * now LENDS the mutex while the request is pending, to the drain only, one frame at a time, for any
   * group but its own - and takes it back before it merges. Every assertion is an ORDER: the network
   * answer is a promise the test opens by hand.
   */
  describe('a commit lending the mutex across its network round trip', () => {
    /** A promise the test opens by hand. */
    const gate = (): { promise: Promise<void>; open: () => void } => {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    };

    let log: ReturnType<typeof vi.spyOn>;
    let complaint: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      complaint = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      log.mockRestore();
      complaint.mockRestore();
    });

    /** A commit of `groupId` that stages, sends a request answered by `answer`, then merges. */
    const commitOf = (
      scheduler: MlsPerGroupScheduler,
      groupId: string,
      order: string[],
      answer: Promise<void>,
      staged: Promise<void> = Promise.resolve()
    ) => {
      const lent = gate();
      const done = scheduler.runCommitUnderMlsLock(groupId, async () => {
        await staged;
        order.push(`stage ${groupId}`);
        await scheduler.lendMlsLockWhile(groupId, async () => {
          lent.open();
          await answer;
        });
        order.push(`merge ${groupId}`);
      });
      return { done, lent: lent.promise };
    };

    it("applies another group's frame while the request is pending, and its own group's after the merge", async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise);
      await commit.lent;

      scheduler.enqueue(msg('group-b', 'b'));
      scheduler.enqueue(msg('group-a', 'a'));
      // RETURNS while the answer is still held: B was applied, A's frame waits for its commit.
      await scheduler.drain(async (m) => {
        order.push(`frame ${m.groupId}`);
      });
      expect(order).toEqual(['stage group-a', 'frame group-b']);
      expect(scheduler.getPendingCount()).toBe(1);
      expect(scheduler.hasRunnableWork()).toBe(false);

      answer.open();
      await commit.done;
      expect(scheduler.hasRunnableWork()).toBe(true);
      await scheduler.drain(async (m) => {
        order.push(`frame ${m.groupId}`);
      });
      expect(order).toEqual(['stage group-a', 'frame group-b', 'merge group-a', 'frame group-a']);
    });

    it('hands the loan to a frame that was already waiting on the commit when the request left', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const staged = gate();
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise, staged.promise);

      scheduler.enqueue(msg('group-b', 'b'));
      const drained = scheduler.drain(async (m) => {
        order.push(`frame ${m.groupId}`);
      });
      await flushMacrotask();
      // The stage is exclusive: nothing is lent before the request leaves.
      expect(order).toEqual([]);

      staged.open();
      await drained;
      expect(order).toEqual(['stage group-a', 'frame group-b']);
      answer.open();
      await commit.done;
      expect(order).toEqual(['stage group-a', 'frame group-b', 'merge group-a']);
    });

    it('takes the mutex back only once the frame being applied under the loan has finished', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise);
      await commit.lent;

      const inFrame = gate();
      const frameMayEnd = gate();
      scheduler.enqueue(msg('group-b', 'b'));
      const drained = scheduler.drain(async () => {
        order.push('frame start');
        inFrame.open();
        await frameMayEnd.promise;
        order.push('frame end');
      });
      await inFrame.promise;
      answer.open();
      await flushMacrotask();
      // The answer is in, the merge is not: the borrower still holds the client.
      expect(order).toEqual(['stage group-a', 'frame start']);

      frameMayEnd.open();
      await Promise.all([drained, commit.done]);
      expect(order).toEqual(['stage group-a', 'frame start', 'frame end', 'merge group-a']);
    });

    it('never lends to an exclusive acquirer: a catch-up, a Welcome or a settlement waits for the whole commit', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise);
      await commit.lent;

      const exclusive = scheduler.runUnderMlsLock(async () => {
        order.push('exclusive');
      });
      await flushMacrotask();
      expect(order).toEqual(['stage group-a']);

      answer.open();
      await Promise.all([commit.done, exclusive]);
      expect(order).toEqual(['stage group-a', 'merge group-a', 'exclusive']);
    });

    it('holds back unaddressed frames and Welcomes, and still applies the rest', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise);
      await commit.lent;

      scheduler.enqueue(msg('group-c', 'w', { isWelcome: true }));
      scheduler.enqueue({ ...msg('group-x', 'o'), groupId: undefined });
      scheduler.enqueue(msg('group-b', 'b'));
      await scheduler.drain(async (m) => {
        order.push(`${m.isWelcome ? 'welcome' : 'frame'} ${m.groupId ?? 'unaddressed'}`);
      });
      expect(order).toEqual(['stage group-a', 'frame group-b']);
      expect(scheduler.getPendingCount()).toBe(2);

      answer.open();
      await commit.done;
      await scheduler.drain(async (m) => {
        order.push(`${m.isWelcome ? 'welcome' : 'frame'} ${m.groupId ?? 'unaddressed'}`);
        if (m.isWelcome && m.groupId) scheduler.releaseWelcomeBuffer(m.groupId, 'Welcome complete');
      });
      expect(order.slice(3).sort()).toEqual(['frame unaddressed', 'welcome group-c']);
    });

    it('refuses a loan asked by anyone but the commit holding the mutex for that group, before the work starts', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const work = vi.fn(async () => undefined);

      await expect(scheduler.lendMlsLockWhile('group-a', work)).rejects.toThrow(/loan refused/);
      await scheduler.runCommitUnderMlsLock('group-b', async () => {
        await expect(scheduler.lendMlsLockWhile('group-a', work)).rejects.toThrow(/loan refused/);
      });
      await scheduler.runUnderMlsLock(async () => {
        await expect(scheduler.lendMlsLockWhile('group-a', work)).rejects.toThrow(/loan refused/);
      });
      expect(work).not.toHaveBeenCalled();
      expect(scheduler.committingGroupId).toBeNull();
    });

    /**
     * THE RACE THE PICK CANNOT SEE: an exclusive holder X has the mutex and commit A is queued
     * behind it, so `committingGroup` is still null when the drain picks A's frame (or an unaddressed
     * one) and queues it for the mutex. When X releases and A is granted, that frame must neither
     * borrow A's loan (it would apply another member's commit in A with A's stage in flight) nor
     * hold the drain - and B's frame behind it - for the whole commit.
     */
    it.each([
      ['its own group', 'group-a'],
      ['no group', undefined],
    ])(
      'puts back a frame of %s picked before the commit was granted, and applies the rest under the loan',
      async (_what, groupId) => {
        const scheduler = new MlsPerGroupScheduler('web');
        const order: string[] = [];
        const releaseX = await scheduler.acquireMlsLock();
        const answer = gate();
        const commit = commitOf(scheduler, 'group-a', order, answer.promise);

        scheduler.enqueue({ ...msg('group-a', 'h'), groupId });
        const process = async (m: MlsQueuedMessage) => {
          order.push(`frame ${m.groupId ?? 'unaddressed'}`);
        };
        const drained = scheduler.drain(process);
        await flushMacrotask();
        // Picked, and waiting for the mutex behind commit A.
        expect(scheduler.getPendingCount()).toBe(0);
        scheduler.enqueue(msg('group-b', 'b'));

        releaseX();
        await commit.lent;
        await drained;
        // B was applied under the loan; the held-back frame is back in its bucket, not applied.
        expect(order).toEqual(['stage group-a', 'frame group-b']);
        expect(scheduler.getPendingCount()).toBe(1);

        answer.open();
        await commit.done;
        await scheduler.drain(process);
        expect(order).toEqual([
          'stage group-a',
          'frame group-b',
          'merge group-a',
          `frame ${groupId ?? 'unaddressed'}`,
        ]);
      }
    );

    it('admits no borrower between the reclaim and the merge, while the loan is closing', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise);
      await commit.lent;

      const releaseB = await scheduler.acquireMlsLockForFrame('group-b');
      expect(releaseB).not.toBeNull();
      answer.open();
      await flushMacrotask();
      // The answer is in; the commit waits in the reclaim for B.
      expect(order).toEqual(['stage group-a']);

      // B's release wakes the reclaim; C asks in the same synchronous step, before the commit has
      // resumed to drop the loan - `borrowed` is false here, only `closing` refuses it.
      releaseB!();
      const c = scheduler.acquireMlsLockForFrame('group-c').then((release) => {
        order.push('frame group-c');
        release?.();
      });
      await Promise.all([commit.done, c]);
      expect(order).toEqual(['stage group-a', 'merge group-a', 'frame group-c']);
    });

    it('answers an acquisition for the committing group or no group at once, without the mutex', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise);
      await commit.lent;

      await expect(scheduler.acquireMlsLockForFrame('group-a')).resolves.toBeNull();
      await expect(scheduler.acquireMlsLockForFrame(MLS_QUEUE_ORPHAN_KEY)).resolves.toBeNull();
      // The loan is still free for a frame of another group.
      const releaseB = await scheduler.acquireMlsLockForFrame('group-b');
      expect(releaseB).not.toBeNull();
      releaseB!();
      answer.open();
      await commit.done;
      expect(order).toEqual(['stage group-a', 'merge group-a']);
    });

    it('lends to one borrower at a time', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise);
      await commit.lent;

      const releaseB = await scheduler.acquireMlsLockForFrame('group-b');
      const c = scheduler.acquireMlsLockForFrame('group-c').then((release) => {
        order.push('frame group-c');
        return release;
      });
      await flushMacrotask();
      expect(order).toEqual(['stage group-a']);

      releaseB!();
      const releaseC = await c;
      expect(order).toEqual(['stage group-a', 'frame group-c']);
      releaseC!();
      answer.open();
      await commit.done;
    });

    it('reports a reclaim that does not return, and does not cut it', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const scheduler = new MlsPerGroupScheduler('web');
        const order: string[] = [];
        const answer = gate();
        const commit = commitOf(scheduler, 'group-a', order, answer.promise);
        await commit.lent;

        const releaseB = await scheduler.acquireMlsLockForFrame('group-b');
        answer.open();
        await flushMacrotask();
        vi.advanceTimersByTime(60_000);
        expect(complaint).toHaveBeenCalledWith(
          expect.stringMatching(
            /STUCK in the reclaim of the MLS mutex lent by the commit of group-a/
          )
        );
        expect(order).toEqual(['stage group-a']);

        releaseB!();
        await commit.done;
        expect(order).toEqual(['stage group-a', 'merge group-a']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts for the drain overlay only the frames the drain can apply', async () => {
      const scheduler = new MlsPerGroupScheduler('web');
      const order: string[] = [];
      const answer = gate();
      const commit = commitOf(scheduler, 'group-a', order, answer.promise);
      await commit.lent;

      scheduler.enqueue(msg('group-a', 'a'));
      scheduler.enqueue({ ...msg('group-x', 'o'), groupId: undefined });
      scheduler.enqueue(msg('group-c', 'w', { isWelcome: true }));
      scheduler.enqueue(msg('group-b', 'b'));
      const onDrainStart = vi.fn();
      await scheduler.drain(async () => undefined, { onDrainStart });
      expect(onDrainStart).toHaveBeenCalledWith(1);

      answer.open();
      await commit.done;
    });
  });
});
