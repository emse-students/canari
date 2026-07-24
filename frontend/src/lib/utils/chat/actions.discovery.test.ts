import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { discoverMissingGroups } from './actions';
import {
  forgetMlsGroupIfPresent,
  purgeLocalConversationRecord,
  purgeOrphanGroup,
} from './groupActions';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
  return {
    getUserGroups: vi.fn().mockResolvedValue([]),
    getLocalGroups: vi.fn().mockReturnValue([]),
    forgetGroup: vi.fn(),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
    getDismissedGroups: vi.fn().mockResolvedValue([]),
    getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
    getGroupUserMembers: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as IMlsService;
}

describe('forgetMlsGroupIfPresent', () => {
  it('calls forgetGroup only when WASM knows the group', () => {
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
    });
    expect(forgetMlsGroupIfPresent(mlsService, 'g1')).toBe(true);
    expect(mlsService.forgetGroup).toHaveBeenCalledWith('g1', 0);
    expect(forgetMlsGroupIfPresent(mlsService, 'missing')).toBe(false);
  });
});

describe('purgeLocalConversationRecord', () => {
  it('removes map entry and IndexedDB row without touching MLS', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          name: 'Test',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls();

    await purgeLocalConversationRecord({
      conversations,
      contactKey: 'g1',
      groupId: 'g1',
      deleteConversation,
    });

    expect(conversations.has('g1')).toBe(false);
    expect(deleteConversation).toHaveBeenCalledWith('g1');
    expect(mlsService.forgetGroup).not.toHaveBeenCalled();
  });
});

describe('purgeOrphanGroup', () => {
  it('forgets MLS then persists state then drops UI row', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          name: 'Test',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
    });

    await purgeOrphanGroup({
      conversations,
      mlsService,
      userId: 'user-a',
      pin: '1234',
      contactKey: 'g1',
      groupId: 'g1',
    });

    expect(mlsService.forgetGroup).toHaveBeenCalledWith('g1', 0);
    expect(mlsService.saveState).toHaveBeenCalledWith('1234');
    expect(conversations.has('g1')).toBe(false);
  });
});

