# Performance audit under a heavy MLS state - 2026-10-12

The question: what does the client spend when the account is HEAVY - 60 conversations, 20
communities of 8 salons, 20k stored messages, 80+ MLS groups with real trees, a 5k-message thread.
Read from the code at `main` `dc973bea8` (every finding carries `file:line` on that commit), then
measured where a measurement could be taken without production. Companion of the
[web console log audit](web-console-log-audit-2026-10-12.md) (A-H there; C, D, F are re-ranked
here with numbers) and of the notification-tap latency work
([notification-to-conversation-latency](notification-to-conversation-latency.md), PR #1770), which
this audit did not touch.

**Every number below was measured identically before and after, and every regression test pins a
COUNT, never a clock** ([durable-rules](../durable-rules.md)).

## Ranked findings (cost x frequency)

Paths are under `frontend/src/lib/` unless they say otherwise. "Shipped" = a draft pull request.

| #   | Finding                                                                                                                                                                                                                                                                                                                                           | Where                                                                                                                                                                                                                | Frequency                                                                | Measured                                                                                                                                                                                                                   | Disposition                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **The restore decrypts every stored message to read a length.** The history replay checks its cursor against a wiped store with `getMessages(id).length === 0`, one AES-GCM decrypt per row                                                                                                                                                       | `utils/chat/history.ts:545`, called from the serial restore loop `utils/chat/conversations.ts:922-993`                                                                                                               | every cold start, every conversation                                     | 5000 rows: 158-190 ms -> 2.6-2.9 ms (desktop, fake IndexedDB); decrypts 5000 -> 0                                                                                                                                          | **#1772** (`countMessages`)                                                                                                    |
| 2   | **One full encrypted checkpoint per drain, and a drain is often ONE frame.** `onBulkIngestEnd` sets `dirtyEncrypted = true` unconditionally, overwriting the commit/application distinction `setupMessageHandler.ts:965/983` made                                                                                                                 | `mls-client/mlsStatePersister.ts:130-135`                                                                                                                                                                            | every received frame on a live socket                                    | 7.7 MB state (80 groups x 44 leaves): desktop Chrome 2.3 ms export + 1 ms copy + **141 ms seal** + 31 ms IndexedDB put; native 3.8 ms export, 9.8 ms export+seal. One decrypt: 0.4 ms. The checkpoint is ~400x the message | Backlog (durability decision, see below)                                                                                       |
| 3   | **The WASM seal is the checkpoint.** ChaCha20-Poly1305 in WASM has no SIMD backend (`chacha20` 0.10 ships avx2/sse2/neon/soft only) and runs at ~55 MB/s; it is off the main thread (encrypt worker) but costs CPU, battery and the durability window on every checkpoint                                                                         | `mls-wasm/src/lib.rs:93`, `mls-client/mlsEncryptWorkerSession.ts:77`                                                                                                                                                 | every checkpoint                                                         | 141-148 ms of 175 ms per 7.7 MB checkpoint (82 %) in desktop Chrome                                                                                                                                                        | **Built, writer OFF**: the framed `state_blob` v2 ([below](#the-webcrypto-seal-v2---measured-2026-10-12)), 198 -> 47 ms per checkpoint |
| 4   | **A message anywhere redraws the open thread.** `currentConvo` iterated the conversation `SvelteMap`, which subscribes to every key: each write to any of ~220 conversations re-ran it and ChatArea redid `groupMessages`, seen-by, one `parseEnvelope` per message (polls) and the unread count, plus a props refresh of every mounted row       | `composables/useConversations.svelte.ts:306-318` -> `components/chat/ChatArea.svelte:495-627`                                                                                                                        | every frame received outside the open thread                             | 52 writes elsewhere: 52 recomputations -> 0. Per recomputation on 5k messages: `groupMessages` 1.3-1.7 ms + 5000 `parseEnvelope` 1.2-2.7 ms (desktop, warm) + the row render (not measured)                                | **#1773** (`get(key)`)                                                                                                         |
| 5   | **IndexedDB pages read the whole conversation.** `getMessagesPage` `getAll`s every row of the conversation, sorts, slices 50; there is no `[conversationId, timestamp]` index (SQLite has `LIMIT` but only `idx_messages_conv`, so it sorts in a temp B-tree)                                                                                     | `db/indexeddb.ts:609-635`, `db/sqlite.ts:183,598-616`                                                                                                                                                                | ~3 calls per conversation per cold start, every scroll-back              | 5000 rows: 28-31 ms per 50-row page                                                                                                                                                                                        | Backlog (needs an IndexedDB version bump)                                                                                      |
| 6   | **A catch-up batch re-sorted the whole conversation once per message**                                                                                                                                                                                                                                                                            | `utils/chat/messageOrder.ts:36-59` (callers `useMessaging.svelte.ts:638,708,941`, `ChatBackgroundService.svelte:1186,1219,1231`)                                                                                     | every batch, every conversation                                          | 200 into 5000: 18.5-25.3 ms -> 0.1 ms; sorts 200 -> 1                                                                                                                                                                      | **#1774** (one stable sort)                                                                                                    |
| 7   | **Per-connection N+1 reads.** `removeStrayLeaves` reads `user-members` once per held group, serially (80 in 6.3 s in the console audit); `forgetGroupsAbsentFromServer` asks `GET /mls/groups/<id>` for every key-distribution group twice per connection (sync + discovery); `/users/<me>/groups` is fetched 3x per cold start, 2x per reconnect | `mls-client/initializeConnection.ts:254-344`, `utils/chat/strayLeaves.ts:55`, `utils/chat/groupSweep.ts:147`, `utils/chat/groupLifecycle.ts:274`, `utils/chat/actions.ts:465,488`, `utils/chat/conversations.ts:893` | every connection and reconnect                                           | console audit: 80 + 16 requests per connection                                                                                                                                                                             | Backlog D and F (a batched roster read is a server endpoint; the twice-asked groups need one answer shared by the two sweeps)  |
| 8   | **A Welcome re-runs the whole restore** (finding 1 and 5 for every conversation, plus `/groups`)                                                                                                                                                                                                                                                  | `composables/session/sessionAuth.ts:1351,1364`                                                                                                                                                                       | per Welcome processed - a new device joining 80 groups restores 80 times | not measured                                                                                                                                                                                                               | Backlog                                                                                                                        |
| 9   | **The thread's render window only grows.** After a scroll to the top of a 5k thread every group stays mounted (~25-40 nodes per bubble), and every bubble registers its own `matchMedia('(pointer: coarse)')` listener, a non-passive `touchmove`, and (non-phone) a `<svelte:window onkeydown>` in its toolbar                                   | `utils/chat/renderWindow.ts:74-76`, `components/messages/MessageBubble.svelte:219,529-545`, `components/messages/MessageBubbleToolbar.svelte:190`                                                                    | per mounted message                                                      | not measured (needs a browser on a seeded 5k thread: `document.querySelectorAll('[id^="msg-"]').length`, `getEventListeners(window).keydown.length`)                                                                       | Backlog                                                                                                                        |
| 10  | **The seen-cipher ledger is re-stringified per frame.** The microtask flush coalesces only marks made in one synchronous turn, and the drain awaits a decrypt between frames, so each frame stringifies and writes the whole set (up to 5000 + 5000 entries) to `localStorage`, synchronously                                                     | `utils/chat/history.ts:171-208`                                                                                                                                                                                      | every received frame                                                     | not measured (proof: count `setItem` on `history_seen_cipher:*` while draining N frames through an async stub - expected N, the comment claims 1)                                                                          | Backlog                                                                                                                        |
| 11  | **Restore and replay do two more full reads** when the replay produced rows (`existingById`, the post-update pass)                                                                                                                                                                                                                                | `utils/chat/history.ts:1136,1209`                                                                                                                                                                                    | cold start, only for conversations with new rows                         | not measured                                                                                                                                                                                                               | Backlog (a `getMessagesByIds`)                                                                                                 |
| 12  | **Native: the manager mutex is held across export + seal + file write**, so a send (`envoyer_message_bytes`, a sync command) or a decrypt waits for a whole checkpoint                                                                                                                                                                            | `src-tauri/src/commands/mls.rs:216-231`                                                                                                                                                                              | every checkpoint on Android/iOS                                          | Mi 9T 2026-10-13: a sync command waiting on it freezes the WebView, 1.6-3.2 s per call in debug ([measured](community-open-slowness-mi9t-2026-10-13.md#finding-1---a-synchronous-mls-command-freezes-the-webview-for-the-rest-of-a-checkpoint))| Backlog                                                                                                                        |
| 13  | **Sidebar rebuilds and re-sorts every conversation row on any write**, salon traffic included                                                                                                                                                                                                                                                     | `components/sidebar/Sidebar.svelte:340-370`                                                                                                                                                                          | every frame                                                              | O(220) per frame; not measured                                                                                                                                                                                             | Recorded                                                                                                                       |
| 14  | **Every PDF opened started its own pdf.js worker** (one per mount after #1760)                                                                                                                                                                                                                                                                    | `utils/pdfDocument.ts:146`                                                                                                                                                                                           | per PDF mount                                                            | workers for 4 documents: 4 -> 1                                                                                                                                                                                            | **#1771** (shared `PDFWorker`)                                                                                                 |
| 15  | **Calls code ships at startup with `CALLS_ENABLED = false`**: `CallService` (static in `useChatSession.svelte.ts:20`) and `CallOverlay` (static in `ChatBackgroundService.svelte:56`) are reachable from the root layout                                                                                                                          | `composables/useChatSession.svelte.ts:20`                                                                                                                                                                            | every cold start (parse)                                                 | not measured                                                                                                                                                                                                               | Recorded - the cold-start page says parse time must be MEASURED before any split                                               |
| 16  | **Dead code**: 10 TS exports, 5 WASM bindings, 1 native command with no caller                                                                                                                                                                                                                                                                    | see #1775                                                                                                                                                                                                            | -                                                                        | 201 lines                                                                                                                                                                                                                  | **#1775**                                                                                                                      |

### What the audit found that is not performance

- `stores/announcement.svelte.ts:126` `resetAnnouncementState` is documented as "so the next account
  to sign in is asked on its own behalf" and nothing calls it: a second account signing in in the same
  tab is probably never shown its announcements. Kept in #1775; **wired 2026-10-13**: `logoutImpl`
  now calls it (pinned by `session/logoutResetsAccountState.test.ts`), and the reset moves a
  generation on so an ask still in flight when its account signs out cannot land its announcement
  for the next one (`stores/announcement.test.ts`).
- The web checkpoint comments still say "Argon2" (`services/WebMlsService.ts:68,878,900,904`,
  `mls-client/mlsEncryptWorkerSession.ts:74`); the seal has been a direct ChaCha20-Poly1305 under the
  device key since v0.11.0 (`mls-wasm/src/lib.rs:93`). Finding 3 is what the Argon2 story hid.
- `media.segmentedWriter.e2e.test.ts:4` still says `SEGMENTED_MEDIA_WRITER_ENABLED` "is `false` and
  stays so"; it is `true` since 2026-10-05.

## Finding 2 and 3, read together - the checkpoint question the backlog owed

The console audit's checkpoint item asked for "a trace splitting the WASM export (main thread) from
the IndexedDB write" before deciding anything. Measured on a synthetic heavy state with
[tools/perf-bench](../../../tools/perf-bench/README.md) (desktop Chrome, the app's own WASM, medians
of 5, after ONE application message in ONE group):

| groups (44 leaves, 10 past epochs, 3 senders x 20 frames) | state   | export (main thread) | copy   | seal (worker) | IndexedDB put |
| --------------------------------------------------------- | ------- | -------------------- | ------ | ------------- | ------------- |
| 5                                                         | 0.48 MB | 0.1 ms               | 0.1 ms | 9.3 ms        | 1.3 ms        |
| 20                                                        | 1.9 MB  | 0.6 ms               | 0.3 ms | 35.4 ms       | 8.1 ms        |
| 40                                                        | 3.8 MB  | 1.2 ms               | 0.4 ms | 71.0 ms       | 14.3 ms       |
| 80                                                        | 7.7 MB  | 2.3 ms               | 1.0 ms | 141.2 ms      | 30.9 ms       |

Native, same shapes (`cargo test --release --test heavy_state_checkpoint -- --ignored`, x86 desktop):
export 0.3 / 1.1 / 2.3 / 3.8 ms, export + seal 0.7 / 2.3 / 5.0 / 9.8 ms, one decrypt 0.11-0.12 ms.

What this settles:

- **The main thread is not where the checkpoint costs.** The export is 2-4 ms even at 7.7 MB - the
  same order as the "typical 7.5 MB" state named in `WebMlsService.ts`. The 348 ms median of the
  console log is the seal, the IndexedDB write and the round trips around them, on a slower browser.
- **The cost is linear in the WHOLE state, not in the group that moved**: ~1.8 ms of seal per group
  on desktop Chrome, for a message whose own decrypt is 0.4 ms. There is no per-group dirtiness
  (`mls-core/src/state.rs:813-861` writes the whole `MemoryStorage`).
- **The seal is 82 % of it in a browser** and 60 % natively; a faster primitive alone (WebCrypto
  AES-GCM runs at GB/s) would cut the web checkpoint about five-fold without touching durability.

What it does NOT settle, and is still owed before changing the flush policy: what losing an
application-only ratchet advance costs once the frame is acked (TAB-3b in the
[backlog](../backlog.md) says the fingerprint mark must be one write with the advance). The three
levers, cheapest first: a faster seal (format, no semantics); not checkpointing a drain that only
advanced receive ratchets (semantics - needs the TAB-3b answer); per-group storage (structure).

## The WebCrypto seal (v2) - measured 2026-10-12

Lever one above, built: the framed `state_blob` v2 (AES-256-GCM through WebCrypto on the web, read
by `mls-core` everywhere - the design and the downgrade story are in
[mls-protocol](../protocols/mls-protocol.md#v2---the-browser-seals-with-webcrypto-every-platform-reads-it-2026-10-12)).
Same bench, same states, desktop Chrome, the app's own WASM and the app's own `mlsStateSeal.ts`,
medians of 5 (loads: of 3) from two runs - a range is the two runs' medians, and the small states
spread by up to ~40 % (20 groups: load 60-84 ms), so read the 80-group row. "legacy" is the
unframed `[nonce || ChaCha20-Poly1305]` blob every web client writes today - NOT the framed v1,
which nothing writes; the bench's own output calls these columns `v1`:

| groups | state | seal legacy (WASM ChaCha) | seal v2 (WebCrypto) | checkpoint legacy | checkpoint v2 | load legacy | load v2 (web) | v2 through the WASM reader |
| ------ | ----- | --------------------- | ------------------- | ------------- | ------------- | ------- | ------------- | -------------------------- |
| 5      | 0.48 MB | 11 ms               | 0.3-0.5 ms          | 13 ms         | 2-3 ms        | 18-20 ms | 8-9 ms       | 44-52 ms                   |
| 20     | 1.9 MB  | 40-44 ms            | 3 ms                | 50-60 ms      | 12-16 ms      | 60-84 ms | 25-39 ms     | 152-197 ms                 |
| 40     | 3.8 MB  | 83 ms               | 6-7 ms              | 101-104 ms    | 22-27 ms      | 129-143 ms | 46-66 ms   | 327-360 ms                 |
| 80     | 7.7 MB  | 158-163 ms          | 10-11 ms            | 196-200 ms    | **47 ms**     | 233-240 ms | **96-98 ms** | 610-618 ms               |

"checkpoint" = export + (legacy only: the copy for the worker) + seal + IndexedDB put. "load" = what a
cold start pays to construct the client from the stored blob.

- **A 7.7 MB checkpoint goes from ~198 ms to ~47 ms (4.2x); the seal alone from ~160 to ~10 ms.**
  What is left is the IndexedDB put (~34 ms) and the export.
- **The cold-start load also halves (240 -> 97 ms)**, but ONLY because the web opens v2 with
  WebCrypto: the WASM reader's software AES took 610 ms, ~2.5x WORSE than ChaCha. That column is
  why `loadAndInitWasm` dispatches v2 to WebCrypto; it is not a web path.
- **The main thread's longest stall during the v2 seal read 0.0 ms** (a `MessageChannel` ping loop,
  resolution ~0.1 ms): Chrome copies and encrypts off the JavaScript thread. The legacy seal ran in the
  encrypt worker, so its column is CPU and battery, never main-thread time - the v2 win is in the
  durability window, CPU and battery, not in jank.
- **THE WRITER SHIPS OFF** (`MLS_STATE_SEAL_V2_WRITER_ENABLED = false`, read-first): nothing above
  reaches a user until the one-line flip the mls-protocol section conditions.

**Not measured:** Firefox and Safari (WebCrypto off-thread there is believed, not seen); the Mi 9T's
Chrome; a native read of a v2 blob on a phone (only a restored web backup does it, once).

## Phase 2 - what was measured, and what was not

**Measured (reproducible, in the repository):** the checkpoint split above (browser and native), and
the per-change before/after numbers in each pull request (vitest on a desktop, `fake-indexeddb`).

**Not measured, and why:**

- **The heavy state on the dev estate** (60 conversations, 20 x 8 salons, 20k messages). Salon and
  conversation messages are end-to-end encrypted by the client, so the only way to write them is the
  composer ([seed-bench](../../../tools/cross-client-harness/seed-bench.mjs) types them one by one);
  20k messages is hours of typing, and no shortcut exists that would not bypass the product. The
  synthetic states above stand in for the MLS half; the UI half (cold start to usable list, a 5k
  thread's scroll jank, heap snapshots) is still owed on such a state.
- **The Mi 9T.** The bench page was opened on it once and the phone was in use by another session
  (the Canari app in the foreground with a picker open); the run was abandoned rather than contend
  for the device. Owed: `adb reverse tcp:5199 tcp:5199` and the same URL in its Chrome.
- **Battery wakeups** and **sqlite write volume per message** on hardware. The write count per
  received application message, read from the code: one message batch write and one conversation row
  per drain, three `localStorage` writes (seen ledger + its index + the send-ratchet ledger), and one
  full checkpoint (finding 2) - the checkpoint dominates the bytes by three orders of magnitude.

## Draft pull requests from this audit

| PR    | Change                                                    | Pinned by                                                                                                |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| #1771 | one pdf.js worker for every PDF                           | `utils/pdfDocument.test.ts` (4 documents -> 1 worker)                                                    |
| #1772 | the restore counts stored rows instead of decrypting them | `utils/chat/history.cursorCheck.test.ts` (0 full reads)                                                  |
| #1773 | the open conversation is read by its own key              | `composables/useConversations.currentConvoScope.svelte.test.ts` (0 recomputations for 52 foreign writes) |
| #1774 | a catch-up batch is merged with one sort                  | `utils/chat/messageOrder.test.ts` (1 sort; equal to the old loop on random input)                        |
| #1775 | delete 16 exports nothing calls                           | grep evidence in the PR                                                                                  |

## How to re-measure

```sh
bun tools/perf-bench/serve.ts                       # browser checkpoint split, open :5199
cd frontend/mls-core && cargo test --release --test heavy_state_checkpoint -- --ignored --nocapture
```
