# Weak-network audit, second pass: every screen's round trips, measured on dev - 2026-11-10

> **Request (owner, 2026-11-10, `1.6.9`):** *"les performances de l'app sont toujours nulles avec une
> connexion mauvaise. Pas que les messages lents, mais lenteur dans toute l'app. Peut-etre du
> parallelisme manquant."* The weak-network audit was closed on 2026-10-14; **the owner reopened it
> on this date.** The first pass is [offline-and-weak-network](offline-and-weak-network.md) (the send
> path, the cold start, the outbox); this page is the SCREENS: what each one waits for on a slow
> link, which waits are serial without needing to be, and what was fixed.

**The rule this page applies.** On a weak link the cost of a screen is *latency x the number of
SERIAL round trips*, not bytes: at 500 ms RTT every `await` that does not need the previous answer
costs half a second. So each screen below is counted in round trips (RTT) to its first usable paint
and to quiet, and each serial chain is named by its cause (file:line).

## 1. Method, and what it cannot see

- **Estate:** `dev.canari-emse.fr` (`1.6.9-alpha.8`), never production. One harness Chrome profile
  already signed in on dev with a sandbox account (4 communities, ~15 conversation rows, small
  histories), driven over raw CDP by a throw-away probe: `Network.emulateNetworkConditions`
  (**500 ms latency, 50 kB/s each way**, a bad-3G link) and `Debugger.setAsyncCallStackDepth` so
  each request carries its async initiator stack. Unthrottled runs give the shape at zero latency.
- **Navigation is client-side** (a link click, as a tap would), the HTTP cache warm (the native app
  embeds its frontend, so a cold HTTP cache is a web-only cost, covered by the first pass).
- **"Depth" is inferred:** a request is one level below another when it starts within 80 ms of that
  one's end. A coincidence can inflate it, so every chain this page calls serial was confirmed from
  its initiator stack and then from the code.
- **Blind spots:** CDP does not shape the gateway WebSocket; the sandbox account has 4 communities
  where the owner's has ~10 and ~45 conversations, so the per-community and per-group costs below
  are measured per unit and multiplied, never assumed; Android's `plugin-http` is invisible to CDP
  (the owner's in-app log of `1.6.9`, read by the lead, stands in for it - section 4).

## 2. Per screen, measured (500 ms RTT, 50 kB/s, warm cache)

| Screen | API requests | First usable paint | Serial RTTs to paint | Quiet after | Serial RTTs to quiet |
| --- | ---: | --- | ---: | --- | ---: |
| **Cold start** (reload `/chat`) | 72 (+ presence) | list at **3.1 s** (shell 1.6 s) | 3 (document, `auth/refresh`, first reads) | **11.6 s** | **15** |
| Feed - Associations | 12 | 0.35 s (stored page) | 0 | 1.3 s | 2 |
| Feed - Pour toi | 9 | 0.6 s skeleton, cards 1.4 s | 1 | 1.7 s | **3** |
| Feed - Campus | 3 | 1.5 s | 1 | 1.0 s | 1 |
| Notifications | 3 | 0.3 s (stored) | 0 | 0.9 s | 1 |
| Associations directory | 1-2 | 0.8 s | 1 | 0.6 s | 1 |
| **An association's page** | 7 | 3.3 s | **2** | 3.8 s | **3** |
| Bookings | 3 | 0.6 s (spinner before) | 1 | 1.1 s | **2** |
| Agenda | 2 (+3 media) | 1.5 s | 1 | 1.4 s | 2 |
| Communities rail | 0 | 0.2 s | 0 | - | 0 |
| Open a DM / group | 2 | 0.2 s (local) | 0 | 0.65 s | 1 |
| Open a salon (not yet loaded this session) | 5 | 0.65 s (messages) | 1 | 2.3 s | **4** (background key-group chain) |
| **A person's profile** | 8 | 2.0 s header | 1 | **4.2 s** | **5** |
| Own profile | 7 | 1.4 s | 2 | 2.0 s | 2 |

Asset weight on the FIRST web visit of a screen (route chunks, unthrottled run): Feed 121 kB in 32
files, Bookings 61 kB, Notifications 15 kB, a profile 21 kB - 1-2.5 s at 50 kB/s, once per session,
web only. A first DM open also fetches `emoji-data-fr.json` (68 kB, 1.4 s at 50 kB/s), off the
critical path. The feed's first visit pulled a **1.16 MB** `GET /api/media/<id>` (a post's full
image), 23 s of the whole pipe at 50 kB/s - R11 of the first pass (no thumbnail variant of an
encrypted image), still the largest single cost on a thin link.

