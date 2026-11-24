## P2 - A browser-wide worker holds the MLS state, instead of a leader tab

target: 1.9.0

**Decided by the owner on 2026-11-24** ([decisions](../decisions/owner-decisions-of-2026-11-24.md)):
the leader-tab symptom is fixed in `1.8.0`
([chat](../frontend/modules/chat.md#a-leader-whose-own-session-ended-gives-the-lead-up-2026-11-24)).
This design is written now, and the worker is built in `1.9.0` under an adversarial review. The
review is Opus-class, as for every MLS change.

### Why

On the web, one tab per browser profile runs the MLS state, the socket and the commits. The other
tabs proxy through it: sends through the outbox, commits through `tabCommitDelegation.ts`, frames
through `emit-frame`, and seals through `seal-salon-message`. Every defect of the multi-tab chantier
came from that role sitting in a DOCUMENT, which the browser hides, throttles, freezes, discards,
navigates and locks under the member:
- the follower that stayed undecided (TAB-4b);
- the tab queued behind itself (2026-09-21);
- the take-over loop (2026-09-28/29);
- the follower checkpoint that forked the state (web `1.6.10`);
- the hidden Firefox leader (2026-11-10);
- the leader whose session ended in place (2026-11-24).

Each was fixed, and each fix added a seam: the hand-over, the freeze release, `stateAuthority`, the
promotion reload, `DrainAckHold`, `whenBulkIngestsClosed`, eligibility. Two cases stay open by
construction, and no event can close them:
- a leader whose main thread is wedged;
- an engine that suspends a page without dispatching `freeze` (Firefox, Safari).

A worker owned by no tab removes the role from the document. Every tab becomes a client of one
state, and the promotion reload disappears with the promotion.

### The shape

- **One `SharedWorker` per origin and account** (`new SharedWorker(url, { name: 'canari-mls' })`)
  holds:
  - the `BaseMlsService` web client and its openmls WASM instance - one copy of the ratchet in
    memory, so no load fact and no "promoted in place";
  - the gateway WebSocket, the inbound pipeline, the ACK hold and the checkpoint persister;
  - the outbox flush, and the executors that `tabCommitDelegation.ts` registers today.
- **Tabs are clients**. Each holds the UI state (the conversation `SvelteMap`, the stores) and talks
  to the worker over its `MessagePort`:
  - requests are typed, mirroring `DelegatedCommitOp`, plus send, decrypt-for-display, history and
    reconcile;
  - events go back to the tab (message arrived, group ready, socket state).

  `tabMessageSync`'s `BroadcastChannel` events become worker events. The durable request records
  stay: they are what makes a request survive the worker's own restart.
- **Single writer, proved by a lock rather than by the worker's uniqueness.** The worker takes
  `canari-tab-leader` (a Web Lock; `navigator.locks` exists in workers) before it loads the state.
  After a deploy, the browser can run two `SharedWorker`s at once: an old build's, still serving the
  open tabs, and a new one. The lock keeps the second from writing until the first is gone. The
  worker URL carries the build id, so both versions are worker scripts in their own right, and
  uniqueness alone would be the assumption that broke the leader tab. The write latch
  (`MlsStateWriteLatch`) keeps reading the lock role at the put.
- **The unlock becomes browser-wide.** The worker holds the device key once a tab has unlocked:
  - a second tab attaches to an unlocked worker without a PIN;
  - a lock from any tab ends the worker's session for all of them, and the worker drops the key.

  This is a product change (charter principle 1, *your messages are yours*). Today each tab unlocks
  on its own, and a locked tab shows nothing. The owner confirms it before the build.
- **Storage ownership.**
  - IndexedDB (`CanariDB_<userId>`, the MLS state store, `CanariDBTabCommit_<userId>`, the app log)
    is reachable from a `SharedWorker`. The worker becomes the only writer of the MLS state and its
    checkpoint. Tabs keep reading the message rows they render, as followers do today.
  - OPFS: `navigator.storage.getDirectory()` works in a `SharedWorker`, but `createSyncAccessHandle`
    is dedicated-worker only. Any path that relies on a sync handle (the segmented media writer, if
    it moves there) stays in a dedicated worker started by a tab.
- **Nested workers.** `mlsCrypto`, `mlsEncrypt` and `mlsKeyPackage` are dedicated workers started
  by the page today. Whether a `SharedWorker` may start a dedicated worker in every target engine
  is the first measurement of the build (Chromium and Firefox; WebKit at the `1.9.0` alpha). Where
  it may not, the worker runs that code inline. Off-main-thread is what those workers were for, and
  the shared worker is already off the main thread.
- **When every tab closes.** The worker ends with its last client: the socket closes, and nothing
  is lost that a tab close loses today. Every commit, Welcome and application frame is held by the
  ACK hold until a landed checkpoint or a stored row covers it, so the server keeps it. Push
  notifications are the service worker's job and do not change. The next tab starts a worker that
  loads the state from disk, as a cold start does.
- **Freezing.** Chromium freezes a worker only when all its clients are frozen. One visible tab
  keeps it running, which is exactly the property the leader tab lacked. This is to be measured
  (`chrome://discards` with one tab frozen and one visible) before the design is believed.

### Where it does not apply

- **Tauri (iOS, Android, desktop)**: one webview, always the leader (`runElection`). The native
  engine holds the state, and nothing changes there.
- **Chrome for Android and Samsung Internet (the mobile web)**: no `SharedWorker`. **Safari, macOS
  and iOS**: `SharedWorker` since Safari 16. **Firefox and Chromium desktop**: supported.

  The engines without it keep the leader-tab model as it stands after `1.8.0`. This is a CAPABILITY
  chosen once, at boot, by feature detection, and logged with the engine. It is not a fallback
  reached by a failure: a `SharedWorker` that fails to start on an engine that has one is a defect,
  accused at error, never a quiet switch to the tab model. On a phone, a second tab is rare and the
  PWA is one window, so the residual cost is the code kept, not a behaviour.

### Migration from the leader-tab model

1. **Move the MLS host behind an interface the page already almost has.** The delegation ops,
   `sendFrameFromThisTab`, the outbox flush request and the leader link are the follower's whole
   view of the leader today. Make every tab a follower of an in-page host first, with no behaviour
   change on the web, so that tests can drive both hosts.
2. **Build the worker host** behind a compiled switch (`SHARED_WORKER_MLS_COMPILED`), on by default
   on dev only. The lead may flip it once its readings pass (the release authority in `CLAUDE.md`).
3. **The upgrade path.** A browser holding an old leader tab and a new worker is the deploy window.
   The lock above makes it one writer, and the new build's tabs refuse to start a worker while an
   old build's leader holds the lock: they attach as followers until it closes, as followers do
   today.
4. **Delete on the engines that have the worker** the promotion reload, the hand-over, the freeze
   release, eligibility and `stateAuthority`'s load fact. Keep them only for the engines in the
   list above. A seam kept for no engine is dead code and goes.

### Risks to settle in review

- **Every UI-facing MLS call becomes asynchronous across a port.** A call that today reads the
  client synchronously (group readiness, `canSendInGroup`) needs a mirrored snapshot in the tab, and
  a snapshot that lags is a new kind of race. Enumerate the call sites before choosing.
- **Debuggability.** A shared worker's console is in `chrome://inspect/#workers`, and Firefox shows
  it in `about:debugging`. The in-app log (`appLog.ts`) must flush from the worker, or the export
  loses its most important half - the 2026-11-10 lesson.
- **Memory.** One WASM instance instead of one per tab is a gain. A worker that leaks is now
  browser-wide.
- **A wedged worker** wedges every tab instead of one. A worker with no event loop answers no
  request, which is the leader-tab defect concentrated. The durable records, and the run-lock proof
  of death, still answer for a worker that died. One that hangs is visible in every tab at once
  instead of being hidden in a background one, and that visibility is the point.
- **Safari's private browsing and storage partitioning.** A third-party context is out of scope.
  Canari runs first-party.

### Done when

- On Chromium and Firefox desktop, two tabs and one worker give:
  - no promotion reload;
  - a hidden or frozen tab changes nothing;
  - a gesture from either tab runs once.
- The deploy window keeps one writer, read on dev with the web rig.
- The tab model is gone from every engine that has `SharedWorker`.
