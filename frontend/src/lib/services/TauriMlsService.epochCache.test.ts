// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

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

/** A fake native manager: the groups it holds and the epoch of each, behind the real command names. */
function nativeManager(initial: Record<string, number>) {
  const groups = new Map(Object.entries(initial));
  invoke.mockImplementation(async (cmd: string, args?: { groupId?: string }) => {
    const id = args?.groupId ?? '';
    switch (cmd) {
      case 'recharger_mls_au_resume':
        return 'reloaded';
      case 'lister_groupes':
        return [...groups.keys()];
      case 'obtenir_epoch': {
        const epoch = groups.get(id);
        if (epoch === undefined) throw new Error(`GroupNotFound(${id})`);
        return epoch;
      }
      // A commit: the manager moves one epoch and there is no plaintext to hand back.
      case 'recevoir_message_bytes':
      case 'confirmer_commit':
        groups.set(id, (groups.get(id) ?? 0) + 1);
        return null;
      case 'groupe_actif':
        return true;
      default:
        return undefined;
    }
  });
  return groups;
}

interface Internals {
  _deviceKeyB64: string;
  reloadStateFromDisk(): Promise<void>;
  getEpoch(groupId: string): number;
  getLocalGroups(): string[];
  processIncomingMessage(groupId: string, bytes: Uint8Array): Promise<Uint8Array | null>;
  mergePendingCommit(groupId: string): Promise<void>;
  syncGroupCachesFromNative(): Promise<number>;
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

  it('re-reads the epochs when the resume installs mls.bin - the file may be ahead', async () => {
    const native = nativeManager({ 'kg-1': 56 });
    const svc = makeService();
    await svc.reloadStateFromDisk();
    native.set('kg-1', 60); // a background engine advanced the file while the app was away

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
