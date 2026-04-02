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
    sendSyncRequest: vi.fn(),
    onSyncRequest: vi.fn(),
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
      pin: '1234',
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
      pin: '1234',
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

  it("active un placeholder sans re-bootstrap quand le groupe existe deja dans l'etat MLS local", async () => {
    const convs = new Map<string, Conversation>();
    const createGroup = vi.fn();
    const registerMember = vi.fn().mockResolvedValue(undefined);
    const saveConversation = vi.fn().mockResolvedValue(undefined);

    const mls = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([{ groupId: 'g-1', name: 'Projet', isGroup: true }]),
      // The group already exists in MLS memory (loaded from localStorage backup)
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
      registerMember,
      createGroup,
    });

    await discoverMissingGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      saveConversation,
      log: vi.fn(),
    });

    // Should NOT re-bootstrap (create_group would destroy the existing state)
    expect(createGroup).not.toHaveBeenCalled();
    // Should register this device on the gateway
    expect(registerMember).toHaveBeenCalledWith('g-1', 'jolan', 'dev-main');
    // Conversation should be ready
    const conv = [...convs.values()].find((c) => c.groupId === 'g-1');
    expect(conv?.isReady).toBe(true);
    // saveConversation called twice: once for placeholder (Phase 1) + once for activation (Phase 2)
    expect(saveConversation).toHaveBeenCalledTimes(2);
  });

  it('le leader re-bootstrap un groupe orphelin en creant le groupe et envoyant les Welcomes', async () => {
    const convs = new Map<string, Conversation>();
    const createGroup = vi.fn().mockResolvedValue(undefined);
    const registerMember = vi.fn().mockResolvedValue(undefined);
    const addMembersBulk = vi.fn().mockResolvedValue({
      commit: new Uint8Array([0x01]),
      welcome: new Uint8Array([0x02]),
      addedDeviceIds: ['dev-jolan'],
      ratchetTree: new Uint8Array([0x03]),
    });
    const sendWelcome = vi.fn().mockResolvedValue(undefined);
    const sendCommit = vi.fn().mockResolvedValue(undefined);

    const mls = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'g-1', name: 'alice::jolan', isGroup: false }]),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'alice' }, { userId: 'jolan' }]),
      // alice (leader) has NO other own devices → bootstrap allowed
      // jolan has a device that will be added
      fetchUserDevices: vi
        .fn()
        .mockImplementation((uid: string) =>
          uid === 'jolan'
            ? Promise.resolve([{ keyPackage: new Uint8Array([10]), deviceId: 'dev-jolan' }])
            : Promise.resolve([])
        ),
      createGroup,
      registerMember,
      addMembersBulk,
      sendWelcome,
      sendCommit,
    });

    // userId 'alice' < 'jolan' alphabetically, so alice is the leader
    await discoverMissingGroups({
      mlsService: mls,
      userId: 'alice',
      pin: '1234',
      conversations: convs,
      saveConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    // Leader should have bootstrapped the group
    expect(createGroup).toHaveBeenCalledWith('g-1');
    // The conversation should now be ready
    const conv = [...convs.values()].find((c) => c.groupId === 'g-1');
    expect(conv?.isReady).toBe(true);
  });

  it('le non-leader attend le bootstrap sans creer le groupe', async () => {
    const convs = new Map<string, Conversation>();
    const createGroup = vi.fn();

    const mls = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'g-1', name: 'alice::jolan', isGroup: false }]),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'alice' }, { userId: 'jolan' }]),
      createGroup,
    });

    // 'alice' < 'jolan', so jolan is NOT the leader
    await discoverMissingGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      saveConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    // Non-leader should NOT have created the group
    expect(createGroup).not.toHaveBeenCalled();
    // Conversation should still be a placeholder
    const conv = [...convs.values()].find((c) => c.groupId === 'g-1');
    expect(conv?.isReady).toBe(false);
  });

  it("le leader attend quand d'autres appareils propres existent (attente Welcome via sync_request)", async () => {
    const convs = new Map<string, Conversation>();
    const createGroup = vi.fn();

    const mls = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'g-1', name: 'alice::jolan', isGroup: false }]),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'alice' }, { userId: 'jolan' }]),
      // alice has another device (dev-alice-2) that can send a Welcome via sync_request
      fetchUserDevices: vi.fn().mockImplementation((uid: string) =>
        uid === 'alice'
          ? Promise.resolve([
              { keyPackage: new Uint8Array([10]), deviceId: 'dev-main' },
              { keyPackage: new Uint8Array([11]), deviceId: 'dev-alice-2' },
            ])
          : Promise.resolve([{ keyPackage: new Uint8Array([12]), deviceId: 'dev-jolan' }])
      ),
      createGroup,
    });

    await discoverMissingGroups({
      mlsService: mls,
      userId: 'alice',
      pin: '1234',
      conversations: convs,
      saveConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    // Even though alice is the leader, should NOT bootstrap because
    // another own device (dev-alice-2) exists and will handle sync via sync_request
    expect(createGroup).not.toHaveBeenCalled();
    const conv = [...convs.values()].find((c) => c.groupId === 'g-1');
    expect(conv?.isReady).toBe(false);
  });

  it("le non-leader re-bootstrap apres le timeout de 30s quand aucun autre membre n'est actif", async () => {
    const convs = new Map<string, Conversation>();
    const createGroup = vi.fn().mockResolvedValue(undefined);
    const registerMember = vi.fn().mockResolvedValue(undefined);
    const addMembersBulk = vi.fn().mockResolvedValue({
      commit: new Uint8Array([0x01]),
      welcome: new Uint8Array([0x02]),
      addedDeviceIds: ['dev-alice'],
      ratchetTree: undefined,
    });
    const sendWelcome = vi.fn().mockResolvedValue(undefined);
    const sendCommit = vi.fn().mockResolvedValue(undefined);

    const mls = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'alice' }, { userId: 'jolan' }]),
      // alice has NO active devices (offline) → short 30s timeout applies
      fetchUserDevices: vi.fn().mockResolvedValue([]),
      createGroup,
      registerMember,
      addMembersBulk,
      sendWelcome,
      sendCommit,
    });

    // Pre-seed a placeholder that has been pending for > 30s
    convs.set('dm_old', {
      contactName: 'alice',
      name: 'alice',
      groupId: 'g-1',
      messages: [],
      isReady: false,
      mlsStateHex: null,
      conversationType: 'direct',
      directPeerId: 'alice',
    } as Conversation);
    localStorage.setItem('discovery_pending:g-1', String(Date.now() - 60_000));

    await discoverMissingGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      saveConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    // Non-leader bootstraps after 30s when no other member is active
    expect(createGroup).toHaveBeenCalledWith('g-1');
    const conv = convs.get('dm_old');
    expect(conv?.isReady).toBe(true);
  });

  it("le non-leader attend plus longtemps (120s) quand l'autre membre est actif", async () => {
    const convs = new Map<string, Conversation>();
    const createGroup = vi.fn();

    const mls = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([]),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'alice' }, { userId: 'jolan' }]),
      // alice HAS active devices → extended 120s timeout
      fetchUserDevices: vi
        .fn()
        .mockImplementation((uid: string) =>
          uid === 'alice'
            ? Promise.resolve([{ keyPackage: new Uint8Array([10]), deviceId: 'dev-alice' }])
            : Promise.resolve([])
        ),
      createGroup,
    });

    // Pending 60s — beyond 30s but below 120s extended timeout
    convs.set('dm_old', {
      contactName: 'alice',
      name: 'alice',
      groupId: 'g-1',
      messages: [],
      isReady: false,
      mlsStateHex: null,
      conversationType: 'direct',
      directPeerId: 'alice',
    } as Conversation);
    localStorage.setItem('discovery_pending:g-1', String(Date.now() - 60_000));

    await discoverMissingGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      saveConversation: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    });

    // Should NOT bootstrap — waiting for alice's sync to re-invite us
    expect(createGroup).not.toHaveBeenCalled();
    const conv = convs.get('dm_old');
    expect(conv?.isReady).toBe(false);
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

  it('ne met pas en cache si seules des conversations placeholders non pretes existent', async () => {
    const log = vi.fn();
    const mls = makeMls({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-2' }])
        .mockResolvedValue([{ keyPackage: new Uint8Array([2]), deviceId: 'dev-2' }]),
    });

    const convs = new Map<string, Conversation>();
    convs.set('placeholder', makeConversation({ groupId: 'g-missing', isReady: false }));

    const promise = syncOwnDevicesToGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    const cacheRaw = localStorage.getItem('known_own_devices:jolan');
    expect(cacheRaw).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Aucune conversation prete'));
  });

  it('log un diagnostic explicite quand addMember ne retourne pas de welcome', async () => {
    const log = vi.fn();
    const mls = makeMls({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-2' }])
        .mockResolvedValue([{ keyPackage: new Uint8Array([2]), deviceId: 'dev-2' }]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockResolvedValue({
        commit: new Uint8Array([0x01]),
        welcome: undefined,
        ratchetTree: undefined,
      }),
      registerMember: vi.fn().mockResolvedValue(undefined),
      sendCommit: vi.fn().mockResolvedValue(undefined),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([0xaa])),
    });

    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = syncOwnDevicesToGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Aucun Welcome retourne pour dev-2 dans g-1')
    );
  });

  it('enregistre un membre côté serveur quand addMember echoue avec DuplicateSignatureKey', async () => {
    const log = vi.fn();
    const registerMember = vi.fn().mockResolvedValue(undefined);
    const mls = makeMls({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-2' }])
        .mockResolvedValue([{ keyPackage: new Uint8Array([2]), deviceId: 'dev-2' }]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockRejectedValue(new Error('DuplicateSignatureKey already exists')),
      registerMember,
    });

    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = syncOwnDevicesToGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Should log about DuplicateSignature and register server-side
    expect(log).toHaveBeenCalledWith(expect.stringContaining("deja dans l'arbre MLS de g-1"));
    expect(registerMember).toHaveBeenCalledWith('g-1', 'jolan', 'dev-2');
  });

  it('enregistre le device courant côté serveur pour les conversations prêtes au premier sync', async () => {
    const log = vi.fn();
    const registerMember = vi.fn().mockResolvedValue(undefined);
    const mls = makeMls({
      fetchUserDevices: vi.fn().mockResolvedValue([]),
      getDeviceId: vi.fn().mockReturnValue('dev-main'),
      registerMember,
    });

    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));
    convs.set('grp_2', makeConversation({ groupId: 'g-2', isReady: true, name: 'room2' }));

    const promise = syncOwnDevicesToGroups({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    // Self-registration should have been called for both ready conversations
    expect(registerMember).toHaveBeenCalledWith('g-1', 'jolan', 'dev-main');
    expect(registerMember).toHaveBeenCalledWith('g-2', 'jolan', 'dev-main');
    // Flag should be cached to avoid repeating on next sync cycle
    expect(localStorage.getItem('self_registered:jolan:dev-main')).toBe('1');
  });
});

describe('forceSyncReset', () => {
  it('supprime le cache known_own_devices', () => {
    localStorage.setItem('known_own_devices:jolan', JSON.stringify(['dev-2']));
    const log = vi.fn();

    forceSyncReset('jolan', log);

    expect(localStorage.getItem('known_own_devices:jolan')).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Cache efface'));
  });
});
