import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import {
  requestReAdd,
  cancelReAdd,
  reboot,
  migrateConversation,
  recoverForkedGroup,
  resetReAddCooldowns,
  RECOVERY_TIMEOUT_MS,
  REBOOT_DEADLINE_MS,
} from './recovery';
import { saveMlsState } from '$lib/utils/hex';

beforeEach(() => {
  vi.mocked(saveMlsState).mockClear();
  // Reboot deadline markers persist in localStorage across tests - reset between cases.
  if (typeof localStorage !== 'undefined') localStorage.clear();
  // The welcome_request cooldown is module-global - reset it so throttling never leaks between cases.
  resetReAddCooldowns();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMls(overrides: Record<string, unknown> = {}) {
  return {
    sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
    clearPendingWelcomeRequests: vi.fn().mockResolvedValue(undefined),
    getLocalGroups: vi.fn().mockReturnValue([]),
    getGroupMeta: vi.fn().mockResolvedValue(null),
    // Default = group alive on server (neither absent nor tombstone): requestReAdd proceeds
    // without phantom purge (active != absent), and performReboot proceeds to candidate creation
    // (active != unknown). An explicit 'absent' triggers purge; an explicit 'error' simulates
    // network uncertainty (reboot deferred in performReboot).
    getGroupServerStatus: vi
      .fn()
      .mockResolvedValue({ groupId: 'mock-group', deletedAt: null, successorId: null }),
    getUserGroups: vi.fn().mockResolvedValue([]),
    createRemoteGroup: vi.fn().mockResolvedValue('new-id'),
    createGroup: vi.fn().mockResolvedValue(undefined),
    registerMember: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
    claimGroupSuccessor: vi.fn().mockResolvedValue({ claimed: true, successorId: 'new-id' }),
    deleteGroupOnServer: vi.fn().mockResolvedValue(true),
    forgetGroup: vi.fn(),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    getGroupUserMembers: vi.fn().mockResolvedValue([]),
    fetchUserDevices: vi.fn().mockResolvedValue([]),
    addMembersBulk: vi.fn().mockResolvedValue({
      addedDeviceIds: [],
      skippedDeviceIds: [],
      welcome: undefined,
    }),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    acquireAddLock: vi.fn().mockResolvedValue(true),
    releaseAddLock: vi.fn().mockResolvedValue(undefined),
    acquireRebootLock: vi.fn().mockResolvedValue(true),
    releaseRebootLock: vi.fn().mockResolvedValue(undefined),
    getEpoch: vi.fn().mockReturnValue(0),
    getDeviceId: vi.fn().mockReturnValue('self-device'),
    // Phase 4a: default = external join unavailable, so tests exercise the legacy welcome_request
    // fallback. Cases that want the self-service path override this to resolve true.
    externalJoin: vi.fn().mockResolvedValue(false),
    refreshGroupInfo: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeConversations(entries: Array<[string, object]> = []) {
  return new Map(entries) as any;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    mlsService: makeMls(),
    storage: null,
    userId: 'user-a',
    pin: 'pin123',
    conversations: makeConversations(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    ...overrides,
  } as any;
}

// ── requestReAdd ─────────────────────────────────────────────────────────────

describe('requestReAdd', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a welcome_request and marks the group not-ready', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
    // Marked in the persistent registry so the SYNC_WATCHDOG drives the re-add cadence.
    expect(localStorage.getItem('mls_not_ready_since:user-a:g1')).not.toBeNull();
  });

  it('external join success short-circuits the legacy welcome_request', async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue([]);
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue(true);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    // Self-service join succeeded -> no welcome_request, no reboot; not-ready marker cleared.
    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1');
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(deps.mlsService.createRemoteGroup).not.toHaveBeenCalled();
    expect(localStorage.getItem('mls_not_ready_since:user-a:g1')).toBeNull();
  });

  it('throttles: two immediate calls emit a single welcome_request (cooldown)', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    await requestReAdd('g1', deps, timers);

    // The second call is within RECOVERY_TIMEOUT_MS -> throttled by the internal cooldown
    // (the seam self-throttles regardless of caller: watchdog cadence or reactive).
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(1);
  });

  it(`resends welcome_request on the next call past the ${RECOVERY_TIMEOUT_MS / 1000}s cooldown, no reboot`, async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue([]); // toujours absent
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    await vi.advanceTimersByTimeAsync(RECOVERY_TIMEOUT_MS);
    await requestReAdd('g1', deps, timers);

    // Persistent 1h deadline not reached -> no reboot, a second welcome_request once the cooldown
    // elapsed.
    expect(deps.mlsService.createRemoteGroup).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(2);
  });

  it('reboots immediately when REBOOT_DEADLINE_MS has already elapsed (persistent)', async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue([]); // toujours absent
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    // Simulates a group not ready for more than 1h (deadline set in a previous session): the
    // escalation step reboots on the first attempt, no waiting for a timer.
    localStorage.setItem(
      'mls_not_ready_since:user-a:g1',
      String(Date.now() - REBOOT_DEADLINE_MS - 1_000)
    );

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.createRemoteGroup).toHaveBeenCalled();
    expect(deps.mlsService.claimGroupSuccessor).toHaveBeenCalled();
  });

  it('follows the successor chain and sends welcome_request to the terminal', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi.fn().mockImplementation((id: string) => {
          if (id === 'dead-a') return Promise.resolve({ groupId: 'dead-a', successorId: 'dead-b' });
          if (id === 'dead-b') return Promise.resolve({ groupId: 'dead-b', successorId: 'live' });
          if (id === 'live') return Promise.resolve({ groupId: 'live', successorId: null });
          return Promise.resolve(null);
        }),
      }),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('dead-a', deps, timers);

    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('live');
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(1);
  });

  it('Welcome received (group already in WASM) -> no welcome_request, no reboot', async () => {
    const deps = makeDeps();
    // The group is already in WASM (Welcome received in the meantime) -> recovery is a no-op.
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue(['g1']);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    cancelReAdd('g1', timers);

    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(deps.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('group confirmed absent from server -> purges the phantom, no welcome_request', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi.fn().mockResolvedValue(null),
        getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
        getLocalGroups: vi.fn().mockReturnValue([]),
      }),
      conversations: makeConversations([
        ['ghost', { id: 'ghost', name: 'Ghost', lifecycle: 'pending' }],
      ]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('ghost', deps, timers);

    // Loop stopped: no welcome_request emitted.
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    // Local conversation purged.
    expect(deps.deleteConversation).toHaveBeenCalledWith('ghost');
    expect(deps.conversations.has('ghost')).toBe(false);
  });

  it('group absent but conversation removed -> kept (manual deletion), no welcome_request', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi.fn().mockResolvedValue(null),
        getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
      }),
      conversations: makeConversations([
        ['tomb', { id: 'tomb', name: 'Deleted', lifecycle: 'removed' }],
      ]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('tomb', deps, timers);

    // The tombstone remains until manual deletion (rules 2 & 4) but the loop is stopped.
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(deps.deleteConversation).not.toHaveBeenCalled();
    expect(deps.conversations.has('tomb')).toBe(true);
  });
});

