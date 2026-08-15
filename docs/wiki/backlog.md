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

### P2 - the message hover bar is too wide on desktop

The react/reply/... strip shown on message hover does not fit when the window is half the screen, so
its end is unreachable. A layout constraint, not a behaviour change.

---

## Outbound connectivity

### P2 - the avatar proxy pays a 5 s budget on IPv6 addresses the container cannot reach

**Diagnosed 2026-08-15, from inside `core-service` on prod.** `gallery.mitv.fr` resolves to four
addresses; the two IPv6 ones answer `ENETUNREACH` and the two IPv4 ones connect fine:

```
lookup: 172.67.180.204 (4), 104.21.31.239 (4), 2606:4700:3031::6815:1fef (6), 2606:4700:3032::ac43:b4cc (6)
ERR  6 ...:6815:1fef  ENETUNREACH        OK 4 172.67.180.204
ERR  6 ...:ac43:b4cc  ENETUNREACH        OK 4 104.21.31.239
```

The container has no IPv6 route, but DNS keeps handing it AAAA records, so every avatar fetch enters
Node's happy-eyeballs path - `internalConnectMultiple` and `Timeout.internalConnectMultipleTimeout`
are in every captured stack - against the `timeout: 5000` in `avatar.service.ts`. When those attempts
hang rather than failing fast, the whole request dies `ETIMEDOUT` and the endpoint answers 404 with
the UI falling back to initials. **Eleven of them in one five-minute READ window.**

Three candidate fixes, and the choice is a judgement rather than a lookup: pin the avatar client to
IPv4 (`family: 4`, or `dns.setDefaultResultOrder('ipv4first')`), give the container a working IPv6
route, or turn `autoSelectFamily` off for that client. **Whether the proxy should exist at all is a
separate and prior question, and it is the user's** - see the note in `CLAUDE.md`.

The log-volume half of this is already fixed: the handler used to pass the whole axios error to the
Nest logger, which printed `util.inspect` of the TLS socket - about 500 lines per occurrence, 5 581
lines from those eleven incidents, enough to make the service's whole window unreadable.

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

### P2 - every send writes a membership cache the send path never reads, and pays two DB queries to do it

Found 2026-08-14 by classifying the server's own logs, not by a failure: `FALLBACK_MEMBERS_CACHE`
fired on **279 of 279 sends** in a 23-minute window. A branch named for an exception, taken 100% of
the time, is the shape of a comment that has outlived its architecture.

What the code says (`messaging.service.ts`, the `ops.length === 0 && body.groupId` branch): *"Fallback:
recipients not provided (Redis cache miss). Resolve from DB and repopulate `group:members` so
subsequent messages no longer need this round-trip."* It reads as a one-time warm-up per group.

What actually happens:

- **The client never sends `recipients`.** The live send path is `postApplicationMessage` in
  `mlsDeliveryApi.ts`, which posts `senderId`, `senderDeviceId`, `groupId`, `proto`, `silent`,
  `durable` - and nothing else. `mkMlsEnvelope` in `proto/codec.ts` still takes a `recipients` array
  and is called from nowhere: it belongs to the WebSocket send path, which is dead
  (`ws_dispatch.rs`: *"All send-path operations now go directly from the frontend to the delivery
  service via HTTP. The gateway WS connection is receive-only for those message types"*).
- **So the branch is not a fallback, it is the only path**, and "subsequent messages no longer need
  this round-trip" is never true for any message.
- **`sendMessage` never reads `group:members:` at all.** It goes straight from an empty `ops` to the
  database. The `sadd` it performs on the way out feeds the GATEWAY's routing and diagnostics, which
  do read the key - so the write is not useless, but the send path writes a cache it never consults.

The cost is two queries per message - `deviceGroupRepo.find` over the group's memberships, then
`keyPackageRepo.find` over their device ids - both O(members). On a two-person DM that is invisible.
It is exactly the shape the standing directive rules out for a large conversation: *"doit marcher
avec une conversation de toute les tailles"*.

**Not fixed unilaterally because the right answer is a design decision, not a repair.** Three
candidates, in increasing order of change: read `group:members:` in `sendMessage` before falling back
to the database (smallest, and it makes the existing comment true); or have the client send
`recipients` again, which the server already accepts and the proto already carries; or accept the DB
resolution as authoritative and delete the language of caching from the branch. Whichever is chosen,
**the log line must stop calling itself a fallback** - it misfiled itself as `notable` in the
classifier for exactly that reason, and it will mislead the next reader the same way.

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
