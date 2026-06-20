import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import {
  requestReAdd,
  cancelReAdd,
  reboot,
  migrateConversation,
  RECOVERY_TIMEOUT_MS,
  REBOOT_DEADLINE_MS,
} from './recovery';
import { saveMlsState } from '$lib/utils/hex';

beforeEach(() => {
  vi.mocked(saveMlsState).mockClear();
  // Reboot deadline markers persist in localStorage across tests - reset between cases.
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMls(overrides: Record<string, unknown> = {}) {
  return {
    sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
    clearPendingWelcomeRequests: vi.fn().mockResolvedValue(undefined),
    getLocalGroups: vi.fn().mockReturnValue([]),
    getGroupMeta: vi.fn().mockResolvedValue(null),
    // Defaut 'error' = ambiguite reseau -> requestReAdd procede comme avant (pas de purge
    // fantome). Seul un 'absent' explicite declenche la purge du groupe confirme disparu.
    getGroupServerStatus: vi.fn().mockResolvedValue('error'),
    getUserGroups: vi.fn().mockResolvedValue([]),
    createRemoteGroup: vi.fn().mockResolvedValue('new-id'),
    createGroup: vi.fn().mockResolvedValue(undefined),
    registerMember: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
    claimGroupSuccessor: vi.fn().mockResolvedValue({ claimed: true, successorId: 'new-id' }),
    deleteGroupOnServer: vi.fn().mockResolvedValue(true),
    forgetGroup: vi.fn(),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    getGroupUserMembers: vi.fn().mockResolvedValue([]),
    fetchUserDevices: vi.fn().mockResolvedValue([]),
    addMembersBulk: vi.fn().mockResolvedValue({
      commit: new Uint8Array([2]),
      addedDeviceIds: [],
      skippedDeviceIds: [],
      welcome: undefined,
    }),
    sendCommit: vi.fn().mockResolvedValue(undefined),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    acquireAddLock: vi.fn().mockResolvedValue(true),
    releaseAddLock: vi.fn().mockResolvedValue(undefined),
    acquireRebootLock: vi.fn().mockResolvedValue(true),
    releaseRebootLock: vi.fn().mockResolvedValue(undefined),
    getEpoch: vi.fn().mockReturnValue(0),
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
    pin: 'pin123',
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
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('envoie sendWelcomeRequest et arme un timer', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);

    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('g1');
    expect(timers.has('g1')).toBe(true);
  });

  it('un seul timer armé mais welcome_request renvoyée à chaque reconnexion', async () => {
    const deps = makeDeps();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    await requestReAdd('g1', deps, timers);

    // La welcome_request est re-envoyée silencieusement même quand le timer tourne déjà
    // (le peer peut être revenu en ligne depuis la dernière fois).
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(2);
    // Mais un seul timer doit être actif (pas de double reboot).
    expect(timers.size).toBe(1);
  });

  it(`après ${RECOVERY_TIMEOUT_MS / 1000}s sans Welcome → renvoie welcome_request, pas de reboot (échéance non atteinte)`, async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue([]); // toujours absent
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    await vi.advanceTimersByTimeAsync(RECOVERY_TIMEOUT_MS);

    // Échéance persistante de 1h non atteinte → pas de reboot, juste un nouveau welcome_request.
    expect(deps.mlsService.createRemoteGroup).not.toHaveBeenCalled();
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(2);
  });

  it('reboot seulement une fois REBOOT_DEADLINE_MS écoulé en temps réel persistant', async () => {
    const deps = makeDeps();
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue([]); // toujours absent
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    // Simule un groupe non-prêt depuis plus d'1h (échéance posée lors d'une session précédente).
    localStorage.setItem(
      'mls_not_ready_since:user-a:g1',
      String(Date.now() - REBOOT_DEADLINE_MS - 1_000)
    );

    await requestReAdd('g1', deps, timers);
    await vi.advanceTimersByTimeAsync(RECOVERY_TIMEOUT_MS);

    expect(deps.mlsService.createRemoteGroup).toHaveBeenCalled();
    expect(deps.mlsService.claimGroupSuccessor).toHaveBeenCalled();
  });

  it('suit la chaîne de successeurs et envoie le welcome_request au terminal', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi.fn().mockImplementation((id: string) => {
          if (id === 'dead-a') return Promise.resolve({ groupId: 'dead-a', successorId: 'dead-b' });
          if (id === 'dead-b') return Promise.resolve({ groupId: 'dead-b', successorId: 'live' });
          if (id === 'live') return Promise.resolve({ groupId: 'live', successorId: null });
          return Promise.resolve(null);
        }),
      }),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('dead-a', deps, timers);

    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledWith('live');
    expect(deps.mlsService.sendWelcomeRequest).toHaveBeenCalledTimes(1);
    expect(timers.has('live')).toBe(true);
  });

  it('Welcome reçu avant 60s → cancelReAdd annule le timer, pas de reboot', async () => {
    const deps = makeDeps();
    // Au moment du timeout, le groupe est dans le WASM (Welcome reçu entre-temps)
    deps.mlsService.getLocalGroups = vi.fn().mockReturnValue(['g1']);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('g1', deps, timers);
    cancelReAdd('g1', timers);

    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();

    // reboot ne doit pas être appelé
    expect(deps.mlsService.createRemoteGroup).not.toHaveBeenCalled();
  });

  it('groupe confirmé absent du serveur → purge le fantôme, ni welcome_request ni timer', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi.fn().mockResolvedValue(null),
        getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
        getLocalGroups: vi.fn().mockReturnValue([]),
      }),
      conversations: makeConversations([
        ['ghost', { id: 'ghost', name: 'Fantôme', isReady: false }],
      ]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('ghost', deps, timers);

    // Boucle coupée : aucune welcome_request, aucun timer armé.
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(timers.has('ghost')).toBe(false);
    // Conversation locale purgée.
    expect(deps.deleteConversation).toHaveBeenCalledWith('ghost');
    expect(deps.conversations.has('ghost')).toBe(false);
  });

  it('groupe absent mais conversation deletedRemotely → conservée (suppression manuelle), pas de welcome_request', async () => {
    const deps = makeDeps({
      mlsService: makeMls({
        getGroupMeta: vi.fn().mockResolvedValue(null),
        getGroupServerStatus: vi.fn().mockResolvedValue('absent'),
      }),
      conversations: makeConversations([
        ['tomb', { id: 'tomb', name: 'Supprimé', isReady: true, deletedRemotely: true }],
      ]),
    });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    await requestReAdd('tomb', deps, timers);

    // Le tombstone reste jusqu'à suppression manuelle (règles 2 & 4) mais la boucle est coupée.
    expect(deps.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(deps.deleteConversation).not.toHaveBeenCalled();
    expect(deps.conversations.has('tomb')).toBe(true);
  });
});

