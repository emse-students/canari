// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { SvelteMap } from 'svelte/reactivity';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';
import { ChannelApiError } from '$lib/services/ChannelService';
import { RefreshFailedError, SessionExpiredError, SignOutInProgressError } from '$lib/stores/auth';
import { GraineNotReadyError } from '$lib/utils/graine/runtime';
import { GraineUnknownChannelError } from '$lib/utils/graine/channelSeal';
import { showToast } from '$lib/stores/toast.svelte';
import { DeliveryUnreachableError } from '$lib/mls-client/mlsDeliveryApi';
import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { conformPluginFetch } from '$lib/utils/transportFailure';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { getChannelReactions } from '$lib/stores/reactionStore.svelte';
import { activeReactions } from '$lib/utils/chat/messageReactions';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { resetOwedSalonWrites } from '$lib/utils/chat/salonOwed';

// THE ERROR CLASSES COME FROM THE REAL MODULE, not from the mock. `isRetryableLoadError` decides
// by `instanceof`, and a stand-in class would make every one of those tests pass against a type the
// application never throws - which is the whole failure the prose matching it replaced had.
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  getToken: vi.fn().mockResolvedValue('test-token'),
  refresh: vi.fn().mockRejectedValue(new Error('refresh failed')),
  clearAuth: vi.fn(),
}));

vi.mock('$lib/paraglide/messages', () => ({
  m: {
    channel_action_community_load: vi.fn(() => 'Loading communities'),
    channel_action_message_react: vi.fn(() => 'Reacting'),
    channel_action_channels_reorder: vi.fn(() => 'Reordering channels'),
    channel_action_error_unknown: vi.fn(({ action }: { action: string }) => `${action}: unknown`),
    channel_action_error_session: vi.fn(
      ({ action }: { action: string }) => `${action}: session expired`
    ),
    channel_action_error_permission: vi.fn(
      ({ action, detail }: { action: string; detail: string }) =>
        `${action}: permission denied (${detail})`
    ),
    channel_action_error_network: vi.fn(
      ({ action }: { action: string }) => `${action}: network error`
    ),
    channel_action_error_generic: vi.fn(
      ({ action, detail }: { action: string; detail: string }) => `${action}: ${detail}`
    ),
    chat_system_member_added: vi.fn(() => 'notice'),
    chat_send_error_seal_no_session: vi.fn(() => 'seal: no-session'),
    chat_send_error_seal_unknown_channel: vi.fn(() => 'seal: unknown-channel'),
    chat_send_error_seal_key_group_missing: vi.fn(() => 'seal: key-group-missing'),
    chat_send_error_seal_key_group_unsettled: vi.fn(() => 'seal: key-group-unsettled'),
    chat_send_error_seal_key_group_catching_up: vi.fn(() => 'seal: key-group-catching-up'),
    channel_action_error_conflict: vi.fn(({ action }: { action: string }) => `${action}: conflict`),
    chat_error_follower_tab: vi.fn(() => 'follower-tab'),
  },
}));

vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: vi.fn(),
}));

vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  sendEncryptedChannelMessage: (...args: unknown[]) => sendEncryptedChannelMessage(...args),
  sendChannelReaction: (...args: unknown[]) => sendChannelReaction(...args),
}));
const sendChannelReaction = vi.fn();
const sendEncryptedChannelMessage = vi.fn();

const listUserWorkspaces = vi.fn();
const listChannels = vi.fn();
const createWorkspace = vi.fn();
const createChannel = vi.fn();
const renameChannel = vi.fn();
const reorderChannels = vi.fn();
const inviteToChannel = vi.fn();

// Same reason as the auth mock above: `ChannelApiError` must be the real class, because that is
// what `ChannelService.handleError` throws and what the code under test tests for.
vi.mock('$lib/services/ChannelService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/services/ChannelService')>()),
  ChannelService: class MockChannelService {
    listUserWorkspaces = listUserWorkspaces;
    listChannels = listChannels;
    createWorkspace = createWorkspace;
    createChannel = createChannel;
    renameChannel = renameChannel;
    reorderChannels = reorderChannels;
    inviteToChannel = inviteToChannel;
    // Every listing asks the unread counts at its end; a fake without them logged a TypeError there.
    listUnreadCounts = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn().mockResolvedValue((id: string) => id),
}));

/** The admission this device signs for an invitee (channel-encryption section 25). */
const signDirectAdmission = vi.fn();
vi.mock('$lib/utils/graine/admissionIssue', () => ({
  signDirectAdmission: (...args: unknown[]) => signDirectAdmission(...args),
}));

const ensureCommunityDistributionGroup = vi.fn().mockResolvedValue(true);
vi.mock('$lib/utils/graine/distributionGroup', () => ({
  ensureCommunityDistributionGroup: (...args: unknown[]) =>
    ensureCommunityDistributionGroup(...args),
  // The one entrance a private salon is entered through, at all three moments. Its own contract -
  // that declining is as loud as entering - is driven in `distributionGroup.test.ts`; here it only
  // has to succeed so the walk around it keeps going.
  enterPrivateSalonGroup: vi.fn().mockResolvedValue(true),
}));

const requestCommunityHistory = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/utils/graine/repair', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/graine/repair')>()),
  requestCommunityHistory: (...args: unknown[]) => requestCommunityHistory(...args),
}));

import { useChannelWorkspaces, type ChannelWorkspaceContext } from './useChannelWorkspaces.svelte';
// NOT MOCKED, DELIBERATELY: the channel-to-community map is the fact the send path reads, so the
// test asserting it survives a failed join has to read the real one.
import { workspaceForChannel } from '$lib/utils/graine/runtime';
import {
  beginSalonListing,
  readSalonSendGate,
  resetSalonSendGate,
  salonSendWaiterCount,
  settleSalonListing,
  whenSalonSendable,
} from '$lib/utils/graine/salonSendGate';
import { flushMacrotask } from '../../test/flush';

