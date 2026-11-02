import { runPinReset, type PinResetSteps } from './pinReset';

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
