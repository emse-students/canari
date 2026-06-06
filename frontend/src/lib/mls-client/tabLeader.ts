// ─── Multi-tab coordination ───────────────────────────────────────────────
// Only one browser tab should hold the WebSocket connection and run MLS
// operations. Other tabs run in read-only mode and receive UI updates via
// BroadcastChannel. This prevents two tabs from advancing the same MLS
// ratchet concurrently (which would cause WrongEpoch / AeadError).
//
// Strategy: prefer the Web Locks API (navigator.locks) which guarantees
// mutual exclusion at the browser level — no read-modify-write race on
// localStorage. Falls back to the heartbeat approach on platforms where
// navigator.locks is unavailable (Tauri WebKitGTK, very old browsers).

const TAB_ID = crypto.randomUUID();
let isTabLeader = false;
let tabChannel: BroadcastChannel | null = null;
let leaderPromotedHandler: (() => void) | null = null;
/** Stored resolve from holdLeaderLockUntilUnload — permet de libérer explicitement le lock. */
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
 * Libère explicitement le leadership de cet onglet.
 * Appelé quand un autre onglet demande à prendre la main.
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
  // Libère le Web Lock si actif (le tab suivant dans la queue l'acquiert automatiquement)
  releaseLeaderLock?.();
  releaseLeaderLock = null;
}

/**
 * Depuis un onglet follower : demande à l'onglet leader de libérer son leadership
 * afin que cet onglet puisse prendre la main.
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
    // Le leader libère son leadership sur demande d'un onglet follower
    if (ev.data?.type === 'request_takeover' && isTabLeader) {
      log('[TAB] Demande de takeover reçue — libération du leadership.');
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
        log('[TAB] Ancien leader fermé — promotion en leader.');
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
    // Écouter les demandes de takeover des onglets followers
    tabChannel.addEventListener('message', (ev: MessageEvent) => {
      if (ev.data?.type === 'request_takeover' && isTabLeader) {
        log('[TAB] Demande de takeover reçue — libération du leadership (Web Locks).');
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
        log('[TAB] Leadership acquise (Web Locks).');
        resolveLeadership(true);
        await holdLeaderLockUntilUnload();
      })
      .catch(() => {
        resolveLeadership(false);
      });
  });

  if (!acquired) {
    log('[TAB] Autre onglet actif — mode lecture seule (Web Locks).');

    void navigator.locks
      .request('canari-tab-leader', { mode: 'exclusive' }, async () => {
        if (isTabLeader) return;
        isTabLeader = true;
        log('[TAB] Promotion en leader (Web Locks).');
        tabChannel?.postMessage({ type: 'leader_promoted', tabId: TAB_ID });
        notifyTabLeaderPromoted();

        await holdLeaderLockUntilUnload();
      })
      .catch(() => {
        /* Tab is closing — ignore. */
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
        log('[TAB] Leader crashé détecté (heartbeat stale) — promotion en leader.');
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
      log('[TAB] Leadership acquise (localStorage).');
    } else {
      isTabLeader = false;
      log('[TAB] Race election — autre onglet leader.');
    }
  } else if (currentLeader === TAB_ID) {
    isTabLeader = true;
    startHeartbeat();
  } else {
    isTabLeader = false;
    log('[TAB] Autre onglet actif — mode lecture seule (localStorage).');
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