function makeContext(overrides: Partial<ChannelWorkspaceContext> = {}): ChannelWorkspaceContext {
  return {
    conversations: new SvelteMap<string, any>(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    selectConversation: vi.fn(),
    getSelectedConversationId: () => null,
    reloadChannelHistory: vi.fn().mockResolvedValue(undefined),
    invalidateChannelHistoryCache: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

function makeWorkspaceDto(id: string, name: string, slug: string): WorkspaceDto {
  return {
    _id: id,
    id,
    name,
    slug,
    imageMediaId: null,
    viewerCanManage: false,
    viewerCanModerate: false,
  } as WorkspaceDto;
}

function makeChannelDto(
  id: string,
  name: string,
  visibility: 'public' | 'private' = 'public'
): ChannelDto {
  return {
    _id: id,
    id,
    name,
    visibility,
  } as ChannelDto;
}

function tick() {
  return flushMacrotask();
}

describe('useChannelWorkspaces - loadChannelWorkspacesFromBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listUserWorkspaces.mockReset();
    listChannels.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('updates channelWorkspaces and clears workspacesLoadError on success', async () => {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await promise;

    expect(store.workspacesLoadError).toBeNull();
    expect(store.channelWorkspaces).toHaveLength(1);
    expect(store.channelWorkspaces[0].channels[0].id).toBe('channel_ch1');
  });

  // User report 2026-10-13: a message sent right after opening the app was refused as "not loaded
  // yet". The load is what ENTERS a salon, so it is what releases a send held for it - and its end
  // is what refuses one it did not enter.
  it('releases a send held for a salon the load enters, and refuses one it does not', async () => {
    resetSalonSendGate();
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);
    const listed = whenSalonSendable('channel_ch1');
    const gone = whenSalonSendable('channel_not-listed');

    const store = useChannelWorkspaces();
    const promise = store.loadChannelWorkspacesFromBackend(makeContext());
    await tick();
    await promise;

    expect(await listed).toEqual({ kind: 'ready' });
    expect(await gone).toEqual({ kind: 'refused', reason: 'not-listed' });
  });

  // Production web console 2026-10-12 (v1.2.5): 7 communities walked one after another, 21+
  // requests in a row, 2.87 s before `communities/channels loaded`. They now run side by side.
  it('asks every community for its salons before ANY of them has answered', async () => {
    listUserWorkspaces.mockResolvedValue([
      makeWorkspaceDto('ws1', 'One', 'one'),
      makeWorkspaceDto('ws2', 'Two', 'two'),
      makeWorkspaceDto('ws3', 'Three', 'three'),
    ]);
    const pending = new Map<string, (rows: ChannelDto[]) => void>();
    listChannels.mockImplementation(
      (workspaceId: string) =>
        new Promise<ChannelDto[]>((resolve) => pending.set(workspaceId, resolve))
    );

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();

    // Three listings in flight at once; the serial walk had exactly one here.
    expect(listChannels).toHaveBeenCalledTimes(3);
    // Every community row is already in the sidebar, in the server's order.
    expect(store.channelWorkspaces.map((ws) => ws.id)).toEqual(['one', 'two', 'three']);

    // Answered in REVERSE order: the sidebar order is still the server's.
    pending.get('ws3')!([makeChannelDto('c3', 'trois')]);
    pending.get('ws2')!([makeChannelDto('c2', 'deux')]);
    pending.get('ws1')!([makeChannelDto('c1', 'un')]);
    await promise;

    expect(store.channelWorkspaces.map((ws) => ws.id)).toEqual(['one', 'two', 'three']);
    expect(store.channelWorkspaces.map((ws) => ws.channels.map((c) => c.id))).toEqual([
      ['channel_c1'],
      ['channel_c2'],
      ['channel_c3'],
    ]);
    expect(store.workspacesLoadError).toBeNull();
  });

  it('a community that fails fails the attempt only once every sibling has settled', async () => {
    listUserWorkspaces.mockResolvedValue([
      makeWorkspaceDto('ws1', 'One', 'one'),
      makeWorkspaceDto('ws2', 'Two', 'two'),
    ]);
    let releaseSibling: (rows: ChannelDto[]) => void = () => {};
    listChannels.mockImplementation((workspaceId: string) =>
      workspaceId === 'ws1'
        ? Promise.reject(new SessionExpiredError())
        : new Promise<ChannelDto[]>((resolve) => (releaseSibling = resolve))
    );

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    let settled = false;
    const promise = store.loadChannelWorkspacesFromBackend(ctx).then(() => (settled = true));
    await tick();

    // ws1 has already failed, but ws2 is still loading: no retry may start beside it.
    expect(settled).toBe(false);
    expect(store.isLoadingWorkspaces).toBe(true);

    releaseSibling([makeChannelDto('c2', 'deux')]);
    await promise;
    expect(ctx.log).toHaveBeenCalledWith('[WORKSPACE-LOAD] 1/2 community(ies) failed to load');
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
    expect(store.workspacesLoadError).not.toBeNull();
  });

  it('refreshes a channel already in the sidebar rather than ignoring it (COMM-13)', async () => {
    // THE ADMINISTRATOR JOIN, WHICH THE SERVER COMPLETED AND THE SCREEN NEVER SHOWED. The re-read
    // after `joinPrivateChannelAsAdmin` calls into the sidebar for every channel it just fetched,
    // and an entry already on screen used to be skipped as a duplicate - so the row went on
    // offering "Rejoindre" for the rest of the session while every server route said otherwise.
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([
      { ...makeChannelDto('ch1', 'salon', 'private'), viewerHasAccess: false } as ChannelDto,
    ]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    await store.loadChannelWorkspacesFromBackend(ctx);
    expect(store.channelWorkspaces[0].channels[0].hasAccess).toBe(false);

    // The badge is owned by the live event path and is not part of any reload, so the refresh must
    // not clear it - a blind overwrite would empty every unread count on each re-read.
    store.channelWorkspaces[0].channels[0].unreadCount = 3;

    listChannels.mockResolvedValue([
      { ...makeChannelDto('ch1', 'salon', 'private'), viewerHasAccess: true } as ChannelDto,
    ]);
    await store.loadChannelWorkspacesFromBackend(ctx);

    expect(store.channelWorkspaces[0].channels).toHaveLength(1);
    expect(store.channelWorkspaces[0].channels[0].hasAccess).toBe(true);
    expect(store.channelWorkspaces[0].channels[0].unreadCount).toBe(3);
  });

  it('retries on transient failure and succeeds on second attempt, preserving existing data', async () => {
    listUserWorkspaces
      .mockRejectedValueOnce(new TransportFailureError(new TypeError('Failed to fetch')))
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();

    // Seed existing data
    store.channelWorkspaces = [
      {
        id: 'existing',
        name: 'Existing',
        avatarUserId: 'Existing',
        channels: [{ id: 'channel_old', name: 'old' }],
      } as any,
    ];

    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    await promise;

    expect(store.workspacesLoadError).toBeNull();
    expect(store.channelWorkspaces).toHaveLength(1);
    expect(store.channelWorkspaces[0].id).toBe('community');
    expect(listUserWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('sets workspacesLoadError and preserves channelWorkspaces after 3 retryable failures', async () => {
    listUserWorkspaces.mockRejectedValue(
      new TransportFailureError(new TypeError('Network failure'))
    );

    const store = useChannelWorkspaces();
    const ctx = makeContext();

    const seeded = [
      {
        id: 'seeded',
        name: 'Seeded',
        avatarUserId: 'Seeded',
        channels: [{ id: 'channel_seed', name: 'seed' }],
      } as any,
    ];
    store.channelWorkspaces = seeded;

    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
    await tick();
    await promise;

    expect(store.workspacesLoadError).not.toBeNull();
    expect(store.channelWorkspaces).toHaveLength(1);
    expect(store.channelWorkspaces[0].id).toBe('seeded');
    expect(listUserWorkspaces).toHaveBeenCalledTimes(4);
  });

  it('does not retry on 401/403 and sets workspacesLoadError', async () => {
    // THE ERROR THE SERVICE ACTUALLY THROWS. This used to be a bare `Error` whose message was a
    // JSON envelope, which `ChannelService` has never produced - it throws `ChannelApiError`. The
    // test passed because the code under test re-parsed that message; both were reading a shape
    // nothing writes, and the test could not have caught the status being read wrongly.
    listUserWorkspaces.mockRejectedValue(
      new ChannelApiError(401, null, JSON.stringify({ statusCode: 401, message: 'Unauthorized' }))
    );

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await promise;

    expect(store.workspacesLoadError).not.toBeNull();
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('non-retryable'));
  });

  /**
   * THE CASE THE WORD LIST GOT WRONG IN BOTH DIRECTIONS.
   *
   * Retryability was decided by looking for `fetch`, `network`, `timeout`, `abort` or
   * `err_internet_disconnected` in the message, and then by hunting any three-digit number in it
   * for a status. A 403 is a decision - the server has ruled on this device and will rule the same
   * way again - but a 403 whose body explains that the community is unreachable over the network
   * was read as transient and asked three more times; and a 502 whose body says only
   * `Bad Gateway` was retried because the words `API Error 502` happen to contain digits, not
   * because anyone classified it.
   *
   * Both are now decided by `ChannelApiError.status`, which the throw has been carrying all along.
   */
  it('reads the status off the error, not words out of its body', async () => {
    listUserWorkspaces.mockRejectedValue(
      new ChannelApiError(403, null, 'Network policy: this community is not reachable from here')
    );

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await promise;

    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('non-retryable'));
  });

  it('retries a Bad Gateway whose body carries no digits at all', async () => {
    listUserWorkspaces
      .mockRejectedValueOnce(new ChannelApiError(502, null, 'Bad Gateway'))
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    await promise;

    expect(store.workspacesLoadError).toBeNull();
    expect(listUserWorkspaces).toHaveBeenCalledTimes(2);
  });

  /**
   * A refresh that answered 502 is not a dead session, and the load path must keep asking.
   *
   * `apiFetch` used to flatten every refresh failure into one French sentence, so this arrived
   * carrying neither a status nor a type and was given up on at the first attempt - during a
   * deploy, which is exactly when the sidebar empties and stays empty.
   */
  it('retries a refresh that failed for a transient reason', async () => {
    listUserWorkspaces
      .mockRejectedValueOnce(new RefreshFailedError(502))
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    await promise;

    expect(store.workspacesLoadError).toBeNull();
    expect(listUserWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('gives up at once on a dead session and reports it as one', async () => {
    listUserWorkspaces.mockRejectedValue(new SessionExpiredError());

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await promise;

    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
    // Not the generic arm: the session message, chosen from the TYPE, since a `SessionExpiredError`
    // carries no HTTP status of its own.
    expect(store.workspacesLoadError).toContain('session expired');
  });

  it('returns false and does not issue a second request while a load is already in flight', async () => {
    const store = useChannelWorkspaces();
    const ctx = makeContext();

    // Start a load that will never resolve, then synchronously issue a second call.
    // Because `isLoadingWorkspaces` is set before the first `await`, the second call
    // must hit the guard and return `false` without any network request.
    listUserWorkspaces.mockImplementationOnce(() => new Promise(() => {}));

    // The first load never settles, so it is deliberately left dangling.
    void store.loadChannelWorkspacesFromBackend(ctx);

    await expect(store.loadChannelWorkspacesFromBackend(ctx)).resolves.toBe(false);
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
  });
});

describe('useChannelWorkspaces - online/foreground refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listUserWorkspaces.mockReset();
    listChannels.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reloads workspaces when load error exists and refresh is triggered externally', async () => {
    listUserWorkspaces
      .mockRejectedValueOnce(new TransportFailureError(new TypeError('Offline')))
      .mockRejectedValueOnce(new TransportFailureError(new TypeError('Offline')))
      .mockRejectedValueOnce(new TransportFailureError(new TypeError('Offline')))
      .mockRejectedValueOnce(new TransportFailureError(new TypeError('Offline')))
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();

    // First load fails and exhausts retries
    const first = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
    await tick();
    await first;
    expect(store.workspacesLoadError).not.toBeNull();

    // Simulate online/foreground handler: re-invoke when an error is present
    const retry = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await retry;

    expect(store.workspacesLoadError).toBeNull();
    expect(store.channelWorkspaces[0].id).toBe('community');
  });

  /**
   * THE MI 9T READING OF `v1.2.7-alpha.1` (2026-10-14). After an offline start, the `online` event's
   * listing was rejected by Tauri `plugin-http` with the bare string `error sending request for url
   * (...)`, which was neither a TypeError nor a DeliveryUnreachableError, and gave up as
   * `non-retryable`: 2.5 min online with an empty community rail and every salon send refused.
   * The failure is built by the real wrapper the app installs, so the test reads the shape the
   * phone produced.
   */
  async function tauriNetworkFailure(): Promise<unknown> {
    const plugin = vi
      .fn()
      .mockRejectedValue(
        'error sending request for url (https://canari.emse.fr/api/channels/workspaces/user/me)'
      );
    return conformPluginFetch(plugin)(
      'https://canari.emse.fr/api/channels/workspaces/user/me'
    ).catch((e: unknown) => e);
  }

  it("retries the Tauri plugin's network failure instead of giving up as non-retryable", async () => {
    listUserWorkspaces
      .mockRejectedValueOnce(await tauriNetworkFailure())
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const promise = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    await promise;

    expect(ctx.log).not.toHaveBeenCalledWith(expect.stringContaining('non-retryable'));
    expect(listUserWorkspaces).toHaveBeenCalledTimes(2);
    expect(store.workspacesLoadError).toBeNull();
  });

  it('a listing that reached nobody HOLDS salon sends, and the reconnect lists again and releases them', async () => {
    resetSalonSendGate();
    const failure = await tauriNetworkFailure();
    listUserWorkspaces
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);
    const held = whenSalonSendable('channel_ch1');

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const first = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
    await tick();
    await first;

    // Gave up - but on the link, not on an answer: the send is still held, not refused.
    expect(store.workspacesLoadError).not.toBeNull();
    expect(readSalonSendGate('channel_ch1')).toEqual({ kind: 'wait' });
    expect(salonSendWaiterCount('channel_ch1')).toBe(1);

    // The reconnect (`connectivity.onReconnect` in ChatBackgroundService) lists again.
    store.retryFailedListing(ctx, 'reconnect');
    await vi.waitFor(() => expect(store.workspacesLoadError).toBeNull());
    expect(await held).toEqual({ kind: 'ready' });
    expect(listUserWorkspaces).toHaveBeenCalledTimes(5);
  });

  it('a reconnect DURING a listing that then gives up is owed one more listing', async () => {
    resetSalonSendGate();
    const failure = await tauriNetworkFailure();
    listUserWorkspaces
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    const first = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    // Not doubled: the listing in flight is still the only one.
    store.retryFailedListing(ctx, 'reconnect');
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
    await first;
    await vi.waitFor(() => expect(store.workspacesLoadError).toBeNull());
    expect(listUserWorkspaces).toHaveBeenCalledTimes(5);
    expect(store.channelWorkspaces[0].id).toBe('community');
  });

  it('a listing the server FAILED still refuses the held sends - an answer is a decision', async () => {
    resetSalonSendGate();
    listUserWorkspaces.mockRejectedValue(new ChannelApiError(403, null, 'Forbidden'));
    const held = whenSalonSendable('channel_ch1');

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    await store.loadChannelWorkspacesFromBackend(ctx);

    expect(await held).toEqual({ kind: 'refused', reason: 'listing-failed' });
  });

  it('the reconnect does nothing when the last listing answered', async () => {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext();
    await store.loadChannelWorkspacesFromBackend(ctx);
    store.retryFailedListing(ctx, 'reconnect');

    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
  });

  // THE BOUND (review of #1843). A reconnect is any answer after a transport failure, so an endpoint
  // that keeps failing while other calls answer would cycle for ever: give up -> unreachable -> a
  // probe answers -> reconnect -> list again. One reconnect retry per give-up, none for the give-up
  // of a reconnect's own listing.
  it('a persistently failing listing stops after ONE reconnect retry, however many reconnects follow', async () => {
    resetSalonSendGate();
    listUserWorkspaces.mockRejectedValue(await tauriNetworkFailure());
    const store = useChannelWorkspaces();
    const ctx = makeContext();

    const first = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
    await first;
    expect(listUserWorkspaces).toHaveBeenCalledTimes(4);

    for (let reconnect = 0; reconnect < 5; reconnect++) {
      store.retryFailedListing(ctx, 'reconnect');
      await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
      await vi.waitFor(() => expect(store.isLoadingWorkspaces).toBe(false));
    }

    // The first listing (4 attempts) and its ONE reconnect retry (4 attempts) - and nothing more.
    expect(listUserWorkspaces).toHaveBeenCalledTimes(8);
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining('NOT listing again: this give-up already had its one reconnect retry')
    );
    // The foreground - the member's return - still lists again, and earns a new reconnect retry.
    store.retryFailedListing(ctx, 'foreground');
    await vi.advanceTimersByTimeAsync(1_000 + 3_000 + 7_000);
    await vi.waitFor(() => expect(store.isLoadingWorkspaces).toBe(false));
    expect(listUserWorkspaces).toHaveBeenCalledTimes(12);
  });

  it("owes nothing to a reconnect that lands while the listing's own request is on the wire", async () => {
    resetSalonSendGate();
    let fail: (e: unknown) => void = () => {};
    listUserWorkspaces.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const store = useChannelWorkspaces();
    const ctx = makeContext();

    const first = store.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    // The listing's request is in flight: this reconnect may be its own answer.
    store.retryFailedListing(ctx, 'reconnect');
    fail(new ChannelApiError(403, null, 'Forbidden'));
    await first;
    await tick();

    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('nothing owed'));
  });

  // A ROLE CHANGE PUSHED TO THE PERSON IT IS ABOUT, applied without a round trip.
  //
  // Measured on prod 2026-08-20 (COMM-5) before the push existed: the answer arrived on the next
  // full load and not before, so a DEMOTED administrator kept every control they had just lost for
  // as long as their tab stayed open. The value is applied from the event rather than refetched
  // because a refetch can fail, can be declined while a load is in flight, and lands whenever the
  // network allows - and what it would return is exactly what the event already carries.
  it('applies a pushed role change to the community it names, and to no other', async () => {
    listUserWorkspaces.mockResolvedValue([
      makeWorkspaceDto('ws1', 'One', 'one'),
      makeWorkspaceDto('ws2', 'Two', 'two'),
    ]);
    listChannels.mockResolvedValue([]);

    const store = useChannelWorkspaces();
    const promise = store.loadChannelWorkspacesFromBackend(makeContext());
    await tick();
    await promise;

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws1',
      roleName: 'Administrateur',
      canManage: true,
      permissions: ['workspace.manage'],
    });

    const byId = (id: string) => store.channelWorkspaces.find((w) => w.workspaceDbId === id);
    expect(byId('ws1')?.viewerCanManage).toBe(true);
    expect(byId('ws2')?.viewerCanManage).toBe(false);
  });

  it('takes the capability AWAY on a demotion, which is the direction that matters', async () => {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([]);

    const store = useChannelWorkspaces();
    const promise = store.loadChannelWorkspacesFromBackend(makeContext());
    await tick();
    await promise;

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws1',
      roleName: 'Administrateur',
      canManage: true,
      permissions: ['workspace.manage'],
    });
    expect(store.channelWorkspaces[0].viewerCanManage).toBe(true);

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws1',
      roleName: 'Membre',
      canManage: false,
      permissions: [],
    });
    expect(store.channelWorkspaces[0].viewerCanManage).toBe(false);
  });

  // The salon settings panel reads this flag. It moves with the event when the server sends it, and
  // an older server that does not send it must not be read as a demotion.
  it('applies canManageChannels from the event, and leaves it alone when the event omits it', async () => {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([]);

    const store = useChannelWorkspaces();
    const promise = store.loadChannelWorkspacesFromBackend(makeContext());
    await tick();
    await promise;

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws1',
      roleName: 'Gestion des salons',
      canManage: false,
      canManageChannels: true,
      permissions: ['channel.manage'],
    });
    expect(store.channelWorkspaces[0].viewerCanManageChannels).toBe(true);

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws1',
      roleName: 'Gestion des salons',
      canManage: false,
      permissions: ['channel.manage'],
    });
    expect(store.channelWorkspaces[0].viewerCanManageChannels).toBe(true);

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws1',
      roleName: 'Membre',
      canManage: false,
      canManageChannels: false,
      permissions: [],
    });
    expect(store.channelWorkspaces[0].viewerCanManageChannels).toBe(false);
  });

  // The pin and delete affordances on OTHER members' messages follow this flag. A moderator demoted
  // to Membre kept them until a reload when the event did not carry it (2026-10-05).
  it('applies canModerate from the event, and leaves it alone when the event omits it', async () => {
    listUserWorkspaces.mockResolvedValue([
      { ...makeWorkspaceDto('ws1', 'One', 'one'), viewerCanModerate: true },
    ]);
    listChannels.mockResolvedValue([]);

    const store = useChannelWorkspaces();
    const promise = store.loadChannelWorkspacesFromBackend(makeContext());
    await tick();
    await promise;
    expect(store.channelWorkspaces[0].viewerCanModerate).toBe(true);

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws1',
      roleName: 'Modérateur',
      canManage: false,
      permissions: ['channel.moderate'],
    });
    expect(store.channelWorkspaces[0].viewerCanModerate).toBe(true);

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws1',
      roleName: 'Membre',
      canManage: false,
      canManageChannels: false,
      canModerate: false,
      permissions: [],
    });
    expect(store.channelWorkspaces[0].viewerCanModerate).toBe(false);
  });

  // An event for a community this device does not hold must change nothing at all - not throw, and
  // not create a phantom entry in the sidebar.
  it('ignores a role change for a community it does not have', async () => {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([]);

    const store = useChannelWorkspaces();
    const promise = store.loadChannelWorkspacesFromBackend(makeContext());
    await tick();
    await promise;

    store.handleWorkspaceRoleChanged({
      workspaceId: 'ws-elsewhere',
      roleName: 'Administrateur',
      canManage: true,
      permissions: ['workspace.manage'],
    });

    expect(store.channelWorkspaces).toHaveLength(1);
    expect(store.channelWorkspaces[0].viewerCanManage).toBe(false);
  });
});

