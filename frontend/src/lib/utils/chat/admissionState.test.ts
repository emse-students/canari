import type { UserGroupRow } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import {
  applyRestoredLifecycles,
  isNeverAdmitted,
  reconcileRestoredLifecycles,
  syncAdmissionFlags,
} from './admissionState';

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

  it('N dropped states cost ONE checkpoint, not one each - each is a full encrypted save before the connection opens', async () => {
    const conversations = new Map(
      ['g1', 'g2', 'g3'].map((id) => [id, named(id, 'active')] as const)
    );
    const service = mls(async () => false);
    const out = await reconcileRestoredLifecycles({
      conversations,
      localGroups: new Set(['g1', 'g2', 'g3']),
      mlsService: service,
      log: () => {},
    });
    expect(out.awaiting).toEqual(['g1', 'g2', 'g3']);
    expect(service.forgetGroup).toHaveBeenCalledTimes(3);
    expect(service.persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('checkpoints nothing when nothing was dropped', async () => {
    const service = mls(async () => true);
    await reconcileRestoredLifecycles({
      conversations: new Map([['g1', named('g1', 'pending')]]),
      localGroups: new Set(['g1']),
      mlsService: service,
      log: () => {},
    });
    expect(service.persistCheckpoint).not.toHaveBeenCalled();
  });

  it('reads at most eight memberships at once', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `g${i}`);
    let inFlight = 0;
    let peak = 0;
    const service = mls(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return true;
    });
    await reconcileRestoredLifecycles({
      conversations: new Map(ids.map((id) => [id, named(id, 'active')] as const)),
      localGroups: new Set(ids),
      mlsService: service,
      log: () => {},
    });
    expect(service.isGroupActive).toHaveBeenCalledTimes(20);
    expect(peak).toBe(8);
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

/**
 * THE VERDICT IS DURABLE (delta review of #2808, L3): a demotion kept in memory only was read back
 * as the stored `active` row at the next boot - over a group whose evicted state was already gone.
 */
describe('applyRestoredLifecycles', () => {
  const named = (id: string, lifecycle: Conversation['lifecycle']): Conversation => ({
    ...row(lifecycle),
    id,
    contactName: id,
  });
  const service = (active: boolean) => ({
    isGroupActive: vi.fn(async () => active),
    forgetGroup: vi.fn(),
    persistCheckpoint: vi.fn(async () => {}),
  });

  it('writes the row an evicted state was dropped under, as `pending`', async () => {
    const conversations = new Map([['g1', named('g1', 'active')]]);
    const saved: Array<[string, Conversation['lifecycle'] | undefined]> = [];
    await applyRestoredLifecycles({
      conversations,
      localGroups: new Set(['g1']),
      mlsService: service(false),
      saveConversation: async (key) => {
        saved.push([key, conversations.get(key)?.lifecycle]);
      },
      log: () => {},
    });
    expect(saved).toEqual([['g1', 'pending']]);
  });

  it('writes the demoted and the promoted rows too, and logs a write that failed', async () => {
    const conversations = new Map([
      ['g1', named('g1', 'active')],
      ['g2', named('g2', 'pending')],
    ]);
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saveConversation = vi.fn(async (key: string) => {
      if (key === 'g2') throw new Error('quota');
    });
    await applyRestoredLifecycles({
      conversations,
      localGroups: new Set(['g2']),
      mlsService: service(true),
      saveConversation,
      log: (l) => lines.push(l),
    });
    expect(saveConversation).toHaveBeenCalledWith('g1');
    expect(saveConversation).toHaveBeenCalledWith('g2');
    expect(lines).toContainEqual(expect.stringContaining('promoted row not saved'));
    warn.mockRestore();
  });
});
