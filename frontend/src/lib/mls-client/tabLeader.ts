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
let leaderDemotedHandler: (() => 'reloads' | void) | null = null;

/**
 * How to get back in the queue after handing leadership over - set by whatever took the lock.
 * Storing the CLOSURE rather than the logger keeps the knowledge where it already is.
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
 *
 * It returns `'reloads'` when it ends the document: this one then neither requeues nor accepts the
 * lead again, and the page its reload starts runs the election - see {@link handOver}.
 */
export function setTabLeaderDemotedHandler(handler: (() => 'reloads' | void) | null): void {
  leaderDemotedHandler = handler;
}

/**
 * Ends this document's hold on the leader lock: `follower` FIRST, then the release, so nothing this
 * document runs after the lock is gone still believes it leads. Set while the lock is held, `null`
 * otherwise; called by the unload and by a freeze ({@link watchPageLifecycle}), whichever comes first.
 */
let releaseLeaderLock: (() => void) | null = null;

function holdLeaderLockUntilUnload(): Promise<void> {
  return new Promise<void>((release) => {
    if (typeof window === 'undefined') {
      release();
      return;
    }
    const end = () => {
      if (releaseLeaderLock !== end) return;
      releaseLeaderLock = null;
      decide('follower');
      release();
    };
    releaseLeaderLock = end;
    window.addEventListener('beforeunload', end, { once: true });
  });
}

/**
 * The blocking request this follower holds in the lock's queue, so a freeze can withdraw it. `null`
 * when there is none: a leader, a document leaving, or a request withdrawn by a freeze.
 */
let promotionRequest: AbortController | null = null;
/** A freeze withdrew this follower's queued request: its resume queues it again. */
let requestWithdrawnByFreeze = false;
/** This document's demotion reloads it: it neither queues again nor takes the lead back. */
let leaving = false;
let lifecycleWatched = false;

/**
 * A FROZEN DOCUMENT HOLDS NOTHING (2026-11-10, with the hand-over below).
 *
 * Chromium freezes some hidden pages (Energy Saver freezing), and a frozen page runs no task: it
 * answers no `outbox_flush_request`, posts no relay, and cannot answer a hand-over ask either. Its
 * Web Lock, though, stays held, so every other tab of the account would stay a follower - the shape
 * of the owner's report (a photo queued in a visible follower, unsent while the leader was hidden;
 * on Firefox there, which has no freeze, and which {@link watchHandover} covers). A frozen leader is
 * not a leader.
 *
 * So the lock follows the lifecycle, from the browser's own events and never from a clock:
 * - **`freeze`** (and `pagehide` into the back/forward cache, the other way a document stops running
 *   while it exists): a LEADER becomes a follower and releases the lock, which the browser grants at
 *   once to the next queued tab; its demotion handler closes its socket and schedules its reload,
 *   which runs when the page is resumed. Chrome's own guidance for `freeze` is "release any held Web
 *   Locks" (developer.chrome.com/docs/web-platform/page-lifecycle-api, the Frozen state). A FOLLOWER
 *   withdraws its queued request, since a lock granted to a frozen page would be held by a document
 *   that cannot run the promotion.
 * - **`resume`** / **`pageshow` from the cache**: a follower whose request a freeze withdrew queues it
 *   again; a former leader is already on its way out (its reload).
 *
 * THE SINGLE WRITER HOLDS ACROSS IT: `follower` is decided synchronously inside the freeze handler,
 * before the release, and every MLS write reads it at its last synchronous step (the send's
 * `refusesCommitsHere` before the encrypt, the commit guards), so a continuation that resumes in the
 * old document after the lock moved refuses instead of writing on a stale copy. The tab granted the
 * lock reloads before it serves (its promotion), so it reads the state as the old leader left it.
 *
 * What this does NOT cover: a leader whose main thread is wedged (it runs no handler at all), and
 * an engine that suspends a page without dispatching `freeze` (only Chromium dispatches it): there
 * is no event to act on, and a clock would be a guess about a live document.
 */
