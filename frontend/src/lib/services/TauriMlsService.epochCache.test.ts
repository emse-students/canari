// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', () => ({ getToken: vi.fn().mockResolvedValue('') }));

import { TauriMlsService } from './TauriMlsService';
import { isInEpochGap, resetEpochGapRegistry } from '$lib/utils/chat/epochGapRegistry';

/**
 * `getEpoch` on the native app is a CACHE, and it must say what the native manager says.
 *
 * Production 2026-10-09: 449 key-group re-joins in six days, 378 from native apps, every one at the
 * head of a commit log whose previous commit was the same device's own join - the device was
 * current, and re-joined anyway. The cache was never filled at start-up, so a held key group read
 * as epoch 0; `verifyDistributionEpoch` then saw it 56 epochs behind its server, asked the commit
 * log `sinceEpoch=0` (seen in the edge log, every few minutes, for groups joined minutes earlier),
 * the replay broke on the epoch-0 commit, the gap stayed armed - so every seal was refused - and the
 * sync watchdog re-joined 45 s later. The cache also lagged every applied commit until the queue's
 * post-callback hook, so a replay comparing `getEpoch` with its target could not see its own work.
 */

/** Resolves on the next macrotask - later than any chain of microtasks a caller could await. */
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A fake native manager: the groups it holds and the epoch of each, behind the real command names.
 *
 * Like the real one it answers from the state AT THE MOMENT a call is issued (native calls run in
 * issue order), and it answers an epoch read only after a MACROTASK, so a caller that does not await
 * its refresh is caught reading the old value. `hold(cmd)` parks the next call of `cmd` until
 * `release(cmd)`, which is how the tests below put work in the middle of a sync.
 */
