// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

/**
 * ADM-2 and ADM-4 (2026-10-25), driven through the SYNC_WATCHDOG itself: a retry the joiner
 * scheduled while its invitation-link ask waited must not fire once discovery has removed the
 * declined row - neither past the cadence nor after a reload, the two conditions both runs met
 * (27 s and 37 s after the removal).
 *
 * Unlike `sessionWatchdogs.test.ts`, the recovery seam and the not-ready registry are REAL here: the
 * defect was the registry outliving the row, so mocking either would assert the mock. Only the
 * session wiring and the server are stubbed.
 */
vi.mock('$lib/utils/hex', () => ({ saveMlsState: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$lib/utils/chat/connection', () => ({ getIsTabLeader: () => true }));
vi.mock('$lib/services/ChannelService', () => ({ ChannelService: class {} }));
vi.mock('$lib/utils/graine/distributionGroup', () => ({
  rejoinBehindDistributionGroup: vi.fn(async () => null),
}));
let deps: Record<string, unknown> & { mlsService: ReturnType<typeof makeMls> };
vi.mock('./sessionAuth', () => ({ makeRecoveryDeps: () => deps }));

const { startSyncWatchdogImpl } = await import('./sessionWatchdogs');
const { requestReAdd, resetReAddCooldowns, RECOVERY_TIMEOUT_MS } =
  await import('$lib/utils/chat/recovery');
const { purgeLocalConversationRecord } = await import('$lib/utils/chat/groupActions');
const { enumerateNotReadyGroups } = await import('$lib/utils/chat/notReadyRegistry');

const GROUP = 'g-asked';
const TICK_MS = 5_000;

/** The joiner's server: the ask awaits a member until `declined` is set, then the seat is gone. */
function makeMls(state: { declined: boolean }) {
  return {
    getGroupMeta: vi.fn().mockResolvedValue({ groupId: GROUP, isGroup: true, deletedAt: null }),
    getGroupServerStatus: vi
      .fn()
      .mockResolvedValue({ groupId: GROUP, isGroup: true, deletedAt: null }),
    getLocalGroups: vi.fn().mockReturnValue([]),
    getDeviceId: vi.fn().mockReturnValue('joiner-device'),
    getDeviceMemberships: vi.fn(async () =>
      state.declined
        ? []
        : [
            {
              id: 'm-1',
              userId: 'joiner',
              deviceId: 'joiner-device',
              groupId: GROUP,
              status: 'pending',
              welcomeQueued: false,
              addInFlight: false,
              awaitingAdmission: true,
            },
          ]
    ),
    getUserGroups: vi.fn(async () =>
      state.declined ? [] : [{ groupId: GROUP, name: 'Club', isGroup: true }]
    ),
    isDistributionGroup: vi.fn().mockReturnValue(false),
    noteDistributionGroup: vi.fn(),
    notifyConversationAvailable: vi.fn(),
    sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
    externalJoin: vi.fn().mockResolvedValue({ joined: false, reason: 'no_base_published' }),
  };
}

/** The joiner's whole sequence up to the removal, then a reload, then the watchdog's first sweep. */
async function declineThenReloadThenSweep(opts: { removeTheRow: 'discovery' | 'row-only' }) {
  const state = { declined: false };
  const conversations = new SvelteMap<string, object>([
    [GROUP, { id: GROUP, lifecycle: 'pending', awaitingAdmission: true }],
  ]);
  deps = {
    mlsService: makeMls(state),
    storage: null,
    userId: 'joiner',
    deviceKey: () => 'k',
    conversations,
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };

  // The waiting pass: it asks a member and arms the persisted marker.
  await requestReAdd(GROUP, deps as never);
  expect(enumerateNotReadyGroups('joiner')).toEqual([GROUP]);

  // A member declines; discovery removes the never-admitted row. The control removes the ROW ONLY
  // and leaves the marker - the pre-fix purge - so the marker alone is what it isolates.
  state.declined = true;
  if (opts.removeTheRow === 'row-only') {
    conversations.delete(GROUP);
  } else {
    await purgeLocalConversationRecord({
      conversations: conversations as never,
      contactKey: GROUP,
      groupId: GROUP,
      userId: 'joiner',
      deleteConversation: deps.deleteConversation as never,
      log: deps.log as never,
    });
  }

  // Past the cadence, then a reload: the in-memory cooldown is gone, the stored marker is not.
  vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS * 2);
  resetReAddCooldowns();
  const ctx = { timers: { syncWatchdog: null } };
  const cb = { conversations, log: vi.fn() };
  startSyncWatchdogImpl(ctx as never, cb as never);
  await vi.advanceTimersByTimeAsync(TICK_MS);
  if (ctx.timers.syncWatchdog !== null) clearInterval(ctx.timers.syncWatchdog);
  return { conversations, mls: deps.mlsService };
}

describe('the SYNC_WATCHDOG after a declined ask (ADM-2, ADM-4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetReAddCooldowns();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires no pass for the declined group: the removal took the marker it would have enumerated', async () => {
    const { conversations, mls } = await declineThenReloadThenSweep({ removeTheRow: 'discovery' });

    // One read, the waiting pass's own; the sweep found nothing to drive.
    expect(mls.getGroupMeta).toHaveBeenCalledTimes(1);
    expect(mls.externalJoin).not.toHaveBeenCalled();
    expect(conversations.size).toBe(0);
    expect(enumerateNotReadyGroups('joiner')).toEqual([]);
  });

  it('control: the row gone but the marker left standing, the same sweep DOES run a pass - so the case above can fail', async () => {
    const { conversations, mls } = await declineThenReloadThenSweep({ removeTheRow: 'row-only' });

    await vi.waitFor(() => expect(mls.getGroupMeta).toHaveBeenCalledTimes(2));
    // ...and that stale pass, the ADM-2 one, now ends on the account's seat: no placeholder, no
    // join, no second ask, and the marker it ran on is gone.
    await vi.waitFor(() => expect(enumerateNotReadyGroups('joiner')).toEqual([]));
    expect(conversations.size).toBe(0);
    expect(mls.externalJoin).not.toHaveBeenCalled();
    expect(mls.sendWelcomeRequest).toHaveBeenCalledTimes(1);
  });
});
