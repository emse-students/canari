import { describe, expect, it } from 'vitest';
import { isReentryOfSameRoute, type NavigationRoutes } from './reentry';

const nav = (from: string | null, to: string | null) =>
  ({
    from: from === null ? null : { route: { id: from } },
    to: to === null ? null : { route: { id: to } },
  }) as NavigationRoutes;

describe('isReentryOfSameRoute', () => {
  it('is true when a push opens the route the page already shows', () => {
    expect(isReentryOfSameRoute(nav('/notifications', '/notifications'))).toBe(true);
  });
  it('is false on a first entry (cold start): the mount reads', () => {
    expect(isReentryOfSameRoute(nav(null, '/notifications'))).toBe(false);
  });
  it('is false when arriving from another route: the fresh mount reads', () => {
    expect(isReentryOfSameRoute(nav('/dashboard', '/notifications'))).toBe(false);
  });
  it('is false when the destination is unknown', () => {
    expect(isReentryOfSameRoute(nav('/notifications', null))).toBe(false);
  });
});