function watchPageLifecycle(log: (msg: string) => void): void {
  if (lifecycleWatched || typeof window === 'undefined' || typeof document === 'undefined') return;
  lifecycleWatched = true;
  const suspend = (cause: string) => {
    if (leadership === 'leader' && releaseLeaderLock) {
      log(
        `[TAB] Page suspended by the browser (${cause}) while leading - the lock is released so a tab that can run takes the lead.`
      );
      releaseLeaderLock();
      // A document whose demotion does not reload it (no session yet) queues again here - and a
      // request queued by a frozen page is withdrawn below like any other.
      handOver();
    }
    if (promotionRequest) {
      log(
        `[TAB] Page suspended by the browser (${cause}) while waiting for the lead - the request is withdrawn until it resumes.`
      );
      const request = promotionRequest;
      promotionRequest = null;
      requestWithdrawnByFreeze = true;
      request.abort();
    }
  };
  const resume = (cause: string) => {
    if (!requestWithdrawnByFreeze) return;
    requestWithdrawnByFreeze = false;
    if (leaving || leadership === 'leader') return;
    log(`[TAB] Page resumed (${cause}) - queueing for the lead again.`);
    queueForPromotion(log);
  };
  document.addEventListener('freeze', () => suspend('freeze'));
  document.addEventListener('resume', () => resume('resume'));
  window.addEventListener('pagehide', (e) => {
    if ((e as PageTransitionEvent).persisted) suspend('pagehide into the back/forward cache');
  });
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) resume('pageshow from the back/forward cache');
  });
}

/**
 * A demotion (the lock stolen by a tab reloading after its promotion): tell the session, and get
 * back in the queue ONLY if this document goes on living. The member's "Prendre la main" that also
 * led here was removed with the follower banner on 2026-11-08: a follower tab now hands its commits
 * to the leader (`tabCommitDelegation.ts`), so no tab ever needs to take the lead over by hand.
 *
 * Handing leadership over is not leaving the election: the tab that took over will close one day,
 * and a document holding no outstanding request is never told - it stays read-only and offline for
 * the rest of its life. But a document whose handler RELOADS it is leaving, and the page the reload
 * starts runs its own election; queueing here as well is what handed the lock back to the leaving
 * document. Only on the Web Locks path, which is what sets the requeue - the localStorage fallback
 * has its own poll.
 *
 * **A DOCUMENT ON ITS WAY OUT TOOK THE LEAD BACK, AND "PRENDRE LA MAIN" LOOPED.** Both handlers
 * reload after 50 ms, and the yielding tab used to requeue at once - so when the tab it yielded to
 * reloaded in turn (a promoted tab reloads to read the MLS state the old leader left), the lock
 * went back to the document that was leaving, which was promoted, marked a promotion reload, and
 * stole the lock from the new page on its next load. Measured on production 2026-09-29, one click:
 * five promotions and five demotions in two seconds, alternating.
 */
function handOver(): void {
  const requeue = requeueForPromotion;
  requeueForPromotion = null;
  clearPromotionReload();
  // Notify the session to close its WebSocket (otherwise the MLS ratchet would advance in two tabs
  // simultaneously) - and learn from its answer whether this document is ending.
  if (leaderDemotedHandler?.() === 'reloads') {
    leaving = true;
    return;
  }
  requeue?.();
}

