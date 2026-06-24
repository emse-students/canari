// ─── Multi-tab coordination ───────────────────────────────────────────────
// Only one browser tab should hold the WebSocket connection and run MLS
// operations. Other tabs run in read-only mode and receive message updates via
// BroadcastChannel (`canari-tab-messages`). Tab leadership uses `canari-mls-tab`.
// This prevents two tabs from advancing the same MLS ratchet concurrently.
//
// Strategy: prefer the Web Locks API (navigator.locks) which guarantees
// mutual exclusion at the browser level - no read-modify-write race on
// localStorage. Falls back to the heartbeat approach on platforms where
// navigator.locks is unavailable (Tauri WebKitGTK, very old browsers).

const TAB_ID = crypto.randomUUID();
let isTabLeader = false;
let tabChannel: BroadcastChannel | null = null;
let leaderPromotedHandler: (() => void) | null = null;
let leaderDemotedHandler: (() => void) | null = null;
/** Stored resolve from holdLeaderLockUntilUnload - allows explicitly releasing the lock. */
let releaseLeaderLock: (() => void) | null = null;

/** Returns true if this tab is the active MLS leader (holds the WebSocket). */
export function getIsTabLeader(): boolean {
  return isTabLeader;
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
        isTabLeader = false;
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
  if (!isTabLeader) return;
  isTabLeader = false;
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
    if (ev.data?.type === 'request_takeover' && isTabLeader) {
      log('[TAB] Takeover request received - releasing leadership.');
      releaseLeadership();
      return;
    }
    if (ev.data?.type === 'leader_closing' && !isTabLeader) {
      const delay = Math.random() * 300;
      setTimeout(() => {
        if (isTabLeader) return;
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
        isTabLeader = true;
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
      if (ev.data?.type === 'request_takeover' && isTabLeader) {
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
        isTabLeader = true;
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
        if (isTabLeader) return;
        isTabLeader = true;
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
    if (!isTabLeader) {
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
    if (isTabLeader) {
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
        if (isTabLeader) return;
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
        isTabLeader = true;
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
      isTabLeader = true;
      startHeartbeat();
      log('[TAB] Leadership acquired (localStorage).');
    } else {
      isTabLeader = false;
      log('[TAB] Race election - another tab won leadership.');
    }
  } else if (currentLeader === TAB_ID) {
    isTabLeader = true;
    startHeartbeat();
  } else {
    isTabLeader = false;
    log('[TAB] Another tab is active - read-only mode (localStorage).');
    startFollowerPoll(log);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (isTabLeader) {
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

  return isTabLeader;
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
    isTabLeader = true;
    return true;
  }

  // Tauri environments (desktop/mobile) are single-instance webviews and should always be leader.
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    isTabLeader = true;
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
  isTabLeader = false;
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