**What the table says.** Every screen whose data is stored on the device (feed, notifications,
conversations, communities) paints in 0-1 RTT: the local-first work holds. The slowness the owner
feels is (a) **the boot**, 15 serial round trips that keep the link busy for ~12 s after the list is
drawn, and everything tapped during that window queues behind it; (b) **the screens that still
chain reads that need nothing from each other**: a profile (5), an association (3), Pour toi (3),
bookings (2).

## 3. The serial chains, and their causes

### 3.1 The boot (cold start, 15 levels)

Levels as measured, with the code behind each:

```
 1.7 s  L1  POST auth/refresh ................................ the session
 2.2 s  L2  workspaces/user/me, users/batch, announcement, help-seen, birthday, avatar-presence,
            devices/<self> (isDeviceRevoked)
 3.1 s  L3  per community: workspace/:id/user/me (salons) || workspaces/:id/distribution-group
            notification-preferences, sibling-status, sessions/current/device, birthdays/today
 3.9 s  L4  per community: workspaces/:id/members (key-group roster, needs the group id)
            avatar-presence x4 (SAME ids)  <- cause 3.3
 4.5 s  L5  per key group: POST groups/:id/revoked-leaves
 5.1 s  L6  devices/<self> again (fetchPrekeyCount), members?presence=1, unread-counts (2nd)
 5.9 s  L7  POST register-device
 6.4 s  L8  devices/<self> a third time (listOwnPrekeys), users/<id>/groups
 7.2 s  L9  POST group-rosters (stray-leaf sweep, one batched read)
 7.8 s  L10-L13  GET groups/:id  x4, ONE AFTER ANOTHER  <- cause 3.2
10.4 s  L14 invitations/pending, users/<id>/groups (discovery), POST graine/live-sessions
11.0 s  L15 users/<id>/dismissed-groups  <- cause 3.4
```

The list is drawn at L2-L3 (3.1 s); L4-L15 are background, but at 50 kB/s and with requests
queued behind each other they are what a tap during the first ten seconds waits behind.

### 3.2 FIXED - every key group's server row was read one at a time, at every connection

`forgetGroupsAbsentFromServer` (`utils/chat/groupSweep.ts`) walks the local MLS groups the server's
`getUserGroups` did not name and asks `reconcileAbsentLocalGroup` -> `GET /api/mls/groups/:id` for
each, **awaiting each before the next**. Every community's and private salon's key-distribution
group is excluded from `getUserGroups` by construction, so this list is one entry per community at
EVERY connection: 4 reads = 2.6 s here, and **N x RTT** in general - ~10 communities = 5 s at
500 ms. The sibling loop in `discoverMissingGroups` (`utils/chat/actions.ts`, one status read per
absent conversation row) had the same shape.

**Fix:** the reads are independent questions (no MLS state touched), so they are now asked
together, at most `NETWORK_READ_CONCURRENCY` (6) at once - `forEachBounded` and the constant in
`utils/boundedConcurrency.ts`, ONE bound shared by the history elections, this sweep and discovery -
and the answers are ACTED on one by one in the original order: every forget, purge and retirement
stays sequential. **Saving: N - ceil(N/6) RTT per connection** (3 RTT = 1.9 s on the bench account,
~8 RTT = 4 s on a ten-community account).

**Every item runs.** `forEachBounded` catches per item, logs it with the item's id and returns the
failures once every item has settled - so one read that throws never stops the others, and nothing
is still running after the pass resolves. Each caller decides what a failure costs: the sweep KEEPS
a group whose read threw (forgetting is destructive and is done only on an answer), the history pass
leaves the group owed for the next connection, and discovery rethrows at that conversation's turn,
where its sequential loop threw. Discovery does not ask about a dismissed conversation (it is purged
unasked), and a row that arrives during the reads is asked at its turn in the loop.

Tests: `boundedConcurrency.test.ts` (the bound after every release, item 2 of 5 throwing while 3-5
still run, nothing settles early), `groupSweep.test.ts` (all four on the wire before the first
answer, forgets in snapshot order when answered in reverse, the bound after every release, a thrown
read keeping its group), `actions.discovery.test.ts` (concurrent status reads, a dismissed row never
asked, a late row asked once).

### 3.3 FIXED - `avatar-presence` asked five times for the same faces

