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

/**
 * A BAD MINUTE ON ONE ENDPOINT USED TO RETIRE A PERFECTLY VALID INVITATION.
 *
 * `fetchDeviceKeyPackage` answered `null` for a 404, a 500, a gateway error and an unreachable
 * network alike, and this loop read every one of them as "the device was deregistered" and DELETED
 * the pending membership. A status code is an ANSWER and a transport failure is not - the rule was
 * already written down; this call site did not honour it.
 *
 * And the 404 itself had three causes reported as one. Since the server refuses to serve an elapsed
 * package (2026-09-16), "no package" also means "this device has not been online since its own
 * package died" - which is temporary, repairs itself on the device's next connection, and was being
 * logged as a permanent deregistration.
 */
describe('a pending invitation acts on WHICH answer it got', () => {
  const INVITATION = {
    id: 'i1',
    userId: 'peer',
    deviceId: 'peer-dev',
    groupId: 'g1',
    status: 'pending',
  };

  function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
    return {
      getDeviceId: vi.fn().mockReturnValue('self-device'),
      getLocalGroups: vi.fn().mockReturnValue(['g1']),
      getPendingInvitations: vi.fn().mockResolvedValue([INVITATION]),
      acquireAddLock: vi.fn().mockResolvedValue(true),
      releaseAddLock: vi.fn().mockResolvedValue(undefined),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      getGroupMemberIdentities: vi.fn().mockResolvedValue([]),
      // Empty, so every case below falls through to the single-device fallback under test.
      fetchUserDevices: vi.fn().mockResolvedValue([]),
      fetchDeviceKeyPackage: vi.fn(),
      deleteDeviceMembership: vi.fn().mockResolvedValue(undefined),
      removeMemberDevice: vi.fn().mockResolvedValue(undefined),
      kickStaleDevice: vi.fn().mockResolvedValue(undefined),
      addMember: vi.fn(),
      updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
      registerMember: vi.fn().mockResolvedValue(undefined),
      sendWelcome: vi.fn().mockResolvedValue(undefined),
      sendCommit: vi.fn().mockResolvedValue(undefined),
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
      ...overrides,
    } as unknown as IMlsService;
  }

  const conversation = (): Conversation =>
    ({
      id: 'g1',
      contactName: 'g1',
      name: 'a::b',
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
    }) as Conversation;

  async function sweep(answer: unknown) {
    const mlsService = makeMls({
      fetchDeviceKeyPackage: vi.fn().mockResolvedValue(answer),
    } as Partial<IMlsService>);
    const log = vi.fn();
    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map<string, Conversation>([['g1', conversation()]]),
      requestReAdd: () => Promise.resolve(),
      log,
    });
    return { mlsService, lines: log.mock.calls.flat().join('\n') };
  }

  it('KEEPS the invitation when the server did not answer at all', async () => {
    const { mlsService, lines } = await sweep({ kind: 'unanswered', detail: 'HTTP 502' });

    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
    expect(lines).toContain('the server did not answer');
    expect(lines).toContain('HTTP 502');
    expect(lines).toContain('next sweep retries');
  });

  it('keeps it for an unreachable network too, which is the same non-answer', async () => {
    const { mlsService } = await sweep({ kind: 'unanswered', detail: 'unreachable: TypeError' });

    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
  });

  it('retires it on an answer, and says the device comes back when the answer is `expired`', async () => {
    const { mlsService, lines } = await sweep({ kind: 'none', reason: 'expired' });

    expect(mlsService.deleteDeviceMembership).toHaveBeenCalledWith('peer', 'peer-dev', 'g1');
    expect(lines).toContain('expired');
    expect(lines).toContain('returns by itself');
    // The word that made a temporary condition look permanent in every log that recorded it.
    expect(lines).not.toContain('deregistered');
  });

  it.each(['revoked', 'unregistered'] as const)(
    'retires it on `%s` and promises nothing about a return',
    async (reason) => {
      const { mlsService, lines } = await sweep({ kind: 'none', reason });

      expect(mlsService.deleteDeviceMembership).toHaveBeenCalledWith('peer', 'peer-dev', 'g1');
      expect(lines).toContain(reason);
      expect(lines).not.toContain('returns by itself');
    }
  );

  /** A server older than the reason field. The reading that cannot be wrong is the old one. */
  it('retires it on an unexplained 404, exactly as it did before the reason existed', async () => {
    const { mlsService, lines } = await sweep({ kind: 'none', reason: 'unspecified' });

    expect(mlsService.deleteDeviceMembership).toHaveBeenCalledWith('peer', 'peer-dev', 'g1');
    expect(lines).toContain('unspecified');
  });

  it('adds the device when there IS a package, which is the whole point of the fallback', async () => {
    const { mlsService, lines } = await sweep({
      kind: 'package',
      device: { deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) },
    });

    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
    expect(lines).toContain('KeyPackage retrieved via fallback');
  });
});
