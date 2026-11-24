## The owner's decisions of 2026-11-17

Recorded so no question answered here is asked again. Each line names where its detail lives. The
lead's own reversible readings, taken under the owner's delegation, are marked as such.

### The `1.7.0` scope cut (afternoon) - it supersedes the morning's line below

*"Ce serait bien que la 1.7.0 sorte un jour quand meme."* The owner approved this cut:

- **`1.7.0` KEEPS** everything already merged; the P1 pull requests under review that day - an
  offline newcomer asks for its register (#3777), a salon push's catch-up linear in the key group
  (#3781), the two live seals reviewed and the chat load read (#3783), step 1 of sealed names
  (#3785), rows before ratchet (#3786) - plus the own-bubble mention contrast (#3784) and the
  `alpha.8` readings (#3788); the readings that merged work owes and that the bench can take; and
  **every defect introduced since `v1.6.12`** (a regression of `1.7.0`), whatever its priority.
- **`1.7.1` TAKES** the next steps of the big P1 chantiers (sealed names steps 2-4, the remaining
  windows of rows-before-ratchet, the admission rule's steps 2-5, any P1 whose remaining work is a
  multi-week step after its first shipped step); every P2 and P3 that is NOT a regression since
  `1.6.12`; and the readings that can only be taken after the stable.
- Group calls, the content-free push chantier, the reaction foreground trigger and the
  new-discussion panel were already `1.7.1` or later.

Each entry the cut MOVED carries a dated line saying so, and each entry it KEPT on a judgement
(a regression, new code, a path changed since `v1.6.12`, a merged fix awaiting its reading) carries a
dated KEPT line naming that evidence. The readings, the decision records and the entries owned by
the pull requests then open stand as they were; the seven entries filed the same day (below) are
written straight at their version. The
[plan](../plan.md) shows the result, the [roadmap log](../roadmap.md#log-of-replannings-and-milestones)
the counts.

### The morning

- **(superseded the same afternoon by the cut above)** The `1.7.0` stable waits for EVERY open
  `1.7.0` entry and reading, knowing the P1 chantiers make that several weeks (re-asked with that
  measure; the owner kept it).
- **Group calls stay held until after the stable, in `1.7.1`** (confirms (21) of
  [2026-11-16](owner-decisions-of-2026-11-16.md)).
- **Decision (20)'s deletions** (a reading half the bench cannot stage is deleted): the lead
  re-verifies each one; deleting is fine, and a wrong deletion is restored later.
- **The usage dashboard** - distinct people per day, week and month, six platform categories, a
  week-by-hour map, daily activity totals, no small-number threshold, anonymous by construction:
  [its entry](../usage-dashboard.md), `1.8.0`.
- **(lead, reversible) The push-token P1 is reduced to a reading taken in production AFTER the
  `1.7.0` stable** (#3765 makes the outcome name its cause). It does not block the stable; it is
  taken the day after both stores carry `1.7.0`, and a non-zero count opens a `1.7.1` P1
  (the reading was deleted 2026-11-22, read).
- **(lead, reversible, #3770) An association officer sees their OWN name small under the
  association** on the posts they wrote, as an anonymous post's author does; the association's other
  holders of the posting right are not served the writer
  ([moderation-authority, decision 11](../moderation-authority.md#the-decisions-of-2026-11-15-owner)).

### The afternoon (the owner present)

- **Opening a community: the P1 closes for `1.7.0`** once #3769 and its phone reading are in; the
  200 ms budget moves to the [slow-link chantier](../backlog.d/slow-link-local-first-chantier.md) (`1.7.1`).
- **The admission rule: step 1 (#3774, the count as a table) ships in `1.7.0`; steps 2-5 in `1.7.1`
  and `1.8.0`.** Step 2's card reuses "X veut rejoindre la conversation - Accepter / Refuser" as it
  is, and **a Decline removes the seat** ([entry](../backlog.d/p1-the-admission-rule-fix-forward.md)).
- **The live viewer cap: NO Cloudflare R2, NO Cloudflare Stream.** Stream must read the cleartext,
  which breaks principle 1 of [the charter](../../principes.md), and it bills per viewer-minute. The
  owner: *"rester totalement sur le serveur, quitte a degrader la qualite si trop de spectateurs"*
  (principle 4, independence). So O-1 is no for now - the storage stays S3-generic so that a
  SELF-HOSTED store remains possible; O-2 is moot; the quality step-down (c) is the audience answer,
  which REVERSES D2 (O-5 yes); what remains meets the soft "Connexion au direct..." retry of (e),
  never "live complet"; O-4 is moot (a cap remains, and Redis down fails closed as today). The entry
  stays `1.8.0` ([live-scaling 3 and 7](../frontend/modules/live-scaling.md#3-the-recommendation)).
  Researched for the owner: Cloudflare's CDN terms ask for a paid service of the Developer Platform
  (or Images, or Stream) to serve video
  ([Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/),
  "Content Delivery Network", read on [live-scaling (a)](../frontend/modules/live-scaling.md#a-segments-from-cloudflare-not-from-the-host));
  whether a free R2 bucket qualifies is unresolved.
- **Push payloads (content-free push): the whole chantier goes after `1.7.0`** (`1.7.1`,
  [entry](../backlog.d/push-payloads-carry-nothing-for-google-and-apple.md)); only its ring-end step ships in
  `1.7.0` (#3779, merged the same day).
- **Live bitrate.** The owner asked about H.265 or AV1 at about 2 Mb/s for 720p. The answer given:
  the server transcodes nothing (the content is end-to-end encrypted), so every viewer must decode
  the broadcaster's codec, hence H.264; and the Android `MediaRecorder` floor (~2.6 Mb/s) is the
  binding fact. **Approved: a bench measurement after the `alpha.8` readings** - `MediaRecorder` at 1
  and 1.5 Mb/s, WebCodecs at a fixed bitrate at 720p and 480p, and encode and decode support for
  H.264, H.265 and AV1 on the Mi 9T and the iPhone 12. It feeds stage 0 (ii) of
  [live-scaling](../frontend/modules/live-scaling.md#3-the-recommendation).
- **The host's egress, measured** (owner-approved, from the owner's own client hosts against a
  production static file): the ~90-107 Mb/s plateau of 2026-10-15 was the workstation's path; the
  host serves ~600 Mb/s and more to a close client
  ([realtime-media-feasibility 4](../infrastructure/realtime-media-feasibility.md#4-network-capacity)).
  `LIVE_HOST_EGRESS_BPS` rests on the wrong number:
  [re-derive it](../backlog.d/live-host-egress-constant-rests-on-the-workstation-path.md), `1.8.0`.
- **The departed roster seats are deleted in production** (asked twice; the first answer had not
  been written): *"au pire ils seront reinvites"*; a 1:1 goes with its departed seat. Done the same
  day - departed seats left: 0
  ([entry](../backlog.d/p2-the-group-panel-lists-22-roster-seats-that-hold-no-device.md), `1.7.1` for the panel).
- **Sealed names (#3785):** an invitation link carries the name in its `#fragment` (never sent to a
  server; link unfurlers show a generic card); the minimum client version for step 2 is the version
  carrying step 1 plus the creation dating
  ([entry](../backlog.d/p1-encrypt-the-names-of-groups-communities-and-salons.md)).
- **(lead, reversible, #3784)** A mention in the sender's own bubble takes the own-bubble variant
  (`currentColor`, no tint); incoming bubbles keep the accent.
- **Noise filed** (P3, `1.7.1`, none of them a regression shown since `1.6.12`):
  [a CSP refusal on every dev page load](../backlog.d/p3-dev-logs-a-csp-inline-script-error-on-every-page-load.md),
  a dropped 1:1 logged as a key group (fixed in `1.7.1`, entry deleted),
  and [the iPhone's landscape close circle clipped](../device-verification.md).
- **Seat counting for capped forms stays at submit, under the form's lock, for now.** A hold taken
  when the form is opened is refused (every browser that opens it blocks a seat, and a script can hold
  every seat of a public form); a 10-minute hold behind an explicit "Réserver ma place" button, one per
  signed-in person with a countdown, is the design kept: *"Plus tard (1.8.0)"*
  ([entry](../backlog.d/a-capped-form-holds-a-seat-behind-a-reserve-button.md)).
- **An organiser's test no longer notifies the people who asked** (seen on production that day: an
  opening moved to "now" for a test sent the opening reminder to everyone who had pressed the bell).
  *"A + B + affichage, en 1.7.1"*: (A) a "Tester l'envoi" in the preview, a test submission counted
  nowhere and the form not opened; (B) moving the opening earlier asks first, naming how many people
  asked to be told; (display) the reminder names the association (its logo) and the form's title.
  Refused: (C) notifying only once the link "was distributed", which nothing can know
  ([entry](../backlog.d/p2-an-organiser-test-of-a-form-notifies-everyone-who-asked.md), `1.7.1`).
- **A form notifies only the people who pressed its bell.** *"Je ne pense pas que les formulaires
  doivent notifier les gens (sauf quand ils ont cliqué sur la cloche du formulaire)."* A form's opening
  writes no row for the association's followers any more; only an "asked" row ("Me prévenir") gets
  the 5-minute heads-up and the opening. Events and booking spaces are untouched. Filed in the same
  entry, with a defect found that day: an opening moved later after it fired leaves the follower rows
  stamped as told, so the real opening tells nobody - every kind's moved opening must re-arm what has
  not really opened; that day's case was repaired by hand on production with the owner's yes
  ([entry](../backlog.d/p2-an-organiser-test-of-a-form-notifies-everyone-who-asked.md), `1.7.1`).

### The evening (the owner present)

- **The lead's autonomy runs THROUGH `1.7.1`, included**: pre-releases and the stable of `1.7.0`
  and of `1.7.1`, each stable once its pre-release is read on both bench phones and nothing blocks.
- **The dependency audit blocks a pull request only on what we ship** (#3795, decided that evening;
  [cicd](../cicd.md#the-audit-blocks-on-what-we-ship-2026-11-17)).
- **The new-discussion panel (#3793):**
  - a push for an UNNAMED group shows the sender alone;
  - the members' first names in that notification are a `1.7.1` entry, native on Android and iOS
    ([entry](../backlog.d/an-unnamed-group-s-push-names-its-members-by-first-name.md));
  - an older build shows "Groupe" for an unnamed group until step 3 of
    [sealed names](../backlog.d/p1-encrypt-the-names-of-groups-communities-and-salons.md) raises the minimum
    version - accepted;
  - **a named group can NEVER be un-named** - a decision, not an open question;
  - group creation stays create-then-invite, and a partial invite names who is missing (the
    `alpha.10` reading found an invite that added nobody:
    entry deleted 2026-11-18, read PASS on `1.7.0-alpha.11`).