// ── reboot ───────────────────────────────────────────────────────────────────

describe('reboot', () => {
  it('CAS gagné → sendCommit puis sendWelcome pour chaque membre', async () => {
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'other', deviceId: 'dev2' }]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([9]), deviceId: 'dev2' }]),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([2]),
        welcome: new Uint8Array([3]),
        addedDeviceIds: ['dev2'],
        skippedDeviceIds: [],
        ratchetTree: undefined,
      }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    expect(mls.sendCommit).toHaveBeenCalledWith(expect.any(Uint8Array), 'new-id');
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'other',
      'new-id',
      'dev2',
      undefined
    );
  });

  it('CAS perdu → candidate supprimé, sendWelcomeRequest vers gagnant', async () => {
    const mls = makeMls({
      claimGroupSuccessor: vi.fn().mockResolvedValue({ claimed: false, successorId: 'winner-id' }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    // Candidat local nettoyé
    expect(mls.deleteGroupOnServer).toHaveBeenCalledWith('new-id');
    expect(mls.forgetGroup).toHaveBeenCalledWith('new-id');
    // Rejoindre le gagnant
    expect(mls.registerMember).toHaveBeenCalledWith('winner-id', 'user-a');
    expect(mls.sendWelcomeRequest).toHaveBeenCalledWith('winner-id');
  });

  it('verrou reboot cross-device détenu ailleurs → abstention, aucun candidat créé', async () => {
    const mls = makeMls({
      acquireRebootLock: vi.fn().mockResolvedValue(false),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    // Le perdant ne crée aucun candidat ni ne tente le CAS (le gagnant s'en charge).
    expect(mls.createRemoteGroup).not.toHaveBeenCalled();
    expect(mls.claimGroupSuccessor).not.toHaveBeenCalled();
    // Le verrou n'ayant pas été acquis, on ne le relâche pas.
    expect(mls.releaseRebootLock).not.toHaveBeenCalled();
  });

  it('verrou reboot relâché après un reboot complet', async () => {
    const mls = makeMls();
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    expect(mls.acquireRebootLock).toHaveBeenCalledWith('dead');
    expect(mls.releaseRebootLock).toHaveBeenCalledWith('dead');
  });

  it("aucun autre membre → pas de sendWelcome, pas d'erreur", async () => {
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'user-a', deviceId: 'self' }]),
    });
    const deps = makeDeps({ mlsService: mls });

    await expect(reboot('dead', deps)).resolves.not.toThrow();
    expect(mls.sendWelcome).not.toHaveBeenCalled();
  });

  it('getGroupMembers vide → fallback getGroupUserMembers → sendWelcome envoyé', async () => {
    // Simule le cas device créateur supprimé via fresh-start :
    // dm_device_group_memberships vide, mais dm_group_members peuplé.
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([]),
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'other' }]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ keyPackage: new Uint8Array([9]), deviceId: 'dev2' }]),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([2]),
        welcome: new Uint8Array([3]),
        addedDeviceIds: ['dev2'],
        skippedDeviceIds: [],
        ratchetTree: undefined,
      }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    expect(mls.getGroupUserMembers).toHaveBeenCalled();
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'other',
      'new-id',
      'dev2',
      undefined
    );
  });

  it('getGroupMembers et getGroupUserMembers vides → pas de sendWelcome', async () => {
    const mls = makeMls({
      getGroupMembers: vi.fn().mockResolvedValue([]),
      getGroupUserMembers: vi.fn().mockResolvedValue([]),
    });
    const deps = makeDeps({ mlsService: mls });

    await expect(reboot('dead', deps)).resolves.not.toThrow();
    expect(mls.getGroupUserMembers).toHaveBeenCalled();
    expect(mls.sendWelcome).not.toHaveBeenCalled();
  });

  it('findAncestorWithMembers : préfère le groupe courant (user-level) à un ancêtre (device-level)', async () => {
    // Scénario : ancêtre A → dead. A a des device-level actifs (ancienne donnée),
    // dead a des user-level (donnée à jour). Le reboot doit inviter depuis dead,
    // pas depuis A.
    const mls = makeMls({
      getUserGroups: vi
        .fn()
        .mockResolvedValue([{ groupId: 'ancestor', successorId: 'dead', isGroup: false }]),
      getGroupMembers: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === 'ancestor' ? [{ userId: 'old-user', deviceId: 'old-dev' }] : [])
        ),
      getGroupUserMembers: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === 'dead' ? [{ userId: 'current-user' }] : [])
        ),
      fetchUserDevices: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(
            id === 'current-user'
              ? [{ keyPackage: new Uint8Array([9]), deviceId: 'dev-current' }]
              : []
          )
        ),
      addMembersBulk: vi.fn().mockResolvedValue({
        commit: new Uint8Array([2]),
        welcome: new Uint8Array([3]),
        addedDeviceIds: ['dev-current'],
        skippedDeviceIds: [],
        ratchetTree: undefined,
      }),
    });
    const deps = makeDeps({ mlsService: mls });

    await reboot('dead', deps);

    // Doit inviter current-user (dm_group_members de dead), pas old-user (ancêtre)
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'current-user',
      'new-id',
      'dev-current',
      undefined
    );
    expect(mls.sendWelcome).not.toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'old-user',
      expect.any(String),
      'old-dev',
      undefined
    );
  });
});

