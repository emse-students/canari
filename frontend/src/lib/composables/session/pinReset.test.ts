import {
  noServerPinBasis,
  PinResetRefusedError,
  pinSaltFingerprint,
  runPinReset,
  serverPinSaltFingerprint,
  settleUnsettledPinReset,
  type PinResetSteps,
  type UnsettledPinResetSteps,
} from './pinReset';

const BASIS = 'a'.repeat(64);

/**
 * THE "FORGOT PIN" RESET'S ORDER (rounds 6 and 10 of the review of #2919): the server's salt is asked
 * first and journalled with the stage, the local state is set apart before the server is asked, put
 * back only on a DEFINITE refusal or an unchanged salt, and the gate enters first setup the moment
 * the server has reset - before the commit can fail.
 */
function steps(overrides: Partial<PinResetSteps> = {}) {
  const order: string[] = [];
  const s: PinResetSteps = {
    serverSaltFingerprint: vi.fn(async () => BASIS),
    stage: vi.fn(async () => {
      order.push('stage');
    }),
    askServer: vi.fn(async () => {
      order.push('server');
    }),
    rollback: vi.fn(async () => {
      order.push('rollback');
    }),
    handOver: vi.fn(async () => {
      order.push('hand over');
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

const logged = (s: { log: unknown }) =>
  (s.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');

describe('the "forgot PIN" reset', () => {
  it('stages under the server salt, asks the server, enters first setup, then commits', async () => {
    const { s, order } = steps();
    await runPinReset(s);
    expect(order).toEqual(['stage', 'server', 'first setup', 'commit']);
    expect(s.stage).toHaveBeenCalledWith(BASIS);
  });

  it('a salt the server will not say moves nothing and asks the server nothing', async () => {
    const offline = new TypeError('Failed to fetch');
    const { s, order } = steps({
      serverSaltFingerprint: vi.fn(async () => Promise.reject(offline)),
    });
    await expect(runPinReset(s)).rejects.toBe(offline);
    expect(order).toEqual([]);
  });

  it('with no PIN on the server, the local state is reset alone - staged and committed (round 10, F6)', async () => {
    const { s, order } = steps({ serverSaltFingerprint: vi.fn(async () => null) });
    await runPinReset(s);
    expect(order).toEqual(['stage', 'first setup', 'commit']);
    expect(s.stage).toHaveBeenCalledWith(await noServerPinBasis());
    expect(s.askServer).not.toHaveBeenCalled();
    expect(logged(s)).toContain('the server holds no PIN');
  });

  it('a refused stage asks the server nothing', async () => {
    const refusal = new Error("this account's state was cut part-way through a move");
    const { s, order } = steps({ stage: vi.fn(async () => Promise.reject(refusal)) });
    await expect(runPinReset(s)).rejects.toBe(refusal);
    expect(order).toEqual([]);
    expect(s.askServer).not.toHaveBeenCalled();
  });

  it('a DEFINITE refusal (4xx) rolls the state back - the old PIN still opens it', async () => {
    const refusal = new PinResetRefusedError(403);
    const { s, order } = steps();
    s.askServer = vi.fn(async () => Promise.reject(refusal));
    await expect(runPinReset(s)).rejects.toBe(refusal);
    expect(order).toEqual(['stage', 'rollback']);
    expect(s.serverSaltFingerprint).toHaveBeenCalledTimes(1);
    expect(s.enterFirstSetup).not.toHaveBeenCalled();
    expect(s.commit).not.toHaveBeenCalled();
  });

  it('NO ANSWER (a 5xx) with the salt unchanged rolls back: the server did not reset', async () => {
    const failure = new Error('Server-side PIN reset answered 500.');
    const { s, order } = steps();
    s.askServer = vi.fn(async () => Promise.reject(failure));
    await expect(runPinReset(s)).rejects.toBe(failure);
    expect(order).toEqual(['stage', 'rollback']);
    expect(s.serverSaltFingerprint).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no PIN any more', null],
    ['another salt', 'b'.repeat(64)],
  ])(
    'NO ANSWER (a transport failure) with %s commits: the server reset, its reply was lost',
    async (_label, now) => {
      const { s, order } = steps();
      s.serverSaltFingerprint = vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce(BASIS)
        .mockResolvedValueOnce(now);
      s.askServer = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
      await runPinReset(s);
      expect(order).toEqual(['stage', 'first setup', 'commit']);
      expect(s.rollback).not.toHaveBeenCalled();
    }
  );

  it('NO ANSWER and no salt either: the reset is handed over, never rolled back on a guess', async () => {
    const failure = new TypeError('Failed to fetch');
    const { s, order } = steps();
    s.serverSaltFingerprint = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(BASIS)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    s.askServer = vi.fn(async () => Promise.reject(failure));
    await expect(runPinReset(s)).rejects.toBe(failure);
    expect(order).toEqual(['stage', 'hand over']);
    expect(s.rollback).not.toHaveBeenCalled();
    expect(s.commit).not.toHaveBeenCalled();
  });

  it('a rollback that fails still reports the refusal, and says so', async () => {
    const refusal = new PinResetRefusedError(400);
    const { s } = steps();
    s.askServer = vi.fn(async () => Promise.reject(refusal));
    s.rollback = vi.fn(async () => Promise.reject(new Error('disk')));
    await expect(runPinReset(s)).rejects.toBe(refusal);
    expect(logged(s)).toContain('could not be put back now');
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

  it('is committed when the server holds another salt - a new PIN chosen since is unlocked, not set up', async () => {
    const { s, order } = settleSteps({ serverSaltFingerprint: vi.fn(async () => 'b'.repeat(64)) });
    expect(await settleUnsettledPinReset(s)).toBe('committed_pin_chosen');
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

  it('offline then online in the same page: the adopted reset is asked again, and settles (round 10)', async () => {
    const { s, order } = settleSteps({
      serverSaltFingerprint: vi
        .fn<() => Promise<string | null>>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(BASIS),
    });
    expect(await settleUnsettledPinReset(s)).toBe('unanswered');
    expect(await settleUnsettledPinReset(s)).toBe('rolled_back');
    expect(s.adopt).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['rollback']);
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