function nativeManager(initial: Record<string, number>) {
  const groups = new Map(Object.entries(initial));
  const toHold = new Map<string, number>();
  const parked = new Map<string, Array<() => void>>();
  const answer = async <T>(cmd: string, value: () => T): Promise<T> => {
    const result = (() => {
      try {
        return { ok: true as const, value: value() };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    if ((toHold.get(cmd) ?? 0) > 0) {
      toHold.set(cmd, toHold.get(cmd)! - 1);
      await new Promise<void>((resolve) => parked.set(cmd, [...(parked.get(cmd) ?? []), resolve]));
    } else if (cmd === 'obtenir_epoch') {
      await macrotask();
    }
    if (!result.ok) throw result.error;
    return result.value;
  };
  invoke.mockImplementation((cmd: string, args?: { groupId?: string }) => {
    const id = args?.groupId ?? '';
    switch (cmd) {
      case 'recharger_mls_au_resume':
        return answer(cmd, () => 'reloaded');
      case 'lister_groupes':
        return answer(cmd, () => [...groups.keys()]);
      case 'obtenir_epoch':
        return answer(cmd, () => {
          const epoch = groups.get(id);
          if (epoch === undefined) throw new Error(`GroupNotFound(${id})`);
          return epoch;
        });
      case 'creer_groupe':
        return answer(cmd, () => void groups.set(id, 0));
      case 'oublier_groupe':
        return answer(cmd, () => void groups.delete(id));
      // A commit: the manager moves one epoch and there is no plaintext to hand back.
      case 'recevoir_message_bytes':
      case 'confirmer_commit':
        return answer(cmd, () => {
          groups.set(id, (groups.get(id) ?? 0) + 1);
          return null;
        });
      case 'groupe_actif':
        return answer(cmd, () => true);
      default:
        return answer(cmd, () => undefined);
    }
  });
  return {
    groups,
    hold(cmd: string) {
      toHold.set(cmd, (toHold.get(cmd) ?? 0) + 1);
    },
    /** Lets every parked call of `cmd` answer, then waits until each has. */
    async release(cmd: string) {
      for (const resolve of parked.get(cmd) ?? []) resolve();
      parked.delete(cmd);
      await macrotask();
      await macrotask();
    },
    /** Waits until a call of `cmd` is parked. */
    async parkedOn(cmd: string) {
      while (!(parked.get(cmd)?.length ?? 0)) await macrotask();
    },
  };
}

interface Internals {
  _deviceKeyB64: string;
  reloadStateFromDisk(): Promise<void>;
  getEpoch(groupId: string): number;
  getLocalGroups(): string[];
  processIncomingMessage(groupId: string, bytes: Uint8Array): Promise<Uint8Array | null>;
  mergePendingCommit(groupId: string): Promise<void>;
  syncGroupCachesFromNative(): Promise<number>;
  createGroup(groupId: string): Promise<void>;
  forgetGroup(groupId: string): void;
  deviceId: string;
  _initImpl(
    userId: string,
    deviceKeyB64: string,
    state?: Uint8Array,
    opts?: { stateOnDisk?: boolean }
  ): Promise<void>;
  verifyDistributionEpoch(groupId: string, activeEpoch: number): Promise<string>;
  onDistributionGapVerdict(listener: ((g: string, v: string) => void) | null): void;
  initialDrain: Promise<void>;
  waitForGroupQueueIdle: () => Promise<void>;
  delivery: { fetchCommitsSince: ReturnType<typeof vi.fn> };
}

function makeService(): Internals {
  const svc = new TauriMlsService() as unknown as Internals;
  svc._deviceKeyB64 = 'a'.repeat(44);
  return svc;
}

describe('TauriMlsService - the epoch cache says what the native manager says', () => {
  beforeEach(() => {
    invoke.mockReset();
    resetEpochGapRegistry();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('knows the epoch of every group held at start-up, not 0', async () => {
    nativeManager({ 'kg-1': 56, 'kg-2': 127 });
    const svc = makeService();
    await svc.syncGroupCachesFromNative();

    expect(svc.getLocalGroups().sort()).toEqual(['kg-1', 'kg-2']);
    expect(svc.getEpoch('kg-1')).toBe(56);
    expect(svc.getEpoch('kg-2')).toBe(127);
  });

  it('knows them after a real start-up - init itself fills the cache', async () => {
    nativeManager({ 'kg-1': 56 });
    localStorage.clear();
    const svc = makeService();
    svc.deviceId = 'device-1';
    await svc._initImpl('user-1', 'k'.repeat(44), undefined, { stateOnDisk: true });

    expect(svc.getLocalGroups()).toEqual(['kg-1']);
    expect(svc.getEpoch('kg-1')).toBe(56);
  });

  it('re-reads the epochs when the resume installs mls.bin - the file may be ahead', async () => {
    const native = nativeManager({ 'kg-1': 56 });
    const svc = makeService();
    await svc.reloadStateFromDisk();
    native.groups.set('kg-1', 60); // a background engine advanced the file while the app was away

    await svc.reloadStateFromDisk();
    expect(svc.getEpoch('kg-1')).toBe(60);
  });

  it('moves the epoch with a commit BEFORE processIncomingMessage returns', async () => {
    nativeManager({ 'kg-1': 56 });
    const svc = makeService();
    await svc.reloadStateFromDisk();

    await svc.processIncomingMessage('kg-1', new Uint8Array([1]));
    // The commit replay reads this on its very next line to decide whether it reached its target.
    expect(svc.getEpoch('kg-1')).toBe(57);
  });

  it('moves the epoch with a merged commit before mergePendingCommit resolves', async () => {
    nativeManager({ 'kg-1': 56 });
    const svc = makeService();
    await svc.reloadStateFromDisk();

    await svc.mergePendingCommit('kg-1');
    expect(svc.getEpoch('kg-1')).toBe(57);
  });

  it('a held key group at its server epoch is CURRENT after a cold start - no replay from 0, no gap', async () => {
    nativeManager({ 'kg-1': 56 });
    const svc = makeService();
    await svc.reloadStateFromDisk();
    svc.initialDrain = Promise.resolve();
    svc.waitForGroupQueueIdle = vi.fn().mockResolvedValue(undefined);
    svc.delivery.fetchCommitsSince = vi.fn().mockResolvedValue({
      commits: [{ baseEpoch: 0, proto: 'AA==' }],
      activeEpoch: 56,
      belowFloor: false,
    });
    const listener = vi.fn();
    svc.onDistributionGapVerdict(listener);

    const verdict = await svc.verifyDistributionEpoch('kg-1', 56);

    expect(verdict).toBe('current');
    // The edge log of 2026-10-09 showed exactly this read, for groups joined minutes earlier.
    expect(svc.delivery.fetchCommitsSince).not.toHaveBeenCalled();
    // Armed, it refuses every seal for the scope and hands the group to the watchdog's re-join.
    expect(isInEpochGap('kg-1')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('TauriMlsService - a sync never overwrites what landed while it ran', () => {
  beforeEach(() => {
    invoke.mockReset();
    resetEpochGapRegistry();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a commit applied mid-sync is not lowered by the sync reading started before it', async () => {
    const native = nativeManager({ 'kg-1': 56 });
    const svc = makeService();
    native.hold('obtenir_epoch'); // the sync's own reading of kg-1: 56
    const sync = svc.syncGroupCachesFromNative();
    await native.parkedOn('obtenir_epoch');

    await svc.processIncomingMessage('kg-1', new Uint8Array([1]));
    expect(svc.getEpoch('kg-1')).toBe(57);

    await native.release('obtenir_epoch');
    await sync;
    expect(svc.getEpoch('kg-1')).toBe(57);
  });

  it('a group created mid-sync keeps its entry, though the listing predates it', async () => {
    const native = nativeManager({ 'kg-1': 56 });
    const svc = makeService();
    native.hold('lister_groupes'); // answers ['kg-1']
    const sync = svc.syncGroupCachesFromNative();
    await native.parkedOn('lister_groupes');

    await svc.createGroup('kg-new');
    await svc.mergePendingCommit('kg-new');

    await native.release('lister_groupes');
    await sync;
    expect(svc.getLocalGroups().sort()).toEqual(['kg-1', 'kg-new']);
    // 0 here is the false gap: a held key group the server has ahead, read as never joined.
    expect(svc.getEpoch('kg-new')).toBe(1);
    expect(svc.getEpoch('kg-1')).toBe(56);
  });

  it('a group forgotten mid-sync is not brought back by the listing that still named it', async () => {
    const native = nativeManager({ 'kg-1': 56, 'kg-2': 12 });
    const svc = makeService();
    await svc.syncGroupCachesFromNative();
    native.hold('lister_groupes'); // answers ['kg-1', 'kg-2']
    const sync = svc.syncGroupCachesFromNative();
    await native.parkedOn('lister_groupes');

    svc.forgetGroup('kg-2');

    await native.release('lister_groupes');
    await sync;
    expect(svc.getLocalGroups()).toEqual(['kg-1']);
    expect(svc.getEpoch('kg-2')).toBe(0);
  });

  it('a group gone from the native manager leaves both caches', async () => {
    const native = nativeManager({ 'kg-1': 56, 'kg-2': 12 });
    const svc = makeService();
    await svc.syncGroupCachesFromNative();
    native.groups.delete('kg-2');

    await svc.syncGroupCachesFromNative();
    expect(svc.getLocalGroups()).toEqual(['kg-1']);
    expect(svc.getEpoch('kg-2')).toBe(0);
  });
});
