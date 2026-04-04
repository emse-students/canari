import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverMissingGroups, forceSyncReset, processPendingInvitations } from './actions';
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
    acquireAddLock: vi.fn().mockResolvedValue(true),
    releaseAddLock: vi.fn().mockResolvedValue(undefined),
    fetchHistory: vi.fn(),
    getDeviceId: vi.fn().mockReturnValue('dev-main'),
    getLocalGroups: vi.fn().mockReturnValue([]),
    forgetGroup: vi.fn(),
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
    getPendingInvitations: vi.fn().mockResolvedValue([]),
    getDeviceMemberships: vi.fn().mockResolvedValue([]),
    updateInvitationStatus: vi.fn().mockResolvedValue({ status: 'added' }),
    deleteDeviceMembership: vi.fn().mockResolvedValue({ status: 'deleted', affected: 1 }),
    deleteAllDeviceMemberships: vi.fn().mockResolvedValue({ status: 'deleted', affected: 0 }),
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

describe('processPendingInvitations', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  it('ne fait rien quand aucune invitation en attente', async () => {
    const log = vi.fn();
    const mls = makeMls({
      getPendingInvitations: vi.fn().mockResolvedValue([]),
    });
    const convs = new Map<string, Conversation>();

    const promise = processPendingInvitations({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mls.acquireAddLock).not.toHaveBeenCalled();
  });

  it('skip un groupe sans conversation locale prête', async () => {
    const log = vi.fn();
    const mls = makeMls({
      getPendingInvitations: vi.fn().mockResolvedValue([
        {
          id: '1',
          userId: 'alice',
          deviceId: 'dev-alice',
          groupId: 'g-unknown',
          status: 'pending',
        },
      ]),
    });
    const convs = new Map<string, Conversation>();

    const promise = processPendingInvitations({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(log).toHaveBeenCalledWith(expect.stringContaining('pas de conversation locale'));
  });

  it('traite une invitation pending et envoie un Welcome', async () => {
    const log = vi.fn();
    const mls = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: '1', userId: 'alice', deviceId: 'dev-alice', groupId: 'g-1', status: 'pending' },
        ]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-alice' }]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockResolvedValue({
        commit: new Uint8Array([0x01]),
        welcome: new Uint8Array([0x02]),
        ratchetTree: new Uint8Array([0x03]),
      }),
    });
    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = processPendingInvitations({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mls.addMember).toHaveBeenCalledWith('g-1', new Uint8Array([1]));
    expect(mls.registerMember).toHaveBeenCalledWith('g-1', 'alice', 'dev-alice');
    expect(mls.sendWelcome).toHaveBeenCalled();
    expect(mls.sendCommit).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Welcome'));
  });

  it('skip un device déjà membre (idempotence)', async () => {
    const log = vi.fn();
    const mls = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: '1', userId: 'alice', deviceId: 'dev-alice', groupId: 'g-1', status: 'pending' },
        ]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-alice' }]),
      getGroupMembers: vi.fn().mockResolvedValue([{ deviceId: 'dev-alice', userId: 'alice' }]),
    });
    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = processPendingInvitations({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mls.addMember).not.toHaveBeenCalled();
    expect(mls.updateInvitationStatus).toHaveBeenCalledWith(
      'dev-alice',
      'alice',
      'g-1',
      'welcome_received'
    );
  });

  it('gère DuplicateSignature en mettant à jour le statut', async () => {
    const log = vi.fn();
    const mls = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: '1', userId: 'alice', deviceId: 'dev-alice', groupId: 'g-1', status: 'pending' },
        ]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-alice' }]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockRejectedValue(new Error('DuplicateSignatureKey already exists')),
    });
    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = processPendingInvitations({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(log).toHaveBeenCalledWith(expect.stringContaining("déjà dans l'arbre MLS"));
    expect(mls.updateInvitationStatus).toHaveBeenCalledWith(
      'dev-alice',
      'alice',
      'g-1',
      'welcome_received'
    );
  });

  it('gère WrongEpoch et vérifie si déjà traité', async () => {
    const log = vi.fn();
    const mls = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: '1', userId: 'alice', deviceId: 'dev-alice', groupId: 'g-1', status: 'pending' },
        ]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([1]), deviceId: 'dev-alice' }]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockRejectedValue(new Error('WrongEpoch')),
      getDeviceMemberships: vi.fn().mockResolvedValue([{ groupId: 'g-1', status: 'welcome_sent' }]),
    });
    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = processPendingInvitations({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(log).toHaveBeenCalledWith(expect.stringContaining('déjà traité'));
  });

  it('skip quand le verrou est pris par un autre appareil', async () => {
    const log = vi.fn();
    const mls = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: '1', userId: 'alice', deviceId: 'dev-alice', groupId: 'g-1', status: 'pending' },
        ]),
      acquireAddLock: vi.fn().mockResolvedValue(false),
    });
    const convs = new Map<string, Conversation>();
    convs.set('grp_1', makeConversation({ groupId: 'g-1', isReady: true }));

    const promise = processPendingInvitations({
      mlsService: mls,
      userId: 'jolan',
      pin: '1234',
      conversations: convs,
      log,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(log).toHaveBeenCalledWith(expect.stringContaining('verrou tenu'));
    expect(mls.addMember).not.toHaveBeenCalled();
  });
});

describe('forceSyncReset', () => {
  it('logs reset instructions', () => {
    const log = vi.fn();

    forceSyncReset('jolan', log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Reset forcé'));
  });
});
