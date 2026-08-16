// ─── Multi-tab coordination ───────────────────────────────────────────────
// Only one browser tab holds the WebSocket connection and runs MLS operations. Other tabs run in
// read-only mode and receive message updates via BroadcastChannel (`canari-tab-messages`), which
// also carries outbox coordination: a follower composes and queues, the leader encrypts and sends.
// Tab leadership itself is negotiated on `canari-mls-tab`.
//
// This prevents two tabs from advancing the same MLS ratchet concurrently - which is not a
// theoretical worry. Both tabs load their MLS client from ONE snapshot, so a send from the tab
// whose in-memory ratchet is behind is encrypted at a generation the peer has already consumed and
// is dropped on arrival, silently (WP-MULTITAB-1). Every write path therefore has to be gated, not
// just the socket: `initializeConnection`, and the outbox flush in `utils/chat/outbox.ts`. For the
// same reason a follower PROMOTED to leader must not send from the state it loaded - see the
// promotion handler in `useChatSession.svelte.ts`.
//
// Strategy: prefer the Web Locks API (navigator.locks) which guarantees
// mutual exclusion at the browser level - no read-modify-write race on
// localStorage. Falls back to the heartbeat approach on platforms where
// navigator.locks is unavailable (Tauri WebKitGTK, very old browsers).

const TAB_ID = crypto.randomUUID();

/**
 * WHAT THIS TAB KNOWS ABOUT LEADERSHIP - three states, because there have always been three.
 *
 * `isTabLeader` was a boolean initialised to `false`, so between page load and the moment the
 * election resolves, every reader was told "another tab is the leader" - which is a claim, and a
 * false one on a single-tab client. `runFlush` believed it, took the follower branch, and broadcast
 * a drain request to a leader that does not exist (WP-OUTBOX-2, seen on A1 after a reload and on a
 * single-tab W1 seven seconds into READ pass 4).
 *
 * **A PREDICATE IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER.** "Am I the leader" and
 * "has leadership been decided" differ by exactly this state, and answering the second with the
 * first is the whole defect. Callers that must not act before the answer exists await
 * `whenTabLeadershipDecided()`; callers for which "not the leader" is the safe reading keep
 * `getIsTabLeader()`, which is deliberately unchanged.
 */
export type TabLeadership = 'undecided' | 'leader' | 'follower';

let leadership: TabLeadership = 'undecided';

/**
 * Resolved the first time the election settles, and never re-armed.
 *
 * A promotion or a demotion afterwards is a TRANSITION between two decided states, not a return to
 * the undecided one: `whenTabLeadershipDecided` answers "is the answer known yet", so once it is,
 * it stays known. Created eagerly at module load so a waiter that arrives before
 * `initTabLeadershipAsync` runs has something to await rather than a null to guard.
 */
let resolveDecided!: (state: 'leader' | 'follower') => void;
function armDecided(): Promise<'leader' | 'follower'> {
  return new Promise<'leader' | 'follower'>((r) => {
    resolveDecided = r;
  });
}
let decided = armDecided();

/**
 * Records the outcome of the election, resolving the first decision for anyone waiting on it.
 *
 * Resolving an already-resolved promise is a no-op, which is exactly the semantics wanted: the
 * later transitions (promotion, demotion, unload) move `leadership` and leave the ANSWERED question
 * answered.
 */
function decide(state: 'leader' | 'follower'): void {
  leadership = state;
  resolveDecided(state);
}

/** What this tab currently knows: `undecided` until the election resolves, then its side of it. */
export function getTabLeadership(): TabLeadership {
  return leadership;
}

/**
 * Resolves once this tab knows which side of the election it is on.
 *
 * Deliberately NOT a timeout: the election always terminates - every branch of
 * `initTabLeadershipAsync` decides, including the two that decide synchronously - so a deadline here
 * could only ever fire on a client that has no session at all, and would answer with a guess. A
 * caller that hangs on this is a caller whose session never started, which is a defect to see rather
 * than to paper over.
 */
export function whenTabLeadershipDecided(): Promise<'leader' | 'follower'> {
  return decided;
}

let tabChannel: BroadcastChannel | null = null;
let leaderPromotedHandler: (() => void) | null = null;
let leaderDemotedHandler: (() => void) | null = null;
/** Stored resolve from holdLeaderLockUntilUnload - allows explicitly releasing the lock. */
let releaseLeaderLock: (() => void) | null = null;

/**
 * Returns true if this tab is the active MLS leader (holds the WebSocket).
 *
 * `undecided` reads as `false` here, which is right for every caller that must not WRITE without
 * being sure - and wrong for a caller deciding whether someone ELSE will do the work. That second
 * question is `whenTabLeadershipDecided()`.
 */
export function getIsTabLeader(): boolean {
  return leadership === 'leader';
}

/**
 * Registers a callback invoked when this tab becomes leader after starting as a
 * follower (Web Locks promotion or stale-heartbeat takeover).
 */
export function setTabLeaderPromotedHandler(handler: (() => void) | null): void {
  leaderPromotedHandler = handler;
}

