const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let tauri = true;
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => tauri }));

import { mlsStateSize, hasMlsState, removeMlsState } from './hex';
import {
  MlsSlotMoveUnfinishedError,
  MlsStateLoadUntypedError,
} from '$lib/mls-client/mlsStateLoadError';

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
    expect(await mlsStateSize('user-1')).toBe(8_131_838);
    expect(invoke).toHaveBeenCalledWith('mls_state_size', { userId: 'user-1' });
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('load_mls_state');
  });

  it('is 0 off Tauri, where there is no native file to stat', async () => {
    tauri = false;
    expect(await mlsStateSize('user-1')).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects when the command fails - an unknown size is never "no state"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValue({ code: null, message: 'stat mls.bin: permission denied' });
    await expect(mlsStateSize('user-1')).rejects.toBeInstanceOf(MlsStateLoadUntypedError);
    await expect(hasMlsState('user-1')).rejects.toBeInstanceOf(MlsStateLoadUntypedError);
    vi.restoreAllMocks();
  });

  it("types an unfinished move of the account's own state, which the gate answers", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockRejectedValue({ code: 'SLOT_MOVE_UNFINISHED', message: 'a cut park' });
    await expect(mlsStateSize('user-1')).rejects.toBeInstanceOf(MlsSlotMoveUnfinishedError);
    vi.restoreAllMocks();
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

  it("asks about the account it was given, never the install's last one", async () => {
    invoke.mockResolvedValue(0);
    expect(await hasMlsState('user-2')).toBe(false);
    expect(invoke).toHaveBeenCalledWith('mls_state_size', { userId: 'user-2' });
  });
});

/**
 * Round 5 of the review of #2919: the "forgot PIN" reset on a phone is THE ACCOUNT'S. It used to end
 * the native session WITH A SWEEP, which removes the slot whoever it belongs to - account B's reset
 * deleted account A's state.
 */
describe('removeMlsState on a phone', () => {
  beforeEach(() => {
    tauri = true;
    invoke.mockReset();
    invoke.mockResolvedValue(0);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('ends the native session without a sweep, then resets only the named account', async () => {
    await removeMlsState('user-b');
    const calls = invoke.mock.calls;
    expect(calls.map((c) => c[0])).toEqual(['terminer_session_mls', 'reset_user_mls_state']);
    expect(calls[0][1]).toMatchObject({ sweepState: false });
    expect(calls[1][1]).toEqual({ userId: 'user-b' });
    expect(calls.some((c) => (c[1] as { sweepState?: boolean })?.sweepState === true)).toBe(false);
  });

  it('propagates a refused reset - nothing removed is never reported as done', async () => {
    const refusal = 'the slot holds a state of unproven owner';
    invoke.mockImplementation((cmd: string) =>
      cmd === 'reset_user_mls_state' ? Promise.reject(refusal) : Promise.resolve(undefined)
    );
    await expect(removeMlsState('user-b')).rejects.toBe(refusal);
  });
});
