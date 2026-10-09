# Offline and weak network: what the app does today, measured, and the plan

> **Request (user, 2026-10-09):** *Canari is extremely bad and laborious on a weak connection. It must
> be usable with NO connection, a WEAK one and a GOOD one, on web, Android and iOS. Messages seem to
> appear only once sent.* Direction decided: optimistic send plus a durable queue, **measured first**.
> This page is the measurement phase. No production code changed; the plan at the end is for the
> sessions that follow.

**Read first: [local-first-ui](local-first-ui.md)** (the rule that no interaction servable locally may
await the network, and the phone measurement of 2026-09-22 this page extends) and the Outbox section of
[chat](modules/chat.md#outbox-outbound-delivery).

## 0. The verdict, in five lines

1. **The premise is false for direct messages and groups (MLS), true for community salons.** A DM or
   group message is shown at once (28-50 ms, every network condition, including offline) and sits in a
   durable IndexedDB outbox that survives a reload. A SALON message is not shown at all until the
   server has it, and **sent while offline it is LOST**: the composer is emptied, a toast says
   "Echec de l'envoi", nothing is queued, nothing is on screen.
2. **The cold start is the weak-network killer, not the send.** Cold on "Slow 3G" the list is usable
   after **103-108 s** (first paint 23 s). Warm it is 2.1 s (Slow 3G) / 6.0 s (2G-like).
3. **Nothing in the app has a deadline.** `apiFetch` has no timeout; the connectivity store only knows
   "reachable" or "transport failure", never "slow". A slow link is a spinner of unknown length.
4. **The local estate serves JS/CSS/WASM uncompressed over HTTP/1.1, and so did PRODUCTION until
   WP-W1 (2026-10-09)**: `canari.emse.fr` answers from the host with no CDN in front (the 723 kB brotli
   WASM of 2026-09-16 was a Cloudflare-era number), and a `curl`/Chrome read that day showed no
   `Content-Encoding` on any JS, CSS or WASM. Production does speak h2, which the local rig does not,
   so the local bytes are exact and the local latency rounds are pessimistic ([section 10](#10-package-status-2026-10-09)).
5. **The warm start fires ~90 API calls** (duplicates included) for a 2-conversation, 8-community
   account; on Slow 3G the chain keeps running for **18.6 s after the list is usable**.

## 1. Method, and what it cannot see

- **Client:** the harness W2 Chrome (visible, `localhost:9223`, the sandbox `peer` account), attached
  over CDP; `Network.emulateNetworkConditions` per scenario, restored after each; `Network.clearBrowserCache`
  for "cold". **Why not a headless Chrome on a private profile, as planned:** the local estate signs
  in through the production identity provider, and the brief forbids touching it; a fresh profile has
  neither a session nor an MLS device. W2 was checked idle (last harness activity 2026-10-07), brought
  to front, reloaded and navigated by this session; W1 (`owner`) is logged out and was NOT touched, so
  **delivery at the peer was not measured** (an open row, section 8). Debris: messages `NET-*` in the
  `Canari Test Alpha` DM and in `#general` of `Canari Test Venue` (both sandbox).
- **Profiles:** Slow 3G = 400 ms RTT, 400 kbit/s both ways; 2G-like = 800 ms, 50 kbit/s; fast = none.
  Warm = HTTP cache populated by an earlier unthrottled load; cold = cache cleared (IndexedDB, MLS state
  and the session are NOT cleared, so "cold" is a cold HTTP cache on a signed-in device).
- **Usable** = `main` holds the conversation list (`innerText` over 80 characters), PIN prompt absent.
- **Blind spots, stated so nobody over-reads a number:** (a) CDP throttling does NOT shape the gateway
  WebSocket, so a salon bubble delivered by `channel.message.created` arrives faster here than on a real
  link; (b) local nginx is HTTP/1.1 (6 connections), production is h2/h3 behind Cloudflare, so the
  201 JS requests cost more latency rounds here; (c) the sandbox holds no media and short histories, so
  **payload sizes per screen are floors**; (d) Android's `plugin-http` is invisible to CDP
  (local-first-ui section 1), so even a clean phone run needs the TCP shaper; (e) one run per cell
  except where noted - these are a map of causes, not a benchmark.

## 2. Inventory: every path that needs the network

"Offline" = link down. "Weak" = Slow 3G / 2G-like. Evidence is file:line on `main` at 2026-10-09.

| Path | Offline | Weak | WS drop / retry | Evidence |
| --- | --- | --- | --- | --- |
| **Send DM / group text** | Bubble at once, `pending` ("En attente"), durable; sent after reconnect | Bubble at once; `sending` until the POST answers (1.0 s Slow 3G, 2.5 s 2G) | POST cut -> back to `pending`, retried after the link returns; at-least-once + receiver dedup on `messageId` | `utils/chat/messaging.ts:96-170` (echo + entry are ONE write), `utils/chat/outbox.ts` (flush, `BACKOFF_MS` 2/5/15/30/60 s) |
| **Send DM / group media** | Placeholder bubble, bytes kept in IDB, upload then send on flush | Same; the upload has no progress or deadline | Upload ref persisted before send (no re-upload) | `composables/useMessaging.svelte.ts:1138+`, `outbox.ts` `prepareMedia` |
| **Send salon text/reply** | **LOST**: composer emptied, toast "Echec de l'envoi. Reessayez dans un instant.", no row | No local row; appears when the server has it (and its WS push arrives) | Throw -> toast; nothing retried | `messaging.ts:94-146` ("server-authoritative, no outbox"), `channelCrypto.ts:309` |
| **Send salon media** | Upload throws; files re-staged in the picker (`pendingMediaFiles`), no bubble | Upload blocks the composer (`isUploadingMedia`), no progress, no deadline | Same | `useMessaging.svelte.ts:1139-1160` |
| **Edit / delete / react / pin (DM, group)** | Control entry in the outbox, converges later; a delete of an unsent message withdraws it | Same as send | Same; kind `control` is silent and durable | `messaging.ts:187-420` |
| **React (salon)** | Pill flips at once, then ROLLED BACK on a transport failure; never queued | Same | Rolled back only when nothing was sent | `useChannelWorkspaces.svelte.ts:1349-1400` |
| **Edit (salon)** | Nothing changes, error logged; no queue | Waits for the POST before applying | Same | `useChannelWorkspaces.svelte.ts:1294-1330` |
| **Pin / poll vote (salon)** | HTTP, no echo until answer | Same | Fire-and-forget `.catch` | `MainChatPage.svelte:973` |
| **Read-mark** | DM/group: control entry (durable). Salon: `POST /api/channels/:id/read`, **best-effort, a failure only logs** | Same | Same | `ChannelService.ts:808`, `ChatBackgroundService.svelte:644` |
| **Open a conversation** | Served from the local store; history top-up is the network part | MLS history is incremental (`?after=`, 1 request, 1-2 kB in the sandbox) -> 1.75 s Slow 3G / 3.1 s 2G until quiet | Re-fetched on reconnect via `fetchPendingMessages` | `mls-client/mlsDeliveryApi.ts:1075`, `initializeConnection.ts:158` |
| **Open a salon** | Needs HTTP: `GET .../messages?limit=100` | 100 ciphertext rows per open (size unmeasured, sandbox salon is near empty) | Channel messages are DELIBERATELY not persisted locally | `ChannelService.ts:869-884`, `social-service channel.service.ts:3383` |
| **Cold start (web)** | **Browser error page** (`ERR_INTERNET_DISCONNECTED`): no service worker, no cached shell. Recovers on `navigate` once online | See section 3.2 | - | measured; `grep serviceWorker src` is empty; Tauri embeds the frontend (`frontendDist`), so native cold start has no download |
| **Cold start (session)** | `apiFetch` proceeds without a token on a transport failure; offline unlock exists | `auth/refresh` is the first API call, serial behind the JS bundle | - | `utils/apiFetch.ts:50-68`, [auth](modules/auth.md#what-happens-on-reconnect) |
| **Feed / notifications / agenda** | Fetch on tab switch; served from `feedCache` when warm (feed only) | 1-3 requests per tab, one RTT deep each (sandbox data tiny) | - | [local-first-ui](local-first-ui.md) section 3; measured section 3.3 |
| **Media view** | Blob cache only; no cache = skeleton/error | Full encrypted blob (chat images up to 2560 px / q 0.92, no thumbnail variant), `no-store` at the server | Aborts handled (`AbortController` in `mediaBlobCache`) | `media.ts:130-134`, `media.controller.ts:546,606` |
| **Calls** | Held off (`CALLS_ENABLED=false`) | - | - | [calls](modules/calls.md) |

Reading the table: **every DM/group path is already offline-capable. Every SALON write path is not**,
and every read path that is not "an open DM" depends on the network.

## 3. Measured

### 3.1 The send path (W2, DM `Canari Test Alpha`, and `#general`; times from the press of the send button)

| Scenario | DM / group: bubble visible | DM: `sending` | DM: `sent` | Salon: bubble visible | Notes |
| --- | --- | --- | --- | --- | --- |
| Good link | 28 ms | 53 ms | **146 ms** | 96 ms | salon POST answered 201 in 63 ms |
| Slow 3G | 43 ms | 502 ms | **973 ms** | 133 ms (*) | (*) WS push is not shaped by CDP, so the real figure is higher |
| 2G-like | 40 ms | 1108 ms | **2512 ms** | 605 ms (*) | POST answered at 1296 ms |
| **Offline, send, wait 13 s, link back** | 50 ms, `pending` | - | **3.76 s after the link returned** | **never** | salon: composer emptied at +1.5 s, toast shown, nothing queued |
| **Link cut 750 ms into a slow POST** (`wsdrop`) | 37 ms | 769 ms | state back to `pending` at 780 ms; POST failed `ERR_INTERNET_DISCONNECTED`; **5.3 s after the link returned** the retry went out and `sent` followed | not run | no duplicate bubble (marker count unchanged, 2 = bubble + list preview) |
| **Kill with an unsent message** (offline send, reload with link restored) | 30 ms `pending` | - | after the reload the message is on screen, `sent`, **one** copy, within 5.4 s | - | the row survives the document teardown: IndexedDB, not RAM |

What this says: **the optimistic row + outbox exists and works for MLS**; the cost on a weak link is
the 1.0-2.5 s of `sending` and the 3.8-5.3 s between "link back" and "flush". What it does not cover is
the whole salon surface. The gap between `online` and the first POST after a reconnect is the
connectivity cascade (`online` event -> `serverReachable` only restored by the next successful call ->
`onReconnect` -> incoming-queue barrier -> flush); [chat](modules/chat.md#the-flusher-resolves-its-token-and-does-not-run-while-offline)
documents the previous 3 min 11 s version of this.

### 3.2 Load weight and the critical path to a usable list (W2, `/chat` reloaded)

Bytes are `encodedDataLength` on the LOCAL estate (uncompressed JS/CSS/WASM, see section 1).

| Run | First paint (FCP) | First text (nav shell) | List usable | Requests | Transferred | JS | WASM | CSS+font | API |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Good link, cold | - | - | 0.41 s | 302 | 4.4 MB | 201 req / 1.9 MB | 2.0 MB | 0.3 MB | 90 req / 122 kB |
| Good link, warm | - | - | 0.21 s | 302 | 72 kB | 0 | 0 (cached) | 0 | 90 req / 72 kB |
| Slow 3G, warm | - | - | **2.1 s** | 302 | 72 kB | cached | cached | cached | 90 req, **last one ends at 18.6 s** |
| 2G-like, warm | - | - | **6.0 s** | 231 at 26 s | 13 kB | cached | cached | cached | 20 of 90 done at 26 s |
| **Slow 3G, cold** | **23.0 s** | **52.2 s** | **103-108 s** | 249-376 | 4.4-5.2 MB | **57 s to finish** (201-270 files) | 2.0 MB: **58.8 s -> 103.1 s** | - | first call (`auth/refresh`) at **57.5 s** |
| 2G-like, cold | not run to the end | | **~12 min computed** (4.4 MB / 6.25 kB/s); the run was killed | | | | | | |

The Slow 3G cold timeline, from the request log of that run:

```
 0.0 s  GET /chat (SSR document, 19 kB, answered at 0.8 s)
 0.7 s  201..270 JS files requested; 6 connections (HTTP/1.1)            ... FCP at 23 s
57.5 s  all JS in -> POST/GET /api/auth/refresh, /users/batch, /version ... (5 calls, ~0.5 s each)
58.8 s  mls_wasm_bg.wasm (2.09 MB) starts, 44 s at 50 kB/s
103.1 s WASM done -> NOW the workspace, groups, unread, avatar calls start  ... list usable
```

Three structural facts fall out, each independent of the local estate's compression:

1. **The WASM starts only after the whole JS graph and one auth round trip.** `hooks.client.ts:67`
   (`prefetchMlsWasmAtBoot`) runs inside the bundle, so it cannot start before the bundle is parsed.
   A `<link rel="preload">` in `app.html` would overlap the two transfers.
2. **The list waits for the WASM.** None of the group/workspace calls is issued before it finished
   (103.1 s above), although the conversation names and previews live in the local store. Whether that
   is a real data dependency or an ordering is the first thing to establish (WP-W3).
3. **The warm start is a serial chain, not a payload.** 72 kB in 90 requests; on Slow 3G the chain
   ends 16.5 s after the list is usable, on 2G-like it had not ended at 26 s. The sandbox account
   has 2 conversations and 8 communities and the chain is: refresh -> users/batch -> {version,
   announcement, devices} -> {notification-preferences, workspaces/user/me, sessions/device, mls/messages,
   unread-counts} -> `mls/users/<id>/groups` -> **three calls per community** (`distribution-group`,
   `members`, `user/me`) -> **two `mls/groups/<id>` per group**. Duplicates in one start: `mls/devices/...`
   x3, `mls/users/.../groups` x3, `unread-counts` x2, `users/batch` x2, every `mls/groups/<id>` x2.
   Two `404 /api/users/<id>/avatar` per start (a user without an avatar asks every boot).

*Correction, 2026-10-09:* this paragraph assumed production's edge compressed (the 723 kB brotli WASM
of 2026-09-16). It no longer does: production's origin served the raw 2 126 190-byte WASM, the raw
240 kB stylesheet and raw JS, exactly like the local nginx, which compressed only `application/json`.
The gzip fix and its measurement are [section 10](#10-package-status-2026-10-09).

### 3.3 Per screen, client-side navigation from `/chat` (sandbox data, so FLOORS)

| Screen | Requests | Good link: quiet after | Slow 3G | 2G-like |
| --- | --- | --- | --- | --- |
| Discussions | 1 | 0.84 s | 1.2 s | 1.7 s |
| Open a DM (history `?after=`, members x2) | 3-4 | 0.92 s | 1.75 s | 3.1 s |
| Feed (`/api/posts?limit=20&feed=...`, notifications, presence) | 6-7 | 0.87 s | 1.3 s | 2.2 s |
| Notifications | 1-3 | 0.81 s | 1.2 s | 1.7 s |
| Agenda | 2-4 | 0.82 s | 1.2 s | 2.2 s |

Warm navigation is cheap and one-RTT deep: the local-first work of 2026-09-23 holds. What this phase
could NOT measure is the weight of a real feed (20 posts with media), a real salon page (100 rows) and
a long DM history; the code says: chat images are compressed to **2560 px / q 0.92** and uploaded as ONE
encrypted blob each (`media.ts:130`), posts to 2048 px, comments to 1280 px; the server cannot make
thumbnails of ciphertext, so **a 300 px bubble downloads the full image**; the media route is
`no-store` (`media.controller.ts:546`) so only the client's blob cache keeps it.

### 3.4 Timeouts and retries, per call family

| Call | Deadline | A slow answer shows... | Retries |
| --- | --- | --- | --- |
| `apiFetch` (every REST call: channels, social, users, MLS delivery) | **none** (`utils/apiFetch.ts:37`; local-first-ui ledger row 6) | spinner/skeleton for as long as the browser tolerates | one retry on 401 only |
| MLS send POST | **none** (`mlsDeliveryApi.ts:1021`); one flush loop awaits entries one by one, so **one stalled POST holds every queued message behind it** (`outbox.ts:861-866`) | `sending` forever | ladder 2/5/15/30/60 s on a failure that is NOT a stall |
| MLS ACK | 10 s per attempt, 4 attempts (`ackRetry.ts:20`) | silent | bounded |
| WASM fetch | 15 s, **on the response head only** (`mlsWasmLoader.ts:30`); the body is unbounded, which is correct | error only if the head is late | none |
| Version check | 8 s (`appVersion.ts:178`) | silent | none |
| Calls token | 12 s | held off | - |
| Progress deadline helper | exists (`mls-client/progressDeadline.ts`, silence-based, honest at any speed) | but is used only where it was written | - |
| Reconnect / recovery cadence | `RECOVERY_TIMEOUT_MS = 60 s` per group (`recovery.ts:24`) | silent | one HTTP call per group per minute, not multiplied |
| Connectivity store | none: `isOffline = !online || !serverReachable`, `serverReachable` flips only on a TRANSPORT FAILURE | **no "slow" state exists** | - |

Retries do not multiply load in the measured paths (the outbox backs off to 60 s and refuses to run
offline), but **an unbounded request is worse than a retry**: it keeps a connection of the 6 and the
uplink occupied, and on a slow link everything else queues behind it.

## 4. Root causes

| # | Cause | Where | Effect measured |
| --- | --- | --- | --- |
| R1 | Salon sends are inline `await`s with no local row, no queue | `messaging.ts:94`, `channelCrypto.ts:309`, `useMessaging.svelte.ts:1704` ("no local echo: the broadcast renders the bubble") | offline: text lost; weak: invisible until the server has it |
| R2 | The send is a throw-and-toast and the composer is found empty 1.5 s after a failed salon send (whether it is cleared before the answer or not restored after it is to be read in the handler, WP-OFF-1) | `useMessaging.svelte.ts` `handleSendChat` | the draft is destroyed on failure |
| R3 | Salon edit / pin / vote apply only after the await; salon read-mark swallows failure | `useChannelWorkspaces.svelte.ts:1314`, `ChannelService.ts:808` | no echo, no retry |
| R4 | The server ignores the client's `messageId` and mints its own row id | `channel.dto.ts:218`, `channel.service.ts:3100` | a replay of a salon send has no idempotence key (only the `(session, index)` unique constraint answers 409 `CHANNEL_MESSAGE_KEY_REUSED`, `:3208`) |
| R5 | No deadline on any REST call; no "slow" notion | `apiFetch.ts:37`, `connectivity.svelte.ts` | spinners of unknown length; one stalled POST blocks the outbox |
| R6 | Cold start downloads JS -> auth -> WASM strictly in series | `hooks.client.ts:67`, `mlsWasmLoader.ts` | 57 s + 45 s on Slow 3G. **Fixed by WP-W2** (section 10) |
| R7 | First list render waits for the WASM, the gateway socket and the session flip | `sessionAuth.ts:758` -> `:871` -> `:1184` -> `:1208` (graph in section 10.3) | 103 s vs 58 s. **Diagnosed, NOT fixed** |
| R8 | The boot sync is a ~90-call chain with duplicates, per-community and per-group calls | `loadExistingConversations`, `useChannelWorkspaces` | 18.6 s settle on Slow 3G warm; 2G did not settle in 26 s |
| R9 | The origin compresses only JSON, PRODUCTION INCLUDED (no CDN in front) | `Dockerfile.frontend` gzip block | 4.4 MB cold instead of 1.65 MB. **Fixed by WP-W1** (section 10) |
| R10 | No service worker: web cold start offline is the browser's error page | measured | 0 % usable offline on web (native is unaffected) |
| R11 | E2E media has no thumbnail variant | `media.ts:130`, media-service | full image per bubble |
| R12 | Reconnect to flush takes 3.8-5.3 s: `online` -> reachability only on a successful call -> incoming-queue barrier | `connectivity.svelte.ts`, `outbox.ts:835-846` | slow resume |
| R13 | Encrypt and POST are one unit; a failed POST has already consumed a send generation | `BaseMlsService.ts:4178` (`emitFrame`) | each failed attempt burns one generation; bounded by the 60 s ladder but UNMEASURED against the receiver's forward-distance limit |

## 5. Work packages, ordered by gain per effort

Seconds are measured above unless marked *(est)*. "Test" is the one that must exist before the
package merges. Each is a pull request of its own.

| WP | What | Effort | Gain | Test |
| --- | --- | --- | --- | --- |
| **WP-OFF-1 (BUILT 2026-10-09, [chat](modules/chat.md#a-refused-salon-send-gives-the-draft-back-wp-off-1-2026-10-09))** | **Never destroy a salon draft**: clear the composer only on success; on failure keep the text and show the error on the composer. No new mechanism | S | stops the only measured DATA LOSS | unit on the send handler (failure keeps the draft) + harness row: offline salon send, text still in the composer |
| **WP-W1** | Verify production's origin compression (`curl -I` with `Accept-Encoding: br`); enable gzip/brotli for `js/css/wasm/svg/woff2` in the frontend nginx where missing | S | local/dev/non-edge cold Slow 3G 103 s -> ~38 s *(est from bytes)*; production gain depends on the check | asserted by a test reading the generated nginx config, plus a curl row in the deploy smoke |
| **WP-W2** | Start the WASM in parallel with the JS: `<link rel="preload" as="fetch" crossorigin>` for the hashed `.wasm` in `app.html` (hash known at build) | S | removes the serial 44 s (-> bandwidth-bound: ~-20 s on Slow 3G *(est, same bytes in parallel)*, more on a real h2 link) | build test: the hashed name in the preload equals the `?url` import; measured with the CDP profile |
| **WP-W3** | Find out whether the list truly needs the WASM; if not, render the list (names, previews, unread) from the local store before it | M | up to **-45 s** cold Slow 3G (list at ~58 s instead of 103 s) | trace of what in `ensureMls` the first list render awaits; then a boot-order unit test that the list renders with the WASM promise pending |
| **WP-OFF-5** | **SHIPPED 2026-10-09 (section 11).** **A deadline and a `slow` state**: route `apiFetch` through the progress-deadline helper (silence, never total), type the failure `StalledRequestError`, add `connectivity.slow` (a request > N s in flight) and show "Connexion lente" instead of an endless spinner; the outbox treats a stall as retry-with-backoff and stops head-of-line blocking | M | bounds every "spinner of unknown length"; unblocks the queue behind one dead POST | `apiFetch` stall unit test; outbox test "a stalled first entry does not delay the second" |
| **WP-W4** | Cut the boot chain: dedupe the repeated calls (`devices` x3, `groups` x3, `groups/<id>` x2, `unread-counts` x2), one batched call for the per-community triplet, conditional requests (ETag/304) for stable payloads, stop asking for avatars that 404 every boot | M | ~90 -> ~35 calls *(est)*; Slow 3G settle 18.6 s -> ~6 s *(est)*; 2G becomes settleable | a counting test over a recorded boot (the CDP log of this page is the fixture): no URL twice, request budget |
| **WP-OFF-2** | **Salon optimistic row** with `pending/sending/error` and a retry/delete affordance; id = the client UUID already placed inside the ciphertext (`AppMessage.message_id`), reconciled with the `channel.message.created` row by that inner id | M | salon bubble in ~40 ms like DMs (today 96 ms-600 ms+ and offline never) | reducer test: local row replaced, never duplicated, by the server row; harness row on both clients |
| **WP-OFF-3** | **Salon durable outbox** (IndexedDB, same store as MLS, `channel` kind) + server idempotence: store the client `messageId` as a nullable unique `(author, channel, client_message_id)` and answer the stored row on repeat | M-L | offline salon send works; replay without duplicate | server spec (repeat POST returns the same row), outbox spec (replay after a cut), harness: offline send, kill, restore |
| **WP-OFF-6** | **SHIPPED 2026-10-09 (section 12).** Make resume prompt: probe reachability itself on `online` rather than waiting for the next failed/successful call; start the flush as soon as the incoming barrier is idle | S-M | 3.8-5.3 s -> ~1 s *(est)* | `outbox.test.ts` trigger table (the five triggers) plus a CDP row |
| **WP-OFF-4** | Salon edit / pin / vote / read-mark through the same queue, optimistic with rollback only when nothing left | M | consistency with DMs | per-action reducer tests |
| **WP-W5** | Trim the boot bundle: find why 201-270 JS files are fetched before the list (route-level `modulepreload`, eager imports of other tabs), split the 480 kB and 350 kB chunks | M-L | cold JS 57 s -> *(est, needs a bundle report)* | a bundle budget test (entry JS bytes, file count) |
| **WP-OFF-7** | Persist the encrypted MLS frame once per epoch and re-POST the SAME bytes while the epoch has not moved; re-encrypt only after an epoch change (inner `messageId` dedup stays the safety net) | M | removes the burned generations of R13; needs the delivery service to accept a byte-identical repeat | measure burn per failed attempt first; then a `BaseMlsService` spec with a failing POST |
| **WP-W6** | Web service worker precaching the app shell (immutable hashed assets, `index` fallback), so the web client boots offline into the local-first UI; native unaffected | L | web offline cold start: error page -> ~1 s | CDP row `offboot` (this page's script): reload offline shows the shell |
| **WP-W7** | Encrypted thumbnail variant for chat/post images (e.g. 320 px, uploaded beside the original, original fetched on open) | L | MBs -> tens of kB per bubble on a weak link | size assertion in the upload path; media-service test |

Order to build: **OFF-1 -> W1 -> W2 -> W3 -> OFF-5 -> W4 -> OFF-2 -> OFF-3 -> OFF-6 -> OFF-4 -> W5 -> OFF-7 -> W6 -> W7**.
OFF-1 and W1/W2 are one-day changes that remove the worst measured outcomes (data loss, ~45 s serial
transfer). W3 and W4 are the biggest honest wins and both start with a measurement already described.

## 6. Proposed design (what the packages build toward)

### 6.1 Message states, one vocabulary for every conversation kind

`pending` (queued, not attempted: offline or not yet flushed) -> `sending` (a POST is in flight under a
deadline) -> `sent` (the server answered 2xx) -> `error` (permanent: evicted, deleted group, too large;
the only state that asks the user to act). New: `stalled` is NOT a stored state, it is the UI reading
`sending` for longer than the deadline (WP-OFF-5), so no migration. The existing types
(`types/index.ts:54`, `MessageMetadata.svelte`) already carry the first four; only the salon rows lack
them. UI copy through Paraglide, one clock icon for `pending`, a spinner for `sending`, a tap on
`error` offers retry and delete (delete of an unsent row withdraws it, `deleteMessage` already does).

### 6.2 The durable outbox, keyed by a client id

The MLS outbox (`outbox.ts`, IndexedDB, entry `id` = the client-generated `messageId`) is the model.
Extend it with a `channel` kind carrying `{channelId, plaintextProto, sealed?}` and the same
`pending/backoff/leader-tab` rules. **The key is the client UUID that is already inside every
ciphertext** (`AppMessage.message_id`), so idempotence is end-to-end: readers dedupe on it, the server
(WP-OFF-3) dedupes on the cleartext copy sent beside it (a random UUID reveals nothing).

### 6.3 MLS-safe replay rules (DM, group)

1. **Encrypt at flush, never at compose** (today's rule, keep it): the epoch at send time is the only
   one peers can decrypt. The barrier `waitForMessageQueueIdle` before every flush stays.
2. A POST of unknown fate (timeout, cut after the body left) is retried as a NEW frame with the SAME
   inner `messageId`: peers dedupe, so at-least-once becomes exactly-once in effect. Unchanged.
3. **New (WP-OFF-7):** if the epoch has not moved and no commit was applied since the first encryption,
   re-POST the stored bytes instead of consuming another generation. If the epoch moved, discard the
   stored frame and re-encrypt: a frame for a superseded epoch is undecryptable for up-to-date peers
   and must never be replayed.
4. Never send into a group that is not healthy, never while offline, never past an unapplied incoming
   commit - all three already enforced; they stay the gate and the new work must not add a second path.
5. An evicted / deleted group retires the entry with an `error` row and a system line (exists).

### 6.4 Salon (Graine v2) replay rules

A salon ciphertext is sealed under THIS device's session and consumes a `messageIndex`; the signature
binds the row to its place ([channel-encryption section 21](../protocols/channel-encryption.md)).
So the rules differ from MLS:

1. **Seal once, persist the sealed envelope, replay byte-identical bytes.** The server's unique
   `(session, index)` then makes a replay harmless: 201 the first time, `409 CHANNEL_MESSAGE_KEY_REUSED`
   for any repeat. With WP-OFF-3's `client_message_id` the repeat returns the stored row (200), which
   removes the ambiguity of reading a 409 as "ours".
2. The `seedFrame` rides the same POST as the first message of a session; it is part of the stored
   envelope, so an entry sealed offline is self-sufficient.
3. **If the roster moved between seal and send** (a member left or joined: the session is invalid), the
   stored envelope is discarded and the plaintext re-sealed under the new session. That is the one case
   where a duplicate is possible (the first POST may have arrived), and the reader's dedupe on the inner
   `messageId` is what absorbs it - **to verify first: does the salon reader dedupe on the inner id
   today? (open question, see section 8).**
4. Order: a salon is ordered by the server's `createdAt`; a message delivered late sorts at ITS server
   time, not its compose time. The local `pending` row is therefore pinned at the bottom (author's own
   view) until the server row replaces it. Never re-sort by `sentAt`.
5. Expiry: a salon entry older than the community's retention (or one whose channel the user can no
   longer write to) fails permanently with a visible `error`, never silently; an MLS entry never
   expires on a clock (it ends on eviction, deletion or the user's delete) - the 60 s backoff ceiling
   is the cadence, not a deadline.

### 6.5 UI and per-platform differences

- **All platforms:** one connection strip with three states - `hors ligne`, `connexion lente`,
  `en ligne` - driven by `connectivity` (WP-OFF-5), never by `navigator.onLine` alone (a captive portal
  reports true: [CLAUDE.md](../../../CLAUDE.md) rule). The list and open conversations stay interactive.
- **Web:** no service worker today (WP-W6); leader-tab election means ONLY the leader flushes
  (`outbox.ts`, [chat](modules/chat.md#only-the-leader-tab-flushes)); a salon outbox must obey the same
  gate or two tabs seal under one session and collide on `(session, index)`.
- **Android (Tauri):** two network clients (WebView `fetch` and `plugin-http`); a deadline must live
  where each is called; background sends use the native mirror (`outboxMirror.ts`), which today
  knows MLS kinds only; the salon kind needs a mirror decision (probably "foreground only").
- **iOS:** the WebView is suspended in the background, timers stop, and the NSE does not wake on silent
  frames: a queue that relies on a timer after the app is hidden does not run, so flush on
  `visibilitychange`/foreground (exists) and never promise background delivery; the refresh token travels
  in `X-Canari-Refresh` on `tauri://localhost` ([sessions](../sessions.md)) - a replay must read it at
  send time like the token.

## 7. How to reproduce what was measured

The probes were throw-away scripts (a CDP client, no Playwright), described so they can be rebuilt:

- **Load:** attach to W2 (`http://localhost:9223/json/list`), `Network.enable`, `Network.clearBrowserCache`
  for cold, `Network.emulateNetworkConditions {latency, downloadThroughput, uploadThroughput}` in bytes/s
  (400 kbit/s = 50000), `Page.reload`; collect `requestWillBeSent` / `responseReceived` /
  `loadingFinished.encodedDataLength`; poll `main.innerText.length > 80` for "usable" and a `timeOrigin`
  guard so the OLD document is never read as the new one.
- **Send:** open the row with a real `Input.dispatchMouseEvent` after parking the pointer away
  (the nav drawer overlays the first click otherwise), `Input.insertText`, click
  `[aria-label*="Envoyer le message"]`; an in-page 15 ms probe records the first time the marker is in a
  leaf outside `.chat-composer-footer` and the status label (`En attente` / `Envoi` / sent check).
  Offline = `emulateNetworkConditions {offline:true}`; "kill" = restore the link then `Page.reload`.
- **Salon row selector:** `[data-channel-row="general"]`; the community must already be selected.

## 8. Not measured, and owed

**Delivery at the peer** (W1 is logged out; needs the service-account sign-in the brief forbade for this
session). **Open questions:** (1) does the salon reader dedupe on the inner `messageId`?
(2) does the delivery service accept a byte-identical repeat of an MLS frame (WP-OFF-7)? (3) how many
generations does a failed POST burn, and what is the receiver's forward-distance limit? (4) ~~is the
production ORIGIN compressing JS/WASM~~ - answered 2026-10-09: it was not ([section 10](#10-package-status-2026-10-09));
(5) ~~what exactly does the first list render await~~ - answered, section 10.3.

**Android (Mi 9T, another agent owns it now), to run later:** (a) airplane/no-link: `adb shell cmd
connectivity airplane-mode enable|disable`, or `adb shell svc wifi disable; svc data disable`; (b) weak
link: `bun shaper.mjs <listen> localhost:8081 <rttMs> <kbps> [lossPct]` + `adb reverse tcp:8081
tcp:<listen>` (shapes BOTH `fetch` and `plugin-http` and the WebSocket; CDP does not), profiles 400/400 kbit
and 800/50 kbit; (c) per scenario: tap-to-bubble, bubble-to-`sent`, kill (`adb shell am force-stop`)
with an unsent message, then relaunch and read the outbox; cold start to list on the native build (no
JS/WASM download, so only the API chain and the PIN/unlock path matter); (d) the background send mirror
under airplane mode. Read results with the harness `a1` client on `localhost:9333`.

**iOS (iPhone 12 on the bench):** Network Link Conditioner (Settings > Developer, profiles "3G",
"Very Bad Network", "100% Loss") or a Mac with `Additional Tools`; the same send / kill / relaunch rows
through `CANARI_PHONE=ios` ([cross-client-ios](../cross-client-ios.md)); plus what only iOS has: a send
while the app is suspended, then foreground; the first launch after a force-quit offline (does the
offline unlock reach a usable list); WKWebView dropping the refresh cookie, so the `X-Canari-Refresh`
path under a flapping link.

**Web:** repeat sections 3.1-3.2 with an HTTP/2 front (the production nginx image behind a local TLS
proxy) and compression on, to replace the pessimistic bytes; and on a real salon / feed with media.

## 9. Related

[local-first-ui](local-first-ui.md), [cold-start](cold-start.md), [chat](modules/chat.md),
[channel-encryption](../protocols/channel-encryption.md), [websocket-protocol](../protocols/websocket-protocol.md),
[mobile](mobile.md), [backlog](../backlog.md).

## 10. Package status (2026-10-09)

| WP | State | Reaches users through |
| --- | --- | --- |
| **WP-W1** origin compression | **built** (one nginx block + `static-compression.test.mjs`) | the next pre-release / stable: it is an nginx image change |
| **WP-W2** WASM beside the JS | **built** (`wasmPreload.ts` + `hooks.server.ts`) | the next pre-release / stable (web build only; Tauri is inert by construction) |
| **WP-OFF-5** deadline, `slow`, lanes | **built** (section 11) | the next pre-release / stable (frontend only) |
| **WP-OFF-6** prompt resume | **built** (section 12) | the next pre-release / stable (frontend only) |
| **WP-W3** list before the WASM | **diagnosed, NOT built**: the dependency is real, section 10.3 | - |

### 10.1 What production served, read before changing anything

`curl -H 'Accept-Encoding: br,gzip'` and one headless Chrome load of `https://canari.emse.fr/login`
(read-only, public, no sign-in), 2026-10-09. The name resolves straight to the host (193.49.175.122),
**no CDN in front**, so the Cloudflare-era figures of this page (723 kB brotli WASM) no longer describe
production.

| Asset | Served | `Content-Encoding` | Cache-Control |
| --- | --- | --- | --- |
| HTML (`/`, `/login`) | 19 kB | gzip (nginx's default `text/html`) | `public, max-age=0, s-maxage=60` |
| JS (123 files on `/login`) | 1305 kB | **none** | `public, max-age=31536000, immutable` |
| CSS `0.DPWcxRH8.css` | 239 701 B | **none** | immutable |
| WASM `mls_wasm_bg.GxLDQQfn.wasm` | **2 126 190 B** | **none** | immutable |

HTTP/2 on every request (Chrome `protocol`), no `alt-svc`, so no HTTP/3. **The cache half was already
right** (long immutable on every hashed asset, asserted by `static-headers.test.mjs`); only the
compression was missing, because `gzip_types` named `application/json` alone.

### 10.2 The fix, and the numbers

**WP-W1.** `infrastructure/local/Dockerfile.frontend`: `gzip_types` now lists JS, CSS, WASM, SVG, JSON,
manifests; `gzip_proxied any` (the host proxy adds `Via`, and nginx then skips compression without a log
line); `gzip_vary on`; level 6. **No brotli**: the stock `nginx:stable-alpine` has no brotli module and
a module built against another nginx is a worse failure than the bytes it would save (brotli would be
~15-25 % smaller still: owed if the image ever carries the module). The WASM goes 2 093 565 -> 764 038
bytes, JS 1970 -> 730 kB, CSS 237 -> 37 kB.

**WP-W2.** An inline head script, substituted for a marker in `app.html` by `hooks.server.ts`, appends
`<link rel=preload as=fetch crossorigin=anonymous fetchpriority=low href=<hashed wasm>>` when
`localStorage` holds a `mls_device_id_*` key (the predicate and the prefix constant of
`prefetchMlsWasmAtBoot`, now shared) and the shell is not Tauri. `as=fetch` + anonymous CORS is
exactly the request `mlsWasmLoader` later makes, so the browser answers it from the download in
flight (one `.wasm` request in every run). `low` so the 1.5 MB of JS that paints the screen is not
slowed (measured: JS done 52.5 s -> 52.7 s with the WASM running beside it).

**Rig** (`headless=new`, absolute private profile, private port, CDP `Network.emulateNetworkConditions`,
cache cleared for cold; Slow 3G = 400 ms / 400 kbit, 2G = 800 ms / 50 kbit): the nginx and SSR images
built from the same artifact in Docker, a stub for the API upstreams so they fail in tens of ms rather
than a DNS timeout. **Unauthenticated `/chat`** with `mls_device_id_*` pre-set in `localStorage` (so the
WASM prefetch runs): no sign-in against the production identity provider was needed, and it measures
exactly what W1/W2 change - the transfer of JS, CSS and WASM. It does NOT measure what comes after
(sections 3.2 / 10.3). HTTP/1.1 locally (6 connections), h2 in production: bytes are exact, the latency
rounds of 201 files are pessimistic. "Before" is the already-running local estate on `main`; the
single-package rows are the new build behind the old config (W2 only) and `main`'s own assets behind
the new config (W1 only).

Cold, seconds (`FCP` / last JS byte / WASM start -> end / bytes):

| Run | FCP | JS done | WASM | Transferred | Everything in |
| --- | --- | --- | --- | --- | --- |
| **Slow 3G, `main` (before)** | 22.5 | 52.5 | 46.1 -> 94.2 | 4401 kB | 94.2 |
| Slow 3G, W2 only | 22.5 | 52.7 | 0.8 -> 91.3 | 4402 kB | 91.3 |
| Slow 3G, W1 only | 3.5 | 23.2 | 22.5 -> 39.4 | 1653 kB | 39.4 |
| **Slow 3G, W1 + W2 (after)** | **3.5** | **23.3** | **0.8 -> 39.3** | **1654 kB** | **39.3** |
| **2G, `main` (before)** | 208.7 | 427 | 318.8 -> 723.8 | 4401 kB | 723.8 (12 min) |
| **2G, W1 + W2 (after)** | **32.2** | **163.1** | **3.5 -> 283.4** | **1654 kB** | **283.4 (4.7 min)** |
| Good link, `main` / W1 + W2 | 0.2 / 0.2 | 0.2 / 0.2 | start 0.2-0.3 / 0.0 | 4401 / 1654 kB | no regression |
| Slow 3G warm, `main` / W1 + W2 | 0.5 / 0.5 | cached | cached | 3 / 5 kB | no regression |

**Reading it honestly.** W1 is the whole gain, because a weak link is bytes divided by bandwidth: the
screen paints 19 s sooner on Slow 3G and 3 min sooner on 2G, everything is in 55 s sooner (Slow 3G) and
7 min sooner (2G). **W2 adds almost nothing once W1 is in** (end 39.4 -> 39.3 s): the link is saturated
by the same bytes either way. What it does is move the WASM start from after-the-bundle (46 s, or 22.5 s
once the bytes shrink) to the first second, which is time that is only worth something where the link
has slack - a fast link with a long round trip, where 201 files cost 34 round trips and the binary used
to wait behind them. It costs one inline script and no extra byte. **Not measured here:** production
itself (an nginx change reaches users only in a pre-release or stable; the first row to read after
`serve-dev` is `curl -sI -H 'Accept-Encoding: gzip' -H 'Via: 1.1 x'` on a hashed `.wasm` of the dev
estate showing `content-encoding: gzip`, which proves the proxied case), h2 multiplexing, and a
signed-in warm start (the rig is unauthenticated).

### 10.3 WP-W3: the first list render depends on the WASM only by ORDER, and the order is the session

The brief for this package was to render the conversation list before the WASM when the first render has
no real dependency on it. The dependency graph, read on `main` 2026-10-09:

```
login()                         composables/session/sessionAuth.ts
  :758  mlsService.init(...)    <- needs the WASM (decrypts the MLS state, builds WasmMlsClient)   [A]
        timeBootSpan('storage-open', getStorage())  :771  <- IndexedDB only, runs in PARALLEL with A
  :871  ctx.setIsLoggedIn(true)                       <- AWAITS A
  :881  cb.onMlsReady()
  :1172 await mlsService.markInboundReady()
  :1184 await openGatewayConnection(...)              <- a WebSocket handshake over the weak link  [B]
  :1208 await cb.loadAndRestoreConversations()        <- AWAITS A, then B
          utils/chat/conversations.ts:799 loadExistingConversations
            phase 1 (stubs: names, lastMessageAt)     <- storage only
            phase 1b storage.getMessagesPage(deviceKey) <- IndexedDB + WebCrypto, no WASM
            phase 2 getUserGroups / fetchHistoryBatch / replayConversationHistory <- network + WASM
MainChatPage.svelte:143,1089   `!session.isLoggedIn` -> "connecting" overlay; `{#if session.isLoggedIn}` draws the list
```

**What the list itself needs:** conversation rows and their last messages come from IndexedDB, opened
by `getStorage`, and are decrypted with the device key through WebCrypto - no WASM. **What it is made
to wait for anyway:** (1) `mlsService.init` (the WASM download and the state decrypt), (2)
`ctx.setIsLoggedIn(true)`, which gates the whole page and about a dozen effects in `MainChatPage`, (3) a
**gateway WebSocket handshake** (`:1184`) - so on a weak link the list also waits for a socket it never
reads from - and (4) `loadExistingConversations`'s single entry point, which runs the local phases and
the network/WASM phase in one call that clears and rebuilds the map.

**Verdict: no data dependency, a real structural one.** Painting the list early is a change to the
session's boot state machine, not a reordering of two statements: it needs a new state between "storage
open and device key known" and `isLoggedIn` (a `localReady`), a split of `loadExistingConversations`
into its local phase and its network phase so the second no longer `clear()`s what the first drew, every
consumer of `isLoggedIn` classified as "needs MLS" or "does not", and the "securing" state on the
composer. That is `login()` and the MLS session, which this package was not to touch, and it cannot be
verified without a signed-in device (the rig here is unauthenticated). **It is the biggest remaining
win after W1** (the list could appear when the JS ends, ~23 s on Slow 3G now, instead of when the WASM,
the socket and the replay have all finished) and it should be its own package with its own
`localReady` design review.

## 11. WP-OFF-5 shipped: a deadline, a slow state, and lanes

**What was built** (`utils/requestDeadline.ts`, `utils/trackedFetch.ts`, `stores/connectivity.svelte.ts`,
`utils/apiFetch.ts`, `mls-client/mlsDeliveryApi.ts`, `utils/chat/outbox.ts`, `components/shared/OfflineBanner.svelte`):

- **A response-head deadline per call class**, chosen from the method and the body, with its reason in
  the source: `read` 20 s (a GET is ~16 ms good, ~960 ms on the 2G-like profile; 20 s is twenty times
  that), `write` 30 s plus the time the body needs to leave at an assumed 4 kB/s uplink (below the
  2G-like 6.25 kB/s, so an upload is never cut for being big), `probe` 6 s. It bounds the wait for the
  HEAD only: after the head the server has answered and the rest is transfer, honest at any speed (the
  same reasoning as `progressDeadline.ts`, which cannot be used here because `apiFetch` returns a live
  `Response`). `deadlineMs` overrides per call (`0` disables).
- **Expiry is a TYPED transport failure**, `RequestDeadlineError`, raised where the timer is armed
  (a caller's own abort is not one). `isTransportFailure` recognises it by type. It is never a status,
  so it can never reach a 401/403 branch and **never logs anyone out**. Two expiries in a row with
  nothing answered between flip the store to unreachable (`STALLS_BEFORE_UNREACHABLE`); one answer
  resets the count.
- **Retry cannot multiply load**: a stalled GET is retried once, after 250-1000 ms of jitter, and not
  at all once the store is offline; a write of unknown fate is never replayed by `apiFetch` (the
  outbox owns that, with the same inner `messageId` so receivers dedupe).
- **The MLS send POST goes through the same `trackedFetch`** (class `write`); expiry surfaces as
  `DeliveryUnreachableError` carrying the typed cause. It now also feeds the connectivity store, which
  it did not before.
- **`connectivity.slow`**: derived from observed answer latency, never a guess. An EWMA of the time to
  head (alpha 0.3, at least 3 samples) enters at 700 ms and leaves at 350 ms (hysteresis), and one
  request unanswered for 5 s enters at once. Measured (CDP, 14 sequential GETs): good 2 ms, Slow 3G
  440 ms (**no strip**: slow but workable), 2G-like 960 ms (**strip after 2.9 s**, three requests).
  Never set while offline. UI: the existing `Banner` surface, one calm line, Paraglide `slow_banner_*`,
  nothing disabled; the offline banner wins when both could show.
- **Lanes in the outbox** ([chat](modules/chat.md#one-lane-per-conversation-three-frames-on-the-wire-at-most-wp-off-5-2026-10-09)).

**Measured, before and after** (headless Chrome `headless=new` on a private profile, real `apiFetch`,
real `MlsDeliveryApi` POST and real `createOutbox`, a mock server; CDP network profiles; the `main`
outbox is the "before"):

| Scenario | Before | After |
| --- | --- | --- |
| A POST that never answers | no end (aborted by the harness at 70 s) | `RequestDeadlineError` at **30.06 s** |
| A GET that never answers | no end | one retry, then `RequestDeadlineError` at **42.05 s** (20 + ~1 jitter + 20) |
| Conv A's POST stalled, conv B queued behind it | B **never** sent (35 s window), both stay queued | B on the server after **5 ms**, only A stays queued |
| Slow hint | none | 2G-like: shown after 2.9 s; Slow 3G and good link: not shown |

**Blind spots, stated.** The harness runs the real modules in a real browser network stack but not
the application: no MLS encryption, no WebSocket, an in-memory outbox store. CDP shaping delays the
client side only, so "a POST cut mid-flight" is modelled with `Fetch.failRequest` at the response
stage (the frame REACHES the server, the answer is lost) plus `offline`. `refresh()` has deliberately
NO deadline: it ROTATES the refresh token, and abandoning a request whose answer may already have
rotated it invites the replay detection (a revoked session) that this work must never cause; its
bound belongs to a design of its own (open).

## 12. WP-OFF-6 shipped: a prompt, bounded resume, exactly once in effect

**What was built** (`stores/connectivity.svelte.ts`, `utils/reachabilityProbe.ts`, `utils/chat/outbox.ts`):

- **The store asks, it does not wait to be told.** On the browser's `online` event while
  `serverReachable` is false it probes at once; on a transport failure with the browser still online
  it probes after ~1 s (no `online` event will ever announce that return). The probe is `GET
  /api/version` (unauthenticated, so an expired token cannot keep the device "offline"; any HTTP
  answer is "reachable", a 502 included) through the same `trackedFetch`, so its answer fires the
  ordinary reconnect listeners - the outbox flush rides that, no second path. **Bounded and
  single-flight**: four probes at most per event (0/1/2/4 s after `online`, 1/2/4/8 s after a failure,
  each jittered +-25 %), a flapping link joins the running probe, and after the last one the store
  stops and waits for the next `online` event or any successful request - it never polls.
  Installed from `registerOutbox`, not as an import side effect.
- **A transport failure skips its backoff when the link returns, a refusal does not.** The outbox
  remembers (in memory) which entries last failed for want of an ANSWER (`DeliveryUnreachableError`,
  a deadline, a transport `TypeError`, classified by type); a reconnect arms exactly those to skip
  their ladder once. `sender-not-active`, a held group and the rest keep their clock: they are facts
  about the group and no reconnect changes them.
- **Idempotence comes from durable state, never from a clock.** An entry leaves the durable queue only
  after a 2xx; one lane per conversation means an entry is never on the wire twice at once; a frame
  whose answer was lost is re-sent as a NEW frame with the SAME inner `messageId` and receivers
  deduplicate, which is the existing at-least-once rule, unchanged. Nothing waits for a timer to
  expire to decide whether a send happened.

**Measured, before and after** (same harness as section 11; the link is cut the instant the POST's
answer would arrive, modelled with `Fetch.failRequest` at the response stage plus `offline`, so the
frame REACHES the server and the answer is lost; 3 s later the link returns; background traffic is a
presence-like poll every 3 s; "before" is the WP-OFF-5 branch):

| Scenario (link back onto...) | Before | After |
| --- | --- | --- |
| Cut mid-POST, a good link | 479 / 2851 / 2896 ms to the resent frame | **9 / 6 / 13 ms** |
| Cut mid-POST, Slow 3G | not run | 462 / 464 ms (one probe round trip) |
| Cut mid-POST, 2G-like | not run | 1216 / 1216 ms |
| Offline send, a good link | 2482 / 2412 / 2467 ms (bounded by the 3 s poll) | **6 / 5 / 5 ms** |
| Offline send, 2G-like | not run | 1207 / 1220 ms |

The server received the cut frame **twice** with the same inner id (`mA`: 2 receipts) and the entry
left the queue after the second: at-least-once on the wire, once in effect at the receiver. A reload
between the two is covered by `outbox.test.ts` (a new controller over the same durable queue sends it
once more and never again). **Not measured**: the whole app (MLS encryption, the incoming-queue
barrier `waitForMessageQueueIdle`, which adds the time of any pending decrypt after a resume, and the
WebSocket), and Android/iOS where `plugin-http` is invisible to CDP.
