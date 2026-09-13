/**
 * ONE BUILDER FOR A CONVERSATION ROW, DRIVEN THROUGH THE REAL ENTRY POINTS.
 *
 * Thirteen places built this object by hand and the type has twelve fields, so what they agreed on
 * was `messages: []` and `mlsStateHex: null`. The rest drifted, and the drift was not cosmetic:
 *
 *  - **no builder ever wrote `conversationType: 'channel'`**, so every reader's
 *    `conversationType ?? 'group'` read a channel as a group. The sidebar tile has a `#` branch
 *    that could not render; "add members", "rename" and "set an avatar" are each gated on
 *    `!== 'group'` with the comment *"DMs and channels cannot be invaded"* - and channels could;
 *  - the community hydration wrote `messages: []` over a row it had just read for its unread
 *    count, so hydrating a workspace emptied a channel the user was reading;
 *  - the `onWelcomeProcessed` fallback asserted `group` and used the raw group id as the display
 *    name, because it had nothing else to hand.
 *
 * **THE TABLE DRIVES THE SITES, NOT THE BUILDER.** A site that keeps its own object literal is
 * exactly what a test of `buildConversationRow` walks past, so every row here runs a real entry
 * point and reads what landed in the map. The two sites no unit test can reach - the
 * `onWelcomeProcessed` callback wired inside `sessionAuth`, and a Svelte component's
 * `onChannelMemberJoined` - are covered by the source check at the bottom, which is also what
 * catches a FOURTEENTH builder being written next week.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
  globalSession: {},
  globalConvs: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/stores/auth', () => ({
  getToken: vi.fn().mockResolvedValue('t'),
  refresh: vi.fn().mockRejectedValue(new Error('no')),
  clearAuth: vi.fn(),
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/utils/graine/distributionGroup', () => ({
  ensureCommunityDistributionGroup: vi.fn().mockResolvedValue(true),
  enterPrivateSalonGroup: vi.fn().mockResolvedValue(true),
}));

const listUserWorkspaces = vi.hoisted(() => vi.fn());
const listChannels = vi.hoisted(() => vi.fn());
const createWorkspace = vi.hoisted(() => vi.fn());
const createChannel = vi.hoisted(() => vi.fn());
vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class {
    listUserWorkspaces = listUserWorkspaces;
    listChannels = listChannels;
    createWorkspace = createWorkspace;
    createChannel = createChannel;
  },
}));

import {
  buildConversationRow,
  loadExistingConversations,
  type ConversationRowSpec,
} from './conversations';
import { ensureConversationForServerGroup } from './serverGroupConversation';
import { createNewGroup, startNewConversation } from './groupCreation';
import { mergeFcmMessagesIntoConversations } from './fcmMemoryMerge';
import { useChannelWorkspaces } from '$lib/composables/useChannelWorkspaces.svelte';

// ---------------------------------------------------------------------------------------------
// Shared fakes

/** The smallest MLS service every entry point below is satisfied by. */
function mls(overrides: Record<string, unknown> = {}) {
  const local = new Set<string>();
  return {
    createRemoteGroup: vi.fn(async () => 'g-new'),
    registerMember: vi.fn(async () => {}),
    createGroup: vi.fn(async (id: string) => {
      local.add(id);
    }),
    fetchUserDevices: vi.fn(async () => []),
    getDeviceId: vi.fn(() => 'dev-1'),
    getLocalGroups: vi.fn(() => [...local]),
    getUserGroups: vi.fn(async () => []),
    saveState: vi.fn(async () => new Uint8Array([1])),
    deleteGroupOnServer: vi.fn(async () => {}),
    notifyConversationAvailable: vi.fn(),
    notifyConversationsRestored: vi.fn(),
    beginBulkIngest: vi.fn(),
    endBulkIngest: vi.fn(),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    addMembersBulk: vi.fn(async () => ({
      addedDeviceIds: [],
      skippedDeviceIds: [],
      welcome: null,
    })),
    persistCheckpoint: vi.fn(async () => {}),
    undismissGroup: vi.fn(async () => {}),
    isDistributionGroup: vi.fn(() => false),
    getDismissedGroups: vi.fn(async () => []),
    ...overrides,
  } as never;
}

