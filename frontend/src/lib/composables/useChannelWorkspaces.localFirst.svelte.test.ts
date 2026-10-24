// @vitest-environment happy-dom
/**
 * THE COMMUNITY LIST IS DRAWN BEFORE THE NETWORK, AND THE NETWORK ONLY REFRESHES IT
 * (community-open-budget F1-F3, 2026-10-14).
 *
 * - F3: a community's salon rows are drawn on its salon listing's answer, beside the key-group
 *   check, not after it - and the send gate still waits for the key group.
 * - F2: a listing may start before MLS is ready; its key-group step waits for `whenMlsReady`, and a
 *   sign-out while it waits stops it without writing anything for the next account.
 * - F1: what a listing drew is saved per account and drawn at boot from the device; the next
 *   listing replaces it, removing what the server no longer names; another account never sees it;
 *   a sign-out erases it.
 */
import { flushSync } from 'svelte';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';

vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/auth')>()),
  getToken: vi.fn().mockResolvedValue('test-token'),
  refresh: vi.fn().mockRejectedValue(new Error('refresh failed')),
  clearAuth: vi.fn(),
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({
  isChannelConversationId: (id: string) => id.startsWith('channel_'),
  sendEncryptedChannelMessage: vi.fn(),
}));

const listUserWorkspaces = vi.fn();
const listChannels = vi.fn();
const listUnreadCounts = vi.fn().mockResolvedValue([]);
const createChannel = vi.fn();
vi.mock('$lib/services/ChannelService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/services/ChannelService')>()),
  ChannelService: class MockChannelService {
    listUserWorkspaces = listUserWorkspaces;
    listChannels = listChannels;
    listUnreadCounts = listUnreadCounts;
    createChannel = createChannel;
  },
}));

const ensureCommunityDistributionGroup = vi.fn();
vi.mock('$lib/utils/graine/distributionGroup', () => ({
  ensureCommunityDistributionGroup: (...args: unknown[]) =>
    ensureCommunityDistributionGroup(...args),
  enterPrivateSalonGroup: vi.fn().mockResolvedValue(true),
}));

import { SvelteMap } from 'svelte/reactivity';
import { useChannelWorkspaces, type ChannelWorkspaceContext } from './useChannelWorkspaces.svelte';
import { setMlsReady } from './session/mlsReadiness';
import { readSalonSendGate, resetSalonSendGate } from '$lib/utils/graine/salonSendGate';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { clearUserLocally, saveUserLocally } from '$lib/stores/user';
import {
  readWorkspaceSnapshot,
  serializeWorkspaceSnapshot,
  storeWorkspaceSnapshot,
} from '$lib/utils/chat/workspaceSnapshot';
import { flushMacrotask } from '../../test/flush';

const ALICE = 'user-alice';
const BOB = 'user-bob';

function ws(id: string, name: string, slug: string, extra: Partial<WorkspaceDto> = {}) {
  return {
    _id: id,
    id,
    name,
    slug,
    imageMediaId: null,
    viewerCanManage: true,
    viewerCanModerate: true,
    ...extra,
  } as WorkspaceDto;
}

function salon(id: string, name: string, extra: Partial<ChannelDto> = {}): ChannelDto {
  return { _id: id, id, name, visibility: 'public', ...extra } as ChannelDto;
}

function makeContext(overrides: Partial<ChannelWorkspaceContext> = {}): ChannelWorkspaceContext {
  return {
    conversations: new SvelteMap<string, never>(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    selectConversation: vi.fn(),
    getSelectedConversationId: () => null,
    log: vi.fn(),
    ...overrides,
  };
}

/** Lets every pending microtask and the awaited mocks run. */
function settle() {
  return flushMacrotask();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetSalonSendGate();
  setMlsReady(true);
  setCurrentUserId(ALICE);
  // The device's durable sign-in record, which every tab shares (`stores/user.ts`).
  localStorage.setItem('canari_saved_user', ALICE);
  ensureCommunityDistributionGroup.mockResolvedValue(true);
  listUnreadCounts.mockResolvedValue([]);
});

afterEach(() => {
  setCurrentUserId(null);
  localStorage.clear();
});

