import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverMissingGroups, forceSyncReset, syncOwnDevicesToGroups } from './actions';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    contactName: 'room',
    name: 'room',
    groupId: 'group-1',
    messages: [],
    isReady: true,
    mlsStateHex: null,
    conversationType: 'group',
    ...overrides,
  };
}

function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
  return {
    init: vi.fn(),
    createGroup: vi.fn(),
    createRemoteGroup: vi.fn(),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([0xaa])),
    generateKeyPackage: vi.fn(),
    addMember: vi.fn(),
    addMembersBulk: vi.fn(),
    processWelcome: vi.fn(),
    sendMessage: vi.fn(),
    processIncomingMessage: vi.fn(),
    connect: vi.fn(),
    fetchUserDevices: vi.fn().mockResolvedValue([]),
    publishKeyPackage: vi.fn(),
    sendWelcome: vi.fn(),
    sendCommit: vi.fn(),
    registerMember: vi.fn(),
    fetchHistory: vi.fn(),
    getDeviceId: vi.fn().mockReturnValue('dev-main'),
    getLocalGroups: vi.fn().mockReturnValue([]),
    renameGroup: vi.fn(),
    deleteGroupOnServer: vi.fn(),
    removeMemberFromServer: vi.fn(),
    removeMember: vi.fn(),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    getUserGroups: vi.fn().mockResolvedValue([]),
    exportSecret: vi.fn(),
    onMessage: vi.fn(),
    onDisconnect: vi.fn(),
    ...overrides,
  } as unknown as IMlsService;
}

describe('discoverMissingGroups', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('dedup les groupes serveur et ne recree pas un placeholder local deja present', async () => {
    const convs = new Map<string, Conversation>();
    convs.set(
      'pending_local',
      makeConversation({
        groupId: 'g-1',
        isReady: false,
        conversationType: 'group',
      })
    );

    const mls = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([
        { groupId: 'g-1', name: 'G1', isGroup: true },
        { groupId: 'g-2', name: 'G2', isGroup: true },
        { groupId: 'g-2', name: 'G2 duplicate', isGroup: true },
      ]),
    });

    const saveConversation = vi.fn().mockResolvedValue(undefined);

    await discoverMissingGroups({
      mlsService: mls,
      userId: 'jolan',
      conversations: convs,
      saveConversation,
      log: vi.fn(),
    });

    const g2Entries = [...convs.values()].filter((c) => c.groupId === 'g-2');
    expect(g2Entries).toHaveLength(1);
    expect(g2Entries[0].isReady).toBe(false);
    expect(saveConversation).toHaveBeenCalledTimes(1);
  });

  it('extrait correctement le pair pour les placeholders de discussion directe', async () => {
    const convs = new Map<string, Conversation>();
    const mls = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'dm-1', name: 'jolan::alice::jolan', isGroup: false }]),
    });

    await discoverMissingGroups({
      mlsService: mls,
      userId: 'jolan',
      conversations: convs,
      saveConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    const created = [...convs.values()][0];
    expect(created.contactName).toBe('alice');
    expect(created.name).toBe('alice');
    expect(created.conversationType).toBe('direct');
    expect(created.directPeerId).toBe('alice');
  });
});

describe('syncOwnDevicesToGroups', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  it('ne met pas en cache un appareil si toutes les tentatives echouent', async () => {
    const mls = makeMls({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-2' }])
        .mockResolvedValue([{ keyPackage: new Uint8Array([2]), deviceId: 'dev-2' }]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockRejectedValue(new Error('network boom')),
    });

    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = syncOwnDevicesToGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log: vi.fn(),
    });

    await vi.runAllTimersAsync();
    await promise;

    const cache = localStorage.getItem('known_own_devices:jolan');
    expect(cache).toBeNull();
  });

  it('met en cache un appareil deja membre (DuplicateSignature) pour eviter une boucle de retries', async () => {
    const mls = makeMls({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-2' }])
        .mockResolvedValue([{ keyPackage: new Uint8Array([2]), deviceId: 'dev-2' }]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockRejectedValue(new Error('DuplicateSignatureKey already exists')),
    });

    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = syncOwnDevicesToGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log: vi.fn(),
    });

    await vi.runAllTimersAsync();
    await promise;

    const cacheRaw = localStorage.getItem('known_own_devices:jolan');
    expect(cacheRaw).not.toBeNull();
    expect(JSON.parse(cacheRaw as string)).toContain('dev-2');
  });
});

describe('forceSyncReset', () => {
  it('supprime le cache known_own_devices', () => {
    localStorage.setItem('known_own_devices:jolan', JSON.stringify(['dev-2']));
    const log = vi.fn();

    forceSyncReset('jolan', log);

    expect(localStorage.getItem('known_own_devices:jolan')).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Cache des appareils connus efface'));
  });
});
