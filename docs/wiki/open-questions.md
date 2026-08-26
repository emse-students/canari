# Open questions

**No code until they are answered.** Every item here is a QUESTION, not a defect: it has no severity,
and its first task is to produce an answer. That is why they are not in
[backlog](backlog.md) - that file is the scheduled queue behind `CLAUDE.md`, and a question mixed into
it reads like work somebody forgot to do.

**What happens to an answer.** It either becomes an entry in [backlog](backlog.md) with a severity, or
it closes the question and the section is deleted from here - with the reasoning going to the wiki page
that owns the subject, never left only on this page. A question that has been answered and still sits
here is the same defect this split was made to fix.

**These are owed to the user, not to the code.** Several can only be answered by a decision that is
theirs (what a Remove is meant to guarantee, whether an app is worth building), and the rest need a
measurement or a device nobody here has. None of them is waiting on an implementation.

---

### QUESTION - does an iOS attachment CONSUME the avatar cache file it is handed?

Found 2026-08-17 while writing the initials fallback, and it is a question rather than a defect
because settling it needs an iPhone. `CanariShowLocalNotification` hands `attachmentPath` straight to
`UNNotificationAttachment`, and for an avatar that path IS the durable cache file `avatar_<id>.jpg`
that `CanariFetchAvatar` writes and later re-reads. The NSE does the opposite on purpose: its
`attachImage` copies to a temp file first, carrying the comment *"an attachment URL is
consumed/moved by the OS, so we never hand it a shared cache file directly"*.

Both cannot be right. If the OS really moves the file, the app-process cache is emptied by its own
first hit and every subsequent notification re-fetches - a silent, permanent cache miss that no log
would name, since a re-fetch looks exactly like a first fetch. **What settles it is one device
observation**: notify twice for the same person with the app alive, then look for `avatar_<id>.jpg`
in the app container. If it is gone, the app path copies too, exactly as the extension does. The
initials disc is unaffected either way - it writes to `NSTemporaryDirectory()` on both.


### Is a MiGallery application worth it?

An open question, deliberately. The Canari formula (SvelteKit + Tauri) transfers, so the cost is
knowable - but MiGallery's value is a gallery that a browser already renders well, and the question
is what an app would add that the web version cannot do. Answer that before estimating anything.

---


### Server - can occupancy be monitored, and will it hold?

**The media half shipped 2026-08-18** and is documented on
[storage-forecast](infrastructure/storage-forecast.md): `/admin/storage` now separates growth (bytes
written per 7-day window) from a retention sweep that has stopped taking anything, and counts
separately the objects no sweep can EVER reach. That last one was not hypothetical -
`purgeExpiredMedia` iterates the metadata index, so an object with no entry is invisible to it for
ever, and 7 such objects (~11 MB) were already measured.

**The MLS half shipped 2026-08-19**, and this entry is closed. Postgres and Redis are no longer bare
totals: the panel lists the eight MLS tables by size with their row counts, reports the queue as four
figures (total, devices, oldest, and the DEEPEST single device queue - the one a total cannot show),
counts §5.7's WP-GHOST-1 shape continuously, and breaks Redis down by key prefix from a bounded
sample that says how much it sampled. The production baseline and the reasoning are on
[storage-forecast](infrastructure/storage-forecast.md); do not restate them here.

**Decided 2026-08-17: the panel is the whole of it, there is NO alert.** The user's call. Worth
stating what that costs rather than pretending it costs nothing - the standing rule is that a correct
mechanism with no report is found by hand a day late, and a panel is a report only for whoever opens
it. The slope is what makes it survivable: a number read once a month against a trend is enough to see
a wall coming, where a bare total is not. **§5.7's own "more than a few hundred rows" predicate is
deliberately left unarmed**: the deepest real queue is 189, so a threshold set from the last incident
would be a threshold nobody has measured against the population it would run on.

