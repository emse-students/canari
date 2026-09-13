/**
 * ONE WAY THIS DEVICE STOPS HOLDING A GROUP, DRIVEN FROM THE PATHS RATHER THAN FROM THE FUNCTION.
 *
 * `dropGroupState` is trivially testable on its own, and a spec that only did that would pass on
 * exactly the defect this fusion exists to remove: a path that keeps its own `forgetGroup` and its
 * own idea of what goes with it never reaches the shared function, so no test of the shared
 * function can see it. So every case below enters through a PATH - the exported entry point a
 * caller really uses - and asserts the three things a drop owes, whichever path it came from:
 *
 *   1. the state is forgotten, at the floor that path means (`minEpoch`);
 *   2. the epoch gap - a claim about held state lagging - is gone with the state it described;
 *   3. the drop is durable, because `forgetGroup` mutates a store whose snapshot is written
 *      separately, and seven of the seventeen sites used to write none.
 */
import { markEpochGap, isInEpochGap, clearEpochGap } from './epochGapRegistry';
import { dropGroupState } from './dropGroupState';
import {
  deleteGroupAndBroadcast,
  leaveGroupAndBroadcast,
  forgetMlsGroupIfPresent,
} from './groupActions';
import { recoverForkedGroup, recoverRosterDisagreement, resetReAddCooldowns } from './recovery';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import type { IMlsService } from '$lib/mls-client/IMlsService';

const G = 'group-under-test';

/**
 * A stub that HOLDS `G`, and whose `forgetGroup` really stops holding it.
 *
 * Stateful on purpose: `recoverRosterDisagreement` re-enters `requestReAdd`, which returns at its
 * own "do we hold this?" guard, so a static `getLocalGroups` would make two of these cases pass
 * against a drop that dropped nothing.
 */
function holdingStub(overrides: Record<string, unknown> = {}): IMlsService {
  const held = new Set([G]);
  const stub = createMlsServiceStub({
    getLocalGroups: vi.fn(() => [...held]),
    forgetGroup: vi.fn((id: string) => {
      held.delete(id);
    }),
    // The distribution form is the one path that reaches the drop through the service itself.
    forgetDistributionGroupById: vi.fn(async (id: string) => {
      if (!held.has(id)) return false;
      await dropGroupState(stub, id, {
        reason: 'test: distribution group left',
        checkpoint: 'awaited',
      });
      return true;
    }),
    ...overrides,
  });
  return stub;
}

/** The deps `recovery.ts` reads on the way through a drop. */
function recoveryDeps(mlsService: IMlsService) {
  return {
    mlsService,
    userId: 'u1',
    deviceKeyB64: 'dk',
    conversations: new Map(),
    log: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    addMessageToChat: vi.fn().mockResolvedValue(undefined),
  } as never;
}

/**
 * THE PATHS. Each `run` is the real exported entry point, not a call to the drop.
 *
 * `minEpoch` is what that path MEANS by a floor, and it is the one thing the drop lets a caller
 * decide: 0 accepts any later Welcome, and the fork recovery passes the server's epoch so a Welcome
 * queued on the branch it has just abandoned cannot re-install it.
 */
const paths: {
  name: string;
  minEpoch: number;
  run: (mlsService: IMlsService) => Promise<unknown>;
}[] = [
  {
    name: 'a conversation deleted here',
    minEpoch: 0,
    run: (mlsService) =>
      deleteGroupAndBroadcast({ mlsService, groupId: G, userId: 'u1', deviceKeyB64: 'dk' }),
  },
  {
    name: 'a conversation left here',
    minEpoch: 0,
    run: (mlsService) =>
      leaveGroupAndBroadcast({ mlsService, groupId: G, userId: 'u1', deviceKeyB64: 'dk' }),
  },
  {
    name: 'a fork behind the server',
    minEpoch: 4,
    run: (mlsService) => recoverForkedGroup(G, recoveryDeps(mlsService), 4),
  },
  {
    name: 'a roster the server has no leaf in',
    minEpoch: 0,
    run: (mlsService) => recoverRosterDisagreement(G, recoveryDeps(mlsService)),
  },
  {
    name: 'a distribution group the server no longer lists',
    minEpoch: 0,
    run: (mlsService) => forgetMlsGroupIfPresent(mlsService, G),
  },
];