describe('useChannelWorkspaces - createNewCommunity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureCommunityDistributionGroup.mockResolvedValue(true);
  });

  /**
   * The creator posts in the community it just made, BEFORE anything reloads - so the group has to
   * exist by then. Until 2026-08-20 only the workspace LOAD and the creation of a PRIVATE salon
   * ensured it, and the first message in a brand-new community was refused with "community <id> has
   * no distribution group on this device". COMM-1 caught it; this keeps it caught.
   */
  it('prepares the community distribution group as part of creating the community', async () => {
    createWorkspace.mockResolvedValue(makeWorkspaceDto('ws-new', 'Nouvelle', 'nouvelle'));
    listChannels.mockResolvedValue([makeChannelDto('chan-general', 'general')]);

    const mls = { marker: 'the-mls-service' };
    const ctx = makeContext({ ensureMls: vi.fn().mockResolvedValue(mls) } as never);
    const api = useChannelWorkspaces();

    await api.createNewCommunity('Nouvelle', ctx);

    expect(ensureCommunityDistributionGroup).toHaveBeenCalledTimes(1);
    expect(ensureCommunityDistributionGroup.mock.calls[0][0]).toBe(mls);
    expect(ensureCommunityDistributionGroup.mock.calls[0][2]).toBe('ws-new');
  });

  /**
   * BEFORE THE CHANNELS ARE LISTED, for the reason the load path gives: a seed frame arriving on a
   * group this device has not registered is answered as an unknown conversation. Order is the whole
   * point of where the call sits, so it is asserted rather than left to the diff.
   */
  it('registers the group before it lists the channels', async () => {
    const order: string[] = [];
    createWorkspace.mockResolvedValue(makeWorkspaceDto('ws-order', 'Ordre', 'ordre'));
    ensureCommunityDistributionGroup.mockImplementation(async () => {
      order.push('ensure');
      return true;
    });
    listChannels.mockImplementation(async () => {
      order.push('listChannels');
      return [];
    });

    const ctx = makeContext({ ensureMls: vi.fn().mockResolvedValue({}) } as never);
    await useChannelWorkspaces().createNewCommunity('Ordre', ctx);

    expect(order).toEqual(['ensure', 'listChannels']);
  });

  /**
   * NEVER FATAL. A community that fails to prepare must still reach the sidebar - the salons then
   * refuse to send with a named cause, instead of the community itself vanishing.
   */
  it('still creates the community when the group cannot be prepared', async () => {
    createWorkspace.mockResolvedValue(makeWorkspaceDto('ws-soft', 'Souple', 'souple'));
    listChannels.mockResolvedValue([]);
    ensureCommunityDistributionGroup.mockResolvedValue(false);

    const ctx = makeContext({ ensureMls: vi.fn().mockResolvedValue({}) } as never);
    const api = useChannelWorkspaces();
    await api.createNewCommunity('Souple', ctx);

    expect(api.channelWorkspaces.some((w) => w.workspaceDbId === 'ws-soft')).toBe(true);
  });
});

