import {
  pinSaltFingerprint,
  runPinReset,
  serverPinSaltFingerprint,
  settleUnsettledPinReset,
  type PinResetSteps,
  type UnsettledPinResetSteps,
} from './pinReset';

/**
 * THE "FORGOT PIN" RESET'S ORDER (round 6 of the review of #2919): the local state is set apart
 * before the server is asked, put back when the server does not reset the PIN, and the gate enters
 * first setup the moment it has - before the commit can fail.
 */
function steps(overrides: Partial<PinResetSteps> = {}) {
  const order: string[] = [];
  const s: PinResetSteps = {
    stage: vi.fn(async () => {
      order.push('stage');
    }),
    askServer: vi.fn(async () => {
      order.push('server');
    }),
    rollback: vi.fn(async () => {
      order.push('rollback');
    }),
    enterFirstSetup: vi.fn(() => {
      order.push('first setup');
    }),
    commit: vi.fn(async () => {
      order.push('commit');
    }),
    log: vi.fn(),
    ...overrides,
  };
  return { s, order };
}

describe('the "forgot PIN" reset', () => {
  it('sets the state apart, asks the server, enters first setup, then commits', async () => {
    const { s, order } = steps();
    await runPinReset(s);
    expect(order).toEqual(['stage', 'server', 'first setup', 'commit']);
  });

  it('a refused stage asks the server nothing', async () => {
    const refusal = new Error("this account's state was cut part-way through a move");
    const { s, order } = steps({ stage: vi.fn(async () => Promise.reject(refusal)) });
    await expect(runPinReset(s)).rejects.toBe(refusal);
    expect(order).toEqual([]);
    expect(s.askServer).not.toHaveBeenCalled();
  });

  it('a server that does not reset the PIN rolls the state back - the old PIN still opens it', async () => {
    const failure = new Error('Server-side PIN reset failed (503).');
    const { s, order } = steps();
    s.askServer = vi.fn(async () => Promise.reject(failure));
    await expect(runPinReset(s)).rejects.toBe(failure);
    expect(order).toEqual(['stage', 'rollback']);
    expect(s.enterFirstSetup).not.toHaveBeenCalled();
    expect(s.commit).not.toHaveBeenCalled();
  });

  it('a rollback that fails still reports the server failure, and says so', async () => {
    const failure = new Error('Server-side PIN reset failed (500).');
    const { s } = steps();
    s.askServer = vi.fn(async () => Promise.reject(failure));
    s.rollback = vi.fn(async () => Promise.reject(new Error('disk')));
    await expect(runPinReset(s)).rejects.toBe(failure);
    expect((s.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain(
      'could not be put back now'
    );
  });

  it('a commit that fails leaves the gate in first setup - the next PIN is never read as an unlock', async () => {
    const failure = new Error('disk');
    const { s, order } = steps();
    s.commit = vi.fn(async () => {
      order.push('commit');
      throw failure;
    });
    await expect(runPinReset(s)).rejects.toBe(failure);
    expect(order).toEqual(['stage', 'server', 'first setup', 'commit']);
  });
});

/**
 * ROUND 9 OF THE REVIEW OF #2919: a reset a page that is gone left unsettled is settled from the
 * SERVER'S ANSWER - never undone on a guess, which sent an account whose PIN the server had reset
 * back to an old PIN that opens nothing.
 */
describe('an unsettled "forgot PIN" reset', () => {
  const BASIS = 'a'.repeat(64);

  function settleSteps(overrides: Partial<UnsettledPinResetSteps> = {}) {
    const order: string[] = [];
    const s: UnsettledPinResetSteps = {
      adopt: vi.fn(async () => BASIS),
      serverSaltFingerprint: vi.fn(async () => BASIS),
      commit: vi.fn(async () => {
        order.push('commit');
      }),
      rollback: vi.fn(async () => {
        order.push('rollback');
      }),
      log: vi.fn(),
      ...overrides,
    };
    return { s, order };
  }

  it('is left alone when there is none', async () => {
    const { s, order } = settleSteps({ adopt: vi.fn(async () => null) });
    expect(await settleUnsettledPinReset(s)).toBe('none');
    expect(s.serverSaltFingerprint).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('is rolled back when the server still holds the salt it was staged under', async () => {
    const { s, order } = settleSteps();
    expect(await settleUnsettledPinReset(s)).toBe('rolled_back');
    expect(order).toEqual(['rollback']);
  });

  it('is committed when the server holds no PIN any more', async () => {
    const { s, order } = settleSteps({ serverSaltFingerprint: vi.fn(async () => null) });
    expect(await settleUnsettledPinReset(s)).toBe('committed');
    expect(order).toEqual(['commit']);
  });

  it('is committed when the server holds another salt - a new PIN was chosen since', async () => {
    const { s, order } = settleSteps({ serverSaltFingerprint: vi.fn(async () => 'b'.repeat(64)) });
    expect(await settleUnsettledPinReset(s)).toBe('committed');
    expect(order).toEqual(['commit']);
  });

  it('is neither committed nor rolled back when the server does not answer', async () => {
    const { s, order } = settleSteps({
      serverSaltFingerprint: vi.fn(async () => Promise.reject(new Error('offline'))),
    });
    expect(await settleUnsettledPinReset(s)).toBe('unanswered');
    expect(order).toEqual([]);
    expect((s.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain('ERROR');
  });
});

describe("the server's PIN salt fingerprint", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('asks pin-status first, and never the salt of a user with no PIN - that GET writes', async () => {
    const fetchFn = vi.fn(async () => json({ registered: false }));
    expect(
      await serverPinSaltFingerprint('u1', { baseUrl: 'https://x', token: 't', fetchFn })
    ).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain('/pin-status/u1');
  });

  it("answers the fingerprint of a registered user's salt", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes('pin-status') ? json({ registered: true }) : json({ salt: 'salt-1' })
    );
    const fp = await serverPinSaltFingerprint('u1', {
      baseUrl: 'https://x',
      token: 't',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fp).toBe(await pinSaltFingerprint('salt-1'));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws when the server does not answer, never reads it as an answer', async () => {
    const fetchFn = vi.fn(async () => json({}, 503));
    await expect(
      serverPinSaltFingerprint('u1', { baseUrl: 'https://x', token: 't', fetchFn })
    ).rejects.toThrow('503');
  });
});
