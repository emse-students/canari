const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
let runtime: 'android' | 'ios' | 'web' = 'android';
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => runtime === 'android',
  isIosTauriRuntime: () => runtime === 'ios',
  isMobileTauriRuntime: () => runtime !== 'web',
}));

import { eraseIncomingShare } from './incomingShareSignOut';
import { drainNativeShare } from './incomingShareDrain';
import { incomingShare } from '$lib/stores/incomingShare.svelte';

/**
 * A share into Canari must never land in the account signed in next (user, 2026-10-22). After a
 * sign-out NOTHING of it is left: not in the page, not as a manifest waiting on disk, not as a copy -
 * and nothing captured or drained around the sign-out is offered afterwards (the share EPOCH).
 */
const entry = (path: string) => ({ path, name: 'a.png', mime: 'image/png', size: 3 });

const discarded = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === 'discard_picked_file').map(([, a]) => a.path);

describe('eraseIncomingShare', () => {
  /** The native side, modelled: one manifest slot claimed exactly once, and the epoch file. */
  let waiting: string | null;
  // Never reset: the store's floor is module state that only rises, like the page's.
  let epoch = 0;

  beforeEach(() => {
    runtime = 'android';
    waiting = null;
    incomingShare.drop('test reset');
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'advance_share_epoch') return ++epoch;
      if (cmd !== 'read_and_clear_pending_share') return undefined;
      const manifest = waiting;
      waiting = null;
      return manifest === null ? null : { manifest, epoch };
    });
  });

  it('leaves nothing: the held share, the undrained manifest and every copy are gone', async () => {
    incomingShare.offer({ text: 'held', files: [entry('/inbox/a/0_a.png')] }, epoch);
    incomingShare.chooseTarget('group-1');
    waiting = JSON.stringify({
      text: 'undrained',
      files: [entry('/inbox/b/0_b.png')],
      epoch,
    });

    await eraseIncomingShare('signed out');

    expect(incomingShare.pending).toBeNull();
    expect(incomingShare.target).toBeNull();
    expect(waiting).toBeNull();
    expect(discarded().sort()).toEqual(['/inbox/a/0_a.png', '/inbox/b/0_b.png']);
    expect(incomingShare.takeFor('group-1')).toBeNull();
  });

  it('erases a held share with nothing waiting on disk', async () => {
    incomingShare.offer({ text: '', files: [entry('/inbox/a/0_a.png')] }, epoch);
    await eraseIncomingShare('signed out');
    expect(incomingShare.pending).toBeNull();
    expect(discarded()).toEqual(['/inbox/a/0_a.png']);
  });

  it('a capture still running at sign-out lands STALE: the next drain deletes it, offers nothing', async () => {
    const capturedAt = epoch; // the native copy started before the sign-out
    await eraseIncomingShare('signed out');
    // ...and writes its manifest afterwards, stamped with the epoch it started in.
    waiting = JSON.stringify({
      text: 'late',
      files: [entry('/inbox/c/0_c.png')],
      epoch: capturedAt,
    });

    expect(await drainNativeShare()).toBeNull();
    expect(incomingShare.pending).toBeNull();
    expect(discarded()).toEqual(['/inbox/c/0_c.png']);
  });

  /** The real drain, held inside its native claim until `release` - the ordering under review. */
  function drainHeldInItsClaim() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const before = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== 'read_and_clear_pending_share') return before(cmd, args);
      const claimed = await before(cmd, args); // claimed, with the epoch current at the claim...
      invoke.mockImplementation(before);
      await gate; // ...and answered only after the sign-out ran
      return claimed;
    });
    return { drained: drainNativeShare(), release };
  }

  it('a drain claimed BEFORE the sign-out and answered after it offers nothing', async () => {
    waiting = JSON.stringify({ text: 'racing', files: [entry('/inbox/d/0_d.png')], epoch });
    const { drained, release } = drainHeldInItsClaim();
    await eraseIncomingShare('signed out');
    release();

    expect(await drained).toEqual({ lost: 0 });
    expect(incomingShare.pending).toBeNull();
    expect(discarded()).toEqual(['/inbox/d/0_d.png']);
  });

  it('a drain that offered BEFORE the sign-out is dropped by it', async () => {
    waiting = JSON.stringify({ text: 'early', files: [entry('/inbox/f/0_f.png')], epoch });
    await drainNativeShare();
    expect(incomingShare.pending?.text).toBe('early');
    await eraseIncomingShare('signed out');
    expect(incomingShare.pending).toBeNull();
    expect(discarded()).toEqual(['/inbox/f/0_f.png']);
  });

  it('keeps a share captured in the instant after the advance, before the erase claims it', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'advance_share_epoch') {
        ++epoch;
        // A capture starts right after the advance and lands before the claim: it carries the new epoch.
        waiting = JSON.stringify({ text: 'next', files: [entry('/inbox/g/0_g.png')], epoch });
        return epoch;
      }
      if (cmd !== 'read_and_clear_pending_share') return undefined;
      const manifest = waiting;
      waiting = null;
      return manifest === null ? null : { manifest, epoch };
    });
    await eraseIncomingShare('signed out');
    expect(incomingShare.pending?.text).toBe('next');
    expect(discarded()).toEqual([]);
    incomingShare.drop('test reset');
  });

  it('offers nothing when the drain cannot read the epoch', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'read_and_clear_pending_share'
        ? {
            manifest: JSON.stringify({ text: 'x', files: [entry('/inbox/h/0_h.png')], epoch }),
            epoch: null,
          }
        : undefined
    );
    expect(await drainNativeShare()).toBeNull();
    expect(incomingShare.pending).toBeNull();
    expect(discarded()).toEqual(['/inbox/h/0_h.png']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('share epoch is unreadable'));
    error.mockRestore();
  });

  it('offers a share captured after the sign-out to the account signed in next', async () => {
    await eraseIncomingShare('signed out');
    waiting = JSON.stringify({ text: 'fresh', files: [], epoch });
    expect(await drainNativeShare()).toEqual({ lost: 0 });
    expect(incomingShare.pending?.text).toBe('fresh');
  });

  /**
   * iOS: the Share Extension's manifest waits in the App Group until `read_and_clear_pending_share`
   * carries it over BEFORE its claim (`commands/app_group_share.rs`), and `advance_share_epoch` also
   * writes the App Group's epoch - so the erase is the same two commands, and leaves nothing there.
   */
  it('erases on iOS through the same two commands, the App Group share included', async () => {
    runtime = 'ios';
    // A share the extension left in the App Group: the command's own import hands it over.
    waiting = JSON.stringify({ text: 'from photos', files: [entry('/caches/s/0_s.png')], epoch });

    await eraseIncomingShare('signed out');

    const commands = invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands.indexOf('advance_share_epoch')).toBeLessThan(
      commands.indexOf('read_and_clear_pending_share')
    );
    expect(waiting).toBeNull();
    expect(discarded()).toEqual(['/caches/s/0_s.png']);
    expect(incomingShare.pending).toBeNull();
  });

  it('claims no native manifest outside the mobile apps, which have none', async () => {
    runtime = 'web';
    incomingShare.offer({ text: 'held', files: [] }, epoch);
    await eraseIncomingShare('signed out');
    expect(incomingShare.pending).toBeNull();
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain('read_and_clear_pending_share');
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain('advance_share_epoch');
  });

  it('never throws when the native side fails, still claims the waiting manifest, and fails closed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    waiting = JSON.stringify({ text: 'x', files: [entry('/inbox/e/0_e.png')], epoch });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'advance_share_epoch') throw new Error('no app data dir');
      if (cmd !== 'read_and_clear_pending_share') return undefined;
      const manifest = waiting;
      waiting = null;
      return manifest === null ? null : { manifest, epoch };
    });
    await expect(eraseIncomingShare('signed out')).resolves.toBeUndefined();
    expect(discarded()).toEqual(['/inbox/e/0_e.png']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('share epoch was not advanced'));

    invoke.mockImplementation(async () => {
      throw new Error('no app data dir');
    });
    await expect(eraseIncomingShare('signed out')).resolves.toBeUndefined();
    error.mockRestore();

    // FAILED CLOSED: nothing is offered again in this process. (Last in the file for that reason.)
    expect(
      incomingShare.offer({ text: 'after', files: [entry('/inbox/i/0_i.png')] }, epoch + 9)
    ).toBe(false);
  });
});
