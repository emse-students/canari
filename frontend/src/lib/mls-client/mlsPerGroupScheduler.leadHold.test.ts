/**
 * THE MLS MUTEX HOLDS THE TAB'S LEAD from its grant to its release (second review of #4053): every
 * MLS state change runs under it, so a session ending meanwhile gives the lead up only once that
 * change settled - and a WAIT for the mutex holds nothing.
 */
import { MlsPerGroupScheduler } from './mlsPerGroupScheduler';
import { leadHoldsInFlight, onLeadHoldsReleased, resetLeadHoldsForTests } from './leadHolds';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe('the MLS mutex holds the lead while it is held', () => {
  beforeEach(() => resetLeadHoldsForTests());

  it('holds from the grant, and releases with the mutex', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const body = gate();
    let inside = -1;
    const run = scheduler.runUnderMlsLock(async () => {
      inside = leadHoldsInFlight();
      await body.promise;
    });
    await vi.waitFor(() => expect(inside).toBe(1));
    body.open();
    await run;
    expect(leadHoldsInFlight()).toBe(0);
  });

  it('a commit WAITING for the mutex holds nothing of its own', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    const first = gate();
    const busy = scheduler.runUnderMlsLock(() => first.promise);
    await vi.waitFor(() => expect(leadHoldsInFlight()).toBe(1));

    const queued = scheduler.runCommitUnderMlsLock('group-a', async () => {});
    await Promise.resolve();
    // Still one: the queued commit has not been granted, so a session ending now waits only for
    // the holder, never for the queue behind it.
    expect(leadHoldsInFlight()).toBe(1);

    first.open();
    await Promise.all([busy, queued]);
    expect(leadHoldsInFlight()).toBe(0);
  });

  it('hands the mutex on without the count touching zero in between', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    let zeroes = 0;
    onLeadHoldsReleased(() => (zeroes += 1));
    const first = gate();
    const a = scheduler.runUnderMlsLock(() => first.promise);
    const b = scheduler.runUnderMlsLock(async () => {});
    first.open();
    await Promise.all([a, b]);
    // One release to zero, after the last holder: a session that ended keeps the lead through both.
    expect(zeroes).toBe(1);
  });

  it('releases when the body throws', async () => {
    const scheduler = new MlsPerGroupScheduler('web');
    await expect(
      scheduler.runUnderMlsLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(leadHoldsInFlight()).toBe(0);
  });
});