describe('F3 - salon rows are drawn beside the key-group check, not after it', () => {
  it('draws the rows while the key group is still answering, and opens the send gate only after it', async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);
    let releaseKeyGroup: () => void = () => {};
    ensureCommunityDistributionGroup.mockImplementation(
      () => new Promise<boolean>((resolve) => (releaseKeyGroup = () => resolve(true)))
    );

    const store = useChannelWorkspaces();
    const ctx = makeContext({ ensureMls: vi.fn().mockResolvedValue({}) as never });
    const loading = store.loadChannelWorkspacesFromBackend(ctx);
    await settle();

    // The salon listing went out WITHOUT waiting for the key group...
    expect(listChannels).toHaveBeenCalledWith('ws1');
    // ...and its rows and conversation are on screen while the key group is still in flight.
    expect(store.channelWorkspaces[0].channels.map((c) => c.id)).toEqual(['channel_c1']);
    expect(ctx.conversations.has('channel_c1')).toBe(true);
    // But nothing may be SENT into it before the key group is registered.
    expect(readSalonSendGate('channel_c1')).not.toEqual({ kind: 'ready' });

    releaseKeyGroup();
    await loading;
    expect(readSalonSendGate('channel_c1')).toEqual({ kind: 'ready' });
  });

  it('a salon listing that fails still waits for its key-group chain before the attempt fails', async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockRejectedValue(new Error('boom'));
    let keyGroupDone = false;
    let releaseKeyGroup: () => void = () => {};
    ensureCommunityDistributionGroup.mockImplementation(
      () =>
        new Promise<boolean>(
          (resolve) =>
            (releaseKeyGroup = () => {
              keyGroupDone = true;
              resolve(true);
            })
        )
    );

    const store = useChannelWorkspaces();
    const ctx = makeContext({ ensureMls: vi.fn().mockResolvedValue({}) as never });
    let settled = false;
    const loading = store.loadChannelWorkspacesFromBackend(ctx).then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    expect(store.isLoadingWorkspaces).toBe(true);

    releaseKeyGroup();
    await loading;
    expect(keyGroupDone).toBe(true);
    expect(store.workspacesLoadError).not.toBeNull();
  });
});

describe('F2 - a listing may start before MLS is ready', () => {
  it('draws the communities and salons before MLS, and joins the key group once it is ready', async () => {
    setMlsReady(false);
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);
    const ensureMls = vi.fn().mockResolvedValue({});

    const store = useChannelWorkspaces();
    const ctx = makeContext({ ensureMls: ensureMls as never });
    const loading = store.loadChannelWorkspacesFromBackend(ctx);
    await settle();

    expect(store.channelWorkspaces.map((w) => w.id)).toEqual(['one']);
    expect(store.channelWorkspaces[0].channels.map((c) => c.id)).toEqual(['channel_c1']);
    // No client was asked for, let alone created, before the login initialised one.
    expect(ensureMls).not.toHaveBeenCalled();
    expect(ensureCommunityDistributionGroup).not.toHaveBeenCalled();

    setMlsReady(true);
    await loading;
    expect(ensureCommunityDistributionGroup).toHaveBeenCalledTimes(1);
    expect(store.workspacesLoadError).toBeNull();
    expect(readSalonSendGate('channel_c1')).toEqual({ kind: 'ready' });
  });

  it('a sign-out while the key group waits for MLS stops the listing: nothing written, no failure', async () => {
    setMlsReady(false);
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);

    const store = useChannelWorkspaces();
    const ctx = makeContext({ ensureMls: vi.fn().mockResolvedValue({}) as never });
    const loading = store.loadChannelWorkspacesFromBackend(ctx);
    await settle();

    store.forgetAccount(vi.fn());
    expect(await loading).toBe(false);
    expect(store.channelWorkspaces).toEqual([]);
    expect(store.workspacesLoadError).toBeNull();
    expect(store.isLoadingWorkspaces).toBe(false);
    expect(ensureCommunityDistributionGroup).not.toHaveBeenCalled();
  });
});

