# Backlog

Work that is **not** an open Work Package: nothing here is scheduled, and nothing here blocks the
current campaign. A Work Package is opened from an item here only when someone decides to do it, or
when a check fails and produces a captured log.

Severity uses the repo scale: **P1** security, or a user-facing path that is broken - **P2**
correctness, nothing at risk - **P3** hygiene. An item with no severity is a QUESTION, not a defect,
and its first task is to answer the question rather than to write code.

Each entry states what is known, so that picking it up does not start with a rediscovery. Delete an
entry outright when it ships: the rule goes to [durable-rules](durable-rules.md), the story to
`CHANGELOG.md`.

---

## Security - blocked upstream

### P2 - `libcrux-chacha20poly1305` panic on an overlong ciphertext buffer, in the MLS path

**The only one of the 16 open Dependabot alerts that reaches attacker-controlled input on a path that
matters.** `frontend/mls-wasm/Cargo.lock` pins 0.0.7; the advisory is fixed in 0.0.8. It arrives
transitively as `openmls_rust_crypto` → `hpke-rs` → `hpke-rs-libcrux` → `libcrux-aead` →
`libcrux-chacha20poly1305`, i.e. it IS the HPKE half of the MLS crypto provider, and it processes
ciphertext supplied by whoever sends this device a frame. A panic there kills the MLS client inside
the WASM module. Availability, not confidentiality - no key material is exposed.

**It cannot be bumped today, and this was tried rather than assumed.** `libcrux-aead 0.0.7` pins
`libcrux-chacha20poly1305 = "=0.0.7"`, and a `0.0.x` requirement is exact in Cargo semver, so the
whole chain has to move together:

| crate                      | locked | needed | available                                            |
| -------------------------- | ------ | ------ | ---------------------------------------------------- |
| `libcrux-chacha20poly1305` | 0.0.7  | 0.0.8  | yes                                                  |
| `libcrux-aead`             | 0.0.7  | 0.0.8  | yes                                                  |
| `hpke-rs-libcrux`          | 0.6.1  | 0.7    | yes                                                  |
| `hpke-rs`                  | 0.6.1  | 0.7    | yes                                                  |
| `openmls_rust_crypto`      | 0.5.1  | 0.6    | **release candidates only** (0.6.0-rc.1, 0.6.0-rc.2) |

So closing this alert means shipping a release candidate of the MLS crypto provider. That is not a
dependency bump, it is an openmls provider upgrade with a full MLS re-verification behind it, and it
must not ride along with anything else.

**Re-check when `openmls_rust_crypto 0.6.0` goes stable** - that is the whole condition. Until then
the alert stays open on purpose, and the reason is here rather than in somebody's memory.

---

## Reported by users - to reproduce first

### P1 - a community whose only channel is left becomes unmanageable

> _"il se passe des trucs bizarres quand je cree une communaute et que je quitte son unique salon. Je
> ne peux plus rien gerer dedans apres, meme la quitter."_

Leaving the last channel of a community appears to remove the surface that carries the community's
own controls - including _leave the community_, so the state is not recoverable by the user. That is
a user-facing path that is broken and it traps whoever hits it, which is what puts it at P1.