describe('useChannelWorkspaces - a listing that predates a creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listUserWorkspaces.mockReset();
    listChannels.mockReset();
    ensureCommunityDistributionGroup.mockResolvedValue(true);
  });

  /**
   * THE PRUNE IS THE DANGEROUS HALF OF THE LOAD. Between the listing going out and the deletion of
   * everything it did not mention, the load awaits an MLS group join and a channel listing per
   * community - seconds on a real account. A community created in that window is absent from an
   * answer that was already on its way, and until 2026-08-20 it was deleted for it: measured on
   * production, the community vanished from the sidebar 1.5 s after it was created and the app
   * dropped the user into an unrelated one. Every gesture afterwards went to the wrong community.
   */
  it('keeps a community created while a workspace listing was in flight', async () => {
    let releaseListing: (value: WorkspaceDto[]) => void = () => {};
    listUserWorkspaces.mockImplementationOnce(
      () =>
        new Promise<WorkspaceDto[]>((resolve) => {
          releaseListing = resolve;
        })
    );
    listChannels.mockResolvedValue([]);
    createWorkspace.mockResolvedValue(makeWorkspaceDto('ws-late', 'Tardive', 'tardive'));

    const ctx = makeContext({ ensureMls: vi.fn().mockResolvedValue({}) } as never);
    const api = useChannelWorkspaces();

    const loading = api.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await api.createNewCommunity('Tardive', ctx);
    releaseListing([]);
    await loading;

    expect(api.channelWorkspaces.some((w) => w.id === 'tardive')).toBe(true);
  });

  /**
   * THE NEGATIVE CONTROL, without which the line above is satisfied by a load that prunes nothing.
   * A community that existed when the listing was requested and is missing from the answer really
   * was deleted, and must go.
   */
  it('still prunes a community the server no longer lists', async () => {
    listChannels.mockResolvedValue([]);
    const api = useChannelWorkspaces();
    const ctx = makeContext();

    listUserWorkspaces.mockResolvedValueOnce([makeWorkspaceDto('ws-gone', 'Partie', 'partie')]);
    await api.loadChannelWorkspacesFromBackend(ctx);
    expect(api.channelWorkspaces.some((w) => w.id === 'partie')).toBe(true);

    listUserWorkspaces.mockResolvedValueOnce([]);
    await api.loadChannelWorkspacesFromBackend(ctx);
    expect(api.channelWorkspaces.some((w) => w.id === 'partie')).toBe(false);
  });
});

