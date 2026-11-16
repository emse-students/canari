const leadership = vi.hoisted(() => ({
  value: 'leader' as 'leader' | 'follower' | 'undecided',
  handlers: new Set<(why: string) => void>(),
}));
vi.mock('$lib/mls-client/tabLeader', () => ({
  getTabLeadership: () => leadership.value,
  onLeaderTabChanged: (handler: (why: string) => void) => {
    leadership.handlers.add(handler);
    return () => leadership.handlers.delete(handler);
  },
}));

import { GroupDrainAbandonedError, type IMlsService } from '$lib/mls-client/IMlsService';
import { registerChannelWorkspace, setGraineRuntime } from './runtime';
import { salonKeysNow, type SalonKeysDraining } from './salonReadGate';

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

function draining(channelId: string): SalonKeysDraining {
  const keys = salonKeysNow(channelId);
  if (keys.kind !== 'draining') throw new Error(`expected draining, got ${keys.kind}`);
  return keys;
}

/**
 * A SALON ROW WITH NO SEED IS READ AFTER ITS KEY GROUP'S DRAIN, NEVER BEFORE IT (1.6.11 logs,
 * 2026-11-14): a seed the drain is still applying made every row of its session read `missing seed`.
 */
describe('salonKeysNow', () => {
  beforeEach(() => {
    leadership.value = 'leader';
    leadership.handlers.clear();
  });
  afterEach(() => setGraineRuntime(null));

  it('a key group still draining is said from state, and no waiter is registered until asked', async () => {
    const stub = drainStub();
    install(stub.mlsService);
    const keys = draining(`channel_${SALON}`);
    expect(keys.groupId).toBe(KEY_GROUP);
    expect(stub.whenGroupDrained).not.toHaveBeenCalled();

    let answer: unknown = null;
    const gate = keys.drained().then((a) => (answer = a));
    await Promise.resolve();
    await Promise.resolve();
    expect(stub.whenGroupDrained).toHaveBeenCalledWith(KEY_GROUP);
    expect(answer).toBeNull();

    stub.settle().resolve();
    await gate;
    expect(answer).toEqual({ kind: 'drained', groupId: KEY_GROUP, waited: true });
    // The demotion watch ends with the wait.
    expect(leadership.handlers.size).toBe(0);
  });

  it('answers drained at once when the key group is drained already', () => {
    const stub = drainStub({ drainedNow: true });
    install(stub.mlsService);
    expect(salonKeysNow(SALON)).toEqual({ kind: 'drained', groupId: KEY_GROUP, waited: false });
    expect(stub.whenGroupDrained).not.toHaveBeenCalled();
  });

  it('a follower tab does not wait: it drains nothing, so the wait would never end', () => {
    leadership.value = 'follower';
    const stub = drainStub();
    install(stub.mlsService);
    expect(salonKeysNow(SALON)).toEqual({ kind: 'unwaited', reason: 'follower' });
    expect(stub.whenGroupDrained).not.toHaveBeenCalled();
  });

  it('a leader demoted DURING the wait is released by the demotion, never left hanging', async () => {
    const stub = drainStub();
    install(stub.mlsService);
    const gate = draining(SALON).drained();
    await vi.waitFor(() => expect(stub.whenGroupDrained).toHaveBeenCalled());

    // Another tab's announcement alone is not a demotion of this one.
    for (const h of leadership.handlers) h('another tab sent leader_promoted');
    leadership.value = 'follower';
    for (const h of leadership.handlers) h('this tab is now follower');

    await expect(gate).resolves.toEqual({ kind: 'unwaited', reason: 'follower' });
    expect(leadership.handlers.size).toBe(0);
  });

  it('a leader demoted between the read and the wait does not start it', async () => {
    const stub = drainStub();
    install(stub.mlsService);
    const keys = draining(SALON);
    leadership.value = 'follower';
    await expect(keys.drained()).resolves.toEqual({ kind: 'unwaited', reason: 'follower' });
    expect(stub.whenGroupDrained).not.toHaveBeenCalled();
  });

  it('a salon no community registered, or a key group not registered here, is not waited for', () => {
    const stub = drainStub({ groupId: null });
    install(stub.mlsService);
    expect(salonKeysNow(SALON)).toEqual({ kind: 'unwaited', reason: 'key-group-unregistered' });
    expect(salonKeysNow('another-salon')).toEqual({ kind: 'unwaited', reason: 'no-scope' });
    expect(stub.whenGroupDrained).not.toHaveBeenCalled();
  });

  it('without a session there is nothing to wait for', () => {
    expect(salonKeysNow(SALON)).toEqual({ kind: 'unwaited', reason: 'no-runtime' });
  });

  it('a service closed before the drain releases the read rather than holding it for ever', async () => {
    const stub = drainStub();
    install(stub.mlsService);
    const gate = draining(SALON).drained();
    await vi.waitFor(() => expect(stub.whenGroupDrained).toHaveBeenCalled());
    stub.settle().reject(new GroupDrainAbandonedError(KEY_GROUP));
    await expect(gate).resolves.toEqual({ kind: 'unwaited', reason: 'closed' });
  });
});
