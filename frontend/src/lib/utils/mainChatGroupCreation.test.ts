/**
 * mainChatGroupCreation.test.ts
 *
 * Tests unitaires couvrant la logique de création de conversations et de groupes :
 *   - startNewConversation : conversation 1:1
 *   - createNewGroup : groupe multi-membres
 *   - inviteMemberToGroup : invitation dans un groupe existant
 *
 * Exécution :
 *   cd frontend && npm test          # (ou bun test)
 *   make test-frontend
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startNewConversation, createNewGroup, inviteMemberToGroup } from './mainChatGroupCreation';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';

type GroupCreationDeps = Parameters<typeof startNewConversation>[1];

// ─── Mocks globaux ────────────────────────────────────────────────────────────

// Mock du module codec pour éviter les dépendances protobuf dans le contexte de test
vi.mock('$lib/proto/codec', () => ({
  encodeAppMessage: vi.fn().mockReturnValue(new Uint8Array([0x01, 0x02])),
  mkSystem: vi.fn().mockReturnValue({ type: 'system' }),
}));

// Mocks fetch global
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock localStorage (disponible via jsdom mais on réinitialise entre les tests)
beforeEach(() => {
  mockFetch.mockReset();
  // Réponse par défaut : toutes les requêtes fetch retournent 200
  mockFetch.mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ status: 'queued' }),
  });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMlsService(overrides: Partial<IMlsService> = {}): IMlsService {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    createGroup: vi.fn().mockResolvedValue(undefined),
    createRemoteGroup: vi.fn().mockResolvedValue('group-test-uuid'),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([0xab, 0xcd])),
    generateKeyPackage: vi.fn().mockResolvedValue(new Uint8Array()),
    addMember: vi.fn().mockResolvedValue({
      commit: new Uint8Array([0x01]),
      welcome: new Uint8Array([0x02]),
    }),
    addMembersBulk: vi.fn().mockResolvedValue({
      commit: new Uint8Array([0x01]),
      welcome: new Uint8Array([0x02, 0x03]),
      addedDeviceIds: ['dev-jolan2-01'],
    }),
    processWelcome: vi.fn().mockResolvedValue('group-test-uuid'),
    sendMessage: vi.fn().mockResolvedValue(new Uint8Array()),
    processIncomingMessage: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    fetchUserDevices: vi.fn().mockResolvedValue([]),
    publishKeyPackage: vi.fn().mockResolvedValue(undefined),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendCommit: vi.fn().mockResolvedValue(undefined),
    registerMember: vi.fn().mockResolvedValue(undefined),
    fetchHistory: vi.fn().mockResolvedValue([]),
    getDeviceId: vi.fn().mockReturnValue('dev-jolan-01'),
    getLocalGroups: vi.fn().mockReturnValue([]),
    renameGroup: vi.fn().mockResolvedValue(undefined),
    deleteGroupOnServer: vi.fn().mockResolvedValue(undefined),
    removeMemberFromServer: vi.fn().mockResolvedValue(undefined),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    exportSecret: vi.fn().mockResolvedValue(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    onMessage: vi.fn(),
    onDisconnect: vi.fn(),
    ...overrides,
  };
}

type ConvMap = Map<string, Conversation>;

function makeConversationMap(): ConvMap {
  return new Map<string, Conversation>();
}

function makeDeps(
  mls: IMlsService,
  conversations: ConvMap,
  overrides: Partial<
    Pick<GroupCreationDeps, 'userId' | 'pin' | 'log' | 'selectConversation' | 'saveConversation'>
  > = {}
): GroupCreationDeps {
  return {
    mlsService: mls,
    storage: null,
    userId: overrides.userId ?? 'jolan',
    pin: overrides.pin ?? 'pin-test',
    historyBaseUrl: 'http://localhost:3010',
    conversations: conversations as any,
    selectConversation:
      overrides.selectConversation ??
      (vi.fn() as unknown as GroupCreationDeps['selectConversation']),
    saveConversation:
      overrides.saveConversation ??
      (vi.fn().mockResolvedValue(undefined) as unknown as GroupCreationDeps['saveConversation']),
    log: overrides.log ?? (vi.fn() as unknown as GroupCreationDeps['log']),
  };
}

// ─── startNewConversation ─────────────────────────────────────────────────────

describe('startNewConversation', () => {
  it('ne fait rien si le contactName est vide', async () => {
    const mls = makeMlsService();
    const convs = makeConversationMap();
    await startNewConversation('', makeDeps(mls, convs));
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
    expect(convs.size).toBe(0);
  });

  it('ne fait rien si contactName === userId (auto-conversation)', async () => {
    const mls = makeMlsService();
    const convs = makeConversationMap();
    await startNewConversation('jolan', makeDeps(mls, convs));
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('ne fait rien si contactName est uniquement des espaces', async () => {
    const mls = makeMlsService();
    const convs = makeConversationMap();
    await startNewConversation('   ', makeDeps(mls, convs));
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('sélectionne la conversation si elle existe déjà', async () => {
    const mls = makeMlsService();
    const convs = makeConversationMap();
    const selectConversation = vi.fn();
    // Simulate an existing conversation stored with a UUID key
    const existingKey = 'dm_existing_uuid';
    convs.set(existingKey, {
      contactName: 'jolan2',
      name: 'jolan & jolan2',
      groupId: 'g-existing',
      messages: [],
      isReady: true,
      mlsStateHex: null,
      conversationType: 'direct',
      directPeerId: 'jolan2',
    });

    await startNewConversation('jolan2', makeDeps(mls, convs, { selectConversation }));
    expect(selectConversation).toHaveBeenCalledWith(existingKey);
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('normalise le contactName en minuscules', async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10, 0x20]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([]) // propres appareils
        .mockResolvedValueOnce([jolan2Device]),
    });
    const convs = makeConversationMap();
    await startNewConversation('JOLAN2', makeDeps(mls, convs));

    // Check if any conversation was created for 'jolan2'
    const created = Array.from(convs.values()).find((c) => c.contactName === 'jolan2');
    expect(created).toBeDefined();

    // Le groupe doit être créé avec le nom normalisé et le format "userId::contact"
    expect(mls.createRemoteGroup).toHaveBeenCalledWith('jolan::jolan2');
  });

  it('crée le groupe et ajoute jolan comme membre', async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([]) // propres appareils (aucun autre)
        .mockResolvedValueOnce([jolan2Device]),
    });
    const convs = makeConversationMap();
    await startNewConversation('jolan2', makeDeps(mls, convs));

    expect(mls.createRemoteGroup).toHaveBeenCalledWith('jolan::jolan2');
    expect(mls.createGroup).toHaveBeenCalledWith('group-test-uuid');
    expect(mls.registerMember).toHaveBeenCalledWith('group-test-uuid', 'jolan', 'dev-jolan-01');
  });

  it('ajoute les devices de jolan2 en bulk et les inscrit comme membres', async () => {
    const devices = [
      { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-A' },
      { keyPackage: new Uint8Array([0x20]), deviceId: 'dev-jolan2-B' },
    ];
    const mls = makeMlsService({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([]) // propres appareils
        .mockResolvedValueOnce(devices),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([0x01]),
        welcome: new Uint8Array([0x02]),
        addedDeviceIds: ['dev-jolan2-A', 'dev-jolan2-B'],
      }),
    });
    const convs = makeConversationMap();
    await startNewConversation('jolan2', makeDeps(mls, convs));

    expect(mls.addMembersBulk).toHaveBeenCalledWith('group-test-uuid', devices);
    expect(mls.registerMember).toHaveBeenCalledWith('group-test-uuid', 'jolan2', 'dev-jolan2-A');
    expect(mls.registerMember).toHaveBeenCalledWith('group-test-uuid', 'jolan2', 'dev-jolan2-B');
  });

  it('envoie un Welcome HTTP pour chaque device de jolan2', async () => {
    const devices = [
      { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-A' },
      { keyPackage: new Uint8Array([0x20]), deviceId: 'dev-jolan2-B' },
    ];
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(devices),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([0x01]),
        welcome: new Uint8Array([0xaa, 0xbb]),
        addedDeviceIds: ['dev-jolan2-A', 'dev-jolan2-B'],
      }),
    });
    const convs = makeConversationMap();
    await startNewConversation('jolan2', makeDeps(mls, convs));

    const welcomeCalls = mockFetch.mock.calls.filter(([url]: any[]) =>
      (url as string).includes('/api/mls-api/welcome')
    );
    // Un Welcome par device
    expect(welcomeCalls).toHaveLength(2);
    // Vérifier le payload du premier Welcome
    const [, opts] = welcomeCalls[0];
    const body = JSON.parse(opts.body);
    expect(body.targetUserId).toBe('jolan2');
    expect(body.senderUserId).toBe('jolan');
    expect(body.groupId).toBe('group-test-uuid');
    expect(body.welcomePayload).toBeDefined();
  });

  it('envoie le commit après les Welcomes', async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([jolan2Device]),
    });
    const convs = makeConversationMap();
    await startNewConversation('jolan2', makeDeps(mls, convs));

    expect(mls.sendCommit).toHaveBeenCalledWith(new Uint8Array([0x01]), 'group-test-uuid');
  });

  it('marque la conversation isReady=true après succès', async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([jolan2Device]),
    });
    const convs = makeConversationMap();
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    await startNewConversation('jolan2', makeDeps(mls, convs, { saveConversation }));

    const convo = Array.from(convs.values()).find((c) => c.contactName === 'jolan2');
    expect(convo).toBeDefined();
    expect(convo!.isReady).toBe(true);
    expect(convo!.groupId).toBe('group-test-uuid');
    // saveConversation doit être appelé pour persistance avec la clé UUID
    expect(saveConversation).toHaveBeenCalledWith(expect.stringMatching(/^dm_/));
  });

  it('log [OK] Canal securise avec le nom du contact', async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([jolan2Device]),
    });
    const convs = makeConversationMap();
    const log = vi.fn();
    await startNewConversation('jolan2', makeDeps(mls, convs, { log }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[OK] Canal securise avec jolan2.'));
  });

  it('BLOCAGE 1 : supprime la conversation et log [ERREUR] si aucun device trouve', async () => {
    // fetchDevicesWithRetry épuise 6 tentatives avec délais → fake timers
    vi.useFakeTimers();

    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValue([]),
    });
    const convs = makeConversationMap();
    const log = vi.fn();

    const promise = startNewConversation('jolan2', makeDeps(mls, convs, { log }));
    // Accélérer tous les délais de retry (6 × 1500 ms)
    await vi.runAllTimersAsync();
    await promise;

    expect(convs.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[ERREUR] Appareils introuvables'));
  }, 15_000);

  it('sync les propres appareils de jolan dans le groupe', async () => {
    const ownDevice2 = { keyPackage: new Uint8Array([0xff]), deviceId: 'dev-jolan-02' };
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi
        .fn()
        .mockResolvedValueOnce([ownDevice2]) // propres appareils : 1 autre device
        .mockResolvedValueOnce([jolan2Device]),
    });
    const convs = makeConversationMap();
    await startNewConversation('jolan2', makeDeps(mls, convs));

    // Le propre device de jolan doit aussi être ajouté
    expect(mls.addMember).toHaveBeenCalledWith('group-test-uuid', ownDevice2.keyPackage);
    expect(mls.registerMember).toHaveBeenCalledWith('group-test-uuid', 'jolan', 'dev-jolan-02');
    // Un Welcome doit être envoyé à dev-jolan-02
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'jolan',
      'group-test-uuid',
      'dev-jolan-02'
    );
  });

  it("sauvegarde l'état MLS dans localStorage", async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([jolan2Device]),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([0xde, 0xad])),
    });
    const convs = makeConversationMap();
    await startNewConversation('jolan2', makeDeps(mls, convs));

    const saved = localStorage.getItem('mls_autosave_jolan');
    expect(saved).toBe('dead');
  });
});

// ─── createNewGroup ───────────────────────────────────────────────────────────

describe('createNewGroup', () => {
  it('ne fait rien si le nom est vide', async () => {
    const mls = makeMlsService();
    const convs = makeConversationMap();
    await createNewGroup('', makeDeps(mls, convs));
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('ne fait rien si le nom est uniquement des espaces', async () => {
    const mls = makeMlsService();
    const convs = makeConversationMap();
    await createNewGroup('   ', makeDeps(mls, convs));
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('log une erreur si un groupe du même nom existe déjà', async () => {
    const mls = makeMlsService();
    const convs = makeConversationMap();
    const log = vi.fn();
    // La clé dans la map est normalisée en minuscules
    convs.set('grp_existing_uuid', {
      contactName: 'dev team',
      name: 'Dev Team',
      groupId: 'g-old',
      messages: [],
      isReady: true,
      mlsStateHex: null,
      conversationType: 'group',
    });
    await createNewGroup('Dev Team', makeDeps(mls, convs, { log }));
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('existe déjà'));
  });

  it("crée le groupe et inscrit l'initiateur comme membre", async () => {
    const mls = makeMlsService({ fetchUserDevices: vi.fn().mockResolvedValue([]) });
    const convs = makeConversationMap();
    const selectConversation = vi.fn();
    await createNewGroup('Projet Alpha', makeDeps(mls, convs, { selectConversation }));

    expect(mls.createRemoteGroup).toHaveBeenCalledWith('Projet Alpha');
    expect(mls.createGroup).toHaveBeenCalledWith('group-test-uuid');
    expect(mls.registerMember).toHaveBeenCalledWith('group-test-uuid', 'jolan', 'dev-jolan-01');
  });

  it('ajoute le groupe à la map de conversations (isReady: true)', async () => {
    const mls = makeMlsService({ fetchUserDevices: vi.fn().mockResolvedValue([]) });
    const convs = makeConversationMap();
    const selectConversation = vi.fn();
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    await createNewGroup(
      'Projet Alpha',
      makeDeps(mls, convs, { selectConversation, saveConversation })
    );

    // La clé dans la map est 'grp_' + UUID, le nom d'affichage est 'Projet Alpha'
    const convo = Array.from(convs.values()).find((c) => c.name === 'Projet Alpha');
    expect(convo).toBeDefined();
    expect(convo!.isReady).toBe(true);
    expect(convo!.groupId).toBe('group-test-uuid');
    expect(convo!.name).toBe('Projet Alpha'); // nom d'affichage préservé

    // Verif selectConversation appelé avec une clé UUID
    const createdKey = Array.from(convs.keys())[0];
    expect(selectConversation).toHaveBeenCalledWith(createdKey);
    expect(saveConversation).toHaveBeenCalledWith(createdKey);
  });

  it('log [OK] Groupe cree', async () => {
    const mls = makeMlsService({ fetchUserDevices: vi.fn().mockResolvedValue([]) });
    const convs = makeConversationMap();
    const log = vi.fn();
    await createNewGroup('Projet Alpha', makeDeps(mls, convs, { log }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[OK] Groupe "Projet Alpha" cree.'));
  });

  it('sync les propres appareils de jolan dans le nouveau groupe', async () => {
    const ownDevice2 = { keyPackage: new Uint8Array([0xee]), deviceId: 'dev-jolan-02' };
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValueOnce([ownDevice2]),
    });
    const convs = makeConversationMap();
    await createNewGroup('Projet Beta', makeDeps(mls, convs));

    expect(mls.addMember).toHaveBeenCalledWith('group-test-uuid', ownDevice2.keyPackage);
    expect(mls.registerMember).toHaveBeenCalledWith('group-test-uuid', 'jolan', 'dev-jolan-02');
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'jolan',
      'group-test-uuid',
      'dev-jolan-02'
    );
  });
});

// ─── inviteMemberToGroup ──────────────────────────────────────────────────────

describe('inviteMemberToGroup', () => {
  const existingConvo: Conversation = {
    contactName: 'dev-team',
    name: 'Dev Team',
    groupId: 'group-dev-team',
    messages: [],
    isReady: true,
    mlsStateHex: null,
  };

  it('ne fait rien si memberId est vide', async () => {
    const mls = makeMlsService();
    const convs = makeConversationMap();
    await inviteMemberToGroup('', existingConvo, makeDeps(mls, convs));
    expect(mls.fetchUserDevices).not.toHaveBeenCalled();
  });

  it('invite jolan2 et ajoute tous ses devices en bulk', async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValue([jolan2Device]),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([0x01]),
        welcome: new Uint8Array([0x02]),
        addedDeviceIds: ['dev-jolan2-01'],
      }),
    });
    const convs = makeConversationMap();
    await inviteMemberToGroup('jolan2', existingConvo, makeDeps(mls, convs));

    expect(mls.addMembersBulk).toHaveBeenCalledWith('group-dev-team', [jolan2Device]);
    expect(mls.registerMember).toHaveBeenCalledWith('group-dev-team', 'jolan2', 'dev-jolan2-01');
  });

  it('envoie un Welcome pour chaque device de jolan2', async () => {
    const devices = [
      { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-j2-a' },
      { keyPackage: new Uint8Array([0x20]), deviceId: 'dev-j2-b' },
    ];
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValue(devices),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([0x01]),
        welcome: new Uint8Array([0xff]),
        addedDeviceIds: ['dev-j2-a', 'dev-j2-b'],
      }),
    });
    const convs = makeConversationMap();
    await inviteMemberToGroup('jolan2', existingConvo, makeDeps(mls, convs));

    const welcomeCalls = mockFetch.mock.calls.filter(([url]: any[]) =>
      (url as string).includes('/api/mls-api/welcome')
    );
    expect(welcomeCalls).toHaveLength(2);
    const bodies = welcomeCalls.map((call: any[]) =>
      JSON.parse((call[1] as RequestInit).body as string)
    );
    expect(bodies[0].targetUserId).toBe('jolan2');
    expect(bodies[0].groupId).toBe('group-dev-team');
    expect(bodies[1].targetDeviceId).toBe('dev-j2-b');
  });

  it('envoie le commit après les Welcomes', async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValue([jolan2Device]),
    });
    const convs = makeConversationMap();
    await inviteMemberToGroup('jolan2', existingConvo, makeDeps(mls, convs));

    expect(mls.sendCommit).toHaveBeenCalledWith(new Uint8Array([0x01]), 'group-dev-team');
  });

  it('log [OK] avec le nombre de devices ajoutes', async () => {
    const devices = [
      { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-j2-a' },
      { keyPackage: new Uint8Array([0x20]), deviceId: 'dev-j2-b' },
    ];
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValue(devices),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([0x01]),
        welcome: new Uint8Array([0xff]),
        addedDeviceIds: ['dev-j2-a', 'dev-j2-b'],
      }),
    });
    const log = vi.fn();
    const convs = makeConversationMap();
    await inviteMemberToGroup('jolan2', existingConvo, makeDeps(mls, convs, { log }));

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[OK] Ajoutes: jolan2 (2 appareils).')
    );
  });

  it("BLOCAGE 1 : log [ERREUR] si le membre cible n'a aucun device (jamais connecte)", async () => {
    vi.useFakeTimers();
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValue([]),
    });
    const log = vi.fn();
    const convs = makeConversationMap();
    const promise = inviteMemberToGroup('nouveau', existingConvo, makeDeps(mls, convs, { log }));
    await vi.runAllTimersAsync();
    await promise;

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[ERREUR] Aucun appareil trouve pour les utilisateurs demandes.')
    );
    expect(mls.addMembersBulk).not.toHaveBeenCalled();
  }, 15_000);

  it('normalise le memberId en minuscules', async () => {
    const jolan2Device = { keyPackage: new Uint8Array([0x10]), deviceId: 'dev-jolan2-01' };
    const mls = makeMlsService({
      fetchUserDevices: vi.fn().mockResolvedValue([jolan2Device]),
    });
    const convs = makeConversationMap();
    await inviteMemberToGroup('JOLAN2', existingConvo, makeDeps(mls, convs));

    const welcomeCalls = mockFetch.mock.calls.filter(([url]: any[]) =>
      (url as string).includes('/api/mls-api/welcome')
    );
    const body = JSON.parse((welcomeCalls[0][1] as RequestInit).body as string);
    expect(body.targetUserId).toBe('jolan2');
  });
});
