const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let tauri = true;
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => tauri }));

import { mlsStateSize, hasMlsState } from './hex';

/**
 * THE QUESTION "IS THERE A SAVED STATE" ANSWERED WITHOUT MOVING THE STATE.
 *
 * `mls.bin` is megabytes and crosses the Tauri bridge as a JSON array of per-byte numbers, so
 * every caller that only wanted a boolean was paying for the whole blob - 908 ms of main thread
 * warm, measured on a Pixel 6a with a 7,8 MB state. The assertions below pin the two things that
 * make the cheap answer usable: the command it calls, and the rule that ZERO IS ABSENT, which is
 * the same rule the bytes obey and the reason a truncated write cannot arm `noFreshStart`.
 */
describe('mlsStateSize', () => {
  beforeEach(() => {
    tauri = true;
    invoke.mockReset();
  });

  it('asks for the size, never for the bytes', async () => {
    invoke.mockResolvedValue(8_131_838);
    expect(await mlsStateSize()).toBe(8_131_838);
    expect(invoke).toHaveBeenCalledWith('mls_state_size');
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('load_mls_state');
  });

  it('is 0 off Tauri, where there is no native file to stat', async () => {
    tauri = false;
    expect(await mlsStateSize()).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('is 0 when the command fails, the same verdict as a first install', async () => {
    invoke.mockRejectedValue(new Error('no app data dir'));
    expect(await mlsStateSize()).toBe(0);
  });
});

describe('hasMlsState', () => {
  beforeEach(() => {
    tauri = true;
    invoke.mockReset();
  });

  it('is true for a state with bytes in it', async () => {
    invoke.mockResolvedValue(8_131_838);
    expect(await hasMlsState('user-1')).toBe(true);
  });

  it('is false for a zero-length file - damage, not history', async () => {
    invoke.mockResolvedValue(0);
    expect(await hasMlsState('user-1')).toBe(false);
  });

  it('never loads the blob to answer a boolean', async () => {
    invoke.mockResolvedValue(1);
    await hasMlsState('user-1');
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['mls_state_size']);
  });
});
