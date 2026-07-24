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
});
