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

## History reconciliation - measured after the rework shipped

Three findings from reading the shipped exchange end to end, 2026-08-13. **None of them loses data**
and none is a reason to revert; all three are cost or determinism, and all three were found because
the question *"is probing on every connection overkill?"* was answered by measuring instead of
asserting. The design intent is in
[history-reconciliation](protocols/history-reconciliation.md) and stands - what follows is the gap
between it and the code.

### P2 - a probe wakes offline devices with a push, for a frame they can never use

`sendHistoryStateKey` (`groupActions.ts`) sends the state key as an ordinary MLS **group broadcast**
with `DELIVERY.transport` (`silent: true, durable: false`). The server (`messaging.service.ts`,
`postApplicationMessage`) then, per member device: writes a `queued_message` row, and for a device
that is OFFLINE fires `sendFcmForQueued(..., silent = true)` - an immediate silent FCM push. Online
devices additionally get a `scheduleDeferredPush`.

**Waking an offline device achieves nothing here, and that is provable rather than a judgement.** The
election only ever picks a device that Redis reports ONLINE (`EXISTS user:online:{u}:{d}`), so an
offline member is never the responder. And the frame it would be woken for expires: the rendezvous
holds a probe for `DIGEST_TTL_MS` = 60 s, so a push delivered minutes later arrives for an exchange
that no longer exists. **This is the same reasoning that already made `history_request` deliberately
non-durable** - a stored request drained hours later has no probe and is answered with nothing.

Order of magnitude, worst case measured at 17 groups on one connect: 17 probes x (member devices - 1)
queued rows and silent pushes, in each direction, every time either side reconnects.

**Shape of the fix:** a `transport`-class frame should not generate an FCM push, and arguably should
not be queued for an offline device at all - for exactly the reason it is not written to the stream.
The classification already exists (`frameDelivery.ts`); what is missing is the server honouring it on
the push path the way it already honours it on the `XADD` path (`durable: false` skips the stream).

### P2 - `reconcileAllGroups` reads the whole conversations table once per group

`sendHistoryStateKey` calls `historyRangeStartFor` unconditionally, which goes through
`storedConversationState` to `storage.getConversations()` - a **full conversations-table read**, in
both backends. The state key itself is cached and costs nothing on a hit, so the docstring's claim
that a probe costs *"no store read at all"* on a cache hit is true of the MESSAGE window only. A
connect pass over G groups performs G full conversation-table reads.

**Shape of the fix:** read the conversations once per pass and pass the floor down, rather than per
group. Pure factorisation - no semantic change, and it is the same "a lookup inside a per-item loop
grows with the wrong thing" shape as the post-ingest freeze already fixed in this rework.

### P2 - a probe can be compared against a state key up to 60 s stale

`PROBE_COALESCE_MS` = 30 s (`historyReconcile.ts`) is SHORTER than `DIGEST_TTL_MS` = 60 s
(`historyDigestRendezvous.ts`), and **every member stores every probe** - `noteProbeReceived` is
called with no addressee check, because the election is a separate transport the frame knows nothing
about. So: A probes at t=0, B is elected and consumes it, C and D store it. A probes again at t=35,
C is elected this time, and `awaitProbe` finds C's stored t=0 probe and consumes it **immediately**
rather than waiting for the fresh one that is on its way.

The docstring says a stored probe *"answers this request and no later one, so a second solicitation
always compares against a fresh snapshot"*. That holds for a DM, where the same peer is always
elected. It does not hold from three online devices upward, which is where the election shuffles.

**Consequence:** if the stale key happens to equal the responder's, the responder logs *"same state -
nothing to do"* and stays silent while the two stores actually differ - a missed repair, recovered on
the asker's next connect edge. Never a wrong message, never a loss.

**Shape of the fix:** a probe stored BEFORE the election frame that summoned this responder is not an
answer to it. Discarding those makes the comparison deterministic without any clock, which is the
property this area is held to.

---

## Reported by users - to reproduce first

### P1 - a community whose only channel is left becomes unmanageable

> *"il se passe des trucs bizarres quand je cree une communaute et que je quitte son unique salon. Je
> ne peux plus rien gerer dedans apres, meme la quitter."*

Leaving the last channel of a community appears to remove the surface that carries the community's
own controls - including *leave the community*, so the state is not recoverable by the user. That is
a user-facing path that is broken and it traps whoever hits it, which is what puts it at P1.

The first task is a REPRODUCTION, not a fix: it decides whether the community is genuinely
unreachable server-side (a membership row lost with the channel) or merely unrendered (the UI hangs
the community's controls off a channel that no longer exists). Those are different defects in
different layers and only one of them needs a migration.

### P2 - commenting a GIF on a post fails

> *"On ne peut pas commenter un gif sur un post (le bouton est la, mais les requetes echouent j'ai
> l'impression."*

A control that is present and does nothing. Capture the failing request first - a 4xx from validation
and a 5xx from the media path are different defects, and the button's presence says the client
believes the feature exists.

### P2 - the same person shows three different profile pictures

> *"Quelqu'un me dit qu'il a une photo differente sur Canari sur son PC, son telephone, et sur
> MiGallery."*

Three surfaces disagreeing means the cache key does not change when the picture does. The question to
answer FIRST is what the current cache lifetime actually is and where it is set - HTTP headers at the
media service, a service-worker cache, the client's own store, or all three - because a lifetime is
not a bug and a missing invalidation is. MiGallery is a separate origin with its own cache, so it
also establishes whether the URL itself is content-addressed.

### P2 - the message hover bar is too wide on desktop

The react/reply/... strip shown on message hover does not fit when the window is half the screen, so
its end is unreachable. A layout constraint, not a behaviour change.

---

## Interface

### P3 - the Canari admin page has too many tabs

Many tabs behind a selector that has to be dragged sideways to reach the end. The same problem is
already solved better in the association editor, which wraps onto several rows - so this is a
question of adopting the pattern that exists rather than inventing one.

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
timestamp, establish which column is written *by the connection* - and if none is, the merge needs
that column first. See [durable-rules](durable-rules.md).

---

## Storage and retention

The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

### Server - can occupancy be monitored, and will it hold?

The forecast exists on paper; what is missing is a live measurement and an alert. **A forecast with
no report is discovered by hand, a day late.** Scope: what is actually growing (Postgres, MinIO,
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

> **Already shipped, do not re-open:** *"ne garder que les messages les plus recents (dernier mois),
> et le reste recuperable en demandant l'historique a un appareil mobile"* is exactly the device
> window plus the scrollback range request delivered in the history-reconciliation rework - web keeps
> 90 days, mobile and desktop 5 years, and reaching the top of the scrollback asks a peer for the
> range below the window. See [history-reconciliation](protocols/history-reconciliation.md) and
> `historyWindow.ts`.

> **Already shipped, do not re-open:** *"pourquoi garder plus d'un accuse de lecture sur de vieux
> messages ? Si le dernier message a ete lu, le precedent aussi"* is the read watermark that replaced
> per-message `readBy` in the same rework - read state is now ONE timestamp per (conversation, user),
> and `readersOf` derives the per-message display from it. Old messages cost nothing extra, and a
> history catch-up cannot mark a read message unread because the watermark is compared, not the
> per-message list.

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
