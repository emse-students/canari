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
 * The election for THIS document: in flight, or settled, or `null` before the first call.
 *
 * Holding the promise rather than a boolean is what makes two concurrent callers share one
 * election instead of racing each other for the same lock.
 */
let election: Promise<boolean> | null = null;

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
 * How to get back in the queue after handing leadership over - set by whatever took the lock.
 *
 * The logger belongs to the election, and `releaseLeadership` is reached from a BroadcastChannel
 * listener that has none. Storing the CLOSURE rather than the logger keeps the knowledge where it
 * already is, and pairs it with `releaseLeaderLock`: both are set on acquiring and cleared on
 * releasing, so there is one state, not two that can disagree.
 */
let requeueForPromotion: (() => void) | null = null;

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
  const requeue = requeueForPromotion;
  releaseLeaderLock?.();
  releaseLeaderLock = null;
  requeueForPromotion = null;
  // AND GET BACK IN THE QUEUE. Handing leadership over is not leaving the election: the tab that
  // took over will close one day, and a tab holding no outstanding request is never told. It then
  // stays read-only and offline for the rest of its life with nothing on screen to say why, which
  // is the same end state as the double election above, reached from the other direction. Only on
  // the Web Locks path, which is what set this - the localStorage fallback has its own poll.
  requeue?.();
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
 * Queues a blocking request for the leader lock, to be granted when the holder releases it.
 *
 * TWO PLACES NEED THIS AND ONLY ONE HAD IT. A tab that lost the election queues here and is
 * promoted when the leader closes. A tab DEMOTED by a takeover was left with no request at all -
 * so if the tab that took over then closed, the demoted one stayed read-only and offline for the
 * rest of its life, with nothing on screen to say why. Same end state as the defect above, reached
 * from the other direction, so it gets the same answer rather than a second one.
 *
 * NOT CALLED WHILE THIS DOCUMENT ALREADY HOLDS THE LOCK. Web Locks are per-document, so a request
 * made behind our own hold waits for our own `beforeunload` - that is the defect
 * `initTabLeadershipAsync` is memoised to prevent, and it must not come back in through here.
 */
function queueForPromotion(log: (msg: string) => void): void {
  void navigator.locks
    .request('canari-tab-leader', { mode: 'exclusive' }, async () => {
      if (leadership === 'leader') return;
      decide('leader');
      log('[TAB] Promoted to leader (Web Locks).');
      requeueForPromotion = () => queueForPromotion(log);
      tabChannel?.postMessage({ type: 'leader_promoted', tabId: TAB_ID });
      notifyTabLeaderPromoted();

      await holdLeaderLockUntilUnload();
    })
    .catch(() => {
      /* Tab is closing - ignore. */
    });
}

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
        requeueForPromotion = () => queueForPromotion(log);
        resolveLeadership(true);
        await holdLeaderLockUntilUnload();
      })
      .catch(() => {
        resolveLeadership(false);
      });
  });

  if (!acquired) {
    // THE ELECTION IS OVER FOR THIS TAB AND ITS ANSWER IS `follower`, SO IT IS RECORDED HERE.
    //
    // This line was missing, and this is the branch EVERY REAL BROWSER TAKES - Web Locks is the
    // preferred path, and the localStorage twin below decides on all four of its outcomes. Nothing
    // looked wrong: `getIsTabLeader()` reads `undecided` as false, so read-only mode, the skipped
    // WebSocket and the skipped `initializeConnection` were all correct. The one caller asking the
    // question this state actually answers - `runFlush`, awaiting `whenTabLeadershipDecided()` -
    // hung for ever, and it memoises that wait: a second tab queued every send it was given, told
    // the user it was accepted, and handed none of them to the leader for the rest of its life
    // (TAB-4b, measured 2026-09-05; the entire handover below it was built and never once reached).
    decide('follower');
    log('[TAB] Another tab is active - read-only mode (Web Locks).');

    queueForPromotion(log);
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
/**
 * Elects this tab, ONCE PER DOCUMENT, and hands every later caller the standing answer.
 *
 * **THE ELECTION IS A PROPERTY OF THE DOCUMENT, NOT OF A LOGIN.** It has one production caller -
 * `sessionAuth.ts`'s login - and a login runs more than once in a page's life: a PIN refused, a
 * reset, a new PIN is two of them. Run 1 takes the lock with `ifAvailable` and holds it until
 * unload; run 2 probes, is told `null` BY ITS OWN HOLD, calls `decide('follower')` over run 1's
 * answer, and queues a blocking request that can only be granted by the release it is blocking.
 *
 * Measured on W2, 2026-09-21: `navigator.locks.query()` answered `canari-tab-leader` held by
 * client `BCDAE226...` AND pending for client `BCDAE226...`, in a profile with exactly one page.
 * The tab showed "Messagerie chiffree active dans un autre onglet", read *Hors-ligne*, and listed
 * nothing - permanently. "Prendre la main" cannot rescue it: `requestLeadershipTakeover` posts on
 * a `BroadcastChannel`, which never delivers to the context that posted, and the only tab that
 * could release the lock is the one asking.
 *
 * So the first call runs the election and every later one awaits it and reads the CURRENT state -
 * not the first call's boolean, which goes stale the moment a follower is promoted.
 */
export function initTabLeadershipAsync(log: (msg: string) => void): Promise<boolean> {
  if (election) return election.then(() => getIsTabLeader());
  election = runElection(log);
  return election;
}

async function runElection(log: (msg: string) => void): Promise<boolean> {
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
  // The memo goes with them, or the next case would be handed the previous case's election.
  election = null;
  releaseLeaderLock = null;
  requeueForPromotion = null;
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
