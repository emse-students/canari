// @vitest-environment happy-dom
/**
 * A GROUP FROZEN BY A REFUSED ADMISSION IS NEVER RECOVERED AUTOMATICALLY - not now, not after a
 * restart.
 *
 * Once `mls-core` has refused a commit that brought a new user in on their own, every way back
 * into the group runs through the server that served that commit: the external join imports the
 * server's GroupInfo (whose tree holds the intruder), and the `welcome_request` asks a member who
 * may have accepted it. So the freeze is DURABLE STATE, and `requestReAdd` - the single recovery
 * seam - reads it before anything else. Lifting it is a human decision, never a timer.
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import {
  isReAddDue,
  recoverForkedGroup,
  recoverRosterDisagreement,
  requestReAdd,
  resetReAddCooldowns,
} from './recovery';
import {
  freezeForAdmissionRefusal,
  isFrozenByAdmissionRefusal,
  resetAdmissionFreezes,
} from './admissionFreeze';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
  resetReAddCooldowns();
  resetAdmissionFreezes();
});

function makeDeps() {
  return {
    mlsService: {
      getGroupMeta: vi.fn().mockResolvedValue({ groupId: 'g1', isGroup: true, deletedAt: null }),
      getGroupServerStatus: vi
        .fn()
        .mockResolvedValue({ groupId: 'g1', isGroup: true, deletedAt: null }),
      getLocalGroups: vi.fn().mockReturnValue([]),
      getDeviceId: vi.fn().mockReturnValue('self-device'),
      // Everything that would let it back in is available - that is what makes the refusal matter.
      getDeviceMemberships: vi
        .fn()
        .mockResolvedValue([
          { id: 'm1', userId: 'user-a', deviceId: 'self-device', groupId: 'g1', status: 'active' },
        ]),
      externalJoin: vi.fn().mockResolvedValue({ joined: true }),
      sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
      forgetGroup: vi.fn(),
      isDistributionGroup: vi.fn().mockReturnValue(false),
      noteDistributionGroup: vi.fn(),
      notifyConversationAvailable: vi.fn(),
      waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
      updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
      // What the seam now reads before choosing a door: this ACCOUNT's seat in the group (a seated
      // account keeps the self-service join), the roster rows, the mailbox, and the checkpoint a
      // dropped state is written with. Without them the control case never reaches the join and
      // proves nothing about the freeze.
      getUserGroups: vi.fn().mockResolvedValue([{ groupId: 'g1', name: '', isGroup: true }]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
      persistCheckpoint: vi.fn().mockResolvedValue(undefined),
      isGroupActive: vi.fn().mockResolvedValue(true),
    },
    storage: null,
    userId: 'user-a',
    deviceKey: () => 'device-key',
    conversations: new Map(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    // Raised by the seam once a rejoin lands: the control case reaches it, the frozen cases never do.
    onGroupReady: vi.fn(),
    log: vi.fn(),
  } as any;
}

describe('requestReAdd - a group frozen by a refused admission', () => {
  it('neither external-joins nor asks a member for a Welcome', async () => {
    freezeForAdmissionRefusal('g1', 'mallory:dev7');
    const deps = makeDeps();

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(deps.mlsService.forgetGroup).not.toHaveBeenCalled();
    const said = deps.log.mock.calls.flat().join(' ');
    expect(said).toContain('mallory:dev7');
  });

  it('control: an unfrozen group with the same facts external-joins', async () => {
    // Without this, the case above would pass on a stub that simply never reaches the join.
    const deps = makeDeps();

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1', {
      asAFurtherDevice: 'ask',
    });
  });

  it('freezes only the group that refused', async () => {
    freezeForAdmissionRefusal('g-other', 'mallory:dev7');
    const deps = makeDeps();

    await requestReAdd('g1', deps);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1', {
      asAFurtherDevice: 'ask',
    });
  });
});

describe('every seam that forgets a group is gated on the freeze', () => {
  it('recoverForkedGroup neither forgets the group nor re-adds it', async () => {
    freezeForAdmissionRefusal('g1', 'mallory:dev7');
    const deps = makeDeps();

    await recoverForkedGroup('g1', deps);

    expect(deps.mlsService.forgetGroup).not.toHaveBeenCalled();
    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('recoverRosterDisagreement neither forgets the group nor re-adds it', async () => {
    freezeForAdmissionRefusal('g1', 'mallory:dev7');
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue(['g1']);

    await recoverRosterDisagreement('g1', deps);

    expect(deps.mlsService.forgetGroup).not.toHaveBeenCalled();
    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
  });

  it('a frozen group is never due, so a polling cadence does not call the seam at all', () => {
    expect(isReAddDue('g1')).toBe(true);
    freezeForAdmissionRefusal('g1', 'mallory:dev7');
    expect(isReAddDue('g1')).toBe(false);
  });
});

describe('admissionFreeze - durable', () => {
  it('survives a restart of the module (a reload of the app)', async () => {
    freezeForAdmissionRefusal('g1', 'mallory:dev7');
    vi.resetModules();
    const reloaded = await import('./admissionFreeze');

    expect(reloaded.isFrozenByAdmissionRefusal('g1')).toBe(true);
  });

  it('is not lifted by time', () => {
    vi.useFakeTimers();
    try {
      freezeForAdmissionRefusal('g1', 'mallory:dev7');
      vi.advanceTimersByTime(365 * 24 * 3600 * 1000);
      expect(isFrozenByAdmissionRefusal('g1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
