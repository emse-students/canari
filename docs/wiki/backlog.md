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

### P2 - what made the profile fetches fail on that device at that moment

**THE MECHANISM HALF IS CLOSED (2026-08-16). WHAT REMAINS IS THE TRIGGER**, which no amount of code
reading answers and which is the only reason this entry still exists. Everything below the horizontal
rule is the original finding, kept because it is the measurement; what shipped against it, in order:

1. a `console.warn` that ACCUSES on every failed lookup, so the fallback can finally be counted -
   the file had no logging at all, which is why "9 of 10 rows unknown" reached a run log with
   nothing anywhere to explain it;
2. a `connectivity.onReconnect` listener that clears `failedAt`, because **a failure recorded while
   the network was down is evidence about the network, not about the user** - regaining
   connectivity refutes the suppression outright, and a shorter timer would only have made the same
   wrong answer shorter;
3. the placeholder-caching guard, read against the VALUE rather than against the doc comment, and
   left as an explicit answer: a profile that really carries no name is a definitive result;
4. **a failed lookup now answers `null` instead of the label.** The label is truthy and all
   twenty-six call sites read `if (resolved) use it`, so ONE failed request made every screen
   overwrite a name it already had - and only the first time, the backoff answering `null`
   afterwards, so the same event rendered two different ways depending on how recently it had
   happened. The synchronous read stopped discarding the caller's `fallback` during the backoff for
   the same reason. Both are pinned by `displayName.spec.ts`.

So a single blip no longer anonymises anything a caller could name by itself. **What is still owed is
the denominator**: with the log line in place, measure how often that `catch` actually fires and
against what population, before deciding whether the two-minute backoff has any case left to serve.
Do not assume it is the same fault as the avatar endpoint, and do not assume it is not.

---

#### The original finding, 2026-08-16 - a name that fails to resolve once is "Utilisateur inconnu" for two minutes, silently

**Measured twice on 2026-08-16, on BOTH platforms**, by `awaitListed`'s first two sightings since it
learnt to report state - 11:14Z on the phone and 11:18Z on a desktop browser, the same numbers each
time: `{"path":"/chat","sidebarPanel":true,"listedEntries":10,"unknownLabelRows":9}`. The list HAD
loaded - ten rows - and **nine of them carried the fallback label**, for the twenty seconds the check
waited. Not a race, not device-specific, and not a stale bundle: `8b68bfe9` is an ancestor of both
the deployed build and the APK, so both clients are running the fix for the PREVIOUS instance of this
symptom, which its own commit message describes as "on web and on Android, permanently".

**It also corrects four earlier sightings.** MUT-13, MUT-19 and one each on MUT-7 and MUT-8 had been
read as "a list that fails to populate", and the reading was wrong in a way no amount of thought
would have caught: the lists were full every time, and only the NAMES were missing, so a search by
name could not match. The bare `until()` timeout could not tell the two apart, and the difference is
an application defect versus a loading problem that does not exist.

Three facts in `frontend/src/lib/utils/users/displayName.ts`, all readable without reproducing
anything:

- **`FAILURE_BACKOFF_MS` is 2 minutes and nothing announces it.** One failed `fetchUserProfile` sets
  `failedAt`, and for the next 120 s `getUserDisplayNameSync` returns the label while
  `resolveUserDisplayName` returns `null` WITHOUT retrying (`shouldSkipRetry`, both call sites). One
  blip anonymises every affected row for two minutes.
- **The `catch` swallows the error entirely** (line ~137: `failedAt.set(...); return
  m.user_unknown_label()`). The file contains no `Log.`, no `console.`, nothing - so the fallback
  that fires cannot be counted, and its rate against the population is unknown. This alone is a
  defect under the standing rules: a swallowed branch logs, and a fallback is logged at a level that
  ACCUSES.
