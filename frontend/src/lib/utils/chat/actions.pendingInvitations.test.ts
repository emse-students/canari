import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/chat/groupSyncEligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupSyncEligibility')>()),
  resolveTerminalGroup: vi.fn().mockResolvedValue({
    terminalId: 'g1',
    groupMeta: { name: 'a::b', isGroup: false, deletedAt: null },
    hasChain: false,
  }),
}));

import { processPendingInvitations } from './actions';

function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
  return {
    getDeviceId: vi.fn().mockReturnValue('self-device'),
    getLocalGroups: vi.fn().mockReturnValue(['g1']),
    getPendingInvitations: vi.fn().mockResolvedValue([]),
    acquireAddLock: vi.fn().mockResolvedValue(true),
    releaseAddLock: vi.fn().mockResolvedValue(undefined),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    fetchUserDevices: vi.fn().mockResolvedValue([]),
    fetchDeviceKeyPackage: vi.fn().mockResolvedValue(null),
    removeMemberDevice: vi.fn().mockResolvedValue(undefined),
    kickStaleDevice: vi.fn().mockResolvedValue(undefined),
    addMember: vi.fn(),
    registerMember: vi.fn().mockResolvedValue(undefined),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendCommit: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
    ...overrides,
  } as unknown as IMlsService;
}

function readyConversation(id: string): Conversation {
  return {
    id,
    contactName: id,
    name: 'a::b',
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
  } as Conversation;
}

describe("processPendingInvitations - leaf déjà dans l'arbre", () => {
  it("skip sans kicker ni ré-ajouter quand le device est déjà membre de l'arbre MLS", async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'peer', deviceId: 'peer-dev' }]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) }]),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
    });

    // Le leaf valide ne doit jamais être kické ni ré-ajouté : l'invitation est remplie.
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("déjà dans l'arbre"));
  });

  it("ajoute normalement un device absent de l'arbre", async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) }]),
      addMember: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([2]),
        commit: new Uint8Array([3]),
        ratchetTree: new Uint8Array([4]),
      }),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
    });

    expect(mlsService.addMember).toHaveBeenCalledWith('g1', expect.any(Uint8Array));
    expect(mlsService.sendWelcome).toHaveBeenCalled();
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
  });
});

describe('processPendingInvitations - état local forké en retard', () => {
  it('déclenche recoverForkedGroup et abandonne le groupe quand le commit est rejeté (écart > 1)', async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi.fn().mockResolvedValue([
        { id: 'i1', userId: 'peer', deviceId: 'peer-dev-1', groupId: 'g1', status: 'pending' },
        { id: 'i2', userId: 'peer', deviceId: 'peer-dev-2', groupId: 'g1', status: 'pending' },
      ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi.fn().mockResolvedValue([
        { deviceId: 'peer-dev-1', keyPackage: new Uint8Array([1]) },
        { deviceId: 'peer-dev-2', keyPackage: new Uint8Array([1]) },
      ]),
      addMember: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([2]),
        commit: new Uint8Array([3]),
        ratchetTree: new Uint8Array([4]),
      }),
      sendCommit: vi
        .fn()
        .mockRejectedValue(
          new Error('Commit rejected: epoch_mismatch (server epoch: 23, sent: 7)')
        ),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();
    const recoverForkedGroup = vi.fn().mockResolvedValue(undefined);

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
      recoverForkedGroup,
    });

    // Recovery déclenchée une seule fois pour le groupe, et la 2e invitation n'est pas tentée
    // (break sur le groupe forké) : addMember appelé une seule fois.
    expect(recoverForkedGroup).toHaveBeenCalledTimes(1);
    expect(recoverForkedGroup).toHaveBeenCalledWith('g1', 23);
    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
  });

  it('déclenche la recovery dès un écart de 1 quand NOTRE commit est rejeté (fork concurrent émetteur, C7)', async () => {
    // Cote emetteur, addMember a deja merge le commit localement (epoch N+1) avant le rejet
    // serveur : un ecart de 1 est donc un fork concurrent reel (branche divergente), pas un
    // simple retard de receveur. On doit recovery, sinon le commit gagnant est dropé comme
    // same-epoch benin et le fork devient permanent.
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev-1', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      getDeviceMemberships: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev-1', keyPackage: new Uint8Array([1]) }]),
      addMember: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([2]),
        commit: new Uint8Array([3]),
        ratchetTree: new Uint8Array([4]),
      }),
      sendCommit: vi
        .fn()
        .mockRejectedValue(new Error('Commit rejected: epoch_mismatch (server epoch: 8, sent: 7)')),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();
    const recoverForkedGroup = vi.fn().mockResolvedValue(undefined);

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
      recoverForkedGroup,
    });

    expect(recoverForkedGroup).toHaveBeenCalledTimes(1);
    expect(recoverForkedGroup).toHaveBeenCalledWith('g1', 8);
  });

  it('traite ALREADY_MEMBER comme une invitation remplie (skip, ni kick ni recovery)', async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev-1', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev-1', keyPackage: new Uint8Array([1]) }]),
      addMember: vi
        .fn()
        .mockRejectedValue(
          new Error('ALREADY_MEMBER: All KeyPackages already belong to existing group members')
        ),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();
    const recoverForkedGroup = vi.fn().mockResolvedValue(undefined);

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
      recoverForkedGroup,
    });

    expect(recoverForkedGroup).not.toHaveBeenCalled();
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invitation remplie'));
  });
});
