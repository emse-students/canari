// @vitest-environment happy-dom
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let tauri = true;
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => tauri }));
// The document the reset steps name: a page's own generation (`page_ring_document`).
vi.mock('$lib/services/pageGatewaySocket', () => ({ thisDocumentGeneration: async () => 7 }));

import {
  mlsStateSize,
  adoptUnsettledMlsReset,
  hasMlsState,
  loadMlsState,
  MlsResetRefusedError,
  removeMlsState,
  rollbackMlsStateReset,
  stageMlsStateReset,
} from './hex';
import {
  MlsResetUnsettledError,
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

  // ROUND 8 OF THE REVIEW OF #2919 (M-1): whether a state of unproven owner counts is decided
  // natively, from a state that OPENED - never from the device id the PIN check writes first.
  it('hands no WebView fact about whether the account is known here', async () => {
    invoke.mockResolvedValue(0);
    localStorage.setItem('mls_device_id_user-2', 'device-2');
    try {
      await mlsStateSize('user-2');
    } finally {
      localStorage.removeItem('mls_device_id_user-2');
    }
    expect(invoke).toHaveBeenCalledWith('mls_state_size', { userId: 'user-2' });
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

  // Round 11 (N4): the bytes old-PIN recovery reads are refused as the same types - an unsettled
  // reset or an unfinished move is never read as "no local state to recover".
  it.each([
    ['RESET_UNSETTLED', MlsResetUnsettledError],
    ['SLOT_MOVE_UNFINISHED', MlsSlotMoveUnfinishedError],
  ])('loadMlsState types a %s refusal, never null', async (code, type) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValue({ code, message: 'refused' });
    await expect(loadMlsState('user-1')).rejects.toBeInstanceOf(type);
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
 * Rounds 5 and 6 of the review of #2919: the "forgot PIN" reset on a phone is THE ACCOUNT'S, and runs
 * in two steps around the server's reset. It used to end the native session WITH A SWEEP, which
 * removes the slot whoever it belongs to - account B's reset deleted account A's state.
 */
describe('the PIN reset of the local MLS state on a phone', () => {
  const BASIS = 'c'.repeat(64);
  beforeEach(() => {
    tauri = true;
    invoke.mockReset();
    invoke.mockResolvedValue(0);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const sweeps = () =>
    invoke.mock.calls.some((c) => (c[1] as { sweepState?: boolean })?.sweepState === true);

  it('stage: ends the native session without a sweep, then sets the named account apart', async () => {
    await stageMlsStateReset('user-b', BASIS);
    const calls = invoke.mock.calls;
    expect(calls.map((c) => c[0])).toEqual(['terminer_session_mls', 'stage_user_mls_reset']);
    expect(calls[0][1]).toMatchObject({ sweepState: false });
    expect(calls[1][1]).toEqual({ userId: 'user-b', serverBasis: BASIS, document: 7 });
    expect(sweeps()).toBe(false);
  });

  it('commit: removes what was set apart, and never sweeps', async () => {
    await removeMlsState('user-b');
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['commit_user_mls_reset']);
    expect(invoke.mock.calls[0][1]).toEqual({ userId: 'user-b', document: 7 });
    expect(sweeps()).toBe(false);
  });

  it('rollback: puts the named account back', async () => {
    await rollbackMlsStateReset('user-b');
    expect(invoke.mock.calls).toEqual([
      ['rollback_user_mls_reset', { userId: 'user-b', document: 7 }],
    ]);
  });

  // Round 9 of the review of #2919: a reset left unsettled by a page that is gone is adopted by this
  // one, which learns the server basis it was staged under.
  it('adopt: names this document and answers the basis, or null', async () => {
    invoke.mockResolvedValueOnce(BASIS).mockResolvedValueOnce(null);
    expect(await adoptUnsettledMlsReset('user-b')).toBe(BASIS);
    expect(await adoptUnsettledMlsReset('user-b', { handOver: true })).toBeNull();
    expect(invoke).toHaveBeenNthCalledWith(1, 'adopt_unsettled_user_mls_reset', {
      userId: 'user-b',
      handOver: false,
      document: 7,
    });
    // Round 10: this page's own steps hand their staged reset over when the server said nothing.
    expect(invoke).toHaveBeenNthCalledWith(2, 'adopt_unsettled_user_mls_reset', {
      userId: 'user-b',
      handOver: true,
      document: 7,
    });
  });

  it('a native refusal arrives TYPED, with its code - a page that is gone settles nothing', async () => {
    invoke.mockRejectedValue({ code: 'RESET_NOT_STAGED_BY_THIS_PAGE', message: 'gone' });
    const refusal = await removeMlsState('user-b').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(MlsResetRefusedError);
    expect((refusal as MlsResetRefusedError).code).toBe('RESET_NOT_STAGED_BY_THIS_PAGE');
  });

  it('a refused stage or commit propagates - nothing moved is never reported as done', async () => {
    const refusal = "this account's state was cut part-way through a move";
    invoke.mockImplementation((cmd: string) =>
      cmd === 'terminer_session_mls' ? Promise.resolve(undefined) : Promise.reject(refusal)
    );
    await expect(stageMlsStateReset('user-b', BASIS)).rejects.toBe(refusal);
    await expect(removeMlsState('user-b')).rejects.toBe(refusal);
  });

  it('the web stages and rolls back nothing', async () => {
    tauri = false;
    await stageMlsStateReset('user-b', BASIS);
    await rollbackMlsStateReset('user-b');
    expect(invoke).not.toHaveBeenCalled();
  });
});
