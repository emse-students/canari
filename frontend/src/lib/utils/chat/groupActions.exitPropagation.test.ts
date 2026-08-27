/**
 * THE SERVER STEP OF AN EXIT MUST NOT BE SWALLOWED, AND THE LOCAL STEPS MUST RUN ANYWAY.
 *
 * DEL-10 kept failing after `pendingGroupExits` shipped because the classifier was installed one
 * layer OUT (`exitGroupAndCleanup`) while the helper it delegates to had already caught the failure
 * and returned normally - so the owed row was written and then cleared by the happy path, and prod
 * kept a group no client could open. These four cases pin both halves of the contract: the failure
 * reaches the caller, and it reaches it AFTER the purge rather than instead of it.
 */
import { deleteGroupAndBroadcast, leaveGroupAndBroadcast } from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

const G = 'group-1';
const args = { groupId: G, userId: 'u1', deviceKeyB64: 'dk' };

describe('deleteGroupAndBroadcast - the server failure', () => {
  it('rethrows what the server call threw, so the caller can classify it', async () => {
    const boom = new TypeError('Failed to fetch');
    const mlsService = createMlsServiceStub({
      deleteGroupOnServer: vi.fn().mockRejectedValue(boom),
    });

    await expect(deleteGroupAndBroadcast({ mlsService, ...args })).rejects.toBe(boom);
  });

  it('completes the LOCAL exit before rethrowing - the purge is unconditional by design', async () => {
    const mlsService = createMlsServiceStub({
      deleteGroupOnServer: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    });

    await expect(deleteGroupAndBroadcast({ mlsService, ...args })).rejects.toThrow();
    expect(mlsService.forgetGroup).toHaveBeenCalledWith(G);
    expect(mlsService.persistCheckpoint).toHaveBeenCalled();
  });

  it('treats a 404 as an ANSWER and returns normally', async () => {
    // `deleteGroupOnServer` maps 404 to `false`: the group is not there, which is the end state a
    // delete asks for. Nothing is owed, so nothing may be thrown.
    const mlsService = createMlsServiceStub({
      deleteGroupOnServer: vi.fn().mockResolvedValue(false),
    });
    const lines: string[] = [];

    await expect(
      deleteGroupAndBroadcast({ mlsService, ...args, log: (m) => lines.push(m) })
    ).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('not found on server'))).toBe(true);
  });
});

describe('leaveGroupAndBroadcast - the server failure', () => {
  it('rethrows it, where a bare catch used to hide it with no log at all', async () => {
    const boom = new TypeError('Failed to fetch');
    const mlsService = createMlsServiceStub({
      removeMemberFromServer: vi.fn().mockRejectedValue(boom),
    });

    await expect(leaveGroupAndBroadcast({ mlsService, ...args })).rejects.toBe(boom);
    // The local half still happened: this device is out whatever the server managed.
    expect(mlsService.forgetGroup).toHaveBeenCalledWith(G);
  });
});