/**
 * A SALON JOINED IN-SESSION AND THE GROUP ITS SEEDS TRAVEL ON.
 *
 * `registerJoinedChannel` is the in-session sibling of the per-workspace body of
 * `executeWorkspaceLoadAttempt`, reached from the real-time `channel.member.joined` event. The walk
 * at startup does three things per community, and this path used to do two: it mapped the channel
 * to its community and it entered a PRIVATE salon's own group, and it never entered the COMMUNITY's
 * key-distribution group - the one a PUBLIC salon's seeds travel on.
 *
 * Measured on the local estate 2026-09-21: the peer was invited, its community appeared in its
 * sidebar, `#general` opened - and the server logged `[SEND] No message queued after validation -
 * recipients=0 - the group named no other device` for the seed the owner distributed seconds later.
 * The roster held one device until the peer's app was RELOADED, at which point the startup walk ran
 * and the join landed in 1 s. So every seed minted in between reached everyone except the person
 * who had just been added, and the salon read `nouveau message` for all of them.
 */
describe('useChannelWorkspaces - a salon joined in-session enters the group its seeds travel on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureCommunityDistributionGroup.mockResolvedValue(true);
  });

  it("enters the COMMUNITY's distribution group for a public salon", async () => {
    const api = useChannelWorkspaces();
    const ensureMls = vi.fn().mockResolvedValue({});
    const log = vi.fn();

    await api.registerJoinedChannel('ch-public', 'ws1', false, ensureMls, log);

    // THE ARGUMENTS MATTER AS MUCH AS THE CALL: the scope is the COMMUNITY, not the channel, and
    // the log is the session's - the same one every other GRAINE line lands in.
    expect(ensureCommunityDistributionGroup).toHaveBeenCalledTimes(1);
    expect(ensureCommunityDistributionGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'ws1',
      log
    );
  });

  /**
   * A PRIVATE SALON NEEDS BOTH, and that is not a redundancy. Its own seeds travel on its own
   * group, and the community's group is still what carries every public salon of the same
   * community - including the ones this device may join later in the same session.
   */
  it("enters the community's group for a private salon too, beside the salon's own", async () => {
    const api = useChannelWorkspaces();
    const ensureMls = vi.fn().mockResolvedValue({});

    await api.registerJoinedChannel('ch-private', 'ws1', true, ensureMls, vi.fn());

    expect(ensureCommunityDistributionGroup).toHaveBeenCalledTimes(1);
  });

  /**
   * NO MLS CLIENT IS NOT A JOIN WITH NO CLIENT. The startup walk guards the same call the same way;
   * a call with an undefined service would throw inside the join and lose the channel-to-community
   * mapping this function's first line just wrote.
   */
  it('does not reach for the group when this load has no MLS client', async () => {
    const api = useChannelWorkspaces();

    await api.registerJoinedChannel('ch-public', 'ws1', false, undefined, vi.fn());

    expect(ensureCommunityDistributionGroup).not.toHaveBeenCalled();
  });

  /**
   * THE MAPPING IS WRITTEN BEFORE THE JOIN, AND A FAILED JOIN STAYS VISIBLE.
   *
   * Two statements in one case, because they are the same ordering. The map is what the send path
   * reads, so losing it would refuse the first message with `GraineUnknownChannelError` on top of
   * the blind seed - two failures from one cause. And the rejection is NOT caught here: the one
   * caller (`onChannelMemberJoined`) already logs it as `[GRAINE] could not prepare joined channel`,
   * and a `try` added here would make that line unreachable and the failure silent.
   */
  it('maps the channel before the join, and lets a failed join be seen', async () => {
    ensureCommunityDistributionGroup.mockRejectedValueOnce(new Error('group-info refused'));
    const api = useChannelWorkspaces();

    await expect(
      api.registerJoinedChannel('ch-public', 'ws1', false, vi.fn().mockResolvedValue({}), vi.fn())
    ).rejects.toThrow('group-info refused');

    expect(workspaceForChannel('ch-public')).toBe('ws1');
  });

  /**
   * A FOLLOWER TAB MAY NOT ENTER THE GROUP (`FollowerTabCommitError`, from `createGroup` or
   * `externalJoin`): the join of the salon still completes, and the member is told the main tab is
   * where it happens - not a failed join, and not silence.
   */
  it('tells the member, and completes the join, when a follower tab may not enter the group', async () => {
    vi.mocked(showToast).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ensureCommunityDistributionGroup.mockRejectedValueOnce(new FollowerTabCommitError('kg-1'));
    const api = useChannelWorkspaces();

    await api.registerJoinedChannel(
      'ch-public',
      'ws1',
      false,
      vi.fn().mockResolvedValue({}),
      vi.fn()
    );

    expect(workspaceForChannel('ch-public')).toBe('ws1');
    expect(showToast).toHaveBeenCalledExactlyOnceWith('follower-tab');
  });

  /**
   * THE EVENT DRAWS THE SALON BEFORE THE JOINS END. A send typed in that window, after the last
   * listing settled without the salon, used to be refused as `not-listed`: it waits for the entry.
   */
  it('holds a send typed while the salon is being entered, then releases it', async () => {
    resetSalonSendGate();
    settleSalonListing(beginSalonListing(), 'loaded');
    let releaseJoin: (value: boolean) => void = () => {};
    ensureCommunityDistributionGroup.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (releaseJoin = resolve))
    );
    const api = useChannelWorkspaces();

    const entering = api.registerJoinedChannel(
      'ch-public',
      'ws1',
      false,
      vi.fn().mockResolvedValue({}),
      vi.fn()
    );
    const held = whenSalonSendable('channel_ch-public');
    await tick();
    expect(salonSendWaiterCount('ch-public')).toBe(1);

    releaseJoin(true);
    await entering;
    expect(await held).toEqual({ kind: 'ready' });
  });
});

