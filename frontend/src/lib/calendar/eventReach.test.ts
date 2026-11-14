import { afterEach, describe, expect, it, vi } from 'vitest';

const estate = vi.hoisted(() => ({ eventReach: null as boolean | null }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  serverEventReach: () => estate.eventReach,
}));

import { eventReachOffered } from './eventReach';

/**
 * A STORE BUILD NEWER THAN ITS SERVER (review of #3460): the picker, and the requirement it brings,
 * exist only on an estate that SAYS it stores the reach - an unknown or older estate files as before.
 */
describe('eventReachOffered', () => {
  afterEach(() => {
    estate.eventReach = null;
  });

  it('offers the reach to an institution on an estate that stores it', () => {
    estate.eventReach = true;
    expect(eventReachOffered('institution')).toBe(true);
  });

  it('never to another owner type', () => {
    estate.eventReach = true;
    expect(eventReachOffered('association')).toBe(false);
    expect(eventReachOffered(null)).toBe(false);
  });

  it('not while the estate is older or has not answered yet', () => {
    estate.eventReach = false;
    expect(eventReachOffered('institution')).toBe(false);
    estate.eventReach = null;
    expect(eventReachOffered('institution')).toBe(false);
  });
});
