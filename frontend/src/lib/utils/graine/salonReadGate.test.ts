const leadership = vi.hoisted(() => ({ value: 'leader' as 'leader' | 'follower' | 'undecided' }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => leadership.value }));

import { GroupDrainAbandonedError, type IMlsService } from '$lib/mls-client/IMlsService';
import { registerChannelWorkspace, setGraineRuntime } from './runtime';
import { whenSalonKeysDrained } from './salonReadGate';

const SALON = '7d2f0aa0-0000-4000-8000-000000000001';
const WORKSPACE = 'ws-1';
const KEY_GROUP = 'kg-0001-community';

/** A drain this test settles by hand: the event `whenGroupDrained` stands for. */
function drainStub(opts: { drainedNow?: boolean; groupId?: string | null } = {}) {
  let settle!: { resolve: () => void; reject: (e: Error) => void };
  const whenGroupDrained = vi.fn(
    () => new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
  );
  const mlsService = {
    distributionGroupFor: vi.fn(() => (opts.groupId === undefined ? KEY_GROUP : opts.groupId)),
    isGroupDrained: vi.fn(() => opts.drainedNow ?? false),
    whenGroupDrained,
  } as unknown as IMlsService;
  return { mlsService, whenGroupDrained, settle: () => settle };
}

function install(mlsService: IMlsService) {
  setGraineRuntime({ storage: {} as never, deviceKey: () => 'k', userId: 'u1', mlsService });
  registerChannelWorkspace(SALON, WORKSPACE, false);
}

/**
 * A SALON PAGE IS DECODED AFTER ITS KEY GROUP'S DRAIN, NEVER BEFORE IT (1.6.11 logs, 2026-11-14):
 * a seed the drain is still applying made every row of its session read `missing seed`.
 */
describe('whenSalonKeysDrained', () => {
  beforeEach(() => {
    leadership.value = 'leader';
  });
  afterEach(() => setGraineRuntime(null));

  it('holds the read until the key group drains, and not a tick less', async () => {
    const stub = drainStub();
    install(stub.mlsService);
    let answer: unknown = null;
    const gate = whenSalonKeysDrained(`channel_${SALON}`).then((a) => (answer = a));

    await Promise.resolve();
    await Promise.resolve();
    expect(stub.whenGroupDrained).toHaveBeenCalledWith(KEY_GROUP);
    expect(answer).toBeNull();

    stub.settle().resolve();
    await gate;
    expect(answer).toEqual({ kind: 'drained', groupId: KEY_GROUP, waited: true });
  });

  it('answers at once when the key group is drained already', async () => {
    const stub = drainStub({ drainedNow: true });
    install(stub.mlsService);
    await expect(whenSalonKeysDrained(SALON)).resolves.toEqual({
      kind: 'drained',
      groupId: KEY_GROUP,
      waited: false,
    });
    expect(stub.whenGroupDrained).not.toHaveBeenCalled();
  });

  it('a follower tab does not wait: it drains nothing, so the wait would never end', async () => {
    leadership.value = 'follower';
    const stub = drainStub();
    install(stub.mlsService);
    await expect(whenSalonKeysDrained(SALON)).resolves.toEqual({
      kind: 'unwaited',
      reason: 'follower',
    });
    expect(stub.whenGroupDrained).not.toHaveBeenCalled();
  });

  it('a salon no community registered, or a key group not registered here, is not waited for', async () => {
    const stub = drainStub({ groupId: null });
    install(stub.mlsService);
    await expect(whenSalonKeysDrained(SALON)).resolves.toEqual({
      kind: 'unwaited',
      reason: 'key-group-unregistered',
    });
    await expect(whenSalonKeysDrained('another-salon')).resolves.toEqual({
      kind: 'unwaited',
      reason: 'no-scope',
    });
    expect(stub.whenGroupDrained).not.toHaveBeenCalled();
  });

  it('without a session there is nothing to wait for', async () => {
    await expect(whenSalonKeysDrained(SALON)).resolves.toEqual({
      kind: 'unwaited',
      reason: 'no-runtime',
    });
  });

  it('a service closed before the drain releases the read rather than holding it for ever', async () => {
    const stub = drainStub();
    install(stub.mlsService);
    const gate = whenSalonKeysDrained(SALON);
    await vi.waitFor(() => expect(stub.whenGroupDrained).toHaveBeenCalled());
    stub.settle().reject(new GroupDrainAbandonedError(KEY_GROUP));
    await expect(gate).resolves.toEqual({ kind: 'unwaited', reason: 'closed' });
  });
});
