import type { IStorage, PendingGroupExit } from '$lib/db/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { GroupExitRefusedError } from '$lib/mls-client/mlsDeliveryApi';
import { connectivity } from '$lib/stores/connectivity.svelte';
import {
  classifyExitFailure,
  clearPendingGroupExit,
  drainPendingGroupExits,
  flushPendingGroupExits,
  pendingGroupExitIds,
  recordPendingGroupExit,
  registerPendingGroupExitDrain,
  resetDrainGuardForTests,
  unregisterPendingGroupExitDrain,
} from './pendingGroupExits';

/**
 * A storage holding only the pending-exit table, because that is the whole of what this module
 * touches. Rows live in a Map so the tests can assert on what SURVIVED rather than on the calls
 * made - a drain that calls `delete` and leaves the row is the failure mode that matters.
 */
function makeStorage(seed: PendingGroupExit[] = []) {
  const rows = new Map(seed.map((e) => [e.groupId, e]));
  return {
    rows,
    savePendingGroupExit: vi.fn(async (e: PendingGroupExit) => {
      rows.set(e.groupId, e);
    }),
    getPendingGroupExits: vi.fn(async () =>
      [...rows.values()].sort((a, b) => a.requestedAt - b.requestedAt)
    ),
    deletePendingGroupExit: vi.fn(async (groupId: string) => {
      rows.delete(groupId);
    }),
  } as unknown as IStorage & { rows: Map<string, PendingGroupExit> };
}

function makeMls(over: Partial<IMlsService> = {}) {
  return {
    deleteGroupOnServer: vi.fn(async () => true),
    removeMemberFromServer: vi.fn(async () => undefined),
    dismissGroup: vi.fn(async () => undefined),
    ...over,
  } as unknown as IMlsService;
}

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const NET = new TypeError('Failed to fetch');

beforeEach(() => {
  resetDrainGuardForTests();
  unregisterPendingGroupExitDrain();
});

describe('classifyExitFailure', () => {
  // 403 and 404 are the two answers that mean the end state is already reached, and the reason the
  // drain and `exitGroupAndCleanup` must not each hold their own copy of that reading.
  it('reads 404 and 403 as the exit having already happened', () => {
    expect(classifyExitFailure(new GroupExitRefusedError(G1, 404, 'delete'))).toBe('already-gone');
    expect(classifyExitFailure(new GroupExitRefusedError(G1, 403, 'leave'))).toBe('already-gone');
  });

  it('reads any other status as a reachable server refusing', () => {
    expect(classifyExitFailure(new GroupExitRefusedError(G1, 500, 'delete'))).toBe('refused');
    expect(classifyExitFailure(new GroupExitRefusedError(G1, 409, 'leave'))).toBe('refused');
  });

  it('reads a transport failure as no answer at all', () => {
    expect(classifyExitFailure(NET)).toBe('unreachable');
    expect(classifyExitFailure(new Error('network is unreachable'))).toBe('unreachable');
  });

  // A bug in this path throws too, and calling that "the network" would keep a row for ever while
  // blaming the link. It is a refusal: kept, and named as something to find.
  it('does not call a plain programming error a network problem', () => {
    expect(classifyExitFailure(new RangeError('index out of range'))).toBe('refused');
    expect(classifyExitFailure('a string nobody typed')).toBe('refused');
  });
});

