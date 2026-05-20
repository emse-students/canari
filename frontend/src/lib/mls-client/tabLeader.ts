// ─── Multi-tab coordination (preventive) ─────────────────────────────────
// Only one browser tab should hold the WebSocket connection and run MLS
// operations. Other tabs run in read-only mode and receive UI updates via
// BroadcastChannel. This prevents two tabs from advancing the same MLS
// ratchet concurrently (which would cause WrongEpoch / AeadError).

const TAB_ID = crypto.randomUUID();
let isTabLeader = false;
let tabChannel: BroadcastChannel | null = null;

/** Returns true if this tab is the active MLS leader (holds the WebSocket). */
export function getIsTabLeader(): boolean {
  return isTabLeader;
}

const LEADER_KEY = 'canari_tab_leader';
const HEARTBEAT_KEY = 'canari_tab_leader_heartbeat';
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/** Writes a fresh timestamp to localStorage every 4 s so other tabs can detect a stale leader. The staleness threshold is 5 s, giving a 1 s margin. */
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
  }, 4000);
}

/**
 * Async leader election using localStorage heartbeat.
 * First tab claims leadership; subsequent tabs become followers.
 * Stale leader (>5s without heartbeat) is automatically replaced.
 */
export async function initTabLeadershipAsync(log: (msg: string) => void): Promise<boolean> {
  // BroadcastChannel not available (e.g. Tauri desktop) — always leader.
  if (typeof BroadcastChannel === 'undefined') {
    isTabLeader = true;
    return true;
  }

  if (!tabChannel) {
    tabChannel = new BroadcastChannel('canari-mls-tab');
    tabChannel.addEventListener('message', (ev: MessageEvent) => {
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
        }, delay);
      }
    });
  }

  const now = Date.now();
  const lastHeartbeat = parseInt(localStorage.getItem(HEARTBEAT_KEY) ?? '0', 10);
  const currentLeader = localStorage.getItem(LEADER_KEY);

  if (!currentLeader || now - lastHeartbeat > 5000) {
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
      log('[TAB] Leadership acquise.');
    } else {
      isTabLeader = false;
      log('[TAB] Race election — autre onglet leader.');
    }
  } else if (currentLeader === TAB_ID) {
    isTabLeader = true;
    startHeartbeat();
  } else {
    isTabLeader = false;
    log('[TAB] Autre onglet actif — mode lecture seule (pas de WebSocket).');
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
    });
  }

  return isTabLeader;
}

/** @internal Resets module state between Vitest cases (BroadcastChannel, timers, localStorage keys). */
export function resetTabLeaderStateForTests(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  try {
    tabChannel?.close();
  } catch {
    /* ignore */
  }
  tabChannel = null;
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
