/**
 * `isGroupDrained` - "has this device merged everything the server holds for the group", read as a
 * fact and never waited for (the admission gate's first observation stands on it,
 * channel-encryption section 25). Each case removes ONE piece of the evidence and expects `false`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';

/** @see BaseMlsService.deliveryIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

/** A service whose last pull emptied the mailbox, with no pull running and its socket open. */
function drainedService(idle: (groupId: string) => boolean = () => true): BaseMlsService {
  const svc = makeService();
  Object.assign(svc, {
    mailboxEmptiedByAPull: true,
    pendingPullInFlight: null,
    isWsOpen: () => true,
    messageScheduler: { isGroupIdle: idle },
  });
  return svc;
}

describe('isGroupDrained', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  it('holds when the last pull emptied the mailbox, none runs, the socket is open and the group is idle', () => {
    expect(drainedService().isGroupDrained('g-1')).toBe(true);
  });

  it('does not hold before a pull has listed the whole mailbox', () => {
    const svc = drainedService();
    Object.assign(svc, { mailboxEmptiedByAPull: false });
    expect(svc.isGroupDrained('g-1')).toBe(false);
  });

  it('does not hold while a pull is running', () => {
    const svc = drainedService();
    Object.assign(svc, { pendingPullInFlight: new Promise<void>(() => undefined) });
    expect(svc.isGroupDrained('g-1')).toBe(false);
  });

  it('does not hold once the socket the pull was trusted with has dropped', () => {
    const svc = drainedService();
    Object.assign(svc, { isWsOpen: () => false });
    expect(svc.isGroupDrained('g-1')).toBe(false);
  });

  it('does not hold while the group has frames queued, parked or being applied', () => {
    const svc = drainedService((groupId) => groupId !== 'g-1');
    expect(svc.isGroupDrained('g-1')).toBe(false);
    expect(svc.isGroupDrained('g-2')).toBe(true);
  });
});
