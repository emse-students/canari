import type { UserGroupRow } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import { isNeverAdmitted, reconcileRestoredLifecycles, syncAdmissionFlags } from './admissionState';

const row = (lifecycle: Conversation['lifecycle'], awaitingAdmission?: boolean): Conversation => ({
  id: 'g1',
  contactName: 'g1',
  name: 'Groupe',
  messages: [],
  lifecycle,
  mlsStateHex: null,
  ...(awaitingAdmission === undefined ? {} : { awaitingAdmission }),
});

const listed = (deviceMembership?: UserGroupRow['deviceMembership']): UserGroupRow[] => [
  {
    groupId: 'g1',
    name: 'Groupe',
    isGroup: true,
    ...(deviceMembership === undefined ? {} : { deviceMembership }),
  } as UserGroupRow,
];

const seat = (awaitingAdmission?: boolean) =>
  ({
    status: 'pending',
    welcomeQueued: false,
    addInFlight: false,
    admitted: false,
    ...(awaitingAdmission === undefined ? {} : { awaitingAdmission }),
  }) as UserGroupRow['deviceMembership'];

describe('isNeverAdmitted', () => {
  it('is an ask on a row this device was never in', () => {
    expect(isNeverAdmitted(row('pending', true))).toBe(true);
  });

  it('is never an active or removed row, nor one with no flag', () => {
    expect(isNeverAdmitted(row('active', true))).toBe(false);
    expect(isNeverAdmitted(row('removed', true))).toBe(false);
    expect(isNeverAdmitted(row('pending'))).toBe(false);
  });
});

describe('syncAdmissionFlags', () => {
  it("sets the flag from the list's word on this device's seat, and reports the change once", () => {
    const conversations = new Map([['g1', row('pending')]]);

    expect(syncAdmissionFlags(conversations, listed(seat(true)))).toEqual(['g1']);
    expect(conversations.get('g1')?.awaitingAdmission).toBe(true);
    expect(syncAdmissionFlags(conversations, listed(seat(true)))).toEqual([]);
  });

  it('clears it once the seat is admitted, and never flags a row this device is in', () => {
    const conversations = new Map([['g1', row('pending', true)]]);
    expect(syncAdmissionFlags(conversations, listed(seat(false)))).toEqual(['g1']);
    expect(conversations.get('g1')?.awaitingAdmission).toBe(false);

    const active = new Map([['g1', row('active')]]);
    expect(syncAdmissionFlags(active, listed(seat(true)))).toEqual([]);
  });

  it('leaves the row alone when the server does not say - an older server, or no seat row', () => {
    const conversations = new Map([['g1', row('pending', true)]]);

    expect(syncAdmissionFlags(conversations, listed())).toEqual([]);
    expect(syncAdmissionFlags(conversations, listed(null))).toEqual([]);
    expect(syncAdmissionFlags(conversations, listed(seat()))).toEqual([]);
    expect(conversations.get('g1')?.awaitingAdmission).toBe(true);
  });
});

/**
 * THE RESTORE PROMOTES A PENDING ROW ON MEMBERSHIP, NEVER ON HELD STATE ALONE (review, 2026-10-31).
 * An evicted group stays held, so a row awaiting the Welcome of its re-admission was promoted to
 * `active` at boot, and the outbox then failed the next message as evicted.
 */
