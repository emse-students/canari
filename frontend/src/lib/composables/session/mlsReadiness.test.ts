import {
  MlsSessionEndedError,
  abandonMlsReadyWaiters,
  mlsReadyClient,
  setMlsReady,
  whenMlsReady,
} from './mlsReadiness';

/** A WAIT FOR MLS NEVER OUTLIVES ITS CALLER NOR ITS SESSION (calls.md, "The answer joins on its own group"). */
describe('whenMlsReady', () => {
  afterEach(() => {
    setMlsReady(false);
    abandonMlsReadyWaiters('test end');
  });

  it('an aborted waiter is removed and rejected with the reason: the next session wakes nothing', async () => {
    const stop = new AbortController();
    const waiting = whenMlsReady(stop.signal);

    stop.abort(new Error('the call ended'));

    await expect(waiting).rejects.toThrow('the call ended');
    expect(abandonMlsReadyWaiters('signed out')).toBe(0);
  });

  it('a sign-out rejects the parked waiters, typed', async () => {
    const waiting = whenMlsReady();
    expect(abandonMlsReadyWaiters('signed out')).toBe(1);
    await expect(waiting).rejects.toBeInstanceOf(MlsSessionEndedError);
  });

  it('resolves at once when MLS is up, whatever the signal', async () => {
    setMlsReady(true);
    await expect(whenMlsReady(new AbortController().signal)).resolves.toBeUndefined();
  });

  it('names the client it is ready on, and none once not ready', () => {
    const client = { id: 'session client' };
    setMlsReady(true, client);
    expect(mlsReadyClient()).toBe(client);
    setMlsReady(false);
    expect(mlsReadyClient()).toBeNull();
  });
});