- **A 200 carrying no names is cached as though it were a resolved name, for ever.**
  `formatProfileDisplayName` returns the LABEL when a profile has no `firstName`/`lastName`/
  `displayName`; the guard then asks `value !== normalized` - is it different from the user ID - which
  is true of the label always, so the placeholder is written into `displayNameCache` and that Map has
  no expiry. The guard was written against the function's doc comment ("firstName+lastName >
  displayName > **id**"), which describes a behaviour the code does not have. **A guard tested
  against the documentation instead of the value is a guard that cannot fire.**

What is NOT established, and must be before this is scheduled: **what made the fetches fail on that
device at that moment.** The mechanism above turns one failure into two silent minutes, but the
trigger is unknown, and the neighbouring
[four projects proxy one avatar endpoint](#p2---four-projects-proxy-one-avatar-endpoint-and-only-canari-calls-a-transient-blip-an-error)
entry covers adjacent user endpoints - do not assume they are the same fault, and do not assume they
are not. The first move is the log line that does not exist yet: without it there is no denominator,
and the previous instance of this symptom survived precisely because reloading hid it.

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
reaction silently never happened. They ran inside a stated viewport override, and MUT-21 was written
to own the defect at the launched width so that override could not outlive it. **MUT-21 passed
against the fix the same day - `overflowsPaneLeftBy: 0`, `reachable: true` in both directions at
958 px - and every override was deleted with it.** MUT-21 stays as the regression guard.

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

### P2 - four projects proxy one avatar endpoint, and one of them still caches nothing

**THREE OF THE FOUR ARE DONE AND DEPLOYED (2026-08-16): Canari, Sky, Portail-etu.** The contract, the
three outcomes and the caching rule are on [core-service](services/core-service.md#the-avatar-proxy),
the story is in `CHANGELOG.md`, the rule is in [durable-rules](durable-rules.md). What is left here
is **Le Cercle**, which is a merge request and Aurel's decision, and the reason this entry outlives
the fix: **nobody chose the spread**, so it will happen again on the next shared solution (see the
cross-repo entry below).

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

| project | timeout | caches a miss | on failure |
| --- | --- | --- | --- |
| Canari (`core-service/users/avatar.service.ts`) | 4 000 ms, stated | **yes** - 10 min absence, 1 h image, bounded | 404 for an absence, 502 `no-store` for a non-answer; `warn` for a blip, `error` only for a refused key |
| Le Cercle (`lib/server/migallery/index.ts`) | `AbortSignal.timeout(4000)`, justified | **no** | `null` -> initials, one log line separating *no key* / *legitimate 404* / *unreachable* |
| Sky (`routes/api/avatar/[id]/+server.ts`) | 4 000 ms, `OUTBOUND_BUDGET_MS`, shared by all 4 of its outbound calls | no | initials SVG `no-store`; a 404 is silent, a refused key or an unreachable gallery is an `error` |
| Portail-etu (`routes/api/users/[userId]/avatar/+server.ts`) | 4 000 ms, `OUTBOUND_BUDGET_MS`, shared with both Canari-API calls | yes - the shape Canari copied | 404 cached for a real absence, 502 `no-store` for every claim about MiGallery |

**Sky and Portail-etu shipped on 2026-08-16** (`424f439` / `6bede6a`, both deployed and verified
answering). Each got the budget it lacked - `fetch` has no default deadline, and that is the opposite
risk from the one measured here: an unreachable upstream fails fast and gets amplified by a missing
cache, while an upstream with no deadline *cannot fail at all*, which is worse, because every caller
degrades on a throw. Each also stopped blurring the distinction the status carries: a refused key
answered 404 on the portal, i.e. the portal asserting the member has no face; a plain 404 was logged
at `error` on both, on every faceless card. Both now log only what accuses. Three findings came out
of the work and are worth keeping:

- **Sky's `tests/api.test.ts` had never run once** - the vitest `include` only looked under `src/`.
  Neither passing nor failing, invisible, and rotted (a mock missing an export the route calls, an
  env assignment after a hoisted import). *A test file nobody executes reads as coverage on every
  review.* Both roots are in the pattern now.
- **Sky's proxy narrated every request** - the key's presence at load, the fetch, the DB hit, the
  success, the miss. A map of N stars wrote several N lines and buried the two that mean something.
- The budget belongs to the REPO, not the call site: one constant each (`src/lib/server/outbound.ts`,
  `src/lib/outbound.ts`) now covers the Canari public API and Authentik too, which had the same
  defect and were never part of this entry.

**What is left, and it is not ours to commit:** **Le Cercle caches nothing**, so it re-asks the
gallery for a known-absent photo on every render - the amplification Canari's cache exists to remove.
It is **Aurel's repository**: this travels as a merge request or not at all, never a commit on his
`main`.

The log-volume half was already fixed before this: the handler used to pass the whole axios error to
the Nest logger, printing `util.inspect` of the TLS socket - about 500 lines per occurrence, 5 581
lines from eleven incidents, enough to make the service's whole window unreadable. It now names the
user and the destination, which makes the line partitionable by subject; it was not, which is why
those errors could never be attributed to a campaign account or to a stranger.

## Interface

### P3 - iOS has no home-screen icon, and `/favicon.ico` 404s too

Measured on prod 2026-08-16 while classifying an unexplained shape in the server window:
`/apple-touch-icon.png`, `/apple-touch-icon-precomposed.png` and `/favicon.ico` all answer **404**.
`frontend/static/` holds only `favicon.png` and `favicon.svg`, and `src/app.html:73-74` declares
those two and nothing else - so Safari falls back to the convention path, finds nothing, and an "add
to home screen" gets a page SCREENSHOT instead of an icon. On a chat app whose mobile install path
matters, that is the first thing a user sees on their springboard.

Fix is one asset and one `<link>`: a 180x180 PNG at `static/apple-touch-icon.png` plus
`<link rel="apple-touch-icon">`. A `favicon.ico` alongside them costs nothing and closes the third
404 - some browsers and most feed readers still ask for it before reading the declared icons.

**The 404 itself is not a server defect** and is classified BENIGN in `srvlog.mjs`: answering 404 to
a path this site does not have is correct. It is filed here rather than only silenced there, which
is the whole difference between classifying a line and hiding one - the rule carries a comment
pointing at this entry so the two cannot drift apart.

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
day because the other members kept addressing it.

**Both halves are decided (2026-08-17): deleting a device PURGES its queue, and the backlog of a
device that never returns is BOUNDED.** The second is the one nobody triggers by hand - a user is
under no obligation to delete anything, so a queue that only shrinks on an explicit delete grows for
ever on exactly the devices that are worst at coming back. The bound is a question for the sweep that
already deletes at `RETENTION_WINDOW_MS`, not a new mechanism: what it must not do is measure
liveness with a column somebody else writes, which is the trap this whole entry already carries.

---

## Protocol and delivery

### P2 - FIXED 2026-08-16 - an unresolved tab leadership was read as "another tab is the leader", and the skipped flush rescheduled nothing

**Leadership has three states now** (`tabLeader.ts`): `undecided | leader | follower`, with
`getTabLeadership()` for the state and `whenTabLeadershipDecided()` for the answer. `runFlush` awaits
the decision instead of treating "undecided" as someone else's job, and `getIsTabLeader()` is
deliberately unchanged - `undecided` still reads as "do not write", which is right for every caller
that gates a WRITE and wrong only for the one that was delegating.

**No timer, and the wait terminates by construction**: every branch of `initTabLeadershipAsync`
decides, including the two that decide synchronously (Tauri, no `BroadcastChannel`). The deferral is
logged with what it cost - `[OUTBOX] Flush deferred ...` then `Leadership decided as <side> after
<n> ms` - because a gap nobody can see is how this survived two sightings.

**The check that was owed exists**, in `outbox.test.ts`: a message enqueued INSIDE the gap, asserting
both halves - nothing is delegated while the answer is unknown, and the entry goes out on the
decision itself, with no second trigger. Its twin asserts that a decided `follower` still delegates,
which is the only time that was ever true.

What remains of the original entry, kept because it is the reasoning, not the fix:

---

#### The original finding, 2026-08-15

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

### P3 - the composer sits behind the soft keyboard on Android, and the page scrolls onto a white band

Known, reproduced by hand. Two symptoms, and reading them together is what makes this a layout
decision rather than a patch:

- the message composer is overlapped by the soft keyboard on some Android keyboards;
- with the keyboard open, **the interface itself scrolls** - resting a finger on the text bar and
  dragging moves the whole page off the conversation and onto an empty white band below it.

**They are one defect.** The white band is the LAYOUT viewport keeping its full height while the
VISUAL viewport shrank to make room for the keyboard: the page is still as tall as the screen was,
so the part now hidden behind the keyboard is scrollable into view, and it holds nothing. The
composer sits in that same overhang. Anything that pins the composer alone leaves the band.

**Decided 2026-08-17: let the OS resize the view** - `adjustResize` on the activity plus
`interactive-widget=resizes-content` in the viewport meta - rather than translate the composer from
a `visualViewport` listener. The layout shrinks, so there is no overhang to scroll into and no event
to chase; it is one setting rather than a correction applied after the fact, and it fixes the whole
column instead of one element of it.

**The check the user asked for, and it is a good one because it needs no coordinates**: with the
keyboard open, **at least 5 messages must be visible in the conversation**, read off a screenshot.
Fewer means a band survives between the list and the keyboard. Negative control is free - the
current build fails it, so the check can be seen failing before it is believed
([testing-methodology](testing-methodology.md), rule 2).

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

### P3 - a backup that fails to export or import tells the user nothing

Found on 2026-08-16 while typing the error branches above it. `sessionBackup.ts` catches both
failures and hands them to `log`, which is `appendLog`, which is `console.log`. The spinner stops and
nothing else happens: a file the importer refused and a backup fully restored look identical on
screen, and seven distinct refusals in `importBackup` are equally invisible.

**This is also why those seven sentences were made ENGLISH rather than Paraglide messages** when the
branch above them was deleted: nothing user-visible carries them today, and the rule is that a
dev-facing string is English. Inventing a surface for them is a UI decision, not a translation one -
whoever picks this up decides what the user actually sees (a toast naming the refusal, or a panel),
and the sentences become Paraglide messages in the same change, never before it.

### P2 - the reaction notification is the same on both platforms, except on a KILLED iPhone

The reaction rework shipped 2026-08-15 (`fbc8597b`) and closed the whole of the previous entry here -
the POSTS pipe, the undismissable id, the missing avatar, the notification that fired over an open
chat, and the plaintext of the reacted-to message travelling to our server, Google and Apple. The
story is in `CHANGELOG.md`. **What is at parity, do not re-derive it**: both platforms take the
MESSAGE path, both use the stable per-conversation id and thread, both suppress themselves in the
foreground, both drop reply and mark-as-read, and both compose the sentence in the app's OWN
Français/English rather than the OS one, from `locale` in `push_context.json`. That mirror is the one
part of this with a test - `frontend/src/lib/mobile/pushContextFields.test.ts` pins the field across
the Rust writer and all three native readers.

**Two of the three gaps were closed the same night, BLIND** - this machine is Windows, so every line
of it is compiled by CI and by nothing else, and none of it has run:

- The NSE - the path that runs when the app is KILLED - composed the sentence and stopped, so a
  reaction on a closed iPhone showed a blank icon and left the app-icon count one too high, while
  the in-app path and Android both did neither. It now fetches the actor's avatar and recomputes the
  badge, through `fetchAvatar` / `attachImage` / `applyBadgeCount` - the same helpers
  `applyMessageContent` uses.
- **iOS has a `Localizable.strings` now**, on BOTH targets (`canari_iOS/*.lproj` and
  `canari_NSE/*.lproj`, four files, wired as two `PBXVariantGroup`s into two Resources phases). The
  appex is a separate bundle from the app, so the table is duplicated on purpose - that split is the
  platform's. `CanariLocalized` / `NotificationService.localized` resolve it through the `.lproj`
  named by `locale` in `push_context.json`, NOT `NSLocalizedString`, which answers for the OS - a
  different setting from the one the user chose in Canari. Five keys, the five sentences that were
  French literals: reaction, message-from, message-encrypted, channel-message, outbox-pending.

**What is still NOT at parity:**

- **No initials fallback on iOS.** When the avatar cannot be fetched Android draws
  `generateInitialsBitmap(actorName)` - a 96 px indigo disc with the first letter; both iOS paths
  show no image at all. It needs a bitmap rendered to a file for `UNNotificationAttachment`, in
  ObjC and again in Swift, and it was the one piece judged not worth writing blind in the same
  sitting: it is additive and guarded, so it can go in whole whenever. Same shape as the
  web/mobile avatar entry above.

The Android literals named here previously are CLOSED (2026-08-17): the two platforms now use the
same mechanism, and the entry below keeps only the half neither of them can fix. The iOS
`channel_read` gap named here previously is CLOSED too, and was not what it looked like - see the
channel-push entry below.

### P2 - a server-composed notification body is French for everyone, and cannot be otherwise

Measured 2026-08-15 while reworking the reaction push. **Paraglide reaches neither the native
clients nor the services** - it compiles into the web bundle, and the FCM handler, the iOS extension
and NestJS have no access to it. So the rule "user-visible strings use Paraglide" has no enforcement
mechanism at all outside the bundle, and the three layers each answered differently.

**THE WHOLE CLIENT HALF IS DONE (Android and iOS, 2026-08-17).** Each platform has a two-language
table read through the locale the user chose INSIDE Canari, `nativeStrings.test.ts` holds the four
resource files to the same key sets, and a third block of that file holds both platforms to the
invariant the per-platform ones cannot see: **no native source may carry a literal a table already
translates.** iOS also re-registers its quick-action titles when the locale moves, which is possible
there and not on Android. Mechanism on
[mobile](frontend/mobile.md#the-language-a-notification-speaks); do not re-derive it here.

**What is left is the services, and it is not a translation problem.** `chat-delivery-service` and
`social-service` compose French sentences for pushes and do not know the recipient's language - no
header carries it and no column stores it. The MESSAGE push path already answers this correctly by
sending `body: ''` and letting the device compose after decrypting, which is the only layer that
knows the locale. Any server-composed body is therefore a design smell, not just an untranslated
string, and the fix is to MOVE THE COMPOSITION rather than to translate it in place - which is also
why storing a `locale` column server-side would be the wrong repair.

### P2 - what is left on the channel notification: the title format, and the banner iOS never cancels

**The route itself is CORRECT and this entry is not about it - do not re-open that.** The user asked
on 2026-08-15 whether `[CHANNEL_PUSH]` / `type: 'channel'` was wired to the right path, remembering
WP-PREFIX-1. It was one of that WP's three broken call sites: `POST /internal/push/notify` without
the global prefix answered **404 on every channel message**, under a `logger.warn` nobody read, for
the whole life of the feature. Fixed 2026-08-14 by `deliveryUrl()`, and **measured on prod since the
corrected container started (`2026-08-14T18:00:01Z`): 269 `[CHANNEL_PUSH]` fan-outs, ZERO `notify
HTTP` lines**, `[INTERNAL_PUSH]` acknowledging each. A 404 that stopped is not a banner that
appeared, so the phone still owes the positive check - that is NOTIF's first measurement, not a
finding.

**THE PAYLOAD HALF IS CLOSED (2026-08-16), WRITTEN BLIND AND VERIFIED BY A SOURCE-READING TEST, NOT
BY A DEVICE.** `mentioned` is read by all three handlers now: Android posts on `canari_mentions`,
both iOS paths set `interruptionLevel = .timeSensitive`, and the flag is the SERVER's rather than an
`@[uuid]` scan - the only answer that survives a ciphertext too large to inline. The three fields no
client read (`workspaceId`, `messageId`, `createdAt`) were dropped instead of left looking like a
contract, and the same read found a fourth thing: the NSE was the one surface showing a salon message
with no avatar at all, though the payload had carried `senderId` for it all along. The reasoning for
each, and the contract itself, are on
[social-service](services/social-service.md#channel-push-notifications); the guardrail that would
have caught the whole class is `frontend/src/lib/mobile/channelPushFields.test.ts`, and its rule is
in [durable-rules](durable-rules.md#contracts-the-compiler-does-not-check).

**THE iOS HALF IS CLOSED TOO (2026-08-16), AND IT WAS TWO DEFECTS, NEITHER THE ONE THIS ENTRY
NAMED.** The bullet used to read "the NSE treats `channel_read` as a pass-through". It cannot: the
extension runs on ALERT pushes only and a silent frame is a background push, so that `case` had
never once executed. Underneath it, `POST /internal/push/notify` was sending data-only with **no
`apns` block at all** - a second copy of `MessagingService.sendPushToUser` missing exactly that -
so **no community push had ever reached an iPhone**, message or read frame, while the endpoint
answered `sent`. And once the frame does arrive, the cancel keyed on `canari-<stableId>`, which the
NSE-posted notification never carries. All three are fixed and pinned:
[chat-delivery](services/chat-delivery.md#transport--single-gateway-fcm),
[social-service](services/social-service.md), two rules in
[durable-rules](durable-rules.md), `internal.controller.push.spec.ts` and the second half of
`channelPushFields.test.ts`.

**THE TITLE IS DONE TOO (2026-08-16): `<Communaute> - #<salon>`**, the user's decision, taken after
the correction that the data was NOT already in the payload - `workspaceId` was a uuid and no native
surface can turn one into a name. `workspaceName` now travels in its place and FOUR surfaces compose
the format, the server's copy being the APNs alert title an iPhone falls back to. Contract and the
degraded case on [social-service](services/social-service.md#channel-push-notifications).

**What is left of this entry is one measurement.**

- **The phone still owes the positive check** (above): a 404 that stopped is not a banner that
  appeared. NOTIF's first measurement, and it now also has to show the mention landing on the right
  tier on each platform - **and, on iOS, that anything lands at all**, which nothing has ever shown.

---

## Storage and retention

The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

### Server - can occupancy be monitored, and will it hold?

The forecast exists on paper; what is missing is a live measurement over TIME. `/admin/storage`
already answers disk, `auth_db`, bucket size and object count, and Redis memory - but only as
TOTALS, and only when somebody goes and looks. Scope: what is actually growing (Postgres, Garage,
Redis streams), at what RATE, and a presentation that distinguishes "media grew" from "the retention
stopped working" - two causes with the same symptom and opposite fixes. The second is not
hypothetical: `purgeExpiredMedia` iterates the metadata index, so an object with no entry is
invisible to it for ever, and 7 such objects (~11 MB) are already measured. §5.7's WP-GHOST-1 shape
belongs on the same panel: a device holding memberships with no `key_package`, or more than a few
hundred `queued_message` rows.

**Decided 2026-08-17: the panel is the whole of it, there is NO alert.** The user's call. Worth
stating what that costs rather than pretending it costs nothing - the standing rule is that a
correct mechanism with no report is found by hand a day late, and a panel is a report only for
whoever opens it. The slope is what makes it survivable: a number read once a month against a
trend is enough to see a wall coming, where a bare total is not.

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
and four different failure behaviours were written for it, each in isolation - one had no deadline at
all, one dressed a refused key as "this member has no face", one narrated every request, and only one
cached. **Nobody chose that spread**, and the best version never travelled. Three of the four are
aligned now (see the P2 in *Outbound connectivity*), which settles the contract but not the process:
alignment took one person reading four repositories in one sitting, and nothing makes the fourth
follow or the next shared solution converge. The avatar case is only the one a server log exposed.

**What this asks for is an inventory first, not a refactor.** The list below is what is ACTUALLY
established today; everything else is a guess until someone looks, and a guessed inventory is how the
IPv6 diagnosis got written down:

- **verified** - the avatar proxy, four implementations, table in the *Outbound connectivity* P2;
  three now aligned, and each of the three keeps its budget in ONE constant per repo, which is the
  shape a fifth project should copy;
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
generalise from a shape nobody has validated once. **That prerequisite is now met** - the contract is
written and implemented three times, so what remains here is the process question, not the design.

### P2 - measure EGRESS over time, because two unrelated upstreams stalled in one window

**FIXED 2026-08-16, AND WHAT REMAINS IS THE MEASUREMENT.** The three defects below are closed:
`UpstreamUnreachableError` classifies at the throw, so an unreachable host is a **502 `no-store`**
and is never remembered, while an answer about the URL stays a cacheable 400; and `OUTBOUND_BUDGET_MS`
is now the single budget, set on the `AbortController` AND on the undici dispatcher
(`connect.timeout`, `headersTimeout`, `bodyTimeout`), so the stated budget is the one that fires.
Two things surfaced while doing it, both fixed with it: `fetchYouTubeOEmbed` carried **no deadline at
all** - no signal was passed, so the endpoint's budget did not reach the FIRST outbound request it
makes - and its doc comment claimed it returned null "if the API call fails", which it never did.
Pinned by `security.controller.link-preview.spec.ts`, whose second assertion is the load-bearing one:
the same URL asked twice must ASK twice when the first attempt could not reach anybody.

**What is still owed, and it is not a code change.** Within one three-minute window on 2026-08-15,
two unrelated upstreams timed out from two different containers (`chat-delivery-service` ->
Wikipedia at 14:37:02, `core-service` -> gallery at 14:39:58 - WP-AVATAR-1's signature to the
character). That is not evidence about either upstream, and it is the second time this shape has
been mistaken for one: the IPv6 reading was refuted by measuring the components, which all came back
healthy. **Measure EGRESS over time rather than the endpoints again** - the component probes already
say each is fine at the moment it is asked, so what is left to establish is whether these stalls are
CORRELATED, and a one-shot probe cannot answer that by construction.

---

#### The original finding, 2026-08-15 - a link preview that could not be REACHED is reported as a bad request, and remembered as one

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

### P3 - FIXED 2026-08-16 - the SSR reported an unmatched route as a server error, in red, on stderr

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

**Fixed by `$lib/server/handleError.ts`, exported from `hooks.server.ts`.** A 4xx is a `console.warn`
with no stack and no colour; a 5xx is a `console.error` carrying its stack. **The first line keeps
SvelteKit's exact `[<status>] <METHOD> <path>` shape on purpose** - `srvlog.mjs` classifies the
server window by it, path by path, each rule carrying its own justification, and a new wording would
have silently un-classified every one of them. So no classifier rule changed, and the two paths a
general rule would wrongly forgive (`/service-worker.js`, `/chat`) stay pinned in
`srvclassify-selftest.mjs`.

Two things travelled with it. `handleError` lives in `$lib/server/` rather than in `hooks.server.ts`
so it can be unit-tested without `$env/dynamic/private` having to resolve. And `hooks.server.ts` had
been claiming in its own doc comment that `hooks.server.test.ts` pinned the two `app.html` markers it
substitutes - **that file did not exist**; a renamed marker would have turned the whole SSR head into
a no-op that still runs, still logs nothing and still serves a page. It exists now, and pins both.

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

### One MLS client in a SharedWorker - POST-CAMPAIGN PROJECT, decided 2026-08-17

**It would remove the multi-tab class outright**, and that class is not theoretical: W2 was measured
carrying seven `canari-emse.fr` tabs, each a full MLS client with its own gateway socket and its own
in-memory counters, sharing one IndexedDB key. Two campaign findings dissolved on that fact alone
(see [testing-methodology](testing-methodology.md), rule 5), and the harness's answer - `client()`
refusing an ambiguous browser, `onetab.mjs` repairing it - protects the INSTRUMENT and not the user.

**Why it is not a queue item.** The cost is not the worker: it is the worker TRANSPORT, the startup
sequence, the PIN unlock and the Safari/mobile fallback, all of which have to be redone. Doing it
before the campaign would invalidate every verdict already taken, since the boot path is what half
of them measure. So it is scheduled AFTER, as its own project, and the decision is recorded here so
nobody re-argues it from scratch.

### `dev.canari-emse.fr` becomes a real second environment - POST-CAMPAIGN, decided 2026-08-17

Today it is a proxied CNAME onto the same tunnel as production - one environment wearing two names.
The user wants trials to stop happening on prod, which is the right instinct: every reproduction in
the current queue is authorised on prod only because there is nowhere else, and each one leaves
debris on a shared server that real members use.

**What has to be decided before any of it is built**, because a second environment is a second copy
of every secret and every service: whether it gets its own database or a snapshot of prod's, its own
object storage, its own push credentials (an FCM sender is per-project, so a shared one would send a
test notification to a real phone), and whether its data is ever restored from prod - which would
carry real people's ciphertext onto a machine with weaker rules. Scope that first; the tunnel and
the DNS are the easy half, and they are already in hand.

### The campaign covers chat, and the app is not only chat

**Asked for on 2026-08-16, explicitly for AFTER the current campaign closes** - nothing here is
scheduled and nothing here blocks the 18 sections.

**It is a SECOND CAMPAIGN, not more sections on this one** - the user's framing, and it settles a
structural question rather than a stylistic one. The expected size is dozens of checks per surface,
where the current dashboard already carries 18 sections in one file whose entire job is to be a LIVE
summary someone can read. Pouring a second campaign into it destroys that property, and the rule
that keeps it readable (state only, no narrative, no second copy of anything) is exactly the rule
that would be broken first. So: its own dashboard, its own manifest, its own phase files - and
`checks.mjs`'s phase list is the seam to look at first, since a second campaign must be runnable
without re-running this one.

The dashboard's 18 sections were written around one class of failure: a message crossing between two
transports and two platforms, and the silent loss that class produces. That is where the incidents
were. It leaves whole surfaces of the product with **no check at all** - posts, forms, communities as
a management surface, profiles, media browsing, calendar, payments - and a surface with no check is
not a surface that works, it is one nobody has asked about.

The named starting point is the **`social` notification family**: a post, a comment, a reaction on a
post, a form alert. What makes it worth its own sections rather than a few rows appended to NOTIF is
that it does **not** share the chat path - no MLS, no per-device fan-out, no outbox - so none of the
verdicts already taken transfer to it. Its delivery is server-decided, which is a different failure
mode (an audience computed wrong sends a notification to the wrong people, and nothing on the client
can detect that).

Three things must be settled BEFORE writing checks, or this repeats the campaign's own early
mistakes rather than inheriting its lessons:

- **The venue.** Every existing check sends into the two-test-account DM or `Campagne de test`
  precisely because production is shared. A post or a form alert has an AUDIENCE, so the same
  discipline needs an answer that does not exist yet: what does a test post look like that no real
  member is notified by? Until that is answered, no social check may run on prod.
- **The observer.** `srvlog.mjs` partitions its window by subject and classifies every line. The
  services behind posts and forms are not in that window today, and an unclassified window is not an
  observation - so the server half of `social` has to be added to the classifier, with its
  self-test, before the first verdict is believed.
- **What a verdict rests on.** A chat check reads the peer's DOM. A notification with an audience is
  only correct if the people who should NOT get it did not - which is an assertion about absence,
  over a population, and needs its window sized from a measured latency rather than guessed
  ([testing-methodology](testing-methodology.md), rule 13).

Cost is the reason this is a backlog entry and not a plan: each new section carries a phase file, its
classifier rules, and its cleanup on a production database. Scope it against what has actually broken
in these surfaces before deciding how many of them earn a section.