describe('every path drops group state the same way', () => {
  beforeEach(() => {
    resetReAddCooldowns();
    clearEpochGap(G);
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  for (const path of paths) {
    describe(path.name, () => {
      it(`forgets the state at minEpoch ${path.minEpoch}`, async () => {
        const mlsService = holdingStub();
        await path.run(mlsService).catch(() => {});

        expect(mlsService.forgetGroup).toHaveBeenCalledWith(G, path.minEpoch);
        expect(mlsService.getLocalGroups()).not.toContain(G);
      });

      it('takes the epoch gap with it, because the gap described the state', async () => {
        const mlsService = holdingStub();
        markEpochGap(G);
        expect(isInEpochGap(G)).toBe(true);

        await path.run(mlsService).catch(() => {});

        // Left behind, this entry refuses to encrypt in the group the device has just re-joined
        // cleanly, and keeps `anyEpochGapArmed` true for the rest of the session.
        expect(isInEpochGap(G)).toBe(false);
      });

      it('makes the drop durable, or the next load undoes it', async () => {
        const mlsService = holdingStub();
        await path.run(mlsService).catch(() => {});

        expect(mlsService.persistCheckpoint).toHaveBeenCalled();
      });
    });
  }

  it('drives five DISTINCT paths, not one path five times', () => {
    expect(new Set(paths.map((p) => p.run.toString())).size).toBe(paths.length);
    expect(new Set(paths.map((p) => p.name)).size).toBe(paths.length);
  });
});

describe('what the drop itself promises', () => {
  beforeEach(() => clearEpochGap(G));

  it('does not checkpoint state that was never durable', async () => {
    // `externalJoin` discarding a refused commit: the group was built in memory during that very
    // call and no checkpoint has run since, so there is nothing to undo - and a save here would
    // cost one per failed attempt, on the phone that can least afford it.
    const mlsService = createMlsServiceStub();
    await dropGroupState(mlsService, G, {
      reason: 'test: never persisted',
      checkpoint: 'never-persisted',
    });

    expect(mlsService.forgetGroup).toHaveBeenCalledWith(G, 0);
    expect(mlsService.persistCheckpoint).not.toHaveBeenCalled();
  });

  it('starts the checkpoint even when the caller does not wait for it', async () => {
    // `'deferred'` says the caller holds the MLS mutex, never that durability is optional.
    const mlsService = createMlsServiceStub();
    await dropGroupState(mlsService, G, {
      reason: 'test: under the mutex',
      checkpoint: 'deferred',
    });

    expect(mlsService.persistCheckpoint).toHaveBeenCalled();
  });

  it('clears the gap and checkpoints even when the forget throws', async () => {
    const mlsService = createMlsServiceStub({
      forgetGroup: vi.fn(() => {
        throw new Error('WASM is gone');
      }),
    });
    markEpochGap(G);
    const lines: string[] = [];

    await expect(
      dropGroupState(mlsService, G, {
        reason: 'test: the forget throws',
        checkpoint: 'awaited',
        log: (m) => lines.push(m),
      })
    ).resolves.toBeUndefined();

    // Never throws: a drop is part of a larger repair, and a caller that cannot forget the state
    // can do nothing about it. The failure is not silent either.
    expect(lines.some((l) => l.includes('FAILED') && l.includes('WASM is gone'))).toBe(true);
    expect(isInEpochGap(G)).toBe(false);
    expect(mlsService.persistCheckpoint).toHaveBeenCalled();
  });

  it('says which of the seventeen reasons it was', async () => {
    const mlsService = createMlsServiceStub();
    const lines: string[] = [];

    await dropGroupState(mlsService, G, {
      reason: 'lost the first-publish race',
      minEpoch: 7,
      checkpoint: 'never-persisted',
      log: (m) => lines.push(m),
    });

    // One line, and it carries the reason and the floor: a line saying only that a drop happened
    // sends the next reader back to the source to find out which path it was.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('lost the first-publish race');
    expect(lines[0]).toContain('minEpoch=7');
  });
});