function ensureTabChannelForLocalStorage(log: (msg: string) => void): void {
  if (tabChannel) return;
  tabChannel = new BroadcastChannel('canari-mls-tab');
  tabChannel.addEventListener('message', (ev: MessageEvent) => {
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
 * Set in THIS tab's sessionStorage just before a promoted tab reloads, consumed by the election of
 * the document that reload starts.
 *
 * **A PROMOTION THAT RELOADS GAVE THE LOCK AWAY, AND "PRENDRE LA MAIN" NEVER STUCK.** A promoted
 * tab reloads to pick up the MLS state the old leader left (see the promotion handler in
 * `useChatSession.svelte.ts`), and Web Locks are per-document: the reload releases the lock it was
 * just granted. The tab it took over from had requeued at once (the take-over, removed 2026-11-08), so it was
 * granted the lock back before the reloaded page could ask. Measured on production 2026-09-28, one
 * click on the button:
 *
 *   19:25:33.243  Promoted to leader (Web Locks)          <- the take-over works
 *   19:25:33.243  Leader promoted - reloading ...          <- ...and gives the lock away
 *   19:25:33.991  Another tab is active - read-only mode   <- the old leader has it again
 *   19:25:34.249  Promoted to leader / reloading ...       <- and the two trade it once more
 *   19:25:35.297  Another tab is active - read-only mode
 *
 * The reload is the same tab continuing, not a new candidate, so its election STEALS the lock
 * rather than queueing for it. Nothing else gets this: a first load, or a reload for any other
 * reason, queues as before.
 */
const PROMOTION_RELOAD_KEY = 'canari_tab_promotion_reload';

/**
 * Records that this tab is about to reload BECAUSE it was promoted - call it right before the
 * reload. The document the reload starts reclaims the leader lock instead of queueing behind the
 * tab that was granted it in between.
 */
export function markPromotionReload(): void {
  try {
    sessionStorage.setItem(PROMOTION_RELOAD_KEY, '1');
  } catch (e) {
    // Said, because the only other symptom is the take-over that does not stick.
    console.warn(
      '[TAB] could not record the promotion reload - the lock may go back to the old leader:',
      String(e)
    );
  }
}

/** Drops the mark: a document that hands the lead over has no promotion left to reclaim. */
function clearPromotionReload(): void {
  try {
    sessionStorage.removeItem(PROMOTION_RELOAD_KEY);
  } catch {
    /* no storage: there is no mark to clear either */
  }
}

/** Reads and clears the mark: one reload reclaims once, never for the rest of the tab's life. */
function consumePromotionReload(): boolean {
  try {
    const marked = sessionStorage.getItem(PROMOTION_RELOAD_KEY) !== null;
    sessionStorage.removeItem(PROMOTION_RELOAD_KEY);
    return marked;
  } catch {
    return false;
  }
}

/**
 * Handles the rejection of a leader-lock request. A lock STOLEN from under a serving leader demotes
 * it exactly as a take-over does, since the MLS ratchet must never advance in two tabs; any other
 * rejection is a document going away and needs nothing.
 */
function onLeaderLockRejected(e: unknown, log: (msg: string) => void): void {
  if (leadership !== 'leader' || (e as { name?: unknown } | null)?.name !== 'AbortError') return;
  log('[TAB] Leader lock reclaimed by a tab reloading after its promotion - handing over.');
  // The lock is no longer this document's: nothing may release it again (a freeze, the unload).
  releaseLeaderLock = null;
  decide('follower');
  handOver();
}

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
  if (leaving) return;
  // Withdrawable, so a freeze can take it out of the queue (`watchPageLifecycle`).
  const request = new AbortController();
  promotionRequest = request;
  void navigator.locks
    .request('canari-tab-leader', { mode: 'exclusive', signal: request.signal }, async () => {
      if (promotionRequest === request) promotionRequest = null;
      if (leadership === 'leader') return;
      decide('leader');
      log('[TAB] Promoted to leader (Web Locks).');
      requeueForPromotion = () => queueForPromotion(log);
      tabChannel?.postMessage({ type: 'leader_promoted', tabId: TAB_ID });
      notifyTabLeaderPromoted();

      await holdLeaderLockUntilUnload();
    })
    .catch((e: unknown) => onLeaderLockRejected(e, log));
}

/**
 * A HIDDEN LEADER HANDS THE LEAD TO THE VISIBLE TAB THAT NEEDS IT (owner, Firefox 159, 2026-11-10).
 *
 * The `freeze` hook above is Chromium's alone: Firefox implements no Page Lifecycle events, and
 * Safari none either. On Firefox the owner's visible follower queued a photo that stayed unsent
 * until he brought the HIDDEN leader tab forward - it went out the instant that tab was shown. The
 * hidden leader was not dead: its log shows it receiving socket frames and raising notifications
 * while hidden. What it did not do was finish the send while hidden. Rather than chase each thing a
 * background tab does slowly, the lead goes where the member is - from facts, never a clock:
 *
 * - a FOLLOWER that is VISIBLE and has a message of its own waiting on the leader (the outbox says
 *   so: {@link requestLeaderHandover}) posts `leader_handover_request`;
 * - the LEADER answers it only when it is itself HIDDEN (a visible leader serves, and keeps the
 *   lead): it decides `follower` FIRST, so nothing it resumes into writes again (the send guard,
 *   `refusesCommitsHere` at the encrypt), posts `leader_handover_granted` naming the requester,
 *   and hands over (its socket paused, its reload scheduled);
 * - the requester, and only it, then STEALS the lock (`steal: true`): granting it through the
 *   queue would hand it to whichever tab queued first, possibly another hidden one. Its promotion
 *   reloads it onto the state the old leader left, and that reload reclaims the lock.
 *
 * Portable: a `BroadcastChannel` message is delivered to a background tab that still runs events
 * (the owner's hidden Firefox leader processed socket frames), and a stolen Web Lock is the
 * browser's mutual exclusion, whoever held it. A leader that runs no event at all (frozen, wedged)
 * cannot answer; Chromium's freeze is covered above, a wedged thread is not.
 */
function watchHandover(channel: BroadcastChannel, log: (msg: string) => void): void {
  if (handoverWatched) return;
  handoverWatched = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') handoverAsked = false;
    });
  }
  channel.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as { type?: unknown; tabId?: unknown; to?: unknown } | null;
    if (data?.type === 'leader_handover_request' && typeof data.tabId === 'string') {
      if (leadership !== 'leader' || !releaseLeaderLock) return;
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return;
      log(
        `[TAB] Hidden leader asked for the lead by a visible tab (${data.tabId.slice(0, 8)}) - handing it over.`
      );
      // The lock is the requester's to steal: this document neither releases it into the queue
      // nor touches it again (its unload, its freeze).
      releaseLeaderLock = null;
      decide('follower');
      channel.postMessage({ type: 'leader_handover_granted', to: data.tabId });
      handOver();
      return;
    }
    if (data?.type === 'leader_handover_granted' && data.to === TAB_ID) {
      if (leadership === 'leader' || leaving) return;
      takeHandedOverLead(log);
    }
  });
}

