import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, forgetAndroidMailWatch } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => undefined),
  forgetAndroidMailWatch: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => true }));
vi.mock('$lib/mobile/androidMailWatch', () => ({ forgetAndroidMailWatch }));

import { eraseNativeMailPassword, forgetNativeMailWatch } from './mailWatchCursor';

/**
 * REVIEW B1 OF #4213: erasing the sealed copy must stop a native run that is going, whatever the
 * page believes - so every erase path sends the bridge's `forget` (erase AND stop, one native op)
 * unconditionally, beside the Rust erasure.
 */
describe('every native erase path tells the native watcher to forget', () => {
  beforeEach(() => {
    invoke.mockClear();
    forgetAndroidMailWatch.mockClear();
  });

  it('the password copy erased (a mail sign-out, unticked, refused, the Canari sign-out)', async () => {
    await eraseNativeMailPassword('u1');
    expect(forgetAndroidMailWatch).toHaveBeenCalledWith('u1');
    expect(invoke).toHaveBeenCalledWith('mail_watch_vault_erase', { userId: 'u1' });
  });

  it('the whole native state erased (D8, the switch off, the local wipe)', async () => {
    await forgetNativeMailWatch('u1');
    expect(forgetAndroidMailWatch).toHaveBeenCalledWith('u1');
    expect(invoke).toHaveBeenCalledWith('mail_watch_forget', { userId: 'u1' });
  });
});
