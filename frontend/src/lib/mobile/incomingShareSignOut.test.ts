const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
let android = true;
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => android,
}));

import { eraseIncomingShare } from './incomingShareSignOut';
import { incomingShare } from '$lib/stores/incomingShare.svelte';

/**
 * A share into Canari must never land in the account signed in next (user, 2026-10-22). After a
 * sign-out NOTHING of it is left: not in the page, not as a manifest waiting on disk, not as a copy.
 */
const entry = (path: string) => ({ path, name: 'a.png', mime: 'image/png', size: 3 });

const discarded = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === 'discard_picked_file').map(([, a]) => a.path);

describe('eraseIncomingShare', () => {
  let waiting: string | null;

  beforeEach(() => {
    android = true;
    waiting = null;
    incomingShare.drop('test reset');
    invoke.mockReset();
    // The native manifest is taken exactly once, like the real claim.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== 'read_and_clear_pending_share') return undefined;
      const raw = waiting;
      waiting = null;
      return raw;
    });
  });

  it('leaves nothing: the held share, the undrained manifest and every copy are gone', async () => {
    incomingShare.offer({ text: 'held', files: [entry('/inbox/a/0_a.png')] });
    incomingShare.chooseTarget('group-1');
    waiting = JSON.stringify({ id: 'b', text: 'undrained', files: [entry('/inbox/b/0_b.png')] });

    await eraseIncomingShare('signed out');

    expect(incomingShare.pending).toBeNull();
    expect(incomingShare.target).toBeNull();
    expect(waiting).toBeNull();
    expect(discarded().sort()).toEqual(['/inbox/a/0_a.png', '/inbox/b/0_b.png']);
    // The next account is offered nothing: the native handoff is empty, the page holds nothing.
    expect(await invoke('read_and_clear_pending_share')).toBeNull();
    expect(incomingShare.takeFor('group-1')).toBeNull();
  });

  it('erases a held share with nothing waiting on disk', async () => {
    incomingShare.offer({ text: '', files: [entry('/inbox/a/0_a.png')] });
    await eraseIncomingShare('signed out');
    expect(incomingShare.pending).toBeNull();
    expect(discarded()).toEqual(['/inbox/a/0_a.png']);
  });

  it('claims no native manifest outside the Android app, which has none', async () => {
    android = false;
    incomingShare.offer({ text: 'held', files: [] });
    await eraseIncomingShare('signed out');
    expect(incomingShare.pending).toBeNull();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'read_and_clear_pending_share')).toEqual([]);
  });

  it('never throws when the claim fails', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_and_clear_pending_share') throw new Error('no app data dir');
      return undefined;
    });
    await expect(eraseIncomingShare('signed out')).resolves.toBeUndefined();
  });
});
