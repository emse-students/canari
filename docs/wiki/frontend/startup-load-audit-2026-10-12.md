# Startup load and send delay - two web consoles, 2026-10-12

The user's words: *"les choses m'ont l'air encore assez longues; je ne sais pas si on a besoin de
charger tout ce qui est charge a chaque fois"* and *"un message que j'envoie met plusieurs secondes a
apparaitre"*. Two exported Firefox consoles of the production web client (`canari.emse.fr`,
`v1.2.5`, the user's account), read with the method of the
[first console audit](web-console-log-audit-2026-10-12.md). Identities are roles, never people
([durable-rules](../durable-rules.md#a-measurement-taken-from-production-names-roles-and-counts-never-people---this-repository-is-public)).
Companions: the heavy-state performance audit (PR #1776, read from
code) and [notification-to-conversation-latency](notification-to-conversation-latency.md) (the tap
path on the Mi 9T).

- **Log 1** (`17:10:56.950-17:12:24.938`, 5202 lines): a reload after ~3.3 h away
  (`messages?after=11:53`), the salon `feca872d` opened, one message sent.
- **Log 2** (`17:27:11-17:29:06`, 135 lines): idle, only key-group chatter.

## The startup timeline (log 1)

| t (s) | What | Evidence |
| ---: | --- | --- |
| 0.00 | token refresh out | `[A] refresh->` 17:10:56.950, answered in 98 ms |
| 0.10 | MLS state loaded from IndexedDB, 10.06 MB (89 groups, 238 KeyPackages) | `load_or_create: state composition` |
| 0.29 | `[INIT] MLS ready` | 17:10:57.240 |
| 0.60 | socket connected | `[WS] Connected` 17:10:57.549 |
| 0.91 | queue pull starts: **1004 frames** in 5 pages of 500 | `[PENDING] Fetched ... (1004 so far)` by 17:10:58.486 |
| 0.91-5.09 | **one drain of 4.2 s**: 1066 frames processed, of which 775 seed bundles (8722 seeds, **all already held**), 83 refused as absent-conversation | `Drain start` 57.863 -> `Drain complete` 02.037 |
| 0.38-3.25 | community load, **7 communities in series**, 21+ requests | `distribution-group`, `members`, `user/me` each; `[WORKSPACE-LOAD] communities/channels loaded` 17:11:00.198 |
| 3.27-5.07 | **26 salon re-reads** for 3 salons (52 requests), one per new seed in the drain | `seed X from Y for channel Z` -> `GET messages?limit=200` + `read-marks` |
| 5.47 | first checkpoint after the drain: 395 ms | `Encrypted state checkpoint persisted. (395 ms)` |
| 5.72 | archive catch-up, 81 groups in 2 requests | `[CATCHUP] batch history: 81/81 group(s) primed in 2 request(s)` |
| 5.9-6.8 | 7 conversations caught up from the archive, each loading the 10 MB state into a fresh WASM client (~45-50 ms each) | `WasmMlsClient::new` x7, `mls_wasm_bg.wasm` fetched 6x (cache), `mlsCrypto.worker` 4x |
| 6.79 | the 83 absent-conversation frames re-fetched and replayed: **80 duplicates** of what the archive just read | `[MLS] Duplicate delivery ... SecretReuseError` x80, `Ciphertext generation out of bounds` x80 |
| 7.7-12.7 | **81 `user-members` reads in series**, 5.0 s, every one `304` | `removeStrayLeaves` |
| 12.7-14.2 | the same 8 key-distribution groups asked twice, 1 s apart (16 requests) | `[SYNC] WASM kept ... key-distribution group` x16 |
| 33.0 | salon opened: members, pins, users/batch; **50 avatar requests, 17 of them `404`** | `[AvatarCache] 404 ... absent for the rest of the session` |

## (A) Findings, ranked by cost

| # | What | Count / time (log) | Cause | Disposition |
| --- | --- | --- | --- | --- |
| 1 | A returning device's queue is mostly seed bundles it already holds | 775 of 1066 frames; 8722 seeds, 0 new; 4.2 s drain on the main thread | Every seed answer was broadcast on the community's key group (208 leaves), so every member queued every answer to anybody | **Fixed by #1768** (merged after `v1.2.5`, an answer reaches only the device that asked) - **owed a release**, then a re-count of this column |
| 2 | **A salon send shows nothing for 6.1 s** | click 17:12:08.052 -> bubble 17:12:14.191 | No local row for a salon; the bubble is the server's broadcast. Behind it, two round trips in series on a slow link (`latency floor 1123 ms`): the key group had a commit 10 s earlier, so the send minted a new Graine session and distributed its seed (`POST /api/mls/send` 4055 ms), then posted the message (`POST .../messages` 2049 ms) | **#1649** (rebased, finished): the row is drawn at the click (`pending` -> `sending` -> settled by the POST reply or the frame, on the server's `createdAt`) - see (C) |
| 3 | A salon is re-read once per seed the drain brings | 26 reloads, 52 requests, 14 for one salon, in 1.8 s | `announceGraineRepair` on every stored seed | **#1785**: held for the drain, 3 reloads |
| 4 | Communities load one after another | 21+ serial requests, 2.87 s before `communities/channels loaded` (the unread counts wait for it) | `executeWorkspaceLoadAttempt` awaited each community's chain before the next | **#1786**: side by side, cost = the longest chain |
| 5 | `user-members` N+1 per connection | 81 serial `304`s, 5.0 s | `removeStrayLeaves` reads each held group's roster | Open: a batched roster endpoint (finding D of the first audit) |
| 6 | Encrypted checkpoint per single-frame drain | log 1: 25 in 88 s (78-395 ms); log 2: **10 in 2 min, 79-242 ms, none for a visible change** | `onBulkIngestEnd` checkpoints any drain | Open, a durability decision (finding 2-3 of the performance audit, PR #1776): what losing an application-only ratchet advance costs once the frame is acked |
| 7 | 83 frames for 7 DMs drained before the restore, then replayed as duplicates | 83 refused + 80 `Duplicate delivery` + 80 `RUST::DEBUG` lines | The drain starts before `loadExistingConversations` has the rows | Taken by the latency work (`perf/notified-message-after-seed`, phase-1 re-fetch) |
| 8 | Archive catch-up spins a WASM client per conversation | 7 loads of the 10 MB state, 6 `.wasm` fetches, 4 worker spawns | Each catch-up decrypt builds its own `WasmMlsClient` in a worker | Open: measure the per-load cost on a phone before touching it |
| 9 | Key-distribution groups asked twice per connection | 16 requests, 8 repeated, ~1 s apart | Both sweeps call `reconcileAbsentLocalGroup`, which reads the row EVERY time by design (`groupLifecycle.ts`) | Open (finding F of the first audit): one answer shared by the two sweeps of ONE pass, never across passes |
| 10 | Avatar 404s | 17 of 50 on opening one salon | Only MiGallery knows who has a photo | Open (finding E of the first audit) |
| 11 | Svelte `derived_inert` warning | 2 at 17:11:30.398 | A derived read after its effect was destroyed | Open, noise - to be traced |
| 12 | Past-epoch frames on the key group | 11 `unreadable for good` | A member sent 3-20 epochs behind | Handled by design |

**Log 2, the key-group chatter.** In 115 s: 10 frames on the community key group `1b1687d0`, each its
own drain and checkpoint. One requester sent 4 requests in 1.6 s (`bytes=365`): the first sealed at
epoch 168 while the group was at 171 (`Past-epoch ... unreadable for good`, dropped by every member),
then 3 readable ones - one answered by this device ("answered ... with 2 seed(s)"), two by another
member, whose bundles were broadcast and arrived here as `absorbed 0/2 (2 already held)`. **Not a
proven re-ask loop**: `repair.ts` asks a session once per app session (`asked`), re-asks only when its
key group catches up past the epoch it was sealed at (`askedOn`, which explains the first repeat),
and sends one request per (salon, answerer) - which explains three readable requests to two
answerers. Whether two of them named the same sessions cannot be read from the receiving side; the
requester's own console would say. The broadcast answers are #1768's (unreleased). The 10
checkpoints are finding 6.

## (B) What a start loads, classified, and the plan

| Item | Class | Evidence | Plan |
| --- | --- | --- | --- |
| token refresh, MLS state load, socket | before first interaction | 0.29 s to `MLS ready`, 0.60 s socket | keep |
| `users/batch`, `announcement`, `notification-preferences`, `sessions/current/device`, `unread-counts` | before / just after | 60-290 ms each, in parallel | keep |
| queued frames (1004) and their drain | needed, size is the defect | 4.2 s, 73 % already-held seeds | **#1768** (release owed) |
| community load (`distribution-group` + roster audit + `user/me` per community) | needed for the sidebar, roster audit only for sending | 2.87 s serial | **#1786** (parallel); the roster audit could leave the load's critical path entirely - next step |
| salon history re-reads on new seeds | after; duplicate | 26 for 3 salons | **#1785** |
| archive catch-up (`history/batch`) | after | 2 requests, then 7 WASM client loads | keep; measure finding 8 |
| `removeStrayLeaves` (`user-members` x81) | after, background; cacheable (all `304`) | 5.0 s serial | server batch endpoint |
| key-group sweep (`mls/groups/<id>` x16) | after; half duplicate | 8 repeated | one answer per pass |
| KeyPackage census / publish | after | 1 publish | keep |
| avatars | on demand (the salon opened) | 50, 17 `404` | needs "has a photo" on the user record |
| emoji SVGs | on demand | 8, from cache | already lazy |
| pdf.js worker | on demand | 0 in this log (no PDF on screen) | already lazy; one shared worker since #1771 |
| WASM module | before (MLS) | from cache, 0 ms | keep; preload is WP-W2 |
| calls code (`CALLS_ENABLED = false`) | never, today | static import (performance audit #15) | recorded there: parse time is measured before any split ([cold-start](cold-start.md)) |

## (C) The send delay, and the verdict on an optimistic row

**Where the 6.1 s went** is finding 2. A DM or group message was never the problem: it is drawn at
the click (`[ADD_MSG]` +3 ms, bubble ~+120 ms on the Mi 9T, measured by the latency work), and its
durable outbox entry is written in the same transaction. **Only salons waited for the server.**

**Verdict: an optimistic row is right, and it is what #1649 builds** - with the rules this repository
holds: the row is memory only and keyed by the client UUID sealed inside the ciphertext; it is
re-keyed IN PLACE to the server's row id by whichever answer comes first (the POST reply or the
`channel.message.created` frame, from the author only), so the server row is never drawn twice; a
refusal WITH a status is `error` with Retry/Delete; a throw with no status is an unknown outcome and
stays `sending` until the frame or a history load settles it (no clock, and no retry that could post
twice while the server does not dedupe on the client id); the text is kept in a small ledger across a
kill. Added on 2026-10-12: the settled row takes the server's `createdAt` and moves to its place by
it, so it sorts and anchors "seen by" on the clock every other device uses. **Not built**: a durable
salon queue and server idempotence (WP-OFF-3), so an offline salon send still needs the member to
press Retry ([offline-and-weak-network](offline-and-weak-network.md)).

**What the row does not remove**: the acknowledgement still waits for the seed distribution when the
key group has just moved. Running the seed's `mls/send` and the message's POST side by side would let
a reader receive a row before its seed - a race that heals, which is still a defect
([durable-rules](../durable-rules.md)) - so the two stay in series.

## How to re-measure

```sh
grep -c "absorbed .* already held" console.log              # finding 1: expected near 0 once #1768 ships
grep -E "\[SEND\] handleSendChat:|ADD_MSG" console.log       # finding 2: the two lines within ~0.1 s
grep -cE "GET /api/channels/[^/]+/messages" console.log      # finding 3: one per salon per drain
grep -E "WORKSPACE-LOAD\] communities" console.log           # finding 4: vs the first distribution-group line
```
