import { holdsGroupState, canSendInGroup } from './groupUsability';
import { markEpochGap, clearEpochGap, resetEpochGapRegistry } from './epochGapRegistry';
import type { IMlsService } from '$lib/mls-client/IMlsService';

function mls(groups: string[]): Pick<IMlsService, 'getLocalGroups'> {
  return { getLocalGroups: () => groups } as Pick<IMlsService, 'getLocalGroups'>;
}

beforeEach(() => {
  resetEpochGapRegistry();
});

describe('holdsGroupState', () => {
  it('is true exactly for the groups this device holds state for', () => {
    const service = mls(['g1', 'g2']);
    expect(holdsGroupState(service, 'g1')).toBe(true);
    expect(holdsGroupState(service, 'g2')).toBe(true);
    expect(holdsGroupState(service, 'g3')).toBe(false);
  });

  // A PREFIX IS NOT A GROUP. The nineteen call sites this replaced all used `includes` on the array,
  // never on a string, and the named predicate must not quietly become the second thing.
  it('matches a whole id, never a prefix or a suffix of one', () => {
    const service = mls(['aaaa-bbbb']);
    expect(holdsGroupState(service, 'aaaa')).toBe(false);
    expect(holdsGroupState(service, 'bbbb')).toBe(false);
    expect(holdsGroupState(service, 'aaaa-bbbb')).toBe(true);
  });

  it('answers false rather than throwing when the device holds nothing at all', () => {
    expect(holdsGroupState(mls([]), 'g1')).toBe(false);
  });
});

describe('canSendInGroup', () => {
  it('is true only when the state is held AND there is no epoch gap', () => {
    const service = mls(['g1']);
    expect(canSendInGroup(service, 'g1')).toBe(true);
    markEpochGap('g1');
    expect(canSendInGroup(service, 'g1')).toBe(false);
    clearEpochGap('g1');
    expect(canSendInGroup(service, 'g1')).toBe(true);
  });

  // NEITHER HALF IS ENOUGH, AND THIS IS THE HALF THAT IS EASY TO FORGET: a group with no local state
  // has no epoch to be behind, so the registry reports no gap for it. Reading the gap alone would
  // call it sendable.
  it('is false for a group this device holds nothing for, gap or no gap', () => {
    const service = mls([]);
    expect(canSendInGroup(service, 'g-unheld')).toBe(false);
    markEpochGap('g-unheld');
    expect(canSendInGroup(service, 'g-unheld')).toBe(false);
  });

  // A gap belongs to ONE group: holding a lagging group must not freeze the sends of a healthy one.
  it('does not let one group’s gap answer for another', () => {
    const service = mls(['g1', 'g2']);
    markEpochGap('g1');
    expect(canSendInGroup(service, 'g1')).toBe(false);
    expect(canSendInGroup(service, 'g2')).toBe(true);
  });
});
