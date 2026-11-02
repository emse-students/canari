# Opening a community: what it waits on, measured, and the budget - 2026-10-14

The goal (user, 2026-10-14, `v1.2.7` in production): **on a slow network and a poor phone, opening a
community - the rail, its salon list, a salon's first messages - is almost instantaneous.** This
page is the measurement that goal starts from: a reproducible protocol, the numbers per condition,
what each open waits on (backed by the trace), a budget, and the smallest set of fixes the evidence
proves. It reuses the method of
[the 2026-10-13 reading](community-open-slowness-mi9t-2026-10-13.md) (CDP on the WebView socket,
logcat beside it) and does not re-derive what that page, the
[performance audit](performance-audit-2026-10-12.md) or [local-first-ui](local-first-ui.md)
established.

**Nothing here is a fix.** The only code that changed is the instrument (and one defect in it).

## 1. Protocol

**Bench:** Mi 9T, `fr.emse.canari` `1.2.7 (100200703)` = the `v1.2.7-alpha.3` release APK (the
same code as the `v1.2.7` stable, built for dev), `dev.canari-emse.fr`, bench account `fourth`
("Canari Test Delta") on the vault path ("Rester connecte": no PIN on a cold start). Two bench
shapes: **small** = the account's two communities (`Bench126` with `général`, 56 rows / a 39 kB
server page; `Bench127` with one salon whose 6 rows are unreadable here), and **big** = the
ten-community bench (section 5).

