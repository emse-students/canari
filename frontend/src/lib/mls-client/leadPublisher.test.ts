/**
 * The lead a session gives up, and when: never while an MLS operation that needs it is in flight
 * (review of #4053). Driven through the real hold counter, not read from source.
 */
import { createLeadPublisher } from './leadPublisher';
import {
  describeLeadHolds,
  holdLeadWhile,
  leadHoldsInFlight,
  onLeadHoldsReleased,
  resetLeadHoldsForTests,
  takeLeadHold,
} from './leadHolds';

function publisher() {
  const calls: string[] = [];
  const eligibility: boolean[] = [];
  const warnings: string[] = [];
  const p = createLeadPublisher({
    setTabLeadEligibility: (eligible) => {
      eligibility.push(eligible);
      calls.push(`eligible:${eligible}`);
    },
    setDelegationReadiness: (r) => calls.push(`readiness:${r}`),
    leadHoldsInFlight,
    describeLeadHolds,
    onLeadHoldsReleased,
    warn: (m) => warnings.push(m),
  });
  return { p, calls, eligibility, warnings };
}

describe('a session that cannot serve gives the lead up only once its MLS work settled', () => {
  beforeEach(() => resetLeadHoldsForTests());

  it('publishes the eligibility BEFORE the readiness', () => {
    const { p, calls } = publisher();
    p.publish('ready');
    expect(calls).toEqual(['eligible:true', 'readiness:ready']);
    calls.length = 0;
    p.publish('unavailable');
    expect(calls).toEqual(['eligible:false', 'readiness:unavailable']);
  });

  it('keeps the lead while a hold is in flight, and gives it up the moment the hold settles', async () => {
    const { p, eligibility } = publisher();
    let finish!: () => void;
    const commit = holdLeadWhile('commit', () => new Promise<void>((r) => (finish = r)));

    p.publish('unavailable');
    expect(eligibility.at(-1)).toBe(true);

    finish();
    await commit;
    expect(leadHoldsInFlight()).toBe(0);
    expect(eligibility.at(-1)).toBe(false);
  });

  it('releases on failure too, so a failed operation never keeps the lead', async () => {
    const { p, eligibility } = publisher();
    const failing = holdLeadWhile('mint', () => Promise.reject(new Error('boom')));
    p.publish('unavailable');
    expect(eligibility.at(-1)).toBe(true);
    await expect(failing).rejects.toThrow('boom');
    expect(eligibility.at(-1)).toBe(false);
  });

  it('waits for the LAST of several holds, and a double release counts once', () => {
    const { p, eligibility } = publisher();
    const a = takeLeadHold('a');
    const b = takeLeadHold('b');
    p.publish('unavailable');
    a();
    a();
    expect(leadHoldsInFlight()).toBe(1);
    expect(eligibility.at(-1)).toBe(true);
    b();
    expect(eligibility.at(-1)).toBe(false);
  });

  it('a session that came back before the hold settled keeps the lead', () => {
    const { p, eligibility } = publisher();
    const hold = takeLeadHold('checkpoint');
    p.publish('unavailable');
    p.publish('ready');
    hold();
    expect(eligibility.at(-1)).toBe(true);
  });

  it('says ONCE, at warn and naming them, that holds keep an ended session in the lead', () => {
    const { p, warnings } = publisher();
    const hold = takeLeadHold('external join of abcd1234');
    p.publish('unavailable');
    p.publish('unavailable');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('external join of abcd1234');
    hold();
    // Nothing to say when nothing holds it.
    p.publish('ready');
    p.publish('unavailable');
    expect(warnings).toHaveLength(1);
  });
});
