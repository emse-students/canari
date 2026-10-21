import { withMlsBulkIngest } from './mlsBulkIngest';
import { createMlsStatePersister, type MlsStatePersister } from './mlsStatePersister';
import {
  registerMlsStatePersister,
  unregisterMlsStatePersister,
} from './mlsStatePersisterRegistry';
import { flushMacrotask } from '../../test/flush';

vi.mock('$lib/utils/scheduling/yieldToMainThread', () => ({
  yieldToMainThread: vi.fn().mockResolvedValue(undefined),
}));

const noCommit = () => {};

describe('withMlsBulkIngest', () => {
  function makeService() {
    const calls: string[] = [];
    return {
      calls,
      beginBulkIngest: vi.fn(() => {
        calls.push('begin');
        return 7;
      }),
      endBulkIngest: vi.fn(async (_handle: number) => {
        calls.push('end');
      }),
    };
  }

  afterEach(() => {
    unregisterMlsStatePersister();
  });

  it('closes the window it opened, by its handle', async () => {
    const svc = makeService();
    await withMlsBulkIngest(svc, async () => undefined, noCommit);
    expect(svc.endBulkIngest).toHaveBeenCalledWith(7);
  });

  it('opens before and closes after fn, returning its value', async () => {
    const svc = makeService();
    const result = await withMlsBulkIngest(
      svc,
      async () => {
        svc.calls.push('fn');
        return 42;
      },
      noCommit
    );
    expect(result).toBe(42);
    expect(svc.calls).toEqual(['begin', 'fn', 'end']);
  });

  it('closes the window even when fn throws, re-throws, and commits nothing', async () => {
    const svc = makeService();
    const commit = vi.fn();
    await expect(
      withMlsBulkIngest(
        svc,
        async () => {
          throw new Error('boom');
        },
        commit
      )
    ).rejects.toThrow('boom');
    await flushMacrotask();
    expect(svc.beginBulkIngest).toHaveBeenCalledTimes(1);
    expect(svc.endBulkIngest).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('awaits endBulkIngest before resolving', async () => {
    const svc = makeService();
    let endResolved = false;
    svc.endBulkIngest.mockImplementation(async () => {
      await flushMacrotask();
      endResolved = true;
    });
    await withMlsBulkIngest(svc, async () => undefined, noCommit);
    expect(endResolved).toBe(true);
  });

  it('withholds the commit when no persister is registered - nothing would checkpoint the window', async () => {
    const svc = makeService();
    const commit = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withMlsBulkIngest(svc, async () => 'marks', commit);
    await flushMacrotask();
    expect(commit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no state persister registered'));
    error.mockRestore();
  });

  /**
   * THE MARKERS FOLLOW THE CHECKPOINT, NOT THE CLOSE (2026-10-21).
   *
   * The persister's `onBulkIngestEnd` STARTS the checkpoint and returns - durability must not gate
   * delivery - so "after `endBulkIngest` resolved" is not "after the state is on disk". A history
   * replay's cursor written there is ahead of the ratchet for one whole checkpoint, and a kill in
   * that window reloads a cursor past frames the state never applied. These cases drive the REAL
   * persister as a bulk-ingest observer, with a checkpoint whose landing the test controls.
   */
  describe('with the real persister observing the window', () => {
    function rig() {
      const releases: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
      const persistCheckpoint = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            releases.push({ resolve, reject });
          })
      );
      const persister: MlsStatePersister = createMlsStatePersister({
        mlsService: { persistCheckpoint } as any,
      });
      registerMlsStatePersister(persister);
      let next = 1;
      const open = new Map<number, true>();
      const svc = {
        beginBulkIngest: vi.fn(() => {
          const handle = next++;
          open.set(handle, true);
          persister.onBulkIngestStart();
          return handle;
        }),
        // As `BaseMlsService.endBulkIngest`: awaits every observer, swallows what they throw.
        endBulkIngest: vi.fn(async (handle: number) => {
          if (!open.delete(handle)) return;
          await persister.onBulkIngestEnd().catch(() => {});
        }),
      };
      return {
        svc,
        persister,
        persistCheckpoint,
        land: async () => {
          releases.shift()?.resolve();
          await flushMacrotask();
        },
        fail: async () => {
          releases.shift()?.reject(new Error('disk full'));
          await flushMacrotask();
        },
      };
    }

    it('does NOT run the commit before the checkpoint started at the close has landed', async () => {
      const r = rig();
      const commit = vi.fn();

      await withMlsBulkIngest(r.svc, async () => 'cursor', commit);
      await flushMacrotask();

      // The window is closed and the caller has its value; the checkpoint is still on its way.
      expect(r.persistCheckpoint).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();

      await r.land();
      expect(commit).toHaveBeenCalledWith('cursor');
      // One checkpoint: the close's own, not a second one for the barrier.
      expect(r.persistCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('never runs the commit when that checkpoint FAILS - the markers stay behind the state', async () => {
      const r = rig();
      const commit = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await withMlsBulkIngest(r.svc, async () => 'cursor', commit);
      await r.fail();

      expect(commit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('progress markers withheld'));
      warn.mockRestore();
    });

    it('closing INSIDE a live drain still waits for a checkpoint that holds the replay', async () => {
      // The drain's window is open around the replay's, so the replay's close returns at depth 1
      // and the persister starts NOTHING there. The commit used to run at once in that case, with
      // no checkpoint even started.
      const r = rig();
      const commit = vi.fn();
      const drain = r.svc.beginBulkIngest();

      await withMlsBulkIngest(r.svc, async () => 'cursor', commit);
      await flushMacrotask();
      expect(r.persistCheckpoint).toHaveBeenCalledTimes(1); // started by the barrier itself
      expect(commit).not.toHaveBeenCalled();

      await r.land();
      expect(commit).toHaveBeenCalledWith('cursor');

      await r.svc.endBulkIngest(drain);
      await r.land();
    });

    it('waits for the NEXT checkpoint when one that exported before the replay is still running', async () => {
      const r = rig();
      const commit = vi.fn();
      r.persister.scheduleDeferred();
      void r.persister.flush(); // checkpoint A exports the state before the replay
      await flushMacrotask();

      await withMlsBulkIngest(r.svc, async () => 'cursor', commit);
      await r.land(); // A lands: it does not hold the replay
      expect(commit).not.toHaveBeenCalled();

      await r.land(); // B lands: it started after the replay ended
      expect(r.persistCheckpoint).toHaveBeenCalledTimes(2);
      expect(commit).toHaveBeenCalledWith('cursor');
    });
  });
});