**Instrument:** [`tools/cold-start/community-open.mjs`](../../../tools/cold-start/community-open.mjs),
its report [`community-open-report.mjs`](../../../tools/cold-start/community-open-report.mjs) and
the bench seed [`community-bench-seed.mjs`](../../../tools/cold-start/community-bench-seed.mjs)
([README](../../../tools/cold-start/README.md#opening-a-community---community-openmjs)). One run is
the gesture a member makes, every mark taken IN THE PAGE in the `requestAnimationFrame` where its
condition first held (so a blocked main thread delays the mark exactly as it delays the paint):

1. cold: `am force-stop`, `am start`; warm: Feed tab, HOME, 10 s, `am start` (a resume);
2. tap "Communautes" (a CDP touch) **as soon as the bottom nav is on screen** - the impatient member;
3. `rail` = one community button visible; `salons` = one `data-channel-row` visible;
4. tap the target community if the hub shows another one; `target salons` = its rows visible;
5. tap its first salon: `pane` = the composer visible; `msgs` = one `msg-*` bubble visible;
6. back, tap ANOTHER community (`switch`), open its first salon (pane only);
7. back, the target again, the same salon again (`reopen`: a salon already opened in this process).

Recorded per run: every first-party API call (path, start, response head, end, bytes), the
WebView's requests (assets and `ipc.localhost`), long tasks, 50 ms heartbeat gaps, the app's console
and the app's logcat. Median and worst of N per condition; durations are ms from the tap that asked.

**What the conditions are, exactly.**

| condition | how | blind to |
| --- | --- | --- |
| `none` | the bench Wi-Fi (dev RTT ~150-250 ms per small call) | - |
| `slow3g` | `window.fetch` wrapped in the page: every first-party API response handed back `400 ms + bytes / 50 kB/s` LATER than it arrived | the MLS delivery client (`TauriMlsService`'s own `plugin-http`), the WebSocket, `<img>` avatars, and the first ~350 ms before the attach |
| `airplane` | `svc wifi disable` + `svc data disable` before the launch, restored after | - |
| `cpu4`, `cpu6` | CDP `Emulation.setCPUThrottlingRate` on the WebView renderer | native code (MLS, `plugin-http`), so a slow phone is UNDER-stated |
| `cold` / `warm` | process killed / backgrounded 10 s | - |

**Why not CDP's network emulation**, which was the first plan and is wrong on this app: on Tauri
Android `hooks.client.ts` routes every first-party `/api` call through `plugin-http` (reqwest, in
Rust), so the WebView's own stack carries only the bundled assets and the IPC
(`http://ipc.localhost/plugin:__TAURI_CHANNEL__|fetch`). `Network.emulateNetworkConditions` would
have delayed every IPC read and every local chunk and left the API untouched. The shaping TCP proxy
of [local-first-ui section 5](local-first-ui.md#5-the-tools-and-where-they-live) covers everything
but needs the local estate; the shim is the dev-estate approximation, and it ADDS to the real link.

## 2. The numbers - small bench

Median / worst, ms. `tap>` columns count from the tap on "Communautes"; `salon>` from the tap on
the salon row; `nav` is from process start (`performance.timeOrigin`).

| condition | n | nav | tap>rail | tap>salons | tap>target salons | salon>pane | salon>msgs | switch>salons | reopen>msgs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold, Wi-Fi | 7 | 1147 / 1214 | 907 / 1035 | 1500 / 1697 | 1700 / 1929 | 267 / 282 | **1907 / 1971** | 147 / 164 | 564 / 658 |
| cold, slow3g | 5 | 1116 / 1173 | 1437 / 1608 | 3327 / 3471 | **3543 / 3710** | 274 / 297 | 2830 / 3502 | 147 / 171 | 593 / 648 |
| cold, cpu4 | 5 | 3131 / 3478 | 2751 / 2929 | 3859 / 4358 | 4326 / 4721 | 768 / 838 | 6392 / 6614 | 198 / 207 | 1932 / 2113 |
| cold, cpu6 | 5 | 4550 / 5223 | 4070 / 4240 | 5658 / 5865 | 6165 / 6487 | 1120 / 1215 | **9881 / 10360** | 237 / 241 | 2846 / 3127 |
| cold, slow3g + cpu4 | 5 | 3312 / 3500 | 3252 / 3336 | 5478 / 5617 | **5982 / 6073** | 766 / 801 | **6245 / 6481** | 197 / 211 | 1851 / 1910 |
| warm, Wi-Fi | 5 | - | 326 / 343 | 426 / 448 | 607 / 639 | 500 / 609 | 593 / 2558 * | 137 / 149 | 564 / 593 |
| warm, slow3g + cpu4 | 5 | - | 2031 / 2283 | 2381 / 2507 | 2977 / 3027 | 1815 / 1881 | 1962 / 9019 * | 276 / 343 | 1867 / 2179 |
| cold, airplane | 3 | 1117 / 1178 | **never** | **never** | **never** | - | - | - | - |

\* the worst is run 1, the first open of that salon in the process (a network fetch); runs 2-5 are
the salon already held in memory.

**Read as a member:** on the bench Wi-Fi, a cold app shows its salons 1.7 s after the tap and a
salon's messages 1.9 s after the next one - **~3.6 s of waiting for two taps**. With a slow link
and a 4x slower renderer it is **~12 s**. Offline the communities never appear at all. The only
open that is already fast is the switch between two communities of a loaded process (~150 ms).

The Pixel 6a reading the user took on production `1.2.7` the same day (observation only, the
user's own phone and gestures) agrees on the shape: Communities tab under 0.4 s and a salon's
content at ~0.6 s on Wi-Fi, ~0.9 s on LTE (salon skeleton ~0.3 s then content on Wi-Fi; tab ~0.17 s, skeleton ~0.7 s on
LTE); **airplane mode: no community at
all ("Selectionner ou creer une communaute") and "Impossible de charger les posts"** - the
community list is not local-first. Its exported log also shows 79 MLS checkpoints in ~3 min at
94-238 ms each (135 in the whole file, median 114 ms, max 586) - one per bulk ingest, read
watermarks included - and 45 identical `[HISTORY_RECONCILE] ... asked 30s ago` lines in 250 ms at
cold start (section 6). Evidence: `<workstation>/canari-harness\pixel-r1014\` (off the
repository: a real account).

## 3. What each open waits on - the critical chains

From `community-open-report.mjs` (medians, ms, cold). "at" = ms after process start.

| link | Wi-Fi | slow3g | cpu4 | cpu6 | slow3g + cpu4 |
| --- | --- | --- | --- | --- | --- |
| session (`[A] refresh✓`) at | 1269 | 1434 | 3412 | 5086 | 4041 |
| `[INIT] MLS ready` at | 1918 | 1983 | 5284 | 8542 | 5786 |
| listing `GET /channels/workspaces/user/me` sent at | 1990 | 2061 | 5733 | 9231 | 6200 |
| listing round trip | 245 | 727 | 429 | 620 | 814 |
| rail drawn after the listing answers | 38 | 40 | 140 | 196 | 121 |
| key-group links (`distribution-group` then `members`) before the salons call | 466 | 1326 | 959 | 1253 | 1766 |
| salons call `GET /channels/workspace/<id>/user/me` | 164 | 594 | 327 | 420 | 639 |
| history request sent, after the salon tap | 323 | 294 | 1120 | 1665 | 1094 |
| history `GET /channels/<id>/messages?limit=200` (39 kB) | 808 | 1781 | 2526 | 3973 | 2324 |
| decode + render after the history arrives | 756 | 742 | 2730 | 4298 | 2830 |

One Wi-Fi run, read end to end (`--chain cold-none-cpu1 3`), is the whole story in order: refresh
POST at 655 ms answered at 1413 (the first request of the process pays the TLS handshake); vault
restore 1206; `Initialising MLS` 1585; `MLS ready` 1967; listing 2043 -> 2269; **rail 2308**;
`distribution-group` x2 2295 -> 2623; `members` x2 2634 -> 2812; `[GRAINE] community ... agrees with
its roster`; salons call 2775 -> 2913; **salons 2928**; `[WORKSPACE-LOAD] communities/channels loaded`
2972. Salon tap 3248; a 107 ms long task; `members` + `pins` 3492; **pane 3528**; history 3564 ->
4390; a 366 ms long task at 4764; **messages 5137**.

### The blockers, ranked by what they cost the member

Every one is on the path from a tap to pixels; everything else the trace shows (unread counts,
presence, avatars, the feed, push registration, the history reconcile, checkpoints) runs BESIDE
these and was measured not to gate a mark.

1. **There is no local workspace list: the rail and the salon rows are a network answer.**
   `channelWorkspaces` is filled only by `executeWorkspaceLoadAttempt`
   (`composables/useChannelWorkspaces.svelte.ts:323`), which starts on `globalSession.isLoggedIn`
   (`components/layout/ChatBackgroundService.svelte:1171`). Airplane: the rail never appears (3/3
   Mi 9T, and the Pixel on production). Cold Wi-Fi: rail = MLS ready + one listing round trip
   (2.3 s after process start); with a slow link and a slow CPU, `tap>target salons` 6.0 s. **This
   is the one that decides "almost instantaneous"**: every other fix below shortens a network
   chain that should not be on the path at all.
2. **The listing waits for MLS initialisation it does not need.** `isLoggedIn` flips "as soon as
   the PIN is validated and MLS is initialised" (`composables/session/sessionTypes.ts:128`), so the
   listing - a REST call that needs only the access token - leaves 650 ms (Wi-Fi), 1.9 s (cpu4),
   3.5 s (cpu6) after the token is there. The per-community key-group step that DOES need MLS
   already awaits `ctx.ensureMls()` inside its own chain (`useChannelWorkspaces.svelte.ts:421`).
3. **Every community's salon rows wait for its key-group check.** `loadCommunitySalons` awaits
   `ensureCommunityDistributionGroup` (`distribution-group`, then `members`, then the roster
   comparison) BEFORE `listChannels` (`useChannelWorkspaces.svelte.ts:421-428`): two serial round
   trips, 466 ms on Wi-Fi, 1.3 s on slow3g, 1.8 s on slow3g + cpu4, between the rail and the salons.
   The reason given in the code (register the key group before a seed frame arrives) is about
   RECEIVING, not about drawing rows.
4. **A salon's history is network-only, and its local rows are deleted before the fetch.**
   `loadChannelHistory` (`composables/useConversations.svelte.ts:565`, "from the server ... into
   memory only - never IndexedDB") calls `deleteMessagesForConversation` then
   `listMessages(rawId, 200)` on every first open in a process - [local-first-ui ledger row 9](local-first-ui.md#4-the-ledger---what-is-fixed-what-is-not),
   open since 2026-09-23, now measured: **1.9 s (Wi-Fi), 6.4 s (cpu4), 9.9 s (cpu6) from the tap to
   the first bubble, and offline an empty salon.** Inside it, three costs in series:
   - the request leaves only once the pane is mounted - 323 ms after the tap (1.1 s at cpu4);
   - the "round trip" is mostly the CLIENT: the 39 kB body arrives through `plugin-http` in ~48
     `plugin:__TAURI_CHANNEL__|fetch` IPC reads (one every ~17 ms), and the duration scales with
     the renderer's speed (808 -> 2526 -> 3973 ms at 1x / 4x / 6x) while a small call barely moves
     (245 -> 429 -> 620). Split on the ten-community bench (section 5): **head 180 ms, body 888 ms**
     for the 116 kB page at 1x - the server answers fast, the body's crossing is the cost;
   - decode + render 756 ms: `decodeChannelMessageRow` is awaited row by row
     (`useConversations.svelte.ts:633-634`), each row a native `graine_verify_signature` invoke
     with its bytes as JSON number arrays (`services/TauriMlsService.ts:1336`), then one 340-370 ms
     long task mounting the bubbles.
5. **Drawing a salon already in memory costs 550-600 ms at 1x, 1.9 s at 4x, 2.8 s at 6x.** The
   reopen fetches nothing; it is one long task mounting the 56-row page (340 ms at 1x). The warm
   pane at 500-600 ms is the same render. On the warm slow3g + cpu4 resume, **the tap itself waits
   ~2 s**: the resume runs a series of 300-400 ms long tasks (and a 1.7 s heartbeat gap) before the
   tab's tap is handled, although the rail is already in memory (`tap>rail` 2.0 s warm vs 326 ms at
   1x). What those tasks are needs a CPU profile on a resume (section 7).

## 4. The budget

Measured on the Mi 9T at 1x and at 4x (the "poor phone"), dev, slow3g as defined above. The rule is
[local-first-ui](local-first-ui.md)'s: **an open the device can answer from local state never
awaits the network; the network only refreshes what is already drawn.**

| gesture | budget at 1x | at 4x | today, 1x / 4x (slow3g + cpu4 for the network row) |
| --- | --- | --- | --- |
| tap "Communautes" -> rail + salon rows of the last community, cold, ANY network incl. offline | **<= 200 ms** after the nav is visible | <= 500 ms | 1700 / 5982, offline never |
| same, warm | <= 150 ms | <= 300 ms | 607 / 2977 |
| tap a community in the rail -> its salons | <= 150 ms | <= 300 ms | 147 / 197 (holds) |
| tap a salon opened before (this process or a previous one) -> pane + last messages | **<= 200 ms** | <= 500 ms | 564 / 1851 (this process); 1907 / 6245 (previous one) |
| tap a salon never opened on this device -> pane | <= 300 ms | <= 600 ms | 267 / 766 |
| ... -> its messages, from the network | 1 round trip + <= 150 ms | 1 round trip + <= 400 ms | 1907 / 6245 |
| long task on any of these paths | none > 100 ms | none > 250 ms | 340-370 ms / 1.4 s |
| requests on the first-paint path | **0** | 0 | 5 serial (listing, key group x2, salons, history) |

The 200 ms budget is the member's "instant": the Pixel's warm tab already sits at ~0.17-0.4 s, and
the in-session community switch proves the hub renders in ~150 ms when its data is in memory.

## 5. The ten-community bench

`bun tools/cold-start/community-bench-seed.mjs --communities 8 --salons 8 --messages 200` gave
`fourth` ten communities (`Bench126`, `Bench127`, `BancOuverture-1` to `-8`), `BancOuverture-1` nine
salons, and its `général` 200 short messages (a 116 kB server page, the full `limit=200`). Target
`BancOuverture-1`, cold, 5 runs each, median / worst:

| condition | tap>rail | tap>salons | tap>target salons | salon>pane | salon>msgs | switch>salons | reopen>msgs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wi-Fi | 1144 / 1173 | 2114 / 2285 | **2471 / 2507** | 258 / 267 | **2976 / 3128** | 177 / 199 | 821 / 934 |
| cpu4 | 3247 / 3441 | 5684 / 6163 | 6337 / 6811 | 792 / 930 | 11649 / 14544 | 285 / 317 | 3195 / 3493 |
| slow3g + cpu4 | 3667 / 3850 | 6936 / 7196 | **7755 / 7898** | 794 / 838 | **13259 / 13755** | 260 / 286 | 3248 / 3553 |

| link (median) | Wi-Fi | cpu4 | slow3g + cpu4 |
| --- | --- | --- | --- |
| key-group links, ten communities side by side | 1375 | 2993 | 4164 |
| salons call | 356 | 709 | 967 |
| history: response HEAD | **180** | 248 | 230 |
| history: BODY read (116 kB) | **888** | 3442 | 5366 |
| decode + render after the history | 1623 | 6742 | 6443 |
| long tasks inside the salon open | 806 | 3932 | 4085 |
| long tasks inside a cached reopen | 635 | 2815 | 2818 |

What size changes:

- **The server is not the slow part of a salon open.** The 200-row page's head comes back in
  180-250 ms whatever the CPU; reading its 116 kB body through `plugin-http`'s channel takes 888 ms
  at 1x and 3.4 s at 4x. That is blocker 4's "round trip", now split, and it is the renderer's work.
- **Decode is half CPU, half waiting.** Of the 1623 ms after the body (1x), 806 ms are long tasks
  (render, and the per-row JavaScript); the rest is 200 awaited native signature checks in series.
- **Ten communities make the key-group step 3x longer** (466 -> 1375 ms at 1x, 1.8 -> 4.2 s on the
  slow link + 4x): ten chains of two requests compete for the same client while the salon rows of
  every community wait for their own.
- **The switch between two loaded communities stays at ~180-290 ms** - the in-memory hub is fine at
  this size; the 200-row salon's in-memory render is 0.8 s at 1x and 3.2 s at 4x.

## 6. The smallest set of fixes the evidence proves

Each names the blocker it removes and the gain it should measure; the instrument re-measures each
one unchanged. **None is built here.**

| # | fix | blocker | expected gain (Mi 9T) |
| --- | --- | --- | --- |
| F1 | **A local workspace list.** Persist, per account, what the last listing drew (communities in rail order, image ids, salon rows with name / private / access / write, the selected community) and hydrate `channelWorkspaces` from it at boot, before the session; the listing stays authoritative and reconciles (same upsert + prune path, so a removed community still disappears once the server says so). Write the snapshot on every successful listing and on the in-session mutations that already update the sidebar (create, rename, reorder, leave, delete) | 1 | tap -> salons: 1.7 s -> render only (~150 ms, the measured in-memory switch) at 1x; 6.0 s -> ~0.3 s at slow3g + cpu4; offline: never -> instant. The Pixel's airplane case is this one |
| F2 | **List on the token, not on MLS ready.** Start `loadChannelWorkspacesFromBackend` when the access token is there; the key-group step keeps its own `ensureMls()` await | 2 | 650 ms (1x), ~1.9 s (cpu4) off the network path - what is left once F1 exists is the first sign-in and a new device |
| F3 | **Draw salon rows before the key-group check.** Run `listChannels` beside `ensureCommunityDistributionGroup` and add the rows on its answer; keep the send gate (`openSalonSendGate`) behind the key group, as the code comment requires | 3 | 2 round trips: 466 ms (Wi-Fi), 1.3 s (slow3g), 1.8 s (slow3g + cpu4) |
| F4 | **Keep a salon's last decoded page locally and draw it first** (ledger row 9): stop deleting before the load, render the stored rows, merge the server page after (`mergeMessagePage` already merges) | 4 | first open in a process: 1.9 s -> the in-memory render (~0.56 s, then F6) at 1x, 6.2 s -> ~1.9 s at slow3g + cpu4; offline: history shown |
| F5 | **Issue the history request at the tap**, not after the pane mounts | 4 | 323 ms (1x), 1.1 s (cpu4) on a first-ever open |
| F6 | **Mount the visible bubbles first**: the render window opens on the last ~20 rows and grows after the first frame | 5 | the 340 ms long task of a 56-row page scales with rows: a cached reopen 564 -> ~200 ms at 1x (estimate, to be measured), 1.9 s -> ~0.6 s at 4x |
| F7 | **A body that crosses the bridge once, and one native call for a page's signatures.** The body: read a first-party JSON response in one transfer instead of `plugin-http`'s chunked channel reads (or route these GETs through the WebView's own `fetch`, which already carries the refresh POST - `utils/fetchRouting.ts` holds why reads go to the plugin, and that reasoning decides which). **Built for `window.fetch` on 2026-10-15: every first-party `GET`/`HEAD` is the WebView's ([mobile](mobile.md#a-response-body-through-the-http-plugin-takes-seconds-at-launch-so-every-first-party-read-is-native-2026-10-15)); a salon's history page goes through `TauriMlsService`'s own plugin `fetch` and is NOT changed**; the signatures: batch `graine_verify_signature` for the page - **built 2026-10-22, [below](#f7s-second-half-one-engine-call-for-a-pages-signatures-built-2026-10-22)** | 4 | body: **888 of the 1114 ms** of a 116 kB page at 1x, 3.4 of 3.7 s at 4x (measured, section 5); signatures: the ~800 ms of the decode that is not a long task, at 200 rows (inferred from the split, to be measured with the batch) |

**F1 + F4 + F6 are what reach the 200 ms budget**; F2, F3, F5, F7 shorten the network refresh that
follows and the first-ever case (new device, first sign-in), which no cache can serve.

### F1-F3: built 2026-10-14

**What was built.**

- **F1, the saved list.** `utils/chat/workspaceSnapshot.ts` holds one slot per account,
  `canari_workspace_snapshot:v1:<userId>`. The owner is repeated inside the payload, and a slot
  that is foreign or malformed is deleted, never drawn. `globalChatSingleton` draws it at module load.
  - Left out on purpose: unread counts, the `viewerCan*` verdicts and `historyVisibility`.
  - Before the session, `MainChatPage` shows the rail and the salon rows (`isWorkspacePreview`), but
    nothing that acts. A salon tap becomes a `notifNav` landing, selected once the session and its
    conversation exist. Reordering and settings are withheld, and the add and join buttons answer
    with a toast.
  - It is drawn ONLY while this account's unlock prompts nobody (`stores/unlockPath.svelte.ts`).
    That is set by the fact that the key is in hand without a prompt: a vault slot whose owner is
    proven, or a keystore read with no prompt due. The PIN gate and every sign-out clear it. The
    default is locked, so nothing is drawn before the gate, under it, or after it is left for
    another page (its "delete my account" link). The same rule holds back the listing on the token
    (F2).
  - A spinner in the header says the list is being refreshed until the first listing answers
    (`workspacesConfirmed`).
  - Two web tabs: the save is also checked against the device's durable sign-in record
    (`canari_saved_user`), so a tab still showing an account that another tab signed out never
    writes that account's list back.
- **F2.** `ChatBackgroundService` starts the listing when the server has answered for the account
  on screen (`sessionAnsweredFor() === currentUserId()`, set when a token is issued and cleared by a
  401/403 or a sign-out), or when `isLoggedIn` is true, whichever comes first.
  - The key-group step waits on `whenMlsReady()`: it never creates an MLS client before the login
    has initialised it.
  - A sign-out during that wait rejects it (`abandonMlsReadyWaiters`). It also bumps the listing
    generation (`forgetAccount`), so nothing is written for the next account.
- **F3.** `loadCommunitySalons` sends `listChannels` beside the key-group chain and draws the rows
  and conversations as soon as it answers. The send gate opens only after the key group, as before.

**The invalidation rule is durable state, not a clock.** The saved list is a copy of the last
listing, rewritten by an effect whenever `channelWorkspaces` changes. Every listing that answers
prunes the communities and salon rows the server no longer names, including saved rows that have
no conversation yet. A community whose access was lost therefore leaves the screen, and the copy,
at the first answer. In-session events (leave, delete, a removal) rewrite it too. A listing that
fails leaves the copy on screen as unconfirmed data being refreshed. It is logged once, and the
spinner, then the error, says so.

**The sign-out decision.** Every sign-out erases every slot, with or without "Rester connecte",
and so does a change of account. The in-memory list goes as well, which it never did before. The
reasoning is in [auth](modules/auth.md#a-sign-out-ended-the-session-on-the-server-and-left-it-live-on-the-device---fixed-2026-10-14).

**A defect the earlier tap exposed.** A salon tapped as soon as its row is drawn now overlaps two
other events: the live stream coming back, and the end of the community listing. Each of them used
to ask for the same 116 kB page again and supersede the first request. That happened 2-3 times per
open on this build, and also on `main` when the tap was fast (one main run in three).
- The fix: a load in flight is now JOINED, unless the copy was declared stale after its request
  left (`salonStaleDeclarations` in `useConversations`). One request per open now.

**What review closed (2026-10-15).**
- **The F3 window.** A salon's rows, and a restored conversation, can be opened before the listing
  registers the community's key group. A history page decoded then asks for its missing seeds on a
  group that is not registered yet. The repair refuses (`key-group-unregistered`), and the request
  is lost until the next load.
  - Now `loadChannelHistory` fetches the page at once but DECODES it only when no listing or entry
    still in flight can enter the salon (`whenSalonEntryDecided` in `salonSendGate.ts`).
  - An entered salon waits for nothing, and nothing ever waits for a listing that has not started.
  - **The wait is bounded by LISTING STATE, not by a clock.** It ends when the salon is entered,
    when the last listing or entry in flight settles, or when the session ends
    (`resetSalonSendGate` wakes every reader). A listing whose fetch HANGS therefore holds
    decoding for as long as it hangs. `apiFetch` has no per-request timeout
    ([local-first-ui ledger row 6](local-first-ui.md#4-the-ledger---what-is-fixed-what-is-not)), so
    a hung fetch is held for as long as the platform's HTTP stack keeps the request open. The fix
    belongs to that row, not to a timer here.
- **Every keypad marks the unlock owed.** One function draws the keypad (`showPinGate` in
  `ChatBackgroundService`), and it resets the unlock fact. Before this fix, the keypad could be
  drawn with the device still marked as unlocked unattended, which left the rail drawn and the
  listing running behind it. Two paths did this: a saved unlock that failed after an unattended
  read, and a PIN reset.
- **A press that joins a background load** raises the skeleton; the joined load owns it.
- **A saved row tapped early, for a salon closed to the member since,** becomes a landing that ends
  at the listing's own answer: the landing was published before the request, and the answer does
  not name the salon.
  - Before, `landingRecovery` asked for a second full listing before giving up.
  - A landing published after the request keeps its refresh (for example, a notification for a
    salon the listing could not know about).

**Measured.** Mi 9T, the ten-community bench, target `BancOuverture-1`, cold, 3 runs, median.
BEFORE is `main` at `b722983f0`, which already has F5 and F6 (#1875). AFTER is this branch.
Same protocol and instrument as sections 1 and 5.

| condition | tap>rail | tap>salons | tap>target salons | salon>msgs |
| --- | --- | --- | --- | --- |
| Wi-Fi, 1x | 999 -> **452** | 1818 -> **626** | 2207 -> **1082** | 3251 -> 4171 |
| Wi-Fi, cpu4 | 2948 -> **1385** | 5239 -> **1755** | 6056 -> **2955** | 11102 -> 14726 |
| slow3g + cpu4 | 3715 -> **1445** | 6923 -> **1846** | 7661 -> **3063** | 12343 -> 16995 |
| airplane, 1x | never -> **415** | never -> **571** | never -> **896** | never (no history offline: F4) |

**How to read these numbers.**

- **The tab got 2-4x faster and now works offline.** It is still not at the 200 ms budget. In
  airplane mode, with no request at all, the rail takes 415 ms and the salon rows 571 ms after the
  tap, against 160-170 ms for a `switch` once the hub is mounted. What remains is the FIRST MOUNT of
  the communities page (a 220-260 ms long task at 1x, 1.4 s at 4x). That is a render cost, the next
  package, and not a data cost any more. It was profiled and cut on 2026-10-15
  ([the first mount](#the-first-mount-profiled-and-cut-2026-10-15)), and most of that task was not the
  communities page at all.
- **`salon>msgs` is longer, but the messages arrive at the same moment.** The member now reaches the
  salon about 1-3 s earlier. The salon open then overlaps the boot work (MLS initialisation, ten
  key-group chains, roster checks) instead of following it. Counted from the tap on the tab, the
  first message lands at about the same time on both builds: ~5.4 s at 1x, ~17-20 s at 4x.
- **The history request leaves 750 ms after the tap at 1x** (360 ms on `main`). The chain shows the
  load started at the tap and left unsent for ~700 ms. The only await in front of the request is the
  `deleteMessagesForConversation` that runs before every salon load, on a SQLite store busy with the
  boot (inferred, not profiled). F4 removes that delete.

### F4: built 2026-10-15

**What changed.**
- A salon's last page is kept on the device as a COPY: the page the last load drew, sealed under the
  device key like a DM's rows.
- `loadChannelHistory` sends the server request first. While that request is in flight, it draws the
  stored page (`drawStoredSalonPage`), only on the salon's first draw in the process. When the
  server page answers, it merges as before.
  - EVERY row drawn from the store that the fresh page does not name is withdrawn, wherever it sits
    and even when the page is empty. The server HARD-deletes a salon message (no tombstone), so a
    missing row is the only sign that it is gone. A message that arrived live after the draw is
    kept, because it was not drawn from the store. Review of #1892 (2026-10-15) found what the first
    version missed: it withdrew only rows OLDER than the page, while the merge keeps rows newer
    than a page as live arrivals. A deleted newest message, or an emptied salon, therefore
    reappeared from the copy for the life of the process.
  - **The drawn rows belong to the SALON, not to the load that drew them** (2026-10-22,
    `salonRowsDrawnUnconfirmed`). Whichever load merges withdraws every drawn row its page does not
    name, then clears the set. Before this, the load that drew kept its own list. If a newer load
    superseded it, that load returned without merging. The newer load then found the drawn rows
    already in memory, drew nothing, and so had nothing to withdraw. A row the server no longer
    served stayed on screen. GRAINE-AUTH-1 saw it once in five runs: a row the reader had refused
    was still shown. Every early return of the draw now says why it drew nothing. The early
    returns log at debug level, one line per load, because the rig's GRAINE-AUTH trail reads them.
    A whole-history search confirms every row it decodes, so a later page cannot withdraw a row
    the server still holds. Sign-out forgets the set with the conversations
    (`forgetUnconfirmedSalonDraws`).
  - **A residual, by design.** Suppose a row reached memory live, or from an earlier load, and was
    never drawn from the store. If a later page refuses it while it is the newest row, it stays on
    screen: it was verified when it arrived, and the merge keeps rows newer than a page. GRAINE-AUTH-1
    cannot tell this case from the drawn-row one, so the instrumented repeat on the estate decides
    which of the two the 2026-10-22 FAIL was.
  - The two-tab race below predates this change and is unchanged.
  - Only then is the copy replaced in the store (`storeSalonPage`: delete, then save).
- Nothing is deleted BEFORE the server answers any more. That includes the boot restore, which used
  to erase every salon's rows (`conversations.ts`).
- An open that fails keeps the copy on screen and in the store, so the salon can be read offline.

**What is unchanged.**
- The server stays the source of truth: the copy is replaced at every load.
- Live salon messages are still not written one by one (`skipDbSave`).
- A pre-session landing still has no salon preview (`landingPreview.ts`).
- A salon pruned by the listing is deleted with its rows (`deleteConversation`).

**The sweep that replaced the boot delete.** A salon gets a conversation only once a listing names it
in this process. The prune's loop over the conversations therefore never reaches the stored page
of a salon the member lost, or that was deleted, while the app was closed. Each complete listing
now deletes the stored page of every salon it does not name, except a salon created on this device
after the request (`sweepStoredSalonPages`, over `IStorage.getMessageConversationIds`). A listing
that failed sweeps nothing.

**Two narrow windows left open on purpose (P3, review of #1892, 2026-10-15).**
- **Another tab stores a newer page between this load's request and its draw.** This load then
  draws that newer copy. Its own server answer, older than that copy, withdraws the rows the copy
  has and the answer lacks, then writes its older page back over the copy. The screen shows what
  this tab's server answer said, which is correct for that answer. A row posted in between is
  missing only until the live stream delivers it or the next load runs. Closing the window would
  need a version on the stored page that both tabs compare. One web user with two tabs, on the
  same salon, inside one round trip, does not justify that.
- **A tap's load that is still in flight when the sweep deletes its salon's page writes that page
  back.** The load was asked before the listing answered and does not know the salon is gone. The
  orphan page is sealed, belongs to this account only, and is never drawn: no listing names the
  salon, so nothing opens it. The next listing's sweep deletes it. Closing this window would mean
  checking the listing generation inside `storeSalonPage`, which is a second source of truth about
  membership.

**What a sign-out does not sweep, deliberately.** A sign-out keeps the message database: the user
chose "deconnecter seulement, garder l'etat" (`ChatBackgroundService`, the PIN gate's exit). A salon
copy follows the same rule as a DM's rows: sealed under the device key, in the account's own
database. Account DELETION (`SettingsDangerZone`) also leaves that whole database, DMs included, at
rest. That is a question about the database as a whole, not about salons, and it is owed in
[backlog](../backlog.md).

**Measured** on the Mi 9T (2026-10-15). Both builds are 1.2.8, measured with
`tools/cold-start/community-open.mjs` on target `BancOuverture-1`. The baseline is #1886's head;
the F4 build adds this change on top. Each figure is the median of 3 runs, in ms.

| Condition | salon>msgs before | salon>msgs F4 | reopen>msgs before | reopen>msgs F4 |
| --- | --- | --- | --- | --- |
| none, 1x | 4177 | 978 | 911 | 572 |
| none, 4x | 14190 | 4246 | 3587 | 2003 |
| slow3g, 4x | 17404 | 3832 | 3643 | 2089 |
| airplane, 1x | never | 606 | never | 646 |

The tab (`tap>salons`) is unchanged within noise: 556/619, 1765/1719 and 1851/1902. That is
expected, because F4 only touches the salon pane. In the airplane condition, one run of three timed
out at `tap>target salons` in both builds, so the airplane medians cover 2 runs.

### Reaching under 200 ms: the tab, and a cached salon's first messages

What the measurements say is already within reach, and what stands between it and 200 ms:

- **The tab.** The hub itself renders in ~150 ms when its data is in memory (`switch>salons` 147 ms
  small, 177 ms on ten communities, at 1x). So the tab is a DATA problem, not a render problem: F1
  puts the last listing in front of the first frame, read synchronously from a per-account snapshot
  at module load (no `await` of SQLite, no session, no MLS) - the same reason the feed's audience
  verdict is persisted ([local-first-ui section 3](local-first-ui.md#3-the-fil-tab-and-what-it-cost-2026-09-23)).
  The listing then reconciles behind it. Expected: cold tap -> rail + salons ~150 ms on Wi-Fi, under
  300 ms at 4x, and the same offline - where today it is never (Mi 9T 3/3, the Pixel on
  production). The warm resume at 4x (2 s before the tap is even handled) is a separate cost and
  needs its profile first (section 7).
- **A cached salon's first messages.** Today a reopen in the same process is 564 ms (56 rows) to
  821 ms (200 rows) at 1x with NO request: it is the render of the whole page in one long task (339
  / 635 ms). Two changes, both needed: F4 so "cached" also covers a salon opened in a PREVIOUS
  process (today that is a 1.9-3.0 s network open), and F6 so the first frame mounts only what the
  viewport shows (~15-20 bubbles on the Mi 9T) and the rest after it. At 1x the long task should
  then fall with the row count (56 rows -> 339 ms, so ~20 rows ~120 ms, inferred, to be measured),
  which is what puts the pane and its messages under 200 ms. The skeleton the Pixel shows for
  ~0.3 s before content is this same render.
- **What must NOT be on that path**: the history request (F4 draws first, F5 refreshes), the 200
  serial signature checks (they apply to the network page, not to rows already decoded and stored),
  the key-group check (F3), and any `await` of the session or MLS (F2).

**Two Pixel findings that are not on the open path** and go to the queue as their own items: the
checkpoint per bulk ingest, read watermarks included, is the parked decision of
[open-questions](../open-questions.md#decision-owed---may-a-drain-that-only-received-application-frames-skip-its-full-checkpoint-2026-10-13)
(94-238 ms each, off the JavaScript thread since #1826); the 45 identical `[HISTORY_RECONCILE] ...
asked 30s ago` lines in 250 ms were a noise defect (P3), FIXED 2026-10-17: `reconcileAllGroups` counts the groups already asked inside the window and reports them once in its pass line.

### The first mount: profiled and cut, 2026-10-15

**Method.** The Mi 9T on `1.2.8`, account BancOuverture-1, at 1x CPU. `community-open.mjs` now takes
three new options: `--profile` (a V8 CPU profile sampled every 200 us, from the tab tap to the target
salon's rows), `--trace` (a Chrome trace over the same window, with the run's marks) and
`--before-tap <js>` (an expression evaluated in the page before the tap). `profile-summary.mjs` and
`trace-summary.mjs` read both files, aligned on the `touchstart` dispatch. A local bundle cannot
reach the phone: Tauri serves `tauri.localhost` from `shouldInterceptRequest`, which CDP `Fetch`
does not see (0 requests paused). Building a local APK would need the release keystore and an
uninstall. So each cut was first EMULATED on the installed build through `--before-tap`, in arms
interleaved run by run, and the built code reaches the phone with the next pre-release.

**What the 220-260 ms task was made of.** Most of it was not the communities page.
- **The click waited for a double tap.** The bottom bar sits outside `.page-scroll-wrap`. That
  wrapper's `pan-y pinch-zoom` turns double-tap zoom off for the page, but not for the bar. The
  Android System WebView therefore held the click ~120 ms after `touchend` (measured on that one
  engine; Chrome's documented behaviour is not to wait on a `width=device-width` page, and iOS was
  not measured). In the trace, `click` lands 266 ms after
  `touchstart`, and 158 ms after with `touch-action: manipulation` on the bar (`gesturetap` 27 ms
  after `touchend` instead of 120).
- **Every navigation re-preloaded every visible tab.** `data-sveltekit-preload-code="viewport"` is
  re-scanned after each navigation and calls the route's node loaders again. Each call goes through
  Vite's `__vitePreload`, which resolves ~250 dependency URLs BEFORE its cache check. That cost
  60-118 ms of main thread per tab tap, for modules loaded since boot. The layout's swipe-neighbour
  `preloadCode` did the same on each arrival.
- **The feed mounted a panel it never draws on a phone.** `ConversationsMiniPanel` is `hidden
  xl:flex`, yet it was mounted at every width. The cold-tap profile ATTRIBUTES 45 ms to it, inside
  the feed's teardown and mount. No arm measured the gain of removing it.
- **What is the communities page itself** is ~130 ms: the feed's teardown (25-35), `MainChatPage` +
  `Sidebar` (35), SvelteKit's focus reset forcing a layout (33), and `ChatArea` (12).

**The cuts.**
- `touch-manipulation` on `#bottom-nav`. It is set on the bar and NOT on `html`, because the
  drag-and-drop rows were not measured under it.
- One code preload per route per document: `preloadRouteCodeOnce`
  (`src/lib/navigation/routeCodePreload.ts`). It is a memo of the promise. A failure is logged and
  forgotten, so the next CALLER of the memo retries. The bar and the sidebar now use
  `use:preloadRouteOnView`, which makes ONE attempt the first time a link is on screen: a link
  whose preload failed does not retry by itself (its observer is one-shot, and re-observing a
  visible link would retry in a loop while offline). A link drawn again, or a swipe neighbour, asks
  the memo anew, and the navigation itself loads the route's code regardless. The layout's swipe
  neighbours go through the same memo.
- The feed mounts `ConversationsMiniPanel` only when `overlayLayout()` is false. That is the `xl`
  boundary, read through a reactive `matchMedia` (`phoneViewport.svelte.ts`).

**Measured.** Medians of 5 interleaved runs, in ms. `s0` is a tap as soon as the bar shows; `s6` is
a tap 6 s after it. The arms are emulations on the installed build:
- `manip` injects `#bottom-nav{touch-action:manipulation}`;
- `manip+nopre` also removes the bar's preload attribute.

The mini panel is not in either arm (its 45 ms is attribution only), and neither is the
swipe-neighbour memo. Neither can make the tap slower, so the built code should gain at least what
is shown; how much more is owed to the pre-release measurement.

| Tap | tap>rail = tap>salons, base | manip | manip+nopre |
| --- | --- | --- | --- |
| cold (`s0`) | 453 | 359 | **343** |
| settled (`s6`) | 449 | 394 | **389** |

**The instrument was lying by up to 120 ms (fixed).** `until()` armed a mark only after the
PREVIOUS mark had been polled. A mark drawn in the same frame as the previous one was therefore
timed at the next poll, never at its frame. With arming moved BEFORE each tap, the salon rows land
in the rail's own frame (`tap>rail` = `tap>salons`). The earlier `tap>salons` figures on this page
are 80-120 ms high.

**Arming early had its own lie, also fixed (review of #1897).** A watch armed before its tap
marked at once if its condition was ALREADY true. Before a reopen, the previous salon's composer and
bubbles can still be on screen during the back animation. A first version of the fix read
`reopen>msgs` ~370 ms that way, and that figure is WITHDRAWN. A watch now marks only the first frame
its condition holds AFTER a frame where it did not. `until()` also refuses (prints, and records
`null`) any mark that precedes its tap. Re-measured with both, cold, 1x, 2 x 3 runs:
- `tap>salons` 415-456, unchanged;
- `salon>msgs` ~950-1030, as F4's table;
- `reopen>msgs` **965-1020**.

**OWED: which of two readings that reopen number is.** Either F4's 572 was the old bubbles too, or
the reopened salon draws its stored page, then goes EMPTY for a frame before the server page, and
the edge times the second appearance. That would be a flicker defect of its own. Telling the two
apart needs a watch for a frame with no bubble after one with bubbles.

The rules are in [durable-rules](../durable-rules.md).

**What remains above 200 ms (~340-390 at 1x), and why.**
- **The press itself, ~150 ms.** The CDP press takes ~125 ms, plus 27 ms of gesture detection.
  While navigation starts on `click`, a 200 ms budget counted from the finger landing is nearly out
  of reach. Counted from `click`, the tab is ~190-230 ms.
- **SvelteKit's navigation chain, ~55 ms.**
- **The mount, ~130 ms** (above). SvelteKit's focus reset forcing a layout is the largest single
  item that is not ours to delete.
- **Paint, ~30-50 ms**, plus the instrument's per-frame rAF probe.

Not changed, and noted: the hub does not remember the selected community across mounts.
`Sidebar`'s `selectedCommunityWorkspaceId` is local, so a return to the tab opens the first
community.

**Owed:** the same table on the phone with the built code, from the next pre-release. Evidence is in
`<harness-dir>/a1-bench/r1015-first-mount/`: `runs.ndjson`, the profiles, the
traces, and `src128/` (the dumped `1.2.8` chunks the profiles resolve against).

### F7's second half: one engine call for a page's signatures, built 2026-10-22

**What changed.** `loadChannelHistory` and `searchChannelHistory` decode through
`decodeChannelMessagePage`, which opens the page with `openChannelMessagePage`. The 200 awaited
`graine_verify_signature` invokes, each carrying three JSON number arrays, are ONE
`graine_verify_signatures` invoke carrying one base64 string (WASM on the web: one call, one
slice). The Rust command is `async` and verifies on a blocking thread, where the single one ran on
the main thread. Semantics, keys, refusals and logs are the single path's
([channel-encryption](../protocols/channel-encryption.md), "Where each half lives"); the rules
that keep them identical are on that page and in `channelSeal.ts`.

**Measured without a device** (this workstation, so a shape and not the phone's number):

- Rust, release, 200 checks: 10.2 ms as 200 single calls, 11.1 ms as one packed batch. The
  verification costs the same; the batch removes the crossings, not a check
  (`cargo test --release -p mls-core page_of_200 -- --ignored --nocapture`).
- The bridge payload of a 200-row page: **356 504 characters over 200 invokes** as number arrays,
  **135 488 in one invoke** as the packed base64 string; built in 6.6 ms vs 1.9 ms on desktop V8
  (`CANARI_BENCH=1`, `graineV2.test.ts`).

**Owed: the Mi 9T re-measure** with `community-open.mjs`, cold, ten-community bench, `salon>msgs`
and the "decode + render after the history" link of section 5 (1623 ms at 1x, of which ~800 ms was
not a long task and was inferred to be these invokes), against the 200 ms budget of section 4. It
needs a build carrying this change, so the next pre-release.

### The budget reading on `1.6.0`, 2026-11-01/02: over budget on every row

**Bench.** Mi 9T, a sideloaded rig build `1.6.0 (100600002)` (the rig does not record its bundle; it
is the build the phone held, signed out, when the dev estate had just been reset). Dev estate, the
rig's `owner` test account on a fictional seed, signed in with "Rester connecte" ticked
(`login.mjs`, then `pin.mjs --stay`: the vault path, no PIN on a cold start). The ten-community bench
of section 5 was seeded again with
`community-bench-seed.mjs --communities 10 --salons 8 --messages 200` (`BancOuverture-1` to `-10`,
nine salons in the first, 200 short messages in its `general`). Target `BancOuverture-1`;
instrument and protocol exactly as sections 1 and 5; no network shim, and no CPU throttle except
where named. Evidence: `<harness-dir>/a1-bench/r1101-budget/`.

**Readings** (ms from the tap that asked; median / p90 by interpolation / n; the raw values are in
`runs.ndjson`). In these runs `tap>rail`, `tap>salons` and `tap>target salons` are one number: the
rows land in the rail's frame.

| condition | n | tap>rail+salons | salon>pane | salon>msgs | switch>salons | reopen>msgs |
| --- | --- | --- | --- | --- | --- | --- |
| cold, Wi-Fi, 1x | 7 | **530 / 737** | 441 / 542 | 919 / 1093 | 176 / 190 | 328 / 344 |
| cold, airplane, 1x | 5 | **376 / 408** | 587 / 611 | 996 / 1012 | 183 / 192 | 354 / 366 |
| cold, Wi-Fi, cpu4 | 5 | **1747 / 1992** | 1501 / 1600 | 3850 / 3963 | 249 / 254 | 847 / 949 |
| warm, Wi-Fi, 1x | 5 | **319 / 355** | 291 / 330 | 299 / 578 | 167 / 183 | 339 / 344 |
| warm, airplane, 1x | 3 | **314 / 318** | 306 / 326 | 332 / 618 | 155 / 161 | 340 / 341 |

`salon>msgs` on a cold run is a salon opened in a PREVIOUS process (F4's stored page), so it is the
"a salon opened before" row of section 4. A warm run keeps the process, so its `salon>msgs` is the
in-memory case; its worst value is the run that did the one network open.

**Against the section 4 budget (1x unless said):**

| gesture | budget | measured (median) | verdict |
| --- | --- | --- | --- |
| tab -> rail + salons, cold, any network incl. offline | <= 200 | 530 Wi-Fi, 376 offline | over, 1.9x-2.6x |
| same, cold, 4x | <= 500 | 1747 | over, 3.5x |
| same, warm | <= 150 | 319 Wi-Fi, 314 offline | over, 2.1x |
| tap a community in the rail -> its salons | <= 150 | 176 | over by ~25 ms (was 147-177) |
| a salon opened before, previous process -> pane + last messages | <= 200 | 919 Wi-Fi, 996 offline | over, 4.6x-5x |
| a salon opened before, same process | <= 200 | 328 Wi-Fi, 354 offline | over, 1.6x-1.8x |
| same, 4x | <= 500 | reopen 847; previous-process open 3850 | both over |
| a salon never opened here -> pane | <= 300 | not run (the seed had opened this one) | not measured |
| long task on these paths | none > 100 | hub 172-225, salon open 546-551, cached reopen 340-348 | over |

**Verdict: the 200 ms budget is not met on any row.** What F1-F7 bought is unchanged: the tab works
offline (rail and salons in 376 ms with no request; "never" before F1), a salon opened in a previous
process draws from its stored copy (919 ms against 1.9-3.0 s from the network, and 996 ms offline
against an empty salon), and a switch between loaded communities stays at ~175 ms. Against the
2026-10-15 readings on `1.2.8` (tab 384-453, `salon>pane` ~300, `salon>msgs` 978) the tab and the
salon pane read HIGHER here (530 and 441), on a different build, a different account and a re-seeded
estate. That comparison is to be re-made on one build; it is not a regression to attribute.

**Where the time goes.**
- **The tab, 376 offline -> 530 Wi-Fi.** The ~155 ms between the two is boot work on the same main
  thread while the member taps: 32-52 first-party API calls in the window and the MLS start-up
  (`mlsReady` at 2.4 s offline, 3.0 s on Wi-Fi). The trace of one Wi-Fi run (`--profile --trace`, rail
  at +642) shows the main thread busy for the whole window: 627 ms of exclusive time, 226 ms in
  microtasks and 216 ms in function calls, style and layout 38 ms, paint 6 ms. Before any of it, the
  press: `click` lands 135 ms after `touchstart` (the CDP press, ~120 ms, plus gesture detection), so
  ~135 ms of the 530 is the instrument's finger.
- **A salon open, 919 ms.** One long task of ~550 ms mounting the page (546-551 in every condition,
  offline included, so it is render and not network). The history request is off the path (stored
  page first) and its body no longer crosses `plugin-http` in ~48 reads: one IPC call in the open
  window, against ~48 on `1.2.7`.
- **A same-process reopen, 328-354 ms** is one 340-350 ms long task for the already-decoded page: the
  same mount again.
- **The biggest single cost on every row is the mount of a salon page (340-550 ms), then the boot work
  sharing the thread with the tab tap (~155 ms), then the instrument's press (~135 ms).** At 4x
  everything scales ~3.3x (tab 1747 ms, long tasks 1.3-2.1 s): main-thread work.

**Not read, and why.** The F7 signatures batch is not isolated: the "decode + render after history"
link of section 5 cannot be computed on these runs (its line goes negative, since the stored page is
drawn before the response), and no earlier build was on the phone for a before/after. A `slow3g` cell,
the warm-resume profile and a never-opened salon were not run.

**What it says about the next package.** The remaining distance is rendering and main-thread
contention, not data: (1) mount only the visible bubbles in a salon's first frame and measure
`longtask ms, salon open` falling from ~550 ms; (2) defer boot work that does not gate the first frame
(MLS start-up, listing reconcile, key-group chains) until after the tab's first paint, then re-read
`tap>rail` on Wi-Fi against its offline twin (target: within noise); (3) count the budget from
`click`, as the first-mount analysis suggests, or the instrument's ~135 ms press keeps every row 135 ms
over by construction.

### The salon mount, named: 60 rows mounted before the reveal, not 20 (2026-11-02)

**Method.** `community-open.mjs --profile-salon` (new): one V8 CPU profile per salon open, from the
tap on the row to the first bubble, on the Mi 9T (`1.6.0`, the build of the reading above, cold
start, BancOuverture-1 and its 200-message `general`). The release bundle is minified, so the chunks
were dumped from the running WebView (`Debugger.getScriptSource`) and the hot positions of
`profile-summary.mjs --sources` read against them. A profiled run is slower than a bare one
(200 us sampling): the profile gives the SHAPE, and the milliseconds against the budget stay the bare
runs' (the table above).

**What the profile says.** In a 1064 ms window (tap to first bubble, the open is 570-920 ms of it),
~450 ms is ONE Svelte flush mounting the page: `ChatMessageGroups` 262 ms (the bubbles; `MessageBubble`
218 ms inclusive, the message text 59 ms of it), the chat header, the composer and the page chrome
~190 ms, and 187 ms of native `(program)` (style and layout) after it. A DOM count after the open read
**60 `msg-*` rows mounted**, not the 20 of the first frame.

**Why 60.** `ENTRY_FIRST_FRAME_GROUPS` is 20 (F6, #1875) and works. But `fillViewportThenPin`
then wants the pane to overflow by 40 px, so that a scroll event, and with it pagination, can happen.
On this seed the rows are one line, 37 px: 20 rows are 740 px in a ~750 px pane, short of
the overflow by a few pixels. The old rule for a short pane was "widen to the FULL 60-group entry", so
the thread mounted 40 more hidden rows (~260 ms of the task, ~4.4 ms a row) for 40 px of overflow
and only then revealed. The wiki's own test pinned it: "a thread of one-line rows settles on the
60-row entry window" (it was documented as intended, and it was the cost).

**What changed** (`ChatArea.svelte`, `renderWindow.ts`):
- The fill pass reads what the first frame measured. `fillStart` takes the mounted height and the
  rows mounted, computes the deficit in pixels and asks for exactly the missing rows (floor of 4 groups,
  never more than the full entry window on a measure alone). A one-line thread of this seed fills with
  24 rows instead of 60 before the reveal; the last of the four passes keeps the old jump, so the loop
  still converges whatever a measure says.
- The widen after the reveal (`widenEntryWindow`) was one task of 40 rows. It is now steps of 10
  groups, a yield between each (`widenStepStart`), the scroll position compensated per step. No task of
  the widen is longer than 10 rows (~45 ms on the phone) whatever the thread holds.
- `isCoarsePointerDevice` reads the live `MediaQueryList` while somebody subscribes: every bubble
  asked `matchMedia` on mount (~3 ms of the open).

**What the instrument now does.** `--profile-salon`, and the `click` of every tap is recorded: the
report carries `click>rail`, `click>salon msgs` and `click>reopen msgs`. Navigation starts on the
click, and the CDP press holds the finger ~120 ms before it, so a budget counted from the finger
landing is over by that much by construction; the `click>` columns are the ones to read against the
200 ms, the `tap>` ones stay for continuity with the tables above. The tap columns still book the
instrument's per-frame predicate (`querySelectorAll` and `getBoundingClientRect` once a frame), a few
milliseconds, not removed.

**Not done, and why.** The boot work that shares the thread with the tab tap (~155 ms: 32-52 API calls
and the MLS start-up) is NOT moved in this step: nothing in the profile above names which part
sits on the tap's critical path, and moving it blind could break the ordering that F2/F3 pin.
The `--profile` window of the tab tap, read against this page's sources, is the next step. The
Mi 9T re-measure needs a build carrying this change (the installed APK holds `1.6.0`).

## 7. Not measured, and owed

- **A CPU profile of the warm resume at 4x** (blocker 5's 2 s before the tap is handled):
  `Profiler.start` on the same socket during the resume, as the 2026-10-13 page did.
- **iOS.** The same protocol needs the WKWebView inspector; the bench iPhone runs TestFlight builds.
- **The MLS delivery and the WebSocket on a slow link** - the shim does not reach them; the shaping
  proxy on the local estate does.
- **What a read-only Pixel 6a capture would add**: the same chain on a 15.5 MB production state
  and a production-sized account (dozens of salons, 60-70 readers per message), which no bench
  account has. Ask the user to (1) close Canari from the recent apps, (2) wait 10 s, (3) open it,
  tap "Communautes" as soon as the bar shows, (4) open the salon they read most, (5) back, another
  community, its first salon, (6) back, the first salon again; then "Enregistrer le journal" in
  Settings > A propos. With USB debugging already on, an agent may only READ: `adb logcat -v epoch
  --pid <canari pid>` during the gestures and, if the store build exposes no inspectable WebView,
  the exported log alone (its `[A] refresh✓`, `[INIT] MLS ready`, `[WORKSPACE-LOAD]` and `[API]`
  lines carry the chain of section 3). Nothing is installed, driven or signed in.

## 8. Evidence

`<harness-dir>/a1-bench/r1014-community-open/` (off the repository):
`runs.ndjson` (one row per run with its console, API calls, requests, long tasks and logcat),
`report.txt`, `batch1.log`, and `discarded/` - the rows taken before two instrument defects were
fixed (a nested `window.fetch` wrapper that recorded and delayed some calls three times, and the
warm flow tapping a Feed tab a salon open hides). Instrument defects fixed on the way:
`forwardDevtools` took the FIRST debuggable WebView socket listed, and the Mi 9T listed four
(three other apps); it now takes the one named after the app's pid.

See also: [cold-start](cold-start.md), [notification-to-conversation-latency](notification-to-conversation-latency.md),
[offline-and-weak-network](offline-and-weak-network.md), [chat](modules/chat.md).