describe('F1 - the saved community list', () => {
  it("saves what a listing drew under the account's own key, without unread counts or verdicts", async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one', { imageMediaId: 'img-1' })]);
    listChannels.mockResolvedValue([
      salon('c1', 'general'),
      salon('c2', 'secret', { visibility: 'private', viewerCanWrite: false }),
    ]);

    const store = useChannelWorkspaces();
    await store.loadChannelWorkspacesFromBackend(makeContext());
    flushSync();

    const saved = readWorkspaceSnapshot(ALICE);
    expect(saved).toEqual([
      {
        id: 'one',
        name: 'One',
        workspaceDbId: 'ws1',
        avatarUserId: 'One',
        imageMediaId: 'img-1',
        channels: [
          { id: 'channel_c1', name: 'general', isPrivate: false, hasAccess: true, canWrite: true },
          { id: 'channel_c2', name: 'secret', isPrivate: true, hasAccess: true, canWrite: false },
        ],
      },
    ]);
    // The member's verdicts are the listing's to confirm, never a copy's.
    expect(saved![0]).not.toHaveProperty('viewerCanManage');
    expect(readWorkspaceSnapshot(BOB)).toBeNull();
  });

  it('draws the saved list at boot, unconfirmed, before any request', () => {
    storeWorkspaceSnapshot(
      ALICE,
      serializeWorkspaceSnapshot(ALICE, [
        {
          id: 'one',
          name: 'One',
          workspaceDbId: 'ws1',
          avatarUserId: 'One',
          imageMediaId: null,
          channels: [{ id: 'channel_c1', name: 'general' }],
        },
      ])
    );

    const store = useChannelWorkspaces();
    const log = vi.fn();
    store.hydrateFromSnapshot(ALICE, log);

    expect(store.channelWorkspaces.map((w) => w.id)).toEqual(['one']);
    expect(store.channelWorkspaces[0].channels.map((c) => c.id)).toEqual(['channel_c1']);
    expect(store.workspacesOwner).toBe(ALICE);
    expect(store.workspacesConfirmed).toBe(false);
    expect(listUserWorkspaces).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("never draws another account's saved list", () => {
    storeWorkspaceSnapshot(
      ALICE,
      serializeWorkspaceSnapshot(ALICE, [
        {
          id: 'one',
          name: 'One',
          workspaceDbId: 'ws1',
          avatarUserId: 'One',
          imageMediaId: null,
          channels: [],
        },
      ])
    );
    // A slot copied under Bob's name still names Alice inside: refused and deleted.
    localStorage.setItem(
      'canari_workspace_snapshot:v1:user-bob',
      localStorage.getItem('canari_workspace_snapshot:v1:user-alice')!
    );

    const store = useChannelWorkspaces();
    store.hydrateFromSnapshot(BOB, vi.fn());

    expect(store.channelWorkspaces).toEqual([]);
    expect(localStorage.getItem('canari_workspace_snapshot:v1:user-bob')).toBeNull();
  });

  it('the first listing replaces the saved list: what the server no longer names leaves the screen and the copy', async () => {
    storeWorkspaceSnapshot(
      ALICE,
      serializeWorkspaceSnapshot(ALICE, [
        {
          id: 'one',
          name: 'One',
          workspaceDbId: 'ws1',
          avatarUserId: 'One',
          imageMediaId: null,
          channels: [
            { id: 'channel_c1', name: 'general' },
            { id: 'channel_gone', name: 'closed-to-me' },
          ],
        },
        {
          id: 'lost',
          name: 'Lost',
          workspaceDbId: 'ws-lost',
          avatarUserId: 'Lost',
          imageMediaId: null,
          channels: [{ id: 'channel_l1', name: 'general' }],
        },
      ])
    );
    const store = useChannelWorkspaces();
    store.hydrateFromSnapshot(ALICE, vi.fn());
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);

    await store.loadChannelWorkspacesFromBackend(makeContext());
    flushSync();

    expect(store.channelWorkspaces.map((w) => w.id)).toEqual(['one']);
    expect(store.channelWorkspaces[0].channels.map((c) => c.id)).toEqual(['channel_c1']);
    expect(store.workspacesConfirmed).toBe(true);
    expect(readWorkspaceSnapshot(ALICE)!.map((w) => w.id)).toEqual(['one']);
    expect(readWorkspaceSnapshot(ALICE)![0].channels.map((c) => c.id)).toEqual(['channel_c1']);
  });

  // Review of #1892 (2026-10-15): a salon's stored page (F4) has no conversation until a listing
  // names it in this process, so the loop over the conversations never reaches the page of a salon
  // lost while the app was closed - and the boot no longer erases salon rows.
  it('deletes the stored page of every salon the listing no longer names, and only those', async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const store = useChannelWorkspaces();

    await store.loadChannelWorkspacesFromBackend(
      makeContext({
        deleteConversation,
        storedSalonPageIds: vi.fn().mockResolvedValue(['channel_c1', 'channel_lost']),
      })
    );

    expect(deleteConversation).toHaveBeenCalledTimes(1);
    expect(deleteConversation).toHaveBeenCalledWith('channel_lost');
  });

  it('spares the stored page of a salon created on this device while the listing was in flight', async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    let answerSalons!: (salons: ChannelDto[]) => void;
    listChannels.mockReturnValue(new Promise((resolve) => (answerSalons = resolve)));
    createChannel.mockResolvedValue({ id: 'born', name: 'new' });
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const store = useChannelWorkspaces();
    const ctx = makeContext({
      deleteConversation,
      storedSalonPageIds: vi.fn().mockResolvedValue(['channel_born', 'channel_lost']),
    });

    const loading = store.loadChannelWorkspacesFromBackend(ctx);
    await vi.waitFor(() => expect(listChannels).toHaveBeenCalled());
    // Created after the question was asked: missing from the answer for a reason that is not loss.
    await store.createNewChannel('ws1', 'new', ctx);
    answerSalons([salon('c1', 'general')]);
    await loading;

    expect(deleteConversation.mock.calls.map(([id]) => id)).toEqual(['channel_lost']);
  });

  it('sweeps no stored page when the listing failed', async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockRejectedValue(new Error('offline'));
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const store = useChannelWorkspaces();

    await store
      .loadChannelWorkspacesFromBackend(
        makeContext({
          deleteConversation,
          storedSalonPageIds: vi.fn().mockResolvedValue(['channel_c1']),
        })
      )
      .catch(() => {});

    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('a listing that fails keeps the saved list on screen, unconfirmed', async () => {
    storeWorkspaceSnapshot(
      ALICE,
      serializeWorkspaceSnapshot(ALICE, [
        {
          id: 'one',
          name: 'One',
          workspaceDbId: 'ws1',
          avatarUserId: 'One',
          imageMediaId: null,
          channels: [{ id: 'channel_c1', name: 'general' }],
        },
      ])
    );
    const store = useChannelWorkspaces();
    store.hydrateFromSnapshot(ALICE, vi.fn());
    const { ChannelApiError } = await import('$lib/services/ChannelService');
    // A refusal does not retry, so the test needs no clock; a transport failure keeps it the same way.
    listUserWorkspaces.mockRejectedValue(new ChannelApiError(403, null, 'Forbidden'));

    await store.loadChannelWorkspacesFromBackend(makeContext());

    expect(store.channelWorkspaces.map((w) => w.id)).toEqual(['one']);
    expect(store.workspacesConfirmed).toBe(false);
    expect(store.workspacesLoadError).not.toBeNull();
  });

  it("a listing for another account empties the previous account's list before it draws", async () => {
    storeWorkspaceSnapshot(
      ALICE,
      serializeWorkspaceSnapshot(ALICE, [
        {
          id: 'alice-only',
          name: 'Alice only',
          workspaceDbId: 'ws-a',
          avatarUserId: 'A',
          imageMediaId: null,
          channels: [],
        },
      ])
    );
    const store = useChannelWorkspaces();
    store.hydrateFromSnapshot(ALICE, vi.fn());
    setCurrentUserId(BOB);
    let answer: (rows: WorkspaceDto[]) => void = () => {};
    listUserWorkspaces.mockImplementation(
      () => new Promise<WorkspaceDto[]>((resolve) => (answer = resolve))
    );
    listChannels.mockResolvedValue([]);

    const loading = store.loadChannelWorkspacesFromBackend(makeContext());
    // While Bob's listing is on the wire, nothing of Alice's is on screen.
    expect(store.channelWorkspaces).toEqual([]);
    answer([ws('ws-b', 'Bob', 'bob')]);
    await loading;
    expect(store.channelWorkspaces.map((w) => w.id)).toEqual(['bob']);
    expect(store.workspacesOwner).toBe(BOB);
  });

  it('saves nothing for an owner this page no longer shows', async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);
    const store = useChannelWorkspaces();
    await store.loadChannelWorkspacesFromBackend(makeContext());
    flushSync();
    localStorage.removeItem('canari_workspace_snapshot:v1:user-alice');

    // The page moved to another account before its list was adopted: Alice's list changes, and
    // nothing may be written under her name from a page that is no longer hers.
    setCurrentUserId(BOB);
    store.channelWorkspaces = [
      ...store.channelWorkspaces,
      { ...store.channelWorkspaces[0], id: 'two', workspaceDbId: 'ws2' },
    ];
    flushSync();

    expect(localStorage.getItem('canari_workspace_snapshot:v1:user-alice')).toBeNull();
  });

  it('a sign-out in ANOTHER tab stops this tab from writing the list back', async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);
    const store = useChannelWorkspaces();
    await store.loadChannelWorkspacesFromBackend(makeContext());
    flushSync();
    expect(readWorkspaceSnapshot(ALICE)).not.toBeNull();

    // Tab 2 signs out: `clearUserLocally` there clears the shared record and every slot. This tab's
    // memory still says Alice.
    localStorage.removeItem('canari_saved_user');
    localStorage.removeItem('canari_workspace_snapshot:v1:user-alice');
    store.channelWorkspaces = [
      ...store.channelWorkspaces,
      { ...store.channelWorkspaces[0], id: 'two', workspaceDbId: 'ws2' },
    ];
    flushSync();

    expect(localStorage.getItem('canari_workspace_snapshot:v1:user-alice')).toBeNull();
  });

  it('a salon landing published before the listing ends when the listing does not name the salon', async () => {
    const { notifNav } = await import('$lib/stores/notifNav.svelte');
    storeWorkspaceSnapshot(
      ALICE,
      serializeWorkspaceSnapshot(ALICE, [
        {
          id: 'one',
          name: 'One',
          workspaceDbId: 'ws1',
          avatarUserId: 'One',
          imageMediaId: null,
          channels: [{ id: 'channel_closed', name: 'closed-to-me' }],
        },
      ])
    );
    const store = useChannelWorkspaces();
    store.hydrateFromSnapshot(ALICE, vi.fn());
    // The saved row was tapped before the session: a landing.
    notifNav.navigate('channel_closed');
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);

    await store.loadChannelWorkspacesFromBackend(makeContext());

    // Abandoned on this answer, not after a second full listing.
    expect(notifNav.pending).toBeNull();
    expect(listUserWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('a salon landing published AFTER the listing was asked keeps waiting for its own refresh', async () => {
    const { notifNav } = await import('$lib/stores/notifNav.svelte');
    notifNav.clear();
    let answer: (rows: WorkspaceDto[]) => void = () => {};
    listUserWorkspaces.mockImplementation(
      () => new Promise<WorkspaceDto[]>((resolve) => (answer = resolve))
    );
    listChannels.mockResolvedValue([salon('c1', 'general')]);
    const store = useChannelWorkspaces();
    const loading = store.loadChannelWorkspacesFromBackend(makeContext());
    // A notification for a salon this listing could not know.
    notifNav.navigate('channel_new');
    answer([ws('ws1', 'One', 'one')]);
    await loading;

    expect(notifNav.pending).toBe('channel_new');
    notifNav.clear();
  });

  it('a sign-out forgets the list and erases every saved one', async () => {
    listUserWorkspaces.mockResolvedValue([ws('ws1', 'One', 'one')]);
    listChannels.mockResolvedValue([salon('c1', 'general')]);
    const store = useChannelWorkspaces();
    await store.loadChannelWorkspacesFromBackend(makeContext());
    flushSync();
    expect(readWorkspaceSnapshot(ALICE)).not.toBeNull();

    // The shell's order: the sign-out handler first, then `clearAuth` clears the user.
    store.forgetAccount(vi.fn());
    clearUserLocally();
    flushSync();

    expect(store.channelWorkspaces).toEqual([]);
    expect(store.workspacesOwner).toBeNull();
    expect(localStorage.getItem('canari_workspace_snapshot:v1:user-alice')).toBeNull();
  });

  it('a sign-in as another account erases the saved lists too', () => {
    storeWorkspaceSnapshot(ALICE, serializeWorkspaceSnapshot(ALICE, []));
    localStorage.setItem('canari_saved_user', ALICE);
    saveUserLocally({ id: BOB });
    expect(localStorage.getItem('canari_workspace_snapshot:v1:user-alice')).toBeNull();
  });
});