describe('discoverMissingGroups orphan cleanup', () => {
  it('marks an established conversation deletedRemotely (not purged) when it is a server tombstone', async () => {
    // A ready conversation absente de notre membership MAIS encore presente cote serveur avec
    // deletedAt (supprimee par un pair / nous sur un autre appareil). On retombe sur une
    // tombstone deletedRemotely au lieu d'une purge silencieuse : l'utilisateur garde la ligne,
    // voit la banniere et la supprime localement. (Une purge silencieuse laissait taper dans un
    // groupe mort.) On ne purge QUE si getGroupServerStatus confirme l'absence totale ('absent').
    const conversations = new Map<string, Conversation>([
      [
        'orphan-id',
        {
          id: 'orphan-id',
          contactName: 'orphan-id',
          name: 'Orphelin',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      // Tombstone : la ligne dm_groups existe encore avec deletedAt -> garder + banniere.
      getGroupServerStatus: vi
        .fn()
        .mockResolvedValue({ groupId: 'orphan-id', deletedAt: '2026-01-01T00:00:00Z' }),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      saveConversation,
      log: vi.fn(),
    });

    expect(conversations.has('orphan-id')).toBe(true);
    expect(conversations.get('orphan-id')?.lifecycle).toBe('removed');
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(saveConversation).toHaveBeenCalledWith('orphan-id');
  });

  it('re-seeds the authoritative group name + avatar from the server onto an existing group', async () => {
    // A device that missed the one-shot `groupRenamed` MLS message keeps a stale name ("Groupe").
    // Discovery must converge it to the server row (source of truth), like it already does for the
    // avatar. DM names are peer-derived and must NOT be overwritten from the server row.
    const conversations = new Map<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          name: 'Groupe',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
          conversationType: 'group',
          imageMediaId: null,
        },
      ],
    ]);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([
          { groupId: 'g1', name: 'Les ROOTz', isGroup: true, imageMediaId: 'img-9' },
        ]),
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      saveConversation,
      log: vi.fn(),
    });

    expect(conversations.get('g1')?.name).toBe('Les ROOTz');
    expect(conversations.get('g1')?.imageMediaId).toBe('img-9');
    expect(saveConversation).toHaveBeenCalledWith('g1');
  });

  it("purge une conversation que l'utilisateur a dismissée (suppression/quitter manuel, regles 3/5)", async () => {
    const conversations = new Map<string, Conversation>([
      [
        'dismissed-id',
        {
          id: 'dismissed-id',
          contactName: 'dismissed-id',
          name: 'Dismissée',
          messages: [],
          lifecycle: 'removed', // meme marquee, un dismiss explicite la purge sur tous les appareils
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      getDismissedGroups: vi.fn().mockResolvedValue(['dismissed-id']),
      // Meme si le groupe existe encore cote serveur, le dismiss prime -> purge.
      getGroupServerStatus: vi.fn().mockResolvedValue({ groupId: 'dismissed-id', deletedAt: null }),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('dismissed-id')).toBe(false);
    expect(deleteConversation).toHaveBeenCalledWith('dismissed-id');
  });

  it('garde une conversation vivante ou on est ENCORE membre (snapshot perime, anti-race)', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'fresh-id',
        {
          id: 'fresh-id',
          contactName: 'fresh-id',
          name: 'Fraiche',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]), // snapshot perime : ne liste pas fresh-id
      getLocalGroups: vi.fn().mockReturnValue([]),
      getGroupServerStatus: vi.fn().mockResolvedValue({ groupId: 'fresh-id', deletedAt: null }),
      // dm_group_members frais : on est toujours membre -> garder actif, NE PAS marquer.
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'user-a' }]),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      saveConversation,
      log: vi.fn(),
    });

    expect(conversations.has('fresh-id')).toBe(true);
    expect(conversations.get('fresh-id')?.lifecycle).not.toBe('removed');
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it("marque deletedRemotely une exclusion (groupe vivant, on n'est PLUS membre)", async () => {
    const conversations = new Map<string, Conversation>([
      [
        'excluded-id',
        {
          id: 'excluded-id',
          contactName: 'excluded-id',
          name: 'Exclu',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
      getGroupServerStatus: vi.fn().mockResolvedValue({ groupId: 'excluded-id', deletedAt: null }),
      // Groupe vivant mais on n'est PAS dans les membres -> exclusion -> banniere.
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'someone-else' }]),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      saveConversation,
      log: vi.fn(),
    });

    expect(conversations.has('excluded-id')).toBe(true);
    expect(conversations.get('excluded-id')?.lifecycle).toBe('removed');
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it('purges a placeholder (never-ready) UI row when absent from server', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'orphan-id',
        {
          id: 'orphan-id',
          contactName: 'orphan-id',
          name: 'Orphelin',
          messages: [],
          lifecycle: 'pending',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue([]),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('orphan-id')).toBe(false);
    expect(deleteConversation).toHaveBeenCalledWith('orphan-id');
  });

  it('forgets phantom MLS group even without UI conversation row', async () => {
    const conversations = new Map<string, Conversation>();
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getLocalGroups: vi.fn().mockReturnValue(['phantom-mls']),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      log: vi.fn(),
    });

    expect(mlsService.forgetGroup).toHaveBeenCalledWith('phantom-mls', 0);
    expect(mlsService.saveState).toHaveBeenCalledWith('1234');
  });

  it('does not purge when server fetch failed', async () => {
    const conversations = new Map<string, Conversation>([
      [
        'orphan-id',
        {
          id: 'orphan-id',
          contactName: 'orphan-id',
          name: 'Orphelin',
          messages: [],
          lifecycle: 'active',
          mlsStateHex: null,
        },
      ],
    ]);
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockRejectedValue(new Error('network')),
      getLocalGroups: vi.fn().mockReturnValue(['orphan-id']),
    });

    await discoverMissingGroups({
      mlsService,
      userId: 'user-a',
      pin: '1234',
      conversations,
      deleteConversation,
      log: vi.fn(),
    });

    expect(conversations.has('orphan-id')).toBe(true);
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(mlsService.forgetGroup).not.toHaveBeenCalled();
  });
});
