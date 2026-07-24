import {
  resetTabLeaderStateForTests,
  initTabLeadershipAsync,
  getIsTabLeader,
  getTabLeaderElectionIdForTests,
} from './tabLeader';

/**
 * End-to-end style flows using real tab-leader module state (reset between tests).
 */
describe('MLS client scenarios (tab leader + timing)', () => {
  afterEach(() => {
    resetTabLeaderStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('cold start: empty storage leads to leadership after election delay', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const p = initTabLeadershipAsync((m) => logs.push(m));
    await vi.advanceTimersByTimeAsync(30);
    await p;
    expect(getIsTabLeader()).toBe(true);
    expect(localStorage.getItem('canari_tab_leader')).toBe(getTabLeaderElectionIdForTests());
    expect(logs.some((l) => l.includes('acquise') || l.includes('Leadership'))).toBe(true);
  });

  it('second tab: active remote leader with fresh heartbeat stays follower', async () => {
    vi.useFakeTimers();
    const incumbent = crypto.randomUUID();
    localStorage.setItem('canari_tab_leader', incumbent);
    localStorage.setItem('canari_tab_leader_heartbeat', String(Date.now()));
    const p = initTabLeadershipAsync(() => {});
    await vi.advanceTimersByTimeAsync(30);
    await p;
    expect(getIsTabLeader()).toBe(false);
  });
});
