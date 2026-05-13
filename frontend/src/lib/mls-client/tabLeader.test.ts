import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initTabLeadershipAsync,
  getIsTabLeader,
  resetTabLeaderStateForTests,
  getTabLeaderElectionIdForTests,
} from './tabLeader';

describe('tabLeader (preventive: single MLS ratchet per browser)', () => {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  beforeEach(() => {
    logs.length = 0;
    resetTabLeaderStateForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    resetTabLeaderStateForTests();
    vi.restoreAllMocks();
  });

  it('claims leadership when BroadcastChannel is undefined (Tauri-like)', async () => {
    const orig = globalThis.BroadcastChannel;
    // @ts-expect-error simulate missing API
    delete globalThis.BroadcastChannel;
    try {
      const ok = await initTabLeadershipAsync(log);
      expect(ok).toBe(true);
      expect(getIsTabLeader()).toBe(true);
    } finally {
      globalThis.BroadcastChannel = orig;
    }
  });

  it('claims leadership when no leader key and fresh heartbeat window', async () => {
    vi.useFakeTimers();
    const p = initTabLeadershipAsync(log);
    await vi.advanceTimersByTimeAsync(30);
    const ok = await p;
    expect(ok).toBe(true);
    expect(getIsTabLeader()).toBe(true);
    expect(logs.some((l) => l.includes('Leadership'))).toBe(true);
  });

  it('becomes follower when another tab id holds the leader key with fresh heartbeat', async () => {
    vi.useFakeTimers();
    const other = crypto.randomUUID();
    localStorage.setItem('canari_tab_leader', other);
    localStorage.setItem('canari_tab_leader_heartbeat', String(Date.now()));
    const p = initTabLeadershipAsync(log);
    await vi.advanceTimersByTimeAsync(30);
    const ok = await p;
    expect(ok).toBe(false);
    expect(getIsTabLeader()).toBe(false);
    expect(logs.some((l) => l.includes('lecture seule'))).toBe(true);
  });

  it('re-claims when heartbeat is stale (>5s)', async () => {
    vi.useFakeTimers();
    const oldLeader = crypto.randomUUID();
    localStorage.setItem('canari_tab_leader', oldLeader);
    localStorage.setItem('canari_tab_leader_heartbeat', String(Date.now() - 6000));
    const p = initTabLeadershipAsync(log);
    await vi.advanceTimersByTimeAsync(30);
    const ok = await p;
    expect(ok).toBe(true);
    expect(getIsTabLeader()).toBe(true);
    expect(localStorage.getItem('canari_tab_leader')).toBe(getTabLeaderElectionIdForTests());
  });

  it('restores leader when same tab id already owns the key', async () => {
    vi.useFakeTimers();
    const id = getTabLeaderElectionIdForTests();
    localStorage.setItem('canari_tab_leader', id);
    localStorage.setItem('canari_tab_leader_heartbeat', String(Date.now()));
    const p = initTabLeadershipAsync(log);
    await vi.advanceTimersByTimeAsync(30);
    const ok = await p;
    expect(ok).toBe(true);
    expect(getIsTabLeader()).toBe(true);
  });
});