describe('reconcileRestoredLifecycles', () => {
  const mls = (active: () => Promise<boolean>) => ({
    isGroupActive: vi.fn(active),
    forgetGroup: vi.fn(),
    persistCheckpoint: vi.fn(async () => {}),
  });
  const named = (id: string, lifecycle: Conversation['lifecycle']): Conversation => ({
    ...row(lifecycle),
    id,
    contactName: id,
  });

  it('promotes a pending row whose held group says this device is a member', async () => {
    const conversations = new Map([['g1', named('g1', 'pending')]]);
    const out = await reconcileRestoredLifecycles({
      conversations,
      localGroups: new Set(['g1']),
      mlsService: mls(async () => true),
      log: () => {},
    });
    expect(out).toEqual({ demoted: [], promoted: ['g1'], awaiting: [] });
    expect(conversations.get('g1')?.lifecycle).toBe('active');
  });

  it('keeps PENDING a row whose held group says this device is out, and drops the evicted state', async () => {
    // A re-admission awaiting its Welcome, written by a client that kept the evicted state: dropped,
    // it is the ordinary awaiting-Welcome state the recovery ends - kept, nothing would.
    const conversations = new Map([['g1', named('g1', 'pending')]]);
    const service = mls(async () => false);
    const out = await reconcileRestoredLifecycles({
      conversations,
      localGroups: new Set(['g1']),
      mlsService: service,
      log: () => {},
    });
    expect(out).toEqual({ demoted: [], promoted: [], awaiting: ['g1'] });
    expect(conversations.get('g1')?.lifecycle).toBe('pending');
    expect(service.forgetGroup).toHaveBeenCalledWith('g1', 0);
    expect(service.persistCheckpoint).toHaveBeenCalled();
  });

  /**
   * WHAT A KILL CAN LEAVE (review of #2808). The merged Remove reaches disk by checkpoints the commit
   * path does not order, and the row by another store, so an `active` row over the evicted state
   * survives a kill - with nothing left to say whether the Remove was an eviction or this device's
   * own re-admission. The restore must not decide; it hands the row to the server's answer.
   */
  it('an ACTIVE row over a group this device is out of is not trusted: the state is dropped and the row waits on the server', async () => {
    const conversations = new Map([['g1', named('g1', 'active')]]);
    const service = mls(async () => false);
    const out = await reconcileRestoredLifecycles({
      conversations,
      localGroups: new Set(['g1']),
      mlsService: service,
      log: () => {},
    });
    expect(out).toEqual({ demoted: [], promoted: [], awaiting: ['g1'] });
    expect(conversations.get('g1')).toMatchObject({
      lifecycle: 'pending',
      awaitingAdmission: false,
    });
    expect(service.forgetGroup).toHaveBeenCalledWith('g1', 0);
  });

  it('leaves an active row this device is still a member of, and a removed row, untouched', async () => {
    const conversations = new Map([
      ['g1', named('g1', 'active')],
      ['g2', named('g2', 'removed')],
    ]);
    const service = mls(async () => true);
    const out = await reconcileRestoredLifecycles({
      conversations,
      localGroups: new Set(['g1', 'g2']),
      mlsService: service,
      log: () => {},
    });
    expect(out).toEqual({ demoted: [], promoted: [], awaiting: [] });
    expect(conversations.get('g1')!.lifecycle).toBe('active');
    expect(conversations.get('g2')!.lifecycle).toBe('removed');
    expect(service.isGroupActive).toHaveBeenCalledTimes(1);
    expect(service.forgetGroup).not.toHaveBeenCalled();
  });

  it('promotes nothing when the membership cannot be read, and says so', async () => {
    const unreadable = mls(async () => {
      throw new Error('unreadable');
    });
    const conversations = new Map([['g1', named('g1', 'pending')]]);
    const lines: string[] = [];
    const out = await reconcileRestoredLifecycles({
      conversations,
      localGroups: new Set(['g1']),
      mlsService: unreadable,
      log: (l) => lines.push(l),
    });
    expect(out.promoted).toEqual([]);
    expect(unreadable.forgetGroup).not.toHaveBeenCalled();
    expect(conversations.get('g1')?.lifecycle).toBe('pending');
    expect(lines.some((l) => l.includes('could not be read'))).toBe(true);
  });

  it('demotes an active row whose group is not held, as an admitted one', async () => {
    const conversations = new Map([['g1', { ...named('g1', 'active'), awaitingAdmission: true }]]);
    const out = await reconcileRestoredLifecycles({
      conversations,
      localGroups: new Set<string>(),
      mlsService: mls(async () => true),
      log: () => {},
    });
    expect(out.demoted).toEqual(['g1']);
    expect(conversations.get('g1')).toMatchObject({
      lifecycle: 'pending',
      awaitingAdmission: false,
    });
  });
});