let handoverWatched = false;
/** This page already SAID it asks for the lead in this visible stretch (the ask itself repeats). */
let handoverAsked = false;

/** The requester's half: the lock taken from the hidden leader that granted it. */
function takeHandedOverLead(log: (msg: string) => void): void {
  // This document's own place in the queue is moot once it holds the lock.
  const queued = promotionRequest;
  promotionRequest = null;
  queued?.abort();
  void navigator.locks
    .request('canari-tab-leader', { mode: 'exclusive', steal: true }, async () => {
      if (leadership === 'leader') return;
      decide('leader');
      log('[TAB] Lead handed over by the hidden leader tab - promoted (Web Locks).');
      requeueForPromotion = () => queueForPromotion(log);
      tabChannel?.postMessage({ type: 'leader_promoted', tabId: TAB_ID });
      notifyTabLeaderPromoted();
      await holdLeaderLockUntilUnload();
    })
    .catch((e: unknown) => onLeaderLockRejected(e, log));
}

/**
 * From a FOLLOWER: this tab has something of its own waiting on the leader (a queued message), and
 * the member is looking at it - ask a HIDDEN leader for the lead ({@link watchHandover}). A no-op
 * unless this page is a visible Web Locks follower. Asked on every flush this follower hands over -
 * a visible leader ignores it, and a leader hidden SINCE the last ask answers the next one - and
 * SAID once per visible stretch of this page (the line would otherwise repeat on every trigger).
 */
export function requestLeaderHandover(log: (msg: string) => void): void {
  if (leadership !== 'follower' || leaving || !tabChannel || !handoverWatched) return;
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  if (!handoverAsked) {
    handoverAsked = true;
    log(
      '[TAB] Visible follower with a message waiting on the leader - a hidden leader is asked for the lead (said once while visible).'
    );
  }
  tabChannel.postMessage({ type: 'leader_handover_request', tabId: TAB_ID });
}

/**
 * Tries to become leader using the Web Locks API.
 * - First tab acquires the exclusive lock and is the leader.
 * - Subsequent tabs queue a non-ifAvailable request; they become leaders
 *   automatically when the current lock holder's tab closes.
 * Returns true if this tab immediately became leader.
 */
async function initWithWebLocks(log: (msg: string) => void): Promise<boolean> {
  if (!tabChannel) tabChannel = new BroadcastChannel('canari-mls-tab');
  watchPageLifecycle(log);
  watchHandover(tabChannel, log);

  const reclaim = consumePromotionReload();
  if (reclaim) log('[TAB] Reloaded after a promotion - reclaiming the leader lock.');
  const acquired = await new Promise<boolean>((resolveLeadership) => {
    void navigator.locks
      .request(
        'canari-tab-leader',
        reclaim ? { mode: 'exclusive', steal: true } : { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (lock === null) {
            resolveLeadership(false);
            return;
          }
          decide('leader');
          log('[TAB] Leadership acquired (Web Locks).');
          requeueForPromotion = () => queueForPromotion(log);
          resolveLeadership(true);
          await holdLeaderLockUntilUnload();
        }
      )
      .catch((e: unknown) => {
        onLeaderLockRejected(e, log);
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
 * nothing - permanently. "Prendre la main" (removed 2026-11-08) could not rescue it: `requestLeadershipTakeover` posted on
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
  requeueForPromotion = null;
  releaseLeaderLock = null;
  promotionRequest = null;
  requestWithdrawnByFreeze = false;
  leaving = false;
  handoverAsked = false;
  // The channel is closed above: the next election's channel needs its own listener.
  handoverWatched = false;
  try {
    sessionStorage.removeItem(PROMOTION_RELOAD_KEY);
  } catch {
    /* ignore */
  }
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
