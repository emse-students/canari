vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import { requestReAdd, cancelReAdd, recoverForkedGroup, resetReAddCooldowns } from './recovery';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import { saveMlsState } from '$lib/utils/hex';
import { resetHistoryReconciliation, setHistoryProbeSender } from './historyReconcile';

beforeEach(() => {
  vi.mocked(saveMlsState).mockClear();
  // Reboot deadline / not-ready markers persist in localStorage across tests - reset between cases.
  if (typeof localStorage !== 'undefined') localStorage.clear();
  // The recovery cooldown is module-global - reset it so throttling never leaks between cases.
  resetReAddCooldowns();
  // External-join success reconciles the group; the coalescing window is module-global, so it is
  // reset between cases or the second case in a file would silently skip its ask.
  resetHistoryReconciliation();
  probeSender.mockClear();
  setHistoryProbeSender(probeSender);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Stands in for the session-registered probe sender, which the reconciliation refuses to run without. */
const probeSender = vi.fn().mockResolvedValue(true);

function makeMls(overrides: Record<string, unknown> = {}) {
  return {
    // Default = group alive on server (neither absent nor tombstone).
    getGroupMeta: vi.fn().mockResolvedValue({ groupId: 'mock-group', deletedAt: null }),
    getGroupServerStatus: vi.fn().mockResolvedValue({ groupId: 'mock-group', deletedAt: null }),
    getLocalGroups: vi.fn().mockReturnValue([]),
    sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
    sendHistoryRequest: vi.fn().mockResolvedValue({ noPeerOnline: false }),
    // A reconciliation waits for this device's own inbound queue before asking anybody anything;
    // no case here is about the mailbox, so it is already idle.
    // No distribution group here: `reconcileGroup` asks this before anything else,
    // because a seed carrier has no history to reconcile.
    isDistributionGroup: vi.fn().mockReturnValue(false),
    waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    // Default = external join unavailable, so tests exercise the welcome_request fallback.
    externalJoin: vi.fn().mockResolvedValue(false),
    forgetGroup: vi.fn(),
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
    deviceKeyB64: 'device-key-123',
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
  it('external join success short-circuits the welcome_request fallback', async () => {
    const deps = makeDeps();
    deps.mlsService.externalJoin = vi.fn().mockResolvedValue(true);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1');
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    // External join lands at the current epoch without the peer-driven history bundle, so the
    // group is reconciled. Nothing durable records that: the comparison is cheap enough to re-run
    // on the next connection, and a note written here could not be discharged from anywhere.
    // No exclusion: this is an ordinary trigger, and only a coverage chase has a reason to skip a
    // member it has already heard from.
    expect(deps.mlsService.sendHistoryRequest).toHaveBeenCalledWith('g1', { exclude: [] });
    expect(probeSender).toHaveBeenCalledWith('g1');
    // Not-ready marker cleared on success.
    expect(localStorage.getItem('mls_not_ready_since:user-a:g1')).toBeNull();
  });

  it('falls back to a welcome_request when external join is unavailable, and marks not-ready', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledWith('g1');
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
    // Marked in the persistent registry so the SYNC_WATCHDOG drives the cadence.
    expect(localStorage.getItem('mls_not_ready_since:user-a:g1')).not.toBeNull();
  });

  it('throttles: two immediate calls make a single recovery attempt (cooldown)', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    await requestReAdd('g1', deps, timers);

    // The second call is within RECOVERY_TIMEOUT_MS -> throttled by the internal cooldown.
    expect(deps.mlsService.externalJoin).toHaveBeenCalledTimes(1);
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(1);
  });

  it('already in WASM -> no recovery attempt (caller must forgetGroup first if forked)', async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue(['g1']);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('group confirmed absent from server -> purges the phantom, no recovery', async () => {
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

    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(deps.deleteConversation).toHaveBeenCalledWith('ghost');
    expect(deps.conversations.has('ghost')).toBe(false);
  });

  it('group tombstoned server-side (deletedAt) -> marks the conversation removed, no recovery', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi.fn().mockResolvedValue({ groupId: 'tomb', deletedAt: '2026-01-01' }),
      }),
      conversations: makeConversations([
        ['tomb', { id: 'tomb', name: 'Gone', lifecycle: 'active' }],
      ]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('tomb', deps, timers);

    expect(deps.conversations.get('tomb')?.lifecycle).toBe('removed');
    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  // ── The refusal that used to be a retry ────────────────────────────────────
  //
  // THREE CASES, AND THE LAST TWO ARE WHY THE FIRST ONE IS TRUSTWORTHY. A 403 on the GroupInfo read
  // is the server saying we hold no membership row, which no retry and no peer can change - so it
  // ends the recovery. Before it was typed it arrived as a bare `false`, went to the welcome_request
  // fallback, and came back every minute for as long as the group existed. The negative cases pin
  // the fix from over-reaching: a failure that says NOTHING about membership must still fall back,
  // and a group that simply has no base published yet must still ask a peer.

  it('server refuses the GroupInfo read as a non-member -> retires the conversation and stops', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        externalJoin: vi.fn().mockRejectedValue(new NotAGroupMemberError('left')),
      }),
      conversations: makeConversations([
        ['left', { id: 'left', name: 'A group we are out of', lifecycle: 'active' }],
      ]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('left', deps, timers);

    expect(deps.conversations.get('left')?.lifecycle).toBe('removed');
    // The whole point: nobody is asked to re-add us to a group whose roster refused us.
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    // And the watchdog must stop enumerating it, or the cadence outlives the answer.
    expect(localStorage.getItem('mls_not_ready_since:user-a:left')).toBeNull();
  });

  it('and a second call then does nothing at all - terminated by a proof, not by the throttle', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        externalJoin: vi.fn().mockRejectedValue(new NotAGroupMemberError('left')),
      }),
      conversations: makeConversations([['left', { id: 'left', lifecycle: 'active' }]]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('left', deps, timers);
    // The cooldown is what USED to be the only thing containing this loop, so clearing it is exactly
    // how to tell a real termination from a throttled one: a proof survives the cooldown going away.
    resetReAddCooldowns();
    await requestReAdd('left', deps, timers);

    expect(deps.mlsService.externalJoin).toHaveBeenCalledTimes(1);
    expect(deps.mlsService.getGroupMeta).toHaveBeenCalledTimes(1);
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  it('a failure that says nothing about membership still falls back to a welcome_request', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        externalJoin: vi.fn().mockRejectedValue(new Error('GroupInfo fetch HTTP error: 503')),
      }),
      conversations: makeConversations([['g1', { id: 'g1', lifecycle: 'active' }]]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
    expect(deps.conversations.get('g1')?.lifecycle).toBe('active');
    expect(localStorage.getItem('mls_not_ready_since:user-a:g1')).not.toBeNull();
  });

  it('already-removed conversation -> immediate no-op', async () => {
    const deps = makeDeps({
      conversations: makeConversations([['g1', { id: 'g1', lifecycle: 'removed' }]]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.getGroupMeta).not.toHaveBeenCalled();
    expect(deps.mlsService.externalJoin).not.toHaveBeenCalled();
  });
});

// ── recoverForkedGroup ─────────────────────────────────────────────────────────

describe('recoverForkedGroup', () => {
  it('forgets the forked group at the known minEpoch then re-adds it', async () => {
    const mls = makeMls({ getLocalGroups: vi.fn().mockReturnValue([]) });
    const deps = makeDeps({ mlsService: mls });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await recoverForkedGroup('g-fork', deps, timers, 4);

    // minEpoch rejects a stale re-Welcome from the diverged branch.
    expect(mls.forgetGroup).toHaveBeenCalledWith('g-fork', 4);
    // The forgotten group is no longer local -> requestReAdd attempts recovery (external join first).
    expect(mls.externalJoin).toHaveBeenCalledWith('g-fork');
  });
});

// ── cancelReAdd ────────────────────────────────────────────────────────────────

describe('cancelReAdd', () => {
  it('clears the cooldown so a later desync re-triggers immediately', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(1);

    // Without cancelReAdd a second immediate call would be throttled; cancelling lets it fire again.
    cancelReAdd('g1', timers);
    await requestReAdd('g1', deps, timers);
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(2);
  });
});
