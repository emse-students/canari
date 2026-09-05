import {
  initTabLeadershipAsync,
  getIsTabLeader,
  resetTabLeaderStateForTests,
  getTabLeaderElectionIdForTests,
  getTabLeadership,
  whenTabLeadershipDecided,
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

  it('returns immediately when Web Locks grant leadership (does not block on lock hold)', async () => {
    const origLocks = navigator.locks;
    const request = vi.fn(
      (_name: string, _opts: unknown, callback: (lock: { mode: string } | null) => void) => {
        callback({ mode: 'exclusive' });
        return Promise.resolve();
      }
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });
    try {
      const started = Date.now();
      const ok = await initTabLeadershipAsync(log);
      expect(Date.now() - started).toBeLessThan(200);
      expect(ok).toBe(true);
      expect(getIsTabLeader()).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: origLocks });
    }
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
    expect(logs.some((l) => l.includes('read-only mode'))).toBe(true);
  });

  it('re-claims when heartbeat is stale (>10s)', async () => {
    vi.useFakeTimers();
    const oldLeader = crypto.randomUUID();
    localStorage.setItem('canari_tab_leader', oldLeader);
    localStorage.setItem('canari_tab_leader_heartbeat', String(Date.now() - 11000));
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

/**
 * THE ELECTION MUST TERMINATE, AND ONE BRANCH DID NOT.
 *
 * `whenTabLeadershipDecided()` documents that "the election always terminates - every branch of
 * `initTabLeadershipAsync` decides". That was true of seven branches and false of the eighth: the
 * refused Web Lock, which is the branch EVERY REAL BROWSER TAKES. A second tab therefore stayed
 * `undecided` for its whole life, `runFlush` awaited an answer that never came, and every message
 * sent from it was queued, acknowledged to the user and handed to nobody (TAB-4b).
 *
 * It survived because every assertion in the suite above reads `getIsTabLeader()`, where
 * `undecided` reads as `false` - the exact conflation this module's own docstring warns about,
 * repeated in its tests. So these assert on `getTabLeadership()` and on the promise, which are the
 * two things that can see the third state.
 */
describe('tabLeader: every branch of the election decides', () => {
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

  /**
   * Stubs Web Locks with the two requests the module actually makes: the `ifAvailable` probe, which
   * answers `granted`, and the queued exclusive request that stays pending until `promote()` - the
   * real shape, where the queue only fires when the holding tab releases.
   */
  function stubLocks(granted: boolean): { promote: () => void; restore: () => void } {
    const orig = navigator.locks;
    let fire = () => {};
    const request = (
      _name: string,
      opts: { ifAvailable?: boolean },
      cb: (lock: { mode: string } | null) => unknown
    ) => {
      if (opts?.ifAvailable) return Promise.resolve(cb(granted ? { mode: 'exclusive' } : null));
      return new Promise<void>(() => {
        fire = () => void cb({ mode: 'exclusive' });
      });
    };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    return {
      promote: () => fire(),
      restore: () => Object.defineProperty(navigator, 'locks', { configurable: true, value: orig }),
    };
  }

  /**
   * The election's answer, or `'pending'` if it has not settled once the microtask queue drains.
   *
   * Deliberately not a timeout: every decision here is synchronous, so draining is enough, and a
   * clock would turn "never answers" into a slow test rather than a failing one.
   */
  async function electionOutcome(): Promise<string> {
    let outcome = 'pending';
    void whenTabLeadershipDecided().then((side) => {
      outcome = side;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return outcome;
  }

  it('a REFUSED Web Lock decides follower - it does not leave the tab undecided', async () => {
    const locks = stubLocks(false);
    try {
      const ok = await initTabLeadershipAsync(log);
      expect(ok).toBe(false);
      expect(getTabLeadership()).toBe('follower');
      // The assertion the old suite could not make, and the whole of the defect.
      expect(await electionOutcome()).toBe('follower');
    } finally {
      locks.restore();
    }
  });

  it('a GRANTED Web Lock decides leader, so the pair is symmetric', async () => {
    const locks = stubLocks(true);
    try {
      expect(await initTabLeadershipAsync(log)).toBe(true);
      expect(getTabLeadership()).toBe('leader');
      expect(await electionOutcome()).toBe('leader');
    } finally {
      locks.restore();
    }
  });

  it('a follower later promoted becomes leader, and the settled answer stays settled', async () => {
    const locks = stubLocks(false);
    try {
      await initTabLeadershipAsync(log);
      expect(getTabLeadership()).toBe('follower');

      locks.promote();
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Deciding follower must not freeze the tab there: promotion is a transition between two
      // decided states, and `getTabLeadership()` is what carries it.
      expect(getTabLeadership()).toBe('leader');
      expect(getIsTabLeader()).toBe(true);
      // The promise answers "is it known yet", so it keeps the first answer. Callers that must act
      // on the current side re-read the getter after awaiting it - which is what `runFlush` does.
      expect(await electionOutcome()).toBe('follower');
    } finally {
      locks.restore();
    }
  });

  it('the localStorage follower decides too - the twin that was right all along', async () => {
    vi.useFakeTimers();
    localStorage.setItem('canari_tab_leader', crypto.randomUUID());
    localStorage.setItem('canari_tab_leader_heartbeat', String(Date.now()));
    const p = initTabLeadershipAsync(log);
    await vi.advanceTimersByTimeAsync(30);
    await p;
    expect(getTabLeadership()).toBe('follower');
    expect(await electionOutcome()).toBe('follower');
  });

  it('no environment leaves the tab undecided once init resolves', async () => {
    const environments: Array<[string, () => () => void]> = [
      [
        'BroadcastChannel absent (Tauri-like)',
        () => {
          const orig = globalThis.BroadcastChannel;
          // @ts-expect-error simulate missing API
          delete globalThis.BroadcastChannel;
          return () => {
            globalThis.BroadcastChannel = orig;
          };
        },
      ],
      [
        'Tauri internals present',
        () => {
          (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
          return () => {
            delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
          };
        },
      ],
      ['Web Locks granted', () => stubLocks(true).restore],
      ['Web Locks refused', () => stubLocks(false).restore],
    ];

    for (const [name, setup] of environments) {
      resetTabLeaderStateForTests();
      const restore = setup();
      try {
        await initTabLeadershipAsync(log);
        expect(getTabLeadership(), `${name} left the election undecided`).not.toBe('undecided');
        expect(await electionOutcome(), `${name} never settled the promise`).not.toBe('pending');
      } finally {
        restore();
      }
    }
  });
});
