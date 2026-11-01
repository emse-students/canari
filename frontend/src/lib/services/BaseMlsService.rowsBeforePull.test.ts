/**
 * THE LOGIN'S FIRST PULL WAITS FOR THE CONVERSATION ROWS - AN ORDER, NOT A DELAY.
 *
 * Measured on an iPhone 12, `1.5.4-alpha.1`, 2026-11-01, a cold start from a notification tap: the
 * socket opened before the restore (deliberately - see `sessionAuth`), its post-connect catch-up
 * pulled the mailbox at once, and all three queued frames met an empty conversation map:
 * `Message for absent conversation ... - retry after restore`, `3 frame(s) left unacknowledged ...
 * absent-conversation: 3`, then a second pull once `[RESTORE] 8 conversation row(s) seeded`.
 *
 * The catch-up is now HELD by the service until the rows exist and run by the restore itself, so
 * the drain cannot meet an empty map. What is asserted: held before the rows, run by the first of
 * the two restore events, awaited by the one that returns it, and run immediately (not held) once
 * the rows exist - which is every reconnect.
 */
import { describe, it, expect, vi } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';

/** @see BaseMlsService.mailboxBarrier.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {
  protected override pausePlatformSocket(): void {}
}

const makeService = (): BaseMlsService => {
  const svc = new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');
  // Nothing was refused, so nothing is re-fetched: the restore events' other half is not under test.
  Object.assign(svc, { refetchFramesLeftBehind: vi.fn() });
  return svc;
};

describe('the catch-up a login owes is ordered after the conversation rows', () => {
  it('is held before the rows exist, and the seeded rows run it and return it to be awaited', async () => {
    const svc = makeService();
    const steps: string[] = [];
    let release!: () => void;
    const held = svc.deferUntilConversationRowsExist(async () => {
      steps.push('pull');
      await new Promise<void>((resolve) => (release = resolve));
      steps.push('drained');
    });
    expect(held).toBe(true);
    expect(steps).toEqual([]);

    const seeded = svc.notifyConversationRowsSeeded();
    let settled = false;
    void seeded.then(() => (settled = true));
    await Promise.resolve();
    expect(steps).toEqual(['pull']);
    // THE RESTORE'S HISTORY PHASE WAITS FOR THE DRAIN, so it does not pull from its own barrier first.
    expect(settled).toBe(false);
    release();
    await seeded;
    expect(steps).toEqual(['pull', 'drained']);
  });

  it('is not held once the rows exist - the caller runs it, as every reconnect does', async () => {
    const svc = makeService();
    await svc.notifyConversationRowsSeeded();
    const work = vi.fn(async () => {});
    expect(svc.deferUntilConversationRowsExist(work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  it('runs once even when both restore events come, and a restore that failed before its rows still runs it', async () => {
    const svc = makeService();
    const work = vi.fn(async () => {});
    svc.deferUntilConversationRowsExist(work);
    // A restore that threw before phase 1 reports only its end (`useConversations.restoreOnce`).
    svc.notifyConversationsRestored();
    await Promise.resolve();
    await svc.notifyConversationRowsSeeded();
    expect(work).toHaveBeenCalledOnce();
  });

  it('a held catch-up that throws costs only itself', async () => {
    const svc = makeService();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn(async () => {});
    svc.deferUntilConversationRowsExist(async () => {
      throw new Error('settle failed');
    });
    svc.deferUntilConversationRowsExist(second);
    await expect(svc.notifyConversationRowsSeeded()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