/**
 * A COMMUNITY JOINED IN-SESSION LISTS EVERY SALON THE MEMBER MAY READ (measured 2026-10-08, UNR-11).
 *
 * Accepting an invitation link makes the server publish ONE `channel.member.joined`, for one
 * representative public salon. Handled alone it left the sidebar with that salon and every message
 * in the others "received for an unknown channel" until a reload.
 */
describe('useChannelWorkspaces - hydrateJoinedCommunity', () => {
  const event = { workspaceId: 'ws-new', workspaceSlug: 'unr-11', workspaceName: 'UNR-11' };

  beforeEach(() => {
    listUserWorkspaces.mockReset();
    listChannels.mockReset();
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws-new', 'UNR-11', 'unr-11')]);
    listChannels.mockResolvedValue([
      makeChannelDto('c1', 'general'),
      makeChannelDto('c2', 'salon-a'),
      makeChannelDto('c3', 'salon-b'),
    ]);
  });

  it('knows a community by its first sight only', () => {
    const api = useChannelWorkspaces();
    expect(api.isCommunityUnknownToEvent(event)).toBe(true);
    api.ensureWorkspaceForChannelEvent(event);
    expect(api.isCommunityUnknownToEvent(event)).toBe(false);
  });

  it('gives the community every salon, with a conversation row each, in ONE listing', async () => {
    const api = useChannelWorkspaces();
    const ctx = makeContext();
    api.ensureWorkspaceForChannelEvent(event);
    api.addChannelToWorkspace('unr-11', { id: 'channel_c1', name: 'general' });

    await api.hydrateJoinedCommunity(ctx);

    const ws = api.channelWorkspaces.find((w) => w.id === 'unr-11');
    expect(ws?.channels.map((c) => c.id)).toEqual(['channel_c1', 'channel_c2', 'channel_c3']);
    expect([...ctx.conversations.keys()].sort()).toEqual([
      'channel_c1',
      'channel_c2',
      'channel_c3',
    ]);
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('owes the join one more listing when one was already in flight', async () => {
    let releaseFirst: (value: WorkspaceDto[]) => void = () => {};
    listUserWorkspaces.mockReset();
    listUserWorkspaces.mockImplementationOnce(
      () =>
        new Promise<WorkspaceDto[]>((resolve) => {
          releaseFirst = resolve;
        })
    );
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws-new', 'UNR-11', 'unr-11')]);
    const api = useChannelWorkspaces();
    const ctx = makeContext();

    resetSalonSendGate();
    const startup = api.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await api.hydrateJoinedCommunity(ctx);
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
    // A send typed into a salon only the OWED listing knows waits through the first one's end.
    const held = whenSalonSendable('channel_c2');

    // The startup answer predates the join: it knows no community, and the owed listing does.
    releaseFirst([]);
    await startup;
    expect(await held).toEqual({ kind: 'ready' });
    await vi.waitFor(() =>
      expect(api.channelWorkspaces.find((w) => w.id === 'unr-11')?.channels).toHaveLength(3)
    );
    expect(listUserWorkspaces).toHaveBeenCalledTimes(2);
  });
});

/**
 * A LISTING BELONGS TO ITS SESSION. `globalChannels` is a singleton: a listing still running when
 * its account signs out used to keep `isLoadingWorkspaces` against the next account (whose
 * post-login listing was refused, so its salon sends stayed `pending` for good behind the send
 * gate) and to write the previous account's communities into the sidebar, the runtime and the gate.
 */
describe('useChannelWorkspaces - a listing that outlives its session', () => {
  beforeEach(() => {
    listUserWorkspaces.mockReset();
    listChannels.mockReset();
    resetSalonSendGate();
  });

  it('lets the next account list and send, and writes nothing of the account that left', async () => {
    let releaseOld: (value: WorkspaceDto[]) => void = () => {};
    listUserWorkspaces.mockImplementationOnce(
      () => new Promise<WorkspaceDto[]>((resolve) => (releaseOld = resolve))
    );
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws-b', 'Bravo', 'bravo')]);
    listChannels.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'ws-b'
        ? [makeChannelDto('salon-b', 'general')]
        : [makeChannelDto('salon-a', 'general')]
    );
    const api = useChannelWorkspaces();
    const ctx = makeContext();

    // Account A's post-login listing is in flight when A signs out.
    const oldListing = api.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    resetSalonSendGate();

    // Account B signs in: its listing RUNS, and a send typed meanwhile waits for it.
    const held = whenSalonSendable('channel_salon-b');
    expect(await api.loadChannelWorkspacesFromBackend(ctx)).toBe(true);
    expect(listUserWorkspaces).toHaveBeenCalledTimes(2);
    expect(await held).toEqual({ kind: 'ready' });

    // A's answer lands afterwards: nothing of it is written, and B's state is left alone.
    releaseOld([makeWorkspaceDto('ws-a', 'Alpha', 'alpha')]);
    expect(await oldListing).toBe(false);
    expect(api.channelWorkspaces.map((w) => w.id)).toEqual(['bravo']);
    expect(workspaceForChannel('salon-a')).toBeNull();
    expect(readSalonSendGate('channel_salon-a')).toEqual({
      kind: 'refused',
      reason: 'not-listed',
    });
    expect(api.workspacesLoadError).toBeNull();
    expect(api.isLoadingWorkspaces).toBe(false);
  });

  it('does not hand the next session a superseded listing flag', async () => {
    let releaseOld: (value: WorkspaceDto[]) => void = () => {};
    let releaseNew: (value: WorkspaceDto[]) => void = () => {};
    listUserWorkspaces
      .mockImplementationOnce(() => new Promise<WorkspaceDto[]>((r) => (releaseOld = r)))
      .mockImplementationOnce(() => new Promise<WorkspaceDto[]>((r) => (releaseNew = r)));
    listChannels.mockResolvedValue([]);
    const api = useChannelWorkspaces();
    const ctx = makeContext();

    const oldListing = api.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    resetSalonSendGate();
    const newListing = api.loadChannelWorkspacesFromBackend(ctx);
    await tick();

    // The old one ends first: the flag is the new listing's, so a third call is still refused.
    releaseOld([]);
    expect(await oldListing).toBe(false);
    expect(api.isLoadingWorkspaces).toBe(true);
    expect(await api.loadChannelWorkspacesFromBackend(ctx)).toBe(false);

    releaseNew([]);
    expect(await newListing).toBe(true);
    expect(api.isLoadingWorkspaces).toBe(false);
  });

  it("drops the reload a join owed the listing once that join's session signed out", async () => {
    let releaseOld: (value: WorkspaceDto[]) => void = () => {};
    listUserWorkspaces.mockImplementationOnce(
      () => new Promise<WorkspaceDto[]>((resolve) => (releaseOld = resolve))
    );
    listUserWorkspaces.mockResolvedValue([]);
    const api = useChannelWorkspaces();
    const ctx = makeContext();

    const oldListing = api.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    await api.hydrateJoinedCommunity(ctx);
    resetSalonSendGate();
    releaseOld([]);
    await oldListing;
    // The next account's own listing ends without paying the leaving account's owed reload.
    expect(await api.loadChannelWorkspacesFromBackend(ctx)).toBe(true);
    await tick();

    expect(listUserWorkspaces).toHaveBeenCalledTimes(2);
    expect(api.isLoadingWorkspaces).toBe(false);
  });

  it('records no failure for the next session when the old listing fails after the sign-out', async () => {
    let failOld: (error: unknown) => void = () => {};
    listUserWorkspaces.mockImplementationOnce(
      () => new Promise<WorkspaceDto[]>((_, reject) => (failOld = reject))
    );
    const api = useChannelWorkspaces();
    const ctx = makeContext();

    const oldListing = api.loadChannelWorkspacesFromBackend(ctx);
    await tick();
    resetSalonSendGate();
    failOld(new SessionExpiredError());

    expect(await oldListing).toBe(false);
    expect(api.workspacesLoadError).toBeNull();
    expect(api.isLoadingWorkspaces).toBe(false);
  });
});

describe('useChannelWorkspaces - salon names and order', () => {
  const FREE_NAME = 'Général 🎉 Équipe';

  async function loadedStore() {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'Promo', 'promo')]);
    listChannels.mockResolvedValue([
      makeChannelDto('c1', 'one'),
      makeChannelDto('c2', 'two'),
      makeChannelDto('c3', 'three'),
    ]);
    const api = useChannelWorkspaces();
    const ctx = makeContext();
    await api.loadChannelWorkspacesFromBackend(ctx);
    return { api, ctx };
  }

  const names = (api: ReturnType<typeof useChannelWorkspaces>) =>
    api.channelWorkspaces[0].channels.map((c) => c.name);

  beforeEach(() => {
    vi.clearAllMocks();
    reorderChannels.mockReset();
  });

  it('creates a salon with the name exactly as typed, case, accents and emoji included', async () => {
    const { api, ctx } = await loadedStore();
    createChannel.mockResolvedValue({ id: 'c4', name: FREE_NAME });

    await api.createNewChannel('ws1', `  ${FREE_NAME}  `, ctx);

    expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({ name: FREE_NAME }));
    expect(names(api)).toContain(FREE_NAME);
  });

  it('renames a salon with the name exactly as typed', async () => {
    const { api, ctx } = await loadedStore();
    renameChannel.mockResolvedValue({ success: true });

    await api.renameCurrentChannel('channel_c1', FREE_NAME, ctx);

    expect(renameChannel).toHaveBeenCalledWith('channel_c1', FREE_NAME);
    expect(names(api)[0]).toBe(FREE_NAME);
  });

  it('applies a reorder at once and sends the new order to the server', async () => {
    const { api, ctx } = await loadedStore();
    reorderChannels.mockResolvedValue(undefined);
    const channels = api.channelWorkspaces[0].channels;

    await api.reorderChannels('promo', [channels[2], channels[0], channels[1]], ctx);

    expect(names(api)).toEqual(['three', 'one', 'two']);
    expect(reorderChannels).toHaveBeenCalledWith('ws1', ['channel_c3', 'channel_c1', 'channel_c2']);
  });

  it('rolls the order back, and says so, when the server refuses', async () => {
    const { api, ctx } = await loadedStore();
    reorderChannels.mockRejectedValue(new Error('nope'));
    const channels = api.channelWorkspaces[0].channels;

    await api.reorderChannels('promo', [channels[2], channels[1], channels[0]], ctx);

    expect(names(api)).toEqual(['one', 'two', 'three']);
    expect(ctx.log).toHaveBeenCalled();
  });

  it('names a seal that this device cannot make yet, by its TYPE, instead of the nameless arm', async () => {
    const { api, ctx } = await loadedStore();
    const channels = api.channelWorkspaces[0].channels;

    for (const [failure, said] of [
      [new GraineNotReadyError('cannot seal'), 'seal: no-session'],
      [new GraineUnknownChannelError('c1c1c1c1c1'), 'seal: unknown-channel'],
    ] as const) {
      vi.mocked(showToast).mockClear();
      reorderChannels.mockRejectedValue(failure);
      await api.reorderChannels('promo', [channels[2], channels[1], channels[0]], ctx);
      // The toast names WHICH fact was missing, from the reason the refusal carries.
      expect(showToast).toHaveBeenCalledWith(said, 'error');
    }
  });

  it('raises no error toast when the action stopped because the user is signing out', async () => {
    const { api, ctx } = await loadedStore();
    const channels = api.channelWorkspaces[0].channels;
    vi.mocked(showToast).mockClear();
    reorderChannels.mockRejectedValue(new SignOutInProgressError('request'));

    await api.reorderChannels('promo', [channels[2], channels[1], channels[0]], ctx);

    expect(showToast).not.toHaveBeenCalled();
  });

  it('logs the cause of a failure it cannot name, which the sentence cannot carry', async () => {
    const { api, ctx } = await loadedStore();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reorderChannels.mockRejectedValue(new Error('nope'));

    await api.reorderChannels('promo', [], ctx);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unclassified'), expect.any(Error));
    spy.mockRestore();
  });

  it('follows another member rearranging, from its own filtered list', async () => {
    const { api } = await loadedStore();
    listChannels.mockResolvedValue([
      makeChannelDto('c2', 'two'),
      makeChannelDto('c3', 'three'),
      makeChannelDto('c1', 'one'),
    ]);

    await api.refreshChannelOrder('ws1');

    expect(names(api)).toEqual(['two', 'three', 'one']);
  });
});

