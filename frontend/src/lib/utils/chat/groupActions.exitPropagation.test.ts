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
    expect(mlsService.forgetGroup).toHaveBeenCalledWith(G, 0);
    expect(mlsService.persistCheckpoint).toHaveBeenCalled();
  });

  it('returns normally once the delivery service answered the delete', async () => {
    const mlsService = createMlsServiceStub({
      deleteGroupOnServer: vi.fn().mockResolvedValue(undefined),
    });

    await expect(deleteGroupAndBroadcast({ mlsService, ...args })).resolves.toBeUndefined();
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
    expect(mlsService.forgetGroup).toHaveBeenCalledWith(G, 0);
  });
});

/**
 * THE NOTICE IS DELIVERED BEFORE THE MEMBERSHIP ENDS, AND ITS LOSS IS SAID (GRP-6, 2026-10-22).
 * `sendMessage` resolves on the delivery service's answer, so the server step must not start before
 * it settles; and a notice that fails is lost - the leave goes on - which used to leave no trace.
 */
describe('leaveGroupAndBroadcast - the memberLeft notice', () => {
  it('does not end the membership until the notice has been accepted', async () => {
    let accept!: () => void;
    const order: string[] = [];
    const mlsService = createMlsServiceStub({
      sendMessage: vi.fn(
        () =>
          new Promise((resolve) => {
            accept = () => {
              order.push('notice accepted');
              resolve({ sealed: new Uint8Array(), receivedAt: 1 });
            };
          })
      ),
      removeMemberFromServer: vi.fn(async () => {
        order.push('membership ended');
      }),
    });

    const leaving = leaveGroupAndBroadcast({ mlsService, ...args });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(order).toEqual([]);
    accept();
    await leaving;

    expect(order).toEqual(['notice accepted', 'membership ended']);
  });

  it('leaves anyway when the notice fails, and logs that it is lost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mlsService = createMlsServiceStub({
      sendMessage: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    });
    const lines: string[] = [];

    await leaveGroupAndBroadcast({ mlsService, ...args, log: (m) => lines.push(m) });

    expect(mlsService.removeMemberFromServer).toHaveBeenCalledWith(G, 'u1');
    expect(mlsService.forgetGroup).toHaveBeenCalledWith(G, 0);
    expect(lines).toContainEqual(
      expect.stringContaining('memberLeft notice for group-1… NOT delivered')
    );
    warn.mockRestore();
  });
});

describe('deleteGroupAndBroadcast - the groupDeleted notice', () => {
  it('deletes anyway when the notice fails, and logs that it is lost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mlsService = createMlsServiceStub({
      // The deleter holds the group, so the notice is attempted at all.
      getLocalGroups: vi.fn().mockReturnValue([G]),
      sendMessage: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    });
    const lines: string[] = [];

    await deleteGroupAndBroadcast({ mlsService, ...args, log: (m) => lines.push(m) });

    expect(mlsService.deleteGroupOnServer).toHaveBeenCalledWith(G);
    expect(lines).toContainEqual(
      expect.stringContaining('groupDeleted notice for group-1… NOT delivered')
    );
    warn.mockRestore();
  });
});
