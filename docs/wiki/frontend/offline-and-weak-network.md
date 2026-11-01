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
| **Read-mark** | DM/group: control entry (durable). Salon: `POST /api/channels/:id/read-mark`, **owed durably in localStorage (`salonReadMarkQueue.ts`) from the instant it is decided, delivered at the debounce, on leaving the salon, at community load and at live-stream return, always BEFORE `unread-counts` is asked; a failure keeps it owed, except the server's `404 CHANNEL_NOT_FOUND` (the salon was deleted while the mark was owed), an ANSWER on which the mark is dropped and said once (`ReadMarkTargetGoneError`, 2026-10-29), as is a mark of a salon `channel.deleted` names. A salon load sets the reader's OWN mark to the server's (or a higher one still owed), never to the row restored from disk: a belief held above the server's meant reading moved nothing and nothing was ever posted (`#infos`, 2026-10-09; `salonMarksAfterLoad`)** | Same | Same | `ChannelService.ts:808`, `ChatBackgroundService.svelte:644` |
| **Open a conversation** | Served from the local store; history top-up is the network part | MLS history is incremental (`?after=`, 1 request, 1-2 kB in the sandbox) -> 1.75 s Slow 3G / 3.1 s 2G until quiet | Re-fetched on reconnect via `fetchPendingMessages` | `mls-client/mlsDeliveryApi.ts:1075`, `initializeConnection.ts:158` |
| **Open a salon** | Needs HTTP: `GET .../messages?limit=100` | 100 ciphertext rows per open (size unmeasured, sandbox salon is near empty) | Live channel messages are not persisted one by one; the last page a load drew is kept, drawn first at the next open (offline included) and replaced by every load ([F4](community-open-budget.md#f4-built-2026-10-15)) | `ChannelService.ts:869-884`, `social-service channel.service.ts:3383` |
| **Cold start (web)** | **Browser error page** (`ERR_INTERNET_DISCONNECTED`): no service worker, no cached shell. Recovers on `navigate` once online | See section 3.2 | - | measured; `grep serviceWorker src` is empty; Tauri embeds the frontend (`frontendDist`), so native cold start has no download |
| **Cold start (session)** | `apiFetch` proceeds without a token on a transport failure; offline unlock exists | `auth/refresh` is the first API call, serial behind the JS bundle | - | `utils/apiFetch.ts:50-68`, [auth](modules/auth.md#what-happens-on-reconnect) |
| **Feed / notifications / agenda** | Fetch on tab switch; served from `feedCache` when warm, and from the stored first page when cold or offline since 2026-10-15 (feed only, [posts](modules/posts.md#the-feed-is-drawn-from-the-device-first-then-the-server-page-merges-over-it-2026-10-15)) | 1-3 requests per tab, one RTT deep each (sandbox data tiny) | - | [local-first-ui](local-first-ui.md) section 3; measured section 3.3 |
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
| **WP-OFF-2 (BUILT 2026-10-09, [chat](modules/chat.md#a-salon-message-is-shown-at-once-and-settled-by-the-server-wp-off-2-2026-10-09); the harness rows are owed)** | **Salon optimistic row** with `pending/sending/error` and a retry/delete affordance; id = the client UUID already placed inside the ciphertext (`AppMessage.message_id`), reconciled with the `channel.message.created` row by that inner id | M | salon bubble in ~40 ms like DMs (today 96 ms-600 ms+ and offline never) | reducer test: local row replaced, never duplicated, by the server row; harness row on both clients |
| **WP-OFF-3 (BUILT 2026-10-17, [section 16](#16-wp-off-3-and-wp-off-4-built-a-salon-write-waits-for-the-link-and-a-repeat-is-one-row-2026-10-17))** | **Salon durable outbox** (IndexedDB, same store as MLS, `channel` kind) + server idempotence: store the client `messageId` as a nullable unique `(author, channel, client_message_id)` and answer the stored row on repeat | M-L | offline salon send works; replay without duplicate | server spec (repeat POST returns the same row), outbox spec (replay after a cut), harness: offline send, kill, restore |
| **WP-OFF-6** | **SHIPPED 2026-10-09 (section 12).** Make resume prompt: probe reachability itself on `online` rather than waiting for the next failed/successful call; start the flush as soon as the incoming barrier is idle | S-M | 3.8-5.3 s -> ~1 s *(est)* | `outbox.test.ts` trigger table (the five triggers) plus a CDP row |
| **WP-OFF-4 (BUILT 2026-10-17, [section 16](#16-wp-off-3-and-wp-off-4-built-a-salon-write-waits-for-the-link-and-a-repeat-is-one-row-2026-10-17))** | Salon edit / pin / vote / read-mark through the same queue, optimistic with rollback only on a refusal | M | consistency with DMs | per-action reducer tests |
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
session). **Open questions:** (1) ~~does the salon reader dedupe on the inner `messageId`?~~ - moot since
2026-10-17: the SERVER keeps one row per (author, salon, client id), so no repeat reaches a reader ([section 16](#16-wp-off-3-and-wp-off-4-built-a-salon-write-waits-for-the-link-and-a-repeat-is-one-row-2026-10-17));
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
(read-only, public, no sign-in), 2026-10-09. The name is served directly by the school host,
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
- **`connectivity.slow`**: derived from observed answer latency, never a guess. **Revised 2026-10-11
  (see the last bullet of section 11's follow-ups below): the reading is the FLOOR (minimum) of the last
  5 time-to-head samples, not their mean**, at least 3 samples, entering at 700 ms and leaving at 350 ms
  (hysteresis). One request unanswered for 5 s enters too, but only while NOTHING ELSE was answered since
  it started. Measured (CDP, 14 sequential GETs): good 2 ms, Slow 3G 440 ms (**no hint**: slow but
  workable), 2G-like 960 ms (**hint after 2.9 s**, three requests). Never set while offline. UI: a small
  fixed icon (`SignalLow`, 20 px badge in the top corner, `aria-label` + `title` from Paraglide
  `slow_indicator_label`), NOT a strip; nothing disabled; the offline banner wins when both could show.
  It is placed BELOW the banner column (`top` adds `--app-banner-height`): being `fixed` it reserves
  nothing, and at a bare `top` it covered the dev "Environnement de test" strip and its close button
  (2026-10-13).
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

## 13. Audit of 2026-10-10: a 13 MB attachment on a poor link, and what navigation waits for

> **Request (user, 2026-10-10, production 1.2.1, iPhone, bad connection):** a 13.4 MB PDF sent in a DM
> was a grey bubble with an endless spinner and no figure, the peer typed *"C'est long la"*; the whole
> app feels slow; *navigation must never depend on loading*. The screenshot shows the file row (name,
> "13,4 Mo", one turning ring) and nothing else.

### 13.0 THE ROOT CAUSE WAS NOT THE CONNECTION: the host's WAF drops any body over 10 MiB

The user's console export (production web, 2026-10-10) shows `encryptAndUpload: application/pdf,
14049945 bytes, single block`, an XHR `POST /api/media/upload` answered **403 in ~1 s with an HTML
body** (`<title>... Ban</title>`, 5.75 KB), and the outbox logging `transient failure (attempt N):
MediaUploadError: media upload failed (403 ) - <!DOCTYPE html>` in a loop: the bubble spun for ever
because **a status code was treated as a transport failure**. The school-managed web application firewall in
front of the host refuses large request bodies, for every user, whatever the
connection: [host-waf-body-limit](../infrastructure/host-waf-body-limit.md). Fixed by WP-OFF-8 (below):
no body over 8 MiB is ever built, and a refusal ends the entry. The weak-link findings that follow
are real and independent.

### 13.1 What the upload did on a poor link, measured (W2, local estate, Slow 3G = 400 ms RTT, 50 kB/s each way)

A 13 400 000-byte PDF staged in the composer of the `Canari Test Alpha` DM and sent; CDP throttle set
after the conversation opened; samples every second.

| Fact | Measured |
| --- | --- |
| Press of send -> bubble on screen | **<= 2.8 s** (file name, "12,8 Mo", ONE `animate-spin`) |
| Press -> the upload request is issued | **4.8 s** (the file is read whole into memory, encrypted, wrapped in a `FormData`; nothing is on the wire before that) |
| What the bubble offered during the transfer | **0 progress elements, 0 percentage, 0 buttons** - no cancel, no retry; only the generic hover toolbar |
| Body | ONE `POST /api/media/upload` of ~12.8 MB (chunking starts at 50 MB, `media.ts`), `fetch`, no deadline, no abort signal |
| Time the transfer needs at this speed | 12.8 MB / 50 kB/s = **~256 s** of a spinner |
| Link cut 25-30 s in | the request failed `net::ERR_INTERNET_DISCONNECTED` 2.3 s later; the entry stayed queued (IndexedDB, bytes included); after the link came back the message was sent - **the whole body again from byte 0** (the media route has no offset) |

**Not captured, said plainly:** W2 is a shared browser and another session navigated it away from the
conversation mid-run, so the second half of the retry timeline (request count after the link returned)
was not sampled; "sent after the link came back" is read from the bubble the next probe found
(`Message envoye`). The throttle is CDP's, so the iPhone's WKWebView, `NSURLSession` background
behaviour and a cellular radio's real stalls are NOT measured: the numbers say what the bubble can and
cannot show, not how long an iPhone takes.

Reading the code beside the measurement (`outbox.ts` `prepareMedia`, `media.ts` `encryptAndUpload`,
`MessageMediaRenderer.svelte`):

- The bubble of a queued attachment has ONE state, the spinner, from enqueue to the answer. It cannot
  tell "encrypting", "sending 40 %", "the link died" and "waiting for the next attempt".
- `fetchUpload` is a bare `fetch`: WP-OFF-5's deadline covers `apiFetch` and the MLS POST, **not the
  upload**, which is the one request whose body is megabytes. A dead socket on a phone is a spinner
  until the OS gives up.
- The upload runs INSIDE `flushOne`, which holds the conversation's lane and one of the three send
  slots: **a text sent behind a 13 MB attachment waits for the whole transfer** (~4 min on Slow 3G;
  from the code, not measured live).
- Every failure restarts at byte 0, and the bytes (13 MB) sit in the outbox row and, during an attempt,
  three times in memory (`file.arrayBuffer()`, the ciphertext, the `FormData` blob).

### 13.2 What navigation waits for

From the routes' `load` functions (all `ssr = false`, so a `load` that awaits holds the navigation):

| Where | Awaits | Verdict |
| --- | --- | --- |
| `routes/+layout.ts` (every route) | when the MLS session is NOT yet logged in (boot, a resume, the whole unlock window): `refresh()` if no user id, **then `fetchUserProfile(userId)`, a network call** (20 s deadline on a slow link) | **BLOCKS EVERY NAVIGATION during that window.** It only decides "redirect to login on a confirmed 404" and a transport failure is deliberately survived, so nothing it learns is needed to render. Fixed by WP-NAV-1 |
| `routes/posts/[postId]/+page.ts` | the post itself (`await fetching`) | blocks the click on a post from the feed until the GET answers; the page then shows "not found" or the post. Fixed by WP-NAV-1 (the shell and header render at once, the post is a promise) |
| `routes/posts/+page.ts` | the audience verdict only when none is remembered (first ever visit); the 20 posts are a promise handed to `{#await}` already | fine |
| `associations/[slug]`, `lists/[slug]`, `dashboard/association`, `app-shell` | nothing (synchronous `load`) | fine |
| `/chat` and its DMs | no `load`; the list waits on the WASM by ORDER, not by data (R7, section 10.3) | covered by WP-W3 (diagnosed, not built) |

So the user's belief is half right: item loading is already independent of the skeleton almost
everywhere (the feed, associations, lists), but the ROOT layout puts a profile round trip in front of
every navigation while the session is not yet unlocked - exactly the cold-start window a weak link
makes long - and one detail page awaits its own data.

### 13.3 The prioritised list

| # | Item | State | Where |
| --- | --- | --- | --- |
| 0 | **P1** Any upload body over 10 MiB is dropped by the host WAF (403 HTML) and was retried for ever | **BUILT: WP-OFF-8** (8 MiB budget, chunk route above it, a refusal ends the entry with an explicit bubble) | [host-waf-body-limit](../infrastructure/host-waf-body-limit.md) |
| 1 | **P1** An attachment bubble is blind: no progress, cancel or retry, no deadline on the upload | **BUILT: WP-OFF-8** ([13.4](#134-wp-off-8-built-a-bubble-that-says-how-much-has-gone-and-can-be-ended)) | this page |
| 2 | **P1** Navigation waits on a profile call (root layout) and on one post (detail page) | **BUILT: WP-NAV-1** (a separate pull request; [posts](modules/posts.md)) | `routes/+layout.ts`, `routes/posts/[postId]` |
| 3 | **P2** Every failed upload restarts at byte 0; a 50 MB body is ONE request | open for every attachment but one: a CHAT REEL resumes since RC-5 (draft) through media-service's upload sessions, sending only the parts the server lacks ([reels-in-chat](modules/reels-in-chat.md#14-what-the-resumable-outbox-rc-5-built-and-what-it-owes-on-devices-2026-10-19)); the general writer is S2 of [media-streaming-upload](../services/media-streaming-upload.md) | [reels-in-chat](modules/reels-in-chat.md), [media-service](../services/media-service.md) |
| 4 | **P2** The upload holds the conversation's lane and a send slot, so text sent behind a big file waits for it | **BUILT: WP-OFF-9** ([13.8](#138-wp-off-9-built-the-upload-runs-outside-the-lane-2026-10-18)) | this page |
| 5 | **P2** A salon (channel) attachment blocks the composer with no progress and no cancel (`isUploadingMedia`) | open: it needs WP-OFF-2/3's salon row; `xhrUpload` is ready for it | [backlog](../backlog.md) |
| 6 | **P2** The 13 MB file lives in the outbox row and three times in memory per attempt | the file is outside the row since 13.7; RC-5 (draft) adds the raw take in the same store and a second blob slot, so replacing the bytes never overwrites what the committed row names | [reels-in-chat](modules/reels-in-chat.md) |
| 7 | **P2** First list render waits for the WASM (R7) | diagnosed, not built: WP-W3 | section 10.3 |
| 8 | **P3** Chat images have no thumbnail, a 300 px bubble downloads the whole blob | open: WP-W7 | section 5 |
| 9 | Covered already: REST and MLS-POST deadlines, the `slow` state, one lane per conversation (OFF-5, #1652); prompt resume (OFF-6); compression and WASM preload (W1, W2); salon optimistic row (OFF-2, #1649, draft) | | sections 10-12 |

### 13.4 WP-OFF-8 built: a bubble that says how much has gone, and can be ended

**One transport for a big body** (`utils/uploadXhr.ts`). `fetch` exposes no upload progress, so the
body of an attachment goes through `XMLHttpRequest` when the caller passes a `transport` to
`MediaService.encryptAndUpload`: the same engine, cookies and CORS rules on every shell (browsers,
WKWebView, Android WebView), a real `Response` back, so the 401 renew-and-retry of `fetchUpload` is
the one path for both. It reports `{loaded, total}`, honours an `AbortSignal` (a typed
`UploadAbortedError`), and **gives up on silence, never on a total**: 45 s without one byte moving
(`DEFAULT_UPLOAD_IDLE_MS`) raises `UploadStalledError`, a `RequestDeadlineError`, so `isTransportFailure`
reads it by type and it can never log anyone out. **The guard stops when the body has left**
(`upload.onload`): a chunked `complete` streams up to 100 MB to storage with nothing on the wire, and
abandoning it at 45 s made the client restart while the server finished. The wait for the answer has its
own bound, `DEFAULT_UPLOAD_ANSWER_MS` (5 min), whose expiry is the typed `UploadAnswerTimeoutError`, also a
transport failure. A 50 MB file on a 50 kbit/s link takes seven minutes
and must not be abandoned for being big. Chunked uploads report the WHOLE blob's progress.

**The outbox owns the transfer** (`utils/chat/outbox.ts`, `uploadProgress.svelte.ts`). `prepareMedia`
creates an `AbortController` per entry and mirrors `{phase, loaded, total, attempt}` into an in-memory
store the bubble reads (never IndexedDB: the numbers change several times a second and mean nothing
after a crash). Phases: `preparing` (reading and encrypting), `uploading` (real bytes), `stalled` (no
byte for 10 s, display only; the transport's guard abandons it later), `queued` (in the queue, not started: no network claim), `waiting` (the last attempt
ended with NO ANSWER, or the link is known down; it starts from zero), `repairing` (held until the group is
sendable: roster repair, re-add) and `retrying` (any other failure, on the backoff ladder). **The label is
the typed reason of the hold** (`holdForRetry` opts `transport` / `repair`), never inferred: a bubble with
no view yet reads `connectivity.isOffline` (waiting) or else `queued`, and a reconnect turns a stale
`waiting` into `queued` at once (2026-10-11, the Mi 9T said "waiting for a connection" while online). **Cancel is the ordinary delete of an unsent
message**: `cancelPending` withdraws the row and now also aborts the body already on the wire, so a
13 MB transfer does not keep leaving a weak uplink for a message nobody wants. **Retry** skips the
backoff for that entry (the `resuming` set WP-OFF-6 already had) and, when a transfer is stalled on the
wire, aborts it and lets the lane re-run at once, not counted as a failure.

**The bubble** (`UploadAction.svelte`, `uploadLabel.ts`, the file row and the image/video frame of
`MessageMediaRenderer`). A ring that fills with the bytes sent, the cancel cross inside it, a retry
beside it only while nothing is moving, and one line: *Envoi 40 % - 5,4 Mo sur 12,8 Mo*, *Plus rien ne
passe - ...*, *En attente de connexion - nouvel essai automatique*. The percentage is clamped to 99 until
the server answers (100 is the answer, not the last byte leaving), and a state with no honest figure
turns instead of filling. After a reload the queued row shows `queued` until the flush runs again.
Strings are Paraglide (`upload_*`).

**Pinned by** `utils/uploadXhr.test.ts` (progress, a refusal as a status, network error as `TypeError`,
silence versus steady progress, abort), `media.uploadTransport.test.ts` (progress, 401 through the same
transport, abort reaching the request), `outbox.test.ts` (progress mirrored and cleared, `waiting` after a
failure, a withdrawal aborts and never sends, a retry restarts without a backoff, a retry on a backing-off
entry runs it) and `MessageMediaRenderer.upload.svelte.test.ts` (figure, buttons, no spinner).

**A refusal is an answer, never transient.** `MediaUploadError` carries its status and its ORIGIN, read
from the response's Content-Type at the throw (`gateway` = an HTML page, which the application never
produces; `app` = our JSON). `uploadRefusalCause` classifies by that type: 413 -> `too-large`; a 4xx from
the gateway **403 HTML** only -> `blocked` (an HTML 400/404/502 from nginx or Cloudflare during a deploy is
retried); the application own 400/403/404/422 -> `refused`, except a 404 that means the staged chunk session
is gone (`sessionLost`: a new session mends it); 401, 408, 425, 429, 5xx, a deadline and a network error stay
retried. `requestBodyBytes` fails closed: a body of unknown size (a stream) counts as over budget.

**A failed chunked attempt gives its session back.** Every restart uses a new uploadId, so the staged bytes
would wait for the 24 h sweep. `MediaService` calls `DELETE /api/media/upload/chunk/:id` (best effort, logged,
never delaying the failure) on a cancel, a refusal, a stall or a lost chunk, and the server route is owner-checked
and idempotent. `complete` is idempotent too: a repeated call for a finished session returns the same mediaId, from a
`<uploadId>.done` sidecar file next to the staging (so it survives a restart or a redeploy; it ages out with
the 24 h orphan sweep). **The client uses it**: on a lost answer, a transport failure or a 5xx of `complete`
it re-asks the SAME uploadId, at most 3 times (a counter, no clock); starting over under a new uploadId would
store the object twice. After those 3 the attempt fails, the session is released and the outbox restarts under a
new uploadId: if the server had finished every time, one object is orphaned (ephemeral class: the idle sweep
takes it). The **single-request route (< 8 MiB) has no memo**, a repeat stores a second object, so it keeps the
45 s bound for the answer instead of the 5 min of a chunked `complete`. A cancel during `complete` is logged
(the assembled object is then unreferenced). **What releases a session when the app is killed: nothing but the
24 h sweep** - the DELETE is a best-effort of a live page (it refreshes an expired token through `fetchUpload`).
**A blocked upload is parked, not ended**: a firewall ban is time-limited, so the entry stays in the queue with
the bubble phase `blocked` (retry + delete), is never retried by the ladder, and a reload makes one new
attempt.
Pinned by `media.chunkLifecycle.test.ts` (failure at chunk N, refusal, cancel, slow complete) and
`media.service.chunk-lifecycle.spec.ts`. The outbox ends the entry at once (`failPermanently`: bubble `error`, entry
deleted, a notice in the thread, metric cause), and the bubble shows *Envoi refuse par le serveur* with the
delete action instead of the spinner a missing `mediaId` used to draw for ever. There is no retry button
on a refused entry: it is deleted from the queue, and the same bytes would be refused again. The page of a
gateway is never copied into a log line (it was 5.75 KB per retry).

**The body budget.** `utils/mediaRequestLimits.ts`: `GATEWAY_MAX_BODY_BYTES` (10 MiB, the host's limit) and
`MEDIA_REQUEST_BODY_BUDGET_BYTES` (8 MiB), the single-request ceiling AND the chunk size, so the
14 049 945-byte PDF now goes `chunk/init` + 2 chunks + `complete` (it was 50 MB before chunking began).
`fetchUpload` throws before sending if a body would exceed the gateway limit, and
`media.bodyBudget.test.ts` sends files around the budget through the real `MediaService` and fails if any
request carries more. Every upload surface (chat, salon, posts, comments, reels, camera) goes through
`encryptAndUpload`, so one place covers them; the other large-body POSTs are listed in the
[host-waf-body-limit](../infrastructure/host-waf-body-limit.md#what-else-posts-a-big-body) page.

**Not done, on purpose:** resume (a chat reel resumes since RC-5, draft; the other attachments do not), the lane decoupling (WP-OFF-9,
built since: 13.8), the salon composer, and any hardware reading: **owed ONE look on the iPhone** with a real 13 MB file on
a bad link, because every gate here is blind to what a WKWebView `XMLHttpRequest` upload reports on a
cellular radio.

### 13.5 An upload that gets NO answer ends, and a parked one holds nothing back (2026-10-10)

Read on the bench Mi 9T against `dev` (readings R1/R2 of `v1.2.3-alpha.1`, PR #1725 `device-readings-2026-10`): a 2.2 MB attachment, whose legacy relay answers 413 above 1 MiB, stopped at 1.4 of 2.1 MB and then **never became a terminal state**. The relay refuses early and closes the socket while the body is still leaving, so the client sees NO status: the XHR stalls (`UploadStalledError`) or errors (`TypeError`), both TRANSPORT failures, and `holdForRetry` climbed the ladder for ever. A status would have been handled (`uploadRefusalCause` reads 413 as `too-large` even from the edge); the missing status is the defect.

- **The bound is a count of consecutive no-answer attempts that got no FURTHER than the best so far** (`UPLOAD_NO_ANSWER_ATTEMPTS = 3`, 256 KiB margin; in `outbox.ts`: classified by TYPE, `UploadStalledError` or `UploadNetworkError` only - never a bare `TypeError`, a cancel, or `UploadAnswerTimeoutError`, whose body WAS delivered; a slow link that advances each time is never given up on). The third throws `UploadGaveUpError`; the flush parks the entry (kept, `phase: 'failed'`, caption `upload_failed`, retry and delete offered by `UploadAction`). A success, a cancel, a manual retry and a reconnect's resume start the count again; it is in memory, so a reload earns one more bounded round.
- **A parked entry no longer holds its successors** (R2's likeliest cause, PROVEN by test, not by a reading): `drainLane` broke on `'skip'`, which `blocked` and `parked` returned, so a text written after a blocked attachment waited behind it. They now return `'parked'` and the lane continues; only an entry that RETRIES (waiting on the network) keeps order.
- **UNPROVEN**: whether the 300 KB attachment of R2 was behind such an entry (the 6 outbox rows of the logcat were not identified), and what reads `outbox` once a second there (a backoff timer clamps at 1 s: `scheduleBackoff`). Re-read on the phone after the next pre-release. `MediaService.uploadLimits()` also caches a `fetch` with no deadline for ever (compose-time only, not the flush).
- **Who may pass a parked attachment**: only what does not depend on it. A reply quoting it, or a control whose proto carries its id, waits (`dependsOnAny` in `outbox.ts`); an independent text goes. `failed` also leaves `transportHeld`, so a reconnect does not restart it behind a bubble that still says failed. Not done: re-asking the SAME uploadId on retry (the single-request route has no uploadId; the chunked one restarts under a new one, as before).

### 13.6 A queued attachment is decoded when it is SENT, never when the queue is READ, and no retry loop is endless (2026-10-10)

A Pixel 6a was made unusable by ONE queued 13 MB attachment. #1728 removed the re-encryption on each backoff; what remained was the READ: `readQueue` ran four times per flush (`runFlush`, each lane pass, the backoff scheduling, the mirror refresh) and each decrypted and base64-decoded every payload, so a media entry that was not even due cost its whole file every time.

- **`IStorage.getOutboxQueue`** is the flusher's read: a `media` row comes back with its scheduling columns only (`media` undefined). The SQLite store does not even SELECT its `iv`/`cipher_text` (a `CASE WHEN kind = 'media'`), so the file never crosses the SQL bridge; IndexedDB skips the decrypt. **`getOutboxEntry(id)`** returns one entry in full and throws the typed `OutboxPayloadUnreadableError` when the row exists and cannot be decrypted. `flushOne` calls it AFTER every skip (cancelled, parked, backing off, channel entry), so a due attachment is decoded exactly once and an entry that is not due costs a row of numbers. `getOutboxEntries` was deleted (no production caller). IndexedDB's `updateOutboxEntry` takes the same in-place path as SQLite for scheduling patches, in ONE readwrite transaction that writes only a row that still exists (a get and a put in two transactions could resurrect a row `cancelPending` had just deleted).
- **Terminal states.** A payload that cannot be decrypted, and an attachment that fails `MAX_UNEXPECTED_ATTEMPTS` (8, about five minutes of the ladder) times in a row for a LOCAL reason, are PARKED as `phase: 'error'`; caption `upload_error` (fr+en), retry and delete offered. "Local" is read from the TYPE only (`isLocalAttachmentFailure`: the outbox's `LocalAttachmentError` - a row that cannot be loaded, an attachment holding no bytes while owing an upload - a `NotReadableError`/`NotFoundError` `DOMException`, a `RangeError`). A transport failure, a 5xx, `sender-not-active` and an edge refusal NEVER count (a relay outage must not tell the member their file is unreadable) and any such hold resets the run, so the count is truly consecutive. Kept, never deleted; in memory, so a reload earns one more bounded round. The no-answer upload keeps its own bound (13.5).
- **The retry button reached nothing for a 403-parked entry**: `retryUpload` never cleared `forbiddenParked`. It does now.
- **NOT bounded, on purpose**: a NON-media entry held by the generic arm (`sender-not-active` waiting for the repair, an edge refusal, a 4xx) - the ladder tops at 60 s and a retry is now one cheap row read, so it is a cadence, not a load. **A text on a run of 5xx is bounded since 2026-10-18 (section 17).** The retry button on a bubble BEHIND a backing-off earlier entry of the same conversation still waits its turn (lane order).
- **The "slow connection" banner**: media uploads go through `xhrUpload`/`fetchWithAnswerDeadline`, which never call `trackRequest`, so an upload in flight did not arm it. What did was the renderer itself: a busy thread fires the 5 s in-flight timer late and delays every response handler. `trackRequest` now forgives a timer that fired more than `LOOP_LAG_TOLERANCE_MS` (1 s) behind its schedule (the device was busy, not the link) and re-arms it, so a request still unanswered a full threshold later does raise the hint, and a body of 16 KiB or more (`transfer`, the same ceiling that already keeps it out of the latency average) never arms the in-flight hint.
- **The slow hint accused the link for server time (user, 2026-10-11).** The Mi 9T bench phone (account
  `fourth`, dev) logged `slow link (smoothed answer 784 ms, 0 request(s) in flight)` on a good link: the
  mean of every tracked call includes heavy routes (feed, lists, MLS), whose time-to-head is link RTT PLUS
  server processing, and the gateway sends no `Server-Timing`. It was the average that was wrong: server
  time only ADDS, so the minimum of the last 5 samples is the closest reading of the link and one cheap
  call (presence poll, version probe) answering fast keeps it low, whatever heavy calls surround it
  (`connectivity.test.ts`, "heavy routes interleaved with cheap ones"). The 5 s in-flight rule likewise
  ignores a request while any other call was answered since it started (the link works; that route is slow
  server-side), re-checked every 5 s so a link that then goes quiet is still caught; no call in the app is a
  long poll or a stream, so no exemption flag exists. On the phone the in-flight list was empty and the
  banner gone when read (the 784 ms state had cleared); the live per-request capture is owed to the next
  occurrence. The strip became a small fixed icon because the phone has no top bar to host it.

### 13.7 The file leaves the outbox row: bytes in IndexedDB, a key in the row (2026-10-11)

**Why.** Even chunked (13.6, `#1732`) a queued 13 MB attachment was a 23 MiB row crossing the Android SQL bridge as a JSON string three times per send (write, read, post-upload patch), ~1.2 GB of renderer memory on a Mi 9T ([backlog](../backlog.md)). A `Uint8Array` cannot cross that bridge better (it becomes a JSON number array), so the bytes no longer cross it at all.

**Mechanism** (`db/outboxBlob.ts`, used by BOTH `SqliteStorage` and `IndexedDbStorage`, so there is one behaviour):
- Database `CanariDBOutbox_<userId>` (its OWN database, not a store of `CanariDB_<userId>`, which does not exist on a phone and which a stray open there is a recorded defect). The `CanariDB` prefix is what the device wipe enumerates; `closeOutboxBlobStores` is a wipe step because a delete blocks on an open connection. Record `{ id, iv, cipher, createdAt }`, the cipher a structured-clone `ArrayBuffer` (no base64, no JSON).
- Each blob is AES-256-GCM under a RANDOM per-entry key held ONLY in the row's encrypted payload (`media.blob.keyB64`). **The blob id IS the entry id**: deleting needs no read of a row that may be unreadable, and the sweep asks "does a row have this id?" from the clear `id` column. A row stays under ~1 KB (tested with a 5 MiB file: under 2 KiB of parameters in total reach the SQL layer).
- **`encodeOutboxSensitive` never writes file bytes.** `saveOutboxEntry` / `saveMessageWithOutboxEntry` call `writeOutboxWithBlob`: put the blob, THEN write the row. `getOutboxEntry` re-attaches the bytes (`attachOutboxBlob`); `getOutboxQueue` is unchanged (a media row is still clear columns only); `hasEntry`, the in-flight enqueue tracking (`#1733`) and the typed errors (`OutboxPayloadUnreadableError`, `LocalAttachmentError`, `OutboxEnqueueError`) are untouched.
- **After the upload** the flusher's patch (`uploadedRef`, `fileBytes` dropped) is a non-clear patch: it re-reads the SMALL row, writes it back without the blob reference, then deletes the blob. It never re-puts the file. `deleteOutboxEntry` (sent, cancelled, parked-and-deleted) removes the row, then the blob; it only touches the blob database for a `media` row.

**Crash windows, each tested** (`db/outboxBlob.test.ts`):

| Killed | Left | Outcome |
| --- | --- | --- |
| after the blob put, before the row write | a blob, no row | nothing to send, no ghost; swept at the next session start (`registerOutbox` -> `sweepOutboxBlobs`) |
| a blob put that fails (quota, disk) | nothing | `OutboxBlobWriteError`, wrapped in `OutboxEnqueueError`; the send path withdraws the placeholder and re-stages the file. A QUOTA failure says so (`chat_media_send_error_storage_full`, fr+en) instead of the generic line |
| row exists, blob gone (platform eviction) | a row | `OutboxBlobMissingError` -> `OutboxPayloadUnreadableError` -> the flusher PARKS it as `phase: 'error'` (`upload_error` caption, retry or delete), entry kept; a blob the key does not open is `OutboxBlobCorruptError`, the same way. An IndexedDB failure that is neither (would not open) is NOT a verdict and is retried through the counted hold |
| after the row rewrite, before the blob delete (post-upload) | a blob, a row that no longer names it | removed when the entry is deleted after the send |
| a cancel landing between the row read and the blob read of `getOutboxEntry` | nothing | the missing blob is NOT a verdict while the row is gone: `attachOutboxBlob` re-asks whether the row exists and returns `null` ("no longer queued"), so a message the member just deleted is dropped, never parked as an error |
| `deleteOutboxEntry`'s `SELECT kind` failing (SQLite) | nothing | the cancel still deletes the row, and the blob too (absent is success); a blob delete that fails is logged and left to the sweep, never a failed cancel |

**Account reset (`clear()`), both backends: rows FIRST, the blob store LAST** (`clearOutboxBlobsLast`). The blob store is a separate database whose open throws when IndexedDB is unavailable or blocked. Awaited between `DELETE FROM outbox` and the graine/owed-exit/distribution deletes it skipped them (sensitive seeds survived a reset); awaited before the IndexedDB transaction it left rows naming blobs already gone. Now a blob-store failure can only leave keyless ciphertext, and it is logged and rethrown as `OutboxBlobClearError` after every row store is empty. The IndexedDB reset also ABORTS its transaction on a synchronous refusal, which otherwise committed the clears queued before it.

**`idbCommitted`, every outbox IndexedDB transaction.** Per the spec `transaction.error` is set only at abort, so `tx.onerror = () => reject(tx.error)` rejected with `null` during a request's error event: `isQuotaError(null)` was false and the "storage full" line never showed on an engine reporting quota as a request error. It rejects with the request's error, then `tx.error` at abort, and never with `null`.

**The sweep** deletes blobs no row owns. **The 10-minute grace (`BLOB_SWEEP_GRACE_MS`) is what protects a concurrent enqueue**, not the order of the reads: the row ids are a snapshot, so an enqueue whose row commits after that snapshot and whose "being written" mark ends before the filter looks like garbage; the in-document set also cannot see another web TAB. Both are seconds-old blobs and only the age test excludes them. A wrong clock there costs one more session of garbage, or a typed `upload_error` on a file written in the same seconds, never a send. The sweep is started inside a promise chain, so a synchronous throw cannot escape `registerOutbox`.

**Migration.** A row queued by an older build keeps its bytes inline (`fileBytesB64`): `decodeOutboxEntry` still reads it, `getOutboxEntry` returns the bytes, it is sent as before, and nothing writes the inline form again. Any re-save of an entry holding bytes converts it to the blob form.

**Not changed, by design.** The native mirror never carries media (`toMirrorEntry` is null for it). **A PIN change re-seals every outbox row and never touches a blob** (since #1898, `resealDeviceKeyStores` in `pinChange.ts`): it reads and compare-and-swaps the raw `iv` / `cipherText` of each row on both backends (`getSealedPayloads` / `swapSealedPayloads`), so an attachment row moves with its blob key inside it and the IndexedDB blob stays exactly as written. The live flusher keeps the old key until the change ends, and the storage gate covers that window: its calls wait while the rows move, then the retired key is forwarded to the new one ([auth](modules/auth.md#the-other-tabs-of-the-account), `db/deviceKeyGate.ts`). Pinned by `pinChange.test.ts` (a queued text, reaction and attachment survive the change; a flush issued mid-pass is held, then reads under the new key).

**Owed.** (a) the Mi 9T re-reading of the 13 MB send (peak and the wait before the first byte); (b) ONE iPhone check: kill the app with a queued 13 MB file and relaunch. WKWebView may evict IndexedDB under storage pressure; the row then survives in SQLite and the attachment shows the `upload_error` card (a lost attachment, visibly, never a silent one). Not measured.

#### The 2026-10-11 analysis that led to it (moved from the backlog, 2026-10-24)

Mi 9T, `1.2.3-alpha.4`: a 13 MB send took ~100 s, renderer RSS 234 MB -> 1.26 GB.


**Reading (user, dev):** 13 MB send ~100 s end to end: ~60 s with the bubble on `waiting` while online, then the ring, then sent; renderer RSS 234 MB -> 1.26 GB ~20 s after the tap (956 MB for 14 MB); alpha.3 ~27 s, 1.1 GB. **Where it goes was read from the code and micro-benchmarked in Chrome (V8), not measured on the phone.** `waiting` is also the DEFAULT view of a bubble with no upload state (`MessageBubble.svelte:587`), so it does not prove a backoff hold.

#### The copies of the file, per phase (13 MiB = 13 631 488 B)

| Phase | Where | Copy | Size / measured (desktop Chrome) |
| --- | --- | --- | --- |
| pick | `useMessaging.svelte.ts:1201` | `file.arrayBuffer()` | 13.6 MB |
| write | `outboxCodec.ts` `uint8ToBase64` | `binary += fromCharCode` per byte: one cons node per byte | **+260 MB heap, 411 ms**, then flat base64 17.3 MiB |
| write | `encryption.ts:49-52` | `JSON.stringify` string, `TextEncoder`, AES-GCM output | 3 x 17.3 MiB, 52 ms |
| write | `sqlite.ts:60` `uint8ToBase64` | the same per-byte loop on the CIPHERTEXT | **+370 MB heap, 816 ms**, row string **23.1 MiB** |
| write IPC | `sqlite.ts:752` -> plugin-sql | **Android never uses the fetch IPC** (`ipc-protocol.js:20`), so the 23 MiB string goes `JSON.stringify` -> `window.ipc.postMessage` (Java UTF-16) -> JNI -> serde `Value::String` -> `to_owned()` for the bind (`tauri-plugin-sql wrapper.rs:159`) | 4-5 copies native-side, NOT measured |
| read | `outbox.ts:912` `getOutboxEntry` -> `SELECT *` | an answer over 10 KiB becomes `JSON.parse('<escaped>')` evaluated by `webview.eval` (`format_callback.rs:64`, `protocol.rs:335`) | 23 MiB x several, NOT measured, **prime suspect for the 60 s** |
| read | `sqlite.ts:72`, `outboxCodec.ts:52` | `Uint8Array.from(atob(s), cb)` twice (outer ciphertext, inner file) | **+266 MB / 1114 ms** and +182 MB / 672 ms |
| read | `encryption.ts:70` | plaintext, `TextDecoder` string, `JSON.parse` string | 3 x 17 MiB |
| upload | `sessionAuth.ts:245`, `media.ts:739,746` | `new File([bytes.buffer])`, `arrayBuffer()`, ciphertext, 8 MiB chunk slices + Blob + FormData | 3 x 13.6 MB + 8 MiB per chunk |
| after upload | `outbox.ts:629` | `updateOutboxEntry` with a media patch is NOT a clear patch: a SECOND full `SELECT *`, decode, merge, re-encrypt (small), INSERT | the whole read cost again |

Peak is linear: **~95 MB of renderer per MB of file**. The server ceiling is 50 MB, so a 50 MB file asks for ~4.7 GB: a certain renderer kill today.

#### Where the 60 s is, ranked (the phone log decides)

1. **The 23 MiB `SELECT` of `getOutboxEntry`** and **the 23 MiB `INSERT`** through the Android postMessage + `eval` bridge: native copies, a script of tens of MB to parse. Unmeasured; the JS side alone is ~2.3 s per direction on a desktop (table above), perhaps 10-20 s on a Mi 9T, which is NOT 60 s.
2. **GC thrash near the WebView heap ceiling** (1.2 GB of cons strings and iterables alive at once): would explain the alpha.3 27 s -> alpha.4 100 s spread, since no code on this path changed between the two tags (only #1730's light `hasEntry` read and a throw on enqueue).
3. **The backoff ladder**, which would be `2+5+15+30 = 52 s` if four holds preceded the first upload (`outbox.ts:57`, `holdForRetry`). Ruled IN or OUT by one log line: `held: group ... not sendable` or `transient failure (attempt N)` versus none. A first-attempt hold after a failed payload read re-pays the 23 MiB read on every retry.
4. Not the cause, by reading: a lane waiting behind an earlier entry (one entry), the idle barrier (`waitForMessageQueueIdle`, instant when nothing drains), the mirror (media is never mirrored: `outboxMirror.ts` `toMirrorEntry` is null for media), and the clear-patch path (alpha.4 has it).

**Instrumentation shipped with the PR:** `[OUTBOX] <id> durable write took N ms` (enqueue) and `[OUTBOX] <id> payload read in N ms` (flush). The next phone reading answers 1 vs 2 vs 3 from the session log.

#### Design, cheapest first

**Tier 0 - shipped by `fix/outbox-media-peak`: chunked base64** (`utils/hex.ts` `toBase64`/`fromBase64`, used by `outboxCodec.ts` and `sqlite.ts`; byte-identical to `btoa`, tested across the 32 KiB slice). Desktop numbers, 13 MiB: encode 411 + 816 ms -> ~85 ms each; decode 1114 + 672 ms -> ~60 ms and ~15 ms; ~1.0 GB of transient heap gone. It does NOT touch the three 23 MiB IPC crossings.

**Tier 1 - DONE (2026-10-11, `feat/outbox-media-blob`): see [13.7](#137-the-file-leaves-the-outbox-row-bytes-in-indexeddb-a-key-in-the-row-2026-10-11).** The text below is the design it followed; what remains OPEN is listed after the risks.

**Tier 1 - the file leaves the row (removes the IPC and most of the peak).** Binary over IPC is hopeless on Android (`process-ipc-message-fn.js`: a `Uint8Array` inside the message becomes a JSON number array, ~4x worse than base64), so the bytes must not cross it: keep them in **IndexedDB** (the webview's own store, structured clone of an `ArrayBuffer`, no base64, no JSON), in a store `outbox_media` `{ id, iv, cipher }`.
- Encrypt the RAW bytes under a **random per-entry AES key** kept in the small encrypted SQLite payload (`blobId`, `blobKeyB64`): AES-GCM of 13 MB is ~9 ms and the row stays under 1 KB, so `getOutboxEntry`, every retry and the post-upload patch cost milliseconds and no longer move 23 MiB.
- Order: **blob first, row second** (the opposite reasoning of the message/entry pair: a row with no blob is a VISIBLE typed failure - `LocalAttachmentError`, the #1730 orphan verdict, parked with a delete - while a blob with no row is invisible garbage a boot sweep deletes).
- `prepareMedia` reads the blob from IDB only when it uploads. After upload: delete the blob, patch the small row (a clear-class patch).
- Web build: `indexeddb.ts` already holds the outbox, so the blob store joins the same transaction (atomic there).
- Expected peak: ~3 x 13.6 MB for the pick/encrypt/upload instead of 1.2 GB; the write and read waits become the IDB put/get (to be measured on the phone).

**Tier 2 - a client cap is NOT recommended once Tier 1 lands.** Until it does, a native cap near 20 MB would stop the 50 MB OOM; it needs a Paraglide message and is offered as a decision, not a default.

#### Risks (Tier 1 built; the verdicts)

- **iOS WKWebView IndexedDB eviction** under storage pressure: unmeasured. The row survives in SQLite and a lost blob becomes the typed orphan, but that is a lost attachment. Needs one iPhone check (kill the app with a queued 13 MB file, relaunch).
- **Crash survival:** the IDB put commits before the row; a kill between the two leaves swept garbage, never a ghost send. Test: kill after the put.
- **Native mirror:** unaffected, media entries are never mirrored.
- **Side finding:** between `addMessageToChat` (placeholder) and the end of the 23 MiB INSERT the bubble has no upload view and `hasEntry` can answer `false`, so #1730's orphan red state can flash on a slow phone and is not re-asked when the row lands. Tier 1 shrinks the window to milliseconds, Tier 0 by the encode time.

### 13.8 WP-OFF-9 built: the upload runs outside the lane (2026-10-18)

**Before.** `flushOne` awaited the whole transfer inside the conversation's lane AND a send slot, so a text written behind a 13 MB file on a weak link waited minutes for it, and three big files held all three send slots.

**Mechanism** (`utils/chat/outbox.ts`):
- The lane, meeting an attachment that owes its upload, **starts the transfer and moves on** (`startUpload`, outcome `uploading`). That is at enqueue in the ordinary case (the enqueue raises the flush); behind an EARLIER entry of the same conversation that is held for a retry, it starts when that one clears, as before. The transfer holds no send slot; it holds one of `MAX_CONCURRENT_UPLOADS` (2) upload slots, so a weak uplink is not split across many bodies.
- **Only the small MLS send of the media message takes the lane**, once the upload has ended: the task wakes the lane, which sends it in turn. One task per entry id, checked and set with no await between them, so a file is never on the wire twice; the leader-only gate is unchanged (only `runFlush`'s lanes start tasks).
- A lane with an upload still running **stays claimed and waits for an EVENT** - the upload ending, or a flush raised meanwhile (an enqueue wakes it) - never a clock. So `flush()` still resolves once everything it could send is sent.
- **A failed upload is classified IN THE LANE** (`settleFailure`, the one path the MLS send's failures also take): refusal, give-up, gateway block, transport hold and the retry-on-request end exactly as in 13.4-13.6. A failure held for a retry, or an attachment backing off on its UPLOAD, holds back only what depends on it (`dependsOnAny`: a reply quoting it, a control naming it); an attachment whose upload ENDED and whose MLS send fails holds its successors, like any message.
- **The ended upload makes its message due ONCE** (`sendDue`): the first send attempt skips the backoff the upload attempts left; a send that then fails (5xx, edge 403) takes the ladder like any message, and no later flush re-posts it early. Uploaded, the entry keeps lane order again.
- **A lane arms the backoff before it waits** for an upload: `runFlush` arms it only after its lanes return, so a text held on a 5xx behind a running upload would otherwise wait for the whole file. The ladder's timer raises a flush, which wakes the claimed lane.
- **Cancel** aborts a transfer on the wire AND one still waiting for an upload slot (the waiter leaves the queue at once); a withdrawal landing during the ref write, with nothing left to abort, is noticed when the task settles. The task forgets itself and clears the bubble. **Retry** aborts and restarts a transfer on the wire; on one still waiting for a slot it does nothing, so it keeps its place in line. **Crash survival** is unchanged: the ref reaches the row before the send is tried and the bytes leave it, and the task keeps the ref (without the bytes) for the send, so a failed row write costs a second upload only after a kill and the payload is decoded once per upload.

**ORDER, STATED.** Display order is `sentAt` (`compareMessageOrder`, on every device), and the media message carries its compose time. **A text sent after a file may reach the peers BEFORE it** (wire order), and every device - the sender's included - still draws the file ABOVE the text. Two attachments of one conversation may likewise be SENT in the order their uploads end; each still sorts at its own compose time. A reply or a control that names the attachment never overtakes it.

**Known limit.** After a reload, an attachment backing off on its upload is not known as such until it is due (the light queue read carries no payload), so it holds its successors for the rest of that backoff (60 s at most), once.

Pinned by `outbox.test.ts` ("outbox uploads run OUTSIDE the lane", WP-OFF-9): a text enqueued behind a 13 MB attachment whose upload is pending is sent before the upload ends (fails on the previous code), a reply quoting it waits, a cancel during the decoupled upload, a kill between the upload end and the send uploads nothing twice; and, after the review of #2061, a send failing after the upload keeps its ladder, a text held on a 5xx behind a running upload retries on its own ladder (fake timers), the 2-slot cap with a third attachment cancelled or retried while it waits, a dispose during an upload, a refusal brought back by the task, a withdrawal during the ref write. **Owed:** the same reading on a phone with a real file on a bad link (with the iPhone look of 13.4).

## 14. A transport failure is one type on every platform (2026-10-14)

**Measured on the Mi 9T, `v1.2.7-alpha.1`** (device-verification, "The Mi 9T readings of v1.2.7-alpha.1"): after an OFFLINE START, the `online` event's community listing failed and `[WORKSPACE-LOAD]` gave up `non-retryable`. For 2.5 min, online with the socket connected, the community rail was empty and every salon send or Retry was refused `listing-failed`, until the next foreground.

**Cause.** Tauri `plugin-http`'s `fetch` does not follow the `fetch` contract. It rejects with what its Rust side returned: a bare STRING (`error sending request for url (...)`) for a network failure, and `Error('Request cancelled')` for an abort. A string is not a `TypeError`, so `isRetryableLoadError` treated it as a final answer. The same string never reached `connectivity.notifyServerUnreachable`, so no reconnect was announced for it either.

**Fix, classified at the throw** (`utils/transportFailure.ts`):
- `conformPluginFetch` wraps the plugin at BOTH places it is handed to the app: `createRoutedFetch` (the `window.fetch` override) and `TauriMlsService`'s delivery client. An aborted request rejects with the signal's `reason` (`AbortError`). Every other rejection becomes `TransportFailureError`, a `TypeError` that keeps the raw rejection in `cause`. The plugin rejects only when no HTTP answer came back; an answered request resolves, whatever its status. Two limits, both open: the plugin's deterministic refusals (a URL outside the scope, an invalid header value) are typed as transport failures too, since a string cannot tell them apart; and a BODY read (`res.json()` after the head) that loses the link or is aborted still rejects with the plugin's bare string, because only the `fetch` call is conformed.
- `isTransportFailure` is THE predicate, and it is NARROW (2026-10-18): a `TransportFailureError` (which covers `DeliveryUnreachableError` and `UploadNetworkError`, both subclasses) or a `RequestDeadlineError`. A bare `TypeError` is NOT transport: a programming error (`cannot read properties of undefined`) inside a `try` around a request used to be retried or held as "no answer". The browser's rejection is typed where it is raised: `trackedFetch`, `conformPluginFetch` (any plugin rejection, a `TypeError` included), and `conformNativeFetch`, installed as `window.fetch` on the web (`hooks.client.ts`) and as the native branch of `createRoutedFetch` on Tauri, so every bare `fetch(...)` call is covered by one wrapper. An abort keeps the signal's reason. Limits: the engine's deterministic `TypeError` refusals (invalid URL, forbidden header) are typed as transport too (the sentence is in `cause`), and a body read cut by the link (`res.json()`) rejects with the engine's bare `TypeError`, which is not transport. It no longer matches words in the message. Its consumers: `connectivity` (`trackRequest.failed`), `auth.refresh`, the outbox's transport hold, `pendingGroupExits`, `media` complete, `publishFailure`, `isRetryableLoadError`, the salon reaction rollback, `salonOwed`, `messaging`, `postNotifStore`, `ReelsEntryButton`, `mlsDeliveryApi` and `BaseMlsService`.
- **The listing is restarted by the reconnect, not by the browser's `online` alone.** `ChatBackgroundService` calls `retryFailedListing` on `connectivity.onReconnect`, which fires on `online` AND when the server answers again after a transport failure, and on the foreground. **Bounded** (review of #1843): a reconnect is any answer after a transport failure, so an endpoint that fails while other calls answer would cycle for ever (give up -> unreachable -> a probe answers -> reconnect -> list again, ~every 11 s). A give-up earns ONE reconnect retry; the give-up of a reconnect's own listing earns none; and a reconnect that lands while the listing's own request is on the wire (it may be that request's answer) is owed nothing. The foreground is never budgeted: it always lists again and earns a new retry. A listing that gave up `unreachable` keeps held salon sends waiting ([chat](modules/chat.md#a-salon-not-yet-loaded-holds-the-send-it-does-not-refuse-it-2026-10-13)).
- **The banner says what is true.** `offline_banner_desc` used to promise "les nouveaux messages partiront dès le retour du réseau". That holds for DMs (outbox) and for a salon whose community is not loaded yet (held). It did not hold for a salon that IS loaded: its POST failed at once and the row was `unconfirmed`. The banner said so until WP-OFF-3 (section 16); it now says every message leaves on the reconnect and that a salon's photos, videos and polls wait for the connection. `chat_send_error_salon_listing_failed` now names the server, since only an answered failure reaches it.

Tests: `transportFailure.test.ts`, `fetchRouting.test.ts` (the bare string from the override), `salonSendGate.test.ts` (`unreachable` keeps waiting), `useChannelWorkspaces.svelte.test.ts` (the plugin's failure is retried; a listing that reached nobody holds sends and the reconnect releases them; a reconnect during a listing is owed; an answered failure still refuses; a persistently failing listing stops after one reconnect retry; a reconnect during the listing's own request is owed nothing), `TauriMlsService.conformedFetch.test.ts` (the delivery client's fetch is conformed), `reconnectListingWiring.test.ts` (source guard on the `onReconnect` wiring). **Owed:** the Mi 9T re-reading of the offline-start sequence.

## 15. An offline cold start sends nothing it knows will fail (2026-10-15)

**Measured on the Mi 9T, `v1.2.9-alpha.1`, airplane mode** ([device-verification](../device-verification.md), PR #1917; console in `<harness-dir>/a1-bench/r1015-a129/cons-feed.ndjson`): **70 warning/error lines in the first 6 s.** Grouped by emitter, each family and what was done:

| Family (lines) | Verdict | What changed |
| --- | --- | --- |
| `[A] refresh✗transport` (23) | upstream: one refresh per caller of `getToken`, each into a link the browser had already declared absent | ONE refresh per no-network spell (`connectivity.browserReportsNoNetwork()`, `navigator.onLine` false): the first is SENT and its outcome is the proof - an answer sets reachability and ends the spell (a STALE false, WebKitGTK behind a full-tunnel VPN or a WebView that missed `online` while suspended, therefore recovers on the first call); a transport failure is what every later caller of the spell is answered from, without a request, with ONE `[A]` log line. The reconnect (`online`, or any answered request) and the return to the foreground end the spell - events, no clock. Refusing on the flag alone (the first version of this PR) locked a signed-in user out on a stale false: no token, no request, nothing to answer (review of #1921). A refresh that leaves and gets no answer is re-typed `TransportFailureError` at the throw, and so is every `fetch` call's `TypeError` in `trackedFetch` |
| `[API] getToken failed ... proceeding without auth` (23) | upstream: the request was SENT, unauthenticated, into the same dead link | `apiFetch` never sends a request without a token: whatever `getToken` threw is rethrown as it came (`TransportFailureError`, `RefreshFailedError`, `SessionExpiredError`, `IdentitySplitError`). The old reason - "some routes answer without a token" - held for no route a signed-in client calls through it |
| `[PENDING] page did not arrive ... retrying with limit=N` (8) | upstream: a transport failure, and even the token failure (`auth()` sat inside the `try`), walked the halving ladder 250 -> 1 | the token is taken before the `try`, and a request nobody answered is rethrown at once. An answer that STARTED and whose body died (a cut read, a proxy timeout on a big page) is typed `BodyInterruptedError` at the throw (`progressDeadline.ts`, never a `TypeError`, on both platforms) and halves like a stall ([chat-delivery](../services/chat-delivery.md)) |
| `[DISPLAYNAME] profile fetch failed ... 120s with no retry` (6) | upstream: one accusation per user, a false "no retry" (the reconnect clears the backoff), counted into a rate meant for a REFUSING server | a failure of the transport TYPES (`TransportFailureError`, `RequestDeadlineError` - never `TypeError` at large, which a bug throws too) is said ONCE per spell, not counted as a failed lookup; the reconnect re-arms the line |
| `Fetch History Error`, `[History] batch ... could not be sent`, `[PENDING] Pending fetch failed`, `[MLS] revocation check unreachable`, `push_context write after init failed` (1 each) | expected and necessary: each names a consequence of no network | one line each, by class (`String(e)`), no stack; a non-transport failure keeps its stack and its `error` level |
| `[LAYOUT] Profile check` (2), `[postNotifStore]` (1) | expected, one line each | unchanged |
| `[Posts]`, `[FEED-STORE]` (1 each) | feed path | owned by `fix/feed-local-first-reading`, not touched here |

**Expected after: ~13 lines** - not yet re-read on the phone.

**The history ask at every launch (`[GRAINE] asked <self> (every device) ... no-seed-held`, 8 communities).** `requestCommunityHistory` fell back to asking OUR OWN devices whenever another device of ours sat on the key group, without reading their presence. The request is a transport frame, dropped for a device presence reports offline, so with the bench's only other device (W3) offline each launch sent eight sealed requests nobody could receive, plus their roster reads. Now that fallback needs one of our other devices ONLINE and in the key group's tree (`answeringDevicesOf`); otherwise one info line, filed against the distribution epoch for the session. A server older than 1.2.5 (no per-device presence) keeps the old reading. It is NOT parked until one of our devices comes online, unlike the other members: the presence waiter watches USERS and our own user is online by definition, so nothing re-asks in the same session ([backlog](../backlog.md)).

**Why it is NOT gated on durable state.** "Already asked" is the wrong fact to persist: an answerer holding nothing answers by SILENCE (`frameHandler`: an empty gathering returns before any bundle), so there is no answer to record, and a durable "asked at epoch E" would strand a community whose answerer missed the live frame (a backgrounded phone). What is left when our other device IS online is one request per community per launch, to that named device. Making it idempotent needs the answerer to SAY "I hold nothing" for a history ask - built as WP-HOLD-NOTHING: each device's answer is recorded for the key group's tree, the next member is asked, and once every device on the tree has answered the next start does not ask ([channel-encryption section 24](../protocols/channel-encryption.md#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18)).

**Open.** The push context written after the MLS init is not re-attempted when an offline start comes back online, so the native side keeps the previous launch's context until the next start. A delayed write must not overwrite a newer device key (a PIN change in between), so it was not added blind ([backlog](../backlog.md)).

Tests: `apiFetch.test.ts` (nothing sent on a transport failure or a refusal; one refresh per no-network spell, sent again after `online`; a stale-false `onLine` with a reachable server recovers), `mlsDeliveryApi.pending.test.ts` (no halving on a transport failure; halving on a body cut after the head, `TypeError` and bare string alike; one token ask), `displayName.transport.test.ts` (a plain `TypeError` still accuses), `repair.test.ts` (our offline devices are not asked; an online one is named). **Owed:** the Mi 9T re-reading of the offline cold start.

## 16. WP-OFF-3 and WP-OFF-4 built: a salon write waits for the link, and a repeat is one row (2026-10-17)

**The server answers a repeated send with the row it holds** (social-service migration 090). `channel_messages."clientMessageId"` is the client UUID already sealed inside the ciphertext, sent beside it as `messageId`, under a partial unique index on `(authorId, channelId, clientMessageId)`. A repeat - a lost answer retried, a page life resuming - writes, publishes and pushes nothing. Two racing repeats meet the index and the loser is answered with the winner's row. The column is `select: false, update: false` because the deploy starts the services BEFORE it runs the migrations, so history and pins keep working in that window. **Every salon INSERT fails in it** - TypeORM lists each insertable column in every INSERT, `DEFAULT` for an absent value, so a send with no client id, an edit, a reaction and a system notice fail exactly like a send carrying one: whole, storing nothing, for the seconds between the services starting and 090 running. This page said until 2026-10-18 that only a write carrying a client id named the column; the integration spec now pins the opposite ([social-service](../services/social-service.md)).

**A deleted message leaves its client id behind** (`channel_message_client_tombstones`, the same migration). A delete drops the row, so without it a repeat arriving after the delete - its first answer lost, the app killed, a moderator removing it meanwhile - found nothing and posted it again: a moderation removal undone unasked. The tombstone and the delete commit together, and a repeat that meets it is refused `410 CHANNEL_MESSAGE_DELETED`, and the client forgets the send and removes its row (`SalonEchoChange` `gone`). Both sides take one advisory lock on the client id (`clientIdLockSql`): the send checks the tombstone and inserts under it, so a delete can never fall between the two (review of #2005). It goes with its salon (`ON DELETE CASCADE`), with its author's account erasure, and **30 days after the delete** (decision 2026-10-18, `channel-retention.scheduler.ts`): a device closed longer than that, holding a send its message's delete overtook, would post it again on its next start - the residual the user accepted. A delete locks the message row before the advisory lock, so one racing an erasure waits for it and leaves no tombstone of the erased author (follow-up of #2005, `channel-message-client-id.integration.spec.ts`). Only a message delete writes one: the retention GC drops rows far older than any repeat, and an account erasure deletes the author's tombstones with its messages. In the deploy window a delete fails whole too, like a send.

**A repeat nobody asked for waits for the server to prove it safe** (`salonRepeatProof.ts`, review of #2005). Production deploys only once both stores serve the client, so a store build meets a server WITHOUT 090 for days, and that server posts a repeat twice. Since 090 a send's answer echoes the `clientMessageId` it was posted under; the first answer that does proves it for the page life - no clock, no probe. Until then a send that may have landed is never repeated unasked: a POST lost as the link went down, and an entry a past page life left, are drawn `unconfirmed` with their Retry, and go on their own the moment an answer proves it. A send HELD offline before any POST is not gated: nothing of it can have landed. A Retry is the author's gesture and goes regardless.

**What differs from section 6.4's design, deliberately.** Nothing sealed is persisted: each attempt seals afresh under the CURRENT session, so a roster change between two attempts costs nothing, and the server's client id is what makes the second attempt the same message. The durable half is the existing unsent ledger (`salonUnsent.ts`, localStorage per user, one Web Lock per page life), which now carries `sentAt` and the quote, never an IndexedDB `channel` kind.

**The send** (`messaging.ts`, `queueSalonSend` / `deliverSalonSend`):
- Offline (`connectivity.isOffline`), the echo row is `pending` and no POST leaves. The reconnect (`connectivity.onReconnect`) delivers it under the same id - an event, never a clock.
- A POST that fails on the transport AND leaves the device offline is owed the same way - once a repeat is proven safe (above); before, it is `unconfirmed`. Any other answerless failure, or a 5xx, is `unconfirmed`, and Retry is now offered on it. A 4xx and a seal that cannot be made are `error`, as before.
- A page life killed with a send owed: the next session-up resumes every entry whose writer is PROVEN dead (its Web Lock is free) under the same id, `sentAt` and quote - sent at once when a repeat is proven safe, else drawn `unconfirmed` until it is. Resumes are serialised and a resuming id counts as live, so two resumes never send twice. A resume whose session ends while it waits on its salon's gate leaves the entry in that account's ledger: the next account's session never seals it. An entry written before this change has no `sentAt` and goes back to the composer, as WP-OFF-1 did.

**Edit, reaction, pin, vote** (`salonOwed.ts`) are optimistic. Offline, or when a failure took the link down, each is OWED to the reconnect, latest-wins per key (`edit:<id>`, `reaction:<id>:<emoji>`, `pin:<id>`, `vote:<id>`). It is rolled back only when nothing of it left the device (`nothingLeftTheDevice`: a seal unavailable or a 4xx). NEVER on a 5xx, which a proxy may return after the write was stored, and never on a transport failure with the link up (a deadline, a lost reply): that outcome is unknown exactly as it is for a send, and a reaction rolled back at a later instant would beat this device's own frame and disagree with every peer for good (review of #2005). An edit and a reaction now send their frame id as the server `messageId` too, so their repeat is one row. Owed control writes are kept in MEMORY only: a pin or vote replayed in a later life would override what the community did since. **The read mark** was already durable (`salonReadMarkQueue.ts`) and needed nothing.

**Residual: a Retry against a server without 090.** The author's Retry of an `unconfirmed` row is not gated, so in the stores-before-server window it can duplicate, as any retry did before; every repeat nobody asked for waits for the proof. An edit or reaction repeated there writes a second silent row that every reader merges to the same state.

**Not queued:** a salon photo, video or poll. They still need the link, and the banner says so.

Tests: `channel.service.spec.ts` and `channel-message-client-id.integration.spec.ts` (a repeat is the stored row, one broadcast and one push, its answer echoing the client id; a repeat of a deleted message is a 410 and writes nothing; two racing repeats leave one row; another author's same id is another row; history and pin work with the column dropped - the deploy window, proven failing without `select: false`), `useMessaging.salonQueue.svelte.test.ts` (including the repeat proof, the session ending during a resume, and the 410), `channelCrypto.test.ts` (the proof read from the answer), `useChannelWorkspaces.offlineWrites.svelte.test.ts`, `salonOwed.test.ts`, `MessageMetadata.retry.svelte.test.ts`. **Owed on the Mi 9T and the iPhone 12:** a salon send in airplane mode then the reconnect; a kill with a send owed, then the relaunch; an offline edit, reaction, pin and vote; and the harness row (an offline salon send delivered on reconnect), not run.

## 17. A text the server keeps failing becomes FAILED, with a Retry (user, 2026-10-18)

**Decision (user, 2026-10-18).** A text or reply whose send is answered with a 5xx `MAX_CONSECUTIVE_SERVER_ERRORS` (5, `outbox.ts`) times IN A ROW stops climbing the ladder and is shown failed ("Echec" + "Reessayer", the existing `msg_echec` / `common_retry_button` strings; no new key). A transport failure (nobody answered) keeps retrying as before and never counts.

- **The hold after a counted 5xx is the ladder's top step at least** (`serverErrorHoldMs`: `max(backoffFor, SERVER_ERROR_HOLD_MS = 60 s, Retry-After capped at MAX_RETRY_AFTER_MS = 10 min)`), so five in a row span at least four minutes (0, 60, 120, 180, 240 s). On the plain ladder they landed at about 0, 2, 7, 22, 52 s, and a container restart longer than that (the edge answers 502 meanwhile) failed every text sent during a deploy (review of #2076). Still the entry's own clock, no deadline timer. `Retry-After` is read at the throw (`parseRetryAfterMs`, seconds or an HTTP date).

- **Classified at the throw.** `postApplicationMessage` raises `SendServerError` (an `ApiRefusalError` carrying `status` and `origin`, gateway or edge) for any 5xx, whoever wrote it - a status is an answer. Every other non-ok status is now an `ApiRefusalError` too, where it used to be an untyped `Error` with the status spelt into the message.
- **Durable count.** `OutboxEntry.serverErrors` is a clear column (`server_errors`, SQLite migration v14; a field on the IndexedDB row), written with the backoff. Any other ANSWER (`isSendAnswer`: a status-carrying refusal, `sender_not_active`, an edge refusal, a 410) resets it to 0; a success deletes the row; a transport failure or a local error leaves it as it is. A reload keeps the run; a reload of a failed text shows it failed again (`applyPendingStatuses`) and sends nothing (`flushOne` reads `isServerFailureTerminal` from the row).
- **Terminal = parked.** The entry is KEPT; outcome `parked`, so the LATER INDEPENDENT texts of the conversation go past it (wire order changes, display order is still `sentAt`) and a reply quoting it - or a control naming it - waits for it (`dependsOnAny`), as for a parked attachment. Status `error`, and an upload view `failed` on the text - the one sign the bubble reads (`MessageBubble`'s `queuedTextFailed`) to offer the Retry through the existing `retryUpload` handler. The native background mirror leaves it out (`toMirrorEntry`), so the background sender does not send what the bubble calls failed.
- **Retry is decided on the STORED row** (`resetServerFailure`), never on the tab's memory: a FOLLOWER tab never saw the failure in memory, and its Retry used to fall through to a flush in which the leader re-read a count of 5 and parked the text again (review of #2076). It writes the count AND `nextAttemptAt` back to 0 BEFORE raising the flush, so whichever tab drains reads a due, unfailed text; the next 5xx starts a new run. Safe on an unknown outcome: a 502 may come after the frame was stored, and receivers deduplicate on the message id.
- **Deleting a text answered 5xx is not a silent withdrawal.** `withdraw` answers `withdrawn: false` for an entry with `serverErrors > 0` (the row still goes), so `deleteMessage` also sends the `delete_message` event: a gateway may have stored the frame, and a peer that has it drops it. A text never answered 5xx is withdrawn silently as before. No copy change was needed: the behaviour is what the member asked for either way.
- **Not covered, on purpose:** attachments (their send after the upload, and the upload itself, keep 13.5/13.6), and control entries (reactions, edits, deletes, pins, read marks) - they stay on the uncounted ladder.
- **Other tabs.** The leader publishes `outbox_entry_failed` once per parked text (`tabMessageSync.ts`), and a follower draws the same failed bubble from it; `outbox_entry_sent` clears that view. A follower opened later reads it from its own `applyPendingStatuses`.

Tests: `outbox.test.ts` ("a text the server keeps failing (5xx)" and "review of #2076": the hold values and Retry-After cap, the clock written, a follower's Retry then the leader's send with TWO controllers, the cross-tab failed event, the delete of a 5xx'd text travelling, the ordering; 5 x 5xx terminal; 4 x 5xx then a success; a 4xx resets the run; transport never counts nor resets; a reload keeps the count; a reload of a failed text sends nothing; the retry resets durably and the next 5xx is 1; 4xx and 403 keep their paths; a control and an attachment stay uncounted), `mlsDeliveryApi.forbidden.test.ts` (the typed 5xx, both origins), `outboxClearPatch.test.ts` and `outboxIdbPatch.test.ts` (the column in place, across a re-open), `sqliteMigrations.test.ts` (v14 on a real in-memory SQLite: queued rows read 0, a rerun and a fresh database are no-ops). **Owed:** one reading on a phone against a dev estate answering 503.

## 18. WP-W4, first part: the account-level reads of a boot are shared while in flight (2026-10-18)

`MlsDeliveryApi.joinInFlight` already shared `groups/:id`, `user-members` and `exclusions` (#1806 era). `fetchUserDevices(userId)` (`devices/<id>`, three callers per boot: the pending-invitation sweep, the welcome-request answer, the group reconcile) and `getUserGroups(userId)` (`users/<id>/groups`: conversation load, sweep, reconcile) now join it too, keyed per account. The entry lives exactly as long as the request: no clock, a caller arriving after the answer asks again, a failure rejects every joiner and is not remembered. Test: `mlsDeliveryApi.inFlight.test.ts` (one request for simultaneous askers, accounts kept apart, a failed read not remembered).

**`POST /api/mls/register-device` on every cold start stays, on purpose.** The handler is not only a registration: it rewrites `createdAt`, which is THIS DEVICE'S LIVENESS CLOCK (`getUserDevices` drops a row older than 30 days, and the clock must be written by the thing whose liveness it measures); it replaces the last-resort package and its `notAfter` (the recovery from an elapsed package); it refreshes `deviceAppVersion`; and it re-creates the `pending` membership in every group the account is in. A durable "last registered" record would starve all four, so conditioning it needs a separate, cheaper heartbeat first - not built.

**Not done, and why.** `unread-counts` x2 is closed in [section 19](#19-wp-w4-second-part-unread-counts-is-one-request-per-boot-ordered-after-the-read-mark-flush-2026-10-19). Avatars that 404: already answered by `avatar-presence` (one batched call, `avatarPresence.ts`). The second `history-request` of the Mi 9T is one per group by construction; whether two went to the SAME group needs a recorded boot. Still open: the per-community triplet in one call and ETag/304.

## 19. WP-W4, second part: `unread-counts` is one request per boot, ordered after the read-mark flush (2026-10-19)

The community load and the live stream coming back both call `reconcileSalonUnreadFromServer` (`utils/chat/salonUnread.ts`), and a cold start sent `GET /api/channels/unread-counts` twice. A bare join was refused in section 18 because each caller settles its owed read marks BEFORE it asks: a count already on the wire was computed before the caller's own marks reached the server and would re-raise a badge just cleared.

The ordering is the join condition. Each caller still runs its own `settleOwedMarks` first (it now returns how many marks the server took). A caller whose flush delivered NOTHING joins the request in flight (`countsInFlight`, one entry keyed by the session generation); a caller whose flush delivered marks, or failed, sends its own, because the request on the wire predates them. **A second condition closes the interleaving where ANOTHER caller delivered the mark**: `salonMarksDeliveredCount()` (`salonReadMarkQueue.ts`) ticks the instant each salon mark is taken, the request records it when it starts, and a joiner joins only if it is unchanged - otherwise a caller owing nothing (A's flush already emptied the queue) would apply counts that predate A's mark and re-raise the badge A cleared. The reconcile token only orders against salon OPENINGS and level changes, so it never protected this. Each joiner keeps its own try/catch, so a failed shared request is reported once per caller, under its own reason. The entry lives exactly as long as the request - no clock, a failure rejects every joiner and is not remembered, and `resetSalonUnread` (session end) drops it so an answer asked for one account is never handed to the next. Each joiner applies the shared answer to its own state with its own tick.

**The recorded-boot counting test**: `mls-client/bootRequestCount.test.ts` runs the boot's concurrent callers (three `devices/<id>` askers, the community load and the live-stream reconnect) through ONE recording `fetch` released by hand - no sleep, no clock - and asserts exactly one `unread-counts` and one `devices` request. Before the change it counted 2 `unread-counts`. Unit cases in `salonUnread.test.ts`: join when nothing was owed, no join after a delivered mark, failure not remembered, no hand-over across a session end.

## 20. A catch-up that gets no answer stops, and the mailbox is owed to the reconnect (2026-10-30)

**Measured on production, `1.5.1`, the owner's Pixel** (no personal data): at a cold start, a network loss and a return from the background, the history catch-up fanned out into a link the client already knew was gone (`[A] refresh not sent: the browser reports no network`). `[History] batch of 50/50/25 got no answer - each replays its own page`, then `[CATCHUP] 0/125 primed`, then ONE per-group history read and ONE full mailbox pull per conversation, 125 + 125 in one second: **327 `[PENDING] Pending fetch got no answer`, 306 `[HISTORY] no answer for group`**. Two mechanisms multiplied each other:

- **The batch read a transport failure as a refusal.** A chunk that got no answer left its groups out of the map, exactly as a refused chunk does, so each group's replay read its own first page from the same unreachable server.
- **Every replay took the mailbox barrier, and the barrier pulled.** A failed pull leaves `mailboxEmptiedByAPull` false and nothing in flight, so `settleBarrier` read "nobody has pulled" on every one of them.

**Fix, classified at the throw:**
- `MlsDeliveryApi.fetchHistoryBatch` rethrows a transport failure as it came (`isTransportFailure`) and sends no further chunk; a refused chunk is still logged and left out, and its groups still read their own page (an ANSWER about those groups).
- `loadExistingConversations` (`utils/chat/conversations.ts`) stops on the first transport failure of the pass - the group list's, which also means the batch is never sent, then the batch's - **only while the link is KNOWN down** (`connectivity.isOffline`). It then **skips every archive replay** of the pass with ONE line, `[CATCHUP] the server got no answer - the archive replay of N conversation(s) is skipped this pass`. The local half (stored page, DM repair) still runs. A transport failure on a link NOT known down (one deadline on a slow but working link) keeps the per-group path, with one `warn`: skipping on it would be a regression.
- **The skipped archives are replayed on the NEXT RECONNECT, once** (`useConversations`, `oweArchiveReplays`). The restore runs only at boot and on a Welcome, so without this a skipped archive waited for the conversation's next open: days on a phone, against a mailbox that keeps 14. The ids go to one `connectivity.onReconnect` listener per session generation; an edge that comes while `isOffline` still holds (an `online` event before the server answered) leaves it armed. It replays each through `loadHistoryForConversation`, serialised, with ONE line (`[CATCHUP] link back - replaying N archive(s) skipped while it was down`). Idempotent by the durable stream cursor (an archive replayed meanwhile costs a `limit=1` probe). A sign-out drops it. The queued frames themselves come with the reconnect's pull (`initializeConnection` pulls after every connect).
- **The barrier holds its pull while the link is KNOWN down** (`BaseMlsService.settleBarrier`): socket closed AND `connectivity.isOffline`. Said once per spell (`[PENDING] mailbox barrier: no pull while the link is down`).
- **Both delivery routes now keep the connectivity store true, in BOTH directions.** The pull and the history batch read the raw fetch, which reaches no `trackedFetch`: each calls `notifyServerUnreachable` on a `TransportFailureError` and `notifyServerReachable` on the GATEWAY'S answer, whatever its status. WHO ANSWERED comes first: the batch reads `responseOrigin(res) === 'gateway'`, and the pull reads the `origin` that `ProgressDeadlineResult` now carries on a non-2xx (its 2xx reader throws `NotFromApiError` on a page that is not the API's). So an edge page - a captive portal's `511` or 2xx HTML, a WAF's HTML `403` - does not clear `isOffline`. A NON-2xx edge page does not SET it either: it is the edge's answer, typed as one everywhere else (`SendEdgeRefusedError`, the origin a `SendServerError` carries), and `trackedFetch` - the reachability probe included - counts any HTTP answer as reachable, so marking the server down on it would only be undone by the next probe answered by the same edge. Only a 2xx edge page is a transport failure (`NotFromApiError`), because only that one could be misread as data. A pull page refused by either party is now logged once (`[PENDING] page answered N by the gateway|edge - the pull stops here`); it used to stop silently. A one-way flag would have stayed set after a long outage - the barrier holding, the outbox refusing, a real gateway fault demoted. A `RequestDeadlineError` (a token refresh's, say) does NOT mark the server unreachable: `trackedFetch` already counts those towards `STALLS_BEFORE_UNREACHABLE`, and one expiry is a slow moment. An ANSWERED failure (a 5xx) leaves the link up and the next barrier pulls as before.

**Expected after, on the same sequence:** one `[CATCHUP] the server got no answer` line and one `[PENDING] ... got no answer` per pull actually made, instead of ~630 lines. **Owed:** that reading on the phone.

**A link that drops again during the owed replay re-owes what is left**: each id is checked against `connectivity.isOffline` before its read, and the remainder goes back to `oweArchiveReplays` for the next answered reconnect, with ONE line (`[CATCHUP] the link dropped again - N archive replay(s) owed to the next reconnect`). A load that throws (its fast path - the stream cursor read from `localStorage`, the stored page - runs outside the replay's own catch) is logged and the loop goes on.

**Residual, accepted:** the archive whose read was IN FLIGHT when the link dropped is not owed again - `fetchHistory` returns an empty page on no answer, so the replay cannot tell that case apart without a type of its own; it waits for the conversation's next open, or the next restore (boot, Welcome). And the restore pass does not stop MID-LOOP: once the batch answered, a per-group read that later gets no answer still costs its own request (and its barrier, which then holds).

**Transport failures logged as errors, in the same capture, each now one line by class:** `[SYNC] Failed to fetch user groups` was printed twice (`log` and `console.error`) - a transport failure is one `[SYNC] the user group list got no answer` line (`groupSweep.ts`); `[WS] Gateway connection failed` on a DNS failure was printed twice, once at ERROR - while the link is known down (a transport failure, or `connectivity.isOffline`) it is one `[WS] Gateway connection failed - the link is down` line at log level, because the socket's own rejection cannot say why (a browser hides it, the native plugin hands over a sentence); `[GRAINE] handler refused a frame` on `DeliveryUnreachableError` is a `warn` saying the next pull redelivers it; `[media-seg] stream ... stopped` is gone (the consumer logs `done`'s rejection) and `media not shown (unreachable)` is a `warn` naming the Retry (`logMediaFailure`). And `[A] token→refresh`, 653 lines for 51 refreshes sent, is gone: the reason rides the `refresh→` line of the request that leaves.

Tests: `mlsDeliveryApi.history.test.ts` (a transport failure is rethrown, no further chunk; a portal's 2xx HTML leaves `isOffline` set, the gateway's 503 clears it), `restoreUnreachable.test.ts` (no replay after a batch or group-list transport failure on a link known down, one line, the ids handed on; a refused chunk, or a batch deadline on a link not known down, keeps the per-group replay), `useConversations.restoreOnce.svelte.test.ts` (the skipped archives replayed at the first answered reconnect, once; the rest re-owed when the link drops mid-replay and replayed at the next; a throwing load logged and the next id still replayed; dropped by a sign-out), `mlsDeliveryApi.pending.test.ts` (a gateway page, even a 503, clears `isOffline`; a portal's HTML 511 and a WAF's HTML 403 leave the store as it was, either way), `progressDeadline.test.ts` (a non-2xx carries its origin), `BaseMlsService.mailboxBarrier.test.ts` (one pull into a dead link, the barrier held and said once, a pull again after an answered request, a deadline does not mark the server unreachable, an answered failure still re-pulls), `startGatewayHandshake.test.ts`, `groupSweep.test.ts`, `initializeConnection.test.ts`, `BaseMlsService.distributionGroup.test.ts`, `mediaErrors.test.ts`, `auth.test.ts` (five callers, one `refresh→` line). Items of the same capture NOT fixed here are in [backlog](../backlog.d/the-1-5-1-pixel-log-what-the-catch-up-fix-left-2026-10-30.md).

## 21. No probe while the app is off screen, and a stall count that stops at its limit (2026-10-31)

Read in the owner's Android `1.5.3` log of nine calls: reachability probes (`[CONNECTIVITY] reachability probe got no answer`) kept leaving after the app paused, and the deadline line read `(stall 3/2)`, `(stall 4/2)`.

- **A paused app's requests are the OS's to starve**, so a probe sent then measures the pause, not the link. **On the native mobile runtimes only** (`setProbePausesOffScreen(isMobileTauriRuntime())`, set by `installReachabilityProbe`): a web or desktop tab in the background is not paused by its OS, keeps its network, and keeps probing exactly as before. There, `probeUntilReachable` checks `isAppOnScreen()` (`utils/appForeground.ts`, the one question that tells the truth on Android) before each attempt and after each pause; off screen it stops, says so once (`[CONNECTIVITY] app off screen - probing after <reason> stops until it is back on screen`) and records `probeOwedOnScreen`. The return to the screen (`onAppScreenChange`) starts a fresh resume (`PROBE_DELAYS_AFTER_ONLINE_MS`, reason `app back on screen`) only if the server is still not known reachable. Durable state settled by an event, never a timer. **Accepted cost:** a send from a system surface while the app is off screen (a notification reply) meets the same `isOffline` it met before, until any request answers or the app comes back.
- **The count leads to ONE verdict.** Once `notifyServerUnreachable` holds, a further deadline is not a step towards it: it is said as `(server already unreachable)` and not counted. The count restarts at 0 whenever the server is back, by whichever answer (`notifyServerReachable` resets it, not only `trackRequest().answered`), so a server restored by a socket is not marked down again by ONE stall.

Tests: `connectivity.test.ts` (five stalls read `1/2`, `2/2`, then three `server already unreachable`, never `3/2`; a fresh count of two after a reachable answer outside `trackRequest`; on a phone no probe while off screen, a fresh one at the return; a hidden web tab probes on; a resume already probing stops when the app leaves the screen, and owes nothing once the server answered meanwhile).