`avatarPhotoPresence` (`utils/avatarPresence.ts`) coalesces the ids asked in ONE turn of the event
loop and remembers ANSWERS, but had no memory of a request in flight: the conversation tiles, the
members list and the salon rows mount in separate turns, so each turn opened its own request for the
same ids. Measured: 5 identical requests in 30 ms, answered at 4.3, 4.8, 5.4, 6.0 and 6.6 s on the
thin link. The owner's log counted **568** `avatar-presence` in 4 days.

**Fix:** an in-flight map per id: a face asked while its answer is on the wire joins that request.
The entry lives exactly as long as the request (no clock); a reader change drops it and an answer
asked for the previous reader is never remembered for the next. **Saving: 4 requests per boot, and
the 2.3 s their serial answers occupied.** Tests: `avatarPresence.test.ts`.

### 3.4 FIXED - the dismissed-groups read waited for the group list

`discoverMissingGroups` read `users/:id/groups` and only then `users/:id/dismissed-groups`, though
the second needs nothing from the first. It now leaves beside it, and is consulted only when the list
may be believed, as before. **Saving: 1 RTT at the end of every discovery.**

Starting it early must not make a dead link noisier: the read used to warn on its own failure, so a
boot whose group list failed too would warn about a list nothing reads. It now returns a typed
`DismissedGroupsRead` (`listed` / `refused` / `failed`, the last saying whether it was a transport
failure) and logs nothing; discovery says the failure on the branch that uses the list - a refusal
or an unexpected failure at warn, a dropped link at debug. Tests: `mlsDeliveryApi.dismiss.test.ts`,
`actions.discovery.test.ts` (no line on a dead link, one line for a refusal).

### 3.5 FIXED - a person's profile was five round trips deep

`routes/profile/[id]/+page.svelte` awaited the profile, then `memberships`, then `role-history`, then
`parrainage`, each after the previous: memberships at 2.5 s, role history at 3.1 s, the entourage at
3.6 s, the badges after that at 4.2 s. The three reads need only the id, so the page loads through
`readProfileWithExtras` (`lib/profile/profileExtras.ts`), which sends them BEFORE the profile read by
construction; the page applies them once the profile is in. **Saving: 3 RTT (~1.6 s) per profile
visited.** The cost, taken knowingly: a profile that turns out unreadable, or a page left before it
answers, has spent three small reads whose answers are dropped. Tests: `profileExtras.test.ts` (the
three extras on the wire while the profile read is held unanswered).

### 3.6 FIXED (server) - `POST /mls/push/register` shared ONE rate-limit bucket with the whole estate

The owner's log: `[Push] FCM token registration failed HTTP 429` three times in 5 s at a cold start.
The client does not register more than once per start in parallel (`registerPushToken` joins the
request in flight); three callers (`+layout.svelte`'s effect, `sessionAuth.ts:2084`,
`promoteOfflineSession.ts:118`) each RE-register after a failure, which is what turned one 429 into
three. The 429 itself is the server's: the route used the stock `ThrottlerGuard`, which keys on
`req.ip` - and chat-delivery is only reached through the nginx container, so `req.ip` is nginx for
EVERY request (`client-ip-throttler.guard.ts` says so). Its quota, 10 a minute (`app.module.ts`),
was therefore one bucket for every phone of the estate: a few phones starting in the same minute
were enough. Other session routes and the two shut-phone reports (`blind-banner`, `channel-read`)
sat on the same bucket.

**Fix:** a throttler counts on the key the guard BEFORE it proved. A session route counts per user
(`@UseGuards(HeaderAuthGuard, UserThrottlerGuard)`, the pair `/mls/send` already used); the two
shut-phone reports count per user after their push secret is proven (`@UseGuards(PushSecretGuard,
PushSecretThrottlerGuard)`, as `wake` and `key-group-join` do - the handlers no longer re-check the
secret); only a route that proves nobody (the GIF relay) counts per address. Every throttler guard
refuses through one `refuseThrottled` (`guards/throttle-refusal.ts`): a coded `429` and a
`[THROTTLE] REFUSED` line. `throttle-keys.spec.ts` reads every controller `AppModule` mounts and
asserts that no handler names the stock guard and that each throttler follows its prover, and drives
each of the three guards to its refusal. **Owed:** one production read of the `[THROTTLE] REFUSED`
rate after the release.

### 3.7 NOT FIXED here, described - the chains left

