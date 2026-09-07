import { attemptCommitReplay } from './commitReplay';

// `vi.hoisted`, NOT a bare `const` plus a dynamic import. `vi.mock` is hoisted above every
// statement in the file, so a factory closing over an ordinary `const` reads it in its temporal
// dead zone; the dynamic-import workaround dodges that but leaves a file with no import and no
// export, which TypeScript then reads as a SCRIPT - and a top-level `await` in a script is an
// error. Local `svelte-check` passed on a warm build and CI, on a fresh checkout, did not.
const noteFrameConsumed = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/history', () => ({
  noteFrameConsumed: (u: string, g: string, b: Uint8Array) => noteFrameConsumed(u, g, b),
}));

function makeMls(overrides: Record<string, unknown>) {
  return {
    getEpoch: vi.fn().mockReturnValue(0),
    fetchCommitsSince: vi.fn(),
    processIncomingMessage: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as any;
}

const noop = () => {};

describe('attemptCommitReplay', () => {
  beforeEach(() => noteFrameConsumed.mockReset());

  /**
   * A COMMIT SPENDS A GENERATION THE SHARED ARCHIVE ALSO HOLDS, and until 2026-09-07 this path
   * recorded nothing - so the archive replay walked the same row later, MLS refused the spent
   * generation, and the client reported a permanent loss and asked a peer to reconcile history it
   * already had. The assertion is on the ARGUMENTS: the account and the group decide which ledger
   * the mark lands in, and a mark in the wrong one is the same as no mark at all.
   */
  it('records every commit it applied as consumed, and nothing it did not', async () => {
    let epoch = 2;
    const mls = makeMls({
      getEpoch: vi.fn(() => epoch),
      fetchCommitsSince: vi.fn().mockResolvedValue({
        commits: [
          { baseEpoch: 2, proto: 'AQ==' },
          { baseEpoch: 3, proto: 'Ag==' },
        ],
        activeEpoch: 4,
        belowFloor: false,
      }),
      processIncomingMessage: vi.fn(async () => {
        epoch++;
        return null;
      }),
    });

    await attemptCommitReplay(mls, 'g', 'user-a', noop);

    expect(noteFrameConsumed).toHaveBeenCalledTimes(2);
    expect(noteFrameConsumed.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['user-a', 'g'],
      ['user-a', 'g'],
    ]);
    expect([...(noteFrameConsumed.mock.calls[0][2] as Uint8Array)]).toEqual([1]);
  });

  it('does NOT record a commit that threw - a refused frame consumed nothing', async () => {
    const mls = makeMls({
      getEpoch: vi.fn(() => 2),
      fetchCommitsSince: vi.fn().mockResolvedValue({
        commits: [{ baseEpoch: 2, proto: 'AQ==' }],
        activeEpoch: 4,
        belowFloor: false,
      }),
      processIncomingMessage: vi.fn().mockRejectedValue(new Error('nope')),
    });

    await attemptCommitReplay(mls, 'g', 'user-a', noop);

    // Claiming it would tell the archive replay "already read" about a frame nobody has read, which
    // is the one failure the ledger must never produce: it silences a real loss instead of a false one.
    expect(noteFrameConsumed).not.toHaveBeenCalled();
  });

  it('heals the gap by applying the missed commits in order', async () => {
    let epoch = 2;
    const mls = makeMls({
      getEpoch: vi.fn(() => epoch),
      fetchCommitsSince: vi.fn().mockResolvedValue({
        commits: [
          { baseEpoch: 2, proto: 'AA==' },
          { baseEpoch: 3, proto: 'AA==' },
        ],
        activeEpoch: 4,
        belowFloor: false,
      }),
      processIncomingMessage: vi.fn(async () => {
        epoch++;
        return null;
      }),
    });

    const res = await attemptCommitReplay(mls, 'g', 'user-a', noop);

    expect(res.healed).toBe(true);
    expect(res.applied).toBe(2);
    expect(mls.processIncomingMessage).toHaveBeenCalledTimes(2);
  });

  it('returns belowFloor without applying anything when the commits were pruned', async () => {
    const mls = makeMls({
      getEpoch: vi.fn().mockReturnValue(2),
      fetchCommitsSince: vi
        .fn()
        .mockResolvedValue({ commits: [], activeEpoch: 9, belowFloor: true }),
    });

    const res = await attemptCommitReplay(mls, 'g', 'user-a', noop);

    expect(res.belowFloor).toBe(true);
    expect(res.healed).toBe(false);
    expect(mls.processIncomingMessage).not.toHaveBeenCalled();
  });

  it('does not claim to have healed a gap it had nothing to replay for', async () => {
    // WP-PENDING-2: the frame failed on a sender-ratchet generation, not on an epoch, so the local
    // epoch already equals the server's. `epoch >= activeEpoch` is true and means nothing here -
    // reporting `healed` made the caller ACK a message it had never decrypted.
    const mls = makeMls({
      getEpoch: vi.fn().mockReturnValue(1),
      fetchCommitsSince: vi
        .fn()
        .mockResolvedValue({ commits: [], activeEpoch: 1, belowFloor: false }),
    });

    const res = await attemptCommitReplay(mls, 'g', 'user-a', noop);

    expect(res.applied).toBe(0);
    expect(res.healed).toBe(false);
  });

  it('stops at the first commit that fails to apply and reports not healed', async () => {
    let epoch = 2;
    const mls = makeMls({
      getEpoch: vi.fn(() => epoch),
      fetchCommitsSince: vi.fn().mockResolvedValue({
        commits: [
          { baseEpoch: 2, proto: 'AA==' },
          { baseEpoch: 3, proto: 'AA==' },
        ],
        activeEpoch: 4,
        belowFloor: false,
      }),
      processIncomingMessage: vi
        .fn()
        .mockImplementationOnce(async () => {
          epoch++;
          return null;
        })
        .mockRejectedValueOnce(new Error('cannot re-process own commit')),
    });

    const res = await attemptCommitReplay(mls, 'g', 'user-a', noop);

    expect(res.applied).toBe(1);
    expect(res.healed).toBe(false); // reached epoch 3, target was 4
  });

  it('stops on a named hole without applying the prefix, because the tail is unreachable', async () => {
    // Measured on prod 2026-09-02 (group `7da231f8`, epoch 121 absent). Before the server named the
    // hole this walked into it: apply 120, throw on 122, `healed=false`, outbox frozen, and rung 2
    // reached only when the watchdog's `STUCK_EPOCH_GAP_MS` expired. A clock standing in for a fact
    // the server held in the same response.
    const mls = makeMls({
      getEpoch: vi.fn().mockReturnValue(120),
      fetchCommitsSince: vi.fn().mockResolvedValue({
        commits: [{ baseEpoch: 120, proto: 'AA==' }],
        activeEpoch: 124,
        belowFloor: false,
        gapAt: 121,
      }),
    });

    const res = await attemptCommitReplay(mls, 'g', 'user-a', noop);

    expect(res.gapAt).toBe(121);
    expect(res.healed).toBe(false);
    expect(res.belowFloor).toBe(false);
    expect(res.applied).toBe(0);
    expect(mls.processIncomingMessage).not.toHaveBeenCalled();
  });
});