function groupDeps(conversations: SvelteMap<string, Conversation>, service = mls()) {
  return {
    mlsService: service,
    storage: null,
    userId: 'u1',
    deviceKeyB64: 'k',
    historyBaseUrl: 'https://example.invalid',
    conversations,
    selectConversation: vi.fn(),
    saveConversation: vi.fn(async () => {}),
    log: vi.fn(),
  } as never;
}

function channelCtx(conversations: SvelteMap<string, Conversation>) {
  return {
    conversations,
    saveConversation: vi.fn(async () => {}),
    selectConversation: vi.fn(),
    getSelectedConversationId: () => null,
    reloadChannelHistory: vi.fn(async () => {}),
    invalidateChannelHistoryCache: vi.fn(),
    log: vi.fn(),
  } as never;
}

/** The one storage `loadExistingConversations` reads, holding exactly the metas handed in. */
function storageWith(metas: Record<string, unknown>[]) {
  return {
    getConversations: vi.fn(async () => metas),
    saveConversation: vi.fn(async () => {}),
    getMessagesPage: vi.fn(async () => []),
    deleteMessagesForConversation: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => {}),
  } as never;
}

// ---------------------------------------------------------------------------------------------
// The table: one row per SITE, each running the entry point that reaches it.

interface Site {
  what: string;
  /** The map key the row lands under, and what `conversationType` it must carry. */
  key: string;
  type: 'direct' | 'group' | 'channel';
  run: (conversations: SvelteMap<string, Conversation>) => Promise<void>;
}

const sites: Site[] = [
  {
    what: 'the boot restore, reading a channel back from storage',
    key: 'channel_c1',
    type: 'channel',
    run: async (conversations) =>
      void (await loadExistingConversations({
        storage: storageWith([
          { id: 'channel_c1', name: 'general', lifecycle: 'active', updatedAt: 7 },
        ]),
        mlsService: mls(),
        conversations,
        messageReactions: new SvelteMap(),
        userId: 'u1',
        deviceKeyB64: 'k',
        archivedConversationIds: [],
        onArchivedIdsChange: vi.fn(),
        log: vi.fn(),
      } as never)),
  },
  {
    what: 'server discovery, from the roster',
    key: 'g-disc',
    type: 'group',
    run: async (conversations) =>
      void (await ensureConversationForServerGroup(
        { groupId: 'g-disc', name: 'Equipe', isGroup: true, imageMediaId: null } as never,
        {
          mlsService: mls(),
          userId: 'u1',
          conversations,
          saveConversation: vi.fn(async () => {}),
          owedExits: new Set<string>(),
          log: vi.fn(),
        } as never
      )),
  },
  {
    what: 'a group this device creates',
    key: 'g-new',
    type: 'group',
    run: async (conversations) => await createNewGroup('Equipe', groupDeps(conversations)),
  },
  {
    what: 'a DM this device creates',
    key: 'g-new',
    type: 'direct',
    run: async (conversations) =>
      await startNewConversation(
        'bob',
        groupDeps(
          conversations,
          mls({ fetchUserDevices: vi.fn(async () => [{ deviceId: 'd-bob', userId: 'bob' }]) })
        )
      ),
  },
  {
    what: 'a DM already on the server, adopted rather than re-created',
    key: 'g-srv',
    type: 'direct',
    run: async (conversations) =>
      await startNewConversation(
        'bob',
        groupDeps(
          conversations,
          mls({
            getUserGroups: vi.fn(async () => [
              { groupId: 'g-srv', name: 'bob::u1', isGroup: false, status: 'active' },
            ]),
            getLocalGroups: vi.fn(() => ['g-srv']),
          })
        )
      ),
  },
  {
    what: 'the FCM cache, merged into memory before any sync',
    key: 'g-fcm',
    type: 'group',
    run: async (conversations) => {
      mergeFcmMessagesIntoConversations(
        [{ id: 'm1', conversationId: 'g-fcm', senderId: 'bob', content: 'hi', timestamp: 3 }],
        conversations,
        'u1',
        new Map([['g-fcm', { name: 'bob', updatedAt: 3 }]])
      );
    },
  },
  {
    what: 'a workspace refreshed from the backend',
    key: 'channel_c1',
    type: 'channel',
    run: async (conversations) => {
      listUserWorkspaces.mockResolvedValue([
        { _id: 'w1', id: 'w1', name: 'BDE', slug: 'bde', imageMediaId: null },
      ]);
      listChannels.mockResolvedValue([
        { _id: 'c1', id: 'c1', name: 'general', visibility: 'public', viewerHasAccess: true },
      ]);
      await useChannelWorkspaces().loadChannelWorkspacesFromBackend(channelCtx(conversations));
    },
  },
  {
    what: 'a community being created, hydrating its channels',
    key: 'channel_c1',
    type: 'channel',
    run: async (conversations) => {
      createWorkspace.mockResolvedValue({
        _id: 'w1',
        id: 'w1',
        name: 'BDE',
        slug: 'bde',
        imageMediaId: null,
      });
      listChannels.mockResolvedValue([
        { _id: 'c1', id: 'c1', name: 'general', visibility: 'public' },
      ]);
      await useChannelWorkspaces().createNewCommunity('BDE', channelCtx(conversations));
    },
  },
  {
    what: 'a channel this device creates',
    key: 'channel_c9',
    type: 'channel',
    run: async (conversations) => {
      const ch = useChannelWorkspaces();
      ch.upsertWorkspaceFromDto({
        _id: 'w1',
        id: 'w1',
        name: 'BDE',
        slug: 'bde',
        imageMediaId: null,
      } as never);
      createChannel.mockResolvedValue({ _id: 'c9', id: 'c9', name: 'annonces' });
      await ch.createNewChannel('w1', 'annonces', channelCtx(conversations), 'public');
    },
  },
];