| # | Chain | Cause | Fix designed | Saving |
| --- | --- | --- | --- | --- |
| C1 | Bookings: `managed` after `mine` + `spaces` | `EditBookingsTab.svelte:50` reads `listManagedSpaces` in its own mount, and the tab is mounted only when the page's two reads ended (`routes/bookings/+page.svelte`, `{#if loading}`) | start `listManagedSpaces` in the page's `load()` beside the other two and hand the rows to the tab. **The booking planner is being edited in parallel; left to that work** | 1 RTT |
| C2 | Pour toi: `posts` -> `follow-statuses` + `blocks` + `users/batch` + `avatar-presence` -> avatar | the cards decide who to resolve from the page's answer; `blocks` needs nothing from it | read `users/me/blocks` once per session with the feed request (it is the reader's own list), and have `GET /api/posts?feed=foryou` carry the follow status of its authors. **Feed cards are being edited in parallel** | 1 RTT |
| C3 | An association's page: `slug/:slug` -> {members, products, partnerships, follow-status} -> `bells/association/:id` | every sub-read is keyed by the id the slug read returns; the bell mounts after the follow status | sub-routes that accept the slug, or one `GET associations/slug/:slug?include=...`; mount the bell beside the follow status | 1-2 RTT |
| C4 | Boot: `devices/<self>` read three times in series (`isDeviceRevoked`, `fetchPrekeyCount`, `listOwnPrekeys`), `register-device` between the 2nd and 3rd | the key-package publication path asks the server what it just learnt; MLS code, not touched in this pass | one read whose answer the publication path carries to its two later questions; or `register-device` answering the published count | 2 RTT |
| C5 | Boot: per community `distribution-group` -> `members` -> `revoked-leaves` (3 levels, ~10 communities at once) | the key-group roster pass needs the group id, then the roster, then asks which leaves are revoked (`rosterReconcile.ts`) | a server bulk read, "my communities with their key-group refs and rosters", in ONE request; the salon rows already do not wait for it (F3, [community-open-budget](community-open-budget.md)) | 2 RTT and ~30 requests per boot |
| C6 | Salon open: `members?presence=1` -> `distribution-group` -> `mls/send` x2 after the messages | the departure committer / seed path after the page | background, not on the paint path: left | - |
| C7 | `users/batch` and `avatar-presence` fired in pairs for the same ids (271 and 568 in the owner's log) | two questions about one face, two endpoints | `users/batch` answers `hasPhoto` in each profile; `avatar-presence` remains for the faces with no profile read | 1 request per face batch |
| C8 | Feed form cards: `GET /api/forms/:id` + `/check` per card (~127 each in the owner's log) | one card, two reads, per form (`forms/api.ts:526`) | the post's feed row carries the form summary and the reader's answer state | 2 requests per card |

## 4. The lead's field evidence (owner's Android `1.6.9` log, production nginx), read against the code

1. **Fan-out at boot** (`avatar-presence` 568, `users/batch` 271, per-community triplet ~210 each,
   `sibling-status` 171, `unread-counts` 185, forms ~127 x 2). On the critical path to the first
   paint: none of them - the list is drawn from the device before the per-community calls answer
   (F3). They compete for the pipe the taps use. Fixed here: the `avatar-presence` duplicates (3.3).
   Designed: C5 (one bulk read for the per-community triplet), C7, C8. `unread-counts` was measured
   TWICE per boot on dev (L3 and L6): the second caller asked after the first had ANSWERED, which
   the in-flight join of [section 19](offline-and-weak-network.md#19-wp-w4-second-part-unread-counts-is-one-request-per-boot-ordered-after-the-read-mark-flush-2026-10-19)
   does not cover by design (an answer older than the caller's own read-mark flush may re-raise a
   badge); a count stamped with the read-mark tick it was computed after would let the second
   caller reuse it - designed, not built. `sibling-status` is one per start: expected.
2. **`[HISTORY] no answer for group X - empty page`, one line per group (45 and 36 in a minute) when
   the link drops.** `MlsDeliveryApi.fetchHistory` logs each transport failure per group; when the
   link drops with a restore pass in flight, every per-group read fails at once. The pass already
   stops on a link KNOWN down ([section 20](offline-and-weak-network.md#20-a-catch-up-that-gets-no-answer-stops-and-the-mailbox-is-owed-to-the-reconnect-2026-10-30)),
   and its residual is exactly this: it does not stop MID-LOOP. Designed: the per-group reads of a
   restore go through `forEachBounded` and the first transport failure stops the queue (the rest
   owed to the reconnect, the way the batch already does), one line per pass. Not built here: it
   changes the history restore.
3. **`POST groups/:id/revoked-leaves` bodies buffered to a temp file by nginx, and one address
   posting it 3 times per group in a minute for ~24 groups.** From the code: ONE device asks once
   per key group per session - the roster pass is serialised per scope and `askRevokedLeaves`
   (`rosterReconcile.ts`) reuses the answer while the tree's leaves are unchanged; on dev each of
   the 4 key groups was asked exactly once per boot. So three per group per minute is **three
   sessions behind one address** (devices on the campus network share it, and every cold start is
   a new session: the reuse is memory only), not a client loop. **The body is large by design:**
   it lists every leaf identity of the key group (`userId:deviceId`, up to 1000 per request,
   `REVOKED_LEAVES_MAX_IDENTITIES`) - a community of a few hundred devices is tens of kB, over
   nginx's client body buffer. Designed: the server answers `GET groups/:id/revoked-leaves` with the
   revoked devices it knows among that group's members (a short list, usually empty) and the client
   intersects it with its tree locally - same allowlist semantics, a body of bytes instead of the
   tree. Its reuse could then be keyed durably by a server revocation cursor rather than by the
   session. `POST graine/live-sessions` is buffered for the same reason (it lists the sessions the
   device holds).
4. **FCM registration 429 x3 in 5 s** - fixed server-side, 3.6.

## 5. Ranked fixes

| Rank | Fix | State | Expected saving at 500 ms RTT |
| --- | --- | --- | --- |
| 1 | Key-group and absent-conversation status reads together (3.2) | **built** | N - ceil(N/6) RTT per connection: 1.9 s (4 communities), ~4 s (10) |
| 2 | Push register and the reports off the estate-wide rate bucket (3.6) | **built** | removes the 429 at cold start |
| 3 | Profile extras with the profile (3.5) | **built** | 3 RTT, ~1.6 s per profile |
| 4 | `avatar-presence` joins the request in flight (3.3) | **built** | 4 requests / ~2.3 s of queued answers per boot |
| 5 | Dismissed list beside the group list (3.4) | **built** | 1 RTT per discovery |
| 6 | C5: one bulk read for the per-community key-group triplet | designed | 2 RTT and ~3 requests per community per boot |
| 7 | R11 (first pass): an encrypted thumbnail variant for post and chat images | designed (WP-W7) | MBs per feed screen on a thin link |
| 8 | C4: the key-package path reads its own device list once | designed | 2 RTT per boot |
| 9 | C1, C2, C3 (bookings, Pour toi, association page) | designed; C1/C2 sit in components other work is changing | 1-2 RTT each |
| 10 | History restore stops on the first transport failure mid-loop (section 4.2) | designed | N warn lines and N dead requests per drop |
| 11 | `revoked-leaves` as a short server answer (section 4.3) | designed | a tree-sized body per key group per session |
| 12 | C7, C8 (profile + photo in one read; form summary in the feed row) | designed | 1-2 requests per face batch / per form card |

**Expected boot after the built fixes, same bench:** 15 -> 11 serial levels (-3 for the status
reads, -1 for the dismissed list), settle ~11.6 s -> ~9 s; on a ten-community account the status
chain alone was 10 levels and is now 2.

## 6. How to reproduce

A CDP client (no Playwright): attach to a dev page of a signed-in harness profile, `Network.enable`,
`Debugger.enable` + `Debugger.setAsyncCallStackDepth {maxDepth:16}` (the initiator stack names the
caller), `Network.emulateNetworkConditions {latency:500, downloadThroughput:51200,
uploadThroughput:51200}`; for each screen, click a link (`a.href = path; a.click()` - SvelteKit
routes it like a tap), record `requestWillBeSent` / `responseReceived` / `loadingFinished`, and stop
when no request but `POST /api/presence` (a 10 s heartbeat) has been in flight for 3.5 s. Depth =
the longest chain of requests each starting within 80 ms of the previous one's end, confirmed from
the stacks. A reading after a release is the same run: the boot's level count and the four tables
rows marked fixed are the numbers to compare.

## 7. Related

- [offline-and-weak-network](offline-and-weak-network.md) - the first pass: sends, the outbox, the
  cold start, deadlines.
- [community-open-budget](community-open-budget.md) - the community open, measured on the Mi 9T.
- [local-first-ui](local-first-ui.md) - why the stored screens paint in 0 RTT.
- Backlog: [weak-network-audit-2-what-is-left](../backlog.d/weak-network-audit-2-what-is-left.md).
- The chantier it opened (owner, 2026-11-10, after `1.6.10`):
  [slow-link-local-first-chantier](../backlog.d/slow-link-local-first-chantier.md).
