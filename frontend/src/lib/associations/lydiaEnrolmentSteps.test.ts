import { describe, expect, it } from 'vitest';
import type { AssociationPayoutAccount } from './api';
import { lydiaEnrolmentView } from './lydiaEnrolmentSteps';

const base: AssociationPayoutAccount = {
  lydiaAccountId: null,
  lydiaDashboardUrl: null,
  lydiaOnboardingComplete: false,
  responsable: null,
  readiness: null,
  enrolmentInFlightSince: null,
};
const responsable = { userId: 'u1', name: 'Ada', phoneEnd: '78' };
const AT = '2026-10-30T10:00:00Z';

describe('lydiaEnrolmentView', () => {
  it('nothing linked: details is the current step', () => {
    const v = lydiaEnrolmentView(base, false);
    expect(v.steps.map((s) => s.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
  });
  it('in flight: details is in-flight, no clear action for a manager', () => {
    const v = lydiaEnrolmentView({ ...base, enrolmentInFlightSince: AT }, false);
    expect(v.steps[0].state).toBe('in-flight');
    expect(v.adminCanClearInFlight).toBe(false);
  });
  it('in flight seen by an admin: the clear action is offered', () => {
    expect(
      lydiaEnrolmentView({ ...base, enrolmentInFlightSince: AT }, true).adminCanClearInFlight
    ).toBe(true);
  });
  it('linked, no responsable: responsable is current', () => {
    const v = lydiaEnrolmentView({ ...base, lydiaAccountId: 'v' }, false);
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
  });
  it('responsable done, not ready: activate and validation are current, activate never done', () => {
    const v = lydiaEnrolmentView({ ...base, lydiaAccountId: 'v', responsable }, false);
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'current']);
  });
  it('paused after a refused request carries the cause and date', () => {
    const v = lydiaEnrolmentView(
      {
        ...base,
        lydiaAccountId: 'v',
        responsable,
        readiness: { cause: 'request-refused', at: AT },
      },
      false
    );
    expect(v.steps[3].state).toBe('paused');
    expect(v.pause).toEqual({ cause: 'request-refused', at: AT });
  });
  it('paused after a blocked Business', () => {
    const v = lydiaEnrolmentView(
      {
        ...base,
        lydiaAccountId: 'v',
        responsable,
        readiness: { cause: 'request-blocked', at: AT },
      },
      false
    );
    expect(v.pause?.cause).toBe('request-blocked');
  });
  it('active with a responsable: folded, no record prompt', () => {
    const v = lydiaEnrolmentView(
      { ...base, lydiaAccountId: 'v', lydiaOnboardingComplete: true, responsable },
      false
    );
    expect(v.active).toBe(true);
    expect(v.recordResponsable).toBe(false);
    expect(v.pause).toBeNull();
  });
  it('already-linked active without a responsable: the record prompt', () => {
    const v = lydiaEnrolmentView(
      { ...base, lydiaAccountId: 'v', lydiaOnboardingComplete: true },
      false
    );
    expect(v.active).toBe(true);
    expect(v.recordResponsable).toBe(true);
  });
  it('admin validate is offered only while linked and not ready', () => {
    expect(lydiaEnrolmentView(base, true).adminCanValidate).toBe(false);
    expect(lydiaEnrolmentView({ ...base, lydiaAccountId: 'v' }, true).adminCanValidate).toBe(true);
    expect(lydiaEnrolmentView({ ...base, lydiaAccountId: 'v' }, false).adminCanValidate).toBe(
      false
    );
    expect(
      lydiaEnrolmentView({ ...base, lydiaAccountId: 'v', lydiaOnboardingComplete: true }, true)
        .adminCanValidate
    ).toBe(false);
  });
});