describe('a conversation row is built one way, whichever site learnt of the group', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(sites)('$what', async (site) => {
    const conversations = new SvelteMap<string, Conversation>();

    await site.run(conversations);

    const row = conversations.get(site.key);
    expect(row, `no row landed under ${site.key}`).toBeDefined();

    // THE TYPE IS WRITTEN, NEVER LEFT TO A READER'S `?? 'group'`. This is the assertion the four
    // channel builders failed for as long as they existed.
    expect(row!.conversationType).toBe(site.type);

    // And the defaults every site agreed on, plus the two they did not.
    expect(row!.id).toBeTruthy();
    expect(row!.name).toBeTruthy();
    expect(row!.contactName).toBeTruthy();
    expect(Array.isArray(row!.messages)).toBe(true);
    expect(row!.mlsStateHex).toBeNull();
    expect(typeof row!.unreadCount).toBe('number');
  });

  it('drives a DISTINCT entry point per row - the table cannot collapse to one site', () => {
    expect(new Set(sites.map((s) => s.run.toString())).size).toBe(sites.length);
  });
});

describe('what an existing row carries survives the site rebuilding it', () => {
  it('hydrating a community does not empty the channel the user is reading', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    conversations.set(
      'channel_c1',
      buildConversationRow({
        id: 'channel_c1',
        lifecycle: 'active',
        identity: { contactName: 'channel_c1', displayName: 'stale-name' },
      })
    );
    const read = conversations.get('channel_c1')!;
    read.messages.push({
      id: 'm1',
      senderId: 'bob',
      content: 'hi',
      timestamp: new Date(),
    } as never);
    read.unreadCount = 4;

    createWorkspace.mockResolvedValue({
      _id: 'w1',
      id: 'w1',
      name: 'BDE',
      slug: 'bde',
      imageMediaId: null,
    });
    listChannels.mockResolvedValue([
      { _id: 'c1', id: 'c1', name: 'general', visibility: 'public' },
    ]);
    await useChannelWorkspaces().createNewCommunity('BDE', channelCtx(conversations));

    // THE HYDRATION REALLY RAN - without this the two assertions below pass on a no-op, which is
    // the only way this test could lie.
    expect(conversations.get('channel_c1')!.name).toBe('general');

    // `messages: []` was written here unconditionally, over the row this same statement had just
    // read for its unread count.
    expect(conversations.get('channel_c1')!.messages).toHaveLength(1);
    expect(conversations.get('channel_c1')!.unreadCount).toBe(4);
  });
});