// ── recoverForkedGroup ─────────────────────────────────────────────────────────

describe('recoverForkedGroup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('forgets the forked group at the known minEpoch then requests a re-Welcome', async () => {
    const mls = makeMls({ getLocalGroups: vi.fn().mockReturnValue([]) });
    const deps = makeDeps({ mlsService: mls });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await recoverForkedGroup('g-fork', deps, timers, 4);

    // minEpoch rejects a stale re-Welcome from the diverged branch.
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-fork', 4);
    // The forgotten group is no longer local -> the re-Welcome will be honoured.
    expect(mls.sendWelcomeRequest).toHaveBeenCalledWith('g-fork');
  });
});

// ── reboot ───────────────────────────────────────────────────────────────────

describe('reboot', () => {
  it('CAS won -> staged addMembersBulk (validated commit) then sendWelcome for each member', async () => {
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'other', deviceId: 'dev2' }]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([9]), deviceId: 'dev2' }]),
      addMembersBulk: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([3]),
        addedDeviceIds: ['dev2'],
        skippedDeviceIds: [],
        ratchetTree: undefined,
      }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    // addMembersBulk now stages + validates the epoch + merges + broadcasts the commit internally.
    expect(mls.addMembersBulk).toHaveBeenCalledWith('new-id', expect.any(Array));
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'other',
      'new-id',
      'dev2',
      undefined
    );
  });

  it('CAS lost -> candidate deleted, sendWelcomeRequest towards winner', async () => {
    const mls = makeMls({
      claimGroupSuccessor: vi.fn().mockResolvedValue({ claimed: false, successorId: 'winner-id' }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    // Local candidate cleaned up
    expect(mls.deleteGroupOnServer).toHaveBeenCalledWith('new-id');
    expect(mls.forgetGroup).toHaveBeenCalledWith('new-id');
    // Join the winner
    expect(mls.registerMember).toHaveBeenCalledWith('winner-id', 'user-a');
    expect(mls.sendWelcomeRequest).toHaveBeenCalledWith('winner-id');
  });

  it('reboot cross-device lock held elsewhere -> abstention, no candidate created', async () => {
    const mls = makeMls({
      acquireRebootLock: vi.fn().mockResolvedValue(false),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    // The loser creates no candidate and does not attempt CAS (the winner handles it).
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
    expect(mls.claimGroupSuccessor).not.toHaveBeenCalled();
    // Lock was not acquired, so it is not released.
    expect(mls.releaseRebootLock).not.toHaveBeenCalled();
  });

  it('reboot lock released after a complete reboot', async () => {
    const mls = makeMls();
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    expect(mls.acquireRebootLock).toHaveBeenCalledWith('dead');
    expect(mls.releaseRebootLock).toHaveBeenCalledWith('dead');
  });

  it('DM successor gets the canonical self::peer name from the repaired peer', async () => {
    const mls = makeMls();
    const deps = makeDeps({
      mlsService: mls,
      conversations: makeConversations([
        ['dead', { id: 'dead', conversationType: 'direct', directPeerId: 'peer-b' }],
      ]),
    });

    await reboot('dead', deps);

    // Never propagate a malformed ancestor name: recompute self::peer.
    expect(mls.createRemoteGroup).toHaveBeenCalledWith('user-a::peer-b', false);
  });

  it('DM successor recovers the peer from the roster when the ancestor name is self-only', async () => {
    const mls = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'dead', name: 'user-a', isGroup: false }]),
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'user-a' }, { userId: 'peer-b' }]),
    });
    const deps = makeDeps({
      mlsService: mls,
      conversations: makeConversations([['dead', { id: 'dead', conversationType: 'direct' }]]),
    });

    await reboot('dead', deps);

    expect(mls.createRemoteGroup).toHaveBeenCalledWith('user-a::peer-b', false);
  });

  it('no other member -> no sendWelcome, no error', async () => {
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'user-a', deviceId: 'self' }]),
    });
    const deps = makeDeps({ mlsService: mls });

    await expect(reboot('dead', deps)).resolves.not.toThrow();
    expect(mls.sendWelcome).not.toHaveBeenCalled();
  });

  it('getGroupMembers empty -> fallback getGroupUserMembers -> sendWelcome sent', async () => {
    // Simulates the case of a creator device removed via fresh-start:
    // dm_device_group_memberships empty, but dm_group_members populated.
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([]),
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'other' }]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([9]), deviceId: 'dev2' }]),
      addMembersBulk: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([3]),
        addedDeviceIds: ['dev2'],
        skippedDeviceIds: [],
        ratchetTree: undefined,
      }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    expect(mls.getGroupUserMembers).toHaveBeenCalled();
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'other',
      'new-id',
      'dev2',
      undefined
    );
  });

  it('getGroupMembers and getGroupUserMembers empty -> no sendWelcome', async () => {
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([]),
      getGroupUserMembers: vi.fn().mockResolvedValue([]),
    });
    const deps = makeDeps({ mlsService: mls });

    await expect(reboot('dead', deps)).resolves.not.toThrow();
    expect(mls.getGroupUserMembers).toHaveBeenCalled();
    expect(mls.sendWelcome).not.toHaveBeenCalled();
  });

  it('findAncestorWithMembers: prefers the current group (user-level) over an ancestor (device-level)', async () => {
    // Scenario: ancestor A -> dead. A has active device-level members (old data),
    // dead has user-level members (up-to-date data). Reboot must invite from dead, not A.
    const mls = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'ancestor', successorId: 'dead', isGroup: false }]),
      getGroupMembers: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === 'ancestor' ? [{ userId: 'old-user', deviceId: 'old-dev' }] : [])
        ),
      getGroupUserMembers: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === 'dead' ? [{ userId: 'current-user' }] : [])
        ),
      fetchUserDevices: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(
            id === 'current-user'
              ? [{ keyPackage: new Uint8Array([9]), deviceId: 'dev-current' }]
              : []
          )
        ),
      addMembersBulk: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([3]),
        addedDeviceIds: ['dev-current'],
        skippedDeviceIds: [],
        ratchetTree: undefined,
      }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    // Must invite current-user (dm_group_members of dead), not old-user (ancestor)
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'current-user',
      'new-id',
      'dev-current',
      undefined
    );
    expect(mls.sendWelcome).not.toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'old-user',
      expect.any(String),
      'old-dev',
      undefined
    );
  });
});