> **Already shipped, do not re-open:** _"ne garder que les messages les plus recents (dernier mois),
> et le reste recuperable en demandant l'historique a un appareil mobile"_ is exactly the device
> window plus the scrollback range request delivered in the history-reconciliation rework - web keeps
> 90 days, mobile and desktop 5 years, and reaching the top of the scrollback asks a peer for the
> range below the window. See [history-reconciliation](protocols/history-reconciliation.md) and
> `historyWindow.ts`.

> **Already shipped, do not re-open:** _"pourquoi garder plus d'un accuse de lecture sur de vieux
> messages ? Si le dernier message a ete lu, le precedent aussi"_ is the read watermark that replaced
> per-message `readBy` in the same rework - read state is now ONE timestamp per (conversation, user),
> and `readersOf` derives the per-message display from it.

---


### DECISION OWED - naming the author of each line inside a salon's stacked notification

Asked for by the user on 2026-08-20: salon notifications should read like a DM's - successive
messages stacking one under another in a single banner. **The stacking already exists**;
`handleChannelMessage` goes through `showNotification`, so a salon gets the stable per-conversation
id, the `MessagingStyle` history rebuild, the badge, the clear-on-open sweep and the cross-device
dismissal. NOTIF-11 is what will say so on a current APK.

What is genuinely missing is the ATTRIBUTION. `senderName = title` and `groupName = ""`, so every
line in a salon's stack is attributed to `<Communaute> - #<salon>` and a reader cannot tell who said
what. The comment there is honest about why: the server sends only `senderId`, for the avatar.

Two shapes, and the choice is the user's:

1. **The name on the wire.** One field beside `channelName` and `workspaceName`, which already
   travel in cleartext. Cheapest, and it puts one more piece of who-talks-to-whom through Google and
   Apple - which is the exact cost the reaction push was rewritten in 2026 to stop paying.
2. **A `push/display-name/:userId` lookup, beside `push/avatar/:userId`.** The phone already
   authenticates to that route with the push secret and caches the answer for 24 h; a name would
   ride the same shape and put NOTHING new through a third party. Costs one request per unknown
   sender on a cold notification, cached thereafter.

**Recommended: (2)**, because the avatar proved the shape and it keeps the wire where it was. Not
started - it is a real work package, and NOTIF-12 records the current behaviour rather than failing
on it, so nothing here blocks the campaign.

### Is a Remove meant to be durable against a later re-add?

**Raised 2026-08-26 by GRP-8**, and it is a decision rather than a defect - which is why the P2 it sits
behind ([backlog](backlog.md)) is written to change nothing until this is answered.

**What the code does today.** `sendHistoryBundleForIds` clips only on `since`, a time window the ASKER
declares (`groupActions.ts`), and performs no entitlement check of any kind: it never asks whether the
requester was a member when a message was sent. So a device removed at epoch 3 and re-added at epoch 4
that asks for the ids it is missing would be SERVED the plaintext of the messages sent while it was out,
re-encrypted under the current epoch.

**Why that is not self-evidently a bug.** `sendFullHistoryBundle` hands a NEWLY INVITED member the
group's whole backlog on purpose, so *"a member gets the history"* is the stated policy, and a re-joining
member is a member. GRP-3's assertion is about live delivery WHILE removed, and it holds - it says
nothing about a later re-add.

**Why it is not self-evidently fine either.** If a Remove is meant to be durable, then re-adding a member
is a way to hand them everything the Remove was supposed to withhold, and any admin who can re-add can
therefore un-do a removal retroactively. That is a property worth stating deliberately in either
direction rather than inheriting from whichever code path was written first.

**What was actually observed, and what it does not prove.** In the GRP-8 run the exchange went the OTHER
way: the re-admitted device SERVED two messages to the peer and received none. That is a fact about one
run, not a property - the direction was decided by which device noticed a digest difference first.

**What answering it costs.** Nothing to measure; it is a product decision. If a Remove must be durable,
the fix is an entitlement filter on the SENDING side keyed on the requester's membership history, which
the server can answer - not a client-side change, because a client asking politely is not a control. If it
must not be, the P2 behind this shrinks to what it already claims: stop calling the exclusion window a
loss, and stop reconciling for it.