describe('useChannelWorkspaces - a reaction that could not be sent', () => {
  const standingOn = (messageId: string) =>
    activeReactions(getChannelReactions(messageId)).filter((r) => r.userId === 'u1');

  // Each case states its own send outcome and its own link: a rejection another test left on the
  // mock, or a store an earlier test left offline, would decide the outcome instead of the case.
  beforeEach(() => {
    vi.clearAllMocks();
    sendChannelReaction.mockReset();
    connectivity.reset();
    resetOwedSalonWrites();
    setCurrentUserId('u1');
  });

  // A lost answer with the link up is an UNKNOWN outcome (WP-OFF-4, `nothingLeftTheDevice`): the
  // server may hold the frame and peers may have it, so the pill stays and only the toast speaks.
  it('names a transport failure by its TYPE, with the network sentence, and keeps the pill', async () => {
    const api = useChannelWorkspaces();
    const ctx = makeContext();
    sendChannelReaction.mockRejectedValue(
      new DeliveryUnreachableError('error sending request for url (https://x/api/mls/send)')
    );

    await api.toggleChannelReaction('channel_c1', 'm-rollback-1', '👍', ctx);

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('network error'), 'error');
    expect(standingOn('m-rollback-1')).toHaveLength(1);
  });

  it('puts a removed reaction back when the server refused the removal', async () => {
    const api = useChannelWorkspaces();
    const ctx = makeContext();
    sendChannelReaction.mockResolvedValueOnce(undefined);
    await api.toggleChannelReaction('channel_c1', 'm-rollback-2', '👍', ctx);
    expect(standingOn('m-rollback-2')).toHaveLength(1);

    sendChannelReaction.mockRejectedValue(new ChannelApiError(403, null, 'Forbidden'));
    await api.toggleChannelReaction('channel_c1', 'm-rollback-2', '👍', ctx);

    expect(standingOn('m-rollback-2')).toHaveLength(1);
  });

  it('keeps the pill when the failure may have reached peers', async () => {
    const api = useChannelWorkspaces();
    const ctx = makeContext();
    sendChannelReaction.mockRejectedValue(new Error('Message send HTTP error: 500'));

    await api.toggleChannelReaction('channel_c1', 'm-rollback-3', '👍', ctx);

    expect(standingOn('m-rollback-3')).toHaveLength(1);
  });
});