// ── migrateConversation ───────────────────────────────────────────────────────

describe('migrateConversation', () => {
  it('moves the conversation from the old to the new groupId', async () => {
    const conversations = makeConversations([
      [
        'from-id',
        {
          id: 'from-id',
          name: 'Chat',
          messages: [],
          lifecycle: 'active',
          contactName: 'x',
          mlsStateHex: null,
        },
      ],
    ]);
    const deps = makeDeps({ conversations });

    await migrateConversation('from-id', 'to-id', deps);

    expect(conversations.has('from-id')).toBe(false);
    expect(conversations.has('to-id')).toBe(true);
    expect(conversations.get('to-id')?.name).toBe('Chat');
  });

  it('existing target -> messages still migrated (saveMessages is idempotent)', async () => {
    // Bug A population 2: when the Welcome creates the target conv before
    // checkGroupSuccessors runs, messages from the source must still be copied
    // (otherwise they are destroyed by deleteConversation on the source).
    const messages = [
      {
        id: 'm1',
        conversationId: 'from-id',
        senderId: 'x',
        content: 'hi',
        timestamp: 0,
        readBy: [],
        reactions: [],
      },
    ];
    const storage = {
      getMessages: vi.fn().mockResolvedValue(messages),
      saveMessages: vi.fn().mockResolvedValue(undefined),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
    };
    const conversations = makeConversations([
      [
        'from-id',
        {
          id: 'from-id',
          name: 'Chat',
          messages: [],
          lifecycle: 'active',
          contactName: 'x',
          mlsStateHex: null,
        },
      ],
      [
        'to-id',
        {
          id: 'to-id',
          name: 'To',
          messages: [],
          lifecycle: 'pending',
          contactName: 'y',
          mlsStateHex: null,
        },
      ],
    ]);
    const deps = makeDeps({ conversations, storage });

    await migrateConversation('from-id', 'to-id', deps);

    // Messages are copied even when the target exists (idempotent upsert)
    expect(storage.getMessages).toHaveBeenCalledWith('from-id', 'pin123');
    expect(storage.saveMessages).toHaveBeenCalledTimes(1);
    // Conversation moved correctly
    expect(conversations.has('from-id')).toBe(false);
    expect(conversations.has('to-id')).toBe(true);
  });

  it('double call -> messages copied only once', async () => {
    const storage = {
      getMessages: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          conversationId: 'from-id',
          senderId: 'x',
          content: 'hi',
          timestamp: 0,
          readBy: [],
          reactions: [],
        },
      ]),
      saveMessages: vi.fn().mockResolvedValue(undefined),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
    };
    const conversations = makeConversations([
      [
        'from-id',
        {
          id: 'from-id',
          name: 'Chat',
          messages: [],
          lifecycle: 'active',
          contactName: 'x',
          mlsStateHex: null,
        },
      ],
    ]);
    const deps = makeDeps({ conversations, storage });

    await migrateConversation('from-id', 'to-id', deps);
    // Second call: 'from-id' no longer exists -> noop
    await migrateConversation('from-id', 'to-id', deps);

    expect(storage.saveMessages).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveMlsState)).not.toHaveBeenCalled();
  });
});