describe('recording and reading what is owed', () => {
  it('writes one row per group, so deciding twice cannot queue two calls', async () => {
    const storage = makeStorage();
    await recordPendingGroupExit(storage, G1, 'delete', () => {});
    await recordPendingGroupExit(storage, G1, 'delete', () => {});
    expect(storage.rows.size).toBe(1);
    expect(await pendingGroupExitIds(storage)).toEqual(new Set([G1]));
  });

  it('says so in the log when there is no storage to record into', async () => {
    const lines: string[] = [];
    await recordPendingGroupExit(null, G1, 'delete', (m) => lines.push(m));
    // The exit proceeds without a row - but that loss is the one thing a later reader needs.
    expect(lines.join('\n')).toContain('NOT recorded durably');
  });

  it('reports nothing owed when storage cannot be read, rather than inventing ids', async () => {
    const storage = {
      getPendingGroupExits: vi.fn(async () => {
        throw new Error('store closed');
      }),
    } as unknown as IStorage;
    expect(await pendingGroupExitIds(storage)).toEqual(new Set());
  });

  it('survives a delete that throws, because the exit itself is already done', async () => {
    const lines: string[] = [];
    const storage = {
      deletePendingGroupExit: vi.fn(async () => {
        throw new Error('store closed');
      }),
    } as unknown as IStorage;
    await clearPendingGroupExit(storage, G1, (m) => lines.push(m));
    expect(lines.join('\n')).toContain('could not clear its pending row');
  });
});

describe('drainPendingGroupExits', () => {
  it('replays a delete and clears the row on the answer', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'delete', requestedAt: 1 }]);
    const mlsService = makeMls();
    const out = await drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: () => {} });
    expect(mlsService.deleteGroupOnServer).toHaveBeenCalledWith(G1);
    expect(mlsService.dismissGroup).toHaveBeenCalledWith(G1);
    expect(out).toEqual([{ groupId: G1, kind: 'delete', result: 'answered' }]);
    expect(storage.rows.size).toBe(0);
  });

  it('replays a leave as a self-removal', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'leave', requestedAt: 1 }]);
    const mlsService = makeMls();
    await drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: () => {} });
    expect(mlsService.removeMemberFromServer).toHaveBeenCalledWith(G1, 'u1');
    expect(storage.rows.size).toBe(0);
  });

  // THE DEFECT ITSELF: the row is what makes the lost deletion recoverable, so a server that never
  // answered must leave it exactly where it was.
  it('keeps the row when the server never answered', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'delete', requestedAt: 1 }]);
    const mlsService = makeMls({
      deleteGroupOnServer: vi.fn(async () => {
        throw NET;
      }),
    });
    const out = await drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: () => {} });
    expect(out).toEqual([{ groupId: G1, kind: 'delete', result: 'kept' }]);
    expect(storage.rows.get(G1)).toBeDefined();
  });

  it('keeps the row when a reachable server refuses, and says which of the two it was', async () => {
    const lines: string[] = [];
    const storage = makeStorage([{ groupId: G1, kind: 'leave', requestedAt: 1 }]);
    const mlsService = makeMls({
      removeMemberFromServer: vi.fn(async () => {
        throw new GroupExitRefusedError(G1, 500, 'leave');
      }),
    });
    const out = await drainPendingGroupExits({
      storage,
      mlsService,
      userId: 'u1',
      log: (m) => lines.push(m),
    });
    expect(out[0].result).toBe('kept');
    expect(storage.rows.get(G1)).toBeDefined();
    expect(lines.join('\n')).toContain('REFUSED by a reachable server');
    expect(lines.join('\n')).not.toContain('still unreachable');
  });

  // The re-entrancy safety net: a second pass over an already-landed call asks for a group that is
  // gone, and the 404 that comes back is what finally clears the row.
  it('clears the row when the server says the group is already gone', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'delete', requestedAt: 1 }]);
    const mlsService = makeMls({
      deleteGroupOnServer: vi.fn(async () => {
        throw new GroupExitRefusedError(G1, 404, 'delete');
      }),
    });
    const out = await drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: () => {} });
    expect(out).toEqual([{ groupId: G1, kind: 'delete', result: 'answered' }]);
    expect(storage.rows.size).toBe(0);
  });

  it('does not keep a row because the per-user dismiss failed - the exit was answered', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'delete', requestedAt: 1 }]);
    const mlsService = makeMls({
      dismissGroup: vi.fn(async () => {
        throw NET;
      }),
    });
    const out = await drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: () => {} });
    expect(out[0].result).toBe('answered');
    expect(storage.rows.size).toBe(0);
  });

  it('replays every owed exit, not just the first', async () => {
    const storage = makeStorage([
      { groupId: G1, kind: 'delete', requestedAt: 1 },
      { groupId: G2, kind: 'leave', requestedAt: 2 },
    ]);
    const mlsService = makeMls();
    const out = await drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: () => {} });
    expect(out.map((o) => o.groupId)).toEqual([G1, G2]);
    expect(storage.rows.size).toBe(0);
  });

  // A flapping link fires the trigger repeatedly; two in-flight copies of the same call is what the
  // guard exists to prevent.
  it('makes one call when two drains overlap', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'delete', requestedAt: 1 }]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mlsService = makeMls({
      deleteGroupOnServer: vi.fn(async () => {
        await gate;
        return true;
      }),
    });
    const first = drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: () => {} });
    const second = await drainPendingGroupExits({
      storage,
      mlsService,
      userId: 'u1',
      log: () => {},
    });
    expect(second).toEqual([]);
    release();
    await first;
    expect(mlsService.deleteGroupOnServer).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when nothing is owed', async () => {
    const storage = makeStorage();
    const mlsService = makeMls();
    expect(
      await drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: () => {} })
    ).toEqual([]);
    expect(mlsService.deleteGroupOnServer).not.toHaveBeenCalled();
  });

  it('replays nothing when the owed rows cannot be read', async () => {
    const lines: string[] = [];
    const storage = {
      getPendingGroupExits: vi.fn(async () => {
        throw new Error('store closed');
      }),
    } as unknown as IStorage;
    const mlsService = makeMls();
    await drainPendingGroupExits({ storage, mlsService, userId: 'u1', log: (m) => lines.push(m) });
    expect(mlsService.deleteGroupOnServer).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('pending exits unreadable');
  });
});