function notifyTabLeaderPromoted(): void {
  leaderPromotedHandler?.();
}

/**
 * Registers a callback invoked when this tab loses leadership (another tab took over).
 * The handler should tear down this tab's WebSocket so the MLS ratchet only ever
 * advances in one tab.
 */
export function setTabLeaderDemotedHandler(handler: (() => void) | null): void {
  leaderDemotedHandler = handler;
}

function holdLeaderLockUntilUnload(): Promise<void> {
  return new Promise<void>((release) => {
    releaseLeaderLock = release;
    if (typeof window === 'undefined') {
      release();
      return;
    }
    window.addEventListener(
      'beforeunload',
      () => {
        decide('follower');
        release();
      },
      { once: true }
    );
  });
}

/**
 * Explicitly releases leadership of this tab.
 * Called when another tab requests a takeover.
 */
export function releaseLeadership(): void {
  if (leadership !== 'leader') return;
  decide('follower');
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  try {
    if (localStorage.getItem(LEADER_KEY) === TAB_ID) {
      localStorage.removeItem(LEADER_KEY);
      localStorage.removeItem(HEARTBEAT_KEY);
    }
  } catch {
    /* quota */
  }
  tabChannel?.postMessage({ type: 'leader_closing', tabId: TAB_ID });
  // Release the Web Lock if active (the next tab in the queue acquires it automatically).
  releaseLeaderLock?.();
  releaseLeaderLock = null;
  // Notify the session to close its WebSocket (otherwise the MLS ratchet
  // would advance in two tabs simultaneously).
  leaderDemotedHandler?.();
}

/**
 * From a follower tab: asks the leader tab to release its leadership
 * so this tab can take over.
 */
export function requestLeadershipTakeover(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  if (!tabChannel) tabChannel = new BroadcastChannel('canari-mls-tab');
  tabChannel.postMessage({ type: 'request_takeover' });
}

function ensureTabChannelForLocalStorage(log: (msg: string) => void): void {
  if (tabChannel) return;
  tabChannel = new BroadcastChannel('canari-mls-tab');
  tabChannel.addEventListener('message', (ev: MessageEvent) => {
    // Leader releases its leadership on request from a follower tab.
    if (ev.data?.type === 'request_takeover' && leadership === 'leader') {
      log('[TAB] Takeover request received - releasing leadership.');
      releaseLeadership();
      return;
    }
    if (ev.data?.type === 'leader_closing' && leadership !== 'leader') {
      const delay = Math.random() * 300;
      setTimeout(() => {
        if (leadership === 'leader') return;
        const current = localStorage.getItem(LEADER_KEY);
        if (current && current !== ev.data.tabId) return;
        try {
          localStorage.setItem(LEADER_KEY, TAB_ID);
        } catch {
          /* quota */
        }
        try {
          localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
        } catch {
          /* quota */
        }
        decide('leader');
        startHeartbeat();
        log('[TAB] Previous leader closed - promoted to leader.');
        notifyTabLeaderPromoted();
      }, delay);
    }
  });
}

// ── Web Locks implementation ───────────────────────────────────────────────

/**
 * Tries to become leader using the Web Locks API.
 * - First tab acquires the exclusive lock and is the leader.
 * - Subsequent tabs queue a non-ifAvailable request; they become leaders
 *   automatically when the current lock holder's tab closes.
 * Returns true if this tab immediately became leader.
 */
async function initWithWebLocks(log: (msg: string) => void): Promise<boolean> {
  if (!tabChannel) {
    tabChannel = new BroadcastChannel('canari-mls-tab');
    // Listen for takeover requests from follower tabs.
    tabChannel.addEventListener('message', (ev: MessageEvent) => {
      if (ev.data?.type === 'request_takeover' && leadership === 'leader') {
        log('[TAB] Takeover request received - releasing leadership (Web Locks).');
        releaseLeadership();
      }
    });
  }

  const acquired = await new Promise<boolean>((resolveLeadership) => {
    void navigator.locks
      .request('canari-tab-leader', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (lock === null) {
          resolveLeadership(false);
          return;
        }
        decide('leader');
        log('[TAB] Leadership acquired (Web Locks).');
        resolveLeadership(true);
        await holdLeaderLockUntilUnload();
      })
      .catch(() => {
        resolveLeadership(false);
      });
  });

  if (!acquired) {
    log('[TAB] Another tab is active - read-only mode (Web Locks).');

    void navigator.locks
      .request('canari-tab-leader', { mode: 'exclusive' }, async () => {
        if (leadership === 'leader') return;
        decide('leader');
        log('[TAB] Promoted to leader (Web Locks).');
        tabChannel?.postMessage({ type: 'leader_promoted', tabId: TAB_ID });
        notifyTabLeaderPromoted();

        await holdLeaderLockUntilUnload();
      })
      .catch(() => {
        /* Tab is closing - ignore. */
      });
  }

  return acquired;
}

// ── Legacy localStorage/heartbeat fallback ────────────────────────────────