// ── migrateConversation ───────────────────────────────────────────────────────

describe('migrateConversation', () => {
  it("déplace la conversation de l'ancien vers le nouveau groupId", async () => {
    const conversations = makeConversations([
      [
        'from-id',
        {
          id: 'from-id',
          name: 'Chat',
          messages: [],
          isReady: true,
          contactName: 'x',
          mlsStateHex: null,
        },
      ],
    ]);
    const deps = makeDeps({ conversations });

    await migrateConversation('from-id', 'to-id', deps);

    expect(conversations.has('from-id')).toBe(false);
    expect(conversations.has('to-id')).toBe(true);
    expect(conversations.get('to-id')?.name).toBe('Chat');
  });

  it('cible déjà existante → messages migrés quand même (saveMessages est idempotent)', async () => {
    // Bug A population 2 : quand le Welcome crée la conv cible avant que
    // checkGroupSuccessors ne tourne, les messages de la source doivent quand
    // même être copiés (sinon ils sont détruits lors de deleteConversation source).
    const messages = [
      {
        id: 'm1',
        conversationId: 'from-id',
        senderId: 'x',
        content: 'hi',
        timestamp: 0,
        readBy: [],
        reactions: [],
      },
    ];
    const storage = {
      getMessages: vi.fn().mockResolvedValue(messages),
      saveMessages: vi.fn().mockResolvedValue(undefined),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
    };
    const conversations = makeConversations([
      [
        'from-id',
        {
          id: 'from-id',
          name: 'Chat',
          messages: [],
          isReady: true,
          contactName: 'x',
          mlsStateHex: null,
        },
      ],
      [
        'to-id',
        {
          id: 'to-id',
          name: 'To',
          messages: [],
          isReady: false,
          contactName: 'y',
          mlsStateHex: null,
        },
      ],
    ]);
    const deps = makeDeps({ conversations, storage });

    await migrateConversation('from-id', 'to-id', deps);

    // Les messages sont copiés même si la cible existe (upsert idempotent)
    expect(storage.getMessages).toHaveBeenCalledWith('from-id', 'pin123');
    expect(storage.saveMessages).toHaveBeenCalledTimes(1);
    // Conversation déplacée correctement
    expect(conversations.has('from-id')).toBe(false);
    expect(conversations.has('to-id')).toBe(true);
  });

  it('appel double → messages copiés une seule fois', async () => {
    const storage = {
      getMessages: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          conversationId: 'from-id',
          senderId: 'x',
          content: 'hi',
          timestamp: 0,
          readBy: [],
          reactions: [],
        },
      ]),
      saveMessages: vi.fn().mockResolvedValue(undefined),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
    };
    const conversations = makeConversations([
      [
        'from-id',
        {
          id: 'from-id',
          name: 'Chat',
          messages: [],
          isReady: true,
          contactName: 'x',
          mlsStateHex: null,
        },
      ],
    ]);
    const deps = makeDeps({ conversations, storage });

    await migrateConversation('from-id', 'to-id', deps);
    // Deuxième appel : 'from-id' n'existe plus → noop
    await migrateConversation('from-id', 'to-id', deps);

    expect(storage.saveMessages).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveMlsState)).not.toHaveBeenCalled();
  });
});