describe('the session lifecycle', () => {
  afterEach(() => {
    unregisterPendingGroupExitDrain();
  });

  it('replays on reconnect, which is an event and not a clock', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'delete', requestedAt: 1 }]);
    const mlsService = makeMls();
    registerPendingGroupExitDrain({
      getStorage: () => storage,
      ensureMls: () => mlsService,
      getUserId: () => 'u1',
      log: () => {},
    });
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    await vi.waitFor(() => expect(mlsService.deleteGroupOnServer).toHaveBeenCalledWith(G1));
  });

  // An app killed while offline comes back with the link already up: no `online` edge ever fires
  // for the exit it owes, which is why the startup pass is not redundant with the listener.
  it('replays on the explicit startup pass too', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'leave', requestedAt: 1 }]);
    const mlsService = makeMls();
    registerPendingGroupExitDrain({
      getStorage: () => storage,
      ensureMls: () => mlsService,
      getUserId: () => 'u1',
      log: () => {},
    });
    expect(await flushPendingGroupExits()).toEqual([
      { groupId: G1, kind: 'leave', result: 'answered' },
    ]);
  });

  // A listener left behind by a logout would replay one user's exits with the next user's token.
  it('replays nothing once the session is gone', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'delete', requestedAt: 1 }]);
    const mlsService = makeMls();
    registerPendingGroupExitDrain({
      getStorage: () => storage,
      ensureMls: () => mlsService,
      getUserId: () => 'u1',
      log: () => {},
    });
    unregisterPendingGroupExitDrain();
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    expect(await flushPendingGroupExits()).toEqual([]);
    expect(mlsService.deleteGroupOnServer).not.toHaveBeenCalled();
  });

  it('waits for a user id rather than replaying for nobody', async () => {
    const storage = makeStorage([{ groupId: G1, kind: 'delete', requestedAt: 1 }]);
    const mlsService = makeMls();
    registerPendingGroupExitDrain({
      getStorage: () => storage,
      ensureMls: () => mlsService,
      getUserId: () => '',
      log: () => {},
    });
    expect(await flushPendingGroupExits()).toEqual([]);
    expect(mlsService.deleteGroupOnServer).not.toHaveBeenCalled();
  });
});
