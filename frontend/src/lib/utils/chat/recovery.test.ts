import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import {
  requestReAdd,
  cancelReAdd,
  reboot,
  migrateConversation,
  RECOVERY_TIMEOUT_MS,
  REBOOT_DEADLINE_MS,
} from './recovery';
import { saveMlsState } from '$lib/utils/hex';

beforeEach(() => {
  vi.mocked(saveMlsState).mockClear();
  // Reboot deadline markers persist in localStorage across tests - reset between cases.
  if (typeof localStorage !== 'undefined') localStorage.clear();
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
      commit: new Uint8Array([2]),
      addedDeviceIds: [],
      skippedDeviceIds: [],
      welcome: undefined,
    }),
    sendCommit: vi.fn().mockResolvedValue(undefined),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    acquireAddLock: vi.fn().mockResolvedValue(true),
    releaseAddLock: vi.fn().mockResolvedValue(undefined),
    acquireRebootLock: vi.fn().mockResolvedValue(true),
    releaseRebootLock: vi.fn().mockResolvedValue(undefined),
    getEpoch: vi.fn().mockReturnValue(0),
    getDeviceId: vi.fn().mockReturnValue('self-device'),
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

  it('sends sendWelcomeRequest and arms a timer', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
    expect(timers.has('g1')).toBe(true);
  });

  it('only one timer armed but welcome_request resent on every reconnection', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    await requestReAdd('g1', deps, timers);

    // The welcome_request is resent silently even when the timer is already running
    // (the peer may have come back online since the last attempt).
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(2);
    // But only one timer should be active (no double reboot).
    expect(timers.size).toBe(1);
  });

  it(`after ${RECOVERY_TIMEOUT_MS / 1000}s without Welcome -> resends welcome_request, no reboot (deadline not reached)`, async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue([]); // toujours absent
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    await vi.advanceTimersByTimeAsync(RECOVERY_TIMEOUT_MS);

    // Persistent 1h deadline not reached -> no reboot, just a new welcome_request.
    expect(deps.mlsService.createRemoteGroup).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(2);
  });

  it('reboot only once REBOOT_DEADLINE_MS has elapsed in persistent real time', async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue([]); // toujours absent
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    // Simulates a group not ready for more than 1h (deadline set in a previous session).
    localStorage.setItem(
      'mls_not_ready_since:user-a:g1',
      String(Date.now() - REBOOT_DEADLINE_MS - 1_000)
    );

    await requestReAdd('g1', deps, timers);
    await vi.advanceTimersByTimeAsync(RECOVERY_TIMEOUT_MS);

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
    expect(timers.has('live')).toBe(true);
  });

  it('Welcome received before 60s -> cancelReAdd cancels the timer, no reboot', async () => {
    const deps = makeDeps();
    // At timeout the group is in WASM (Welcome received in the meantime)
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue(['g1']);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    cancelReAdd('g1', timers);

    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();

    // reboot ne doit pas être appelé
    expect(deps.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('group confirmed absent from server -> purges the phantom, no welcome_request or timer', async () => {
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

    // Loop stopped: no welcome_request, no timer armed.
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(timers.has('ghost')).toBe(false);
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

// ── reboot ───────────────────────────────────────────────────────────────────

describe('reboot', () => {
  it('CAS won -> sendCommit then sendWelcome for each member', async () => {
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'other', deviceId: 'dev2' }]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([9]), deviceId: 'dev2' }]),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([2]),
        welcome: new Uint8Array([3]),
        addedDeviceIds: ['dev2'],
        skippedDeviceIds: [],
        ratchetTree: undefined,
      }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    expect(mls.sendCommit).toHaveBeenCalledWith(expect.any(Uint8Array), 'new-id');
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
        commit: new Uint8Array([2]),
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
        commit: new Uint8Array([2]),
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