const LEADER_KEY = 'canari_tab_leader';
const HEARTBEAT_KEY = 'canari_tab_leader_heartbeat';
const HEARTBEAT_STALE_MS = 10_000;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let followerPollInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (leadership !== 'leader') {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      return;
    }
    try {
      localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
    } catch {
      /* quota */
    }
  }, 4_000);
}

function startFollowerPoll(log: (msg: string) => void): void {
  if (followerPollInterval) return;
  followerPollInterval = setInterval(() => {
    if (leadership === 'leader') {
      clearInterval(followerPollInterval!);
      followerPollInterval = null;
      return;
    }
    const lastHb = parseInt(localStorage.getItem(HEARTBEAT_KEY) ?? '0', 10);
    if (Date.now() - lastHb > HEARTBEAT_STALE_MS) {
      clearInterval(followerPollInterval!);
      followerPollInterval = null;
      const delay = Math.random() * 300;
      setTimeout(() => {
        if (leadership === 'leader') return;
        const hbNow = parseInt(localStorage.getItem(HEARTBEAT_KEY) ?? '0', 10);
        if (Date.now() - hbNow <= HEARTBEAT_STALE_MS) return;
        try {
          localStorage.setItem(LEADER_KEY, TAB_ID);
        } catch {
          /* quota */
        }
        try {
          localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
        } catch {
          /* quota */
        }
        decide('leader');
        startHeartbeat();
        log('[TAB] Crashed leader detected (stale heartbeat) - promoted to leader.');
        notifyTabLeaderPromoted();
      }, delay);
    }
  }, 3_000);
}

async function initWithLocalStorage(log: (msg: string) => void): Promise<boolean> {
  ensureTabChannelForLocalStorage(log);

  const now = Date.now();
  const lastHeartbeat = parseInt(localStorage.getItem(HEARTBEAT_KEY) ?? '0', 10);
  const currentLeader = localStorage.getItem(LEADER_KEY);

  if (!currentLeader || now - lastHeartbeat > HEARTBEAT_STALE_MS) {
    try {
      localStorage.setItem(LEADER_KEY, TAB_ID);
    } catch {
      /* quota */
    }
    try {
      localStorage.setItem(HEARTBEAT_KEY, String(now));
    } catch {
      /* quota */
    }
    await new Promise((r) => setTimeout(r, 30));
    if (localStorage.getItem(LEADER_KEY) === TAB_ID) {
      decide('leader');
      startHeartbeat();
      log('[TAB] Leadership acquired (localStorage).');
    } else {
      decide('follower');
      log('[TAB] Race election - another tab won leadership.');
    }
  } else if (currentLeader === TAB_ID) {
    decide('leader');
    startHeartbeat();
  } else {
    decide('follower');
    log('[TAB] Another tab is active - read-only mode (localStorage).');
    startFollowerPoll(log);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (leadership === 'leader') {
        tabChannel?.postMessage({ type: 'leader_closing', tabId: TAB_ID });
        if (localStorage.getItem(LEADER_KEY) === TAB_ID) {
          localStorage.removeItem(LEADER_KEY);
          localStorage.removeItem(HEARTBEAT_KEY);
        }
      }
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (followerPollInterval) {
        clearInterval(followerPollInterval);
        followerPollInterval = null;
      }
    });
  }

  return leadership === 'leader';
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Elects this tab as leader or follower.
 * Uses Web Locks when available (race-free); falls back to localStorage heartbeat.
 */
export async function initTabLeadershipAsync(log: (msg: string) => void): Promise<boolean> {
  // Single-tab environments (Tauri desktop, service workers without BroadcastChannel)
  // are always leader.
  if (typeof BroadcastChannel === 'undefined') {
    decide('leader');
    return true;
  }

  // Tauri environments (desktop/mobile) are single-instance webviews and should always be leader.
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    decide('leader');
    return true;
  }

  // Prefer Web Locks (race-free, no polling required).
  // happy-dom exposes `locks` on navigator but leaves it null; Tauri WebKitGTK may lack the API.
  if (
    typeof navigator !== 'undefined' &&
    navigator.locks != null &&
    typeof navigator.locks.request === 'function'
  ) {
    return initWithWebLocks(log);
  }

  // Legacy fallback for environments without navigator.locks.
  return initWithLocalStorage(log);
}

/** @internal Resets module state between Vitest cases. */
export function resetTabLeaderStateForTests(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (followerPollInterval) {
    clearInterval(followerPollInterval);
    followerPollInterval = null;
  }
  try {
    tabChannel?.close();
  } catch {
    /* ignore */
  }
  tabChannel = null;
  leaderPromotedHandler = null;
  leaderDemotedHandler = null;
  // Back to UNDECIDED, with a fresh promise: a reset returns the module to its pre-election state,
  // and leaving the old one resolved would let the next case await an answer from the previous one.
  leadership = 'undecided';
  decided = armDecided();
  try {
    localStorage.removeItem(LEADER_KEY);
    localStorage.removeItem(HEARTBEAT_KEY);
  } catch {
    /* ignore */
  }
}

/** @internal Tab id used in leader election (for multi-tab assertions). */
export function getTabLeaderElectionIdForTests(): string {
  return TAB_ID;
}