describe('buildConversationRow - what the sites no longer decide', () => {
  const base: ConversationRowSpec = {
    id: 'g1',
    lifecycle: 'pending',
    identity: { contactName: 'bob', displayName: 'bob' },
  };

  it('reads the channel verdict off the id, whatever the site claims', () => {
    expect(buildConversationRow({ ...base, id: 'channel_x' }).conversationType).toBe('channel');
    expect(
      buildConversationRow({
        ...base,
        id: 'channel_x',
        identity: { ...base.identity, conversationType: 'group' },
      }).conversationType
    ).toBe('channel');
  });

  it('falls back to `group` only when the site said nothing and the id is not a channel', () => {
    expect(buildConversationRow(base).conversationType).toBe('group');
  });

  it('leaves an optional ABSENT rather than writing it as undefined', () => {
    const row = buildConversationRow(base);
    // A reader that checks `'imageMediaId' in convo` and one that reads `convo.imageMediaId ?? null`
    // must see the same row; `{ imageMediaId: undefined }` splits them.
    expect('imageMediaId' in row).toBe(false);
    expect('lastMessageAt' in row).toBe(false);
    expect('readWatermarks' in row).toBe(false);
    expect('historyFloor' in row).toBe(false);
    expect('directPeerId' in row).toBe(false);
  });

  it('carries an explicit null avatar, which is not the same as saying nothing', () => {
    const row = buildConversationRow({ ...base, imageMediaId: null });
    expect('imageMediaId' in row).toBe(true);
    expect(row.imageMediaId).toBeNull();
  });

  it('prefers what the site knows to what the row it replaces held', () => {
    const existing = buildConversationRow({ ...base, imageMediaId: 'old', lastMessageAt: 1 });
    const next = buildConversationRow({ ...base, existing, imageMediaId: 'new' });
    expect(next.imageMediaId).toBe('new');
    // ...and keeps the rest of what that row carried.
    expect(next.lastMessageAt).toBe(1);
  });
});

describe('the builder is the only place a conversation row is constructed', () => {
  /**
   * THE GUARD THAT REACHES WHAT THE TABLE CANNOT, and the one that catches a FOURTEENTH builder.
   *
   * Two of the thirteen sites are not drivable from a unit test - the `onWelcomeProcessed` callback
   * wired inside `sessionAuth`, and `ChatBackgroundService`'s `onChannelMemberJoined` handler - and
   * a site that keeps its own object literal is exactly the failure this whole item is about. Every
   * one of the thirteen wrote `mlsStateHex: null`, because a row this device has just learnt about
   * holds no serialised MLS state yet, so that field IS the fingerprint of a hand-built row.
   *
   * Tests and fixtures are excluded deliberately: they build rows to feed the code under test, which
   * is not a second implementation of anything.
   */
  it('no source file outside conversations.ts builds one by hand', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, relative, sep } = await import('node:path');

    const root = join(process.cwd(), 'src', 'lib');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'test' && entry.name !== 'paraglide' && entry.name !== 'wasm') {
            walk(full);
          }
          continue;
        }
        if (!/\.(ts|svelte)$/.test(entry.name)) continue;
        if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
        const rel = relative(root, full).split(sep).join('/');
        if (rel === 'utils/chat/conversations.ts') continue;
        // `mlsStateHex: null` and not `mlsStateHex:` - the latter also matches the field's own
        // declaration in `types/index.ts`, which declares the row rather than building one.
        if (/mlsStateHex:\s*null/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    };
    walk(root);

    expect(offenders, 'these files build a conversation row instead of asking for one').toEqual([]);
  });
});