describe('useChannelWorkspaces - the membership notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentUserId('inviter');
    inviteToChannel.mockResolvedValue({ alreadyMember: true });
    sendEncryptedChannelMessage.mockResolvedValue(null);
  });

  // The row is encrypted, so the server cannot tell a notice from a message: the sender says so.
  // Sent as an ordinary row it counted as unread for every member of the salon (and rang their
  // phones) until each opened it - the "X joined" badge of 2026-10-08.
  it('is sent SILENT, so it neither counts as unread nor rings anyone', async () => {
    await useChannelWorkspaces().inviteMemberToChannel(
      'channel_c1',
      'newcomer',
      'member',
      makeContext()
    );

    expect(sendEncryptedChannelMessage).toHaveBeenCalledTimes(1);
    const [channelId, , , , , options] = sendEncryptedChannelMessage.mock.calls[0];
    expect(channelId).toBe('channel_c1');
    expect(options).toEqual({ silent: true });
  });

  // A member hands the newcomer the past only on a proof it can check: the admission this device
  // signs travels WITH the invitation and is stored on the newcomer's membership row.
  it('sends the admission this device signed with the invitation (channel-encryption section 25)', async () => {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('c1', 'general')]);
    signDirectAdmission.mockResolvedValue('dm91Y2hlcg');
    const api = useChannelWorkspaces();
    const ctx = makeContext();
    await api.loadChannelWorkspacesFromBackend(ctx);

    await api.inviteMemberToChannel('channel_c1', 'Newcomer', 'member', ctx);

    expect(signDirectAdmission).toHaveBeenCalledWith('ws1', 'newcomer');
    expect(inviteToChannel).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ targetUserId: 'newcomer', admissionVoucher: 'dm91Y2hlcg' })
    );
  });

  it('still invites, and says so, when the admission could not be signed', async () => {
    listUserWorkspaces.mockResolvedValue([makeWorkspaceDto('ws1', 'Community', 'community')]);
    listChannels.mockResolvedValue([makeChannelDto('c1', 'general')]);
    signDirectAdmission.mockRejectedValue(new Error('no messaging layer'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = useChannelWorkspaces();
    const ctx = makeContext();
    await api.loadChannelWorkspacesFromBackend(ctx);

    await api.inviteMemberToChannel('channel_c1', 'newcomer', 'member', ctx);

    expect(inviteToChannel).toHaveBeenCalledWith(
      'c1',
      expect.not.objectContaining({ admissionVoucher: expect.anything() })
    );
    expect(error.mock.calls.flat().join(' ')).toContain('NOT signed');
    error.mockRestore();
  });

  // An ordinary invitation names no role: the server grants the community's base role, whatever
  // that role is called there. A role is named only when the inviter picked one.
  it('names no role for an ordinary invitation, and the picked one otherwise', async () => {
    await useChannelWorkspaces().inviteMemberToChannel(
      'channel_c1',
      'newcomer',
      'member',
      makeContext()
    );
    expect(inviteToChannel.mock.calls[0][1]).toEqual({ targetUserId: 'newcomer' });

    await useChannelWorkspaces().inviteMemberToChannel(
      'channel_c1',
      'second',
      'moderator',
      makeContext()
    );
    expect(inviteToChannel.mock.calls[1][1]).toEqual({
      targetUserId: 'second',
      roleName: 'Modérateur',
    });
  });
});

describe('useChannelWorkspaces - the history rule moving under an open session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listUserWorkspaces.mockReset();
    listChannels.mockReset();
  });

  async function loadedWith(historyVisibility: 'shared' | 'joined') {
    listUserWorkspaces.mockResolvedValue([
      { ...makeWorkspaceDto('ws1', 'Community', 'community'), historyVisibility },
    ]);
    listChannels.mockResolvedValue([makeChannelDto('ch1', 'general')]);
    const store = useChannelWorkspaces();
    const promise = store.loadChannelWorkspacesFromBackend(makeContext());
    await tick();
    await promise;
    requestCommunityHistory.mockClear();
    return store;
  }

  // 2026-10-22: a switch to `shared` never reached the members already in - they held seeds
  // floored at their arrival, and nothing asked for the past again. The broadcast is the moment.
  it('asks the seed layer for the history again when the broadcast moves the rule', async () => {
    const store = await loadedWith('joined');

    store.handleWorkspaceUpdated({ workspaceId: 'ws1', historyVisibility: 'shared' });

    expect(requestCommunityHistory).toHaveBeenCalledWith('ws1');
  });

  it('asks nothing when the broadcast repeats the rule already held', async () => {
    const store = await loadedWith('shared');

    store.handleWorkspaceUpdated({ workspaceId: 'ws1', historyVisibility: 'shared' });
    store.handleWorkspaceUpdated({ workspaceId: 'ws1', imageMediaId: 'img-2' });

    expect(requestCommunityHistory).not.toHaveBeenCalled();
  });
});