The first task is a REPRODUCTION, not a fix: it decides whether the community is genuinely
unreachable server-side (a membership row lost with the channel) or merely unrendered (the UI hangs
the community's controls off a channel that no longer exists). Those are different defects in
different layers and only one of them needs a migration.

### P2 - commenting a GIF on a post fails

> _"On ne peut pas commenter un gif sur un post (le bouton est la, mais les requetes echouent j'ai
> l'impression."_

A control that is present and does nothing. Capture the failing request first - a 4xx from validation
and a 5xx from the media path are different defects, and the button's presence says the client
believes the feature exists.

### P2 - the same person shows three different profile pictures

> _"Quelqu'un me dit qu'il a une photo differente sur Canari sur son PC, son telephone, et sur
> MiGallery."_

Three surfaces disagreeing means the cache key does not change when the picture does. The question to
answer FIRST is what the current cache lifetime actually is and where it is set - HTTP headers at the
media service, a service-worker cache, the client's own store, or all three - because a lifetime is
not a bug and a missing invalidation is. MiGallery is a separate origin with its own cache, so it
also establishes whether the URL itself is content-addressed.

### P2 - the message hover bar is too wide on desktop, and the sidebar takes its clicks

Reported by a user as "the end is unreachable when the window is half the screen". **Measured on
2026-08-15, and it is worse than that: the strip is laid out beyond the pane's own left edge, over
the sidebar, which then receives the clicks aimed at it.** Not a race - the same geometry every time.

`MessageBubbleToolbar.svelte` positions itself `absolute ... right-full mr-2` for an own message,
so the whole strip sits OUTSIDE the bubble, to its left, and nothing bounds it by the pane. It is
383 px wide (six quick emoji, a divider, up to six icon buttons), and it needs
`paneWidth - bubbleWidth >= 391`. One message, four viewport widths, sidebar 392 px:

| viewport | pane | bubble | toolbar x | pane x | reachable |
| --- | --- | --- | --- | --- | --- |
| 958 x 944 | 566 | 210 | 329 | 392 | **no** - 54 px into the sidebar |
| 1024 | 632 | 210 | 395 | 392 | yes, by 12 px |
| 1280 | 888 | 210 | 651 | 392 | yes |
| 1600 | 1208 | 210 | 971 | 392 | yes |

At 958 px, `elementFromPoint` at the heart button's own centre returns a **sidebar conversation
row**, not the button. So the reaction is not merely hard to reach - clicking where it is drawn hits
the conversation list, and on a narrow window that means switching conversation.

**Only the own-message direction is measured.** A peer's message puts the strip `left-full`, and
there it is 323 px and reachable at 958 px in a DM (MUT-21 measures both). MUT-9 fails in a CHANNEL
with "nothing is there" - the point outside the viewport rather than covered - and that is a
different symptom whose cause is not yet measured; a channel toolbar carries pin and moderate on top
of the rest, which is a hypothesis, not a finding.

**The threshold is not a single width**, which is why it reads as intermittent: it is
`paneWidth - bubbleWidth < 391`, so a long message overflows on a screen where a short one does not.

**FIXED 2026-08-15 by a placement change, not a breakpoint** - a breakpoint would answer a question
about the viewport, and the question was never about the viewport. The strip now anchors ABOVE the
bubble on its outer edge (`bottom-full right-0` / `left-0`) and extends inward, which removes the
bubble width from the condition entirely: it can only overflow if the strip is wider than the PANE,
which no message can cause. Measured in the live page before being written: a middle row fits with
zero overflow either side. Its cost, also measured: the strip is clipped by the scroller for
whichever row sits within ~46 px of the pane's top edge - one row at a time, back with the smallest
scroll. Recorded rather than hidden.

**It blocks five MUT checks** (MUT-9, MUT-11 both transports, MUT-12 both transports) whose subject
is mutation, not layout: they cannot click a reaction at all at the harness's launched width. That
is what surfaced it - the checks used to dispatch blind, so the click landed in the sidebar and the
reaction silently never happened. They now run inside a stated viewport override, and **MUT-21 owns
the defect at the launched width so the override has an expiry**: the day MUT-21 passes, every
`withToolbarRoom()` call site can be deleted.

### P2 - a deleted message still offers the emoji picker, and using it throws

Measured by MUT-17 on 2026-08-15. `MessageBubbleToolbar.svelte` gates the quick-reaction strip on
`!isDeleted`, but the "open the full picker" (smile) button is passed on `onReact` alone, with no
`!isDeleted` anywhere in that prop's derivation. So on a tombstone the strip correctly disappears and
the picker button stays.

Observed, on the same row, in one pass: `smileOnDeletedPresent: true`,
`quickStripOnDeletedPresent: false`, `reactAttempted: true`, **`reactSucceeded: false`**, and W1
raised `TypeError: Cannot read properties of undefined (reading 'replace')` at that exact moment.
The row itself is undamaged on both clients - both show `Ce message a été supprimé.` with the
deleted styling - so nothing is corrupted; an affordance is offered that cannot work and that throws
when used.

Two things to decide together: whether the picker button should be gated on `!isDeleted` like every
other action (it should - a reaction to a tombstone means nothing), and what the `replace` is
reading, since a guard on the button would hide that crash rather than fix it.

---

## Outbound connectivity

### P2 - four projects proxy one avatar endpoint, and only Canari calls a transient blip an error

**THE IPv6 DIAGNOSIS THAT USED TO BE HERE IS REFUTED. Measured 2026-08-15 from inside the
containers, and it was wrong.** It said the host has no IPv6 route while DNS hands out AAAA, so every
avatar fetch burned a 5 s happy-eyeballs budget. The first half is true and the conclusion does not
follow:

| measurement | result |
| --- | --- |
| `ENETUNREACH` on a v6 address, from `core-service` | **0-2 ms** - the kernel answers with no packet sent |
| `GET https://gallery.mitv.fr/` default vs `family: 4` | **85 ms vs 73 ms** - the whole IPv6 tax is 12 ms |
| the real avatar endpoint, 40 sequential | **40/40 HTTP 404, median 30 ms** |
| 30 CONCURRENT, three rounds | **51-146 ms for the whole burst, no failure** |
| Immich `/api/people/<id>/thumbnail`, 15 real users | **200 x15, median 13 ms, max 80 ms** |

A failure mode costing 2 ms cannot produce a 5 s timeout. **The lesson is the measurement, not the
conclusion**: the original evidence was a `grep -c` over the whole `util.inspect` dump, where one
error object repeats its codes throughout its own graph - so "16 ENETUNREACH, 34 ETIMEDOUT" counted
an object, not events. The `AggregateError`'s own code, read properly, is `ETIMEDOUT`, twice: two
transient failures to complete a TCP connection, on a path that measures healthy in every component
now. **Every outbound dependency is dual-stacked** (gallery, Stripe, FCM, the Cloudflare API, Lydia,
`canari-emse.fr` itself), so if AAAA records were the fault it would be platform-wide - and it is
not, because the tax is 12 ms.

**What IS real, and is the actual finding.** Four projects fetch `gallery.mitv.fr/api/users/<id>/avatar`
with `x-api-key`, each having written its own failure handling:

| project | timeout | on failure |
| --- | --- | --- |
| Le Cercle (`lib/server/migallery/index.ts`) | `AbortSignal.timeout(4000)`, justified in a comment | `null` -> initials, one log line that separates *no key* / *legitimate 404* / *unreachable* |
| Canari (`core-service/users/avatar.service.ts`) | axios `timeout: 5000` | **502 + `logger.error`** |
| Sky (`routes/api/avatar/[id]/+server.ts`) | **none at all** | generated initials SVG |
| Portail-etu (`routes/api/users/[userId]/avatar/+server.ts`) | its own `GALLERY_API_URL` | separate again |

Canari is the only one that turns a transient upstream blip into an ERROR rather than degrading, and
that is the whole reason only its logs are noisy - the other three reach the same user-visible
outcome (initials) silently. **Le Cercle's is the version to copy**: a stated budget, a null return,
and a log line whose wording tells the three causes apart. Sky's missing timeout is the opposite
risk and is worth fixing on its own.

The log-volume half is already fixed: the handler used to pass the whole axios error to the Nest
logger, printing `util.inspect` of the TLS socket - about 500 lines per occurrence, 5 581 lines from
eleven incidents, enough to make the service's whole window unreadable. It now also names the user
and the destination, which makes the line partitionable by subject; it was not, which is why those
errors could never be attributed to a campaign account or to a stranger.

## Interface

### P3 - the whole mobile page is selectable

Reported 2026-08-13, seen while reading a CDP dump: a long press on the phone selects page chrome -
navigation labels, section descriptions - not just message text. Only message content should be
selectable, and arguably nothing else at all. One `user-select` rule at the layout level with an
explicit opt-in on message bodies.

### P3 - merge "Connexions actives" into "Gestion des appareils"

Two panels describe the same thing and neither is complete, so the user reads both to answer one
question. **One panel**, one row per device, carrying:

- a name that lets the reader recognise their own device - the current wording does not, and that is
  the point of the merge rather than a detail of it;
- the **last connection**, which is what "Connexions actives" was for;
- the **browser / platform**, the other half of recognising a row;
- the first characters of the device id, for debugging - a fallback for when the wording fails, not a
  substitute for fixing it.

**Drop the IP.** It is shown today and it answers nothing the reader asked: it does not identify a
device (a phone changes it between wifi and mobile data, several devices behind one connection share
it) and it is not actionable. Removing a column is part of the merge, not a separate task - the point
of one panel is that every column earns its place.

**The trap is the last-connection column, and it has already been paid for once.** A liveness clock
must be written by the thing whose liveness it measures: reusing a row's `updatedAt` once kept nine
dead devices alive for ever, because every unrelated write refreshed it. Before displaying a
timestamp, establish which column is written _by the connection_ - and if none is, the merge needs
that column first. See [durable-rules](durable-rules.md).

**The DISCONNECT half shipped on 2026-08-13 and is no longer part of this entry.** Deleting a device
now signals it over the gateway's generic control-frame path; the device confirms the revocation
against the server - a frame is a message, not an authority - and then erases itself back to a fresh
install and signs out. What remains here is the PANEL merge itself. The premise it proves is the
merge's own: one object, one state.

**Establish what a delete is supposed to reclaim before designing the panel.** Measured 2026-08-13 on
an abandoned device of a real account: 1383 undelivered rows in `queued_message`, still growing that
day because the other members kept addressing it. So the questions the merge must answer are whether
deleting purges that queue, and - separately, since nothing forces a user to delete anything - what
bounds the backlog of a device that simply never returns.

---

## Protocol and delivery

### P2 - an unresolved tab leadership is read as "another tab is the leader", and the skipped flush reschedules nothing

`[OUTBOX] Flush skipped - follower tab; asking the leader to drain the shared queue.` Seen first on
**A1** after a reload (`burn.mjs`, 2026-08-15), then on **W1** - a single-tab Chrome profile - seven
seconds into READ pass 4 (2026-08-15 06:57:12Z), at that check's `goto`.

**The second sighting answered the question the first one left open.** That question was "is the
flush merely early, or is the lock genuinely lost", and the discriminator is a companion line:
a tab that really lost the election logs `[TAB] Another tab is active - read-only mode`. W1's window
contains no such line. The flush is EARLY.

**The mechanism.** `isTabLeader` starts `false` and is set true only once `initTabLeadershipAsync`
resolves the Web Lock, so between page load and that resolution `getIsTabLeader()` answers `false` -
and `runFlush` reads that as *another tab holds leadership*. **A predicate is only evidence for the
question it was written to answer**: "am I the leader" and "has leadership been decided" differ only
in a state neither is modelling, and using one for the other is what produced this. The phone met it
first because a cold native boot widens the gap.

**Why it is P2 and not cosmetic.** The follower branch does two things and neither recovers:
`requestLeaderOutboxFlush()` broadcasts to a leader that, on a single-tab client, does not exist; and
it returns before `scheduleBackoff`, which would not have armed anything anyway - a never-attempted
entry has no `nextAttemptAt`, so the `filter(t => t > now)` finds nothing and the function returns.
The remaining triggers are `connectivity.onReconnect`, a `visibilitychange`, a peer tab's request and
the next `enqueue`. So **a message enqueued inside the boot gap can wait for an unrelated wake-up**,
because `enqueue`'s own `runFlush()` is precisely the one that gets skipped. Nothing observed has
lost a message - both sightings self-corrected, A1's went in 3 589 ms - and no check has yet been
written that sends inside the gap on purpose. That check belongs to the outbox phase, not to READ.

**The fix is a state, not a retry.** Leadership has three states and the code models two; `runFlush`
should await resolution rather than treat "undecided" as "someone else's job". A timer here would be
the pattern this area was deliberately cleared of.

**Classifier**: the skipped-flush line is now `NOTABLE` - reported in every record, never silent,
never breaking an unrelated verdict. That does not forgive a genuine leadership failure the way the
earlier note feared: such a failure also emits `[TAB] Another tab is active`, `[TAB] Race election`
or `[TAB] Promoted to leader`, none of which is classified, so all three still break `clean`.

### P3 - the composer sits behind the soft keyboard on Android

Known, reproduced by hand, never turned into a Work Package because it needs a layout decision rather
than a patch: the message composer is overlapped by the soft keyboard on some Android keyboards.

### P2 - one tab leaving marks the whole DEVICE offline, and the guard that should restore it prevents it

Found 2026-08-15 reading the gateway while refuting an unrelated fix; **not yet reproduced against a
running client**, which is what this owes before it becomes a Work Package.

Presence is keyed `user:online:{userId}:{deviceId}` - **per device, not per connection** - and two
tabs of the same browser share one `deviceId`. Two paths delete it and they disagree:

- `ConnectionGuard::drop` (`chat-gateway/src/handlers.rs`) removes THIS connection from
  `connected_users`, and if another session for the same key is still alive it logs
  `[presence] Skipping DEL ... another session is still active` and keeps the key. Correct.
- `handle_disconnect` (`chat-gateway/src/ws_dispatch.rs`), reached from the app's own
  `{"type":"disconnect"}` frame at `beforeunload`, **DELs unconditionally** - no multi-session check.

So a tab navigating away wipes the presence of every other tab on the same device, and `drop` then
runs, sees the survivor, and takes the "skip" branch - so the key is not restored by the very guard
written to protect it. Peers read the user offline until the surviving socket's next
`refresh_presence`, which rides the ping (bounded by the 15 s interval - **the exact bound is
unconfirmed and is part of the reproduction**).

Shape to note, because it is one of ours: **a column is only evidence for the question it was written
to answer.** The key answers "is this DEVICE online"; the delete is triggered by "is this CONNECTION
leaving". The fix is the same multi-session check `drop` already has, not a TTL and not a retry.

Related but distinct from [WP-OUTBOX-2](../../CLAUDE.md) - both are multi-tab, neither causes the
other.

### P2 - the inbound drain has no watchdog

The outbound side gained one; the inbound drain can still stall with nothing to notice it. Filed
rather than fixed because the termination proof matters more than the detection - a timer here would
be the pattern this area was deliberately cleared of.

### P3 - the pending pull's per-page deadline is a total, and should be a progress deadline

`BaseMlsService.fetchPendingMessages` gives each page a 10 s `AbortController` (`PAGE_TIMEOUT`), and
10 s is a number nobody can justify: it measures the TOTAL time a page takes, so it cannot tell a
transfer that is arriving slowly from one that has stopped arriving at all. That is the wrong
question - what a caller actually wants to know is whether anything is still coming.

**The right form is a progress deadline: abandon only when NOTHING has arrived for N seconds.** It
is honest at any page size and any link speed, it needs no calibration, and it is the shape the
standing directive asks for - deterministic and explicable rather than a tuned constant.

Why it was not done on 2026-08-13, stated plainly as an accepted imperfection rather than a settled
detail: it requires reading the response body as a STREAM (`res.body.getReader()`, resetting the
timer on each chunk) instead of `await res.json()`, and the two fixes that shipped that day
already removed the failure the deadline was masking - the server's byte-bounded page
(`PENDING_PAGE_MAX_BYTES`), and the client halving its request when a page does not arrive. With pages
bounded at a megabyte, the deadline is a hang-guard and nothing more.

**So this is not urgent, and it is not closed either.** Whoever picks it up should also decide
whether the halving ladder still earns its place once progress is measured directly: they answer the
same question by different means, and keeping both may be one mechanism too many. The reasoning
behind the fix that shipped is in
[history-reconciliation](protocols/history-reconciliation.md) and the constants carry their own
justification in `apps/chat-delivery-service/src/retention.constants.ts`.

### P2 - a reaction to your message is delivered down the POSTS pipe, and inherits none of a message notification

Found by MUT-13 on 2026-08-15, first run. `messaging.controller.ts` `POST mls/notify-reaction` sends
`{ type: 'social', deepLink, groupId }` - the same `type` a post like or a comment uses - and
`sendPushToUser` merges only `title` and `body` onto it. **The payload carries no sender id, no
message id and no avatar URL**, so nothing downstream could render an avatar even if it wanted to.

`type: 'social'` then decides everything, and each consequence is a separate defect wearing one
cause. In `CanariFirebaseMessagingService.kt`:

- **It fires while you are looking at the conversation.** The foreground guard excludes `social`
  deliberately and correctly - a pure notification touches no `mls.bin`, so it must not be dropped
  with the MLS work - but `showSimpleNotification` then has no foreground check of its own, unlike
  `showNotification`, which suppresses itself outright. So reacting to a message in an open chat
  posts a system notification about a bubble already on screen.
- **It can never be dismissed.** `showSimpleNotification` takes a fresh
  `notificationIdCounter.incrementAndGet()` and retains no handle or tag, where a message uses
  `getStableNotifId(groupId)`, persisted in SharedPreferences, which is what
  `cancelConversationNotification` cancels on read, on quick reply, and on the silent FCM another
  device sends. None of those can reach a reaction. **And the clear-on-open sweep excludes
  `CHANNEL_SOCIAL`**, so they also survive opening the app. They stack for ever.
- **No avatar, no stacking, and a lower priority** - `BigTextStyle` and `PRIORITY_DEFAULT` against
  `MessagingStyle` + `Person` icon + `setLargeIcon` + `setGroup` + `refreshBadgeSummary` and
  `PRIORITY_HIGH`.

**The spec, from the user:** a reaction notification should have most of what a message notification
has, MINUS reply and mark-as-read, which mean nothing for a reaction. So: the avatar, the stable
per-conversation id (hence dismissal, cross-device dismissal and clear-on-open), the bundling and the
badge. That needs a sender id in the payload, which today it does not carry, and a notification type
that is not `social` - the guard that excludes `social` from foreground suppression is right for a
post and wrong for this, and no amount of branching inside `social` fixes a type that is simply not
the one being sent.

**Deliberately not fixed on discovery**: this is NOTIF's subject and the campaign reaches it with its
own observers. What is settled already is that it is not a rendering detail - the payload is missing
the field the fix needs, so it is a server change and a client change, on both platforms.

---

## Storage and retention

The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

### Server - can occupancy be monitored, and will it hold?

The forecast exists on paper; what is missing is a live measurement and an alert. **A forecast with
no report is discovered by hand, a day late.** Scope: what is actually growing (Postgres, Garage,
Redis streams), at what rate, and what the report should carry so that it distinguishes "media grew"
from "the stream retention changed".

### Mobile - what happens when the device runs out of space?

Unanswered today. The device window on mobile is five years, which is a TIME bound and not a SIZE
bound, so nothing caps the store. Worth knowing what the failure actually looks like before deciding
whether a cap is needed - a write that throws is a different problem from a device that silently
stops persisting.

### Browser - is 90 days bounded in bytes?

Same shape as mobile, and the same gap: the web window is a time bound. IndexedDB is also subject to
the browser's own quota eviction, which can drop the store without asking - the question is what the
client does when it finds its store gone, not whether it can prevent it.

> **Already shipped, do not re-open:** _"ne garder que les messages les plus recents (dernier mois),
> et le reste recuperable en demandant l'historique a un appareil mobile"_ is exactly the device
> window plus the scrollback range request delivered in the history-reconciliation rework - web keeps
> 90 days, mobile and desktop 5 years, and reaching the top of the scrollback asks a peer for the
> range below the window. See [history-reconciliation](protocols/history-reconciliation.md) and
> `historyWindow.ts`.

> **Already shipped, do not re-open:** _"pourquoi garder plus d'un accuse de lecture sur de vieux
> messages ? Si le dernier message a ete lu, le precedent aussi"_ is the read watermark that replaced
> per-message `readBy` in the same rework - read state is now ONE timestamp per (conversation, user),
> and `readersOf` derives the per-message display from it. Old messages cost nothing extra, and a
> history catch-up cannot mark a read message unread because the watermark is compared, not the
> per-message list.

---

## Payments

### Flipping `payment_provider` from Stripe to Lydia (WP-LYDIA-1)

**The code is not the blocker - it is already written and tested.** `PaymentProvider` is an interface
(`apps/core-service/src/payment/payment-provider.interface.ts`), `LydiaPaymentProvider` implements the
two flows that map cleanly onto it (one-off checkout, session lookup) with its own signature module
and specs, and the choice is a platform config column (`payment_provider`) that **defaults to
`stripe`**. Stripe is what runs today and nothing about that is broken.

What is missing is not code, which is why this is a question and not a P-anything: the **credentials**
and the **answers Lydia owes**. Everything that does not map - live balance and status, saved payment
methods - throws a documented error rather than faking a result, and that is deliberate: Lydia has no
live status-poll endpoint, and the saved-card flow was **explicitly dropped by the user** rather than
reimplemented, so every purchase becomes its own interactive request. Do not re-litigate that.

The full provider mapping, the remaining open questions and the credentials still owed are in
[`plans/stripe-to-lydia-migration.md`](../../plans/stripe-to-lydia-migration.md), which the wiki page
[payments](frontend/modules/payments.md) already points at. Registered here so the WORK is visible in
the tracked state, not only the document describing it.

---

## Cross-repo

### P2 - converge the five projects on the best version of each shared solution

**The avatar proxy is the sample, not the subject.** Four projects fetch the same MiGallery endpoint
and four different failure behaviours were written for it (see the P2 in *Outbound connectivity*):
Le Cercle has a stated timeout budget, a `null` return and a log line that separates *no key* /
*legitimate 404* / *unreachable*; Sky has no timeout at all; Canari alone answers **502 and logs an
error** where the others degrade to initials silently. **Nobody chose that spread** - each was
written once, in isolation, and the best version never travelled. That is a process outcome, so it
will keep happening, and the avatar case is only the one a server log happened to expose.

**What this asks for is an inventory first, not a refactor.** The list below is what is ACTUALLY
established today; everything else is a guess until someone looks, and a guessed inventory is how the
IPv6 diagnosis got written down:

- **verified** - the avatar proxy, four implementations, table in the *Outbound connectivity* P2;
- **known partial** - tolerant search (done in Sky, owed in Canari and MiGallery), and the i18n /
  wiki / English-comments normalisation (done in Canari, partial elsewhere) - both already tracked;
- **to inventory** - outbound HTTP handling in general (timeout, retry, what a failure degrades to),
  logging conventions, and whatever else turns up. Do NOT enumerate these from memory.

**A shared package is probably the wrong shape, and that is worth deciding before any code.** Three
of the four are SvelteKit and Canari's is NestJS; there is no monorepo spanning them; and **Le Cercle
is Aurel's repo**, so convergence there is a merge request and his decision, never a commit. The
realistic form is *one written contract, four aligned implementations*, with the contract living
where it can be read from all five - and the contract's first clause is the one the avatar case
already proves: **an optional decoration that cannot be fetched degrades, it does not error.**

Sequenced after WP-AVATAR-1 deliberately: that one settles the contract on a case where all four
behaviours are known and measured, and this generalises it. Doing them in the other order would
generalise from a shape nobody has validated once.

### P2 - a link preview that could not be REACHED is reported as a bad request, and remembered as one

Same family as WP-AVATAR-1, found the same way - by a check going PASS-DIRTY rather than by anyone
looking. `msg6.mjs` posts a Wikipedia link; on 2026-08-15 at 14:37:02 the browser got
`GET /api/mls/link-preview?url=…Signal_(application) -> 400`, and the server said why:

```
[LINK_PREVIEW] fr.wikipedia.org failed: ConnectTimeoutError: Connect Timeout Error
  (attempted addresses: 185.15.58.224:443, 2a02:ec80:600:ed1a::1:443, timeout: 10000ms)
```

Both address families timed out - a real, transient upstream condition, and NOT the IPv6 story that
was refuted on 2026-08-15 (an unroutable AAAA costs 0-2 ms; this is a 10 s connect timeout on v4 as
well). Three things are wrong with what the endpoint does with it, and only the third is expensive:

- **The status code lies.** `400` tells the client its URL was malformed. The truth is *I could not
  reach it*, which is not an answer about the request at all - the standing rule, applied to a
  response this service EMITS rather than one it reads.
- **Two competing budgets.** The handler arms `AbortController` at 4 000 ms
  (`security.controller.ts:381`) and the error that came back is undici's own 10 000 ms connect
  timeout, so the stated budget is not the one that fired. One of them is dead code; decide which.
- **A transient failure is cached as a verdict.** The refusal is stored for
  `PREVIEW_FAILURE_TTL_MS` = **10 minutes** and replayed as `400` to every reader
  (`security.controller.ts:375`), for a link that may have been reachable one second later - which is
  what the log shows, `cache hit ... ok=true` at 14:43:42. Caching a refusal is right (a dead host
  must not cost the full timeout per render); caching *unreachable* under the same key as *refused*
  is what turns a blip into ten minutes of a wrong answer. Separate the two, or do not cache the
  transport failure at all.

Cheap to fix and deliberately not done mid-campaign: it changes a response code the frontend reads.

**And the same check's OTHER dirt puts the two together.** `msg6` also recorded a `502` on both
browsers, which the server names: `[AvatarService] Error fetching avatar for … from
https://gallery.mitv.fr: ETIMEDOUT`, five of them at 14:39:58 - WP-AVATAR-1's signature to the
character. So within one three-minute window, **two unrelated upstreams timed out from two different
containers** (`chat-delivery-service` -> Wikipedia at 14:37:02, `core-service` -> gallery at
14:39:58). That is not evidence about either upstream, and it is the second time this shape has been
mistaken for one: the IPv6 reading was refuted by measuring the components, which all came back
healthy. **Before either fix, measure EGRESS over time rather than the endpoints again** - the
component probes already say each is fine at the moment it is asked, so what is left to establish is
whether these stalls are correlated, and a one-shot probe cannot answer that by construction.

### P3 - the SSR reports an unmatched route as a server error, in red, on stderr

Found while classifying the pass-2 server window of the MSG x5 of 2026-08-15, which went `NOT CLEAN`
on nine lines that turned out to be an internet scanner probing for secrets (`/.env`, `/.git/HEAD`,
`/credentials.json`, `/app.js`, …). **All nine were answered `404` and nothing was served** - the
finding is not the scan, which is background radiation on any public host. It is what the SSR does
with a 404.

`frontend/src/hooks.server.ts` exports `handle` and no `handleError`, so SvelteKit installs its
default (`@sveltejs/kit` 2.70.1, `runtime/server/index.js:114`), which calls
`format_server_error` (`runtime/server/utils.js:197`) and prints through **`console.error`** - to
stderr, wrapped in a hardcoded `\x1b[1;31m`. A 404 is a *correct answer* about a route this
application does not have; a 500 is the application failing. Both come out at the same level, in the
same red, and only the 500 carries a stack.

The consequence is the standing one about levels: a reader who learns that red SSR lines are
scanners is a reader who will skim past the 500 that matters. Fix is one export - our own
`handleError` that logs 4xx at warn (or info) with the method and path, and 5xx at error with the
stack - which also gives the classifier a level to sort on instead of a path shape.

Deliberately not done mid-campaign: it redeploys the SSR, and every client-side disconnection in a
window that straddles a deploy has to be re-attributed. `srvlog.mjs` classifies the scan as
`notable` in the meantime - reported on every run, gating none - and the two paths a general rule
would have wrongly forgiven (`/service-worker.js`, `/chat`) are pinned in
`srvclassify-selftest.mjs`.

### P3 - SEO for Sky, MiGallery and Portail-etu

Canari's is done and the method is written up in [seo](frontend/seo.md), including the four checks no
test can make. The three other repos have had none of it. Each is a separate repo and a separate
deploy, so this is three small pieces of work sharing one method, not one piece of work.

### Is a MiGallery application worth it?

An open question, deliberately. The Canari formula (SvelteKit + Tauri) transfers, so the cost is
knowable - but MiGallery's value is a gallery that a browser already renders well, and the question
is what an app would add that the web version cannot do. Answer that before estimating anything.

---

## Tooling

### P3 - move and rename `test_adb.py`

It sits at the repository root and its name says what it uses rather than what it does - it captures
device logs for the verification pass. It belongs with the harness documentation that references it
([device-verification](device-verification.md)). A rename touches every doc that names it, so grep
before moving.
