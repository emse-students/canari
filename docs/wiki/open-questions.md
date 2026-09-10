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

**STILL OPEN, AND NOW WITH A DELIVERABLE ATTACHED (user, 2026-09-10).** Asked directly, the user
answered neither yes nor no: *"Dis-moi d'abord ce que ca coute."* So what is owed is a costed
scoping note - scope, dependencies, and **what it adds to the surface that has to be maintained**,
which is the half that actually decides it. The paragraph above still governs the note's first
section: it must answer what an app adds that the web cannot do before it estimates anything.
Nothing is built until the note is read.

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


### QUESTION - iOS has the mention elevation on ONE path too, and the plugin cannot express it

NOTIF-16 fixed the Android half on 2026-09-08: a message naming the reader is filed on
`canari_mentions`, and it is now chosen by BOTH builders rather than only the push one
([story](../../CHANGELOG.md), [rule](durable-rules.md)). The obvious follow-up - "does iOS need the
same?" - is ANSWERED in the source, and the answer is half of one and half of the other.

**iOS has no notification channels, and it does not need them: it has the elevation already, on the
push path.** `canari_NSE/NotificationService.swift` scans the decrypted text for `@[uuid]` exactly as
the Kotlin service does and sets `content.interruptionLevel = .timeSensitive` for a mention, which is
what breaks through Focus. That half is done and is not owed anything.

**The other half cannot be fixed the way Android's was.** The WebSocket path on iOS is the same
`tauri-plugin-notification` call, and its `Options` type declares `channelId` and NO
`interruptionLevel` - so there is no argument to pass. The Android fix worked because the plugin
happened to expose the field that mattered there; here the field does not exist. Closing it means
patching the plugin, adding a native command beside it, or accepting that a mention delivered over
the socket on iOS arrives at the default level.

**So the QUESTION is which of those three, and it is a judgement, not a measurement.** What each path
requests is readable in the source, above; what a locked iPhone does with it is not, and that part
waits on hardware like everything else iOS. Do not "fix" this by marking every message
`.timeSensitive` - that is the always-true mutation the Android tests exist to forbid, wearing an
Apple badge, and Apple reviews it.

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

### QUESTION - a reconciler's SILENCE means both "we agree" and "nobody answered", and only one of them is safe to escalate on

Split out of the responder P1 on 2026-09-08, when that entry closed on its measurement. **The defect
is fixed and measured; what is left is a design choice nobody has made**, which is why it belongs
here rather than in [backlog](backlog.md).

`escalateReconciliation` rotates to another member when a device can PROVE it is incomplete - it
holds a frame it can never read. That proof is what gates the escalation, and the gate exists
because the observation it would otherwise act on is ambiguous: a responder that stays quiet because
it holds the same history and a responder that is frozen produce **the identical silence**. A device
with no local proof of a gap cannot tell them apart, so it cannot escalate on silence alone.

**The obvious answer costs the saving the mechanism was built for.** Making the agreeing responder
ACK would disambiguate it immediately - one frame per group per ask - and that is exactly the traffic
the state-key comparison exists to avoid. So the question is a trade, not an oversight:

- is one ack per group per ask affordable at the population's real ask rate, measured rather than
  assumed?
- or is there a cheaper discriminator - the server already knows whether it forwarded to anybody
  (`no_peer_online`, `excludedOnline`), and that is a fact about REACHABILITY the asker currently
  never sees?

**Nothing should be written until one of those is measured.** The second looks cheaper and needs no
new frame, but it answers a different question - "was anyone reachable" is not "did the reachable one
agree" - and conflating them is the shape this repository keeps paying for.

**ONE HALF OF THE TRADE IS NOW MEASURED, 2026-09-08, AND A THIRD OPTION APPEARED WITH IT.** The
saving is not free: HEAL-repair heals three times in ten, and the arithmetic is the election's - three
online members, one of which holds the messages, twenty requests routed 10 / 7 / 3 across them
([backlog](backlog.md)). So the question is no longer *is one ack per group per ask affordable*; it
is *is it more expensive than seven failed repairs in ten*.

And the third option needs no new frame at all. The asker in that measurement DID hold local proof of
its own incompleteness - frames it has and cannot read, the same proof `escalateReconciliation` is
gated on - and the walk stopped anyway, because a responder that agrees on the state key answers with
its COVERAGE, and adequate coverage is signalled by silence. So the termination is not being taken on
an ambiguous silence at all: it is taken on a well-formed answer whose meaning, *I cover what you
asked*, is being read as *and therefore you are complete*. Refusing to terminate while the local proof
stands costs nothing and adds no traffic. Whether it is sufficient - whether the walk then reaches the
holder rather than merely re-asking the same agreeing peers - is the part still owed a measurement.

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

## Which account a SECOND phone would carry, the day one is attached again

**Parked because the hardware is gone, not because the question is hard.** A Pixel 6a was plugged in
temporarily on 2026-09-04; `adb devices` has listed only the Mi 9T (A1) since, which is what
`state.mjs` reports as `A2 (9335) UNREACHABLE` - **that line is explained and is not a defect, so no
session should spend time chasing the forward.**

The question it leaves: A2 is bound and addressable on port 9335, and **no account is assigned**. The
peer's, or a third one? One line in the out-of-tree `names.mjs` decides it, and guessing is an
identity invented by a tool rather than chosen by the person who owns the accounts.

**It is worth answering BEFORE the hardware returns**, because it now overlaps something concrete:
the third test account owed for first contact (NOTIF-17) would also be the obvious occupant of A2, so
the two asks are one decision rather than two. See the table of what is owed to the user in
[backlog](backlog.md).

**Where it came from.** Item C1 of the harness tidy, which is otherwise complete and was deleted on
2026-09-08 - its A and B sections shipped, its D items are the campaign order that
[cross-client-campaign-resume](cross-client-campaign-resume.md) carries, and its E items are the
standing bar now in `CLAUDE.md`. This was the only thing on the page that was neither done nor a
duplicate.

## Whether the three legal documents should be localized at all

**Parked because it is a legal question wearing a coding rule's clothes.** This repo's standing rule
is that every user-visible string goes through Paraglide, and the terms of use, the privacy policy
and the child-safety standards are **~900 lines of hardcoded French** - by far the largest violation
of it in the app. Their shell was rebuilt on 2026-09-10 and its chrome IS localized
(`legal_eyebrow`, `legal_last_updated`, the titles, the table-of-contents heading); the bodies were
deliberately left as they are, and not for effort.

**The reason is that a translated contract is a DIFFERENT CONTRACT.** These three texts name a French
association, a French address, the CNIL, article 33 of the RGPD and the courts of Saint-Etienne.
Which language version governs is a thing a lawyer decides, not a translator - and shipping an
English rendering through Paraglide would silently create a second document that a reader could
reasonably rely on. Google Play and the App Store both take the URL rather than the text, so nothing
in the store pipeline forces the question either.

**So the question is for the USER, and it has three possible answers**: leave them French-only and
carve them out of the Paraglide rule explicitly; translate them and state in the documents
themselves which version governs; or serve an English *summary* that says plainly it is not the
binding text. Only the first costs nothing.

**What must NOT happen is a session "fixing the lint" by machine-translating them.** That is the
failure mode this entry exists to prevent.
