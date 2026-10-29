# Backlog

**Everything below is SCHEDULED** - the user's decision of 2026-08-18: nothing is parked. This file
is not a parking area; it is the DETAIL for the queue in `CLAUDE.md`, which carries the order and
one line per item. Read the order there, the substance here, and delete an entry from BOTH when it
ships.

The exception is the handful that genuinely cannot be pulled forward - blocked upstream, blocked on
hardware (an iPhone 12 is on the bench since 2026-09-30, so an iOS row now waits on a SESSION, not on
a device), blocked on credentials somebody else owes, or post-campaign by the
user's own decision. Each says which it is, and `CLAUDE.md` lists them together at the end of the
queue so that "not scheduled" never has to be inferred.

Severity uses the repo scale: **P1** security, or a user-facing path that is broken - **P2**
correctness, nothing at risk - **P3** hygiene. An item with no severity is a QUESTION, not a defect,
and its first task is to answer the question rather than to write code.

Each entry states what is known, so that picking it up does not start with a rediscovery. **Delete an
entry outright when it ships** - the rule goes to [durable-rules](durable-rules.md), the story to
`CHANGELOG.md`, the mechanism to the wiki page that entry points at. An entry describing its own fix
is an entry nobody trusts to be current.

**NOTHING FIXED BELONGS IN THIS FILE.** Where a fix is in the tree and only its measurement is
missing, it gets ONE LINE in the table at the top and no entry of its own - a fixed thing mixed in
with open work is how a queue stops being readable (user, 2026-08-30). Where an entry keeps an open
half, the shipped half is a pointer, never a retelling.

---

## Cotisation-disabled follow-ups (after the tier stack lands)

Left by the review of #2584. Start after the tier stack has merged.

- **P2 - a paid form that grants a cotisation still takes money after its association disables
  cotisations** (already on `main`, not caused by the stack). The grant then refuses with the "not
  enabled" 400 (`UserTagService.grantCotisantIfARise`), `FormsService.grantCotisationIfConfigured`
  answers `failed`, the claim is released and every replay fails the same way. On `main` the record
  is written `paid`; with #2597 it is written `paid_not_granted` (the tier is not held when the
  record is written), but the grant is still retried as if it could succeed. Fix it like the
  product path: refuse opening the payment of a granting form while the association has no
  cotisation mode, and treat "cotisation not enabled" as FINAL (`not-granted`), not retryable.
- **P3 - `assertMembershipGrantable` does not check that `grantedTagName` is set.** A legacy
  membership product with a cotisation mode but no stored tag opens a checkout, then ends
  `paid_not_granted`: refuse it at the opening. How many such products exist is owed to the
  operator, privately.
- **P3 - no integration case for a sweeper-settled tier that re-ranks to `paid_not_granted`**:
  `lydia-reconciliation.integration.spec.ts` settles a checkout the callback never confirmed, but
  never one whose tier is no longer a rise when the sweep settles it.
- **P3 - the social unit run ends with "A worker process has failed to exit gracefully"**: some test
  leaves a handle open (a timer, a pool); find it (`--detectOpenHandles`) and tear it down.
- **P3 - `account-erasure.integration.spec.ts` needs the schema CI synchronizes**: a fresh scratch
  database lacks tables it touches (`association_calendar_events` among them), so it fails on a
  local fresh-database run only - CI never shows it. Make the spec create what it reads.
- **P3 - retagging a tier leaves the forms that grant the old key behind.** Changing a tier's key
  does not update the `cotisationVariantKey` of the forms granting the old one: those forms then
  refuse every new answer (the tier ranks `unranked`) and an answer already in flight ends
  `paid_not_granted`. Either carry the new key to those forms in the retag's transaction, or refuse
  the retag while a form still names the old key; the hourly `[PAID_NOT_GRANTED]` line is what
  names a payment it already caught.

## Display follow-ups to the shop pricing (after the tier stack lands)

Left by the review of #2544. Start after the tier stack (#2544 and its followers) has merged.

- **P3 - two docs claim the settlement's rule for a form grant.** `rankTier`'s and
  `RankedGrantOutcome`'s comments in `user-tag.service.ts` say a form grant is ranked like a
  settlement, but a held tier differs: the form grant renews it, the settlement does not grant it.
- **P3 - no client wording for `MEMBER_PRICE_TAG_NOT_A_TIER`** in the admin tabs: add a Paraglide
  message (fr, en).
- **P3 - a cash sale's default price is computed outside `lockBuyerTiers`, one tier stale at worst.**
  `grantProductPurchase`'s `cashSaleQuoteFor` reads the beneficiary's tiers (`tierFactsOf`, or the
  grid's `listHeldCotisationTiers`) before `fulfillProductPurchase` takes the buyer's lock, so a tier granted
  or revoked in the same instant can leave the recorded default one tier off; the tag and the record
  stay correct, and a cashier is present. Compute the default inside the locked transaction, both
  branches ([cotisations](cotisations.md#c-manual-grant-from-the-cotisations-tab-cash--retroactive)).

## A paid form that grants a tier is refused to a holder of an equal or dearer tier, even when it sells more - decided by the user on 2026-10-29

A form that grants a cotisation tier and charges for more than the tier (an event, a meal) applies
the shop's rise rule to the whole answer: a holder of that tier or a dearer one is refused before
any payment, `409 FORM_TIER_ALREADY_HELD` or the shop's codes
([cotisations](cotisations.md#rising-to-a-higher-tier)). **The user confirmed on 2026-10-29 that the
refusal stays exactly as the review of #2597 built it - no change.** The alternatives that were
open (sell the rest and skip the grant, split the payment from the grant) are not to be built.

## Follow requests, member reposts, and visibility between spaces - decided by the user on 2026-10-25

**Starts AFTER the stable `1.4.1`; WP-F1 BUILT as a draft (2026-10-27), the rest planned below.** Today following a person is free and
silent (`user_follows`, no status), a personal post is seen by readers sharing a space with its
author (`postVisibleToUserSql`), and only associations republish (D38, D38b in
[profiles-and-access](profiles-and-access.md#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built)).

### The decisions

1. **Member reposts.** A member may republish another member's post to THEIR OWN followers, with
   the AUTHOR's consent: an "allow reposts" setting, per author or per post. A post of an entity
   (association, list, institution) is reposted without asking. Never an anonymous post. A block
   applies both ways. Hiding the original removes every repost. Same rules for reels. A repost
   enters the Suivis feed of the reposter's followers at the time of the repost; a notification goes
   only to readers who NEWLY see the post (the D38 rule).
2. **Follow requests.** Following a PERSON becomes a request the person accepts or refuses.
   Associations, lists and institutions stay free to follow, with no acceptance phase. Students are
   PRIVATE by default (requests to approve), every other profile public (accepted automatically);
   each user may change their own setting.
3. **Existing follows are kept**, recorded as accepted. Every user gets a followers list with a
   "remove follower" action. The processing goes into the register (C5) and the privacy policy.
4. **Visibility opens to accepted followers.** The user: *"Si on garde le systeme d'acceptation,
   pas la peine d'avoir des barrieres, meme entre espace, campus, formation etc. On peut ouvrir les
   vannes de visibilite je pense."* With acceptance in place, a personal post is visible to its
   author's ACCEPTED followers whatever their space, campus or formation, and the D34-D36 rule
   "personnel never see a student's personal post"
   ([profiles-and-access](profiles-and-access.md#d34-d36---who-is-who)) no longer holds for a
   personnel the student accepted. Read grants (WP7) stay out of the personal branch.
5. **The opening reaches ONLY accepted followers** (user, 2026-10-25, answering the lead's open
   question). The Tout feed stays filtered by spaces for non-followers, so what widens is exactly
   what the author approved, one person at a time.

### Follow requests: the four product rules taken on 2026-10-25, all of it still to build

- **Q1 - ALL PERSONAL ACCOUNTS ARE PRIVATE** (user: *"Tous les comptes sont prives alors. Pas besoin
  de faire de distinctions entre les comptes."*). Following any PERSON is a request the person
  accepts; there is no public/auto-accept variant, no per-profile default and no setting to switch
  it. Entities (associations, lists, institutions) stay free to follow. "Private" governs who may
  FOLLOW; space visibility of the Tout feed is unchanged. This SUPERSEDES decision 2's "students
  private by default, every other profile public, each user may change it" and removes the setting
  from WP-F1.
- **Q2 - A member's repost of an ENTITY post DOES widen its audience** to the reposter's followers
  (user: "Oui, jusqu'aux abonnes du membre"). The repost still needs no consent from the entity,
  never covers an anonymous post, and obeys blocks both ways and the hide cascade. WP-F6 and WP-F5
  must treat it as a disclosure change: Opus security review, and the repost's reach is the
  reposter's ACCEPTED followers only.
- **Q3 - Minors: moot.** With one rule for every person, no age-based or profile-based distinction
  exists to confirm; none is stored or added.
- **Q4 - A private account stays findable** by name in search and suggestions and can be asked; its
  posts reach only accepted followers (plus the space rule, per Q1).

### Confirmed by scenario with the user (2026-10-25) and three ideas that came with it

Checked with four cases: a student asks a student, a staff member asks a student (same rule, no
exception by profile), two people sharing a space still see each other's posts in the space feed
without following, and a member's repost (author consent given) reaches the reposter's followers
even when they do not follow the author. **New, from the same answers:** (a) rename the "Tout" tab
"Mon espace" for clarity; (b) an information button explaining each tab; (c) a broader tutorial
shown on the first open after a future update, covering many features of the app. All three are
product work for after the stable, none is designed yet; ask the user for the wording and the
placement of (b) and the scope of (c) before building.

### The work packages, in order: one small pull request each, its starting point and its proof

Planned 2026-10-27 against `main` at `a97e1cea5`. **Releases, not merges, are the unit that
matters here:** WP-F1 to WP-F4 and WP-F7 reach users in ONE stable - F1 alone would turn every new
follow into a request nobody can answer - and that stable carries a data migration, so it ships on
the user's go. WP-F5 and WP-F6 each follow in a LATER stable. **The two packages marked DISCLOSURE
(F5, F6) get an adversarial Opus security review before the lead arms them**; the others get the
ordinary review.

- **WP-F1 - the data model, the migration, and every reader counting accepted rows only. BUILT,
  draft pull request #2589.** Migration 114 adds `user_follows.status` (`pending` / `accepted`, a
  CHECK) with every existing row `accepted` (decision 3), then sets the default to `pending` so a
  writer that forgets the column fails closed; a partial index on what is pending FOR a person
  serves F2's inbox. `POST /api/posts/users/:id/follow` now writes a `pending` request and answers
  `{ ok, status }`; `DELETE` unfollows or withdraws; `GET .../follow-status` answers
  `{ following, status }` (`following` kept true for a request, for older clients -
  [legacy-compatibility](legacy-compatibility.md)). NO setting (Q1). Old WP-F2 is folded in, because
  a pending row read as a follow would be a leak the day F1 merges: the Suivis arm
  (`getFollowedUserIdsForUser`), the announce sweep (`announceRecipientsSql(true)`), the personal
  republication's newly-reached rule and the live push (`liveAudienceSql`) all AND ONE fragment,
  `acceptedFollowSql` (`follows/follow-status.ts`); the erasure and the block severing delete
  whatever the status. Proof: `user-follow-status.integration.spec.ts` (existing rows accepted,
  replay a no-op, a status-less insert pending, the CHECK), a pending follower in the reader-spaces,
  personal-republication and lives PostgreSQL specs - all three fail when the fragment is `TRUE` -
  and `follows.service.spec.ts` (a follow lands pending, a re-ask never downgrades an accepted one).
  Details: [social-service](services/social-service.md#a-follow-of-a-person-is-a-request-first-wp-f1-migration-114-decided-2026-10-25).
- **WP-F2 - the request API: inbox, accept, refuse, and the one notification. BUILT, draft pull
  request #2601, stacked on #2589.** Start:
  `follows/follows.service.ts`, `posts/posts.controller.ts` (the follow routes), the D38b request
  queue in `posts/personal-republications.service.ts` for the shape. `GET` the pending requests FOR
  the caller (the partial index of 114), `POST .../accept` (pending -> accepted, under a row lock so
  a concurrent withdraw cannot be accepted), `POST .../refuse` (the row is deleted; a refusal tells
  nobody and does not stop a later ask). A new request notifies ONE person through the existing
  `PostNotificationsService` (a `follow_request` type: a bell row and a push, `contentKey` for the
  native renderers, NOT in `MUTABLE_PUSH_TYPES`); an acceptance notifies the requester
  (`follow_accepted`) - each at most ONCE per pair, from a `user_follow_notices` row (never a
  clock), and the ask route is throttled per caller. An ask of an id that is not a person is 404
  `FOLLOW_TARGET_NOT_FOUND`, an ask across a block 403 `FOLLOW_BLOCKED`, both decided inside the one
  `INSERT ... SELECT`. The block severing deletes both directions whatever the status, and the
  request bell rows with them: a spec pins it.
  Proof: unit specs for each transition, a PostgreSQL spec for accept-vs-withdraw, the
  `post-notifications` spec for the two types, and the block case.
- **WP-F3 - the followers list and "remove follower". BUILT, draft pull request #2605, stacked
  on #2601.** `GET` my ACCEPTED followers (a person sees
  only their own list), `DELETE` one of them (the row goes, the removed person is told nothing and
  may ask again), and `GET` my own outgoing requests so a request can be withdrawn from a list.
  Start: `FollowsService`, the controller. Proof: a spec that a removed follower drops out of the
  Suivis arm, the announce and the live push at once (the F1 readers), and that one person cannot
  read another's list.
- **WP-F4 - the client screens, every string through Paraglide (`messages/fr.json` and `en.json`).
  BUILT, draft pull request #2616 (stacked on #2605).** As built: the inbox is
  `/notifications/follow-requests` (banner on `/notifications`, host `follow-requests`); "Mes
  abonnes" is the profile section `followers`, with the sent requests under it; the push renderers
  were F2's; a `follows` notification category with its switch; the rig row is FOL-REQ-1 on
  [cross-client-testing](cross-client-testing.md). The plan as written:
  The profile button in three states (Suivre / Demande envoyee / Abonne(e)), reading `status`; the
  request inbox beside the D38b requests in the notifications screen (accept / refuse); "Mes
  abonnes" with "Retirer" in the profile; the bell rows of `follow_request` / `follow_accepted`
  and their push renderers (Kotlin, Swift, web). Start:
  `frontend/src/routes/profile/[id]/+page.svelte:175`, `frontend/src/lib/posts/api.ts:669`.
  Proof: component tests, `bun run check`, and a rig row (two contexts: ask, see "Demande envoyee",
  accept, see the posts in Suivis; remove, stop seeing). Retires nothing yet: `following` stays
  until the floor passes this stable.
  **Left open by the 2026-10-27 review, each owed before the item it names:**
  - **Pagination of the three lists, a PRECONDITION OF WP-F5.** The inbox, "Mes abonnes" and the
    sent requests each load the first 100 rows (`FOLLOW_PAGE_MAX`) and no more. Harmless while a
    follower only means Suivis; once F5 makes a follower a READER across spaces, a person must be
    able to see and prune every one of them, so F5 does not arm until the screens page.
  - **P3 - an older build that saves its switches turns `follows` back on.** The client keeps only
    the categories it knows when it reads the disabled set (`fetchNotificationPreferences` filters
    through `isNotificationCategory`) and the PUT REPLACES the set, so a build older than WP-F4
    that saves any switch silently re-enables `follows` - and the same holds for every category
    added after a build shipped. The server cannot tell what the caller knew: the fix is a client
    that sends the categories it knows (`known`) so the server keeps the rest, and it protects only
    builds that send it - the floor (`minClientVersion`) closes the rest. Measured: not yet; the
    window is a person who turned `follows` off on a new build and then saves a switch on an old one.
  - **Should `minClientVersion` move with this stable?** A build older than WP-F4 reads
    `following: true` for a PENDING request (the legacy field, [legacy-compatibility](legacy-compatibility.md)),
    so it shows "Suivi" for an ask nobody has answered, and it has no inbox to answer one. Nothing
    leaks - the reader filters are server-side - but the person asked can only answer from a new
    build. A decision for the user when the stable is cut, with the share of old clients measured
    from the version header then.
  - **P3 - a row the block severing missed comes back when the block is lifted.** The severing is
    a best-effort cross-service call: when it does not run, the request or follow stays in
    `user_follows`, hidden by every reader while the block stands - and visible again, as it was,
    the moment the block is lifted. The unblock reaches social-service only as a feed-cache drop,
    which does not name the pair. The fix is an unblock call that names the pair and deletes what
    is left between them; until then the stale row is a pending request the person may still
    refuse, or a follow either side may end.
  - **Owner decision - a re-ask after a refusal rewrites the target's unread bell row** (no push,
    one row per pair, but no cap on how often it is rewritten). Product decision 3; left as built.
- **WP-F5 - the visibility opening to ACCEPTED followers (DISCLOSURE: Opus security review before
  arming).** Add an accepted-follower disjunct to the personal branch of `postVisibleToUserSql`
  (`spaces/reader-spaces.ts`), reusing `acceptedFollowSql`; NEVER for an anonymous post (following
  someone must not unmask what they posted anonymously), never through a read grant, and monotone
  for the newly-reached computation; the Tout feed stays filtered by spaces for everyone else
  (decision 5). Ships only in a stable AFTER the one carrying F3 and F4, with a one-time notice to
  every person that their followers will see their posts across spaces, so the grandfathered
  followers can be pruned first. Proof: an integration matrix (accepted / pending / none x same
  space / other space x personal / anonymous / association post), the read-grants spec unchanged,
  and the privacy-policy paragraph in the same pull request.
- **WP-F6 - member reposts with the author's consent, reels included (DISCLOSURE: Opus security
  review before arming).** The consent setting (per author, per post); the SQL beside the
  republication kinds (`posts/republication-sql.ts`, entity-only today); the consent check modelled
  on `posts/personal-republications.service.ts`; an ENTITY post reposted without consent but
  reaching the reposter's ACCEPTED followers only (Q2); never an anonymous post; blocks both ways;
  the cascades (hide, delete, block, erasure); feed placement in Suivis at the repost time; the
  D38 newly-reached notification; the share action in `frontend/src/lib/posts/sharePost.ts`.
  Proof: the D38b refusal list re-run for a member reposter, a hide removing every repost, a
  notification only for the newly reached, and the policy paragraph in the same pull request.
- **WP-F7 - the register and the privacy policy for follow requests.** Register C5
  ([register](compliance/register-of-processing.md)): the request, its answer, the followers list,
  retention (a request until answered or withdrawn; a follow until removed or either account is
  erased). The privacy policy (`/legal/privacy`, its public face - both change together), the
  terms (`/legal/cgu`) if they name following, and the D34-D41 tables of
  [profiles-and-access](profiles-and-access.md). Merges before the stable carrying F1-F4; F5 and F6
  each amend these texts in their own pull request.

### Risks, and what proves each away

- **Disclosure.** WP-F5 widens who reads a personal post. Grandfathered follows were never
  consented to, so the predicate change must not land before the followers list and "remove
  follower" are live, and each user should be told once that followers now see their posts across
  spaces. Proof: WP-F5's matrix, and the Opus review.
- **Notification volume.** A follow request is one push to one person; a repost notifies only the
  newly reached, under the D38 lock, so a repost of a widely seen post notifies almost nobody.
  Proof: the newly-reached spec counting zero for readers who already saw the post.

## P3 - what the 1.4.1 dev campaign left unexplained or noisy (2026-10-25, alpha.4)

Each is a log or console line the campaign met and no row asserts on. NOISE IS NEVER ACCEPTABLE
([CLAUDE.md](../../CLAUDE.md)): explain it or fix it, never demote it.

- **A past-epoch frame older than the joiner's own Welcome is logged at WARN as an unreadable loss.**
  Seen on ADM-1/3/4 (`[RUST::WARN] Past-epoch application frame, unreadable for good: msg_epoch=2
  group_epoch=3 ... TooDistantInThePast`), emitted while a new `WasmMlsClient` loads its state, right
  after "Welcome complete: re-queued 1 buffered message(s)" and before "[HISTORY] ... holds 1 frame(s)
  it can never read - reconciling". The frame predates the membership, so under the no-past-for-new-
  members decision it is not a loss: drop it at INFO with its reason, once.
- **A freshly minted device asks the server three times whether its own KeyPackage exists while it
  already knows its first publication is running.** DEV-1, W3: census "0 proven" and a generate round
  in flight, yet each of the three key-group external joins does `GET /api/mls/devices/<user>/<device>/key-package`
  and learns "absent" from a 404 ("externalJoin ... waits for the server to hold this device's
  KeyPackage (absent, a round is running)"). The wake-up is already round-driven; remove the GET
  before the first round (never learn by failing what a fact could tell).
- **Restored notices carry no proof and no mark (the `[AUTHORSHIP] ... carry no author proof` lines of
  DEV-1).** Every one checked is a system notice row (`sender 'system'`), never a user message: the
  count equals the system rows of each batch. Two classes. (a) Device-local rows relayed into other
  members' timelines (contact lines, outbox failure lines): P3, already filed above, fix = a
  "device-local" property set where the row is written and kept out of digest, diff and bundle.
  (b) Shared notices (member added/removed, rename, picture, Join cards) a new device legitimately
  restores: P2 under the Graine v2 authorship item, NOT a regression (v1.4.0 takes every restored row
  on the relayer's word with no mark; `#2276` makes it visible in the pre-releases). Fix at the
  source: store the event frame's verified authorship on the notice row, add a notice verdict in
  `restoredAuthorship.ts` that verifies the signed system frame and redraws the text locally
  (`renderVisibleNotice`) instead of taking the relayer's text; same for `channel_invitation`.
  Interim decision owed after the stable: show the unverified mark on system rows
  (`ChatMessageGroups.svelte` system branch) or not. Do not lower the log level; split the count
  into notices and messages.
- **Two flaky unit tests** (they pass alone, fail in the full parallel run, with or without recent
  changes): `ChatArea.entryWindow.svelte.test.ts` ("never mounts more than the 20-row entry frame")
  and `outbox.reelResume` ("KILL MID-UPLOAD"). Find the shared-state or ordering cause; a flaky gate is
  a gate nobody believes.
- **The rig's volume lines and its own probes** (JOIN_*, WELCOME_REQ, DISCOVERY, 409/400/403 probes,
  DEVICE_KEY/DEVICE_MEMBERSHIPS, the refresh lines of a minted device) are not declared as expected by
  the ADM and DEV rows; a rig allowlist PR follows the chain.

## Owed to the operator - legacy tier tags without a consistent issuer (2026-10-28)

A production count of legacy tier tags without a consistent issuer is owed to the operator after
the stack deploys ([cotisations](cotisations.md#a-tag-counts-only-for-the-association-that-issued-it)).

## P2 - The reel camera re-opened the camera and microphone for a moment after the member left it (Mi 9T, 2026-10-28) - fix in review: #2647

On a Mi 9T running `1.5.1` on dev, a member picked a video from the gallery in the CanaReels camera,
reviewed it and published it. The app's logs and the system's own records agree on two short,
unrequested opens. Nothing stayed open: the session released the late stream itself.

| When | App log (`[camera-session]`, `[camera]`, `[reel-capture]`) | System record |
| --- | --- | --- |
| The gallery picker returns, before the pick reaches its review | `back on screen - reopening` / `start user (#3)`, then `ready -> review on picked`, `stop`, `opened user`, `#3 came back after the session moved on - releasing it` | `dumpsys audio`: a CAMCORDER recording for ~0.5 s |
| After Publish, with the feed already on screen | `published`, `the screen is being left: the take is dropped`, `the take was dismissed`, `start user (#5)`, `stop`, `opened user: camera 1, facing front`, `#5 came back ... releasing it`, `released` | `dumpsys media.camera`: CONNECT then DISCONNECT of the front camera; `dumpsys audio`: a CAMCORDER recording for ~0.33 s |
| +33 s, +78 s, and in the reel viewer | nothing | no camera client, no recording |

Causes, the fix and its tests: [reels](frontend/modules/reels.md#the-camera-does-not-open-again-once-the-member-has-left-it-mi-9t-2026-10-28).
**Owed: one reading on the Mi 9T** - no CONNECT and no CAMCORDER window after a publish or a gallery
return.

## P2 - A salon heard of live while its community's listing is in flight is deleted by that listing's clean-up, silently (BIG-3-noI1 on Android, `1.4.1-alpha.6`, 2026-10-26; fix in review)

A member joins a community mid-session, so the client starts a full listing of that community's
salons. Another member creates a salon while the listing is in flight. The member hears of the new
salon live (`onChannelMemberJoined` in `ChatBackgroundService.svelte` logs `Joined channel ...` after
`addChannelToWorkspace` and the conversation row are written). Then the listing returns without the
salon, because it was read before the salon existed. Its clean-up removes the salon from the list.
The server still lists it, so it comes back at the next full listing (a reload or a reconnect).

The line is in `frontend/src/lib/composables/useChannelWorkspaces.svelte.ts`, `pruneAfterLoad`:

```ts
const bornAfterTheRequest = (id: string) => (locallyCreatedChannels.get(id) ?? 0) > epochAtRequest;
```

Only a salon created ON THIS DEVICE after the request is spared. A salon heard of live is not in
`locallyCreatedChannels`, so it lands in `staleLocalChannelIds`. The loop then runs
`ctx.conversations.delete(staleId)` and `removeChannelFromWorkspaces(staleId)` with no log line. The
later `removed N salon row(s)` count covers only the second pass, so nothing records this removal.
Communities carry the same guard by `createdEpoch` for the same reason; salons heard of live never
got one.

**Why the web seats passed and the phone did not.** They run the same code, and timing decides which
salons are lost. The phone's in-session listing took 6.4 s, and the creation fell inside it. The web
seats had joined earlier, so their listings had ended before the salon was created. The rig gesture
was ruled out: the community was open with its sidebar shown and listed only `général`. The DOM was
re-read by hand.

**The deciding rows.** LIST-RACE-1 is a RED/GREEN pair on a web seat and on the phone:
1. Hold the per-community listing GET once.
2. Have another member create a salon while the GET is held.
3. Release the GET, then read whether the salon is listed, counting rounds rather than clock time.
4. Run the same steps without the hold as the control.

RED runs on `1.4.1-alpha.6` and must show the salon lost. GREEN replays the pair on the pre-release
that carries the fix, together with BIG-3-noI1 and the COMM rows. The fix, in review, gives salons
created on this device AND salons heard of live one shared epoch record. A live deletion wins, and
every removal is logged.

## P3 - An unanswered call is written as a call with a duration, and a busy callee leaves its caller ringing (CALL-WEB, 2026-10-26)

**BUILT 2026-10-27 (draft PR): see [calls](frontend/modules/calls.md#the-call-record-one-writer-a-typed-reason-2026-10-27); owed the web-row readings.**

- **P3 left: render a call row from `callEvent.outcome` and `starterId`** instead of the text baked per side at write time, so a locale change or a second device reads the same row in its own words.

**These block the `calls_mode` flip, not the stable** (B15 and B16 in
[calls](frontend/modules/calls.md#the-blockers-each-with-its-evidence)). They are user-visible as soon
as calls are on. Read on web (W2 calling W4, `1.4.1-alpha.6`).

- **An unanswered call is written as a call with a duration.** The calls never answered were the
  cancelled one (CALL-WEB-5), the declined one (-4), the unreachable one (-6, which ends at the
  server's 60 s window) and the busy one (-7). All of them read "X a démarré un appel qui a duré moins
  d'une minute" (or "1 minute"), and the caller sees "Appel terminé · 00:00".
  - Cause, in `frontend/src/lib/utils/chat/callSystemMessages.ts`:
    - `handleCallSignalForChat` writes a rung invite with `recordCallStarted`.
    - Every later hang-up goes through `recordCallEnded`, which writes the duration.
    - `chat_system_call_missed` is written only for an invite that will NOT ring (the permission is
      off or calls are unavailable).
  - The fix needs a fact the signal does not carry today: whether the call was ever answered. The
    `answered` signal exists and is ignored here.
- **A busy callee gives the second caller nothing** (CALL-WEB-7). W5 called W4 while W4 was in a call
  with W2.
  - `CallService` does not ring a second invite over a call in progress. That is by design
    (`BUSY: ... nothing is sent for it`).
  - So W5 rang for the whole 60 s window and then ended. The call in progress kept flowing, which is
    correct.
  - Owed: an answer to the second caller (busy, or not answered at once), and the callee's missed
    call.

## Decision owed - does LIVE-STALL-1 judge the documented contract, "one stall per longer-than-seen gap"? (2026-10-29)

- The buffer policy promises that [a longer gap than any seen costs at most one stall](frontend/modules/live.md#the-buffer-policy-l-f1-2026-10-27):
  the target is measured from the gaps already seen, so a gap longer than all of them can still run
  the buffer dry once before the target grows.
- The row fails a viewer on ANY stall after its first delivery gap. A producer whose gaps keep
  growing for a while (3.6 s, then 4.7 s, then 4.75 s) can therefore fail the row while the player
  keeps its contract exactly.
- The mid-fetch stall defect found on `1.5.1-alpha.6` is fixed separately and is not this question;
  this row asks only which rule the board judges by.
- Owed: decide whether the row counts stalls per new longest gap (the contract) or keeps zero after
  the first gap (stricter than the contract), and align the row's definition and its judge in
  `liverows.mjs` with that decision. Neither is changed until it is taken.

## P3 - Id validators are sized by hand, not from the rule that mints the id (audit of 2026-10-28)

- Audited after the revoked-leaves 400 ([durable-rules](durable-rules.md#a-validators-bound-is-derived-from-the-generator-of-the-value-and-its-spec-uses-a-value-of-real-length)):
  every other `sanitizeQueryValue` field in chat-delivery fits its generator today (UUIDs, 64-hex
  user ids, device ids of at most ~87 characters).
- The latent gap: a user id is minted under "visible ASCII, no ':'" with NO length bound
  (`core-service/src/users/user-id.ts`), the device id EMBEDS it, and the services refuse a user id
  over 128 or outside `[a-zA-Z0-9_.:@-]`, and a device id outside social-service's
  `[A-Za-z0-9_-]{1,128}`. A user id of more than ~40 characters, or holding `.` or `@`, mints a
  device that some route refuses. Holds today only because the provider's ids are 64-hex.
- Owed: one shared shape for the user id and the device id, asserted by the minting side and every
  validator, rather than four regexes that agree by accident.

## P3 - An epoch-1 frame meets a device already at epoch 2 and is lost to `AeadError` (DEV-6, `1.4.1-alpha.6`, 2026-10-26)

This is a finding, not design. It is open until it is known why the frame arrives late.

Group `7820dd5c` is DEV-6's group. The first minted device (W3) is a member at epoch 1. At start-up,
while `WasmMlsClient::new` loads its state, it meets an epoch-1 application frame when the group is
already at epoch 2:

```
verbose [RUST::DEBUG] Sender data decryption error
info [RUST::WARN] Past-epoch application frame, unreadable for good: msg_epoch=1 group_epoch=2 group=7820dd5c-... err=ValidationError(UnableToDecrypt(AeadError))
info [21:28:49.670] [HISTORY] 7820dd5c… holds 1 frame(s) it can never read - reconciling (e.g. k1:137qgdw)
```

The second minted device (W6) reports the same frame key at 21:30:09. The invariant held, and HISTORY
reconciled the frame. The message is not lost to the user. The loss is on the MLS path.

The failure is `AeadError`, not `TooDistantInThePast`. The epoch-1 secret was still held, so the frame
could not be opened with a secret this device had at epoch 1.

What the console shows about the order: W3 took a Welcome into the group at 21:27:48. At 21:28:34 it
rejoined by its own external commit ("`[READD] ... roster seat with NO queued Welcome and NO add in
flight - nobody owes us anything; serving ourselves`", then "externalJoin succeeded ... (base epoch
1...)"). That rejoin is what took the group to epoch 2. The questions to answer:

- why a device that had just been Welcomed rejoined by external commit;
- whether the epoch-1 frame was encrypted before or after that rejoin;
- whether delivery order (the frame before the rejoin's commit) would have prevented the loss.

In the same load, the other groups show the expected case: frames older than the joiner's membership,
`TooDistantInThePast`. W3 logged 65 such lines. For example, six on group `1589de4c`:

```
info [RUST::WARN] Past-epoch application frame, unreadable for good: msg_epoch=2 group_epoch=54 group=1589de4c-... err=ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInThePast)))
info [21:28:49.602] [HISTORY] 1589de4c… holds 6 frame(s) it can never read - reconciling (e.g. oz:hnqfta, jd:326tvj, ...)
```

Those `TooDistantInThePast` lines are the item already filed above (*A past-epoch frame older than
the joiner's own Welcome is logged at WARN*). This item is the `AeadError` alone.

## P3 - A commit that has its answer waits for a history bundle applied under its loan (DEV-6, `1.4.1-alpha.6`, 2026-10-26)

The cause is to be read. On the second minted device (W6), two stray-leaf removals of the revoked
first device each got the server's answer while a frame of ANOTHER group held the loan of the MLS
mutex. Both times the borrower was a `history_bundle` system event:

```
info [21:30:12.853] [MLS_LOCK] a frame of a1c4da59… is applied while the commit of b1ecb448… awaits its answer
info [21:30:12.854] [MLS] System event 'history_bundle' from <member> in a1c4da59…
info [21:30:12.856] [MLS_LOCK] the commit of b1ecb448… has its answer - waiting for the frame applied under its loan
info [21:30:12.951] [STRAY] b1ecb448... is now at epoch 74 - the revoked leaves are gone from the tree

info [21:30:13.589] [MLS_LOCK] a frame of 10ddf2b7… is applied while the commit of 1589de4c… awaits its answer
info [21:30:13.615] [MLS_LOCK] the commit of 1589de4c… has its answer - waiting for the frame applied under its loan
info [21:30:13.674] [STRAY] 1589de4c... is now at epoch 57 - the revoked leaves are gone from the tree
```

Each merge was held for about 95 ms and 59 ms (`lendMlsLockWhile` in `mlsPerGroupScheduler.ts`).
Each wait ended without a cut or an error. A bundle's application (store, authorship check, encrypted
checkpoint) is longer than a commit's round trip, so a commit that lends to one waits for it.

Questions:

- should a frame whose application persists a checkpoint be allowed to borrow at all;
- or should the loan be bounded to frames whose cost is known.

The reclaim wait counts against the commit's lock-hold budget (`mayStartCommitRequest`). On a slow
device or a large bundle, this wait could turn a commit's outcome into "unknown".

## P3 - A community's history ask goes to the same member twice, 46 ms apart, and the first ask's answers are discarded (RM-4, `1.4.1-alpha.6`, 2026-10-26)

The salon creator (W1) asked the same member the same question twice: same devices, same community,
same epoch:

```
[21:49:56.321] [GRAINE] asked <member> (<their 2 devices>) for the history of community 53844ba7 at epoch 5 - reason no-seed-held, key group lost none this session
[21:49:56.367] [GRAINE] asked <member> (<their 2 devices>) for the history of community 53844ba7 at epoch 5 - reason no-seed-held, key group lost none this session
[21:49:56.446] [GRAINE] ignoring "I hold nothing" for community 53844ba7 from <member>: it answers request d6b6eb63…, not the history ask in flight (addressed to <member>)
```

The second ask replaced the first in `historyRequest`. Both devices' answers to the first ask were
then dropped at `debug` (`noteHistoryHeldNothing` in `graine/repair.ts`), so W1 printed the
`ignoring` line twice, and the member answered again. Nothing was lost; the cost is one extra round
trip per member. The row's other seats (W2, W4) show the same line shape.

The `ignoring` line is correct for a genuinely superseded ask. The defect is the second ask: two
triggers fire `requestCommunityHistory` for one epoch with nothing deduplicating them.

To do: name the two callers (the log context shows a key-group epoch move to 5 just before), and make
an ask for an epoch that already has one in flight to the same member a no-op.

## P3 - "Made private" is logged for a privacy flip the removal bound then refuses (RM-6, `1.4.1-alpha.6`, 2026-10-26)

`updateChannelAccess` (`channel.service.ts`) logs `[CHANNEL_ACCESS] made private by <actor>, granting
them channel=<salon>` when it adds the actor to the list it is about to compute. The removal bound
is checked after that. On RM-6, the moderator's flip was refused `403 REMOVAL_EXCEEDS_ACTOR`: the salon
stayed public and no group was minted. The server log still says the salon was made private.

A line that states an outcome before the outcome is decided is false whenever the write is refused,
so it cannot be narrated. Log the grant after the save, with the save's result, or reword it as the
intent ("flip to private by ... would grant them").

## P3 - A refused Welcome's leaf stays in a private salon's tree, and the next Add reads it as "already holds a leaf" (RM-5, `1.4.1-alpha.6`, 2026-10-26)

RM-5 cycle 1: the grant landed before the kick. The granter's Add put the subject's two devices in the
salon's distribution group, and the server refused both Welcomes:

```
[COMMIT] 357b4af8... the gate did not record the admit of <subject>:<device> (not_entitled) - its Welcome is sent and answered as before
[WELCOME] 357b4af8... Welcome REFUSED for <subject>...: the roster does not name its owner - terminal, no longer owed; the leaf it admitted has no seat and the stray sweep collects it
```

That much is designed. But 25 s later (cycle 2) and 2.5 min later (cycle 5), the granter's next grant
to the same subject decided:

```
[21:56:26.961] [GRAINE] ADMIT <subject> into salon 114d3327 of c2886ebf: all 2 device(s) already hold a leaf - no commit
```

The leaves the Welcome never reached were still in the tree, and the Add treated them as members
that need nothing.

**What each person sees, read from this run's consoles:**

- **The granter: nothing.** The panel shows the grant as made (`200`). The refused Welcome is an
  `error` in the console only. The later `already hold a leaf - no commit` is silent.
- **The subject, in this run: the salon appears, then is refused.** Each time the grant reached them
  live, their client logged `Joined channel 114d3327…` and `[CHANNEL] #114d3327… updated -
  canWrite=true`, so the salon shows as writable. The next read of its distribution group answered
  `403`, logged as `this user is NOT entitled to its distribution group (403) - no join is owed and
  no retry can help`, at 21:56:01, 21:56:26 and 21:58:40. Every cycle ended with the kick, so the
  subject was never entitled and nothing was withheld from a member.
- **The case this run did not reach: a grant that stands after a refused Welcome.** Reading
  `ensureJoined` (`graine/distributionGroup.ts`): the subject's device does not hold the group. Its
  seat was never written (the Welcome was refused), so no Welcome is owed to it. Its own door is
  therefore an external commit. Nothing waits on the admitter, so by the code it should self-heal.
  What is unobserved is the outcome of that external commit when the tree already holds a leaf for
  the same device (the duplicate-leaf case that GRP-4 closed for conversations). If the gate refuses
  it, the member has the salon in their list and can never read it: a **P2**.

**The row that decides it: RM-5 with a closing uncontested grant.** After the race cycles, with at
least one cycle where the grant landed first (a refused Welcome), rejoin the subject and grant them
without a kick. Then assert three things within the bound:

- the subject's device is `active` in the salon's distribution group;
- a message sent in the salon is readable on the subject's seat;
- the stale leaf is gone or reused, not duplicated.

**Read on `1.5.0-alpha.2` (2026-10-27): no duplicate.** All five cycles had the grant land first; the closing grant seated both of the subject's devices (`active`, one row each), a salon message reached the subject's seat, and the subject's own roster check counted 8 leaves for 8 active devices. The stale leaf is gone or reused, so the P2 does not arise; this stays a P3 for the two reads below.

To read:

- when the stray sweep runs for a salon group;
- whether `ADMIT ... already hold a leaf` should check the seat (`active`) rather than the leaf.

## Authorization audit of the group routes, remainder tracked privately (2026-10-25)

What the audit left open is in the private operations notes until each item is fixed; the rule is
in [durable-rules](durable-rules.md).

## Session liveness beyond the verifier, tracked privately (2026-10-25)

Two follow-ups of [sessions](sessions.md#an-access-token-is-only-as-alive-as-its-session-2026-10-25)
are in the private operations notes until each ships: token liveness for the services that verify
the access token themselves, and closing an open socket when its session ends (a separate pull
request).

## P3 - Post-stable proposal for the user: a partial unique index on tier keys (2026-10-26)

A tier key derived from its label is kept unique by an association-level advisory lock around the
sibling read and the insert ([cotisations](cotisations.md#a-new-tiers-key-is-derived-from-its-label-server-2026-10-26)).
Nothing in the schema enforces it: an explicit key from an older client still goes through a
read-then-insert check without that lock. Proposed for after the 1.5.0 stable, needing the user's
yes because it is a migration: a partial unique index on `(associationId, variantKey)` for
`membership` products (plus one for the base tier's null key), after counting the duplicates it
would refuse.

## P3 - `/api/auth/verify` reads the platform config on every request (2026-10-25)

Every `auth_request` reads `platformService.getConfig()` for the maintenance check, and since
2026-10-25 also one session row. The session read is the point; the config read is the same answer
for every request. A per-process read deduplicated across concurrent requests (one in flight, not a
TTL cache) would remove the config's queries (`ensureDefaults` plus the row read) from most requests. Not done in the liveness change, to keep it to one
fact. Owed: measure the verifier's query rate on production first.

## P3 - A group creation that fails before its creator is registered leaves an orphan group row (2026-10-25)

When creation fails between the remote group's creation and the creator's registration, the
client's cleanup `DELETE mls/groups/:id` is now answered 403 `NOT_A_MEMBER` (the creator holds no
seat yet), so the empty row stays. Owed: a server-side path that ends a group nobody ever joined
(the creator's own bootstrap, or the orphan sweep), with a spec.

## P3 - A resubmission refused for a reason that can later flip is read as definitive (ADM-3 review, 2026-10-26)

The settlement of an unresolved commit classifies a refusal from its body once, and treats it as
final even when the reason is a state that can change later (a seat, a block). Owed: name which
refusal reasons are definitive, and re-plan rather than settle on the others, with a test per reason.

## P3 - Key groups still accept a commit with a refused admit dropped (ADM-3 review, 2026-10-26)

A conversation's gate refuses the whole commit when it may not admit someone (ADM-3); a key group's
gate still accepts it and drops that admit. Owed: decide whether key groups follow the same
whole-commit rule, and the client rebuild it needs, with a spec on each side.

## P3 - Three helpers answer "is this caller a member of this group" (2026-10-25)

`assertCallerActsOnGroup` (`utils/group-membership.ts`) and the private member checks of
`invitations.controller.ts` and `members.controller.ts` (`assertCallerIsGroupMember`,
`assertCallerMayMutateMembership`) each read a caller's standing on a group in their own way. Fold them onto the one kind-aware read (`standingOnGroupOfKind`) with a spec per
route, so a group-keyed route has one answer to the question rather than three.

## P3 - A salon granted live shows its name in lower case until the grantee reloads (RM-4, 2026-10-25)

When an admin adds a member to a private salon's access list, the server announces it to the grantee
(`channel.member.joined`, carrying the salon's stored name). The grantee's sidebar then draws the
salon with its name lower-cased: `<Name>-salon` reads `<name>-salon`. It does so until a reload, which
brings back the stored case. The creator's own sidebar shows the stored case throughout. Read on
`1.4.1-alpha.3`; the name is stored in its original case. Where the case is lost on the receiving
path is not yet read. The salon runner now mints lower-case salon names, so its rows no longer
depend on this.

## P3 - A field change heard during a listing is overwritten by its older answer (2026-10-26)

The existence half is fixed: a salon or community heard of, or removed, while a listing is in flight
is dated against it ([chat](frontend/modules/chat.md#a-live-fact-heard-during-a-listing-is-newer-than-its-answer-2026-10-26)).
FIELDS are not: a rename or a `viewerCanWrite` change (`channel.updated`), a role change
(`workspace.role.changed`) or a cover/history change (`workspace.updated`) heard in that window is
overwritten by the listing's older row (`upsertChannelRow`, `upsertWorkspaceFromDto`) until the next
listing. Owed: whether it is seen at all (a demoted admin keeping controls for one listing is the
case that matters), then the same ledger keyed per field if it is.

## P3 - A re-fetch after a late Welcome re-reads frames the live socket already delivered (DUP-2, 2026-10-25)

After a late Welcome (a joiner reached by a member's commit before it, [mls-protocol](protocols/mls-protocol.md#a-joiner-whose-first-frame-beats-its-welcome-waits-for-it-dup-2-2026-10-25)),
the client re-fetches the frames it left behind as `unknown-group`. That re-fetch pulls every row the
server still holds for the group, including an epoch-4 application frame live delivery had read a
moment earlier and not yet acknowledged. MLS refuses the second read (`SecretReuseError`) and the
frame ledger ACKs it as `Duplicate delivery … silent ACK (SecretReuseError, already read by live
delivery)`. Read on `1.4.1-alpha.4` (dev.f49f499). Nothing is lost, but the duplicate comes from the
client itself, not from a lost ACK, so it is a defect, not a normal path: a decrypt spent to learn
what the client already knew. The mislabel the second read used to carry (`[FORK] not a fork … the
frame itself is damaged` at WARN) is fixed - classified as a spent generation in `messaging.rs` (#2466).
The re-read itself is not: the re-fetch should not ask for, or should not hand to MLS, a row the live
socket already delivered in this session. Not yet read: whether the re-fetch and the live drain share
any per-row identity (`queuedMessageId`) the re-fetch could skip on.

## P3 - Verify: an Add accepted but unannounced lets the joiner rejoin over its own leaf (DUP-2 review, 2026-10-25)

A joiner decides its door from its membership row (`readWelcomeOwedFromRow`). An Add the server
ACCEPTED whose answer the adder lost leaves the seat with `admittedAtEpoch` and the joiner's leaf in
the tree, the Welcome owed state on the adder (`owed_welcome.rs`). If the adder no longer holds the add
lock before it settles and no Welcome is queued, both facts are false: the reading is
`unhonoured-seat` and the joiner joins by external commit. **That is NOT the GRP-4 duplicate-leaf
shape**: the external commit carries the same signature key as the leaf the Add wrote, and OpenMLS
removes that leaf in the same commit - the routine rejoin of an active device that lost its state.
Pinned by `mls-core/tests/external_join.rs` (`an_admitted_joiner_joining_externally_leaves_exactly_one_leaf_for_its_key`)
and `recovery.test.ts` ("joins externally on a seat a commit admitted when neither fact holds").
What is owed is a VERIFICATION, not a decision: whether any adder path releases the lock before its
settlement (DUP-2 read `owed`, so the lock was held there), and then what the adder's late Welcome
does when it meets a joiner already in by its own commit (it should be refused as a spent key package
and taken as a redelivery). `getDeviceMemberships` carries `admittedAtEpoch` (it spreads the entity),
typed on `DeviceMembershipRow` since the review of #2466 and named in the recovery's
`unhonoured-seat` line, so a reading of the log tells an admitted seat from a stranded one. It is not
read as owed: a seat whose adder died would then wait for ever, and the join over it is safe.

## P1 - The ledgers that must follow the MLS state live in `localStorage`, which an unclean exit loses for seconds after each write (KILL-2, 2026-10-25; design owed)

Chrome commits `localStorage` to the profile LAZILY: on a fresh profile a write made 2 s or 4.5 s
before a hard kill of the browser was lost, one made 7 s before survived, and an IndexedDB write
made beside it survived every time (probe of 2026-10-25; Chromium also rate-limits those commits,
so a busy page can wait longer). The MLS state is written to IndexedDB (web) or `mls.bin`
(native), durable when its checkpoint completes. Every ledger whose job is to describe that state
and is kept in `localStorage` can therefore be BEHIND it after a browser killed, a crash, or an
app swiped away (the Android WebView keeps the same store in the app's process). Three do:

- **The leaf-refresh ledger** - closed by naming the leaf in each entry
  ([mls-protocol](protocols/mls-protocol.md#the-periodic-leaf-refresh)); the cost had been one
  extra refresh commit per such exit.
- **The seen-ciphertext ledger** (`history_seen_cipher:<user>:<group>`, `history.ts`). Its marks
  are written after the checkpoint that holds their ratchet advance (`commitPendingHistoryMarks`),
  and its docblock calls the remaining window "microseconds"; it is the store's commit delay. KILL-2
  measured the result: a read receipt consumed seconds before the kill was re-walked by the next
  history catch-up, MLS answered `SecretReuseError` at the device's own epoch, and the client logged
  `frame never read here and unreadable for good (secret-reuse)`, a `[FORK] not a fork` line and a
  reconcile ask - for a frame it had read. No consumption path skipped the mark (the held-back frame
  was drained through the ordinary pipeline after the merge); the mark was made and not kept.
- **The send-ratchet ledger** (`sendRatchetLedger.ts`), whose header chooses `localStorage` as the
  store "that survives the teardown". It survives a TAB teardown; it does not survive the browser's
  or the app's process dying within the commit delay of a send whose checkpoint (not awaited on the
  send path) had not landed either. The device then reloads a ratchet behind a frame that left and
  re-issues its generation: the peers refuse the next frame (`SecretReuseError`) - a real message
  lost, the defect that ledger exists to prevent. Not yet measured; the window is the same.

The design question is where these marks live so that they reach disk WITH the state they
describe, on both platforms - an IndexedDB store written in the checkpoint's own transaction on
web, and the MLS state or a file the native checkpoint writes beside `mls.bin` - and what each
reader does at startup. Measure first: a KILL-2 run with per-run console capture on each window,
and a kill after a send. KILL-3 is that kill on the WEB side since 2026-10-26: W1's browser, after a send
and after a receive. The NATIVE half (`mls.bin`) has no row, because no rig tool holds the Tauri
commit POST.

## P3 - A browser whose storage is broken is told the connection failed (KILL-2, 2026-10-25)

When the browser serves no storage at all - `indexedDB` and `navigator.storage.estimate()` both
throw `Internal error`, `localStorage` an empty in-memory store - the page boots to the PIN gate
and says *"La connexion n'a pas abouti. Réessayez dans un instant."*, with the status pill on
*Hors-ligne*. Nothing is wrong with the connection, and retrying never helps: the user cannot tell
that their browser's storage is the fault, nor that a browser restart is the cure. Seen on
`1.4.1-alpha.3` after a test rig's whole-browser kill left a Chrome profile without its quota
database (the data was intact on disk and came back on a clean restart, so the product wiped
nothing). The fix is to classify a storage failure at boot as its own type where it is thrown, so
the gate can name it; whether it earns a distinct message is decided with the fix.

## P2 - An unclean kill of a browser inside ~30 s of a rotation signs the user out (KILL-2, 2026-10-25; design after the stable)

A browser or app killed without a clean shutdown (a crash, an OS kill, power lost) inside about
30 s of a refresh rotation, or inside the window of two rotations close together, relaunches
signed out. A desktop browser commits its cookie store lazily, about every 30 s, and has no flush
the page can ask for (Android's `CookieManager.flush()` closes the same hole on the phone -
[sessions](sessions.md#the-rotation-has-to-reach-disk-and-on-android-nothing-guarantees-that)).
Every start is a refresh and every refresh rotates, so the relaunch presents a superseded token.
The server's rules then decide it, in `apps/core-service/src/auth/auth-sessions.service.ts`:

- `:26-37` (`isPreviousTokenInGrace`) accepts only the ONE previous `jti`, for 60 s after the
  rotation;
- `:218-224` a grace hit reissues the CURRENT `jti` without rotating, and that reissued
  `Set-Cookie` can be lost in the same flush window - which leaves the next start two generations
  behind;
- `:227-246` anything older is a replay: the session row and its push registration are deleted.
  The server cannot tell this from a stolen cookie, and its own comment says so.

**Reproduced on dev with a test-rig Chrome, hard-killed and relaunched each time:**

1. 70 s idle after the last rotation: the cookie on disk is current; the user stays signed in.
2. Rotation forced by a reload, kill about 5 s later: the previous token is presented inside the
   grace window and reissued; the user stays signed in.
3. Straight after case 2, a second rotation and a kill about 5 s later: neither the rotation nor
   the reissue had reached disk. The token presented is two generations old, `Refresh token replay
   detected … presented=older rotatedAgo=12s - session revoked`, and the user is signed out.
   This reproduces at will.
4. Rotation forced, kill 40 s later: current, signed in.

**Candidate fix, to design AFTER the stable, server side, shipped with a stable:** do not rotate
when the last rotation is younger than the grace window. A refresh inside the window returns the
current token unchanged, so a client can never fall two generations behind. Weigh it against how
strict replay detection is, since the window then also widens what a stolen cookie gets. It needs
an Opus security review. The test rig's KILL-2 row waits for the cookie to reach disk before its
kill, because its subject is a commit in flight, not this.

**Open observation, unexplained.** The first KILL-2 failure was not a replay: the relaunched
browser presented a refresh cookie for a DIFFERENT session, refused as `no such session`. That
session was absent from `auth_sessions` and from every server line since the service last
restarted, hours earlier, while the seat's live session had rotated three minutes before the kill.
The 401 cleared the cookie before it could be read. A cookie store that had failed to commit since
an earlier kill that morning would explain it, but nothing proves it.

## P2 - A join ask reaches only the elected member live (ADM-1, 2026-10-25; fix before 1.4.1)

The user decided that ANY member admits a new person
([mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)). In practice only one
member's device is told live. When a person follows a group link, the delivery service forwards
their `welcome_request` to ONE elected candidate device. Every other member raises the ask only from
`processPendingInvitations`, which runs on connection and when a group becomes ready. So an online
member with the conversation open sees nothing until it next reconnects. Read on `1.4.1-alpha.3`:
- the joiner accepted the link and the request was forwarded to the other member alone;
- the owner's sweeps ran 30 s before (no ask) and 2.5 min after, only because a page reload
  triggered the second one;
- the owner never showed the ask in between, and could not be the one to answer.

"Any member may accept" holds only after a reconnect. ADM-1/2/3/4/8 replay on the build with the fix.

## P2 - A joiner who was never admitted keeps the conversation, captioned as an established channel (ADM-2, 2026-10-25; fix before 1.4.1)

A person who follows a group link gets a sidebar row for the conversation, captioned
*"Canal E2E établi."*, while still waiting for a member. The row stays after a member's Decline:
- the server withdrew the seat and stopped listing the group for that user, the roster row went,
  and no exclusion was written;
- the joiner never read a message sent after the Decline.

Yet the conversation stayed in the joiner's list with the same caption. So did one whose ask was
never answered. The client never prunes a conversation the server no longer lists when this device
was never admitted. The caption also claims an end-to-end channel that does not exist, both while
waiting and after the Decline. Read on `1.4.1-alpha.3` (ADM-2: everything else in the Decline held).

## P2 - A cut holder's add lock ends only by its TTL, and a refused waiter sleeps to it (design after the stable, OFF-3, 2026-10-25)

Two clocks carry normal-path work in the group add lock:

1. **The server's lock TTL** (`ADD_LOCK_TTL_SEC = 30`, `apps/chat-delivery-service/src/utils/add-lock.ts`,
   set with `SET NX EX`). The normal path releases explicitly, by token. But a holder that is CUT
   rather than dead has no way to release, and its owed release (`addLockMarkers.ts`) is sent only
   before ITS OWN next acquire. So for every other member the lock ends by the TTL alone.
2. **The waiter's wake** (`wakeAtAddLockExpiry`, `frontend/src/lib/services/BaseMlsService.ts`). A
   refused acquire with a lost invitation waiting re-plans at the server-stated `PTTL` (bounded by
   `ADD_LOCK_WAIT_BOUND_MS`, `mlsDeliveryApi.ts`), because the holder's release publishes nothing.
   Even when the holder releases after 2 s, the waiter sleeps until about 30 s.

Not clocks on the normal path: the commit lock (`mls:commitlock`, 5 s, released explicitly on
every commit; its TTL is a crash backstop), and the pending pass, which skips a refused lock and
retries at its next pass, event-driven.

**Evidence: OFF-3 on dev, `1.4.1-alpha.4`, times from the server log:**

- `t0`: the committer takes the lock (`acquired=true ttl=30s`) and is cut. No release follows.
- `t0+30 s`: the key expires. Nothing logs it; the test rig sees the key gone after 29.9 s.
- `t0+45 s`: the other member takes the lock, then adds a member and makes two leaf refreshes.
- `t0+64 s`: the committer returns; its kept commit is refused (`epoch_mismatch`).
- `t0+65 s`: its owed release answers `released=false … owed=true`. The lock was long gone.

**Candidate redesign, to design after the stable** (server lock protocol; no new protocol in this
release). The release - explicit, or made by the gateway when the holder's socket closes -
PUBLISHES an event to waiters. The waiter re-plans on that event, and the `PTTL` wake stays only as
a dead-holder backstop.

What the design must keep is the H1 hazard (the original 10 s TTL expired mid-Add and two devices
committed on one epoch). A socket blip mid-Add must not free the lock under a commit still in
flight. The fence that makes a wrongly freed lock harmless is the commit path's epoch check: a
second committer on the same base is refused (`epoch_mismatch` / `concurrent_commit`), never
merged. The design has to show that this fence covers every way a socket-close release can race
an in-flight Add, including the Welcome loop after the accept. Needs an Opus design and security
review.

## P2 - An Add whose commit outcome is unknown is reported as failed (NET-3, 2026-10-25)

`processBulkAddition` (`groupCreation.ts`) handles a `CommitOutcomeUnknownError` in its catch-all.
It logs `console.error('[SYNC] processBulkAddition failed:', …)` and returns `not-added('failed')`,
and `reportBulkAdditionRefusal` then toasts that the invitation added nobody. The commit is KEPT
and resubmitted (`kept until a resubmission answers`). On `1.4.1-alpha.3` (NET-3, captive portal on
the commit POST) it was ACCEPTED at the next settlement, about 26 s later. So an unknown outcome is
logged as an error and shown to the member as a failure, and the member may retry an Add that is
going to land. It wants its own outcome: an Add pending its answer, said as such, at `warn` at most.
P2 (re-graded the same day): the toast misinforms, and the member may retry an Add that will land.
**#2426 (merged) covers the TYPED case**: a `CommitOutcomeUnknownError` now returns
`outcome-unknown`, logs at `warn` and is said as a warning ("pending connection"), pinned by
`conversationRefusalMessage.test.ts` and `lostInvitation.test.ts`. **What is left is the
catch-all**: a no-answer NOT thrown as that type still reaches `console.error` and `failed`. Whether
a portal on the commit POST always reaches the typed error is what the OFF-3 replay on the next build
answers - if it falls through, the fix is at the throw, not at the toast.

## P2 - An invitee the Add could not check is dropped silently when others are added (1.4.1 dev campaign, 2026-10-25)

`processBulkAddition` (`groupCreation.ts`) asks `isBlockedWith` for each invitee before the Add. A
check that THROWS (a captive portal, a dropped link) only logs `[ERROR] Could not check whether <id>
can be added, skipping`, and the invitee leaves the batch. The user is told only when NOBODY is left
(`nobody-reachable`, `chat_invite_error_nobody_reachable`). With several invitees and one that could
not be checked, the others are added, the gesture reads as a success, and the dropped person is
named nowhere on screen - the user silently loses part of an action. The same shape follows two
steps later: an invitee whose device fetch comes back empty is skipped with `[WARN] Skipped: no
devices found` and no notice. Found by reading while the campaign ran the portal row (NET-3) on
`1.4.1-alpha.3`; the fix is to carry the skipped users in `BulkAdditionOutcome` and name them in
the notice. A blocked invitee is skipped deliberately and stays out of this.

## P3 - A leave made while the link is down loses its `memberLeft` notice for good (RM-8, 2026-10-25)

When a member leaves while every request fails, `leaveGroupAndBroadcast`'s notice send throws:
`[GROUP] memberLeft notice for <8>… NOT delivered, and not sent later - the members see the roster
change without it: DeliveryUnreachableError`. The exit itself is kept and replayed on reconnect
(`pendingGroupExits.ts`, `[EXIT] ... leave replayed - server removed this user`), but the notice is
not: the local state is already forgotten, so nothing can encrypt it later. The others see the
roster change and the leaver's leaf goes at their next connection (`strayLeaves.ts`), but no
"X left" line ever appears in the conversation. Read on `1.4.1-alpha.3` (dev.9335201) by RM-8. Either
the owed exit carries the notice and its replay sends it before the server step, or the exit
replay produces the notice. RM-8 names the line as expected, in that row only, until then. The
online cousin of this is the GRP-6 entry below (a 403 race), whose fix is ordering.

## P3 - A salon's `memberAdded` notice carries no minted id (review of #2412, 2026-10-25)

`inviteMemberToChannel` (`useChannelWorkspaces.svelte.ts`) still sends its `memberAdded` through
`mkSystem`, with no `messageId`, while every group notice uses `mkVisibleSystem` since the
notice-identity fix ([chat](frontend/modules/chat.md#a-visible-system-notice-needs-an-identity-the-sender-minted)).
A salon row is server-authoritative, so the history exchange this PR is about does not reach it; what
an id-less notice costs there (a duplicate on a replay or a re-fetch) is unmeasured. Not built.

## P3 - Device-local rows written as `system` are relayed into other members' timelines (review of #2412, 2026-10-25)

The acting device now writes its own visible notice under the frame's id
([history-reconciliation](protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice)).
Left, not built: rows that only THIS device should ever hold are written with the same sentinel
sender and a random id - the outbox's edge-blocked and send-failure lines (`outbox.ts`), the eviction
notice (`eviction.ts`) - so they enter this device's digest, the diff pushes them to every peer that
lacks them, and they land in other members' timelines marked unverified. The rule wanted is a
property of the row ("device-local": never described, never relayed), carried at the write rather
than guessed from the sender. Found by reading; the relay count in the field is unmeasured.

**The device notice's contact line is the same class, with one difference (DEV-1, `1.4.1-alpha.3`,
2026-10-25).** `writeContactLines` (`deviceNotices.svelte.ts`) writes the "X added a device" line with
the same `system` sender, under a DETERMINISTIC id (`contactLineId(group, event)`), so two contacts
that both wrote it never trade it. But the device's OWNER never writes it (`owner-alert`, no line),
nor does a device minted after the event - so the digest diff can push a contact's line to exactly
those devices, unverified. The DEV-1 judge reads the owner's pane at 0 lines within the row, which
bounds the window, not the relay. **The fresh device RECEIVED them.** On DEV-1, W3's `[AUTHORSHIP] N
restored message(s) ... relayed by <user> carry no author proof` lines name W2's account as the relayer
of exactly 1 unverified row in the group the row had just created. That is the one line DEV-1's judge
counts there, the line about W3 itself. Each contact relays 3 to 5 such rows per standing conversation,
in step with the owner devices minted before. This was read from relay counts by relayer, not row by
row. The same "device-local" property closes both.

## A revoked device whose refresh cannot name its revocation

A design limit of the refusal record of [sessions](sessions.md#a-refresh-refused-because-the-device-was-revoked-says-so-2026-10-25),
not a defect: the record answers only for a session the revocation itself ended and that is still
inside its credential's life. Three cases fall outside it and leave through the plain sign-out,
which keeps the local stores until the next sign-in: a device that stays away longer than its
refresh credential lives, a session bound to no device id, and a session the revocation could not
end (the delete answered `503`). What covers all three is the device check on the next sign-in, which
asks with a fresh session and resets the device there. Owed: one rig row reading that next-sign-in
reset, so the cover is observed rather than read from code.

## P3 - A fresh device's own KeyPackage read answers 404, and every browser prints it red (DEV-1, `1.4.1-alpha.3`, 2026-10-25)

`awaitOwnKeyPackagePublished` (`BaseMlsService.ts`) reads `fetchDeviceKeyPackage(self)` before an
external join, and on a device that has not published yet the delivery service answers 404 with its
typed reason. The client reads it correctly as "absent" and waits for the round - but the browser
prints `Failed to load resource: ... 404` at `error` level on EVERY fresh device, which no needle may
forgive (a 404 elsewhere on that path is a real loss). Wanted: the own-publication read answers
`200 {held:false}`, an answer and not a failure. The same endpoint serves a PEER's package to
`processPendingInvitations`, whose typed 404 (`deviceKeyPackage.ts`) must not change, so the fix is a
read of one's own publication rather than a new status on the shared one; old clients that read the
404 get a [legacy-compatibility](legacy-compatibility.md) row with its removal date. Until it lands
the DEV rows stay `PASS-DIRTY` on this line, named.

**Seen again on DEV-6 of `1.4.1-alpha.6` (2026-10-26)**, on the second minted device. The 404 is
that device's read of ITS OWN package: the URL names its own device id. It is not a read of the
revoked first device's package. It is followed by
`[MLS] externalJoin b8ea5710... finds NO KeyPackage published for this device (absent) and no round
running - starting the round` at `warn`, which is the same item. It is not a separate finding about
revoked devices.

## P2 - The native Android senders trust a 200/201 without reading the body (review of #2428, 2026-10-25, needs a device reading)

The web send now reads a non-JSON 2xx as no answer
([chat](frontend/modules/chat.md#a-2xx-a-captive-portal-answered-is-no-answer-2026-10-25)); the
Android background senders do not. `sendQueuedMessagePush` (`CanariFirebaseMessagingService.kt`)
returns `code == 200 || code == 201` and never reads the body, so the drain records the id in
`sentIds` and `appendOutboxSent` drops it: a notification reply or an `OutboxRetryWorker` send on a
captive portal is lost for good, exactly the web defect. `BackgroundWelcomeAnswer.kt` does the same
with `httpCode in 200..299`. The iOS NSE only reads, so it is unaffected. The real exposure is narrower
over HTTPS (a portal cannot answer for the server without a certificate error, which is a transport
failure), but the rig reproduces it over plain HTTP. Fix: the content-type check before counting a
send. Owed: one device reading on the Mi 9T behind a portal.

## P2/P3 - Writes that trust a 2xx without reading anything (review of #2428, 2026-10-25)

#2428 covered the places that PARSE a 2xx. About 140 write sites read no body at all, so a portal's
`200` is believed. Ranked:

- **P3** `renameGroup` / `setGroupImage`, and the notification-preference PATCH/PUTs
  (`notifications/preferencesApi.ts`): the change is lost silently and shows again on reload.
- **P3** `registerMember` swallows every outcome but its two typed refusals (`USER_BLOCKED`,
  `MEMBER_NOT_ADMITTED` since ADM-3); its removal condition is
  [legacy-compatibility](legacy-compatibility.md#no-date-yet---registermember-after-an-accepted-add-for-a-server-older-than-2026-10-25).

The plan is the shared guard (`assertAnsweredByApi`, `utils/apiJson.ts`) applied per site with its
test. `dismissGroup` and `removeMemberFromServer` already carry it (#2428). A blanket sweep inside `apiFetch` is not the plan: some routes answer
non-JSON on purpose (media, files).

## P3 - Connectivity stays "reachable" through a captive portal, so the send waits for the ladder (review of #2428, 2026-10-25)

`trackedFetch` calls `tracked.answered` on the portal's `200` before any reader sees the body, and
every other `apiFetch` (a presence poll, the version probe) does the same. So the store never leaves
"reachable", and when the portal ends there is no transition for the reconnect resume to fire on: a
kept send goes on its backoff ladder, up to 60 s later. It is not a local fix. Reporting
`tracked.failed` on the send alone would flip the store, and the next poll answered by the same
portal would flip it back and fire a resume into the portal. The fix needs `trackedFetch` to know
which routes speak JSON, the version probe included.

## P3 - The outbox sends into a group whose commit outcome it already knows is unknown (DUP-5, 2026-10-25)

When an Add's commit is answered `503`, the client knows the outcome is unknown: it logs `the Add got
no answer - kept with its invitation, settled at the next connection` (`CommitOutcomeUnknownError`).
A message queued for the same group is still attempted. The outbox then logs `transient failure
(attempt 1..3): CommitOutcomeUnknownError …` and backs off between tries, until the reconnection
settles the commit (`duplicate`, merged) and the send goes. Read on `1.4.1-alpha.4`, DUP-5: three
failed attempts in about eight seconds. Nothing is lost, and the order holds. But the outbox learns by
failing what a fact on the same client could have told it. The fix is to carry the group's
unknown-outcome state to where the outbox decides to attempt a send, so that it waits for the
settlement instead of trying and failing.

## P3 - One failed Add is reported three times (TOK-2, 2026-10-25)

When a bulk Add fails, the client says so three times within 3 ms. Read on `1.4.1-alpha.4`, TOK-2,
where the token renewal behind the commit failed (`DeliveryRenewalFailedError`):

- an untagged `Bulk invite error: <typed error>` at log level;
- `[SYNC] processBulkAddition failed: <typed error>` at `console.error`, with a stack;
- `[GROUP] an invitation added nobody (failed)`.

All three carry the same fact. The rule is that a line is either expected and necessary, or the
visible end of something upstream. So one failed Add should be ONE accusing line that carries the
typed outcome: tagged, at the level the outcome deserves, with no stack for a typed and expected
error. The cross-client rig forgives the three as TOK-2's provoked narration until this is fixed, and
the needle's comment points here.

## P3 - A harness self-test run failed twice and could not be reproduced (2026-10-25)

`make test-harness` failed twice in a row in a fresh worktree of the TOK-2 rig fix, then passed. The
first failure stopped at the `lucide-selftest` step, the second at the `sourcestamp-selftest` step.
Both times the kept output was only the tail, so the failing assertion was not captured. Ruled out:
- the change under test, which touches neither file nor anything either reads (settle-row files only);
- a missing dependency: the third run passed in the same worktree, unchanged;
- determinism: each of the two self-tests passed three times in a row on its own afterwards.
What was running at the same time: the rig's own replay chain, on the operator checkout, a
different worktree. `sourcestamp-selftest` writes a file into its tree and hashes the tree twice, so
something writing to the same tree would break it. No writer was found. If either step fails again,
keep the full output, not the tail.

## P3 - Two devices of one account joining a community at once: one exhausts its external-join attempts and loses a frame (LIST-RACE-1-W, 2026-10-27)

Seen on dev `1.5.0-alpha.1`. W4 and W8 are two devices of ONE account, which a user with two devices
can produce by joining from both. They external-joined the community's key group in the same second.

- W8 was refused `concurrent_commit` twice, then joined at base 2.
- W4 was refused `epoch_mismatch` three times: base 0 at group 1, base 1 at group 2, base 2 at group 3.
  It reached `EXTERNAL_JOIN_MAX_ATTEMPTS` and logged
  `[GRAINE] could not join the distribution group of community ... (refused)`.
- 0.9 s later another path joined it at base 4. An application frame of epoch 4 then reached it at
  epoch 5: `[GRAINE] frame on ... is unreadable for good (past-epoch-application) - acknowledged; its
  seed comes back through a history request`.

The row still passed, but this is a heal after a race on the normal path, which the rules count as
a defect: the bounded retry lost to its own sibling's commits, and a frame was lost and had to be
recovered. The give-up line had appeared in no row since 2026-08-27
([cross-client-campaign](cross-client-campaign.md)). Evidence: the run's W4 and W8 consoles
(`logs/consoles/LIST-RACE-1-W-2026-10-26T23-45-59-975Z-*`, W4 lines 123-171, in the rig's state
directory). Owed: say what serialises two joins of one account into one key group. That fact
deletes the overlap; a larger retry bound only widens it. Then re-measure with LIST-RACE-1-W, which
reproduces the pair. Not narrated: it stays dirt until fixed.

## P3 - "they can still read it" after a refusal whose commit log has just applied the departure (BIG-3-noI1, 2026-10-27)

`rosterReconcile.ts` logs `[GRAINE] could not remove N departed member(s) from ...: <error> - they
can still read it` on every failure of its Remove. On dev `1.5.0-alpha.1` the failure was
`concurrent_commit`. The line just before it in the same console says the commit log was read and the
concurrent commit WAS that departure (`refused concurrent_commit at epoch 7: read the commit log, 1
commit(s) applied, now epoch 8`, with the member gone from the tree). So the line states something
false, and a reader told "they can still read it" is sent after a leak that did not happen. Owed:
classify the refusal against the commit log the client just read. Say "still read it" only when the
departed member's leaves are still in the tree after that read; say "removed by another member's
commit" when the log already removed them. Never branch on the error's message: the outcome is a
fact the caller already holds.

## P3 - The presence watch list is a set, not a count: one release unwatches a peer every other holder still wants (review of #2618, 2026-10-27)

`watchUsers` / `unwatchUsers` (`presenceStore.ts`) add to and delete from one `Set`. Several holders
watch the same peer at once: the DM's `ChatHeader`, that DM's sidebar `ConversationTile`, and a
salon's `ChannelMembersList` (`ChannelMembersList.svelte:59` releases every member id it watched).
When one of them releases, the peer leaves the poll for all of them. Leaving a DM therefore stops
polling a peer whose sidebar tile is still on screen, and the dot freezes until something else
watches that peer again. Owed: count the holders per id, with the release decrementing. Add a unit
test with two holders and one release, which must still poll. The WP-PRESENCE push that replaces the
poll needs the same count for its watch set.

## P3 - A conversation tile watches the presence of the peer it MOUNTED with, never the one it shows later (review of #2618, 2026-10-27)

`ConversationTile.svelte` calls `watchUsers([contactName])` in `onMount`. A tile whose `contactName`
or `isDirect` changes while it stays mounted (a keyed list that reuses the component, or a row whose
identity resolves after mount) keeps watching the first peer. Owed: an `$effect` on `contactName` and
`isDirect`, capturing the watched id in its body as `ChatHeader` does
([architecture](frontend/architecture.md#a-teardown-sees-the-values-its-effect-saw-and-a-derived-read-there-keeps-them-2026-10-27)),
with a test that changes the prop and asserts the watch moves. It is cheap to fix together with the
ref-count entry above.

## P3 - A Remove refused `concurrent_commit` that moved no epoch is left to the collector (decided 2026-10-25)

When the gate refuses a Remove `concurrent_commit` before the lock holder's commit has landed, the
refusal proves no progress, so it is not rebuilt: the caller is told "removed, the key change follows"
and `removeStrayLeaves` commits it at a holder's next connection. Waiting for the winner would be a
clock. The candidate is an EVENT-driven wait for the winner's epoch (the local epoch moving past the
refused base), which needs a proof of termination when the winner itself fails. Not built.

## P3 - A pass's unconfirmed tree aborts the group's later pending rows (review of #2416, 2026-10-25)

`pendingAddFactsOf` caches the confirmed tree for a pass, an `unconfirmed` reading included, so every later row of that group aborts `tree-unconfirmed` in the same sweep. Conservative (nothing is added on an unknown tree) and the next sweep retries; a fresh read per row after an unconfirmed one is the candidate. Not built.

## P3 - The add lock is not renewed through a long rebuild chain (review of #2416, 2026-10-25)

An Add takes the server's add lock (`ADD_LOCK_TTL_SEC`, `apps/chat-delivery-service/src/utils/add-lock.ts`)
once, and nothing renews it while `rebuildOnRace` rebuilds. Each rebuild now adds round trips (the
confirmed tree, the premise re-reads), so a long chain can outlive the TTL, and a second Add could
take the lock while the first is still staging. Candidate fixes: renew the lock in each attempt, or
bound the chain by the TTL and surface `add-lock-busy`. Not built.

## P3 - The edges of the lost-invitation re-plan and its add lock (reviews of #2426, 2026-10-25)

What the re-plan of a kept invitation leaves open ([mls-protocol](protocols/mls-protocol.md#an-invitation-whose-kept-commit-did-not-land-is-re-planned-or-the-member-is-told-2026-10-25)). None is built.

- **A kept commit is settled only by a connection.** It is resubmitted when the socket opens again. If the socket stayed open through a lost HTTP answer, nothing settles it until the next reconnect, yet the `outcome-unknown` toast promises "once it is back". The candidate is to settle on the next commit or send in that group.
- **A 1:1 creation and a group's own-device Add carry no invitation.** If such a commit is kept and then lost, it is cleared silently. This reading comes from the code and was not measured:
  - The own devices are covered. The creator's user row is written BEFORE the commit (`registerMember` in `createNewGroup` and `startNewConversation`), so each own device recovers through its own `welcome_request`.
  - The 1:1 contact is NOT covered. It is registered only AFTER the merge (`performDirectAdd`), so no server row re-derives a lost Add, and the conversation is left with its creator alone.
- **The add-lock marker store keeps one marker per group, and a put-back overwrites** (`markAddLock` in `addLockMarkers.ts`; round-4 review of #2426). If an owed release goes unanswered, its put-back of `t1` can land after a concurrent acquire has marked `t2`. Then `t2`'s marker is lost, and if `t2`'s release is also lost, that lock waits out its 30 s TTL. The cost is a bounded delay with no safety impact. The candidate fix is one marker per token.
- **The markers live in the per-account store the tabs share, and on the heartbeat fallback two tabs can lead at once** (the same review). The leader-tab gate keeps a follower from acquiring. But where Web Locks are missing (WebKitGTK), the heartbeat election can briefly have two leaders. One tab's `claimAddLockMarker` could then send a release, naming the other tab's token, that frees that tab's LIVE lock mid-Add. This is the H1 class. It was read from the code and never observed. The candidate fix is to key each marker by page as well as by group.
- **The authorization audit of the group routes** found a pre-existing remainder on the add-lock door; it is tracked privately.
- **A re-plan that dies between its merge and its Welcomes sends no Welcome.** Its entry stays, and the next re-plan finds every device `already-in-tree`, so it concludes and sends none. The invitee then depends on their own `welcome_request`. The owed-Welcome record (`owed_welcome.rs`) covers only a settled merge, not this path.

## P3 - A removed device replays the commits it missed and is answered 403, read as a replay error (CC-2, 1.4.1 dev campaign, 2026-10-25)

The Remove commit the server queues to a removed device (`group:parting`) is built on the group's
CURRENT epoch, which is past the device's own whenever any commit landed between the server record
and the Remove - a lost commit race always does, and the rebuild of that race (2026-10-25,
[history-reconciliation](protocols/history-reconciliation.md)) keeps it so. The device sees an epoch gap, runs rung 1 (`attemptCommitReplay` ->
`fetchCommitsSince`), and is answered `403` on `GET commits?sinceEpoch` - it is off the roster - with
`user-members` and `group-info` refused alike. `setupMessageHandler.ts` logs `[GAP] replay error ...
403` and keeps the gap clock running toward rung 2. **The 403 is an answer ("you are out"), not a
failure.** Owed: type it at the throw (`fetchCommitsSince`) and carry it to the `epoch-gap` arm, which
then hands it to `retireIfEvicted` rather than to rung 2. Gated on proof because retiring is
destructive: the roster 403 is not the device's own membership (`ExclusionsRefusedError` records that
trap), so the decision must read the server's own eviction evidence, not the status alone. Not built.

## P3 - The boot restore opens the frame pipeline before any conversation row exists: a queued frame for a stored conversation is refused (`absent-conversation`), not ACKed, and re-pulled (found by the 1.4.1 dev campaign, DECIDED TO DEFER)

**Deferred past 1.4.1 on purpose.** The fix reorders Welcome and commit handling relative to the
restore; a hang there would stop a device receiving anything, so it needs its own plan, review and
campaign. Nothing below is built.

**What happens (read from the code, certain).** The login starts the handshake alongside the MLS
load (the 2026-09-16 optimisation, not the cause). `markInboundReady` opens the gate and replays held
frames; `openGatewayConnection` then awaits the first pull (`fetchPendingMessages` + `settleMailbox`),
so the whole first pull is decrypted BEFORE `loadAndRestoreConversations` starts.
`loadExistingConversations` has awaits (migrate, `getConversations`, duplicate merge) before phase 1
seeds the rows and calls `notifyConversationRowsSeeded`. Any payload frame for a stored conversation
handled in between reaches `handleKnownGroup`, finds no row, logs `Message for absent conversation`
and returns `false` (no ACK); `refetchFramesLeftBehind` re-pulls the mailbox after
`notifyConversationRowsSeeded`.

**Cost.** One extra pull, a second handling of each such frame, the gap healer holding later frames
of that group as `behind-refused-backlog` until the re-pull lands, and a log line. Measured
elsewhere: [startup-load-audit-2026-10-12](frontend/startup-load-audit-2026-10-12.md) (83 refused,
80 duplicate replays) and finding F12 of
[notification-to-conversation-latency](frontend/notification-to-conversation-latency.md), which
shortened the window and did not remove it.

**Why the obvious fixes do not work.**

- *Hold frames at the inbound gate*: pulled rows go through `enqueuePendingRows` ->
  `enqueueMessage` -> the scheduler, never `deliverFrame`. Holding the scheduler deadlocks, because
  `openGatewayConnection` waits for the scheduler to settle while the restore that would release it
  starts after.
- *Move the whole restore before the gateway*: ruled out by the 2026-09-15 rationale - the socket
  must be up before phase 2's archive replay, or every mailbox wait re-pulls the mailbox.

**Proposed change (for review).** Give `loadExistingConversations` (via `loadAndRestoreConversations` /
`restoreOnce` in `useConversations.svelte.ts`) two optional arguments: a `historyAfter` promise
awaited between phase 1 and phase 2, and an `onRowsSeeded` callback. New login order:
`beginConversationSource`, await `landingPreview`, adopt mirror entries, start the restore, await
rows seeded, `markInboundReady`, `openGatewayConnection`, resolve `historyAfter`, await the restore.
Keep the `notifyConversationRowsSeeded` re-fetch (the mid-session restore needs it).

**Risks to review first.**

- (a) A boot hang: if the restore throws before phase 1, or `stopIfSignedOut` fires between steps,
  "rows seeded" must still settle on EVERY exit path.
- (b) Welcomes and commits would be processed after phase 1, including
  `mergeDirectConversationDuplicates`, which can call `deleteGroupOnServer` before held frames are
  handled (today it runs after them).
- (c) The pre-restore merge loses its boot use but stays for the mid-session Welcome restore.
- (d) `startupOrder.test.ts` pins the current order and must change.

**Tests owed if built.** A frame held at the gate, or returned by the first pull, for a stored
conversation is handled with its row present; `takeGroupsAwaiting('absent-conversation')` is empty
and no second pull happens; a restore that throws before phase 1 still opens the gate;
`startupOrder.test.ts` updated; a frame decrypted between the gate and phase 2 survives phase 2's
stored-page write.

## P3 - Three Welcome paths still end in a conversation row or skip a key-group step (2026-10-25)

What wrote and then probed a key group's conversation row is fixed
([channel-encryption](protocols/channel-encryption.md#a-key-groups-welcome-wrote-a-conversation-row-and-discovery-asked-its-roster---fixed-2026-10-25)).
Three paths are left, none built:

- **A key-group Welcome whose row is unreadable AND whose group this session does not name.**
  `handleWelcome` (`setupMessageHandler.ts`) classifies from `getGroupMeta` when it answers, and from
  `isDistributionGroup` when it does not (`null` = network failure or any non-2xx). With neither -
  typically a first Welcome before any community load - it takes the CONVERSATION path:
  `processWelcome`, a placeholder row, `upsertConversation`, and the drain announces it. Discovery
  purges that row at the next boot, but until then a seed carrier sits in the sidebar store. A
  policy choice, not a reorder: a Welcome is always acknowledged (its KeyPackage is consumed), so
  "could not read the kind" needs a decision - hold the Welcome unacknowledged until the row is
  readable, or install it without a row and classify it afterwards. Unmeasured: how often the meta
  read fails on a Welcome.
- **A Welcome owed while `ensureDistributionGroupFor` (`utils/graine/distributionGroup.ts`)
  answered `false`** leaves `askForHistory` /
  `reconcileRoster` unrun once that Welcome installs: `handleDistributionWelcome` installs and
  promotes, and nothing re-runs the steps the ensure skipped. Found by reading (review of #2408);
  the steps' owner should be the install, not the ensure.
- **A Welcome for a group deleted server-side, or one refused `CannotDecryptOwnMessage`, is still
  announced.** `handleWelcome` returns `true` (ACK) on both, and `processQueue` fires
  `onWelcomeProcessed` on any non-throwing Welcome, whose listener writes an `active` row for a group
  that has none. The drain needs the handler's verdict ("installed a conversation"), not "did not
  throw". Found by reading (review of #2408).

## P3 - A guard answers 5xx for its own faults, and an authorization refusal is a 403 (review of #2420, 2026-10-25)

Server side, separate from the client's 401 rule ([sessions](sessions.md#a-401-renews-the-token-and-sends-the-same-request-once---one-rule-every-caller)).
- **The delivery services' `HeaderAuthGuard` answers 401 for faults of its OWN** - the internal shared
  secret unset, an internal signature refused. Those say nothing about the user's bearer, yet a client
  can only read a 401 as one, so the delivery API had to stop treating a 401 on a renewed token as a
  dead session. They should be 5xx: a server fault, which every client already reads as "retry later".
- **Social-service answers 401 for AUTHORIZATION refusals inside handlers** (its posts service and
  controller). A 401 says "who are you"; "you may not" is a 403. Until it changes, a client's resend
  after a renewal there is wasted, and the premise "a 401 is the guard's answer about the bearer" holds
  on `/api/mls` only.

## P3 - Two edges of the pending pull, left by the review of #2420 (2026-10-25)

- **Any non-2xx page reads as a drained mailbox.** `pullPendingMessagesJson` stops on `!page.ok` and
  returns what it has, so a 5xx or a 403 ends the pull as if the queue were empty, and nothing says it
  did not drain. Predates #2420.
- **The resend after a 401 is not halved on a stall.** The pull applies the 401 rule outside its
  page-halving ladder (so a slow renewal never halves a page); the resend it then makes has its own
  stall timer, but a stall there is thrown rather than asked again smaller. Rare (a 401 followed by an
  oversized page); the next pull asks again ([sessions](sessions.md#a-401-renews-the-token-and-sends-the-same-request-once---one-rule-every-caller)).

## P3 - Two edges left by the gateway-socket rotation fix (review of #2407, 2026-10-25)

- **A follower tab that rotates the device id while the leader's socket carries it.** Tabs of one
  browser share the id; a follower's rotation moves the stored id under a leader whose socket still
  carries the old one, and nothing tells the leader. Predates #2407, which reopens only its own
  document's socket ([auth](frontend/modules/auth.md#the-device-id-is-not-final-when-the-handshake-starts-fixed-2026-10-25)).
- **A poll deadline in the hour summer time repeats is ambiguous.** A `datetime-local` value in that
  hour names its FIRST occurrence, so a deadline set "in an hour" during it reads as now and is
  refused. A product edge, untested now; the test that met it pins its clock (`pollDraft.test.ts`).

## P3 - What a republication still does not move in the feeds (review of #2384, 2026-10-24)

- **The promo cutoff reads `publishedAt`**, so a post published before the reader's promo opens
  and republished since stays out of every feed for that reader. Deliberately left: whether a
  repost should reopen an old post is a decision, not a fix.
- **The placement is a correlated `MAX` per row** (`republished-feed-sql.ts`): fine at today's
  republication count; if that table grows, a `LEFT JOIN` on a per-post `MAX` grouped once replaces
  it. Measure with `EXPLAIN ANALYZE` on the Associations feed first.
- **The "new" marker** (`isNew`, `routes/posts/+page.svelte`) compares `publishedAt`, so an old post
  just republished is placed at the top without the marker.
- **[posts](frontend/modules/posts.md) says the feed order has no unique tie-breaker**; every arm has
  ordered by `posts.id` last since then - the note is stale and should go.

## P2 - A device's one-time KeyPackage pool is topped up only when it connects (measured 2026-10-25, after the stable)

The server serves a joiner's one-time KeyPackage from a per-device pool and falls back to the
static last-resort row when the pool is empty (`[KP] one-time pool EMPTY ... serving the static
last-resort row`). The client refills the pool in one place: on each socket connection, as tab
leader, it asks for its count and mints up to 50 (`generateKeyPackage`, web and native alike).
Nothing tops it up during a live connection, and nothing tops up a device that never connects.

Measured read-only on dev during the `1.4.1-alpha.4` replay. Every group an account creates admits
all of that account's devices, so each one spends a package per group.
- The seats the rig reloads before each row held 25 to 41.
- A phone that stayed connected for about 2 h 30 after its last top-up held 0. Its log shows one
  publication, then only token refreshes and no reconnection.
- Two idle browser profiles held 0.
The server fell back to the static row for all three. So replenishment works, and it is outpaced by
design: the fallback becomes the routine path for any device that stays connected through more than
50 joins, or that is not connected.

A fallback is a signal, not a path. What is owed:
- top up while connected, either on a low count or on a signal from the server that a package was
  consumed;
- decide what an idle device's empty pool should mean;
- keep the empty-pool WARN as the accusing line it is.
Not before the stable.

## P2 - The nightly archive is mostly one group's undelivered queue (measured 2026-10-24)

The archive went from 80 MB (10-11) to 716 MB (10-13) and holds ~650 MB since. The cause is
`queued_message`: 189 205 rows of community key group `1b1687d0`, written 10-12 and 10-13 by the
broadcast seed answers #1768 has since stopped, and **172 060 of them (728 MB) are owed to 109
devices with neither a session nor a push token**. They belong in the archive while they are owed,
so nothing was excluded. **Decision owed to the user:** whether to delete the rows of devices that
can no longer fetch them (a production deletion, the same predicate family as the
[queue audit](infrastructure/prod-queue-and-epoch-audit-2026-10-12.md)'s reaper), or let them leave
at the 90-day bound around 2027-01-10. Numbers and SQL shape:
[backup](infrastructure/backup.md#why-the-archive-went-from-80-mb-to-700-mb-2026-10-13).

## Decided by the user on 2026-10-22 - the local key on a phone is held by secure hardware

On the phone apps the local at-rest key is held by the device's secure hardware, the PIN only
unlocks it (and stays short), and backups get their own recovery secret. Web and desktop keep the
PIN-derived key. BUILT in a draft pull request (`feat/hardware-held-local-key`); the mechanism is
[auth](frontend/modules/auth.md#the-at-rest-key-on-a-phone-is-held-by-the-hardware-2026-10-22).
Owed before it ships:

- **Device readings, Mi 9T and iPhone**: the list is in
  [auth](frontend/modules/auth.md#backups-get-their-own-recovery-secret) ("Owed on hardware"),
  including the iOS build no gate here compiles.
- **Decided (user, 2026-10-22): notifications stay complete on a locked phone, and the PIN is
  verified by the server; the hardware key protects the device's stored data. Practicality first.**
  The four lead decisions are BUILT and recorded with their costs in
  [auth](frontend/modules/auth.md#decisions-taken-on-2026-10-22-and-what-each-costs).
- **`minClientVersion` follows the first release carrying the hardware-held key** once both stores
  serve it.
- **Two keys stay on purpose**: #2271's push-cache key is not derived from the at-rest key, because it
  must exist before the first push and stay stable, while the at-rest key rotates (migration, recovery,
  reset). Revisit only if #2271 lands with a design that tolerates a rotation.

## A new person is admitted only by a member (decided by the user on 2026-10-23): step one built

Built: no automatic Add brings in a user absent from the adder's tree, web, native and the Android
background answer alike; a member is asked "X asks to join this group. Only a member can add them." (Add / Decline), which replaces the
group link's automatic admission (the server holds a link joiner outside, `awaitingAdmission`, until a
member's Add); and an entry no member made is written in the conversation and reported
(`[UNINVITED_ENTRY]`, with its `kind`) - see
[mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23). Owed: migration 038
deployed with the build; the `minClientVersion` floor at this build, since a member client older
than the rule still auto-Adds a link joiner and "only by a member" holds only from that floor
([legacy-compatibility](legacy-compatibility.md)); the `[UNINVITED_ENTRY] kind=new-person` count on
production once the build serves both stores; and a second step on the receiving side (private
operations notes).

## An unseen device of a member is asked about before it is added (2026-10-27): interim built

Built: an automatic Add no longer brings in a device of a member unless its own leaf is in that
group's tree or a member approved it, one device at a time, under the key it showed; a pin never
counts. A further device of a member asks a member rather than joining itself, decided on the tree
of the GroupInfo its commit would be built on (a device whose own leaf is there, and a user's first
device in a group, keep their own door); one that does join itself is reported and written in the
conversation, decided per group, with "Not me" on the owner's alert, and is answered no history
until a member vouches for it; and a waiting device shows its owner its own key
([mls-protocol](protocols/mls-protocol.md#an-unseen-device-of-a-member-2026-10-27-interim)). The user
confirmed the mandatory tap on 2026-10-27, keeping the link join for new persons. Owed:

- the production rate of device enrolments per week (and how many are a second device of an
  account), which is the number of taps it costs - and how often a device enrols while none of its
  conversations has a member online, which now waits instead of joining itself;
- **the hourly stranded report cannot tell a device waiting for a member's tap from a stranded
  one**: both are a `pending` seat with no Welcome, no add in flight and no admission. The device
  knows which it is (its join answers `further_device`); the report needs that fact on the seat - e.g. the
  `welcome_request` the waiting device sends, recorded per seat - before its count can be read as
  defects again;
- a hardware reading of the owner's own new phone approved from the old one, the two keys compared;
- **who can still be flagged honestly**: a device on a client older than this change still joins
  by itself beside its user's other devices, and is flagged wherever it was never in the group - the
  rollout's cost, until `minClientVersion` carries the tree-based door. A current client cannot be:
  its door is the observer's predicate without the departure half. The departure record's cap
  (`MAX_RECORDED_DEPARTURES`, 8192 per device, oldest evicted) and an observer that joined after a
  device left only widen what reads as `firstInGroup`, so they matter for those older clients alone;
- **an honest device flagged during the rollout** (an older client joining by itself) that then adds
  a new person makes that person's device withheld too, by this member, until another member's Add
  or an approval lifts it;
- the native background engine keeps no record of withheld devices, so it never marks a device added
  by one (`added_by_unvouched` is set by the app alone); history is answered only by the app, so
  this costs a notice, not a message;
- **the same class, not gated**: the member-initiated paths that add a user's devices with no tree
  to check them against (details in the private operations notes) close with the real fix;
- the Android background welcome now stages nothing (only a device already in the tree passes its
  rule, and the Add refuses that one): its staging is kept for the real fix, or deleted with its
  native callers if the real fix is not built;
- **a seal is for good, and an honest user can reach one**: a conversation is sealed (no history
  answered there by this member) when the native queue of device events overflowed for it. The
  queue holds 512 events and is emptied only by the app, so a phone whose background engine merges
  for a long time while the app stays closed, in busy communities, can pass it. No path unseals.
  Owed: the seals counted (each is an ERROR line naming its cause; a report of their rate per week);
  and, as a design option NOT built, a lift once every leaf added at or after the overflow's epoch
  has left the tree or been vouched for. **An ordinary sign-out or account switch can seal too**:
  device events taken from an account's state while it is being unbound seal their conversations in
  that account's record, for good, by the same rule - the option above would lift those as well;
- **two tabs of one account merge their records and err towards withholding**: a tab that loaded
  before another tab lifted a device can write that device back, and after a restart it is withheld
  again until a member's approval lifts it once more - a cost in availability only, never an answer
  to a device that should not have one;
- **the departed bound costs detection**: past it, a conversation is sealed and the records of its
  departed withheld devices dropped, so one of them that later comes back by itself is no longer
  known as withheld there - what it then adds gets no line. History stays closed (the seal); only
  the notice is lost;
- the real fix, a device vouched for by a user signing key (shape B, recommended on that page),
  after which this ask remains only as a shim for users without one.

## P2 - A removed member whose leaf survived is re-added automatically by a link (review of #2358)

A removal deletes the roster row before the member's Remove commit lands. If that commit never
lands, the removed person keeps a leaf, and when they later follow an invitation link
`automaticAdmission` reads their user in the tree as `member-device`: a member's device Adds them
with no one asked, and the commit's `admits` lifts their `awaitingAdmission`. "Holds a leaf" is not
"is a member". Not built: the fix needs a fact the client can read that says the leaf is owed a
Remove (the server's exclusion intervals, or `removeStrayLeaves` run before the sweep decides) -
[mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).
**Closed by ADM-3 (2026-10-25), to delete once it ships:** the member-add route no longer enrols
anyone, and an Add that carries no invitation generation never admits an awaiting seat of a person
who ever departed (`departed_and_undated`, the whole commit refused) - only a member's invitation,
which says when it was decided, does; a leaf without a seat is the stray collector's ([mls-protocol](protocols/mls-protocol.md#the-commit-is-the-one-writer-of-a-new-person-adm-3-2026-10-25)).

## P2 - Three delivery routes check no membership at all (re-review of #2358, already on main)

`POST mls/history-request`, `POST mls/base-refresh-request` and `POST mls/notify-reaction` relay to
a group's members without asking whether the caller holds a seat in it, admitted or not: anyone
authenticated can make the members' devices answer, or notify them, in a group they are not in. The
waiting seat of #2358 is only one such caller. Owed: the same caller predicate as the other routes
(`callerSeatStanding`, `utils/group-membership.ts`), an integration case per route, and a look at
what an older client sends there before it is refused -
[mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).

## P3 - Calls: the waiting-seat exclusion is built and has never run against a live call (re-review of #2358)

Every call route refuses a seat awaiting a member's admission (409) and the ring's callees are
admitted seats only (`ADMITTED_SEAT`), proven against PostgreSQL by `admission.integration.spec.ts`.
`calls_mode` is `off` on production, so no ring has gone through it. Owed: one ring on dev with a
pending link joiner in the conversation, read in the `[ring]` lines (`not rung: ... hold no
admitted seat`) - [calls](frontend/modules/calls.md).

## P3 - A joiner's device with no device row is never marked awaiting admission (review of #2442)

The groups list marks a never-admitted conversation per DEVICE seat (`deviceMembership.awaitingAdmission`).
A joiner's second device that holds no device row in the group when it reads the list is never marked,
so its row reads as an ordinary `pending` conversation rather than "waiting for a member". Owed: decide
whether the flag is the user seat's (any device of an awaiting user) and test the second-device case -
[mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).

## P3 - A restored backup keeps a conversation's `awaitingAdmission: true` (review of #2442)

`Conversation.awaitingAdmission` is stored on the row (IndexedDB / SQLite v15), so a backup taken while
an ask was open restores the flag after the person was admitted. Owed: confirm that the first groups
list after a restore clears it (`syncAdmissionFlags`), with a test, or clear it on restore -
[mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).

## P3 - The Android background answer refuses a newcomer and tells nobody (review of #2358)

`prepare_welcome_background_with_key` refuses a `welcome_request` from a user absent from the tree
(`newcomer`) and raises no local notification, so a member whose phone is shut learns of the ask
only when the app is next opened and the foreground sweep raises it - in the conversation, where the
ask is a card (`JoinRequestRow`, 2026-10-24), and in the global banner. DECIDED 2026-10-24: no push
for it, the ask lives in the thread. A phone shut tells its member nothing until opened; a
notification would be a visible push per platform and is not planned - [mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23).

## New-device notices (decided by the user on 2026-10-22): built, owed readings and two decisions

Built: the owner's in-app alert, the contact line in every DM and group shared with the contact
(never in communities, wherever the device was first seen), the owner's notice of a refused device
of their own with its remedy, and the native local notification on both background engines, one
ledger between them - see
[mls-protocol](protocols/mls-protocol.md#new-device-notices-decided-by-the-user-2026-10-22-refined-the-same-day).
Only CI compiles the Kotlin, the Swift and the Android/iOS Rust targets.

Owed readings (Mi 9T and iPhone 12): add a web device to the account with both phones shut - a local
notification on each (the iPhone at its next message push), then the in-app alert on opening, and
no second notification; a line "X added a device" in a DM with a contact who adds a device; NO line
in a community or salon. Owed decisions: whether a phone whose WebView is alive in the background
should also raise the local notification (today the in-app alert only), and whether a device first
seen in a tree this device joined should be announced; and whether 7 days is the right bound for
a contact's line (a device first seen by the server earlier is a heal, not a new device - see the
evidence table in mls-protocol).

## P1 - A new member of a group conversation receives its whole past; decided 2026-10-21 that they must not

The adding device pushes its whole local store to the invitee (`sendFullHistoryBundle`, up to 5
years), which no decision ever chose. 6 of 15 live group conversations had admitted 24 later members by
2026-10-21. Decided by the user: a newcomer reads nothing from before their arrival (WhatsApp, Signal),
and the remove-then-re-add rule of 2026-10-14 stays. Step C (the push withholds the invitee's span,
the receiver drops its own) is on `main`. **Step A is BUILT (draft PR): every history answer, the
push included, is addressed to the asking device and filtered on its own windows; migration `035`
is applied by the deploy, so the user's yes is the release.** Owed, in order: the rig row GRP-ADDR-1; a `minClientVersion` carrying A
once both stores serve it; option B, sealing the answer to the asker (X25519 in `mls-core`, an
ephemeral key carried inside the MLS-signed request). **DECIDED by
the user, 2026-10-22:** a reply quoting a pre-arrival message SHOWS a newcomer the quoted text;
nothing is built for it. Design and limits:
[history-answer-addressing](protocols/history-answer-addressing.md#decided-a-quote-of-an-earlier-message),
[history-reconciliation](protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21).

## P2 - Signed authorship of restored history: built (#2276), owed rig rows and a version floor (2026-10-22)

Restored history carries each message's author signature, and frames carry a signed epoch fingerprint ([history-reconciliation](protocols/history-reconciliation.md#restored-history-carries-its-authors-signature-2026-10-22), [mls-protocol](protocols/mls-protocol.md#fork-detection-a-signed-epoch-fingerprint-in-every-application-frame-2026-10-22)). Owed:

- **Rig rows:** a history restore between two clients on a live local estate (a signed message verified, an older one marked "non verifie"), and a forced fork that must produce one `[INTEGRITY] fork` line on each side.
- **A `minClientVersion` floor:** unsigned messages are only MARKED today, because every older client sends them. Refusing them outright waits until the floor is a signing build on both stores, plus the retention window of the oldest unsigned message.
- **P3 - a history bundle has no byte cap per chunk, only a message count**, and each message now carries its body and proof beside its content (about 2.5x per message). A cap in bytes is owed before bundles of long messages are common.

## P1 - A community's past goes only to a proven admission: BUILT (draft PR), owed its readings and a client floor (2026-10-22)

Decided by the user: communities stay `shared` by default, the past goes only to an admission a
member can verify, and a new user's arrival rotates (D5, #2263). Migration `107` is approved by the
user. Merged (#2273); #2264 is rebuilt on it, one chokepoint calling the gate. Owed, in order: the
rig rows COMM-26..31; and a
`minClientVersion` floor at the version carrying it, since an older answering client still hands
the past to whoever the roster names. **The cut date is DECIDED** (user, 2026-10-23):
`ADMISSION_PROOF_SINCE` is the day the production stable carrying the proof ships, planned for
2026-10-27 UTC. **Old invite links are ACCEPTED as they are** (user, 2026-10-23): a newcomer through
an old link reads from arrival until a member re-admits them.

**Release checklist for that stable: before cutting its final pre-release, check that
`ADMISSION_PROOF_SINCE` (`frontend/src/lib/utils/graine/admissionGate.ts`) equals that stable's
day.** Design:
[channel-encryption section 25](protocols/channel-encryption.md#25-a-member-hands-the-past-only-to-an-admission-it-can-verify-decided-by-the-user-2026-10-22).

## P2 - Local retention is 90 days everywhere while 5 years was intended on native - decision owed (found 2026-10-22)

`ChatBackgroundService.svelte:1789-1802` runs `deleteOldMessages(90 * 24 h)` every 6 hours with no
platform check (`db/indexeddb.ts:924`, `db/sqlite.ts:773`), while `historyWindow.ts`
(`NATIVE_DEVICE_WINDOW_MS`, 5 years) and
[history-reconciliation](protocols/history-reconciliation.md#two-boundaries-not-one) promise 5 years
on a phone or desktop. No decision that 90 days is intended was found. Whether native keeps 5 years
(gate the GC on `deviceWindowMs()`) or the claim is lowered is a product decision; nothing was
changed. Until it is taken, a native device claims coverage it deleted.

## P2 - addGroupMember can enrol an erased account after the final erasure pass (review of #2258, 2026-10-24)

`MembersController.addGroupMember` (`POST mls/groups/:groupId/members`: a group invite, and the
opening of a 1:1 DM) is the one admitting writer the seat lock never converted. It reads the
target's key packages outside any transaction or lock, then writes the roster row, its membership
interval and `pending` device rows with no seat lock and no `heldKeyPackages`. Nothing refuses an id
whose account was erased, so any member holding a valid token can POST an erased uuid and recreate a
roster row naming that person, even after chat-delivery's final erasure pass (no key package is
left, so no device row; the roster row and interval are enough to name them). Pre-existing, not a
regression of #2258, which only names it as the second known exception to "every writer that admits
a device reads its key package under the lock" ([channel-encryption](protocols/channel-encryption.md),
[account-erasure](account-erasure.md)). Fix direction (from the review): route it through
`writePendingSeats(enrol=true)`, which already takes the seat lock, re-reads the group and reads
`heldKeyPackages`; and refuse the target itself, either by a roster-level tombstone that the erasure
writes and that names no one once its own window ends, or by asking core whether the account exists.
**Narrowed by ADM-3 (2026-10-25) to the creation bootstrap:** the route now enrols nobody but a
caller registering ITSELF into an empty roster; for anyone else it re-reads the seat under the seat
lock through `writePendingSeats` (which reads `heldKeyPackages`) and refuses a person no commit
admitted (`409 MEMBER_NOT_ADMITTED`). What is left: the bootstrap transaction still takes no seat
lock and reads no key package under it - an erased account would need its own still-valid token and
an empty group to use it ([mls-protocol](protocols/mls-protocol.md#the-commit-is-the-one-writer-of-a-new-person-adm-3-2026-10-25)).

## P2 - `setNotificationLevel` saves a whole member copy and can undo a demotion (review of #2284, 2026-10-24)

`setNotificationLevel` reads a membership row, changes `notifLevels` and `save`s the whole copy;
TypeORM writes back every column the copy differs on, so a role change committed between its read
and its save is reverted (`roleIds` written back) - a demoted admin restored by changing a salon's
notification level. The fix is an `update` of `notifLevels` alone, the rule `social-service.md` now
states for salon rows. `promoteSuccessor` and `setRole` also save whole member copies, but the
column they mean to write is `roleIds` itself, so they only race each other.
([social-service](services/social-service.md#removals-are-bounded-by-the-actor-and-so-is-hiding-a-salon-2026-10-24))

## P3 - Edges of the community removal lock, left by the review of #2284 (2026-10-24)

- **A salon reorder can deadlock with a departure or a community deletion.** A departure now locks
  the community's private salons in one order (`ORDER BY id`) before the membership rows, and a grant
  and `hardDeleteWorkspace` take salon rows before membership rows (the grant-vs-deletion cycle
  #2284's review found is closed; since 2026-10-26 `hardDeleteWorkspace` also opens with the
  removal lock, so it is serialised with every departure). Left: the reorder transaction writes
  several salon rows in the order the client sent, so it can cross a departure on two salons.
  PostgreSQL aborts one side (`40P01`); an aborted departure settles `cancelled` and is retried
  inline, a reorder is answered 5xx. The fix is the same `ORDER BY id` lock (a `SELECT ... FOR
  UPDATE`) before the bulk write.
- **A group retirement runs after the commit, outside any lock.** A makes a salon public, B makes it
  private again (the idempotent mint returns the same group G), then A's retirement deletes G on
  chat-delivery and nulls `distributionGroupId`: a private salon with no group. The fix is a
  conditional retirement - `UPDATE ... WHERE "distributionGroupId" = G AND NOT "isPrivate"`, and the
  delete only when that row changed.
- **Case.** The removal bound's member map takes the LAST of two membership rows differing only by
  case; it should merge their roles. Allowlist entries written before the actor id was lowercased may
  be mixed case, which `stripFromChannels`' exact compare misses: one `GROUP BY` over production's
  `allowedUsers` for an uppercase letter settles whether any exist. A comma inside a user id would
  corrupt the comma-separated `allowedUsers` column (theoretical).
- **An invitation that reads a salon public and loses the race to a private flip** announces it
  `public` and grants nothing (pre-existing): the flip's allowlist does not name the invitee.

([social-service](services/social-service.md#removals-are-bounded-by-the-actor-and-so-is-hiding-a-salon-2026-10-24))

## P3 - A 1:1 DM created between the erasure's discovery and its roster delete is not tombstoned (review of #2258, 2026-10-24)

`deleteUserData` tombstones the DMs its discovery found. A DM opened with the account after that
read (by the account while a token is valid, or by a peer through `addGroupMember`) loses the
account's roster row to the roster delete and its device rows to the sweep's cut, but its
`dm_groups` row and the other party's side stay: a 1:1 conversation with one member left. The final
pass does not find it either, since nothing of the account names it any more. Small and rare (a DM
opened inside the erasure window); fix with the P2 above, or by having the sweep tombstone any DM
whose roster the account was on.

## Decided by the user 2026-10-22: the undated margin stays symmetric, so a joiner may lose undated messages from their first hour (review of #2251)

`withholdReason` places a copy with no `serverTimestamp` against every window widened by
`UNDATED_SKEW_MARGIN_MS` (one hour) on BOTH sides. A joiner's before-arrival span `[0, arrival)` thus
also withholds their undated history from the hour AFTER they arrived. A device that already holds a
message is never filtered, so the loss is that member's NEXT device restoring history, unless a member
holding the message dated serves it. Widening only the pre-arrival side would leak a message
received before the arrival whose sender's clock ran ahead and stamped it after the edge. That is
exactly the case the margin exists for. **Decided by the user 2026-10-22: symmetric.** The
post-arrival side is not narrowed. The user's reason: a message received before arrival must not
leak from a fast clock, and the cost is accepted, a few undated messages just after arrival possibly
dropped. Nothing is owed. Do not reopen without a new measurement of that cost.
**The undated count cannot be read on the server.**
Undated copies live in client stores, and bundles reach the server as ciphertext. The only reading
is the client's own `[HISTORY_ENTITLEMENT] ... N undated within 60 min` line, on a device that
receives a filtered push. The creator's case of the same margin is fixed (#2251).

## P3 - A leave's own `memberLeft` notice is refused with 403, so the others never see it (GRP-6, 2026-10-22)

`leaveGroupAndBroadcast` sends `memberLeft` "before the server deletion". But `sendMessage` returns
once the outbox has written the entry durably, not once it is delivered. `removeMemberFromServer`
then ends the membership, and the outbox's POST loses the race: `[OUTBOX] ... REFUSED with 403 ...
parked, no retry until the next sign-in`. Observed in GRP-6 on the local estate: written at +0 ms,
the leave dropped local state at +26 ms, refused at +54 ms. So the entry is the leave notice itself,
and withdrawing the group's queued entries on a leave would only silence the line. The fix is
ordering: step 2 must wait for the notice's DELIVERY, not its durable write. A parked entry for a
group the device has left should also be withdrawn rather than wait for a sign-in.

## P3 - Three edges of the exit drain, left by the review of #2259 (2026-10-24)

Mechanism: [chat](frontend/modules/chat.md#an-exit-takes-the-groups-queue-with-it-before-its-server-step-grp-6-2026-10-22).
(1) An exit the server keeps REFUSING stays owed for ever, by design. Every later enqueue for that
group is then refused, a re-add included, and the enqueue RESOLVES. A text or a file now says so at
`warn`; nothing clears the owed exit on a re-add. (2) A FOLLOWER tab's exit cannot send, so it
withdraws the group's texts the leader could still have sent. (3) `resuming` marks set by an exit
drain for entries it then withdrew are never deleted. They are one id each per page life. The owed-exit
check also costs one `getPendingGroupExits` read per enqueue and per lane pass on the hot path.

## P2 - Graine rotates on every key-group epoch, so a growing community mints a seed per message (measured 2026-10-21)

Every device joining a community's key group commits, and the outbound rotation rotated on any
epoch change. Production: 845 sessions for 1 698 messages, and 458 seeds in the largest community's
first 8 days. The history bundle carries every seed, about 330 bytes each in v2, so its 8 000-seed cap
is about 2.6 MB in one MLS message. Owed, in order:
(1) rotate on a REMOVAL or a NEW USER only - BUILT 2026-10-22, draft pull request: a clean run per
key group kept in the MLS state by `mls-core` and judged by `graineOutboundVerdict`
([graine-removal-tracker](protocols/graine-removal-tracker.md)). Owed after merge: the rig rows and the
production ratio named on that page, and one read-only pass proving every stored external commit's
path leaf names its committer (the server now refuses one that does not). A new USER still rotates
(D5, decided 2026-10-22); a new device of a present user continues, by an Add or an external
commit alike; (2) the bundle bounded in bytes and paged is BUILT (draft PR, 2026-10-22), owed one rig run of a
paged history answer ([channel-encryption §4.4](protocols/channel-encryption.md#44-joining-and-what-a-share-link-is-worth));
(3) a key-group frame stored once per group, not once per seat (31 copies per
payload, 883 MB of the 1.5 GB queue): BUILT 2026-10-22, draft PR, for the next stable (user). It
ships the READERS with migration 034 and the writer OFF (`QUEUED_PAYLOAD_SHARED_WRITES=false`).
Owed: the user's yes to apply migration 034; then, once that stable is in production, a pull
request turning the writer on in the release after it; then one re-measure of the queue's bytes
([chat-delivery](services/chat-delivery.md#a-key-group-frame-is-stored-once-migration-034-2026-10-22)).
Reasoning and numbers:
[dm-vs-community-encryption](protocols/dm-vs-community-encryption.md#where-each-system-can-improve).

## P3 - A group conversation of 109 device seats carries its messages over MLS, the shape Graine rejected for salons (2026-10-21)

A QUESTION first: measure that group's unreadable-frame rate against the communities' and decide
whether a group conversation above some size should be backed by Graine
([dm-vs-community-encryption](protocols/dm-vs-community-encryption.md#dms-and-group-conversations)).

## P2 - Community key groups: no periodic leaf refresh and no revoked-device removal yet (2026-10-22, re-decided 2026-10-23)

Conversations refresh their leaves and drop revoked devices
([mls-protocol](protocols/mls-protocol.md#the-periodic-leaf-refresh)). Two halves are deferred for
key groups, and they are NOT the same question:

- **The refresh.** Seeds rotate on departures only since 2026-10-22 (`graineOutboundVerdict`), and
  a refresh is not one, so it would not mint a seed by itself. Its cost is that each refresh moves
  the epoch: every sender's next send REDISTRIBUTES its seed (one frame per sender per refresh), and
  a redistributed session takes the reused caps (50 messages, 24 h FROM ITS MINT), so a session past
  a day rotates. One refresh per active device per week keeps every sender's session under a day
  old in a busy community. Owed before it is turned on: a redistribution that does not tighten the
  caps for a refresh-only epoch move (or caps counted from the redistribution), and the rotation rate
  re-measured with it.
- **The revoked device's leaf - BUILT 2026-10-27, not shipped.** The key-group roster pass now asks
  `POST mls/groups/:groupId/revoked-leaves` which of the leaves it keeps belong to a revoked device
  and removes exactly those by device, staged on the published branch
  ([mls-protocol](protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)).
  Owed: its run on dev, and the row that revokes a device of a community member and reads the key
  group's tree afterwards. **Its first dev run found every request refused 400** (the identity ran
  through the generic 128 bound, which every real identity exceeds) - fixed 2026-10-28, owed that
  run again on the fix
  ([mls-protocol](protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)). It runs on every community load; the revoking device itself does not
  trigger a pass (not built). **Its scope is limited by the
  binding** (a key group's device rows); widening it is a schema change, approved 2026-10-27 and
  BUILT as its own draft pull request (`dm_revoked_device_groups`, chat-delivery migration 041,
  written by the revocation's purge), reaching production only with the user's yes at the stable.

## P2 - A forked holder's republished base can send honest members to rung 2 (review of #2269, 2026-10-24, not built)

The commits no person asks for (the leaf refresh, the revoked-leaf removal) are staged only on the
branch the server publishes (`assertOnPublishedBranch`, `publishedBranch.ts`), and a `diverged`
answer - same epoch number, another group context - is read as a FORK of THIS device: the group is
marked in the epoch-gap registry and handed to rung 2 (forget + re-Welcome). That reading trusts the
base. A base minted by the commit gate is trustworthy (stored in the transaction that accepted the
commit), but the holder republish (`putGroupInfo`, `republishStaleBase`) checks only that the epoch
RISES - not that the GroupInfo is on the branch the commit log holds. Scenario: the published base is
stale (a legacy commit, a failed write), a device that forked at epoch E republishes ITS GroupInfo
for E, and the server takes it because E is above the stale epoch. Every honest member at E then
reads `diverged`, accuses itself, and forgets the group for a re-Welcome - while the forked device,
the one actually off the branch, matches the base and keeps going. Owed, in order: a count of
`[FORK]` lines per group on production after #2269 ships (more than one member per group at the same
epoch accuses the base, not the members); then either the server checks a republished base against
the commit log's row for that epoch (its confirmed transcript hash), or a `diverged` is read as
`unproven` (nothing staged, nothing escalated) unless the base was minted by the gate. Code unchanged
in #2269 by decision of the review.

**WIDENED 2026-10-27:** the departed-member removal of a roster diff now goes through the same check
(#2580), and for a KEY GROUP too - its base read from social-service, where a holder also publishes
it. So `diverged` now reaches community and salon key groups, and a forked holder's republished
key-group base would send that key group's honest members to rung 2 the same way. The count owed
above counts `[FORK]` lines on key groups as well.

## P3 - A commit left unresolved past the commit-log horizon reads as refused (2026-10-22)

A commit whose submission got no answer is settled by resubmitting it, and the gate's duplicate
answer reads the commit-log row at its base epoch
([mls-protocol](protocols/mls-protocol.md#the-periodic-leaf-refresh)). Rows are kept 365 days and the
last 20 000 epochs per group, so a commit left unresolved longer than that (a device offline for a
year, or a group that moved 20 000 epochs) is answered `epoch_mismatch` even if it had landed: the
device clears it and falls to rung 2. Owed only if a measurement ever shows it: a count of
`DUPLICATE` versus refused resubmissions older than a day.

## P3 - Names in the clear: conversation, community and salon names (user, 2026-10-21, not designed)

`dm_groups.name`, `channel_workspaces.name` and `slug`, and `channels.name` are plaintext, and pushes
carry sender and group names in the clear to FCM and APNs ([DSO dossier](compliance/dso-dossier.md)).
The user wants them encrypted "later". Constraints to design against before anything is built: an
invite link's preview shows the community name to a non-member; the `slug` is a unique public
identifier; a push decrypted natively needs the name key on the device before any WebView runs (the
native mirror path, [channel-encryption §4.9](protocols/channel-encryption.md#49-notifications-keep-working-and-the-mirror-gets-a-bound));
server-side admin and moderation screens list communities by name.

## P1 - Live moderation (WP-L8): the server half is BUILT, the client half is BUILT, the decisions of 2026-10-20 are taken and their server work is owed (2026-10-19)

A RELEASE BLOCKER (D3): no stable carries lives before it. **The production gate list, the order of the switch and the viewer-cap steps: [live-production](frontend/modules/live-production.md)** (2026-10-21); the signing secrets of both estates are SET (2026-10-21). **The RUNTIME kill switch the owner asked for on 2026-10-21 is BUILT (draft PR): `platform_config.lives_mode` (`off`/`on`, core migration 015, default `off` on every row), set at `/admin/platform`, ANDed with `LIVE_ENABLED` on every live route and both media segment routes, published by `/api/version` so clients hide the card and the chip** ([lives](services/lives.md#the-two-switches-live_enabled-and-lives_mode)). Owed: dev's row reads `off` after the deploy that applies 015, so a global admin opens it there before the next live reading; then one reading that closing it on dev takes the card away at the next version refresh. Built on the server, draft PR: a live is
reported through `content_reports`, staff cut it (`POST /api/lives/:id/cut`, 410 `endReason: 'cut'`),
the first-live rules acceptance is recorded and required ([lives](services/lives.md#moderation-wp-l8-server-half)).
**Built 2026-10-19, dev builds, draft PR:** the viewer's and the broadcaster's cut screens, the
`live_cut` bell row and the admin queue's live row with its cut button
([live](frontend/modules/live.md#the-moderation-client-wp-l8s-client-half-2026-10-19)).
**Built 2026-10-19, draft PR:** the viewer's report control (a Flag in the top bar, the report dialog, the block offer; reporting one chat line stays impossible by the server's contract). **Owed, code:** the chat-line hiding inside WP-L6, by the contract written there. **DECIDED BY THE USER, 2026-10-20** (substance and contradictions with what exists:
[lives](services/lives.md#decisions-of-2026-10-20-moderation-reactions-the-audience)): strike policy =
warning, then suspension, then withdrawal by staff; a cut is kept **90 days**; **no automatic cut on N
reports**; live reports answered within **24 hours on working days**; **a reported chat message is kept (encrypted,
for staff) until handled** - this REVERSES C2's "no grace period"; floating reactions = heart, laugh,
bravo, fire, the canary chick; the first-live rules reuse the posts' publication rules; **no viewer cap
wanted** (the plan: [live](frontend/modules/live.md#uncapped-audience---the-plan-2026-10-20); **2026-10-21, no VISIBLE ceiling: the design and the owner's decisions O-1..O-7 are on [live-scaling](frontend/modules/live-scaling.md)**).
**WP-L8b, server half BUILT 2026-10-21 (draft PR):** the strike ladder, the 90-day retention, the
reported chat line (checked, signed, kept until handled and 90 days at most, the author's erasure
included), the five reaction kinds and `LIVE_RULES_VERSION` 2 ([lives](services/lives.md#the-strike-ladder-wp-l8b)).
**Owed, code:**
(c) the client set of five kinds and (d) the rules sheet showing the posts' rules, both in #2170;
the client half of the ladder (the three pushes - cut, suspension, withdrawal - and the two new bell
rows are BUILT 2026-10-21, draft PR, owed a reading on both phones once a store build carries the
strings: [lives](services/lives.md#the-three-pushes-a-broadcaster-gets-wp-l8b)) - the two start
refusals and `GET /api/lives/standing` on the pre-live screen, the admin standing, withdraw / lift
buttons and the `live_chat` row with its integrity ([lives](services/lives.md#what-the-client-still-owes-strings-for-paraglide));
(e) BUILT 2026-10-21: the hourly `[LIVE_REPORT_AGE]` alarm, `error` past 24 working hours
([lives](services/lives.md#the-24-h-alarm-on-the-live-report-queue-wp-l8b-item-e)), owed one reading of
the line on dev; (f) the viewer cap lifted, after the plan's measurements. **Owed, the
user:** the filtering statement and the terms' lives paragraph ([store-ugc-answers](store-ugc-answers.md)).

**P3, found by the review of the server half: a seat taken AFTER an end's release outlives the end
by up to its 30 s lease.** A viewer whose key read began before an end (a cut, the broadcaster's end,
a drop, the hour, an erasure - every kind) committed can take a seat after the purge's
`releaseLive` freed them; that seat counts against the host's cap until its lease lapses (its next
poll is a `410` that renews nothing). Harmless to privacy, it is a clock deciding a count: the fix is
for the seat take to be refused by the live's ended state, not left to the lease
([lives](services/lives.md#the-cut)).

## Orphan media rows: source fixed, one reading owed (2026-10-10)

P3. A `mediaId: ''` placeholder with no outbox entry (Mi 9T, alpha.3) is closed at the source and on screen ([media-frame 7](frontend/media-frame.md#7-an-orphan-media-row-and-a-card-with-no-bubble)): `enqueue` and `enqueueOutboxMessage` now REJECT (`OutboxEnqueueError`) with no storage, no controller or a failed durable write, `handleSendChat` withdraws the placeholder before re-staging, and the bubble asks the durable queue (`isOutboxEntryQueued`). OWED: (a) BUILT (draft PR, WP-CONTROL-NOTICE, [media-frame 7](frontend/media-frame.md#7-an-orphan-media-row-and-a-card-with-no-bubble)): a refused reaction/edit/pin/delete wears a mention with "Retry" and a refused delete is no longer tombstoned; owed one look on a phone; (b) the row already stored on the Mi 9T is only cleared by its Delete; (c) a reading of the dark card on the phone.

## Four organisers per event: what is left after the cap (user, 2026-10-10)

P3. The cap (#1721), the stacked faces in the list and day rows, the detail modal's chips with the quiet "n pending" line and the picker's `n / 4` are built ([calendar](frontend/modules/calendar.md), [profiles-and-access](profiles-and-access.md#d39-co-organisation-as-built-2026-10-05)). BUILT 2026-10-17: the month grid's tooltip names every organiser (`eventTooltip`), the ICS summary (the feed and the client's export) and the share title name them as `title - A + B`, `A + N autres` beyond (`eventSummary`, `organisersSummary`); no `+N` tag exists because the cap is four bands and the admin agenda rows already list every co-owner. OWED, unbuilt: (c) DECIDED 2026-10-18: an ACCEPTED co-organisation notifies the organiser, once the floor covers #1911 ([WP-COORG-ACCEPT-NOTICE](#decided-by-the-user-on-2026-10-18---every-design-question-answered); `CoorganisationService.apply` writes the row and announces nothing today). OWED, a reading: nothing here was rendered on a phone (ring and overlap of the stack, the chips' wrap, the counter).

## P3 - the iOS factory wipe leaves the App Group copies other than the names (2026-10-19)

The wipe (`clear_app_data`) walks the app data directory and, since WP-MENTION-NAME, removes the App Group `display_names.json`. It still does NOT reach the other App Group copies the account deletion removes (#2100): the mirrored `push_context.json` and the extension's `fcm_message_cache.ndjson`. Unverified whether a wipe leaves them; read the container on a device after a wipe before deciding. Not widened into the names PR on purpose.

## Queued media: bytes still live in the DB row (2026-10-10)

P3. Built in [offline-and-weak-network 13.6](frontend/offline-and-weak-network.md): lazy decode, the `error` parking of an attachment, the banner fix. OWED: (a) a SIZE CAP at compose time for a queued attachment (not recommended, see the P1 section above); the bytes are now OUT of the row ([offline-and-weak-network 13.7](frontend/offline-and-weak-network.md)); (b) the terminal state of a text on a persistent 5xx is BUILT (user, 2026-10-18, [offline-and-weak-network 17](frontend/offline-and-weak-network.md#17-a-text-the-server-keeps-failing-becomes-failed-with-a-retry-user-2026-10-18)), owed one phone reading; (c) a re-read on the Pixel 6a of the freeze with a 13 MB attachment queued (nothing here was run on that phone).

## P2 - GDPR compliance: the open items of the register (2026-10-16)

P2. From the owner's GDPR review; the substance is [register-of-processing](compliance/register-of-processing.md#9-open-items-summary), and what only the school's DPO can answer is [dso-dossier](compliance/dso-dossier.md). OPEN, each with its page: (a) the school's role (joint controller or provider) and a written hosting agreement with the DSI, including incident notice ([dso-dossier](compliance/dso-dossier.md)); (b) the transfer safeguards of Google FCM, Apple APNs, Cloudflare, Google Safe Browsing and KLIPY, documented or left "to be confirmed" in the privacy policy section 5; (c) log retention 90 days enforced, Authentik `event_retention` included (in progress elsewhere); (d) a complete account deletion with retries (in progress elsewhere) - the tables it misses today are listed in the register, section 2; (e) the database dumps encrypted; (f) KLIPY through the server with no identifier, `klipy_cid` removed, then the policy's sections 4 and 7 updated; (g) the legacy cotisations' end date and the dev estate's full copy, the DPO's opinion; (h) a retention rule for `submissions`; (i) MiGallery's DPIA measures ([dpia-migallery-faces](compliance/dpia-migallery-faces.md#6-open-measures)), controller MiTV; (j) Le Cercle: its controller, a privacy page, the leaderboards' visibility; (k) Portail-etu's legal notice fields; (l) where the request log and the breach register live off-repository; (m) unclassified media kept for ever, a production count of non-empty `submissions.email`, and a restriction flag for Art. 18. **The privacy policy is the public face of the register: a change to one is a change to the other.**

---

## P1 - The MiConnect terms stage reaches production with the next STABLE: three things come first (2026-10-16)

**HELD since 2026-10-17 (user: stable 1.2.9 ships without it).** `45-consent.yaml` waits in
`infrastructure/authentik/blueprints/held/`, never sent and named at every run, and the 8 providers
point back at `default-provider-authorization-implicit-consent`; asserted by
`held-blueprints.test.sh` and `test-blueprints.sh` ([authentik](infrastructure/authentik.md#the-terms-of-use-are-a-stage-of-the-authorization-flow-2026-10-16)).
The hold binds a stable only through a pre-release cut AFTER it merged (a stable ships its latest
alpha's commit; `v1.2.9-alpha.6` and earlier still carry the stage). **Lifting it = `git revert` of
the hold's commit**, once the three conditions below hold; the revert also restores the
`changelog.d/miconnect-terms-of-use.md` fragment and drops `miconnect-terms-held.md` (if a stable
folded that one already, the revert's conflict on it is resolved by deleting it).

`miconnect-authorization` (blueprint `45-consent.yaml`, 8 providers) is applied by the stable deploy
like any blueprint, so **do not lift the hold until these hold**, in this order: (1) the page
`/legal/miconnect` answers 200 on dev (pre-release first), because the prompt links to it; (2) the
cross-client harness accounts carry `attributes.cgu_version` (read-modify-write of the whole
attributes bag - the profile editor PATCH replaces it), or `login.mjs` ticks the box, else every
harness login stalls on the new page; (3) the prompt is READ in a real browser, on the Mi 9T and on
the iPhone (the CI test proves the HTML reaches the challenge, not that a native auth session renders
and follows its link). Rollback: re-apply the previous ref's blueprints, or flip the 8 providers back
to `default-provider-authorization-implicit-consent` in `/if/admin/`. The flow fails OPEN: a broken
policy skips the consent, it never locks anyone out. Accounts that never sign in again are never
asked. See [authentik](infrastructure/authentik.md#the-terms-of-use-are-a-stage-of-the-authorization-flow-2026-10-16).

**Where the three stand (read 2026-10-18):** (1) MET - `dev.canari-emse.fr/legal/miconnect` answers
200 with its own title (a missing `/legal/` path answers 404). (2) HALF - `login.mjs` ticks the box on
the web and in the Android Custom Tab (`idpform.mjs`, pinned by `archive/idpform-selftest.mjs`, never
yet run against the live page because the stage is held); the iOS sheet path (`signInThroughSheet`)
does not know the page, so an iPhone row needs the account's `cgu_version` set, or an iOS stage read
on the bench first. (3) NOT MET - every phone reading so far proves the hold (no terms page, PASS 3 of
3 on the iPhone 12), none reads the prompt. One MiConnect serves dev and production, so (3) can only be
read once the stage is live somewhere: bind `miconnect-authorization` to ONE provider first (`Canari
Local`, the harness's), read it on both phones, then lift the hold for the eight.

## Decided by the user on 2026-10-16 - the GDPR pass over the whole ecosystem

Source: a read-only DPO-style review of Canari, MiConnect, MiGallery, Sky, Le Cercle, Portail-etu and
the estate (the register is [register-of-processing](compliance/register-of-processing.md)). Decisions,
verbatim in substance: **controller** Association Rootz - EMSE for Canari and MiConnect, MiTV for
MiGallery (bureau@mitv.fr); **MiConnect basis** = performance of the service, the tick only proves the
terms were read; **the school HAS a DPO** (ask them to review once the work is solid; the
[dossier](compliance/dso-dossier.md) is ready); **no written agreement with the DSI** beyond the two
school charters (IT charter 2020, AI charter 2026) and ticket exchanges; **MiGallery faces STAY** with
a DPIA, a recorded consent (existing links are `consent_source='legacy'`, the owner holds the proof),
real erasure; an unlisted album serves only its own photos (fixed); **Le Cercle** legacy database is
kept OUT of git (history rewrite approved after a local mirror; the GitLab project is readable by every
school account), the balance is not refunded and the rule is stated where a member tops up and on the
delete card; **logs** 90 days; **KLIPY** through our server (done); **dev** holds fictional data only
(done, the wipe of the old copy is owed to the user); **push** payload content stays and is declared;
**export** is a manual 30-day procedure; **Sky** placeholder people get a notice only; **backups** keep
a deletion 14 days, stated, dumps to be encrypted; legacy cotisations of ~1400 non-users are kept with
no purge date (flagged to the DPO); account deletion is a durable queue (PR in progress).

**Open at the time of writing:** account erasure PR #1965 (two review rounds, blocking defects being
fixed, NOT armed); MiGallery face consent and erasure (PRs #392-#396, merged 2026-10-17);
the MiConnect terms PR #1955 (merged, then HELD out of production on 2026-10-17 - lifting the hold needs the three conditions above);
the Le Cercle history rewrite (owed: the permission system refused the destructive git step, the user
runs it or approves it explicitly); sending the DPO dossier; the DSI log-retention request. **Done 2026-10-17:** Authentik's event retention is `days=90` (a dump was taken first) and Le Cercle's MR !29 is merged and deployed.

## Decided by the user on 2026-10-18 (second batch)

- **`graine_seeds.json` and `channel_keys.json` stay on account deletion for now.** They are per-install native files holding community keys, with no owner. Backlog item: verify whether the next session re-mirrors them, then write an erasure rule using the same `push_context.json` ownership proof.
- **The server refuses a resource block that overlaps an existing block of the same resource.** The answer is typed, and the client says the block already exists. Built after the bookings batch (#2019, #2029, #2035) has merged, since it touches `bookings.service`.
- **Release: the lead cuts the next stable WITHOUT pausing for the user** (supersedes "pause when production is ready" of the same day). The number is `1.3.0`, bookings being a major visible feature. The production migrations of the batch (bookings 087-088, social-service 089-090, chat-delivery 031) are authorised. A direct production change other than a release deploy, or a destructive data migration, still waits for the user's yes.
- **Dev smoke-login account (#2020).** The lead creates a dedicated smoke account (no second factor, random password) and sets the two smoke-login variables in the development environment secrets. The identity provider is a single instance, so this is a production identity change, authorised here.
- **WP-RESTORE-1 (account restore through WebAuthn, native + server)** is built on draft PR #2065 (not merged). It stays out of a stable until the user has read it on a phone.
- **The MiConnect terms hold is lifted by the lead** as soon as the three preconditions listed above are verified; the lead tells the user.
- **The KLIPY key is not rotated.** It was read container-side for the measurement and never printed.

## Decided by the user on 2026-10-22 - the app needs iOS 16

- **The iOS app's minimum is iOS 16**, so the native WebView can carry the same script policy as the web (`'wasm-unsafe-eval'`, which WebKit before 16 does not know). Built in the stricter-policy pull request (#2267). **Owed before that stable:** the console reading for policy refusals on the web, the Mi 9T and the iPhone, and the check of the edge features that inject scripts into a page ([cloudflare-edge](infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22)). Delete this entry when it ships.

## Seen in the 2026-10-18 web console log - two observations, none built

- **Firefox disabled scroll anchoring on the `/posts` feed.** Ten consecutive sub-pixel adjustments of about 0.1667 px preceded it; rounding at a fractional device-pixel ratio is suspected. Reproduce with a `ResizeObserver` log on the feed container before changing anything.
- **A seed asked by two phones was declined by a web device** (`holding 0 - missing ... declining`). Open observation: separate the causes by who should have held it, which needs a read of production state (private operations notes), not a client change.

## P2 - A killed phone answers a background Welcome from a stale epoch, and the route reports it as sent (read on the Mi 9T, 2026-10-22)

Read on the Mi 9T (debug build, frontend `2547870a7`, from `dabc36813`), on the local estate, app killed
(no process), after one `mls_group_info` row of the group was deleted so the newcomer's external join
found no GroupInfo and sent a `welcome_request`. Two facts, recorded separately:

- **(a) The phone builds the Welcome from its stored state and the server refuses it.** The phone logged
  `Welcome created ... baseEpoch=1` while the group was at epoch 3, so it had not applied the commits
  that arrived while it was dead. chat-delivery logged `[BG_WELCOME] START ... baseEpoch=1`, then
  `REJECT commit epoch_mismatch (server epoch: 3, sent base: 1) - neither Welcome nor broadcast`. No
  commit-caller refusal appeared: the caller checks passed.
- **(b) The route answers HTTP 201 although it sent neither Welcome nor broadcast.** The phone logged
  `sendWelcomeAndCommit: HTTP 201` and `Welcome sent`, so a refused delivery reads as a success on the
  device. The answer must say what happened; this part is the more urgent one.

**NOT verified:** whether the newcomer recovered by itself (it was not read afterwards), and which
phone state the reading would have had with the pending commits drained first. A second request for the
same newcomer ended `ALREADY_MEMBER` on the phone, a duplicate that is expected. **Not fixed here:** the
fix is native and MLS, its own work package with an adversarial review.

## The encryption PIN unlock on the iPhone: READ 2026-10-22, it answers - the "hang" was the rig's tap, and one P3 is left

Read over WDA on the iPhone 12 (TestFlight `1.4.0 (100400003)`, `dev.canari-emse.fr`). **The first
reading of the day wrote "unlock does not answer, no error" and was wrong about the cause.** The same
unlock on the dev WEB client answers in about 0.5 s (`pin-check` 201, MLS ready, gate gone, no console
error), and on the Mi 9T the same code passes within ~6 s.

- **Why the iPhone looked silent: WDA's element rectangle goes stale.** The gate's layout moves when the
  iOS keyboard shows or hides (the manual field) and when the red banner appears. The accessibility
  tree still reported `Deverrouiller` at y=412 while the button was drawn at y~731, so `tapText` tapped
  empty space - three times. **The rig note: tap by the DRAWN position (screenshot pixels / 3 = points),
  and re-read the screenshot after anything that opens a keyboard or a banner; never trust a rect read
  before the layout settled.** A stray tap of the same kind also ticked `Rester connecte`, which keeps
  the vault key and would have made a relaunch skip the gate.
- **What the gate said once it was really tapped:** a red banner, `Vos messages enregistres sur cet
  appareil sont verrouilles par un autre PIN que celui-ci...` - correct, the phone held local state under
  the PIN from before a web-side PIN reset (a reset on one device strands the others, documented in
  [cross-client-harness-findings](cross-client-harness-findings.md)). After a PIN reset on the phone, a
  create, a kill and a relaunch, the keypad PIN plus a tap at the drawn position passed the gate and it
  stayed passed.
- **P3 - on a 390x844 screen the red banner pushes the keypad down until its `0` key is clipped behind
  the fixed `Deverrouiller` button**; the dialog scrolls, the key comes back, nothing is lost, but a
  person sees a keypad with no zero until they scroll. Screenshots of both states were taken in the
  session (not committed). Fix is layout only: the dialog body must reserve the height of the fixed
  button, or the banner must not displace the keypad.
- **Not read:** the keyboard-rise behaviour of the manual field on this phone (check W is a separate P3).

## P3 - iPhone sign-in: the login page stays on a disabled "Redirection..." after the in-app sheet is cancelled (read 2026-10-22)

On the iPhone (TestFlight `1.4.0`, build 100400001, `dev.canari-emse.fr`), cancelling the identity sheet
(`Annuler`) returns to the login page with its button stuck on a disabled `Redirection...`; only a
relaunch of the app brings the button back. Observed twice, driven over WDA; not read on a phone by hand,
and not explained.

## P3 - iPhone sign-in: iOS Password AutoFill covers the password field of the identity sheet (read 2026-10-22)

On the same build, the system AutoFill card (`Se connecter ... avec le mot de passe utilise pour ...`)
sits over the password field and the `Se connecter` button of the school's CAS page, and a tap on that
field lands on the card, so a driven sign-in types into the wrong field. It is a property of that phone's
settings, not of the app. A driven sign-in avoids it by moving focus with Tab and submitting with Enter;
the page the test accounts use is the "Connexion externe (service-account)" route, not the school CAS.

## P3 - The background Welcome route refuses `not_a_member` before it asks whether these bytes already landed (review of #2329, 2026-10-24)

`POST /api/mls/push/send-welcome-and-commit` (`push.controller.ts`, `sendWelcomeAndCommitPush`) runs, in
order: `verifyPushSecretAuth` -> the body checks -> the **membership guard** (no `dm_group_members` row
for the target -> `409 {status: 'rejected', reason: 'not_a_member'}`) -> `validateCommit`, whose
refusals are the only ones that first ask the commit log whether THESE bytes from THIS device already
landed at the base (`answerIfAlreadyAccepted`, `messaging.service.ts`) and answer `duplicate` if so.

**The sequence it loses:** the phone's first POST is accepted (the Add lands, the Welcome is stored);
the answer is lost and Android's `HttpURLConnection` silently retries the POST on a reused connection;
between the two, the target is removed from the conversation. The retry meets the membership guard
first and reads `not_a_member`, a typed refusal, so the phone CLEARS its stage
(`BackgroundWelcomeAnswer.settle`) while the server holds its commit. The device then recovers through
the foreground's replay and ladder (`ACCEPTED AND NOT HELD` is never said: the clear ran on a refusal),
so the cost is a recovery, not a fork. Rare: it needs a lost answer AND a removal inside one round trip.

**Why the check cannot simply move after `validateCommit`:** the guard is the single chokepoint that
stops a holder's phone from re-adding a REMOVED user from a push. After the gate, a removed target's
re-add commit would already be accepted - the epoch moved, the Welcome stored - before it is refused.
That is a security regression, not a reordering.

**The fix owed:** on the membership refusal only, ask `answerIfAlreadyAccepted` for these bytes (group,
device, base epoch, commit) and answer the duplicate acceptance when the log holds them; refuse
`not_a_member` otherwise. It needs the helper exposed from `MessagingService` (it is private today) and
one spec: an accepted commit, then a removal, then the same request -> `duplicate`, never
`not_a_member`. Closes when that spec is green.

## P3 - The background Welcome's warm-process refusal: its rate, its wasted round trip, and the old-PIN path (review of #2329, 2026-10-24)

1. **The warm mark is sticky, so the refusal may be the common case.** `live_manager_in_process` is set
   by the first foreground load and never cleared while the process lives, so a process in which the
   app was ever opened refuses EVERY background Welcome (`prepare refused reason=warm-process`) until
   Android kills it - which it often does not, for hours. The path is then effectively off whenever
   Android keeps the process; the newcomer is served by another member, the foreground, or its own
   external join. **Owed: measure the warm-process refusal rate** against the prepares that reach a
   stage, on the Mi 9T and in the field logs, before deciding whether a warm process needs its own path.
2. **The phone learns it is warm too late.** `processWelcomeRequestBackground`
   (`CanariFirebaseMessagingService.kt`) fetches the KeyPackage over HTTP and takes the Redis add-lock
   BEFORE the JNI prepare refuses `warm-process`: one wasted round trip and a held lock per push. A
   cheap JNI probe (`live_manager_in_process`) checked before the fetch removes it; the prepare's own
   check stays, since the compare-and-swap is the proof.
3. **The old-PIN recovery marks the process warm only at install.** The branch of `commands/mls.rs`
   that installs CALLER-SUPPLIED bytes (`mark_foreground_manager_loading`) marks the process when it
   installs them, not when the WebView read them. Bytes read before a cold stage write and installed
   after it build a manager without the stage, which then persists over it while the server may hold
   the commit. Closing it means marking the process warm before those bytes are read, or re-reading
   `mls.bin` under the lock at install.

## Hardware reading owed (user): one background Welcome on the Mi 9T (2026-10-22)

The background Welcome route (`POST /mls/push/send-welcome-and-commit`) now validates its commit as the
push-secret-authenticated committer, so a native path changed and no gate here runs native code.

**Verified from source instead of hardware (2026-10-22).** The rig could not build the trigger: a new
device asks for a background Welcome only when its own external join fails for a reason other than
not being a member. So the request was compared with the route by reading both.
`sendWelcomeAndCommit` in `CanariFirebaseMessagingService.kt` sends `Authorization: PushSecret`, puts
`userId` and `deviceId` in the body, and sends neither `senderId` nor `x-user-id`. The route
authenticates that exact pair and hands it to `validateCommit` as the committer, `senderId` included.
The pair passes the registry check because the push-token row and the key-package row both take
`userId` from `x-user-id`. iOS never posts this route. `push.controller.welcome-commit.spec.ts`
already sends exactly this body. **The reading below stays owed, by the user**, and it no longer holds
a stable.

The reading has one setup and three checks:

- **Setup.** The Mi 9T is killed, not force-stopped (swiped away), and is a member of a group
  conversation. A new device of another member must send a `welcome_request` for it, which makes the
  phone answer in the background. **That request is sent only when the newcomer's own external join
  for the chat group FAILS for a reason other than `NotAGroupMember`** (no GroupInfo published, a stale
  base, an unreachable server; `requestReAdd` step 9 and `sendWelcomeRequest` in `recovery.ts`). A new
  login on a healthy estate does not send it: see the attempt below. The PROCESS must be cold: a
  process in which the app was loaded since it last died answers `prepare refused
  reason=warm-process` and sends nothing, by design.
- **Phone (logcat).** Both of these lines appear (their wording since the typed answer, see
  [chat-delivery](services/chat-delivery.md#the-background-welcome-answers-what-happened-and-the-stage-is-merged-only-on-an-acceptance-2026-10-22)):
  - `processWelcomeRequestBackground: Welcome staged ... baseEpoch=N`;
  - `processWelcomeRequestBackground: group=... target=... accepted at base N - Welcome sent - staged Add merged`.

  No `REFUSED`, `OUTCOME UNKNOWN` or `ACCEPTED AND NOT HELD` line appears.
- **The same reading with the app OPENED inside the round trip** (open the app between the
  `Welcome staged` line and the answer): the phone logs `stage left in mls.bin (left-to-foreground)`
  or `already settled by the foreground`; the foreground's next load logs `background stage of
  group=... found in the loaded state` (or `already merged`), then the WebView logs `[COMMIT] settling
  1 staged commit(s) by resubmission` and `... accepted - merged`; the newcomer reads the next message.
  No `ACCEPTED AND NOT HELD`, no `is ABSENT from the state this foreground keeps`, no `ERASES`.
- **The same reading with the phone STALE** (its group moved while it was shut, as on 2026-10-22):
  the phone logs `REFUSED epoch_mismatch: built on base N, the group is at M`, the server answers 409,
  the phone then reads the group's next message once opened, and the newcomer's next ask logs
  `already refused as stale from this mls.bin -> not answered`.
- **Server (chat-delivery on the local estate).** For the same group, these three lines appear:
  - `[BG_WELCOME][bg-wlc-...] START ... baseEpoch=N`;
  - `commit accepted -> activeEpoch=N+1`;
  - `DONE`.

  No `REJECT` appears, and in particular no commit-caller refusal.
- **The newcomer.** It opens the group and reads the next message.

**ATTEMPTED 2026-10-22: NOT EXERCISED, owed.** The Mi 9T ran a debug build whose frontend equals
`2547870a7` (built from `dabc36813`, plus an uncommitted whitespace change to `AndroidManifest.xml`);
the device is NEW (installed 2026-10-22 04:24:30 after the 1.3.1 release build was uninstalled on
purpose, a bench phone), signed in as the bench owner on the local estate, app swiped from recents
(no process left). A wiped web device of the same account then enrolled. It joined all four groups
by itself (`roster seat with NO queued Welcome and NO add in flight - nobody owes us anything; serving
ourselves`, then external join), so no `welcome_request` was sent: no
`processWelcomeRequestBackground` line, no `[BG_WELCOME]` line, no REJECT. **What WAS read:** FCM woke
the swiped-away phone for four `message` pushes and it applied the external-commit control frames
("control frame applied - state advanced") with no error, so background control-frame handling works
on that build. **READ later the same day, with the user's agreement to delete one local-estate row:** the request was
sent and the phone answered it from a stale epoch, see the P2 above. The phone stays on the debug
build, signed in on the local estate only, which is stopped.

## P2 - WP-CHECKPOINT-CAS: one owner of the MLS state per process, handed over by the platform (2026-10-27, design reviewed four times, nothing built)

**What it changes.** On a phone, the visible app and the background engines share one process and one
state file. Today a heartbeat deadline decides who may write that file, and on Android the page's
visibility never changes, so the heartbeat keeps running while the app is hidden. This WP replaces
the deadline with an explicit owner register held under the existing state-file write lock:
`Vacant`, `Foreground` (the live manager owns the file and background work stays queued) or `Parked`
(the app is hidden, the live manager is frozen and checkpointed, and background engines work from the
file by compare-and-swap). Ownership follows a host-visibility flag that the platform's lifecycle
callbacks write and that is re-read under the lock at every transition. A live call counts as
visible. The unpark runs inside the WebView's mutex grant, so nothing waits for it.

**Four pull requests, no runtime switch, each better than main alone:**

1. **The outbox.** One Rust module owns both outbox files behind one OS file lock and writes them
   atomically. Every sender claims its entries before sealing them and settles them incrementally.
   Closes a queued reply erased by a concurrent rewrite, a message sent twice by the background and
   the app, and a lost update of the sent log.
2. **The teardown and the job fence.** Manager, device key and register are reset in one hold, and
   every background job is fenced by the generation it started under. Closes state resurrected by a
   background job after sign-out. **The one-hold teardown of the manager and the key is BUILT
   (2026-10-27, `end_native_session`, [mls-protocol](protocols/mls-protocol.md#the-native-manager-does-not-outlive-its-account-2026-10-27));
   the generation is what is left.** The native slot has no session generation today: a command issued
   by a destroyed client A that lands after B's `initialiser_mls` acts on B's manager, since the slot
   says only `Some` or `None`, never whose. Only the TypeScript side fences it (the holder retires A's
   client before B's login opens anything). The fence: a generation the install stamps and every
   command carries, refused typed on a mismatch.
3. **The register.** The register itself; a native park that writes nothing when nothing changed;
   an unpark that holds no command lock across a decrypt; one native visibility event for the page;
   on Android, the socket paused while hidden; frames in flight tracked in both directions; a pending
   external join skipped by every background writer. Closes background delivery starved while the app
   is hidden, the resume that overwrote a background advance, the blind checkpoint, and a frame
   stranded by a commit on either side. Jobs with a server effect keep today's refusal.
4. **The stages.** A background key-group join is staged inside the state file, hidden from every
   group listing until it is settled, and settled from the server's answer by whoever owns the file
   next. Closes the joined-but-not-held loss, apart from a bounded late-landing window that is
   reported. A host test settled the precondition on 2026-10-27: a pending external join survives a
   save and reload, and dropping the group leaves the key store byte-identical. That test, and a
   corrected docblock for the external join, land in their own small pull request ahead of PR4.

The design (lock order, interleavings, tests and device rows) is written into the wiki page of the code
each pull request changes, as it lands. Until then this row is its summary. **Ahead of all four:** a
small pull request lands the host test of the precondition and corrects the external join's
docblock, which still calls the join's commit staged.

**Decided.**

- **REJECTED 2026-10-23:** a per-group reconcile of the file into the live manager (a heal).
- **REJECTED 2026-10-27:** background engines borrowing the live manager; a park driven by the
  WebView; a park triggered by the renderer's death (the process dies with it); a transition waiting
  for background jobs; an outbox guarded by two lock families; a park request matched on the session;
  exporting call keys from a parked manager; a server-side fence for the late landing.
- **Lock order:** WebView MLS mutex -> background state lock -> checkpoint lock -> manager mutex ->
  state-file write lock. The outbox lock (one file descriptor per acquisition), the key-group ledger
  lock and the in-flight set lock are LEAVES: they may be taken under anything, and nothing is taken
  under them.
- **On Android the socket follows the host while no call is live**, so a hidden phone is reached by
  push.

**Owed after:** the tests in the design (red on main where today's seams allow); Mi 9T rows D1-D10;
iOS rows after a manual iOS compile; a one-time reader for the old join files, with a removal date.

## P3 - The native command boundary carries its error codes as string prefixes (2026-10-28)

Every Tauri command returns `Result<_, String>`, and every code the TypeScript side reads
(`KEYSTORE_KEY_UNAVAILABLE`, the `STATE_*` load codes, `MLS_MANAGER_ABSENT`) crosses as the string's
leading token, read by one predicate each (`isKeystoreKeyUnavailable`, `classifyStateLoadFailure`,
`isMlsManagerAbsent`). Tauri can serialise an error object instead: one `{ code, message }` type for
every command, decoded into typed errors at the one `invoke` boundary. All codes move in one pull
request, never one at a time (two conventions would give every reader two shapes)
([mls-protocol](protocols/mls-protocol.md#the-native-manager-does-not-outlive-its-account-2026-10-27)).

## P3 - A rotation that fails every time loops through the PIN gate (2026-10-28)

A device identity rotation that fails on every attempt (a disk that refuses every checkpoint, say)
makes a loop: PIN gate -> unlock -> the key-package round is answered "revoked" -> the rotation fails
-> the session is lost -> PIN gate. Each lap costs the member one PIN entry and is logged at ERROR
(`reportMlsSessionLost`); nothing is revoked or erased, so the loop is visible and harmless but not
broken. Owed: a durable count of consecutive failed rotations for this install that, past a bound,
stops the unlock with its own typed outcome instead of another lap
([mls-protocol](protocols/mls-protocol.md#the-native-manager-does-not-outlive-its-account-2026-10-27)).

## P1 - WP-KEYGROUP-JOIN-GATE: a key-group external join is asked of social-service - BUILT, owed its 503 rate (2026-10-22)

A key-group external commit and a key group's Welcome target are now asked of social-service
(`POST /internal/distribution-groups/entitlement`) before the epoch moves and before any activation;
an unanswered call is a `503 entitlement_unavailable`, never an acceptance
([channel-encryption](protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
Owed before a stable: the rate of `[ENTITLEMENT] UNANSWERED` lines on dev, then production, against
the ~77 key-group joins/day.

## P3 - The key-group seat lock: what it does not yet carry (2026-10-22)

Every seat-creating write (a commit's committer and its admits, a key group's publisher) and every
eviction share one per-group advisory lock, and a seat claim is the group's own generation,
`dm_groups."seatGeneration"`, which every eviction moves (chat-delivery migration 036; a claim an
unrelated eviction overtook refuses the whole commit with a retryable 409 `SEAT_CLAIM_OVERTAKEN`).
`dm_seat_evictions` only names a key-group departure in progress, and an erasure deletes its rows;
every key-group departure, account erasure included, goes through one function and
records its outcome in `distribution_departures` (social migration 108), which the hourly drain asks
for ([channel-encryption](protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
Both migrations are applied by the release's deploy before the new containers start, and may ride the
next stable (user, 2026-10-22). The first-writer-wins race runs against PostgreSQL in CI
(`distribution-departure.integration.spec.ts`), and chat-delivery's seat lock orderings too
(`seat-lock.integration.spec.ts`, `test-chat-delivery-integration`). A rejoin after a lost second eviction
waits for the hourly drain, by design ([channel-encryption](protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
Owed: (1) the counts of `[KEY_DISTRIBUTION] second eviction FAILED`, `departure ABANDONED`,
`abandoned departure NOT settled`, `first eviction named NO departure`, `DEPARTURE_SUPERSEDED`,
`route NOT written`, `ROUTE_NOT_RESTORED`, `SEAT_GONE_NOT_QUEUED` and `[SEAT_DRAIN]` outcomes on dev then production, expected near 0 (the
unnamed line only during the deploy itself); (2) the latency of a key group's commit with admits
(the questions are asked in parallel, one round trip) measured on dev.

## P2 - The mobile sign-in returns through a custom scheme: PKCE binds the code, not the app (2026-10-23)

PKCE (S256, [auth](frontend/modules/auth.md#login-flow)) makes a code worthless to anybody who lacks
the verifier of the request that produced it. It does not say WHICH app receives the redirect: the
phone sign-in returns on `fr.emse.canari://callback`, a custom scheme the OS does not verify, and a
party that runs its own authorization runs its own PKCE too. What closes that is a redirect only
Canari can receive: an `https` callback on a verified host (`MOBILE_APP_LINK_HOSTS` in
`frontend/src/lib/mobile/appSiteAssociation.ts`, App Links on Android, Universal Links on iOS)
registered on the providers in `infrastructure/authentik/blueprints/50-providers.yaml`; then, once
`minClientVersion` covers it, the custom-scheme redirect URI comes off the providers and core-service
refuses a callback with no verifier
([legacy-compatibility](legacy-compatibility.md#no-date-yet---an-oidc-callback-with-no-pkce-verifier)).
Owed first: whether `ASWebAuthenticationSession` and the Custom Tab both hand an `https` callback on a
claimed host back to the app on the bench phones, a reading, since no gate here sees it.

## P3 - The commit rate limit is not yet checked against production (2026-10-22)

`POST /mls/commit` is limited to 600 commits per user per minute since 2026-10-22, and a refusal
carries its wait (`RATE_LIMITED`, `retryAfterMs`) so the client's sweeps stop on it
([channel-encryption](protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
The push-triggered key-group joins of #2266 go through `POST /mls/push/key-group-join` (PushSecret),
which has no throttler, so they do NOT count against this per-user quota. Owed: the production
maximum per user and minute over 30 days (`mls_commit_log` joined to its sender device's user,
grouped by minute), and the count of `[THROTTLE] REFUSED MessagingController.validateCommit` lines
on dev then production, expected 0.

## P2 - A push registration is not bound to the session that made it (2026-10-22) - DECIDED: build it (user, 2026-10-23)

A session that ends ends its device's push registration on both sides since 2026-10-22
([sessions](sessions.md#a-session-that-ends-takes-its-devices-push-registration-with-it-2026-10-22)).
The server half is ONE internal call per ended session, deleting by `(userId, deviceId)`. Two
reliability properties need a schema change. **The user said yes on 2026-10-23**: the migration and
the outbox below are built as their own pull request, after this one:

- **Durability.** The server-side ending is single-shot: a failed call is logged at error and not
  retried.
- **Precision.** The delete is keyed on the device, not on the registration the ended session made,
  so its order against a re-sign-in on the same device is not fixed by construction.

**The design to build.** Migration on chat-delivery: `push_token."sessionId" uuid NULL`, written by
`POST /mls/push/register` from the access token's session claim (if the access token does not carry
`sid`, core-service adds it); the internal route deletes `WHERE "sessionId" = :sid`. Rows registered
before the column carry NULL and are rewritten at their next registration - no backfill. Migration on
core-service: an outbox `session_push_endings (sessionId, userId, deviceId, createdAt, attempts,
lastError)` written in the SAME transaction as the session delete and drained like
`account_erasure_jobs` until chat-delivery answers 2xx. Together these make a session's end and its
push ending one durable fact.

## Note - a kicked device's membership report (2026-10-22)

A refused report of `active` is warned on the client since 2026-10-22 (`[MEMBERSHIP] report of
active REFUSED`, with the status, code and reason). A kicked device's report is refused until an ADMITTING commit clears the kick, and only clients from
`0.18.28` (`commitAdmits.ts`) send admits. Measured on production 2026-10-22: `min_client_version` is
`1.2.7` (enforced by the client, which refuses to sign in below it), and of the 398 devices that
committed in the 30 days before, 0 reporting a version below `0.18.28` and 0 reporting none committed
after 2026-10-17, the day the floor reached `1.2.7`. So no re-add without admits is expected.

## P3 - An invitation reads `Membre` as the base role, so a role literally named Membre is not grantable by invitation (2026-10-22)

`inviteToChannel` maps `roleName: 'Membre'` (and the base role's own name) to the base role, because
every client before #2277 sends `Membre` for an ordinary invitation, whatever the community calls its
lowest role ([social-service](services/social-service.md#an-invitation-grants-only-a-role-the-inviter-may-grant-2026-10-22)).
A community that names a higher role `Membre` cannot grant it by invitation; a role change after the
join still can. **Lifted when `minClientVersion` reaches the first version carrying #2277's client**
(which sends no `roleName` for an ordinary invitation): then match a role by its own name before the
`Membre` fallback, with the test that a role literally named Membre above the base role is granted.

## P3 - A device id is held by one account, checked before the insert and not by an index (2026-10-22)

Registration refuses a device id another account holds (`device_id_taken`) by a read before its write; `key_package` is unique on the pair only, so two concurrent registrations of one id by two accounts could both pass. Production held 0 shared ids on 2026-10-22, and a client mints its id per account. The fix is a unique index on `key_package."deviceId"`, a migration of its own.

## P3 - The distribution path's device check: read dev on the alpha, production after the stable

On a key-group frame `openDistributionFrame` compares only the envelope's USER with the MLS credential; the envelope's `senderDeviceId` stays self-asserted ([channel-encryption section 21.1](protocols/channel-encryption.md#211-the-verified-sender-measured-then-refused-wp-g2-1-g2-1b)). Handing it to the sender check would REFUSE every frame whose device disagrees, and production has never been read for `path=distribution kind=device`, so it was taken out of #2027 (user, 2026-10-18). What it would buy: a device could no longer answer "I hold nothing" in a sibling's name ([section 24](protocols/channel-encryption.md#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18)). BUILT in #2090: `openDistributionFrame` hands the envelope's device to the sender check whenever the envelope carries one; an envelope with no device still compares the user alone. **The pre-stable production evidence is INDIRECT, and it is the only kind there can be** - an alpha deploys dev alone, so production never runs this code before a stable. READ 2026-10-24 on chat-delivery, every log still kept (production 2026-10-10 to 2026-10-24, with size-cap gaps): ZERO `[SENDER_MISMATCH]` of any path or kind, and zero `POST /api/mls/sender-mismatch` in the production access log - the `live` path compares the device on the SAME envelope field (`deliveryMeta.senderDeviceId`, written from the sender's `POST /api/mls/send`) and never disagreed. Owed, in order: (1) an alpha, then `[SENDER_MISMATCH] path=distribution` read on dev's chat-delivery - weak evidence, dev's population being a fictional seed plus the testers; (2) the stable; (3) the same line read on production AFTER that stable. A nonzero `kind=device` there is triaged from its reports (envelope device against verified device) before any further stable: an honest client disagreeing with its own credential means the device hand-over is reverted in a patch release and the client cause fixed before it ships again (a refused seed is recoverable by a history request); a sibling naming another device is the case it was built to refuse, and stays.

## P3 - `[TAURI] Couldn't find callback id` every ~15 s after a text-size WebView reload (2026-10-17)

One id, repeated at 15 s, from the previous page's callback. Suspect, unproven: the `plugin-websocket` listener of `TauriMlsService` outliving the page (no `pagehide` release). Evidence and next step: [device-verification](device-verification.md#2026-10-17-follow-up-the-sort-row-fixed-and-the-stale-tauri-callback-open-cause-not-proven). 2026-10-17: `TauriMlsService` now releases the native socket (listener and connection) on `pagehide` through `pauseSocket`. OWED: one Mi 9T reading after a text-size reload that the repeating id is gone; delete this item then, and if it repeats the cause is elsewhere.

## P3 - EXIT-FORTIFY: closing the app logs a native abort `pthread_mutex_lock called on a destroyed mutex` (Mi 9T, `v1.3.1-alpha.5`, 2026-10-21)

On app close Android logged `FORTIFY: pthread_mutex_lock called on a destroyed mutex`, recorded as a normal exit. Suspect, unproven: a thread still locking after shutdown destroyed the mutex. It could surface in Play crash reports. Owed: the thread's name from logcat on a second close. Evidence: [device-readings-2026-10](device-readings-2026-10.md), section "2026-10-21 - `v1.3.1-alpha.5` - the stable gate" (#2178).

## P3 - `[WS] 4 pings without server response - closing zombie connection`, repeatedly overnight on an idle Mi 9T (2026-10-21)

Seen at 04:36, 04:45, 04:55 and 06:12 on a phone left idle. Not investigated: whether the phone's network slept, the server stopped answering, or the ping budget is too tight for Doze.

## P3 - Nothing warns a manager whose free-amount bounds fall outside the payable range (review of #2208, 2026-10-21, not built)

A product's `customAmountMinCents` / `customAmountMaxCents` can be saved outside 0.50-1000 EUR (`libs/contracts/payment-amount-range.json`), so a buyer is refused by the provider range at checkout for an amount the product itself allows. Owed: the product editor names the range when a bound crosses it ([payments](frontend/modules/payments.md)).

## P3 - Dev bench notes: a dev push cannot be read, and a PIN reset through the rig purges the iPhone (2026-10-21)

- **Dev sends no FCM**: `DEV_FIREBASE_SERVICE_ACCOUNT_JSON` does not exist, so `push_text.rs` / `proto_fields.rs` behaviour and the banner on a locked phone cannot be read on dev. A dev push reading needs that secret: the owner line "set the `DEV_FIREBASE_SERVICE_ACCOUNT_JSON` secret" in [owed to the user](#owed-to-the-user---decisions-rotations-and-one-off-clicks).
- **The rig's W2 Chrome profile is the same account as the iPhone's test account**, so a PIN reset through W2 purges the iPhone's footprint. Check which devices share the account before resetting a PIN.

## P3 - Canonical cotisation products created between migration 057 and #2205 were never withheld, so no release touches them (2026-10-21, no backfill)

From migration 057 (2026-08-31) until #2205, `provisionCotisationProduct` created the canonical cotisation with `isActive = ready` and left `activationWithheld` at its default `false`. One created while payments were not ready is therefore `isActive = false, activationWithheld = false` - the signature of a product an admin took off sale by hand - and neither the onboarding release nor the provider-activated sweep of #2205 will ever put it on sale. No backfill: that signature cannot tell such a row from a deliberate deactivation, and an allowlist built from it would be a guess ([cotisations](cotisations.md)).

**Measured on production 2026-10-21 (read-only): 0 rows** match the canonical signature. One `membership` row created since 057 is inactive and not withheld, under another name, touched 3 s after creation - not distinguishable from a manual tier, so not counted. The query, to re-run if a case is reported:

```sql
SELECT count(*) FROM association_products
WHERE type = 'membership' AND name = 'Cotisation'
  AND "isActive" = false AND "activationWithheld" = false
  AND "createdAt" >= '2026-08-31';
```

A row found this way is put on sale by its association's admin from the boutique, a manual `isActive` change and so the right owner of that decision.

## Idea (owner, 2026-10-21): store videos and screenshots from the bench phones

Reuse the bench phones with screen recording to make demo videos and screenshots for the stores and for communication, from the fictional dev seed (never production). Personal data blurred frame by frame and the result reviewed before delivery; Apple and Google formats. Capture and sizes: [store-listings](store-listings.md#6-capture). Not built.

## Sharing into and out of Canari - S1-S4 and S5 (Android) built (user, 2026-10-11, a priority 2026-10-21)

Share IN on Android (S1+S2) and share OUT (S3, [share-out](frontend/share-out.md)) are built; a
waiting share is erased at sign-out (user, 2026-10-22). The Android share-sheet suggestions (S5) are
built too: recent conversations as direct targets, erased at sign-out, behind a setting. Owed: the
Mi 9T and iPhone 12 readings.
**S4, share IN on iOS, is BUILT (2026-10-22)** now that the App ID `fr.emse.canari.share` (App
Group) and its `CanariShare` profiles exist: a Share Extension writes into the App Group and the app
carries the share out of it into the Android layout. Nothing on Windows compiles it, so CI's archive
is its first compile and the iPhone readings listed under Owed on
[sharing](frontend/sharing.md#owed) are its first proof - including the secret
`APPLE_PROVISIONING_PROFILE_SHARE`, which every signed `ios.yml` build now REQUIRES. Next: the iOS
suggestions (`INSendMessageIntent`).

## P3 - Three loose ends of the per-conversation drafts (review of #2614, 2026-10-27)

- **A text restored while an edit is open is LOST.** A refused send answered (or a share landing)
  on the conversation being edited goes through `restoreFailedDraft` into the composer, which holds
  the edited message's text; `cancel`, `confirm` and `reset` then put back the draft saved at
  `begin` (`editSession.svelte.ts`), and the restored text is gone - or, on `confirm`, saved as part
  of the edited message.
- **The salon ledger detour stays, for durability.** A salon text resumed after the member left the
  salon goes back to the ledger (`recordUnsentSalonText`), not straight into that salon's draft
  through the gated writer: the ledger is persisted, the drafts are memory only, so a page closed
  before the next visit would lose it. Simplifying it waits for drafts that outlive the page.
- **A mention dropdown can outlive a conversation switch.** `useMentionAutocomplete` closes only on
  input: type `@ali` in A, switch to B before the debounced search answers or with the list open,
  and the list (A's members) stays over B's composer until the next keystroke.
- **Drafts are never removed when a conversation is left or deleted**: the entry stays in
  `draftByConversation` until sign-out. Memory only and per page life, so small - but a conversation
  re-joined later shows the old text.

[chat](frontend/modules/chat.md#each-conversation-keeps-its-own-draft-2026-10-27)

## P2 - A waiting share is locked with the device on iOS - built 2026-10-27, owed its iPhone readings

A waiting share (manifest and copies) is written under Data Protection on iOS - the extension's
`CompleteUnlessOpen`, the app-side manifest's `Complete` - a locked read deletes nothing, and the
unlock offers what the lock held back; Android keeps its credential-encrypted storage, with the
reasoning written down. The app-level seal first sketched here was rejected, with its reasons:
[sharing](frontend/sharing.md) ("At rest", iOS path item 5). Nothing here compiles iOS, so the
Swift, the Objective-C and the iOS-only Rust ride the next iOS build.

**Owed on the iPhone, with a passcode set, waiting more than 10 s after each lock** (the key is
discarded about 10 s after it), Console on `[CanariShare]` / `[SHARE]` and category `share`:

1. Cold launch, unlocked: the `launch sweep:` line appears, and no `deferred` line (the sweep and
   import no longer ask UIKit before it exists).
2. Share a text and a photo, unlocked: `moved copy protection = ...` names the expected class
   (`NSFileProtectionCompleteUnlessOpen` for a copy), and no protection or `setAttributes` error.
3. Share again with Canari killed, so it waits in the App Group undrained; lock, wait, send a push:
   the launch import line says `locked with the device` - NOT `ERROR: the share could not be moved
   or handed over` (a refused protection or create must classify as locked, by its code) - the
   share is still in the App Group, and no `dropped`, `unreadable` or deletion line.
   Seeing instead a refusal named `NSCocoaErrorDomain 513` WITHOUT an underlying POSIX error is the
   outcome this reading exists to find, not a regression: Foundation then gave no code to classify
   by. Record it here as measured, and the classification is redesigned from that fact.
4. Unlock straight into Canari: the share is offered on the first activation.
5. Variant of 3 where the share already sits in the app data directory (imported, not yet drained),
   and the locked push launch mounts the page: after the unlock it is offered with no new launch
   (`a share waits (unlock), the page was told`).
6. A large iCloud video, the phone locked during the capture: with nothing waiting, the share
   survives; with an older share waiting, that one is not deleted and the new one is refused, said
   on the extension's card and in its log. KEEP-OLD BY CHOICE: the locked older share cannot be
   read, and the member was already told it is ready; the member sharing now is told of the
   failure. The reasons, and the newest-wins alternative rejected, are in
   [sharing](frontend/sharing.md) ("At rest"). The app side no longer meets this case while
   locked: it consumes nothing until the unlock, where newest wins as usual.
7. Sign out while locked, then unlock: the old share is dropped as stale.

## P3 - The share-in picker lists conversations alphabetically, every other share surface by recency (Mi 9T, 2026-10-27)

A share from another app opens "Envoyer a..." (`IncomingShareHost`), which reuses
`ForwardMessageModal` and so `shareDestinations` with `order: 'alphabetical'`. The conversation
list, the share-sheet suggestions (S5) and a post's share sheet (`order: 'recent'`) all lead with
the most recent conversation, so the one the member just left is at the top everywhere except
there. Deciding: whether the forward and the share-in picker split their order, or both go to
`'recent'` ([sharing](frontend/sharing.md)).

## P3 - `ChatArea.entryWindow` "never mounts more than the 20-row entry frame" fails under the full sweep and passes alone (2026-10-27)

Seen failing in a full `vitest run` on a loaded machine, and passing when the file runs alone.
Not diagnosed: the test asserts a mount count, so a mount that has not settled yet when the
assertion runs (a timing dependency) is the first suspect, not proven. Owed: run it under
`--repeat` with the full sweep's load, and name the condition before touching the test.

## P3 - The eight service images run as root (Trivy DS-0002, measured 2026-10-23)

Trivy's Dockerfile scan finds no non-root `USER` in any `infrastructure/local/Dockerfile.*`, and
`--no-install-recommends` missing in the two Rust ones (DS-0029). Not gated: a `USER` on a
production image needs the ownership of its volumes checked on a running estate first. Done when
each image runs as a non-root user and `trivy config infrastructure/local` reports nothing HIGH
([cicd](cicd.md#container-images-are-scanned-2026-10-23)).

## P3 - Bump the four Alpine pins when upstream rebuilds with brotli 1.2.1 (2026-10-24)

Owner: Master. `CVE-2026-92392` (curl 8.22.0-r0, fixed in 8.23.0-r0) joined it on 2026-10-26 under the same conditions, so the rebuild must carry BOTH fixes and both entries go together. `CVE-2026-111497` (`brotli-libs` 1.2.0-r1) is allowlisted in
`.github/image-scan-allowlist.yaml` because no patched image existed: Alpine fixed it on 2026-10-22
and the official `adminer`, `nginx:1.31.8-alpine`, `nginx:stable-alpine` and `postgres:18-alpine`
builds of that day still carry 1.2.0. Done when the three digest pins (production and dev compose,
the local compose for postgres) move to a rebuild carrying 1.2.1-r0, postgres within major 18. The
floating `nginx:stable-alpine` follows on its own, and the allowlist entry is deleted in the same pull
request - the image scan's retirement check fails until it is
([cicd](cicd.md#container-images-are-scanned-2026-10-23)).

## P3 - Bump authentik when a release ships Debian's libbrotli1 1.1.0-2+deb13u1 (2026-10-24)

Owner: Master. `CVE-2026-111497` on Debian's `libbrotli1` 1.1.0-2+b7 is allowlisted by purl for
`ghcr.io/goauthentik/server:2026.8.5`, the newest authentik release, which this repository does not
build. Done when an authentik release carries 1.1.0-2+deb13u1 and `AUTHENTIK_TAG` (the compose
default and the host's `.env`) moves to it; the image scan's purl retirement fails on that pull
request until the `libbrotli1` entry is deleted ([cicd](cicd.md#container-images-are-scanned-2026-10-23)).

**Also allowlisted on 2026-10-27 for the same image, same condition (a release that ships them):** dnspython 2.8.0 (`CVE-2026-114605`, fixed in 2.9.0), msgpack 1.2.1 (`CVE-2026-114613`, 1.2.3) and oauthlib 3.3.1 (`CVE-2026-49272`, 4.0.0). Each entry is scoped by purl and retires through the same check, so the bump pull request deletes all four together.

**Frontend build tooling, 2026-10-28:** `GHSA-gcqx-w48m-w2h4` (LOW, `deepmerge` <= 4.3.1, prototype poisoning in `mergeObject()`, no fixed version published) is ignored in the frontend's dependency audit with its reachability argument in `code-analysis.yml`. Delete the ignore when a fixed `deepmerge` reaches the tree; the audit's retirement step fails until it is.

## Owed a VERIFICATION, and nothing else

Each of these is fixed in the tree; what is left is the measurement that would prove it. **Nothing
about them is open work** - the story is in `CHANGELOG.md`, the mechanism on the wiki page named,
the rule in [durable-rules](durable-rules.md). Delete the line once the measurement is taken. The
phone passes already taken are history: [device-readings-2026-10](device-readings-2026-10.md).

**#2329, the background Welcome staged in the state file (merged 2026-10-24), owes two things before its stable.** (a) One Mi 9T reading: open the app INSIDE a background Welcome's round trip, between the stage written and the server's answer; the app's load reports the stage and settles it exactly once - merged on an acceptance, cleared otherwise - with no second Add and no `ACCEPTED AND NOT HELD`. It is the "app opened inside the round trip" variant of [the background Welcome reading](#hardware-reading-owed-user-one-background-welcome-on-the-mi-9t-2026-10-22). (b) Its change to the iOS background-send FFI (a `max_attempts` argument, its header declaration and its Objective-C caller) agrees when read but has never been compiled: CI builds iOS only from a release or a manual dispatch. Owed: one manual `ios.yml` dispatch on `main`, green, before the next stable - otherwise the release is its first compile.

**The native caches sealed at rest (2026-10-22, [mobile](frontend/mobile.md#the-native-caches-are-sealed-at-rest-and-kept-out-of-backups-2026-10-22)) - built and compiled for Android, the Swift and Objective-C++ halves compiled by CI alone.** Owed on BOTH the Mi 9T and the iPhone, on an UPGRADE over a build that left plaintext files: (a) the first launch logs the key created (`NativeCacheKey: ensure: created` / `[CanariIOS] nativeCacheKey: created`) and the legacy pass (`[NATIVE_CACHE] ... now sealed`); (b) a DM and a salon message pushed with the app KILLED still show their text in the banner; (c) `graine_seeds.json` and `fcm_message_cache.ndjson` start with `CNSEAL1` / `cs1:` (`run-as` on Android, `bench_native_store list` on the iPhone) and the next start injects the cached message; (d) on the iPhone, `graine_seeds.json` and `fcm_message_cache.ndjson` read `isExcludedFromBackup` after a fresh write, in the data directory and in the App Group, while `mls.bin` and `push_context.json` do NOT. **And one rig change**: `phone.mjs graineMirrorSessions` now answers a sealed Android mirror with an error, so NOTIF-20's mirror count needs the app to answer through `bench_native_store` on Android as the iPhone rig already does.

**READ 2026-10-22 on the Mi 9T: `v1.4.0-alpha.1` (SIDELOADED, what it covers).** Artefact: the release
asset `app-universal-release.apk` of the tag (versionName `1.4.0`, versionCode `100400001`, signed by
the association's release key, SHA-256 prefix `e25c0e9f89ccb2f5`), installed with `adb install` after
uninstalling Play's 1.3.1 (a bench phone, a new device, `installerPackageName` null). **A sideload
proves the CODE, not the Play-signed path**: Play serves 1.4.0 on the `internal` track only, and that
phone's Google account got 1.3.1 from the listing (not an internal tester; the opt-in is a human click).
Read: the build talks to `https://dev.canari-emse.fr` (banner "Environnement de test"); sign-in held
(the phone browser's IdP session was still alive, so no credential was typed) and the PIN gate passed; feed, calendar, forms, shop, notifications,
settings and dashboard all open; the comments sheet (#2207) opens full screen (present within the 2.5 s the probe
waited, not a latency measurement) with the box pinned above the keyboard, and closes; 299 log lines for the app's process, 0 console warnings or
errors, 0 `FATAL`/`ANR`/`SIGABRT`. **NOT read:** a DM and a community open (the bench owner has no
conversation and no community on dev, and nothing was created there), the live features (dev-only
behind their kill switches), share-in/out, push (a dev push cannot be read), the feed left-edge and
tab-swipe gestures (no touch input was driven).

**SECOND PASS, same day: the gestures are read on the Mi 9T, the iPhone is blocked at its PIN gate.**
- **Gestures, driven as real touch with `adb shell input swipe` on the `/posts` feed, each from a fresh
  feed (7 variants, 7 outcomes as designed):** a swipe to the right opens `/camera` from the left edge
  at 200 ms and at 900 ms, over 730 px and 300 px, and from mid-screen at 1200 ms (never Back); a swipe
  to the left goes to `/communities` at 900 ms from the right edge band, at 1200 ms and at 200 ms. One
  earlier 900 ms edge swipe, first batch, did NOTHING (1 of 2 identical trials: the second batch ran it
  again and it opened the camera): not reproduced, not explained.
- **The iPhone 12 carries a TestFlight build** (signer `TestFlight Beta Distribution`, `aps-environment`
  production): it held 1.3.1 (100300105), TestFlight served `1.4.0 (100400001)`, and an in-place update
  (data kept, the same device) installed it. **It is now 1.4.0, still behind the encryption PIN gate,
  and NOT READ**: the `owner` bench account's PIN was refused ("PIN incorrect : ce PIN ne correspond
  pas a celui enregistre pour ce compte") on one or two attempts, so the account enrolled on that
  phone is not `owner` or its PIN differs. The accounts file maps no device to an account
  (`ownerByDevice()` is empty) and a TestFlight build has no inspector bridge. The other bench PINs
  were NOT tried: an automated session's attempt to type a second account's PIN was refused by its
  permission layer, and the wrong-PIN policy is documented only for the web client (PIN-2: five wrong
  PINs, no lockout a correct one cannot clear, `mls.bin` untouched), not measured on the iPhone.
- **The dev DM reading is blocked for the same reason.** Chrome w2's dev origin holds a saved session
  whose subject matches the bench account key `third` (not `peer`), and its PIN gate refused the `peer`
  PIN once. Nothing was created on dev. **OWED TO THE USER: say which bench account the iPhone and the
  w2 profile hold on dev (the file wants a `clients` list per account, which today says nothing for
  them), or type the PIN once on the phone yourself.**

| What | The measurement that closes it |
| --- | --- |
| the checkpoint every commit awaits under the MLS lock before its first request (`checkpointStageBeforeSend`, the leaf-refresh PR #2269): ~1.4-2 s per commit on a Mi 9T DEBUG capture, a burst of N commits ~2N checkpoints ([mls-protocol](protocols/mls-protocol.md#the-periodic-leaf-refresh)) | in the pre-release carrying #2269, on a RELEASE build on the Mi 9T AND the iPhone 12: the `[COMMIT]` stage-checkpoint duration of one commit (a leaf refresh or an invite), and of a burst (a group creation adding several devices), read from the device log; the rig rows LEAF-REFRESH-1..4 ([cross-client-testing](cross-client-testing.md)) on the same build |
| the organiser alert for a payment over capacity (#2228, D3; owed only once `FORM_ORGANISER_ALERT_ENABLED` is `true`) | first the client floor: `minClientVersion` at or above the version carrying #2228 on both estates, both stores serving it; then on the Mi 9T AND the iPhone 12, one payment landing on a full form on dev: the push arrives with the title only, a tap (app killed AND backgrounded) opens `/forms` with that form's responses accordion open and in view, and the bell row reads the alert sentence ([forms](frontend/modules/forms.md#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off)) |
| a video filmed with the new-post composer's camera is a CanaReel, with a deletion notice and "Garder comme post" (user, 2026-10-19: one camera, one behaviour; component tests only) | check CR on the Mi 9T and the iPhone 12, next pre-release ([device-verification](device-verification.md#cr-the-composers-camera-films-a-canareel---owed-on-both-phones)) |
| calls lot 1 (#1997, #2010): 1:1 audio peer to peer on dev builds, never placed on a phone - BLOCKED 2026-10-18, no tag carries it ([bench readings](device-readings-calls-live-2026-10-18.md#1-calls---blocked-no-build-within-reach-carries-lot-1)) | after the next pre-release: a call PC <-> Mi 9T and Mi 9T <-> iPhone 12 on dev - setup time, the selected pair (direct or Cloudflare TURN), audio heard both ways, the ring on a throttled uplink, and a key mismatch on a build with #2013 |
| CALL-WIFI: a network blip no longer ends a 1:1 call - the signalling seat is resumed and the initiator restarts ICE (2026-10-19, fake-socket and real-binary tests only, [calls](frontend/modules/calls.md#a-network-blip-does-not-end-the-call-call-wifi-2026-10-19)) | on a pre-release carrying it, both bench phones: CALL-L1 steps 8-10 - Wi-Fi off on the Mi 9T for 6 s and 14 s mid-call, the call survives with audio back both ways; 90 s ends it ([device-verification](device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both)) |
| the LEFT edge is excluded from the Android back gesture on every tab root with a section to its left (feed, communities, chats, dashboard; widened by the owner 2026-10-24 from the feed alone - read cells (2), (3) and (6) on `/communities`, `/chat` and `/dashboard` too, and (6) with a phone conversation open: Back must still close it) so the swipe started in the left 30 CSS px changes section (owner decision 2026-10-21; Kotlin and unit tests only, `MainActivity` compiled by no PR gate, [mobile](frontend/mobile.md#the-left-edge-back-gesture-is-excluded-over-every-tab-root-with-a-section-to-its-left-2026-10-21-widened-2026-10-24)) | on the Mi 9T, next pre-release, gesture navigation: (1) logcat `gesture exclusion: spans={LEFT=...} -> [ExclusionBand(left=0, ...)]` and the same rect in `dumpsys window`; (2) on `/posts`, swipes from x = 20, 50 and 60 physical px at y = 1300 AND at the band's top and bottom rows open the camera, 0 Back; (3) just above and just below the band the left-edge Back still works; (4) the right edge is intact: a reply swipe on an own bubble at x >= 406 CSS px still replies, keyboard closed and open; (5) after a reload (MLS recovery) then `/posts`, both edges' Back behave as specified; (6) leaving the feed clears the band (`/posts/<id>`, `/chat`, `/communities`, `/camera`: left-edge Back works), as do the keyboard up, a rotation and a resume; (7) with an overlay over the feed (reel viewer, media viewer, a modal, the composer's camera) a mid-screen left-edge Back closes it; (8) 3-button navigation: no rect, empty list in the log; (9) back-sensitivity slider at max: the band widens with the inset and still covers the start. Note the dead zone: a start on a horizontal chip strip inside the band does nothing (`shouldIgnoreSwipeTarget`), by design. Recipe: `<harness-dir>/a1-bench/camera-swipe-r1021/`, `gen1.mjs` straight cells |
| a reply swipe along a thumb's arc (45-70 px of vertical drift) replies once the bubble shows armed (2026-10-14; 0 of 14 before, unit and component tests since) | on the Mi 9T, next pre-release: the class-A cells of the matrix (`<harness-dir>/swipe-reply-r1014/`), 110 px across with 45 and 60 px drift, own and received; on the iPhone 12, the same arc by finger, its swipe never having been read on WebKit ([design-reference](frontend/design-reference.md#the-reply-swipe-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-14)) |
| an Android relaunch (navigation-mode switch, WebView update) destroys the old WebView, so its Web Locks no longer withhold refused salon texts (2026-10-14; compiled and source-gated, never run) | on the Mi 9T, next pre-release: switch the navigation mode twice, CDP lists ONE page, a salon text refused before the switch comes back to its composer; restore gestural ([mobile](frontend/mobile.md#a-relaunched-activity-left-its-webview-alive-and-the-orphan-kept-its-web-locks-2026-10-14)) |
| a post push tapped with the session dead lands on `/login?returnTo=` the post (2026-10-09) | check H step 4 on the Mi 9T, killed app AND backgrounded ([device-verification](device-verification.md#h-deep-link-from-an-os-notification-tap---re-opened-on-android)); a bare `/login` with no `[hooks] Processing URL` means the intent never reached the JS |
| after an edge swipe the next scroll is swallowed (Mi 9T, 2026-10-05; NOT a code defect anyone has seen: the page never holds the touch) | check X, ONE real-finger scroll on the Mi 9T with the `[swipeBack]` lines now logged ([device-verification](device-verification.md#x-the-scroll-after-an-edge-swipe---owed-on-the-mi-9t)) |
| NOTIF-10: a refused push after real banners leaves no generic line (2026-10-09, `GenericBannerLedger` unclaimed notes; JVM-tested, the service's two cancel hooks NOT compiled from here) | `bun archive/notif.mjs 10` on the Mi 9T against a build carrying it: five messages with the push channel cut, then the radios back; the shade ends with the summary and the real banners, NO `Nouveau message de ...` ([mobile](frontend/mobile.md), board row [NOTIF-10](cross-client-testing-archive-1-4-0.md#14---notif---notifications)) |
| the composer stands still while the keyboard rises (2026-10-09, Android double report and iOS stale inset, unit-proven only) | the Mi 9T half PASSED on 2026-10-13 (869.5 -> 524 in one frame, 5 of 5, [check W](device-verification.md#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones)); owed: the iPhone, on a build newer than `1.2.3-alpha.5`. **iPhone 12, 2026-10-11: no 465 plateau any more, but a NEW defect, 3 of 3 rises**: the native "+" twin jumps to 487 pt at once while the web layer is drawn a keyboard height lower and slides up over ~250 ms, so the web composer is hidden and the "+" floats alone (an OPEN P3, cause not looked at) |
| a blind salon banner draws no author, no mention and no mention route, and a held mention's redraw does not sound twice (2026-10-22; Android JVM-tested and source-pinned, NOTHING native compiled or run here, the NSE XCTest not wired) | next pre-release, app killed, a salon mention of the reader: on the Mi 9T with the seed held back, one generic banner on `canari_messages` with the salon's initials and no "mentioned you", then the redraw with the author and the mention, ONE sound in all (`reposted silent` in logcat); the same with the blind banner swiped away before the seed (`existing=false`, still one sound); and how MIUI treats a silent group child; on the iPhone 12 the blind banner plays the message trill, not the mention one. iOS never redraws, so a blind mention stays an ordinary banner for good ([channel-encryption](protocols/channel-encryption.md#215-the-native-readers-wp-g2-4b)) |
| a salon carries read receipts (#1235, `v0.18.32`) | `READ-6` on the rig, then one look in a real community: a member who is not an admin sees the double check and "Lu par" under their own last message ([social-service](services/social-service.md#read-receipts-in-a-salon)) |
| a salon's settings are offered only to who may change them (#1228, `v0.18.32`) | one look with a Membre account: the access tab reads only, rename and delete are absent; then grant `channel.manage` to Moderateur in the grid with a moderator's panel open - the controls must appear without a reload |
| every menu is a fixed segmented control or a hub of route sections (chantier CLOSED 2026-10-14) | one look on each phone: a hub, one section, Back and the Android hardware back, a reload on a section ([section-navigation](frontend/section-navigation.md#closed-2026-10-14---the-final-shape-do-not-reopen)) |
| `/forms/success` no longer asks for a form called `success` | after a completed payment on production, social-service logs no `invalid input syntax for type uuid: "success"` (once per payment, so ONE payment settles it) |
| the `apiFetch` fallback now names its cause | the next run's logs separate "a container is restarting" from "refresh is broken"; if one cause dominates, measure its RATE against the population before the name "transient" is believed |
| the `[PENDING]` line that called a routine race "Non-recoverable" | the next run reports it in `notable` from an ANCHORED rule; the two old spellings stay pinned until A1 runs a build emitting the new line (an APK embeds its frontend) |
| the forms responses table shows the answers (#884) | ONE browser pass on a form with real submissions: three answer columns at 1024px, a 200-character answer, the card layout below `sm` ([forms](frontend/modules/forms.md#the-responses-accordion-shows-the-answers-and-the-form-decides-its-own-layout-2026-09-20)); the local estate held 0 forms, so it needs a refreshed copy first |
| a push carries its ciphertext once, not twice | HARDWARE, both platforms, iOS the riskier half ([chat-delivery](services/chat-delivery.md#transport--single-gateway-fcm)) |
| a device with no push token now says so | after the next release a tokenless device either acquires one or prints `[PUSH_UNAVAILABLE]` naming a cause; silence with a tokenless device still in `key_package` means a FIFTH cause |
| the notification quick reply's 403 | HARDWARE: check K steps 1-5 and **K2** on A1, **with the window ARMED** ([check K](device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found)); the iOS twin is corrected identically and unproven |
| the login button that took a press and showed nothing | any cold `/login` press proves the reordering; NOT explained is the 2026-08-28 "no request" over thirty seconds (a version check running its ladder would have issued three): read the network tail of the next cold login |
| the last server-composed sentence asks the device which language it reads | after the next release `[PUSH_REGISTER]` prints `locale=fr` or `locale=en`, not `unstated`, for a device that has restarted once; the VISIBLE half needs an iPhone AND a failed NSE |
| a BLIND salon banner offers no "Marquer comme lu" (2026-10-14, JVM-tested, app compiled) | on the Mi 9T: a salon banner posted while its seed is missing (`[PUSH_BLIND] ... held=true` on chat-delivery) shows no action, and the same banner redrawn with its text shows it ([read-receipt-privacy](read-receipt-privacy.md)) |
| acknowledging a conversation from the notification shade (NOTIF-6b) | HARDWARE, both platforms: on A1 send from W1, background the app, tap **Marquer comme lu**, OPEN the app - the badge must be gone; then the same with a quick REPLY. `logcat` shows `sendReadWatermark: queued+drained at=<ms>` with the SENDER's instant, never near `now` |
| the row a push creates carries the GROUP's name | HARDWARE, both platforms, ONE case (a push placeholder), on an APK built from this tree ([check C](device-verification.md#c-the-row-a-push-creates-carries-the-groups-name---owed-on-both-platforms)) |
| WP-REGRANT-2, a re-granted member's re-join | COMM-22, four grant/revoke cycles green, and COMM-8 reading `seedAfterTheGrant: true`, never `repaired` |
| a security advisory now has an ACTOR (`automated-security-fixes`, 2026-09-02) | the first security pull request Dependabot itself opens, for ANY directory (alert 210 does not count: fixed by hand in #357) |
| the auto-merge ceiling refuses a major | the workflow logging `REFUSED` on a real major in its own run: read the `Dependency ceiling` log of a CURRENT open major |
| the release build no longer enables WebView debugging | HARDWARE, NOT the Mi 9T (its `userdebug` ROM makes every WebView inspectable): the `/proc/net/unix` probe on a `user`-build device ([check R](device-verification.md#r-the-shrunk-release-apk-actually-runs---owed-on-android)) |
| launch to fingerprint prompt on Android, 4.9 - 5.7 s on `v0.18.1` | HARDWARE, a build from this tree: `bun tools/cold-start/launch-trace.mjs --heartbeat`, the offset of `BiometricService/handleAuthenticate` ([tools/cold-start](../../tools/cold-start/README.md)). Target **under 1 s all-in** (user, 2026-09-15); the round trip left in front of the prompt is [below](#p3---a-revocation-round-trip-sits-in-front-of-the-fingerprint-prompt-and-moving-it-is-reverted-not-to-be-re-opened-measured-on-the-pixel-6a-2026-09-15) |
| the biometric cadence (every 12 h by default, or every time) | HARDWARE, a build from this tree. Android passes every cadence decision (Mi 9T, 2026-09-28); owed there: a real finger, the Settings radio, and step 5; all of iOS ([check U](device-verification.md#u-the-biometric-cadence-every-12-h-skips-the-sheet-every-time-keeps-it---owed-on-both-platforms)) |
| the Mi 9T pass D2 (#1281 a shade reply not re-announced, read watermark merged on resume) and D3 (#1282 the outbox worker) | HARDWARE, a build carrying them, then the Pixel: one `drainOutboxBackground` "sent id=" line per quick reply, with the app DEAD (a force-stopped app receives no push) and the shade reply typed by hand ([mobile](frontend/mobile.md)) |
| a notification shows the sender's face, not the app's bird | HARDWARE: one look on the Mi 9T, a DM and a group ([mobile](frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)) |
| the iOS launch logo (#1289 follow-up) | the iPhone 12: delete the app, RESTART the phone, reinstall, cold-launch - a logo means the launch-snapshot cache, nothing to fix ([app-icons](frontend/app-icons.md#launch-screens)) |
| an association document is never swept (#1292, in `v1.1.2`) | on production `/admin/storage` lists `association*` on its own line and no vault download answers 410 for a live document ([media-service](services/media-service.md#the-sweep-is-an-allowlist-an-associations-document-was-swept-2026-10-01)) |
| a tab open across a deploy offers a reload instead of "Erreur" (#1278, in `v1.1.2`) | a tab left open across the next deploy shows the reload offer on its next lazy import, and no `Failed to fetch dynamically imported module` reaches a user |
| the iOS rig adapter (#1284-#1286, #1290, #1291, #1303) | **NO board row has a verdict on the iPhone yet**: each row needs its mechanical port; O3 and O6-O11 change phone state (airplane mode, force quit, reboot, reinstall) and wait for a dedicated session; the Return key was never pressed; `pymobiledevice3` is on no PATH (the env var `PYMOBILEDEVICE3` points to it). Order: [cross-client-ios](cross-client-ios.md#what-is-owed) |
| the iOS push rows (O4, TAB-1, HEAL-NEW-5), **BLOCKED on a Firebase setting** | the development-signed bench build gets `[PUSH_SEND] FCM failed ... Invalid APNs credential` for sandbox tokens while production sends 366 `platform=ios` with 0 failures: the APNs key is missing in the DEVELOPMENT slot (the fix is INFERRED, not read; [the owed click](#owed-to-the-user---decisions-rotations-and-one-off-clicks)). After it, resend the test DM: success = `FCM sent ... platform=ios` plus an `apsd` line in the iPhone syslog. Blocked until then: O4, O11, O13, the NOTIF rows, MENTION-2/3, LIFE-2/3/5/8 |
| a withheld product releases itself when an association's payments become ready | an OBSERVATION: the next association to finish onboarding sees its products go on sale untouched (`activationWithheld`); four associations have no payment account, the BDE tier is off sale deliberately (user, 2026-09-17) |
| the identity label after an account switch and the PIN reset box (#1604) | ANSWERED for the same account on 2026-10-13: a skipped unlock on a key the live process still held, NOT the vault (a cold relaunch asked for the PIN, [readings](device-verification.md#the-bench-readings-of-2026-10-13---the-owed-rows-a-bench-phone-can-settle)). **Owed: the same sign-in as a DIFFERENT account on a live process** - if it also skips the unlock, the previous account's key is reused ([auth](frontend/modules/auth.md#two-iphone-12-findings-of-2026-10-07-a-name-saved-for-the-previous-account-and-a-reset-button-under-the-footer)) |
| the reaction-failure toast (#1536) on the iPhone | the send path and the per-conversation reply context PASSED on 2026-10-13 in the gamma-delta DM and the `Bench126` salon ([readings](device-verification.md#the-bench-readings-of-2026-10-13---the-owed-rows-a-bench-phone-can-settle)); owed: a reaction the server refuses, read on the iPhone |
| the iPhone camera letterbox fix (#1370, shipped UNVERIFIED by the user's choice) | the FRONT lens passed 22 opens with two home-and-returns on 2026-10-11 ([inventory](device-verification.md#the-iphone-12-owed-readings-inventory-2026-10-11)); owed: the REAR lens, phone held up (lying flat, its frame is black) |
| "Seen by" heads in groups and salons (#1401) | one look in a group and a salon with four or more readers: each head under the last message its owner read, `+N` past three |
| the signed calendar subscription's 503 path (#1551) | the signer cannot be stopped without touching the stack: only the 200 path was read on a phone |
| the audiences chantier (#1582, #1584, #1606, #1608) | one look at `/admin/read-access` signed in; the Audience tab of an association read by a BDE star; a global admin's phone reading of the institution creation flow; the institution creation form and the Audience tab's "Custom" grid (`CellPicker`) read on a phone with a real global-admin account (read at 390 and 1280 on the local estate with the sandbox admin only) |

---

## Owed to the USER - decisions, rotations and one-off clicks

**This section holds NO substance.** Every line points at the entry that carries it, and exists only
so that "what is waiting on me" is one list rather than a sweep of the file (user, 2026-09-02:
*"Fais moi une liste des choses qu'il me reste a faire"*). Delete a line when its target entry ships
or its click is made. A line here is a thing NO agent can do - a decision, a credential somebody
else holds, a console owned by the user, or hardware that does not exist.

| What | Kind | Where the substance is |
| --- | --- | --- |
| **optional: count `LEGACY_CONTENT_PATH` in the 30-day chat-delivery deploy-log archive** (`zgrep -c` over the production project's archived chat-delivery logs, in the runner account's home). A confirmation of a removal already made on other evidence, not a blocker | 1 command | [legacy-compatibility](legacy-compatibility.md#removed-2026-10-22---the-pre-mls-send-path-the-content-column-and-its-read-arm-wait-for-a-migration) |
| **open dev's calls once after the deploy that carries migration 014** (B12): `/admin/platform`, `Audio et video` - the migration lands `off` on an existing database. (The TURN meter's four secrets EXIST since 2026-10-21, Account Analytics read only.) | 1 click | [calls](frontend/modules/calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21) |
| **write the terms' lives paragraph and the filtering statement for the store review** (strike policy, retention, the 24 h commitment and the reactions are decided, 2026-10-20) | 1 text, 1 statement | [live moderation](#p1---live-moderation-wp-l8-the-server-half-is-built-the-client-half-is-built-the-decisions-of-2026-10-20-are-taken-and-their-server-work-is-owed-2026-10-19) |
| **send the DPO dossier to the school's DPO** and bring back the answers to its three questions (the school's role, the hosting agreement with the DSI, the MiGallery DPIA); MiTV keeps the proof of each member's face-recognition consent | 1 e-mail, 1 conversation | [the GDPR entry](#p2---gdpr-compliance-the-open-items-of-the-register-2026-10-16), [dso-dossier](compliance/dso-dossier.md) |
| **wipe the real-data copy dev still holds, once the fictional seed has merged and a pre-release has moved `dev-deployed`, and BEFORE the next stable - that stable ships the privacy page and dev banner saying dev holds no production data, which is false until this wipe has run and verified** (owner, 2026-10-16, GDPR): run `scheduled.yml` `job=dev-reset` with `dry_run=true`, then `false`; delete any leftover copy dump (`/tmp/canari-copy.*`) and the copy-era dev log archives on the host; grant your own dev row `admin` after signing in. A production-estate write, the owner's | 1 dispatch, 1 ssh session | [dev-environment](infrastructure/dev-environment.md#3-the-data-a-fictional-seed-and-nothing-from-production-owner-2026-10-16) |
| **when to raise `minClientVersion` to the build that ships "a Remove holds against a later re-add"** - until then an answering member on an older build still sends a re-admitted member's window | decision | [the re-admitted window entry](#p2---a-re-admitted-device-calls-its-own-exclusion-window-a-loss-and-reconciles-for-it-2026-08-26-widened-2026-08-30) |
| **raise the body limit (`client_max_body_size`, request buffering off) on the PRODUCTION legacy-name relay**, then reload it (re-measured 2026-10-21 with unauthenticated uploads: 1.2 MB and 7 MB reach the app (401) on `canari.emse.fr` and `dev.canari-emse.fr`, so the DEV relay is lifted; `canari-emse.fr` still answers 413, which only clients older than v0.18.24 reach. A body of 15 MB or more is refused 403 by the shared host's own filter on BOTH names, 10 MB passes - the app sends under 8 MiB per request, so it never reaches that ceiling, which is why the criterion below is 7 MB and not 20. The 413 is the relay's nginx default, NOT Cloudflare, whose body limit is 100 MB; the app already sends under 8 MiB per request since #1706/#1708/#1710 and chunking under 1 MiB is not an option). Done when a 1.2 MB and a 7 MB upload reach `media-service` on `canari-emse.fr`. The exact files and commands are kept privately | 1 ssh gesture, 2 lines | [cloudflare-edge](infrastructure/cloudflare-edge.md#a-request-body-over-1-mib-is-refused-with-a-413-on-the-legacy-names---it-is-the-relays-nginx-not-cloudflare-measured-2026-10-07-cause-found-2026-10-09) |
| **upload the APNs authentication key in the DEVELOPMENT slot of Firebase** (2 minutes): Firebase Console > Project settings > Cloud Messaging > the iOS app `fr.emse.canari` > APNs authentication key - the same `.p8` (Key ID + Team ID) already in the Production slot. The agent then resends the test DM | click | [the iOS push rows](#owed-a-verification-and-nothing-else) |
| **Lydia's three still-open Livrable A answers** - the KYC document list (channel confirmed: email, not yet arrived), the minimum payable amount, and rate limits/webhook-sandbox testing | blocked upstream | WP-LYDIA-1 |
| **the dev mobile half: a Firebase project for `dev.canari-emse.fr` and a dev keystore, plus where that keystore is backed up.** No agent can create the project with the credentials it holds. Until then a pre-release APK points at dev with production's FCM sender | 1 console visit, 1 decision | [the second package id](#p3---a-second-package-id-so-a-pre-release-can-be-measured-against-production-decided-2026-09-15) |
| **create the new Cloudflare tunnel on the `rootz-emse.fr` zone** (outside the project token's scope). (verify: phase 1 completed for all three estates on 2026-09-24 without it - whether this tunnel is still wanted at all) | 1 dashboard gesture | [estate-migration](infrastructure/estate-migration.md#8-what-is-owed-by-the-user) |
| **the spaces release order (WP6b), three gestures in THIS order**: (1) go for the WP3 profile backfill on production once 6a/6d's release ran migration 071 (`backfill-canari-profiles.sh apply`); (2) set every association's real reach and the BDEs at `/admin/spaces` - the seed gave all of them (ICM, saint-etienne) only; (3) only then cut the release carrying 6b. Out of order, ISMIN/Gardanne/FSSS/Autre readers see no existing association post, and anyone not backfilled loses the feed | 1 go, 1 grid, 1 release | [profiles-and-access](profiles-and-access.md), "WP6b as built" |
| **ask a co-tenant of the shared host whether a leftover runner workspace may go** - somebody else's archive; nothing runs from it | 1 conversation | [estate-migration](infrastructure/estate-migration.md#the-host-was-emptied-before-the-move---2026-09-24-and-it-is-done) |
| **decide whether the host-update report gets a runner key on the old VMs** (your own; without it they are unreported) | 1 decision | [the P2](#p2---two-of-the-hosts-that-take-security-updates-are-not-reported-on-and-a-library-nothing-restarts-the-rest-closed-2026-09-03) |
| **confirm whether to decommission the two older project-team VMs** (out of scope and unused) | 1 decision | [estate-migration](infrastructure/estate-migration.md#two-older-project-team-virtual-machines-are-out-of-scope-decided-2026-10-18) |
| **turn off JavaScript detections on the `canari-emse.fr` zone** (Security > Bots): its injected inline script is refused by the page policy on every dev document, one console error per load; production is not behind Cloudflare. Done when a dev document's console holds no CSP refusal, and the rig's `DEV_EDGE_CSP_EXCEPTION` can go | 1 dashboard toggle | [cloudflare-edge](infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22) |
| **set the `DEV_FIREBASE_SERVICE_ACCOUNT_JSON` secret** (environment `development`; today only the repository-level production `FIREBASE_SERVICE_ACCOUNT_JSON` exists): without it dev sends no push and T1, the push-to-banner latency, cannot be measured | 1 secret | [the notification latency P2](#p2---a-notification-tap-takes-27-s-to-a-usable-conversation-when-killed-5-s-behind-the-pin-measured-2026-10-11) |
| **send the DSI the log-retention request** (the host's logs and security tooling: each kept 90 days at most, as the privacy policy promises) - the text is ready, in French | 1 e-mail | [dsi-log-retention-request](infrastructure/dsi-log-retention-request.md) |
| **decide whether a container whose live log is past 60 days is RECREATED unattended** by the daily `log-retention` job (today it only goes red and a human recreates it); it is a production restart, of postgres and redis included | 1 decision | [logging](infrastructure/logging.md#the-90-day-ceiling-2026-10-16) |
| **set production's `minClientVersion`, and the web rollback floor, to the release tag carrying the hardened v2 reader (#2074)** once it is a stable - the condition the separate writer flip waits on | 1 setting, 1 decision | [the P2](#p2---the-web-checkpoint-is-82--wasm-chacha20-seal---built-writer-off-draft-pr-2026-10-12) |
| **EMSE Finance's roster** - its bureau fills it in (the Carte de la vie asso editor names it meanwhile) | 1 conversation | [below](#the-carte-de-la-vie-asso-chantier---audited-2026-09-27-every-decision-taken-ready-to-build) |
| **set `posts=["ME"]` in Authentik for the staff accounts labelled EMSE that are ME** (two school-staff accounts), from the table Master hands over | 2 attributes | [profiles-and-access](profiles-and-access.md) |
| **set the `DEV_KLIPY_API_KEY` secret** (environment `development`, the same KLIPY key is fine - KLIPY moves no money and believes nothing about production): since the GIF search moved to the server, dev without it answers "GIF search is not configured" | 1 click | [the GIF entry](#p2---a-gif-sent-in-a-chat-is-loaded-by-every-recipient-from-klipys-cdn-found-2026-10-16-gdpr-review) |
| **fill the Play Console "Foreground service permissions" declaration for `FOREGROUND_SERVICE_MICROPHONE`** (App content; in-app 1:1 calls, a description and a video of the call kept while the app is backgrounded). EXPECT the first pre-release carrying WP-C-BG-A to be refused at the `internal` upload until this form is filled - Play may refuse a bundle declaring an undeclared foreground-service permission on any track; not verified on this console. The GitHub release APK is built either way. Filled BEFORE that pre-release, the refusal never happens. Pre-release builds declare it, stables do not (`android.yml` checks) | 1 console form + a video | [calls](frontend/modules/calls.md#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20) |
| **decide whether the feed's LEFT edge gets a gesture exclusion rect** (a swipe to the camera started in the left 30 CSS px is Android's Back: the previous page, or the app closes), like the right edge over a conversation - or nothing | 1 decision | [the tab swipe P2](#p2---the-tab-swipe-is-lost-on-a-slow-start-the-12-px-lock-sits-past-chromes-8-dp-slop-mi-9t-2026-10-21) |
| **review the calls privacy wording (#2013's `/legal/privacy` and register texts: each party sees the other's IP, Cloudflare relays some calls) before calls ship** - presented to you later, decided 2026-10-21 | 1 review | [calls](frontend/modules/calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21) (B5) |
| **decide whether to ROTATE the KLIPY key**: it shipped in every web and native bundle as `VITE_KLIPY_KEY` until 2026-10-16, so it is public; rotating it also ends GIF search on native builds installed before the change, which still call KLIPY directly | 1 decision | [the GIF entry](#p2---a-gif-sent-in-a-chat-is-loaded-by-every-recipient-from-klipys-cdn-found-2026-10-16-gdpr-review) |
| **decide the camera swipe's cause B: a swipe starting in Android's left edge (30 CSS px) is a system Back - add a gesture exclusion rect on the feed's left edge, as was done for the conversations' right edge?** (investigation: PR #2177) | 1 decision | [the right-edge entry](#android-back-gesture-zone-on-the-right-edge-own-bubbles---decided-by-the-user-2026-10-14-draft-pr-in-progress) |
| **decide whether ruleset `22152902` gets a `code_scanning` rule (CodeQL, errors, high or higher)** - analysed, recommended, the exact `gh api` PUT written, not applied | 1 decision, 1 command | [cicd](cicd.md#a-code_scanning-rule-on-the-ruleset-analysed-2026-10-23-not-applied) |

## The Carte de la Vie Asso chantier - audited 2026-09-27, every decision taken, ready to build

**BUILT AND SHIPPED** (#1143-#1149, migration 064, `v0.18.28`). The eighteen decisions, the audit and
every mechanism are on
[carte-vie-asso](carte-vie-asso.md#the-2026-09-27-audit---how-it-was-measured-and-the-eighteen-decisions-it-produced).
**Still owed, and nothing else:** one A0 export from the production editor, timed, with its memory and
PDF size, re-reading the text sizes the way the audit did (D8's cost; D11 wanted it before the stable,
the stable went first); then the user's look at that export (D11); and EMSE Finance's roster (the
USER's, above).

## The composer and CanaReels chantier - compared on the Mi 9T 2026-09-29, every decision taken

**BUILT AND SHIPPED in `v0.18.32` (R1) and `v1.0.0`-`v1.0.2` (R2, R3).** The comparison, the ten
decisions (C1-C10) and the build order are on
[reels](frontend/modules/reels.md#the-chantier-the-comparison-the-ten-decisions-the-build-order-user-2026-09-29);
the editor is [reel-editor](frontend/modules/reel-editor.md). **Owed, readings only:**
- the user's own look at the R1 composer on the Mi 9T;
- one real-content take on each phone, the iOS frame timing of the viewer swipe (the Mi 9T measured
  11.5 % janky frames), and the user's ruling on the publish note;
- a reading of the whole editor (text, drawing, stickers, "Suivant") on both phones, then the user's
  Instagram screenshots for E3/E5 ([reel-editor](frontend/modules/reel-editor.md));
- the front-lens default and full-bleed preview on the iPhone, and the live-mic echo fix (#1368);
- R4 (live, C9) no longer waits for the calls revival (user, 2026-10-19: lives first, [live](frontend/modules/live.md#decisions-of-2026-10-19)).

## The Liquid Glass conversation chrome - decided 2026-09-30, WP-G1 then WP-G2

Decisions L1-L4 (the three-piece glass header, the "+" that grows, phone apps only) and both halves,
shipped in `v0.18.32` (#1251, #1254), are on
[chat](frontend/modules/chat.md#the-conversations-chrome-in-the-phone-apps---glass-floating-over-the-thread-2026-09-30)
and [mobile](frontend/mobile.md#the-conversations-native-glass-chrome). The alignment, "+" > Photos and
the four accessible names PASSED on the iPhone 12 on 2026-10-11; **the keyboard FAILS in a new shape**
(the web layer lags the native "+" by ~250 ms on every rise, [check W](device-verification.md#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones)).

## The MiConnect profile reform - decided 2026-09-29, the technical plan is next

Thirty-two decisions and the eleven-package plan (validated 2026-09-29) are on
[profiles-and-access](profiles-and-access.md), the only copy. State: WP0, WPA and WP1 LIVE on
production; WP4 (4a, 4b #1471) and WP6a/6b (#1384, #1389) and the audiences work are on main; **WP5 is
next**. WP6b's release order is forced: see the owed-to-the-user table above.

## Asked by the USER on 2026-10-05 - one request, not built

**Reply and mark-as-read from a salon notification** - Android MARK AS READ is built (a PushSecret call to the salon's read receipt, [mobile](frontend/mobile.md#a-salon-mark-as-read-only-and-why-reply-is-not-offered-decided-2026-10-10-android)); owed one tap on the Mi 9T against a pushing estate. **Not built:** Android Reply on a salon (needs a native Graine sealing path plus a PushSecret send route, a package of its own) and BOTH iOS actions (no gate here runs them; owed a hand on an iPhone for a DM, a group and a salon).

## Asked by the USER on 2026-10-09 - CanaReels in a conversation, a design study, not built

**An ephemeral video message filmed in the chat (DMs, groups, salons), E2E, 30 days, like Snapchat** - not a link to a published reel. Study, model, 12 work packages (RC-0 to RC-11) and 11 decisions owed: [reels-in-chat](frontend/modules/reels-in-chat.md). RC-0 (measure a 90 s take, the salon media-access rule) comes first; the upload and outbox half waits on the weak-network PR.

## P2 - A GIF sent in a chat is loaded by every recipient from KLIPY's CDN (found 2026-10-16, GDPR review)

**BUILT 2026-10-18, NOT SHIPPED.** The search goes through Canari since 2026-10-16; the GIF relay
(`GET /api/mls/gifs/media`: KLIPY's CDN only, no query, 12 MiB measured, streamed, byte cache,
single-flight, 16 in flight, 600/min per address, a day-long ticket) now carries the three paths that still reached `static.klipy.com` - every recipient's GIF,
the searcher's thumbnails, a comment GIF's bytes. A GIF from any other host still loads directly
(owner decision: no regression), so a reader of a pasted giphy/tenor GIF still reaches that host,
unmeasured; routing them is one line in `proxiedGifUrl`. Mechanism and decisions:
[chat](frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18).
**Owed, and it closes this entry:** a network trace on dev after the alpha (zero request to
`static.klipy.com` from the browser across a GIF bubble, a quoted GIF, the picker and a comment
attach), the same look on the Mi 9T and the iPhone, and the server log after a day
(`[GIF_MEDIA]` refusals by reason, cache hits). **Owner's call:** drop `static.klipy.com` from
`connect-src` once no tab runs an older bundle.

**Measured 2026-10-18 (PK9), the relay's ceiling comes from it:** 144 GIFs (trending plus 5
searches), `HEAD` content-length.

| Rendition | p50 | p90 | max | Over 3 MiB |
| --- | --- | --- | --- | --- |
| `sm` | 0.36 MB | 0.88 MB | 2.9 MB | 0 of 144 |
| `md` | 1.1 MB | 4.4 MB | 11.7 MB | 29 of 144 (20%) |
| `hd` | 1.8 MB | 7.9 MB | 19.9 MB | 48 of 144 |

## P1 - Opening a community: F1-F7 BUILT, the 200 ms budget is what is left (user, 2026-10-14; state re-read 2026-10-22)

**User goal: on a slow network and a poor phone, opening a community is almost instantaneous.** Budget: rail + salons and a salon opened before **<= 200 ms from local state, with 0 request on the path**. F1 (saved workspace list), F2, F3, F4 (a salon's last page kept locally), F5, F6 and F7 (one engine call for a page's signatures, 2026-10-22, native: a lead review) are built; the tab is 2-4x faster and works offline, but still short of 200 ms (first mount cut, see the page). **Left:** a re-measure against the budget on the Mi 9T (F7's gain included, from the next pre-release), a CPU profile of the warm resume at 4x, the history head/body split, iOS. State and numbers: [community-open-budget](frontend/community-open-budget.md). Instrument: `bun tools/cold-start/community-open.mjs`.

## P2 - A withdrawn or wiped chat reel can leak its upload session for 24 h (owed BEFORE `CHAT_REEL_WRITER_ENABLED`)

Found in the review of #2117 (RC-5, 2026-10-19), not built. The withdrawal of a queued chat reel releases its resumable session with a best-effort `DELETE`. **Three paths still leak it** to media-service's 24 h sweep:
- a cancel made offline - the weak link the reel was stuck on - logs `NOT released`;
- a sign-out and an account erasure wipe the outbox without a `DELETE`;
- an account deletion does the same.

Each leaked session holds, for 24 h, one of the owner's 4 open sessions, up to 256 MiB of staging and its share of the daily `chat-reel` budget, so four of them in a day answer the member 429. Nothing reaches users while the writer switch is off; **this must be built before it is flipped**.

**Fix, decided shape:** a durable "to release" mark, swept at the next start and after each sign-in:
- **What the mark holds:** the session ids and the owner id, NO key, encrypted under the device key, in a store that outlives the per-account outbox wipe.
- **When it is written:** by the withdrawal before its `DELETE`, and by the sign-out/erasure path BEFORE it wipes the outbox. Neither may lose a mark silently.
- **When it is removed:** an entry goes only once its `DELETE` answered (2xx, or the 404/409 that says the session is already gone or completed). An erased account's marks are swept under that account's token, then dropped.
- **Privacy:** ids only. A session id names staged ciphertext the owner can already address and nothing else, and the server checks the owner on every route.
- **Proof:** an outbox test that cancels offline, relaunches online and sees the `DELETE`, plus one per wipe path.

The mechanism and the gap are written up in [reels-in-chat](frontend/modules/reels-in-chat.md#14-what-the-resumable-outbox-rc-5-built-and-what-it-owes-on-devices-2026-10-19). Not built in #2117 because it is not small: it touches the sign-out and erasure wipe paths, needs a store that survives them, and adds a sweep to sign-in.

## P3 - Two call-resume edges the second review of #2148 found, recorded and not built (2026-10-20)

- **F6 - the POLITE side's own pending offer, lost with a dead socket, is never rolled back.** Only the initiator rolls back an unanswered offer on a resume (`restartIfMediaDidNotSurvive` checks `have-local-offer` on the initiator alone). A polite side that had renegotiated (a track added) and lost that offer stays in `have-local-offer`; the initiator's next restart offer then collides and the polite side wins by an implicit rollback - so it heals, but by the collision path, not by design. Fix when a polite-side renegotiation ships (none does today: audio only).
- **F7 - a resume whose `Joined` and `PeerReady { resumed }` straddle an ICE `failed` charges TWO restart units.** ICE `failed` between the two frames restarts on the OLD pairing (offer charged, then lost when `PeerReady` opens a new pairing), and the resume restarts again. Bounded (the budget still ends it) and refunded on packet evidence once audio flows; the cost is one unit of three. Fix: defer an ICE-triggered restart while a resume is joined but not yet paired.

Mechanism of both: [calls](frontend/modules/calls.md#what-the-131-alpha2-bench-reading-found-2026-10-19-and-the-fix). Delete each with its fix.

## P3 - CALL-PATH-LINE: the `selected path ... relayed=` line over-counts relayed calls (2026-10-20, not built)

The client's path line ([calls](frontend/modules/calls.md); a diagnostic since 2026-10-21 - the TURN budget reads Cloudflare's meter, never this line) is written ONCE, at `connected`; ICE may move to a better pair afterwards. Bench P1 logged `relayed=yes` on both ends while `getStats` read `host/udp -> host/udp` at the end ([readings](device-readings-2026-10.md)). Fix: log the pair again when the selected pair changes (or at hang-up), so the last line names the path the call ended on. Delete with its fix.

## P1 - CALL-WS-V6 is fixed on a branch and owed ONE phone reading (2026-10-20)

The native chat socket now races IPv6 and IPv4 and closes a connect it abandoned ([mobile](frontend/mobile.md#the-native-socket-races-ipv6-and-ipv4)). Owed on the Mi 9T, on the alpha that carries it: the PC's mobile hotspot with broken IPv6 (bench P6), `Connected to Chat Gateway` within a second, one `[WS-NET] ... while the preferred address was still pending` INFO line per connect in `logcat` (a WARN `... the preferred address FAILED` instead means the IPv6 attempt errored rather than hung - record which), no `[WS] native socket completed ... closing it` WARN, and the iPhone's call RINGING the phone; back on the bench Wi-Fi, no `[WS-NET]` line above debug. Delete with that reading.

## P3 - Two vendored forks are not on the upstream-release watch (2026-10-21, a decision owed)

Job `vendored-upstream` of `scheduled.yml` now reports an upstream `tauri-plugin-websocket` release past the fork ([cicd](cicd.md#a-vendored-fork-is-watched-for-upstream-releases-2026-10-21)); its allowlist holds that one crate, because the row that asked for it named one. `tauri-plugin-keystore` (forked from `2.1.0-alpha.1`, a PRE-release the watch has no rule for) and `tauri-plugin-system-components` (`=0.1.8`) are patched the same way and equally unwatched. Decision owed: add `system-components` (one line), and say what "newer" means for a fork of an alpha. Delete when both are decided.

## P3 - The call resume ladder has no jitter (review of #2148, 2026-10-19, not built)

`CallService`'s signalling resume retries at fixed moments (1, 2, 4, 4, 4... s, `cappedReconnectDelayMs`), so two clients that lost the same Wi-Fi at the same instant reconnect in lockstep - harmless at two phones, a burst on `call-service` once many share a network. Jitter must not become a clock that decides anything: it spreads WHEN an attempt starts, the budget stays a count. Mechanism: [calls](frontend/modules/calls.md#what-the-131-alpha2-bench-reading-found-2026-10-19-and-the-fix). Delete this item when jitter ships or the burst is measured as irrelevant.

## P2 - The deploy's rolling replace: two POSTs answered 502 across a release, cause not settled (CI, 2026-10-22)

`deploy-rolling.test.sh` (`make test-ci-scripts`, case 1, a release under load) failed ONCE: run 39796209603, attempt 1, head `537b4c736`. Tally `{"200":340,"502":2}`, slowest response 2155 ms, right after the frontend's old replica was retired with a 1 s drain. The rerun passed, and so does every other run read. The logs of attempt 1 are not retrievable: the API serves the passing attempt.

**What is known, by reading `infrastructure/lib/rolling.sh`, `infrastructure/edge/nginx.conf` and the fixture.**
- The edge is a LAYER 4 relay (`stream`). It cannot answer `502`: a connect it cannot make closes the client's connection instead (`transport:ECONNRESET` in the client's tally, as in the control case). So both 502s were written by a FRONTEND nginx whose upstream, `api`, failed after the request was handed to it. That rules out the edge's failover, and the accept-backlog reset of the retiring frontend, as the cause: either would show as a transport failure, not a 502.
- The 2155 ms is the edge's 2 s `proxy_connect_timeout` spent on the retired frontend's vanished address, then the next replica. That is the designed failover, and it answered 200.
- Not settled: WHICH frontend wrote the 502s, and what `api` did. Candidates:
  - the old frontend's worker, during its graceful SIGQUIT, failing a request that still needed `resolver` (a variable `proxy_pass`);
  - a frontend whose cached `api` set held only a retired address.

**Why it is not settled.**
- `retire` runs `docker rm` on the old replica, so its error log, the one line that names the hop, is gone with it.
- The test prints no frontend log when case 1 fails.
- Not reproduced locally.

**Owed, in order.**
1. Make the evidence survive: `retire` prints the retired replica's error lines before `rm`, and the test prints both frontends' logs when a POST fails.
2. Re-run case 1 until it fails, and read which hop wrote the 502.
3. Fix the order in the deploy library if the swap drops a request. A retry or a wider timeout is not the fix.

Filed from #2286.

## P2 - Live chat and floating reactions (WP-L6): the server is MERGED (#2131), the client in review (#2136), five things are owed (2026-10-19)

The sixteen decisions (C1-C16: PostgreSQL rows erased with the live, the manifest poll as transport, a sequence under the live's row lock, server-side reaction sums) are on [lives](services/lives.md#live-chat-and-floating-reactions-wp-l6), taken by the lead on the user's instruction, each reversible. **Owed before any stable carries it:** (a) the adversarial crypto review of the chat seal (C12, `liveChatCrypto.ts`), as for the segment seal; (b) a dev reading with several viewers chatting while a broadcaster sends segments - the chat writes now share the live's row lock with the ingest, and nothing has measured that contention; (c) the user's ruling on two of the lead's choices, GIVEN 2026-10-20: C2's "no grace period" is REVERSED for a reported message, and the reactions are heart, laugh, bravo, fire and the canary chick (no sad or angry holds) - [lives](services/lives.md#decisions-of-2026-10-20-moderation-reactions-the-audience); (d) reporting ONE chat message: server built in WP-L8b (`contentType: 'live_chat'`, [lives](services/lives.md#a-reported-chat-line-wp-l8b)), the client control is #2170; (e) a phone reading of the panel, the reaction bar and the floating layer on the Mi 9T and the iPhone 12, the broadcaster's on-air chat included ([live](frontend/modules/live.md#the-chat-and-the-floating-reactions-client-half-wp-l6-2026-10-19-draft)). Accepted, stated: a viewer refused `LIVE_FULL` sees no chat either (the chat rides the manifest, C3); a message whose transaction commits after its author's erasure survives until its live ends (at most an hour); an erased account's messages leave no tombstone, so a screen that drew them keeps them until it closes ([lives](services/lives.md#an-erased-account-and-a-single-message-reported)).

## P3 - iOS: the system theme does not follow a live switch of the phone's theme (2026-10-19)

The window override pins `prefers-color-scheme` to the page's own command, so in the `system` preference the iOS app reads the phone at start only (true since 2026-09-30; made explicit by the camera fix). Following it live needs native to post the screen's trait style to the page. [android-ios-parity](frontend/android-ios-parity.md#the-system-theme-on-ios-is-read-at-start-only)

## P3 - Asking an author to republish their post (D38b): what was not built (2026-10-19)

The consent flow is built (migration 096). Left out on purpose, each a decision for the user:

- A pending request never expires, like a D38 proposal.
- An author cannot opt out of being asked. The caps (20 per author, 10 per association) and a block are the only brakes.
- The author sees how many readers would newly see the post, never who they are.
- A request whose proposer the author blocks AFTERWARDS still waits in the inbox. The author may refuse it.
- Owed: one reading of the push on the Mi 9T and the iPhone. The native composers (Kotlin, Swift NSE, ObjC) were not compiled here.

[profiles-and-access](profiles-and-access.md#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built)

## P3 - Two association deletes that co-organise each other's events can deadlock (found 2026-10-19, review of #2116, not fixed)

`AssociationsService.remove(A)` locks A, then deletes A's events. Migration 074's trigger takes their co-owner rows and `coorganise` proposals, and these can name B. The row delete of A then cascades into the co-owner rows and proposals where A co-organises B's events. `remove(B)` does the same in mirror, so each delete can hold a row the other's cascade needs: `40P01`, one delete aborted and retried by hand. This is older than #2116. It needs two staff deleting two linked associations at the same moment. The likely fix is for `remove` to lock, in id order, every association its events' co-organisation reaches before deleting anything. [profiles-and-access](profiles-and-access.md)

## P3 - A reel's loop holds its first frame ~210 ms longer than the file says, on the Mi 9T (measured 2026-10-16, not built)

The WebView's own `loop` seeks to 0 and the audio renderer pre-rolls before the clock restarts: the first frame after the wrap is held 317-433 ms where the file spans 107-128 ms. Without an audio track the hold is the file's (83 ms for 107 ms), so it is the audio pre-roll, not the decoder. The audio outside the picture is trimmed since 2026-10-16 (`trimToVideo`, ~100 ms per loop). A seamless loop needs NO seek: re-append the same segments to the MSE buffer the streaming reader already uses, `timestampOffset` advanced by the duration. Owed: the design, then the iPhone's reading of the same seam. [reels](frontend/modules/reels.md#the-end-of-a-reel-looked-frozen-2026-10-16)

## P2 - In a DM, the iPhone's native chrome stands one keyboard too high (2026-10-17)

iPhone 12, `v1.2.9-alpha.7`. A DM whose last message is a tall video, and the keyboard rising from
closed. Every native glass piece then stood 301 pt (the overlap) above its web twin: the "+"
mid-thread, the header off-screen. The salon was right, and so was a later keyboard change in the
same DM. It is not new in 1.2.9. The cause is not measured. Owed: one reading of the
`keyboard settled:` syslog line on the next build, which names one of the three causes. The fix
follows from that line. The analysis is in
[mobile](frontend/mobile.md#the-dm-whose-chrome-stands-one-keyboard-too-high-2026-10-17), and the
procedure in [device-verification](device-verification.md#the-iphone-12-readings-of-v129-alpha7-2026-10-17).

## P3 - Accepted: the native "+" menu drops the keyboard (2026-10-17)

Opening the composer's native `UIMenu` ends the WebView's input session, 8 of 8 on the iPhone 12 (`v1.2.9-alpha.5`). The cause is UIKit's context-menu presentation turning on the focus system, about 70 ms BEFORE the #1953 hold acts, not the hold ([mobile](frontend/mobile.md#the-conversations-native-glass-chrome) has the syslog order).

**Accepted for three reasons:**
- every "+" entry opens a full-screen surface;
- the native menu decision stands;
- the only fix at the cause rests on unobserved UIKit behaviour and risks a stuck gate.

**Reopen it if** a menu dismissed WITHOUT a pick turns out to be a common path (a user report, or the in-app log showing `willEnd` with no pick). The candidate fix would then be compiled and read on a pre-release, never shipped on reasoning:
- the existing `CanariNoInputAccessoryContentView` subclass (`canari_ios.mm`) answers `canResignFirstResponder` = NO while a native menu opens;
- the gate rises before the focus override (`beginTracking` or `configurationForMenuAtLocation`);
- it falls on every path the hold already releases on.

Its iPhone reading, through `tools/ios-device`, in a DM and a salon, 8 rounds:
1. With the composer focused (`keyboard overlap=301`), tap "+". Pass: no `End input session` and no `overlap=0` between the focus override and the hold line, the keyboard visible under the menu, the caret still in the composer after a dismissal.
2. Re-run #1953: one edge swipe closes only the menu, 7 of 7.
3. Exercise every release path: a pick (Photos), a tap outside, the app switcher mid-menu and back, and the conversation closed under the menu. After each, the keyboard must still go down normally: a stuck gate shows as a keyboard that cannot be dismissed.

## P3 - iOS: a Modal or sheet over a conversation has no edge swipe (found 2026-10-16)

The iOS app's only Back is the conversation's own left-edge swipe, and a `Modal` is portalled to `document.body`, out of `ChatArea`: a swipe over its backdrop reaches nothing, as the camera review's did ([reels-in-chat](frontend/modules/reels-in-chat.md#the-iphone-12-reading-of-v129-alpha2---the-edge-swipe-is-the-ios-back-2026-10-16)). The fix is the camera's: the layer carries `swipeBack` calling `backHistoryOverlayFromGesture`, enabled only when it is `dismissible` (a gate pushes no entry, so the top overlay would be the one UNDER it). BUILT 2026-10-17 in `Modal.svelte` (backdrop carries `swipeBack`, enabled when narrow and `dismissible`). OWED: one iPhone reading that a left-edge swipe over a sheet closes it, and over a gate does nothing.

## P2 - A DM receipt killed inside the 2 s window: BUILT, owed a phone reading (2026-10-17)

The owed mark is written at decision time and drained into the outbox at every outbox registration (PK4 pull request, [history-reconciliation](protocols/history-reconciliation.md#the-sender-says-only-what-is-new-and-the-outbox-keeps-one-watermark-per-conversation-2026-10-15)). **Owed**: on the Mi 9T, read a DM, kill the app within 2 s, relaunch: the peer must show it read. **And still owed from the coalescing**: a Mi 9T count of received `[READ] ... has read up to` lines and of MLS checkpoints per 3 minutes of a two-person DM exchange, on the coalescing build against the one before it.

## P3 - An iPhone whose passcode is removed with biometric unlock on keeps a key copy that unlocks with no prompt (found 2026-10-15, review of #1923; accepted)

The background keychain copy (`mls_bg_key_`, no access control) is what the 12 h biometric cadence reads (`getKeyBytesUnattended`). A user who turns biometric unlock on, then removes the device passcode, keeps that copy - and since #1923 `storeKeyBytes` writes it alone on a passcode-less phone, so every later PIN login refreshes it instead of failing: the unattended unlock keeps working with no Face ID sheet and no passcode on the phone. Pre-existing (the copy already survived the removal), now permanent. Accepted by review; [auth](frontend/modules/auth.md#a-keychain-that-cannot-hold-the-biometric-item-ios-with-no-passcode-2026-10-15). **Owed, on the iPhone 12 bench**: passcode set, biometrics on in Settings, remove the passcode, relaunch within and past the 12 h window - record whether the app opens with no sheet, what `isConfigured` and `hasKeyBytes` answer, and whether iOS deleted the `.userPresence` primary item (syslog `SecItemCopyMatching` status). If it opens, the fix is to drop the biometric flag when `canEvaluatePolicy(.deviceOwnerAuthentication)` answers `passcodeNotSet`.

## P3 - A leader taken over in the middle of its own PIN change reloads and tears the change (found 2026-10-18, review of #2058)

Another tab's "Take over" makes the changing leader `releaseLeadership`, and the demotion handler (`useChatSession.svelte.ts`) reloads it 50 ms later whatever it is doing; the recovery finishes the move, but it costs a recovery prompt. **Owed**: refuse or defer a takeover while this tab is changing the key (the realm knows it, `RealmHold.changing`), with a two-realm test ([auth](frontend/modules/auth.md#the-other-tabs-of-the-account)).

## P2 - A backup restore resurrects every account erased since that backup (found 2026-10-16, account erasure) - BUILT, draft PR

`restore.sh` exports the current erasure journal before it replaces the database and replays it after; a returner's new account is kept ([account-erasure](account-erasure.md#a-restore-replays-the-erasures)). Delete this entry when a release carries it: both the host's checkout of `restore.sh` and the core-service image move only with a release ([backup README](../../infrastructure/backup/README.md)).

## P2 - Deleting the account leaves its local message database at rest (found 2026-10-15, review of #1892) - BUILT (#2023), in `v1.3.0-alpha.1`

`SettingsDangerZone` runs `deleteMyAccount()`, then `clearAuth()`, then `leaveSignedOut()`; none deletes `CanariDB_<userId>` / `canari_<userId>.db`, so every DM row (and every salon's last page, [F4](frontend/community-open-budget.md#f4-built-2026-10-15)) stays on the device under the device key. A sign-out keeps it on purpose. **Decided (user, 2026-10-18): a deletion wipes THAT account's database and its vault slot, nothing else** - never `wipeDeviceToFactory`. Built with its tests in #2023 ([auth](frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18)); delete this entry when a stable carries it ([WP-DEL-LOCAL](#decided-by-the-user-on-2026-10-18---every-design-question-answered)).

## P2 - A deleted account's community keys stay on the phone in per-install files with no owner (found 2026-10-18, fourth review of #2023)

`graine_seeds.json` (with its `.lock`) and `channel_keys.json` are ONE file per install and hold community keys that can decrypt history the server still stores. (Since 2026-10-22 the first is sealed at rest under the INSTALL's native cache key and the second is deleted at the first run ([mobile](frontend/mobile.md#the-native-caches-are-sealed-at-rest-and-kept-out-of-backups-2026-10-22)) - which changes nothing here: the install key opens the mirror for whichever account is signed in.) Neither records whose it is, so the account-deletion wipe cannot remove them (and a sign-out already leaves them, deliberately). **The minimal safe rule** is the one `delete_user_push_files` uses: remove only when an ownership proof names the deleted account, as `push_context.json` does. **Check first**: two local accounts in the same community may share entries, and whether the live account re-mirrors them from its own session decides if a per-account split or an owner field is the right cut ([auth](frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18)).

## P3 - The case-collision refusal keeps the deletion marker for ever (found 2026-10-18, fourth review of #2023)

`wipeDeletedAccountLocalData` refuses an id that differs from another stored id only by letter case and keeps the wipe OWED, reported once per start, "until a human looks" - but nothing ever asks a human, so the marker lives until the subject signs in again. It was the main precondition of scenario A of that review (a resume wiping the NEW account), now closed by the callback dropping the marker and every login refusing a deleted account; what is left is an owed wipe that never completes and is never surfaced. **Owed**: a decision on what a collision does (wipe the parts not shared by case, and surface the rest to the user), and a test ([auth](frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18)).

## P3 - Four things the offline cold start fix left open (Mi 9T, `v1.2.9-alpha.1`, 2026-10-15)

From [offline-and-weak-network section 15](frontend/offline-and-weak-network.md#15-an-offline-cold-start-sends-nothing-it-knows-will-fail-2026-10-15). (a) An answerer holding nothing answers a HISTORY ask by silence, so the requester cannot record an answer and re-asks its named online device once per launch: BUILT 2026-10-18 as WP-HOLD-NOTHING (`GraineBundleMsg.holds_nothing`, old readers checked first; [channel-encryption section 24](protocols/channel-encryption.md#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18)); owed one bench reading, and this item goes when it ships. (b) The push context written after the MLS init is not re-attempted after an offline start: the native side keeps the previous launch's context until the next start; a retry on reconnect must check the device key has not changed meanwhile. (c) When only OUR OWN other devices could answer a history ask and none is online, nothing re-asks when one comes online in the same session: `parkHistoryUntilOnline` rides `whenAnyComesOnline`, which watches USERS, and our own user is online by definition, so it would fire at once. The fix is a per-device presence waiter (the roster already carries `onlineDevices`); until then the next start re-reads presence. (d) A no-network spell (`auth.refresh`) is ended by the reconnect or the foreground: a STALE `navigator.onLine === false` whose one spell refresh failed while the server was down, followed by the server coming back with no `online` event and no foreground, keeps refusing until one of the two.

## P3 - Asked by the USER on 2026-10-14 - "Modifier les pseudos" for a group and a community, design questions answered, not built

> *"Une fonctionnalite comme sur Messenger : 'Modifier les pseudos', un ecran qui liste les membres du groupe ou de la communaute, avec 'Definir un pseudo' et un crayon a cote de chaque membre."* (not urgent)

**Rules decided by the user.** In a GROUP (private conversation) every member may set ANY other member's nickname, no hierarchy. In a COMMUNITY one must be at least moderator.

**Answered from the code and wiki:**

- **The name is resolved in ONE place**: `frontend/src/lib/utils/users/displayName.ts` (`firstName lastName`, then `displayName`; asserted against `libs/contracts/user-display-name.cases.json`, which two server copies also follow) fed by the reactive `userDisplayName` / `userDisplayNames` in `displayNames.svelte.ts`. A nickname enters there as a per-conversation override, never at call sites. Push titles (chat-delivery, social-service) would otherwise name a person differently from the screen - the 2026-09-18 report that contract was written for.
- **Moderator checks reach the client as a DECISION, never a role name**: the server's `viewerCanModerate` (with `viewerCanManage`, `viewerCanManageChannels`) on the workspace listing and its event ([social-service](services/social-service.md)). `frontend/src/lib/utils/chat/pinPermission.ts` is the model: in a salon the grant decides, in a DM or group "there are no ranks". The server must re-check it.
- **Where it lives is OPEN and splits by kind.** DM or group is an MLS room: a nickname fits an MLS application frame the server never reads (precedent: the silent edit frame, [chat](frontend/modules/chat.md)), but "anybody may" is then enforced only by convention between equals. A community salon is sealed with Graine and a moderator rule is a SERVER-checked grant, so only a server column enforces it, at the cost that the server sees the nickname. To decide: one mechanism or two.
- **Scope**: per conversation, visible to every member of THAT conversation, never leaking to the profile or another conversation. A late joiner misses an MLS frame sent before they joined ([channel-encryption](protocols/channel-encryption.md)); a column has no such gap.
- **Abuse**: a nickname set by someone else can be an insult. Show who set it (setter id travels with the value), let the target reset it for themselves, make the community case reportable and moderator-reversible ([moderation-and-blocking](moderation-and-blocking.md)), and do not let a blocked user rename the blocker. Length and content limits mirror the profile's; every string through Paraglide.
- **DECIDED by the user, 2026-10-14: TWO MECHANISMS.** Private groups carry the nickname in an MLS application frame the server never sees; communities use a server column with the moderator check. **Build is queued AFTER mute / mentions-only** (next section).
- **DECIDED by the user, 2026-10-18**: in a community the target sees "set by X"; a nickname STAYS when its setter leaves (the target can reset it) ([WP-NICK-COMMUNITY-RULES](#decided-by-the-user-on-2026-10-18---every-design-question-answered)).

## Group notification levels (all / mentions only / none) - SHIPPED in `1.2.8` (#1874), nothing owed here

**SHIPPED (stable `1.2.8`, 2026-10-15).** It waited for these levels (mute and mentions-only, PR #1874) and carries #1863 (device-key vault per account), #1870, #1871 (notification sender name), #1875 (salon first frame), #1877, #1880 (reply swipe thumb arc) and the salon-level-over-socket fix. It does NOT wait for "a remove holds against a re-add" (draft PR #1878, under review or rework): that and the in-app camera everywhere (#1859, needs conflict resolution and Mi 9T + iPhone readings) go to `1.2.9`.

*"Pour la prochaine mise a jour"*: the user held 1.2.8 until both shipped, and they did. **Mentions-only must be decided ON THE DEVICE**: in an E2EE group the server cannot see a mention, so it cannot filter the push itself.

## P2 - An unknown notification type reads as a comment with a dead link on every released client (found 2026-10-15, fix #1911 MERGED, the floor is owed)

The client half is built (neutral inert row, no link, one warn per type, unknown deep-link host lands on `/notifications` - but a push of a new type still maps its `postId` to `post/<id>` on the server and Android, so a new type MUST send an explicit `deepLink`). **THE MINIMUM CLIENT VERSION MUST COVER THIS FIX BEFORE ANY NEW NOTIFICATION TYPE SHIPS** (the first one waiting: the organiser alert for a paid form that is full): wait for the release carrying PR #1911 to be served by both stores, then raise `minClientVersion` to it. Earlier types (`profile_correction_*`, `coorganise_proposed`, `repost_proposed`) show the comment fallback on older clients. Detail: [legacy-compatibility](legacy-compatibility.md#no-date-yet---a-notification-type-the-client-does-not-know-from-any-new-server-type).

## Group DM: a remove must hold against a re-add (decided by the user 2026-10-14, MERGED as #1878, shipped in `1.2.9`; the floor is owed)

**Ships in `1.2.9`, not `1.2.8`** (user, 2026-10-14). **OWED STEP OF 1.2.9: raise `minClientVersion`** (`1.2.7` when this was written; check the live value first) once the stable carrying #1878 is served by BOTH stores (`bun tools/play-vitals/vitals.mjs`, and the App Store state), as its own step with the user told: the guarantee is complete only when every answering device runs the new build. The user's wording was "a la version 1.2.8", but the guarantee ships in `1.2.9`, so the floor to raise to is `1.2.9`, NOT `1.2.8`: **ask the user to confirm the version when the time comes.**

Built (#1878): server membership intervals and enforcement at the answering peer; the question it answers is [open-questions](open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add).

## P2 - The tab swipe is lost on a slow start: the 12 px lock sits past Chrome's 8 dp slop (Mi 9T, 2026-10-21)

The owner's "the swipe to the camera does not work every time" is two deterministic classes, the
whole matrix and its evidence in [design-reference](frontend/design-reference.md#the-swipe-to-the-camera-that-sometimes-did-nothing-two-classes-measured-mi-9t-2026-10-21).
**A (every tab, not only the camera):** when the first `touchmove` Chrome delivers is under
`GESTURE_LOCK_PX` (12), nothing claims it, Chrome takes the sequence and every later move is
`cancelable=false`, so `claimTouchMove` stands the swipe down - 8 of 8 such cells. **Reproduction,
deterministic (4 of 4 each way):** on the Mi 9T on the feed, `input motionevent DOWN 300 1300`,
`MOVE 325 1300` (the first delivered move, 10 CSS px), then `MOVE` every 30 px to 620, `UP`: stays
on the feed. The same path with its first `MOVE` at 332 (13 CSS px) opens the camera. (`input
swipe` is NOT deterministic here: its first move lands anywhere from 10 to 24 px by injection
timing.) **The fix** moves the lock to 8 px, under the slop; simulated on the phone, the failing path
then opened the camera 4 of 4, the slow straight cells 12 of 12, and vertical scrolls were unchanged
(separate draft PR). **B:** a start in Android's left 74 physical px
is a system Back (8 of 8), the page sees only `touchcancel` - a user decision, owed in the table
above. Owed after the fix: one real-finger reading of slow swipes on the Mi 9T, and class A read on
the iPhone, where it is unproven.

## Android back-gesture zone on the right edge (own bubbles) - DECIDED by the user 2026-10-14, MERGED as #1883, owed a reading

Decided: declare system gesture exclusion rects for the right edge band while a conversation is open (a reply swipe started in an own bubble's last 17.5 px is a system Back: 11 of 11 on the Mi 9T). **Owed: a Mi 9T reading on the next pre-release.**

## iPhone follows the system text size (Dynamic Type) - DECIDED by the user 2026-10-14, MERGED as #1884, owed a reading

Decided: the iPhone app FOLLOWS the system text size, like Android. Read on `1.2.9-alpha.1` (2026-10-15): cold start PASS; a size changed while backgrounded applied only after a cold start, now carried from native ([mobile](frontend/mobile.md#the-iphone-follows-dynamic-type-decided-by-the-user-2026-10-14)). **Owed: an iPhone 12 reading of the background change, the rail salon name and a long heading at 2x.**

## P1 - The iOS app aborts whenever its accessibility tree is read, since `v1.3.0-alpha.1` (iPhone 12, 2026-10-19) - FIX ON A DRAFT PR, UNVERIFIED

**Observed:** any WDA query (element lookup, tree, even a coordinate tap) kills the app within ~10 ms: `HangTracer name=UIAutomation`, then `Corpse allowed`, then `ASI found [libsystem_c.dylib] (safe) 'abort() called'`. `1.2.9` survives the same query; `1.3.0-alpha.1` and `-alpha.2` abort. VoiceOver users would hit the same path. **Bisected by reading `v1.2.9..v1.3.0-alpha.1`:** no dependency moved (tao 0.37.1, wry 0.57.0, objc2 0.6.4 on both sides); the native iOS changes are #2000 (`canari_push.mm`), #2037 (a `locale` argument through three FFI calls, reached only by a push), the NSE (another process) and sound resources. **Prime candidate: #2000's `CanariReassignAppDelegate`** (`app.delegate = nil; app.delegate = delegate`), the one new thing that touches an object UIKit's accessibility runtime reads. Firebase's own `reassignAppDelegate`, which it copied, keeps the delegate in a static strong `gOriginalAppDelegate` on the very next line; ours keeps it in a local, so the delegate `UIApplicationMain` created appears to die when the function returns. **Corroborated by the same syslog:** SpringBoard logs `Sending received device token to 1 connections` on both launches, and `[CanariPush] APNs token received` - the token hook ON that delegate - never prints. **The backtrace IS readable, with no App Store Connect: `pymobiledevice3 crash pull <dir>` on the USB-attached phone** (reports under `Retired/`). Read 2026-10-19: seven `Canari-2026-10-18-*.ips`, bug type 309, `SIGABRT`, one on `-alpha.1` (build `100300001`) and six on `-alpha.2`. ONE carries the reason: `NSInvalidArgumentException: -[_UISceneCloudKitShareMetadataBSActionHandler _keyboardShortcutMenuLeaves]: unrecognized selector`, thrown from `-[UIResponder _enumerateKeyboardShortcutsInChainWithOptions:usingBlock:]` <- `-[UIApplication _immediatelyUpdateSerializableKeyCommands]` <- the after-CA-commit queue <- `UIApplicationMain` - a responder-only message reaching a UIKit-internal object, i.e. a FREED responder whose memory was reused, in the chain that ends UIApplication -> its delegate (tao's `AppDelegate`, a `UIResponder`). The other six abort with no reason recorded: disassembled against the release `Canari.ipa` (UUID matched), their frames are `start_app`'s `catch_unwind` landing pad -> `__rust_panic_cleanup`'s foreign-exception branch -> "Rust cannot catch foreign exceptions" -> `abort`, so an Objective-C exception escaped `UIApplicationMain` there too and Rust's abort erased its frames. `_AXDyldImageMonitor` is live in each - the accessibility runtime had just loaded. **So: a dead responder at the end of the chain is READ; that it is the delegate is still the hypothesis**, which the fix's becoming-active log (`app delegate is the kept-alive one` / `is nil` / `differs`) settles. Fix: keep the delegate in a static strong reference (draft PR, compiled nowhere - this Windows box cannot build iOS). **Confirms it:** on a build with the fix, (1) a WDA tree/element query no longer aborts, and (2) `[CanariPush] APNs token received` appears in the syslog after `registerForRemoteNotifications`; and (3) the becoming-active line reads `the kept-alive one`; a 1.2.9 syslog showing the token line would add to it. If (1) still aborts with the fix, the next candidate is the reassignment ITSELF (UIKit re-reading a delegate that does not declare `UIApplicationDelegate`, as GoogleUtilities logs at launch) - drop it and accept unseen silent frames until a backtrace says otherwise. The silent-frame reading of #2000 below is void until this closes.

## P2 - iOS silent frames reach no Canari native code, background or foreground (found 2026-10-15, iPhone 12 syslog)

**BUILT on a branch (2026-10-17), not shipped:** the method is ADDED with `class_replaceMethod`, and what a woken process may do is an allowlist of dismissals (`channel_read`, my own MLS frame, `call_ring_end`) that never reaches `CanariHandleFcmData` - mechanism in [mobile](frontend/mobile.md#silent-frames-reach-the-app-through-a-method-canari-adds-2026-10-17). **Owed**: the iPhone 12 reading named there (`remote notification hook installed`, then a salon read elsewhere clearing the banner, backgrounded and foregrounded). The Welcome kinds stay unhandled on iOS until the background-join row fix below.

## Next chantier after 1.2.8 - speed (user, 2026-10-14)

Order: (1) opening a community or salon in **under 200 ms** for the tab and the first paint of cached content: F1 local workspace list (draft PR in progress), then F4 salon last page cached locally, the posts feed local-first (offline it says "Impossible de charger les posts"), read-marker coalescing (pending the adversarial review of #1879) - budget and ranking in [community-open-budget](frontend/community-open-budget.md); (2) CanaReels in chats (RC-3 built, device table owed; RC-7, [reels-in-chat](frontend/modules/reels-in-chat.md)); (3) Graine v2 G2-6.

## P3 - Found reading the Pixel 6a on prod 1.2.7 (Wi-Fi, LTE, offline, 2026-10-14)

Evidence: `canari-log-1.2.7-20261014-1759.txt` in the harness state dir `pixel-r1014` (outside the repo, cite by name only).

- **The Communities tab shows NO community offline**: the workspace list is not local-first, and the feed says "Impossible de charger les posts" (both in the speed chantier above).
- **P2, from the agent of PR #1881: an "absent conversation" at cold start.** Kept; it also affects community open time, so it belongs with the speed chantier.
- **79 MLS checkpoints in 3 minutes** (94-238 ms each, 9.4 s in all): one per bulk ingest, even for `read_watermark` frames.
- **Salon open measured ~0.6 s on Wi-Fi and ~0.9 s on LTE, ~0.7 s of it a skeleton.** The user's target is **under 0.2 s** for the tab and for the first paint of cached salon messages (cold start excluded).
- Stale "a ajouté un membre au groupe" bubbles on devices from before #1870: DECIDED 2026-10-18, no work, left to age out.

## P2 - A group joined in the background has no conversation row at cold start, and 47 of its 150 queued frames are lost (Pixel 6a, prod 1.2.7, 2026-10-14)

Same log as above, cold start at 17:55:53. **BUILT (PK2, 2026-10-17), all three fixes below** - mechanism on [mls-recovery-ladder](protocols/mls-recovery-ladder.md). **Owed: ONE Mi 9T cold start** with a group created by another device of the same account while the app was killed, reading that no `LOST frame ... past epoch application frame` and no second `Message for absent conversation` pass appear for it. Delete this entry when that reading passes on a shipped build.

**What the log shows, for group `513411dc` (a group the user's own other device created):**

1. The native push service joined it in the background (epoch 1) and cached 21 plaintexts; it wrote no conversation row.
2. 17:55:55.136: the server redelivers the Welcome. The handler finds the group held, takes the "already held - redelivered Welcome ignored" path, which promotes an EXISTING row and creates none. 150 frames parked behind it are re-queued.
3. They are refused `absent-conversation` twice: at 17:55:55.4 (before the restore seeded rows) and at 17:55:57.0 (the "conversation rows seeded" re-fetch; storage holds no row for it either). That is 306 of the 314 `Message for absent conversation` lines and the 306 matching `messageCallback -> false`; 149 frames were handled 3 times. The other 8 refusals are 3 groups whose frames arrived before the restore seeded rows, read 1.7 s later.
4. 17:55:58.3: the FCM-cache merge creates the row in memory (`mergeFcmMessagesIntoConversations`) and does NOT call `notifyConversationAvailable`, so nothing re-fetches the waiting frames.
5. 17:55:58.661: a live frame for the group finds the row, is at epoch 18, and the gap healer replays 17 commits from the archive (epoch 1 -> 18) without the application frames between them.
6. 17:55:59.883: the "conversations restored" re-fetch finally delivers the 150 frames; **47 are `LOST frame ... past epoch application frame`** and history reconciliation is asked to repair them (a 2-message bundle at 17:56:03, three more asks by 17:56:40).

The other high-count lines of that window are per event: 114 `read_watermark` frames each advanced a watermark (one dispatch line and one `[READ]` line each, 97 of them this group's backlog), and `[QUEUE] Processing` is one per frame, tripled for this group by the refusals above.

**Cost**: the frames arrive 6.5 s after cold start instead of ~1.5 s; two refusal passes take ~600 ms of drain on the main thread during the restore and first paint; 47 messages depend on a peer's history answer.

**The fix, as built:**

- The "already held" Welcome branch writes the row when none exists and announces it - from storage when storage holds one the restore has not seeded yet, else the install path's derivation. The restore's prune keeps a row written after its storage read. **Residual, named:** on SQLite a row whose save was issued just BEFORE the restore's read is not proven visible to that read; it would be pruned and re-created by the push-cache merge or discovery - later, not lost (the gap hold below covers the loss).
- The FCM-cache merge on resume announces each row it creates. The login merge in `sessionAuth.ts` still calls the unannounced one (PK1/PK8 own that file); the restore's re-fetch covers it there.
- The gap healer holds a live frame while the group has refused frames still queued.

## P3 - A re-added reader rescans its own dropped tail on every launch (fifth review of #1878, 2026-10-15)

When a re-added reader's only unread history rows fall inside its own exclusion window, the server drops them and the cursor cannot move past them. Every launch reads them again, bounded by `MAXLEN` in whole chunks. This cost is accepted.

Letting the cursor jump the tail (`skipTo`) was built and deleted because it could hide entitled rows for good ([history-reconciliation](protocols/history-reconciliation.md)). A future version must prove three things before it moves a cursor past rows it did not hand:

- every window touching the skipped span is CLOSED and ends after the span;
- the windows were repaired before the filter ran (no roster member is left without an open interval);
- the client accepts a skip only when it is ahead of its cursor and at or before the walk head.

## P2 - How the browser lost the message an overheard digest exposed is not established (2026-10-13)

Production, group `656597dc`: the browser lacked one message the owner's phone held. The repair is shipped: the overhearing device asks the digest's author, and asks once more on the author's next live frame ([history-reconciliation](protocols/history-reconciliation.md#a-digest-overheard-is-evidence-the-member-that-lacks-something-asks-its-author-2026-10-13)). **Open**: the CAUSE. Compare the phone's 7 ids with the browser's 6 to find how the browser lost it (inferred, not shown).

## P2 - Key-group requests sealed 3-6 epochs behind are unreadable by every current member (console export, 2026-10-12)

Four senders' devices sealed seed requests at epochs 135-138 while the key group was at 141. No current member can open them (`max_past_epochs` 2), and each loss drives a re-ask. The drain order was REFUTED as the cause ([channel-encryption §23](protocols/channel-encryption.md#not-the-cause-the-drain-order)). **Candidate**: chat-delivery answers `stale_epoch` to an application frame on a key group whose MLS epoch is below active - 2, so the sender catches up and re-seals instead of sending something nobody can read. **First measure**: chat-delivery now logs `STALE_EPOCH_FRAME` with the sender's device, build and distance for every such frame ([channel-encryption §23](protocols/channel-encryption.md#not-the-cause-the-drain-order)); read it on production after the deploy to find out which client versions lag, then decide the refusal.

## P2 - A notification tap takes 2.7 s to a usable conversation when killed, 5 s behind the PIN (measured 2026-10-11)

**User goal: tap a message notification, be in the conversation, send a reply - extremely fluid, killed or backgrounded.** Mi 9T, `1.2.3-alpha.5`, dev, medians: warm **<= 0.35 s** to a usable composer; killed with "Rester connecte" **2.7 s**; killed behind the PIN **5.0 s** plus the human typing it; a reply is accepted 0.75-1.1 s after the send button. Ranked costs and the plan F1-F8: [notification-to-conversation-latency](frontend/notification-to-conversation-latency.md). **Since (2026-10-12)**: F2 (#1751, composer 5.06 -> 3.83 s) and F3 (#1752, gate 2.19 -> 1.74 s) SHIPPED in `v1.2.4`; F5 was REFUTED (#1753: the resume starts ~50 ms after the tap, the warm wait is the `/chat` render). F1 (opening from the local store before the session is up) is #1770, a DRAFT that touches the PIN path (measured on the Mi 9T: history -0.6 s and routing -0.5 s, composer unchanged or slightly slower on a good network, vault 2630 -> 2792 ms; on a slow network the pane no longer waits for the session, n=2; the preview's ~380 ms store open on Tauri is its remaining cost): owed a phone reading, and kept OUT of any stable while the user is away. **Leads left**: a killed-app notified message arrives ~1.2 s after the conversation is drawn; the thread render costs ~0.3 s; the per-request cost behind the edge. **T1 (push-to-banner latency) cannot be measured on dev**: dev has no `DEV_FIREBASE_SERVICE_ACCOUNT_JSON` (owed table). F4 is a user decision. **Owed**: the same readings on the iPhone (bench build with the inspector) and on a production-sized state.

## P1 - Offline and weak network: the cold start is 103 s on Slow 3G (user, 2026-10-09; measured, partly built)

Salon writes now wait for the link and a repeat is one row (WP-OFF-3/4, PK4 pull request, [section 16](frontend/offline-and-weak-network.md#16-wp-off-3-and-wp-off-4-built-a-salon-write-waits-for-the-link-and-a-repeat-is-one-row-2026-10-17)); a salon photo, video or poll still needs the link. Cold start on Slow 3G: first paint 23 s, list usable 103 s (JS 57 s, then the 2 MB WASM 45 s, then the list); warm 2.1 s. Fourteen ordered work packages, each with its test, and the measured table: [offline-and-weak-network](frontend/offline-and-weak-network.md). Start with WP-OFF-1 (keep the salon draft on failure), WP-W1/W2 (compression, WASM preload), WP-W3. Owed: peer-side delivery, Android and iOS runs (the page lists them).

## P3 - A salon row committed by a process that died before its broadcast: the outbox is BUILT, owed its release (2026-10-18)

Migration 093 and the writer are two stacked pull requests that may ride the same release (the deploy migrates before it replaces services). Mechanism, what it does NOT cover (a Redis outage) and the accepted late-duplicate limits: [social-service](services/social-service.md). Delete this item when the release is stable.

## P2 - The host WAF drops any request body over 10 MiB (found 2026-10-10)

The cause of the user's "endless spinner" on a 13.4 MB PDF: the school-managed web application firewall on the host refuses large request bodies with a 403 HTML ban page, for every user ([host-waf-body-limit](infrastructure/host-waf-body-limit.md)). **Fixed for every `encryptAndUpload` surface by WP-OFF-8** (8 MiB per request, chunk route above it, a refusal ends the entry). **Closed 2026-10-17 by a client cap** on the vault document and every raw image upload (`assertWithinRequestBudget`, localised refusal); what remains is a vault document over 8 MiB, which is refused rather than chunked. The host's firewall limit is not ours to change and nothing is asked of anyone: the client stays under it.

## P2 - Weak network, the attachment path after WP-OFF-8 (audit 2026-10-10)

Prioritised list and numbers: [offline-and-weak-network section 13](frontend/offline-and-weak-network.md#13-audit-of-2026-10-10-a-13-mb-attachment-on-a-poor-link-and-what-navigation-waits-for). Built: the upload bubble (progress, cancel, retry, refusal) and the 8 MiB body budget (WP-OFF-8), navigation never waiting on the profile call or a post (WP-NAV-1), the upload running outside the lane so a text sent behind a big file does not wait for it (WP-OFF-9, section 13.8). **Open**: every failed upload restarts at byte 0 (resumable chunks need a server offset route, RC-5); a salon attachment blocks the composer with no progress (WP-OFF-3 queues a salon text, edit or reaction but not a photo, video or poll: section 16); the file sits in the outbox row and three times in memory per attempt. **Owed ONE look on the iPhone** with a real file on a bad link.

## P1 - A 13 MB attachment costs 1.2 GB of renderer memory and a wait before the first byte (Mi 9T, `1.2.3-alpha.4`, read 2026-10-11)

**Reading (user, dev):** 13 MB send ~100 s end to end: ~60 s with the bubble on `waiting` while online, then the ring, then sent; renderer RSS 234 MB -> 1.26 GB ~20 s after the tap (956 MB for 14 MB); alpha.3 ~27 s, 1.1 GB. **Where it goes was read from the code and micro-benchmarked in Chrome (V8), not measured on the phone.** `waiting` is also the DEFAULT view of a bubble with no upload state (`MessageBubble.svelte:587`), so it does not prove a backoff hold.

### The copies of the file, per phase (13 MiB = 13 631 488 B)

| Phase | Where | Copy | Size / measured (desktop Chrome) |
| --- | --- | --- | --- |
| pick | `useMessaging.svelte.ts:1201` | `file.arrayBuffer()` | 13.6 MB |
| write | `outboxCodec.ts` `uint8ToBase64` | `binary += fromCharCode` per byte: one cons node per byte | **+260 MB heap, 411 ms**, then flat base64 17.3 MiB |
| write | `encryption.ts:49-52` | `JSON.stringify` string, `TextEncoder`, AES-GCM output | 3 x 17.3 MiB, 52 ms |
| write | `sqlite.ts:60` `uint8ToBase64` | the same per-byte loop on the CIPHERTEXT | **+370 MB heap, 816 ms**, row string **23.1 MiB** |
| write IPC | `sqlite.ts:752` -> plugin-sql | **Android never uses the fetch IPC** (`ipc-protocol.js:20`), so the 23 MiB string goes `JSON.stringify` -> `window.ipc.postMessage` (Java UTF-16) -> JNI -> serde `Value::String` -> `to_owned()` for the bind (`tauri-plugin-sql wrapper.rs:159`) | 4-5 copies native-side, NOT measured |
| read | `outbox.ts:912` `getOutboxEntry` -> `SELECT *` | an answer over 10 KiB becomes `JSON.parse('<escaped>')` evaluated by `webview.eval` (`format_callback.rs:64`, `protocol.rs:335`) | 23 MiB x several, NOT measured, **prime suspect for the 60 s** |
| read | `sqlite.ts:72`, `outboxCodec.ts:52` | `Uint8Array.from(atob(s), cb)` twice (outer ciphertext, inner file) | **+266 MB / 1114 ms** and +182 MB / 672 ms |
| read | `encryption.ts:70` | plaintext, `TextDecoder` string, `JSON.parse` string | 3 x 17 MiB |
| upload | `sessionAuth.ts:245`, `media.ts:739,746` | `new File([bytes.buffer])`, `arrayBuffer()`, ciphertext, 8 MiB chunk slices + Blob + FormData | 3 x 13.6 MB + 8 MiB per chunk |
| after upload | `outbox.ts:629` | `updateOutboxEntry` with a media patch is NOT a clear patch: a SECOND full `SELECT *`, decode, merge, re-encrypt (small), INSERT | the whole read cost again |

Peak is linear: **~95 MB of renderer per MB of file**. The server ceiling is 50 MB, so a 50 MB file asks for ~4.7 GB: a certain renderer kill today.

### Where the 60 s is, ranked (the phone log decides)

1. **The 23 MiB `SELECT` of `getOutboxEntry`** and **the 23 MiB `INSERT`** through the Android postMessage + `eval` bridge: native copies, a script of tens of MB to parse. Unmeasured; the JS side alone is ~2.3 s per direction on a desktop (table above), perhaps 10-20 s on a Mi 9T, which is NOT 60 s.
2. **GC thrash near the WebView heap ceiling** (1.2 GB of cons strings and iterables alive at once): would explain the alpha.3 27 s -> alpha.4 100 s spread, since no code on this path changed between the two tags (only #1730's light `hasEntry` read and a throw on enqueue).
3. **The backoff ladder**, which would be `2+5+15+30 = 52 s` if four holds preceded the first upload (`outbox.ts:57`, `holdForRetry`). Ruled IN or OUT by one log line: `held: group ... not sendable` or `transient failure (attempt N)` versus none. A first-attempt hold after a failed payload read re-pays the 23 MiB read on every retry.
4. Not the cause, by reading: a lane waiting behind an earlier entry (one entry), the idle barrier (`waitForMessageQueueIdle`, instant when nothing drains), the mirror (media is never mirrored: `outboxMirror.ts` `toMirrorEntry` is null for media), and the clear-patch path (alpha.4 has it).

**Instrumentation shipped with the PR:** `[OUTBOX] <id> durable write took N ms` (enqueue) and `[OUTBOX] <id> payload read in N ms` (flush). The next phone reading answers 1 vs 2 vs 3 from the session log.

### Design, cheapest first

**Tier 0 - shipped by `fix/outbox-media-peak`: chunked base64** (`utils/hex.ts` `toBase64`/`fromBase64`, used by `outboxCodec.ts` and `sqlite.ts`; byte-identical to `btoa`, tested across the 32 KiB slice). Desktop numbers, 13 MiB: encode 411 + 816 ms -> ~85 ms each; decode 1114 + 672 ms -> ~60 ms and ~15 ms; ~1.0 GB of transient heap gone. It does NOT touch the three 23 MiB IPC crossings.

**Tier 1 - DONE (2026-10-11, `feat/outbox-media-blob`): see [offline-and-weak-network 13.7](frontend/offline-and-weak-network.md).** The text below is the design it followed; what remains OPEN is listed after the risks.

**Tier 1 - the file leaves the row (removes the IPC and most of the peak).** Binary over IPC is hopeless on Android (`process-ipc-message-fn.js`: a `Uint8Array` inside the message becomes a JSON number array, ~4x worse than base64), so the bytes must not cross it: keep them in **IndexedDB** (the webview's own store, structured clone of an `ArrayBuffer`, no base64, no JSON), in a store `outbox_media` `{ id, iv, cipher }`.
- Encrypt the RAW bytes under a **random per-entry AES key** kept in the small encrypted SQLite payload (`blobId`, `blobKeyB64`): AES-GCM of 13 MB is ~9 ms and the row stays under 1 KB, so `getOutboxEntry`, every retry and the post-upload patch cost milliseconds and no longer move 23 MiB.
- Order: **blob first, row second** (the opposite reasoning of the message/entry pair: a row with no blob is a VISIBLE typed failure - `LocalAttachmentError`, the #1730 orphan verdict, parked with a delete - while a blob with no row is invisible garbage a boot sweep deletes).
- `prepareMedia` reads the blob from IDB only when it uploads. After upload: delete the blob, patch the small row (a clear-class patch).
- Web build: `indexeddb.ts` already holds the outbox, so the blob store joins the same transaction (atomic there).
- Expected peak: ~3 x 13.6 MB for the pick/encrypt/upload instead of 1.2 GB; the write and read waits become the IDB put/get (to be measured on the phone).

**Tier 2 - a client cap is NOT recommended once Tier 1 lands.** Until it does, a native cap near 20 MB would stop the 50 MB OOM; it needs a Paraglide message and is offered as a decision, not a default.

### Risks (Tier 1 built; the verdicts)

- **iOS WKWebView IndexedDB eviction** under storage pressure: unmeasured. The row survives in SQLite and a lost blob becomes the typed orphan, but that is a lost attachment. Needs one iPhone check (kill the app with a queued 13 MB file, relaunch).
- **Crash survival:** the IDB put commits before the row; a kill between the two leaves swept garbage, never a ghost send. Test: kill after the put.
- **Native mirror:** unaffected, media entries are never mirrored.
- **Side finding:** between `addMessageToChat` (placeholder) and the end of the 23 MiB INSERT the bubble has no upload view and `hasEntry` can answer `false`, so #1730's orphan red state can flash on a slow phone and is not re-asked when the row lands. Tier 1 shrinks the window to milliseconds, Tier 0 by the encode time.


### Still open after Tier 1

- **Phone measurement (owed to the user):** the 13 MB send on the Mi 9T with the `[OUTBOX] ... durable write took N ms` and `payload read in N ms` lines; peak and wait before the first byte were derived from a desktop micro-benchmark, not measured on the phone. If the wait is still long, the remaining suspects are the three upload copies (`sessionAuth.ts:245`, `media.ts:739,746`), not the row.
- **iOS WKWebView IndexedDB eviction (owed, ONE iPhone check):** kill the app with a queued 13 MB file, relaunch. Expected: either the send completes, or the bubble shows the `upload_error` card (blob missing -> parked). Nothing here ran on an iPhone.
- **Multi-tab web, the sweep:** the 10-minute grace is a clock guarding a cross-tab race no in-document set can see; a web tab enqueuing a file in the same seconds as another tab's session start, with an enqueue longer than the grace, would see a typed `upload_error` on that attachment. Not reproducible by test (needs two tabs); accepted.
- **Tier 2 (a client size cap)** stays NOT recommended; the 50 MB ceiling now costs ~3 copies of the file, not 4.7 GB.
- **Row-delete cost:** `SqliteStorage.deleteOutboxEntry` now does one extra clear-column `SELECT kind` per delete (to know whether a blob exists); microseconds, noted in case a profile ever shows the outbox. It is guarded: a failed read deletes the row and the blob anyway, never failing the cancel.

## P3 - iOS notification sounds still play the default tone (palette A is Android and in-app only, 2026-10-09)

**BUILT on a branch (2026-10-17), not shipped:** the three Android files bundled in the app and the extension by reference, the server naming one per push, the extension setting the mention trill ([sounds](frontend/sounds.md)). **Owed**: an `ios.yml` compile check showing the three files copied into both bundles, then a listen on the iPhone 12 (DM, mention, reaction). The call ring (`calls.service.ts`) keeps `'default'` while calls are held off.

## Seen on the 2026-10-09 bench runs (around `v1.2.1`)

### P1 - a tab or app open across a production deploy sees the outage as "Échec de l'envoi"

The 1-2 min a prod deploy takes answers `502`, and a send in that window shows "Échec de l'envoi". Clients older than `1.2.1` then stayed blocked by the key-group epoch bug ([channel-encryption §22.3](protocols/channel-encryption.md#223-the-native-app-read-every-held-key-group-as-epoch-0-and-re-joined-them-all---fixed-2026-10-09)), but the deploy outage is user-visible on its own. **BUILT 2026-10-17 (PK6): a release starts each new replica beside the old one and drains the old one** ([cicd](cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)); a fixture test sends throughout and sees no failure. **Owed:** a pre-release deploy to dev with a client sending throughout (no `502`, no "Échec de l'envoi", and the edge taking port `3080` on that first deploy), then the same reading on the first stable.

### P2 - media-service and call-service still have a gap on each release

Both are `exclusive` in the deploy ([cicd](cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)): media-service keeps its metadata index as one JSON file on the `media_meta` volume, which two replicas would both write, and call-service keeps rooms in memory. An upload or a call started in those few seconds fails. Closing it means moving the index into Postgres (media) and accepting that a release ends a call, or handing rooms over.

### P2 - the dev estate cannot send a push

Firebase is not initialized in `canari-dev-chat-delivery-service`, so no notification check can be performed on `dev.canari-emse.fr` ([dev-environment](infrastructure/dev-environment.md)).

### P2 - iPhone: once, a message that arrived while the app was killed left no unread dot

Neither the tab nor the salon showed one. Not reproduced.

### P3 - switching accounts on one iPhone install makes the local store unreadable

The next session shows "Vos messages enregistrés sur cet appareil n'ont pas pu être ouverts", and only a reinstall clears it.
A candidate cause is fixed in #1862 (the MLS client and its device id survived a sign-out into the next account's login, [auth](frontend/modules/auth.md#a-sign-out-ended-the-session-on-the-server-and-left-it-live-on-the-device---fixed-2026-10-14)); owed one re-reading after it ships.
**The vault half is fixed (2026-10-14)**: the device-key vault names its account, so B is never handed A's key and never rotates A's `mls.bin` ([auth](frontend/modules/auth.md#the-vault-names-its-account---fixed-2026-10-14)).
**The owner record is BUILT (PK1, 2026-10-17, unshipped)**: `initialiser_mls` writes `mls.owner` beside `mls.bin` each time a state OPENS for an account, a state reset (`terminer_session_mls`) removes both, and when B's key does not open the file and the record names A, `init` throws `SavedStateOfAnotherAccountError` before any write - the gate says another account's messages are here and withholds the reset, on the keypad path too. An install whose state predates the record has none, so A must sign in once on the new build before B is protected. Owed: one A -> B -> A reading on the Mi 9T and the iPhone on a pre-release carrying it.

### P3 - the per-community triplet, ETag/304 and the Mi 9T's two `history-request`

`devices`, `users/<id>/groups` and `unread-counts` are single-flight since [section 18](frontend/offline-and-weak-network.md#18-wp-w4-first-part-the-account-level-reads-of-a-boot-are-shared-while-in-flight-2026-10-18) and [section 19](frontend/offline-and-weak-network.md#19-wp-w4-second-part-unread-counts-is-one-request-per-boot-ordered-after-the-read-mark-flush-2026-10-19); `register-device` stays, it is the liveness clock. Left: the per-community triplet in one call, ETag/304, and whether the Mi 9T's two `history-request` hit one group.

### P3 - the harness gamma bench PIN is refused on dev

## Seen on the 2026-10-13 bench pass (Mi 9T `v1.2.6-alpha.1`, iPhone `1.2.3-alpha.5`)

The readings are in [device-verification](device-verification.md#the-bench-readings-of-2026-10-13---the-owed-rows-a-bench-phone-can-settle).

### P2 - TestFlight serves this tester no pre-release after `1.2.3-alpha.5`

The iPhone 12's TestFlight lists the `1.2.6 (100200699)` stable and, under previous builds, nothing
newer than `1.2.3`, although the `v1.2.4-alpha.*`, `v1.2.5-alpha.1` and `v1.2.6-alpha.1` runs all
built and uploaded their IPA. So no pre-release reaches the iPhone bench and every iOS reading of a
newer fix waits. Owed: read in App Store Connect whether those builds exist, finished processing and
were added to the tester group.

### P3 - a 90 px keyboard: the composer spends 24 ms 12 px low on 3 of 5 rises

The other half of the 90 px reading of 2026-10-13 (the one-frame drop to 702 was the double report,
now recognised at any keyboard height, [chat](frontend/modules/chat.md#every-keyboard-rise-moves-the-composer-for-a-moment-on-both-phones-measured-2026-10-02-fixed-2026-10-09-reading-owed)).
Below the 160 px keyboard threshold no keyboard is ever "open", so `computeSnapshot` pins nothing in
those frames; the 12 px (one `0.75rem`) comes from somewhere it does not reach. Cause not read: owed
a per-frame record of `innerHeight`, `visualViewport.height` and the footer's padding on that rise.

## P1 - A community key group sends every repair answer to every seat, and 42 % of seats have no device behind them (production, 2026-10-12)

`queued_message` went from 14 493 rows (2026-09-22) to 93 580. A community created on 2026-10-11 holds 34 946 of them. In 37 minutes of log, 94 % of its key-group application frames were seed requests and answers, and each answer was queued for about 100 seats. 821 of 1 952 active seats belong to devices with no session left, and those devices hold 56 % of the rows. External-join churn is refuted, no client is provably stuck, and the 11 commit-log holes are unchanged. Plan, cheapest first: say why each seed request was made (F3), let one device of the answerer answer (F2), send an answer only to the requester (F1), and revoke replaced device generations with predicate R, staged (F4, needs the user's go). Measurements, SQL and risks: [prod-queue-and-epoch-audit](infrastructure/prod-queue-and-epoch-audit-2026-10-12.md). **State, 2026-10-12 evening:** F1-F3 MERGED (#1768, [channel-encryption §23](protocols/channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)) and NOT in `v1.2.5`, so the queue keeps growing until the next stable; F4 is done: the first pass revoked 43 devices, the second (R in full) 118 ([second pass](infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#second-pass---2026-10-12)). **Measured 2026-10-13** ([why the queue holds 300 000 rows](infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#why-the-queue-holds-300-000-rows---measured-2026-10-13)): 301 937 rows, 255 475 of the last day in ONE group (`1b1687d0`), and 266 of the 448 devices with a queue have a session, so the reaper cannot help. Hypothesis, not proven: that group's broadcast seed requests and answers, which #1768 (in `v1.2.6`, 2026-10-13) addresses to one device. **Owed - the measurement that settles it:** re-run the same per-group `GROUP BY` (rows in the last day, rows per hour) 24 h and 72 h after `v1.2.6`. If the queue can tell which client version a sender runs, split `1b1687d0`'s rows per hour by it; the queue has no version column, so the `ADDRESSED matched=N of M` lines in the delivery log are the other source. **Prediction:** `1b1687d0`'s last-day rows fall from 255 475 to under about 51 000 (-80 %, F1's expected gain) at 72 h, once most of its senders run `v1.2.6`. At 24 h they fall in proportion to the share that has updated. Rows from senders on `v1.2.6` reach 1-3 seats per answer instead of about 100. **The hypothesis is refuted** if `1b1687d0`'s rows per hour from updated senders stay at their earlier level. No deletion: these rows belong to live devices.

## Seen in the 2026-10-12 web console log - what the audit left open

Three minutes of a production web client idle on `/communities` ([web-console-log-audit](frontend/web-console-log-audit-2026-10-12.md), the ranked table and the counts). A and B are fixed in their own pull requests; these are not small enough to be.

### P2 - one encrypted MLS checkpoint per inbound application message

39 checkpoints in 197 s, median 348 ms, max 998 ms: `onBulkIngestEnd` marks the state dirty unconditionally, and every WebSocket frame is its own drain. **The split is now measured** ([performance-audit](frontend/performance-audit-2026-10-12.md#finding-2-and-3-read-together---the-checkpoint-question-the-backlog-owed)): on a 7.7 MB state the main-thread export is 2.3 ms, the WASM ChaCha20 seal 141 ms (worker) and the IndexedDB put 31 ms, linear in the whole state. #1774 already merges a received batch with one sort. The WebCrypto seal option is a design only, see [2026-10-12](#decided-by-the-user-on-2026-10-12-and-what-the-evening-left-open). **DECIDED 2026-10-18: skip it after a plain receive, ONLY after the Mi 9T crash measurement** ([WP-CHECKPOINT-SKIP](#decided-by-the-user-on-2026-10-18---every-design-question-answered); the measurement protocol stays in [open-questions](open-questions.md#decision-owed---may-a-drain-that-only-received-application-frames-skip-its-full-checkpoint-2026-10-13)). Still owed: what losing an application-only ratchet advance costs once the frame is acked. Then choose between "flush on a commit, a welcome, hide and logout" and the current per-drain flush ([mlsStatePersister](../../frontend/src/lib/mls-client/mlsStatePersister.ts)).

### P1 - a history replay saves its stream cursor BEFORE the checkpoint it claims to follow (found 2026-10-21 by the review of #2078; present since the non-awaiting flush of f391c1991, 2026-08-14)

`mlsBulkIngest.ts`, `history.ts` and `useConversations.svelte.ts` all state that closing a bulk-ingest window resolves only after the encrypted checkpoint landed, so the replay's stream cursor and seen hashes are saved "never ahead of persisted state". It does not: `mlsStatePersister.onBulkIngestEnd` starts the flush without awaiting it (deliberately, so durability never gates delivery), and a nested window returns at depth > 0 with no flush until the outermost one closes. So on every build since then the cursor is saved ahead of the disk for the duration of one checkpoint (about 100 ms on web, more on a big state). A process killed in that window leaves a cursor past a commit that a cold replay never applies: the `wrong-epoch` / epoch-gap class. **Not measured in the field, found by reading.** Fix candidates, to choose with the reviewer: the replay window (not the live drain) awaits its flush, or the cursor is written by the persister itself once the checkpoint lands. The inert measurement switch of #2078 does not touch this (it never skips a replay window); it only makes the existing hazard impossible to widen.

### P3 - 80 roster reads per connection for the stray-leaf sweep

**Merged as #1806, shipped in `v1.2.7`**: one `POST /api/mls/group-rosters` per connection ([chat-delivery](services/chat-delivery.md#many-rosters-in-one-read---post-apimlsgroup-rosters-2026-10-13)). Owed once shipped: the per-connection count on a production console (expected 1 request where there were 80-81).

### P3 - an avatar 404 is the only way to learn a person has no photo

10 of 28 avatar reads answered 404 on one load. The client already keeps the absence for the session; removing the first ask needs the user record to say whether a photo exists, which only MiGallery knows.

**Built (2026-10-14; Canari's half merged as #1840 and shipped in `v1.2.9`, MiGallery's on its `feat/avatar-presence-batch` branch)**: one presence question per list ([core-service](services/core-service.md#which-faces-exist-asked-once-per-list-2026-10-14)). MiGallery ships first; Canari tolerates its absence. Owed once both ship: the salon walk's count on a console (0 avatar `404`s expected, 37 before). Delete this entry then.

## Seen in the 2026-10-12 heavy-state performance audit - what is open

Ranked, measured and located on [performance-audit-2026-10-12](frontend/performance-audit-2026-10-12.md); five draft pull requests carry the rest (#1771-#1775).

### P2 - the web checkpoint is 82 % WASM ChaCha20 seal - BUILT, WRITER OFF (draft PR, 2026-10-12)

The framed `state_blob` v2 (WebCrypto AES-GCM on the web, read by `mls-core` everywhere, opened by WebCrypto in the browser) takes a 7.7 MB checkpoint from ~198 to ~47 ms and the cold-start load from ~240 to ~97 ms ([performance-audit](frontend/performance-audit-2026-10-12.md#the-webcrypto-seal-v2---measured-2026-10-12)). **READER FIRST (#2074, review 2026-10-23): the HARDENED reader ships, the writer stays OFF** - a WebCrypto refusal is `unreadable_now` and re-read, never `STATE_ALTERED`, and the verdict on the bytes comes typed from `mls-core` ([mls-protocol](protocols/mls-protocol.md#v2---the-browser-seals-with-webcrypto-every-platform-reads-it-2026-10-12)). Why the writer waits: `v1.2.7` turns a refused v2 blob into a PIN-recovery prompt and `v1.4.0` into `STATE_ALTERED`, which rotates the identity irreversibly - [the PIN-rotation P1](#p1---a-damaged-local-mls-state-is-reported-as-a-pin-rotation-and-the-pin-the-user-actually-holds-does-not-get-them-back-in-measured-2026-09-08) again, for any v2 blob reaching such a build (an old tab re-initialising, a web rollback). **Owed, in order:** (1) the release carrying #2074 reaches a stable tag; (2) production's `minClientVersion` AND the allowed web rollback floor are both set at or past that tag (today `minClientVersion` is `1.2.7`); (3) ONLY THEN the flip of `MLS_STATE_SEAL_V2_WRITER_ENABLED` to `true`, in its OWN pull request, an alpha first and read on both bench phones' BROWSERS (user, 2026-10-18), with the reader enumeration of mls-protocol re-checked on `main`; (4) once a stable carries the flip, delete the encrypt worker and `encryptMlsStateOnMainThread` (kept until then so a revert stays one line).

### P2 - unreadable right now on every start has no exit but the user

A web state that WebCrypto refuses and `mls-core` does not prove altered (`unreadable_now`, #2074) is re-read 3 times per start and then stops the login with the blob untouched - with no exit in code if the same browser refuses it on EVERY start. Decided, not forgotten: no silent repair (installing what `mls-core` opened is a second load path behind a failed primary one; rotating is the irreversible loss the branch refuses). The remedy is the user's and `auth_local_state_unreadable_now` names it: free memory, restart the browser; meanwhile the app or another browser (other devices); support before any reset ([mls-protocol](protocols/mls-protocol.md#v2---the-browser-seals-with-webcrypto-every-platform-reads-it-2026-10-12)). **Owed:** it can only happen once a v2 blob exists, so after the writer flip ([the P2 above](#p2---the-web-checkpoint-is-82--wasm-chacha20-seal---built-writer-off-draft-pr-2026-10-12)) - count the `stayed unreadable after 3 reads` and `bytes that mls-core OPENS` lines per browser, and only if one recurs, decide what the product offers after N starts (an explicit, user-chosen reset; an export first). Nothing before a measurement.

### P2 - IndexedDB message pages read the whole conversation

`getMessagesPage` `getAll`s every row to return 50 (28-31 ms for 5000 rows); needs a `[conversationId, timestamp]` index (an IndexedDB version bump) and a reverse cursor. SQLite sorts in a temp B-tree for want of `(conversation_id, timestamp)`.

**Merged as #1998 (2026-10-18), in `v1.3.0-alpha.1`, no stable yet**: IndexedDB v11 and `idx_messages_conv_time` ([performance-audit](frontend/performance-audit-2026-10-12.md#findings-5-9-and-10---built-2026-10-17-draft-pr-perfpk13-message-storage)). Owed once shipped: the per-page time on a 5k conversation, and no `[IDB] Migration v10->v11` error line on an upgraded browser. Delete this entry then.

### P3 - a Welcome re-runs the whole restore

`sessionAuth.ts:1351,1364` call `loadAndRestoreConversations` per Welcome; a new device joining 80 groups restores 80 times.

**Built (2026-10-18, draft PR `perf/welcome-restore-once`)**: one restore at a time, at most one queued behind it, so a burst of Welcomes costs two restores ([performance-audit](frontend/performance-audit-2026-10-12.md#finding-8---built-2026-10-18-draft-pr-perfwelcome-restore-once)). Owed once shipped: the count of `[RESTORE] ... seeded` lines on a new device joining many groups. Delete this entry then.

### P3 - the thread's render window only grows, with listeners per bubble

`renderWindow.ts` never shrinks the mounted range; each `MessageBubble` adds a non-passive `touchmove` listener. Owed: a DOM-node and listener count on a seeded 5k thread, which decides whether the grow-only window (deliberate, see `renderWindow.ts`) is worth reopening. **The per-bubble `matchMedia` and window `keydown` are gone (#1998, in `v1.3.0-alpha.1`)** ([performance-audit](frontend/performance-audit-2026-10-12.md#findings-5-9-and-10---built-2026-10-17-draft-pr-perfpk13-message-storage)).

### P3 - the seen-cipher ledger is re-stringified per received frame

**Merged as #1998 (2026-10-18), in `v1.3.0-alpha.1`, no stable yet**: the live mark is written at the checkpoint, with the replay's ([performance-audit](frontend/performance-audit-2026-10-12.md#findings-5-9-and-10---built-2026-10-17-draft-pr-perfpk13-message-storage)). Owed once shipped: no new `frame never read here` line on a cold start after a drain (TAB-3b). Delete this entry then.

### P3 - native checkpoints hold the MLS mutex across export, seal and file write

**Fixed by #1826, shipped in `v1.2.7`**: the manager lock spans the export only, the seal and the write run on the copy ([performance-audit](frontend/performance-audit-2026-10-12.md#finding-12---the-manager-lock-released-at-the-export-2026-10-13)). Owed: the Mi 9T's `[MLS] checkpoint: manager lock held N ms` debug line on the same walk. Delete this entry then.

## Open defects, in severity order

### P1 - owed: ONE live reading of the in-session join fix (2026-10-08)

The fix is built ([chat](frontend/modules/chat.md#a-community-joined-in-session-is-listed-whole-2026-10-08)): a community new to the device is hydrated by the full listing. Owed: `bun unread-communities.mjs run join` on W1/W2 (written, not run), and one look at a join through the deep link on iOS/Android, private salon the joiner may read included.

### P2 - the unread counts of salons ride a date, not a baseline (2026-10-08)

`UNREAD_TRACKED_SINCE_MS` (`channel.service.ts`) floors the server's count for a salon the member has no read mark in, so history from before marks existed (2026-09-29) is not called unread. Messages posted between that date and the deploy of `unread-counts` count for a never-opened salon, which is true. **Shipped 2026-10-18 (WP-SALON-UNREAD):** the membership notice is sent silent and muted salons (`none`) count nothing ([chat](frontend/modules/chat.md#a-muted-salon-and-a-membership-notice-raise-no-badge-2026-10-18)); owed one device reading. Open: notices written before that, and those still sent by inviters on older clients until the floor reaches this build, stay counted until the salon is opened; unmuting brings back into the badge what arrived while muted (decided: a mute is not a read); `mentions` level still counts (the row is encrypted); and the in-session mark of a phone with the app asleep still depends on the 2 s receipt debounce.

### P2 - some CAS returns reach MiConnect with no code and no state, and a client can stay out (diagnosed 2026-10-09)

Read end to end on 2026-10-09 ([authentik](infrastructure/authentik.md#the-hand-built-configuration-audited-2026-09-29),
last bullet): **52 % of the failing requests are server-side probes, not people**, the flow heals itself
once for a browser, and one Android client failed three times in a row. The CAS is not ours and no request
goes to its owner (user, 2026-10-10): the remedy is on our side, a MiConnect flow that restarts the
authorization instead of failing. **Owed**: **the MiConnect server's container log is unreadable since the
2026-10-07 restart (NUL bytes in the json log)**; a recreate of the container restores it, and only then
can the browser failure rate be re-counted without the probes.

### P3 - in the SWIPE-CHECK conversation both media show "Format non supporte" on the Mi 9T (2026-10-06)

Both media show "Format non supporte / Telecharger" on the Mi 9T while the iPhone lists them as
"[Media]". Unexplained; the swipe half of that report is fixed
([mobile](frontend/mobile.md#a-modal-closed-by-its-owners-state-left-the-overlay-stack-and-the-tab-swipe-stood-down-2026-10-09)).
**The refusal now logs its cause (2026-10-18, draft PR `fix/voice-player-error-log`)**; owed: that
`[voice] ... refused its source` line from the Mi 9T on the conversation, which decides the fix
([chat](frontend/modules/chat.md#format-non-supporte-names-its-cause-in-the-log-2026-10-18)).

### P1 - Graine v2 - an author that is proven, and a ciphertext bound to its place (decided 2026-09-28)

v1 proves nothing about who wrote a salon message or where; the table is
[channel-encryption §7](protocols/channel-encryption.md#7-what-the-server-can-still-do-stated-rather-than-implied),
the design [§21](protocols/channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28)
(all three decisions of 2026-09-28: the whole of it, a relayed endorsement, the DMs included).
**EVERYTHING TO BUILD IS BUILT (re-verified against `main` 2026-10-14)**: the reader R1 (G2-0 to
G2-4b), the verified MLS sender that covers the DMs (G2-1b, web and native), the writer G2-5
(`v1.0.3`), the refusal of an arriving v1 seed G2-5b (`v1.2.6`), and the server's refusal of an
unsigned row ([§21.8](protocols/channel-encryption.md#218-the-server-refuses-an-unsigned-salon-row-2026-10-13),
#1802). Settled: the floor is `1.2.7` since 2026-10-17, past `1.2.6`, so no admitted build accepts a
v1 seed any more; and GRAINE-AUTH-4 is a unit test, not a rig row
(no mutating dev hook). **The chantier closes when the three rows below are done**; what is left
after that is a dated shim, and it lives in [legacy-compatibility](legacy-compatibility.md) alone.

| What is owed | Blocked on |
| --- | --- |
| §21.8 in production, then the count re-run (§21.8's SQL: 0 unsigned rows a day after the deploy) | the stable `v1.2.7` (the user's gesture); on dev since `v1.2.7-alpha.1` |
| The rig: GRAINE-AUTH-1..3 and -6 re-run (the runner changed, `rows.mjs` flags them) and -7 first run, all on one estate carrying #1802 ([board](cross-client-testing-archive-1-4-0.md#20---graine---an-author-that-is-proven)) | a running local estate (none was up on 2026-10-14, so nothing was run) |
| One reading on a device of the native v1-seed refusal lines (Kotlin `REFUSED N v1 seed(s)`, the NSE's `openSeedFrame: REFUSED v1 seed(s)`), compiled and never run ([§21.7](protocols/channel-encryption.md#217-an-arriving-v1-seed-is-refused-wp-g2-5b---the-floor-reached-the-writer-2026-10-11)) | a pre-floor v1 frame replayed to a phone, the only path that reaches them |

The v1 reader, the nullable `signature` column and the edit trust level of
[§21.5b](protocols/channel-encryption.md#215b-what-a-salon-edit-trusts-2026-10-05) (G2-6b) all go
together when production counts 0 unsigned rows (373 on 2026-10-14; revisit 2027-10-13), in
[legacy-compatibility](legacy-compatibility.md). Not Graine work, noted where it was found: `listMessages`
with a `before` cursor omits edit and reaction rows made after the cursor, which matters only if a
channel ever gets an older-page load.

What v2 does not close: the server can still admit a device it controls or publish a false device key
(BasicCredential's limit, §21).

### P1 - a returner's devices: one reading owed (shipped in `v0.18.26`)

The election reads presence and waits for an online holder ([channel-encryption](protocols/channel-encryption.md#wp-33-and-the-answerer-nobody-elects)). **Owed:** a reading of the returner's devices (`[GRAINE] asked <online member>` or `wait for a holder to come online`, then the salon filling); the second community of 2026-09-24, member by member; an end-to-end harness row. **Residue, not fixed:** a backgrounded Android can hold its socket and look online while unable to answer - the elected member is then silent and the next start re-asks.

### P3 - MiConnect: one string left after the French pass

The layout, flat pass, French prompts, redirect to Canari and signed-in `continue` are SHIPPED
([authentik](infrastructure/authentik.md#one-language-french-in-the-ecosystems-tu-2026-09-25)). Left:
authentik's own untranslated "Go back". **One observation owed**: `miconnect-auth` opened while signed
in, on the Mi 9T, should go straight through.

### The MLS audit items that are still real, with their verified counts (swept 2026-09-12)

**Work to the swept numbers, never the audit's** (eight came back LARGER than claimed). The duplicate
half is gone ([triage](protocols/mls-graine-state-machine.md#8-several-paths-to-one-thing---the-duplicates),
[durable-rules](durable-rules.md#an-open-item-whose-substance-has-never-been-in-the-repository-is-not-an-open-item));
what follows is the whole of what is left.

**Availability dead ends - every one needs an exit that EXISTS** (user, 2026-09-12: *"on ne peut pas
demander a un utilisateur de sortir de l'impasse lui-meme. La sortie de l'impasse doit exister pour
garantir la disponibilite"*, scoped to availability rather than deliberate refusals):

| Item | The state | Population |
| --- | --- | --- |
| an outbox entry with no terminal state | the two permanent dispositions are `group-deleted` and `evicted`; a group nobody can repair is **neither**, so a held entry stays pending for the life of the install | the counter it needs exists (2026-09-14); what is missing is the PROOF a terminal disposition may be taken on, and a clock is not one |
| `R-E9`, `R-E11` | peer-unresolved; `readWelcomeOwed() === null` | retried for ever, no counter |
| `DE7` | a saved state that will not open | the ALTERED half rotates with no PIN since step 2 (PK1, unshipped); a LEGACY blob still offers only the old PIN or the reset until its first rewrite |
| `G-E10` | `forgetCommunityGraine` with no runtime | warns, returns 0; seeds and joined groups stay |

### P1 - a damaged local MLS state is reported as a PIN rotation, and the PIN the user actually holds does not get them back in (measured 2026-09-08)

Typed errors, the honest message naming the reset, and the blob-header READER (step 1) shipped in
`v0.18.18` (#901). **Step 2 is BUILT (PK1, 2026-10-17, unshipped until a tag carries it)**:
`minClientVersion` is `1.0.3`, past the reader, so `encrypt_state_blob_with_key` frames every save
and a failed load is classified from the header - `STATE_KEY_MISMATCH` (`rotated`: the old PIN opens
it, and the gate now says so) or `STATE_ALTERED` (`altered`: the header names the key in hand, no PIN
ever opens it, so `init` rotates the device identity like a `mismatch` - DE7's route without the old
PIN). It is NOT a re-enrol fallback: only the fingerprint routes to the rotation, and a legacy blob
still pauses as `undecryptable` until its first rewrite. The init throws typed errors
(`SavedStateUnopenedError`), so `serverProse.test.ts`'s allowlist is empty. The mechanism is on
[mls-protocol](protocols/mls-protocol.md#the-state-blobs-framing---read-first-write-later). **Owed:
the CORRUPT-2 rig row on a local estate running the branch** ([cross-client-testing](cross-client-testing.md),
runner `tools/cross-client-harness/archive/corrupt2.mjs`) - its expected verdict is now a ROTATION
with no PIN asked, not the old-PIN gate. **Downgrade: no client may be rolled back past `v0.18.18`.**

### P2 - the legacy cotisation rows are LOADED on both estates, and NOT ONE claim has been observed (shipped 2026-09-11, v0.17.1)

1429 rows are staged on dev and on production; the projection (60 production accounts will be granted
at their next sign-in, 248 close `already-held`) is on
[cotisations](cotisations.md#what-the-load-did-projected-on-production-shipped-2026-09-11-v0171). What
is missing is a single observed claim: the next sign-in should move `/admin/legacy-cotisations` off zero
in the claimed tab, and until it does an empty screen and a broken claim look identical. The service
log line and that page have never been read against a real claim.

### P3 - message notifications share one group key across conversations (measured against Messenger, 2026-09-09) - a DECISION owed to the user

The conversation shortcut shipped (#1448). **What remains:** `GROUP_KEY_MESSAGES` is ONE constant at three call sites of `CanariFirebaseMessagingService.kt` with one summary (id 9999), while Messenger keys per THREAD. A placement difference only, and **not built on purpose**: per-thread keys mean one summary per conversation, and that single summary also carries the launcher badge count (`refreshBadgeSummary`, WP-XP-2) and already shipped one defect where cancelling it took its children with it (NOTIF-18, 2026-09-21). Say so if the placement is worth that rewrite; the measurement is the shade on the Mi 9T, which nothing in CI sees.

### iOS stacks the reactions to a post and does not merge them: DECIDED 2026-10-18, no work

The iPhone keeps its native stacking under `post_reaction_<postId>`; no NSE merge ([mobile](frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)).

### P3 - a revocation round trip sits in front of the fingerprint prompt, and moving it is REVERTED, not to be re-opened (measured on the Pixel 6a, 2026-09-15)

Three of the four causes of a slow launch-to-prompt are fixed; **the fourth, `isDeviceRevoked` in front
of the prompt, STAYS** - why it may not move behind `init()` and the three shapes weighed are on
[cold-start](frontend/cold-start.md#the-revocation-gate-stays-in-front-of-the-prompt-and-the-launchs-console-noise-is-explained-pixel-6a-2026-09-15).
**MEASURE BEFORE CHOOSING, and that is not a deferral**: the refresh was 132 ms, the probe was never
timed alone, and the `mls.bin` block that dominated everything is gone as of `v0.18.3`. If the remaining
budget is not dominated by these two round trips this is the wrong first target.
`bun tools/cold-start/launch-trace.mjs --heartbeat` on the Pixel 6a says so, with a build pointing at an
environment where that device HAS a session.

### P2 - the MLS init waited ten seconds behind twenty-four avatars on `v0.18.5`, and nothing has re-read that window on a cold PHONE (measured on production 2026-09-16)

The avatars are edge-cached and batching them is REFUTED
([core-service](services/core-service.md#the-avatar-proxy)); the browser re-reading on `v0.18.16`
puts MLS ready at 968-1182 ms, so the window did not reproduce
([cold-start](frontend/cold-start.md#the-split-answered-on-the-day-it-shipped-an-ordinary-boot-is-968-ms-and-mls-load-state-is-8-of-it-2026-09-20)).
**Owed**: one cold start on a phone, whose console lines bracket themselves (`+<ms>` since #742) -
write no marks. **Do not "fix" it by lowering the avatars' fetch priority** (advisory, per-engine,
would make the measurement unreproducible).

### P2 - a CHANGED PROFILE PHOTO: `no-cache` + ETag SHIPPED (2026-10-08), ONE EDGE READING OWED

The shape and the layers table are on
[core-service](services/core-service.md#no-cache--the-upstream-etag-and-the-busted-url-it-did-not-need-2026-10-08).
**Owed, then delete this entry**: after the deploy, `curl -sI` a face twice through `canari.emse.fr`
and confirm Cloudflare revalidates (`cf-cache-status` not a `HIT` with a growing `Age`), then change a
photo in MiGallery and watch it appear. If the avatar Cache Rule overrides the origin, the fix is that
rule.

### P3 - THE TWO OPENING LINES BELONG TO THE DOCUMENT THAT IS LEAVING (production, 2026-09-16)

#754 shipped (`beforeunload` as well as `pagehide`;
[auth](frontend/modules/auth.md#and-what-is-not-a-reconnect-the-page-leaving)). **Owed: ONE Firefox
reload of a build carrying it** - are the two outgoing-page lines (`+15269ms` stamp, the previous
build's `app.*.js`) gone? If not, Firefox closes the socket before dispatching any event: no DOM event
can discriminate, and the lines are to be EXPLAINED where they are read, never suppressed.

### P3 - ONE MAINTENANCE PASS IS ON THE AWAITED PATH, BLOCKED ON A FACT NOBODY HAS DEFINED

`prune_expired_key_packages` costs **10.08 ms** at a 1000-bundle pool (criterion, workstation; 88 % is
`serde_json` decoding, [cold-start](frontend/cold-start.md)) inside `load_or_create`, in front of the
first screen - NATIVE ONLY. It is maintenance (what it deletes must be deleted and nothing else deletes
it), so moving it needs a TRIGGER, and a clock is forbidden. **The blocking condition**: name a durable
fact, carried in the state blob rather than inferred, that says *this pool has been pruned since it last
changed*, and prune when it is absent. Until then the pass stays, because a pool that silently stops
being pruned makes the prekey P1 worse. **Re-derive before quoting** the old "82.7 % of post-login": on
2026-09-20 post-login is 282 ms, that call 74 ms (26 %) and `revocation-gate` 123 ms (44 %).

### P2 - THE NETWORK FOR THE JAVASCRIPT IS SOLVED; 1.62 MB OF IT STILL HAS TO BE PARSED BEFORE ANYTHING RUNS (measured on production 2026-09-16)

Two chunks (the chat engine, 404 879 B, and the protobuf codec, 146 160 B) are 44 % of what `/login`
loads, through ONE static import in the root layout (`+layout.svelte`, `globalChatSingleton`);
measurements and what NOT to do (touch the preload header, merge chunks) are on
[cold-start](frontend/cold-start.md#the-javascript-is-parsed-before-anything-runs-the-delivery-is-solved-measured-on-production-2026-09-16).
**THE NEXT STEP IS STILL A MEASUREMENT, NOT A REFACTOR**: the user's next cold-start export says
whether parse time is the dominant term (the gap between the first console line and `Initialised in WEB
mode`). Splitting the root layout's chat import changes the thing that keeps the session alive across
navigation, and buys nothing on the route the target is measured on.

### P3 - a second package id, so a pre-release can be measured against production (decided 2026-09-15)

To do, in this order: the user adds `fr.emse.canari.dev://callback` to the Canari OIDC client and a second FCM app and Play listing for `fr.emse.canari.dev`; then an agent adds the Tauri config overlay and the `android.yml` artefact choice. The frontend already spells the id once (2026-10-04). Steps and reasons: [dev-environment §9](infrastructure/dev-environment.md#9-a-pre-release-cannot-measure-production-state---the-second-package-id-decided-2026-09-15).

---

## Reported by the USER on 2026-09-27 - the community settings panels, and two community defects behind them

Shipped in `v0.18.28`; what is left is readings, one decision, three test rows and one native change.

- **Readings owed** - web and the Mi 9T: a salon add survives a reload, the roles tab is one card per
  role ([social-service](services/social-service.md#roles-membership-and-channel-access)). The Pixel
  6a: a salon message in Gala with the phone shut, `fetchCommitsFromBackend` answering 200 before the
  banner ([channel-encryption §16](protocols/channel-encryption.md#16-a-shut-phone-one-commit-behind-could-never-catch-up-in-any-community---fixed-2026-09-27)).
  The iPhone: `NOTIF-20`'s NSE half ([channel-encryption §19](protocols/channel-encryption.md#19-design-the-seed-travels-with-the-message---decided-by-the-user-2026-09-27)).
- **P1 - DECIDED BY THE USER 2026-10-22 (*"Oui, rejoindre au push"*) AND BUILT: a shut Android
  phone joins a salon's key group from the push; iOS joins at the next foreground**
  ([channel-encryption section 26](protocols/channel-encryption.md#26-a-shut-phone-joins-a-salons-key-group-from-the-push---decided-by-the-user-2026-10-22)).
  Owed: the Mi 9T reading (generic banner, `settled joined`, the next push readable,
  `[KEY_GROUP_PUSH_JOIN] ... registered` at the next start) and the iPhone reading (the join at the
  next foreground). The original question: should a phone join a salon's key group from the PUSH, as
  it joins a DM from a Welcome? Two Gala members (`76198d2d`, `7bc0efc7`) held no device in the key group: the seat is
  committed by the member's own device when it LOADS the community, and theirs never had (read on
  production 2026-09-27 21:00, `0.18.15` and `0.18.22`), so every salon push reached them unreadable.
  Production check, read-only: whether either now holds a key-group row (`dm_group_members` for
  `17d0281e`).
- **Three DM/salon test pairs owed (user, 2026-09-27: one contract for a salon and a conversation)** -
  the same row on a DM and on a salon, plaintext on both: right after a membership change, a sender's
  first message, a new device. `NOTIF-2`/`NOTIF-19` is the pair that exists
  ([board](cross-client-testing.md)).
- **P2 - the Rust half of a push handled in a KILLED app logs nowhere**: `tauri_plugin_log` installs
  the logger when Tauri starts; a push in a dead app calls Rust through JNI without it, so every
  `[PushBG]` line is lost. `JNI_OnLoad` (`lib.rs`) installs no logger; one installed there would take
  the global slot from the plugin at a normal start, so the two must be reconciled, not stacked.

## Reported by the USER on 2026-09-18 and 2026-09-17 - what is still owed

The mechanisms are on [mobile](frontend/mobile.md#one-builder-two-triggers),
[chat](frontend/modules/chat.md#a-voice-note-declares-itself-because-nothing-downstream-can-tell) and
[posts](frontend/modules/posts.md#who-sees-which-control-three-served-booleans-never-authorid).
**No identity from the users' captures enters this file.**

- **G1 - one human reading of a DESKTOP banner**: what a salon and a DM notification say, and where a
  tap lands.
- **P3 - BUILT 2026-10-18, NOT SHIPPED: the push scanner's sentences are worded in Rust from the app
  language, and a declared voice note is announced as one** (`mobile/push_text.rs`,
  [chat](frontend/modules/chat.md#a-voice-note-declares-itself-because-nothing-downstream-can-tell)).
  Owed: an Android and an iPhone reading with the app set to English (a reaction, a photo, a voice
  note); the iOS FFI and the Kotlin/Swift callers are verified by compiling only.
- **P2 - one observation: the post its publisher could not delete (2026-09-17)** - the post's URL, or
  whether its publisher held `POST_AS_ASSO` on that association.
- **P2 - one observation: the member who could not publish (2026-09-21)** - once he is past `0.18.14`
  (still there 2026-09-23), whether the composer, which now names its failing stage, refuses him
  anything ([posts](frontend/modules/posts.md#one-catch-said-seven-things)).

## Notifications - one builder on Android since 2026-09-18, and the rows that still owe it a run

### P3 - THREE SERVICES REFUSE AN UNSIGNED CALLER THREE DIFFERENT WAYS, AND MERGING THEM IS A POLICY DECISION

Owed to the USER: a written decision of which refusal is intended, before any file is touched, and
whether `X-Internal-Token` is required outside production too. The table of the four guards and why
picking one changes what the others refuse is on
[core-service](services/core-service.md#three-services-refuse-an-unsigned-caller-three-different-ways).

### P2 (hardware-owed) - a FIRST message from someone you have no conversation with, measured end to end (user, 2026-09-08)

Both halves are fixed since `v0.18.18`; nothing has run them on a genuine first contact. Owed:

1. **Enrol a third account** (`canari-test-gamma` exists on Authentik, credentials out of tree): a
   first sign-in through the app, a Chrome profile with its `PORTS` / `ORIGIN` / `ACCOUNT_OF` entries,
   and a third identity in `names.mjs`
   ([harness entry](#p2---the-rig-can-express-exactly-two-identities-and-the-third-and-fourth-accounts-now-exist-measured-2026-09-10)).
2. **One run**: A1 backgrounded and alive, the new peer starts a conversation and sends one message;
   read the shade, whether the tap lands, whether the conversation is in A1's list WITHOUT a
   restart, and `builtBy`. Then the same with an INVITATION into a community, and once with A1 COLD.
3. **NOTIF-17b re-run on the `admits` route** (a device added while offline is a recipient of the
   next message).

### P3 - NOTIF-6c / NOTIF-6d: the quick reply from a BACKGROUNDED shade, and a reply that fails to send

Owed on the Mi 9T against a pushing estate (the local one; dev has no Firebase): `bun archive/k.mjs`, answer the shade by hand. NOTIF-7c/7d (tap into a salon) PASSED 2026-10-08 and NOTIF-11 PASSED 2026-09-07; NOTIF-12 only records ([board](cross-client-testing-archive-1-4-0.md#14---notif---notifications)).

### P3 - notification taps: what the 2026-10-08 audit left open

Matrix and reasoning: [mobile](frontend/mobile.md#what-every-notification-opens-and-what-was-measured-2026-10-08).
Fixed on a branch (not shipped until released): a proposal push opened the feed, three notices had no switch, a
browser salon notification clicked through `/chat`. Open:

1. **P3 - a comment, reply or mention opens the post, not the comment.** BUILT on a branch (2026-10-17): the push carries `commentId` and the post page scrolls to it ([mobile](frontend/mobile.md)). Owed: one tap on the Mi 9T and the iPhone 12 landing on the comment; the in-app bell row still stores no comment id.
2. **P3 - the Android manifest and `tauri.conf.json` declare five hosts; the page hosts a push writes (`posts`,
   `calendar`, `admin-agenda`, `proposals`) rely on the explicit intent of the notification.** Read it once on the Mi 9T.

The two questions of the audit are answered (2026-10-08): a follow keeps its meaning, a per-association mute exists, read-grant holders stay unannounced - [social-service](services/social-service.md#follow-mute-and-read-grants-three-different-facts-decided-by-the-user-2026-10-08).

## CI and the chain that runs unattended

### P3 - audit advisories are suppressed because they cannot be reached, and retire themselves

Four advisories (`GHSA-vcc3-ghjq-m6fr`, `GHSA-528h-pc64-c93x`, `GHSA-hqr4-qq8f-hg3x`,
`GHSA-mjw6-4jj6-33hc`) are ignored on the `minio > ...` edge of media-service; minio 8.0.7 is still the
latest (2026-10-10). **Nothing is polled by hand any more (2026-10-10):** the premises step of
`code-analysis.yml` audits the tree WITHOUT the ignores (`ignored-advisories-still-reported.sh`, self-tested)
and FAILS the day an ignored id is no longer reported, naming the ignore, its premise assertion
(`.github/scripts/stream-json-premise.sh`) and this entry as what to delete. The reasoning is in
[cicd](cicd.md#four-audit-advisories-are-suppressed-on-one-edge-of-media-service-and-why-each-is-unreachable).

`RUSTSEC-2026-0387` (crypto-bigint 0.5.5) is ignored in all four Rust trees since 2026-10-24, each
with its statement in `.cargo/audit.toml`; REACHABLE IN CODE in call-service's DTLS only. Lifted by the
webrtc 0.21 port and p256 0.14 reaching jsonwebtoken and openmls_rust_crypto; the cargo retirement
step fails when it is gone ([cicd](cicd.md#the-rust-ignores-live-in-cargoaudittoml-and-retire-themselves-too-2026-10-24)).

### P3 - the $lib alias migration waits for a quiet frontend (2026-10-27)

SvelteKit 3 deprecates `alias: { $lib: 'src/lib' }`; the deprecation warning prints on EVERY build and sync. The fix is `bunx sv@latest migrate sveltekit-3 --tasks lib-alias`: 1567 files, 7645 imports gaining a `.js` extension. Tried and reverted on 2026-10-27 because it conflicts with every open frontend pull request. **Do it as ONE mechanical commit while the frontend is frozen; trigger: the open frontend pull requests are few.** It removes the alias in `kit.config.js` and, on Windows, the false `tsconfig_invalid` warning ([architecture](frontend/architecture.md#sveltekit-3-and-adapter-node-6-2026-10-27)).

### P2 - TWO of the hosts that take security updates are not reported on, and a library nothing restarts (the rest closed 2026-09-03)

The mechanism and report exist since 2026-09-03 ([host-updates](infrastructure/host-updates.md)). **The shared
Portail-etu host is judged on OUR questions only since 2026-10-10** (`POLICY_OWNER=host-admins`: timer ran, no
security update pending, no reboot owed; its origin list and unreadable log belong to the School and are
printed, not judged - the daily run was red for ever on facts nobody here may change). Open, each with its
retirement condition in [host-updates](infrastructure/host-updates.md#what-stays-open-the-reports-reach-the-raid-channel-and-libraries-nothing-restarts):

1. the report reaches that host and no other (`mitv`, `cercle`, `miconnect` are the user's old VMs, unreported) - a runner key on them is the user's decision;
2. `mitv`'s 7.3 TB RAID1 has a sensor (`mdmonitor`) and no channel - `/proc/mdstat` into the daily report.

A library fix installed and not in effect (`needrestart -b` is blind as the runner's account) concerns the shared host only and is the School's to restart: not pursued.

## iOS, platform and runtime - the residue that fits no other section

### P2 - iOS carries none of the window-layout work Android already has (user, 2026-08-28)

**OWED - an iPhone re-read of the bars.** The code half shipped (#1242, #1261, #1289;
[android-ios-parity](frontend/android-ios-parity.md) 1.1, 1.3 and 1.4 are FIXED); what is owed is the
user's look at the status bar and the home indicator on the iPhone, with the liquid-glass chrome
([backlog](#the-liquid-glass-conversation-chrome---decided-2026-09-30-wp-g1-then-wp-g2)). This closes
by hardware, never by a fix against a suspected bug nobody has seen.

### P3 - the native refresh credential could live in the platform keychain, on BOTH platforms (2026-08-27)

An upgrade, not a defect; do it when native work is happening anyway. Why it is not trivial (a
non-biometric command in the vendored keystore plugin, Kotlin parity, an iOS build) is on
[sessions](sessions.md#the-native-refresh-credential-could-live-in-the-platform-keychain-on-both-platforms-2026-08-27).

### P3 - the last node runtime: four jest suites that will not run under bun (decided 2026-08-27, AFTER the campaign)

One spec (`admin-storage.controller.mls.spec.ts`) passes under node and fails under bun; porting four
NestJS services to `bun test` waits for the campaign ladder to reach the bottom
([cicd](cicd.md#the-last-node-runtime-four-jest-suites-that-will-not-run-under-bun-decided-2026-08-27-after-the-campaign)).

### P3 (blocked: calls held off) - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27)

Calls are UNVERIFIED, not broken; it becomes P1 the day calling is revived. What settles it is one
relay-path call, two peers, audio and video, TURN as production configures it, taken by hand (the in-process half of it runs in CI since 2026-10-09: `apps/call-service/tests/relay_path.rs`)
([calls](frontend/modules/calls.md#the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27)).

### P1 (blocks `CALLS_COMPILED`, not dev) - four things owed before production calls (review of #1997, 2026-10-17)

**The owner decided on 2026-10-21: the first production calls are AUDIO 1:1 ONLY, kept alive in the
background on both phones; video later.** The fifteen blockers (B0-B14) with their evidence, the
order, the one flip commit, the production preflight, the store answers and the owner's answers
of 2026-10-21 (no native ring in the first release; a server kill switch before the flip) are on [calls](frontend/modules/calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21),
the only copy. Built 2026-10-21: B0 (no video in production: the flag no longer follows `CALLS_COMPILED`, and `CallService` refuses every camera open and never shows a peer's video) and B4 (the `fp=`
line is a SHA-256 fingerprint). Of the review's four items below, F4, F5 and the per-direction key +
AAD are in draft #2013, which must be PORTED onto `main` (it predates #2158 and #2166).

Lot 1 calls dev builds only. Before the production switch flips: F4, the IP exposure of
`iceTransportPolicy: 'all'` and Cloudflare TURN as a recipient, written into
`compliance/register-of-processing.md` and `/legal/privacy`; F5, a key-epoch/fingerprint agreement
between the two ends, or a visible "decrypt failing" toast; one AES-GCM key used in both directions
with no AAD ([calls](frontend/modules/calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only)).

P3, owed by WP-C11 (group calls): `refuseIfBlocked` (`calls.service.ts`) lets ANY block between the
caller and ANY other member refuse the whole call, at `initiate`, `ring` and `room-token`, and 1:1 is
enforced only by the client. Acceptable while group calls are off; WP-C11 must decide whether one
block refuses the call or only drops that member
([calls](frontend/modules/calls.md#the-switches-agree-and-a-silent-frame-stays-unread)).

### P1 (blocks `CALLS_COMPILED`, not dev) - a call does not survive the app leaving the screen on either phone (2026-10-19)

The web half is done (full screen + top banner, timer from timestamps, Media Session, one audio
sink, a log line per background transition). What only native code can do, each a work package of
its own ([calls](frontend/modules/calls.md#the-call-in-the-background-2026-10-19)):

- **WP-C-BG-A (Android): BUILT 2026-10-20, draft PR, OWED THE Mi 9T READING** - a `microphone`
  foreground service (not `phoneCall`: that needs a `ConnectionService`), the ongoing `CallStyle`
  notification, `setCommunicationDevice` in place of `setSinkId` (the mode left to Chromium when
  Chromium set it), merged only into builds that place calls and checked absent from a stable's
  built manifest; started at the caller's `ringing` / the callee's `connecting` once the microphone
  is held. Twelve readings owed (the API 28-30 paths have no bench device); the Play declaration was
  filled by the owner on 2026-10-21: [calls](frontend/modules/calls.md#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20).
- **P3 - `canariCall` is an `addJavascriptInterface` bridge, reachable from ANY frame the WebView
  loads**, not only the app's origin. `WebViewCompat.addWebMessageListener` takes an origin
  allowlist and would bound it to the app's own origin. Today the WebView loads only the embedded
  frontend, and the methods can do no more than start, update or stop a call notification the app
  itself could, so this is hardening, not an open hole; it applies to every bridge `MainActivity`
  registers, not to this one alone, and would move them together.
- **WP-C-BG-I (iOS) - BUILT 2026-10-20, owed its hardware reading.** Measured first: a locked
  iPhone is NOT suspended (same pid, WebRTC stack alive, the partner's audio received) - only its
  microphone is muted, by WKWebView, for want of the `audio` background mode. So the fix is that
  mode on every pre-release build (`ios.yml`), the sixth switch for the stable, plus the partner
  told over the relay (`MicSuspended`) - no CallKit and no native audio session, neither shown
  missing ([calls](frontend/modules/calls.md#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20),
  which carries the owed steps). CallKit for every call stays with the `voip` revival.
- **Read on both phones before either was written** (`1.3.1-alpha.3` and `-alpha.4`, 2026-10-20,
  [device readings](device-readings-2026-10.md)): the Mi 9T loses its call socket and all audio 5 s
  into a lock (WP-C-BG-A's case); the iPhone keeps the call and loses only its microphone (WP-C-BG-I's).

### P2 - a call that never paired, and a ring for a call already hung up (2026-10-20)

CALL-PAIR-STALL and CALL-LATE-RING, met on the bench while measuring WP-C-BG-I, both after the
Mi 9T's chat socket had gone zombie ([device readings](device-readings-2026-10.md#found-on-the-way-not-filed-against-wp-c-bg-i)).
Owed first: the dev `call-service` log of that minute (did the callee's `Join` arrive?) and the
iPhone's exported log, before any cause is named.

### P3 - an OS incoming-call banner over the in-app ring, if it outlives the web fix (2026-10-19)

CALL-OS-BANNER: on the iPhone a foreground ring showed an "Appel entrant" OS banner over the
full-screen ring. The web's own local notification is now deferred while the page is visible
([calls](frontend/modules/calls.md#the-bar-is-never-under-a-layer-call-bar-covered-2026-10-19)).
Owed: one foreground ring on the iPhone. If a banner still shows, the two native candidates are
(a) the notification plugin's own `UNUserNotificationCenter` delegate presenting in the foreground
if it replaced `CanariNotificationDelegate` (which answers `UNNotificationPresentationOptionNone`
in the foreground, `canari_push.mm`), and (b) the server's ring push (`calls.service.ts`:
VoIP -> CallKit, or the FCM alert for a device without a VoIP token) reaching a device whose app is
on screen - a CallKit report cannot be skipped for a VoIP push, so that half is a server question
(do not ring a device whose socket is live and foreground). Read the log first: the `[NOTIF]` line
says whether the web path ran.

### P2 - what made the profile fetches fail on that device at that moment

Owed: the DENOMINATOR (the `(failed/attempted lookups failed this session, X%)` suffix on every
`displayName.ts` warn), read from a device or browser console during a run, then a decision about
`FAILURE_BACKOFF_MS` ([chat](frontend/modules/chat.md#profile-fetches-that-failed-on-a-device-and-the-denominator-that-is-owed-2026-08-16)).

---

## Messaging convergence

### P1 - the repair of a rewound sender lands on a coin flip, the ask cadence is identical either way, and a peer 21 messages behind was told "same state - nothing to do" (measured 2026-09-08, ten runs across three builds)

HEAL-repair heals 3 times in 10 because the server elects a random online member, one of three holds
the messages, and the walk stops on a peer's AGREEMENT. Open: specify the state the fix remembers
(WHAT, for HOW LONG, what discharges it - the repair landing) and exclude an agreeing peer while the
asker holds frames it cannot read. **Re-read 2026-10-09, STILL OPEN and NOT changed: the fix is a design
whose state is not specified (WHAT is remembered, for HOW LONG, what discharges it), the cause is measured
only on the local rig (ten runs), and production's half cannot be read from the server** - 32 h of
`[HISTORY_REQ]` held 423 `NO_PEER_ONLINE` against 54 `FORWARDED`, which is a population of askers with no
peer online, not the coin flip. What would settle it: a harness `HEAL-repair` batch with the asker's
election log beside it, then the exclusion-on-agreement change with its state written first. The
measurement, the root cause and the two refuted causes (not to be re-opened) are in [history-reconciliation](protocols/history-reconciliation.md#heal-repair-lands-on-a-coin-flip-the-measurement-and-the-root-cause-2026-09-08).

### P3 - the pull and the socket hand the SAME row in, and the queue notices afterwards instead of the overlap not existing (measured 2026-09-08)

Open: (1) the web overlap - the pull should not queue a row already queued for the device (a
membership test in the same module), after measuring the RATE (`notableCount` was 91 on one record);
(2) one on-device NOTIF-10 re-read of the generic-banner ledger (#1550); (3) BUILT in a draft pull
request (`take_fcm_cache` + `ack_fcm_cache`: read, persist, THEN clear). The analysis, who consumes the
generation and the withdrawn 2026-09-08 fix are on
[mobile](frontend/mobile.md#one-row-arriving-through-the-push-the-pull-and-the-socket-measured-2026-09-08-to-2026-10-06).

## Background notifications on Android - what the 2026-09-05 investigation left open

### P1 (hardware-owed) - an iPhone's salon banner for a session started while it was shut

Owed: ONE iPhone row. A silent `keyMaterial` frame never wakes the NSE, so on iOS the seed of a new
session can only come from the frame the salon push itself carries (channel-encryption §19, proved
on Android by NOTIF-20 stage B through the same ladder) - never measured on an iPhone. The count is
in place on both platforms since 2026-10-05: `[PUSH_BLIND] platform=ios` in the chat-delivery log
([channel-encryption §14](protocols/channel-encryption.md#what-is-left)). If the row fails, the wake
(an alert push for key material) is the decision it hands the user.

## MLS state, device healing and delivery - the defects the campaign measured

Open entries only; each carries a title, what is left and a link. The measurements, recurrences and
refuted readings are on [campaign-measured-defects](protocols/campaign-measured-defects.md), the
cold-start ledger on [history-reconciliation](protocols/history-reconciliation.md).

### P3 - the read-receipt half of the visibility fix is OWED a hardware pass (2026-09-05)

The notification half was verified on the device; the read-watermark half was not. Needs a W2-side DOM
read of `A1 read it` against a marker, not a count of `/api/mls/send`
([why](protocols/campaign-measured-defects.md#the-read-receipt-probe-and-two-instrument-problems-2026-09-05)).

### P2 - the Android background/resume sequence hangs on a visibility edge that never fires (owed ONE device run)

`handleVisibilityChange`, the `mls_foreground_heartbeat` interval and the resume reload must move
TOGETHER onto the native edge, after one Mi 9T run (background past the 30 s guard, send, return, read
whether the background engine delivered, the warm engine reloaded and the socket paused)
([the three pieces](protocols/campaign-measured-defects.md#the-android-backgroundresume-sequence-2026-09)).

### P2 - a cold start re-accuses frames it already read, because the ratchet advance is durable and its mark is not (TAB-3b `PASS-DIRTY`, 2026-09-08)

Open: the fingerprint mark must be one write with the checkpoint (or answered from MLS state) - **no
smaller fix**, an eager fingerprint mark is a silent real loss. Also unmeasured: which path spends the
generations, and the ~62 s timer before an offline device is handed a held message. The ledger growth
bounds shipped (#1592)
([argument](protocols/history-reconciliation.md#a-cold-start-re-accuses-frames-it-already-read-the-mark-must-be-one-write-with-the-advance-tab-3b-measured-2026-09-08)).

### P3 - HEAL-W2's break cannot take, because the live client writes its MLS state back over the restore (2026-09-06)

Open, harness side: arrange for nothing to execute between the restore and the load (a same-origin
document that boots no app is the candidate), and resolve the group NAME to its uuid
([detail](protocols/campaign-measured-defects.md#heal-w2s-break-cannot-take-2026-09-06)).

### P2 - FIVE rows watch a responder heal a device that no longer needs one (HEAL-NEW-11/-12/-15, MULTI-9; 2026-09-06/07)

Open: the rung needs a fixture that puts the subject in "owed a Welcome" rather than "holds a seat"; the
window that returned once on 2026-09-08 is unexplained, so the entry stands
([measurements](protocols/campaign-measured-defects.md#five-rows-watch-a-responder-heal-a-device-that-no-longer-needs-one-2026-09-06-2026-09-07)).

### P3 - the phone polls presence every ten seconds over a live WebSocket (2026-09-02)

Still so (`presenceStore.ts`). DECIDED 2026-10-18: presence is visible to those who share a conversation or community with the person, then the poll becomes a push ([WP-PRESENCE](#decided-by-the-user-on-2026-10-18---every-design-question-answered), [detail](protocols/campaign-measured-defects.md#the-presence-poll-logcat-2026-09-02)). **The audience half is BUILT and SHIPPED (#2031, `v1.3.0`); the push is NOT** - it needs a presence-transition event the gateway does not emit, a per-connection watch set checked against the audience, and a client that polls until the gateway proves it pushes ([chat-gateway](services/chat-gateway.md#who-may-see-whose-presence-wp-presence-2026-10-18)). This entry closes with the push, not before.

### P2 - a new device's join of a community's key group reaches the commit gate BEFORE its KeyPackage (2026-08-29, cause measured on production 2026-10-09)

**ONE defect, and the two entries that stood here were it.** All six `[MEMBERSHIP_ACTIVE] REFUSED ... no_key_package` of 32 hours of production were on four COMMUNITY distribution groups and no conversation; each device's first run logged `[PURGE_PREKEYS]` (its key package round starting), then the join's commit and its refusal in the same second, then `[REGISTER_DEVICE] START` - the join committed between the mint and the publication, so the gate wrote no membership row and the device held a tree that routed nothing to it ("holds the group, the group holds no row", the rejoin, the extra epoch). Three of the six healed 2 min to 1 h 44 min later (an iPhone among them: seeds unrouted for that long), the other three devices are gone. **Fixed in two steps, neither in prod yet (2026-10-10):** #1666 (`externalJoin` waits for the round running) is in `v1.2.2-alpha.1` only, NOT in `v1.2.1`; the pull request `fix/join-waits-for-published-keypackage` replaces that wait by a wait on the PUBLISHED FACT (the server's own "this device has a static KeyPackage", the row `deviceAddressability` reads) - a round settling during the read is re-read, absent with no round STARTS one, overlapping rounds refuse nobody, destroy releases the parked joins; no timer, no cache - and gives every HTTP call of the round a 60 s per-request deadline that turns a hang into a typed `DeliveryDeadlineError` (the one clock, and it only reports; the prekey count propagates it and fails the round). Not covered: the native `invoke` half of the Tauri round (cannot be aborted from JS). **Measured on prod since the `v1.2.1` deploy (13:13 UTC 2026-10-09):** key-group external joins about 77/day pace, unchanged from ~70/day (the release does not carry the fix); `REFUSED no_key_package` 2 in 9.7 h, both new devices on community key groups (web 1.2.1, iOS 1.1.0), `[SENDER_MISMATCH]` 0 ([detail](protocols/campaign-measured-defects.md#a-new-devices-join-reaches-the-commit-gate-before-its-keypackage-2026-10-09)). **Owed:** the same read once a stable carries the fix; raising `minClientVersion` for it is the user's gesture and needs a stable carrying it live in BOTH stores (Play serves `1.2.1` in production, read 2026-10-10; the App Store was not readable here).

### P2 - a roster seat without a Welcome: the reason is typed on the client, the server report cannot partition on it yet (prod 2026-09-01)

Open: a client-to-server write (migration) so `reportStrandedDeviceMemberships` can join the reason; read
the first real `skipped` lines before designing it
([detail](protocols/campaign-measured-defects.md#a-roster-seat-without-a-welcome---the-typed-reason-prod-2026-09-01)).

### P1 - the placeholder is GONE from prod; what it may have left in the MLS TREE is not answered

The server estate is clean; whether a leaf survives in the affected conversation (epoch 118) is
answered only from a member's own client, which reads the tree
([detail](protocols/campaign-measured-defects.md#the-placeholder-and-the-mls-tree)).

### P2 - a re-admitted device calls its own exclusion window a loss, and reconciles for it (2026-08-26, widened 2026-08-30)

Not built: an ENTITLEMENT FLOOR per group at every entitlement START (re-admission AND a fresh device after
a revocation wipe), keyed on the stream position or a surfaced frame epoch. Confirm with GRP-8 AND
HEAL-REVOKE-5. Never read "no fingerprint repeats across runs" as "new messages". **The policy question
is DECIDED (user, 2026-10-14): a Remove holds**, and answering peers now withhold every member's
window - so a withheld message is re-asked on every connection until this floor exists; the server
side of it, membership intervals, is migration `030`
([history-reconciliation](protocols/history-reconciliation.md#a-remove-holds-against-a-later-re-add---the-answering-peer-withholds-the-window-decided-by-the-user-2026-10-14)).
A sent message is now dated by the server's receive time; only copies written before that change are
undated, and those are placed by their client clock with a one-hour margin
([measurements and the discriminator](protocols/campaign-measured-defects.md#a-re-admitted-device-calls-its-own-exclusion-window-a-loss-2026-08-26),
[open-questions](open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add)).
**OWED TO THE USER - `minClientVersion`:** the withholding runs on the ANSWERING device, so an answerer
on an older build still sends the window unfiltered; the guarantee is complete only once
`minClientVersion` (1.2.7 today) reaches the build that ships it. Raising it is the user's call, not
an agent's. **And a known abuse, accepted with the decision:** a member can remove and re-add someone
to open an artificial window, making that span unrestorable to every new device while the person
stays; nothing tells it from a real removal.

### A device revoked while OFFLINE keeps its store until someone LOGS IN on it: ACCEPTED 2026-10-18, no work

The residue (an id plus sealed key material, nothing readable) is accepted. An unauthenticated revocation route would be an enumeration oracle and a local expiry a clock
([detail](protocols/campaign-measured-defects.md#a-device-revoked-while-offline-keeps-its-store-until-someone-logs-in-on-it-2026-08-30)).

### P1 - the cause of a REVOKED device's partial restore is not established

The wipe and tombstone halves are fixed ([auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it)); HEAL-REVOKE-1, -2, -3 are `PASS`. The shortfall report is built ([auth](frontend/modules/auth.md#a-restore-that-comes-back-partial-says-so-2026-10-08)). Open: which cause the user hit (a session-only row removal, `revokeRowSessions` failing, or the watchdog rebuilding the store) is separable only from the user's own history. Not worth code without a measurement.

## Mentions

One open item; the design is on
[campaign-measured-defects](protocols/campaign-measured-defects.md#mentions).

- **P3 - a mention banner says "someone" where the NAME could be: BUILT 2026-10-18, NOT SHIPPED.** A salon mention of the reader now names its AUTHOR ("Alice vous a mentionné", "Quelqu'un" if unknown) from the phone's local copy (`display_names.json`, written by the WebView as names change, a deleted account dropped), never from the push; the mentioned person inside the text comes from the same copy ([mobile](frontend/mobile.md#a-mention-names-its-author-from-the-phones-own-copy-wp-mention-name-2026-10-18)). Owed: one look on each phone (a salon mention by somebody the app has shown, then by somebody it never has); Kotlin, Swift and ObjC never run.

## The harness itself

Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](cross-client-harness-findings.md). **DECIDED 2026-10-18: the whole test tooling is reformed NOW, not after a wholesale rig change** (user: "on est a un nombre de test aberrant") - [WP-TEST-TOOLING-REFORM](#decided-by-the-user-on-2026-10-18---every-design-question-answered); the "waits for a wholesale rig change" lines below are that reform's scope.

### P2 - the local estate applies no migration file, so a table only a migration creates is missing (2026-10-22)

The local estate's schema comes from TypeORM `synchronize`, and nothing runs `apps/*/src/migrations/*.sql` there. A raw-SQL table therefore never exists locally. On 2026-10-22, every salon send failed with `relation "channel_message_client_tombstones" does not exist` (migration 090), and `post_audiences` (071) was missing too. GRAINE-AUTH-1 read this as `never appeared`. Both files were applied by hand that day. The fix is for the local bring-up to call `apply_migrations` from `infrastructure/lib/migrations.sh`, as the deploy and the dev reset already do.

### P1 - one unexplained FAIL in 44: a salon row the reader refused stayed on screen after a reload (GRAINE-AUTH-1, 2026-10-22)

The reader logged the refusal every time, yet once in 44 runs the refused message was still rendered. There are two candidates:

- **A drawn row.** Two overlapping loads could each leave a stored-page row unwithdrawn. This is fixed by #2245, and its test fails on the old code. It was never seen in a trail: on 35 instrumented runs the tampered row was not in the drawn copy.
- **A live row.** A row that reached memory live and was verified on arrival is kept by the merge's window rule when a later page refuses it while it is the newest (`messageMerge.ts`). This is by design, and it is written down in [community-open-budget](frontend/community-open-budget.md#f4-built-2026-10-15).

GRAINE-AUTH's trail now keeps the load lines and every line naming the tampered row. A loop on the estate waits for a recurrence that carries this evidence.

**Every way a salon message reaches memory, read 2026-10-22** (`frontend/src/lib/`):

| Path | Checked before it is shown? |
| --- | --- |
| Live frame (`messagePipeline/channelEventHandler.ts`) | Yes: `openChannelMessage`, with the author bound by the session. A frame WITHOUT a ciphertext was rendered under the author the server named, with no check; it is refused since the fix that follows this table. |
| History page (`composables/useConversations.svelte.ts`, `loadChannelHistory`) | Yes: `decodeChannelMessageRow`. |
| Stored-page draw (`drawStoredSalonPage`) | Not re-verified. The rows were verified when stored, and any row the next merged page does not name is withdrawn (#2245). |
| Whole-history search (`searchChannelHistory`) | Yes: `decodeChannelMessageRow`. |
| Reconnect and catch-up | Yes, through the history page. Salons have no replay queue. |
| Reactions and edits, live, history and search | Yes; an edit is also checked against its target's author. |
| History bundle, boot restore, landing preview, scrollback | Not a path: salons are excluded from each. |
| Own echo and unsent resend | Local text by this device's own user. |
| Tab sync (`components/layout/ChatBackgroundService.svelte`) | Trusts the leader tab, whose row came through the paths above. |

A row under a v1 session this device still holds carries no author proof. That is the documented legacy of [channel-encryption](protocols/channel-encryption.md), and it ends with the v1 reader.

### P3 - what the salon banner rule leaves to the server (2026-10-22)

- **iOS extension timeout.** If the extension runs out of time while fetching or opening the seed, the system shows the push's original content, which carries the server's mention sound. The time-expiry handler should apply the blind-banner rule before it hands the content back.
- **An opened banner's mention is the server's word alone.** The text is proven, but whether it names this reader is not checked against it. Accepted for now, because the mention level is decided by the server too.
- **Source pins hold `\n`.** Several native source pins in `src/lib/mobile` match multi-line strings with `\n`, and would fail on a checkout with CRLF line endings. Normalise the source before matching.

### P3 - two salon ingest seams with no guard of their own (2026-10-22)

- `fcmMemoryMerge.ts` has no `channel_` guard. It is unreachable today, because the native side never caches a salon push; the guard would be defence in depth.
- The live frame and the history page used to key a row by different fields. The live path now reads `messageId` alone (#2248). Should the server ever give one row two ids, the first path to open it claims the key, and the other is refused as a replay.


### P3 - MULTI-9 cannot pass on a healthy estate: its precondition is a pending device, and none stays pending (2026-10-22)

A new device reached `active` in 107 ms, so there was no window to send into, and the row recorded `VACUOUS`. That matches its only earlier verdict. The row needs a way to hold a device `pending` (a held Welcome or a stopped responder) before it can say anything. Until then it is a precondition the estate cannot create, not a verdict.

### P3 - four rig defects read on the 2026-10-22 GRP and GRAINE passes (WP-TEST-TOOLING-REFORM, no verdict)

- **The client logs one group creation twice**: `groupCreation.ts` emits `[OK] Group … created.` and `[GROUP] Group created successfully` for the same event (3 of 3 creations captured on GRP, 2026-10-22). This is upstream noise and not a classifier rule: one of the two lines goes.
- **GRP waits for "no sidebar row" on W2** and errors when the row lingers. That is a wait on rendering, not on the subject of the row.
- **GRP-8 waits on the member-count TEXT**, so a re-worded count reads as an ERROR. It should read the roster.
- **The peer's display name can drift from `PEER_NAME`**: a local account named otherwise turns every GRP row into `the picker offers no <name>`. `identity.mjs` should compare the name shown with `PEER_NAME` before any row runs. The W2 window width belongs here too: a 500 px window hides the Communities rail, and GRAINE-AUTH-1..3 died on a zero-size link, so the preflight should read it.

### P3 - the phone's local debris cannot be swept, so every run ends on a line that says so (A1, 2026-09-08, still true 2026-09-21)

`sweepDismissed` cannot reach a Tauri client. Needs the name from the server's tombstoned rows joined to the
phone's DOM, or an in-app dismissal on A1 ([detail](cross-client-harness-findings.md#the-phones-local-debris-cannot-be-swept-a1-2026-09-08-still-true-2026-09-21)).

### P2 - no row on the board can tell a healthy conversation from an epoch-forked one (2026-08-29)

The predicate is built end to end (2026-10-04). Owed: the ROW - a MULTI-shaped row asking `readEpochForks`
of a conversation it is not using, run once on a build carrying `window.__canariMlsEpochs()` ([detail](cross-client-harness-findings.md#no-row-can-tell-a-healthy-conversation-from-an-epoch-forked-one-2026-08-29)).

### P2 - a LIVE socket dies in the middle of GRP-3, and no navigation explains it (2026-08-25, accepted `PASS-DIRTY`)

The instrument half is done (`wsOpened`, 2026-10-04). Owed with the rig: `ws1.mjs` over GRP-3's sequence
to place the close against `removeMember` or the socket's age ([detail](cross-client-harness-findings.md#a-live-socket-dies-in-the-middle-of-grp-3-2026-08-25)).

### P2 - ONE NAMED STARTING POINT, reachable at every granularity (asked 2026-08-25)

Not built: one exported, idempotent entry point with an asserted postcondition (on `/chat`, unlocked, no
overlay, mounted, deployed bundle), PIN typed only if the gate is up, a logged reload repair on web, A1
excluded. Of 23 sampled runners 15 assert nothing at their start. Contract in
[the harness findings](cross-client-harness-findings.md#one-named-starting-point-at-every-granularity-asked-2026-08-25).

### P3 - the bubble-action and observation helpers live in one runner (`mut.mjs`)

Waits for a wholesale rig change, because moving helpers into `chat.mjs` invalidates MSG, TYPE, READ and
MUT under rule 33 ([detail](cross-client-harness-findings.md#the-bubble-action-and-observation-helpers-live-in-one-runner)).

### P3 - eight runners open IndexedDB by hand, and `idb.mjs` exists

Same wholesale moment: convert all eight and re-run together ([detail](cross-client-harness-findings.md#eight-runners-open-indexeddb-by-hand-and-idbmjs-exists)).

### P2 - re-registering the PIN verifier strands every other client SILENTLY, and only its next unlock finds out (2026-09-04)

Open: nothing tells an unlocked client its vault material was replaced; every HEAL-NEW row strands W1/W2.
The wipe repair is measured (`newdevice.mjs --device W1`). Owed: do the same digits give an acceptable
verifier, does "ancien PIN" restore or reset MLS state, has production ever had a member in this state
([detail](cross-client-harness-findings.md#re-registering-the-pin-verifier-strands-every-other-client-silently-2026-09-04)).

### P3 - a check that dies mid-gesture leaves a file staged in the composer, and the NEXT check sends it (2026-09-04)

Open: a staged-tray assertion in the shared entry point, like `clearOverlays` ([detail](cross-client-harness-findings.md#a-check-that-dies-mid-gesture-leaves-a-file-staged-in-the-composer-2026-09-04)).

### P3 - TWO out-of-tree directories are both called `canari-harness`, and a decoy `names.mjs` sits in the one the harness does not read (2026-09-04)

Owed to the USER, one-off on the workstation: merge the directories or delete the decoy `names.mjs` (both hold credentials and Chrome profiles). The preflight prints `rig state: <STATE_DIR>` first ([table](cross-client-harness-findings.md#two-out-of-tree-directories-are-both-called-canari-harness-2026-09-04)). **Re-read 2026-10-18 on the workstation, still true, and it is not only a decoy:** the directory the rig does NOT read still holds the decoy `names.mjs`, two stale test-account files, the Play Console service-account key the play-vitals tooling DOES use (move it, do not delete it), and identity-provider database dumps from 2026-09-02 and 2026-09-04 - production personal data past the 14 days the privacy policy promises for backups, so those dumps are deleted (GDPR), not merged.

## The graphical pass - every page at 100 % (user, 2026-09-13)

**EVERYTHING BUT REAL HARDWARE IS DONE** (the route sweep at 390, 1280 and 1920, the truncation defects and
census, the many-channels and long-name halves: [design-reference](frontend/design-reference.md) sections
16, 17, 19-21 and 39, stories in `CHANGELOG.md`). Left: the same measurements on real hardware, where all of
it was Chrome with a device-metrics override and three of three iOS defects were invisible to every gate
([device-verification](device-verification.md)). The instrument is `tools/cross-client-harness/sweep.mjs`;
CLAUDE.md queue item 16 carries it.

- **Suspended, not filed**: the "Nouvelle discussion" dialog showed no result list on A1 against `dev`, where the harness directory does not exist. One re-run against the LOCAL estate settles it ([detail](cross-client-harness-findings.md#the-2026-09-14-hardware-session-one-suspended-measurement)). **Why no agent re-ran it (2026-10-09):** the local estate is up, but every signed-in client of the rig reaches its session through Authentik's login, which an agent may not drive, and the app keeps no other session path (tokens live in memory only); the re-run is one `bun sweep.mjs --device W2 --route /chat` plus the dialog by a session holder.
- **Done 2026-10-08 - the wry bump** (tauri 2.12.1, wry 0.57.0, tao 0.37.1; the vendored `tao` fork DELETED, upstream already carries its guard): one re-check left, none owed ([detail](cross-client-harness-findings.md#the-wry-bump-that-removes-the-abort-a1-2026-09-14)).

## Composer and reactions

### Emoji pictures - the campaign rows, which need real devices

The pictures replaced the font on 2026-09-25 ([emoji](frontend/emoji.md)). **Open:** the twelve rows of the second campaign, all needing real devices (the iPhone, where the font never drew, first) - they live in [emoji](frontend/emoji.md#what-a-future-campaign-owes---the-twelve-rows-moved-from-the-backlog-2026-10-08).

## Storage and retention

### P1 - the resume reload and the receive ratchet: fixed, owed one device reading; a SEND-side rewind is still unexplained (measured on the Mi 9T 2026-09-08)

Defects A (#435, `v0.16.6`) and B (#1527, the native reload refuses `live-ahead`) are shipped; mechanism in [mls-desync-prevention](protocols/mls-desync-prevention.md#the-resume-reload-re-installed-a-receive-ratchet-behind-the-live-one---the-2026-09-08-captures-mi-9t). **Owed on the Mi 9T:** (1) resume right after a received frame with no checkpoint between and read `[MLS][Tauri] Resume reload SKIPPED`; (2) re-measure the `E/` pair (a duplicate `recevoir_messages_batch` 83 ms apart) on a rebuilt APK (`adb logcat -v time` during NOTIF-7); (3) reproduce the 2026-09-06 SEND-side rewind from the phone. **Do not await the outbound checkpoint** ([why](protocols/mls-desync-prevention.md#the-checkpoint-window-and-the-per-document-snapshot-counter-moved-from-the-backlog-2026-10-08)).

### P1 - THE MINTING LOOP HAS NEVER BEEN OBSERVED ON THE HANDSET, AND A BLOB'S SIZE CANNOT SETTLE IT

Population, refuted causes and rules are on [key-package-pool](protocols/key-package-pool.md), the only copy. **Owed, in order:** (1) one CDP console read (not logcat) of the reload path across a background/resume on a real handset, looking for `[RESUME]` and the `publishedThisSession` refusal counter; (2) a device-side state census (groups, members, one-time bundles, last-resort); (3) the per-connection fallback reuse. The shipped guard closes the observed case, not the class: `publishedThisSession` is per-process, so a keystore emptied and then RESTARTED would run the loop again.

### P2 - NOTHING REPUBLISHES A LAST-RESORT PACKAGE'S EXPIRY, SO THE UNDATED ROWS DRAIN ONLY AS THEIR OWNERS UPGRADE (production, re-measured 2026-10-09)

**Re-measured read-only on prod 2026-10-10: 454 undated of 1027 rows (290 users), newest undated row still 2026-09-25 - the drain is now about 3 a day.** **Re-measured 2026-10-09: 457 undated of 1016 rows (291 users, 116 of them with NO dated row), down from 597 on 2026-09-22 - about 8 a day, the 20 a day of 2026-09-18 slowing.** The split is STILL a client version with no exception (559 of 559 dated rows are `>= 0.18.10`; no undated row is, 393 carry no version at all and 29 are below it), and the newest undated row was created 2026-09-25: the population is frozen and only drains. Both client repairs are REFUTED; mechanism in [key-package-pool](protocols/key-package-pool.md). **The server-side lifetime decoder (an MLS reader in `chat-delivery-service`, which never interprets MLS bytes) is NOT justified while the count falls**; a count that stops falling is what would justify it, so re-measure after the floor moves (`minClientVersion`, the user's gesture) - which is also what empties it.

### P2 - the MLS snapshot version is a PER-DOCUMENT counter compared ACROSS documents, so a second tab's write is dropped on a collision (measured on TAB-4, 2026-09-05)

Whether anything is lost is unmeasured; the state is expected to converge. **Owed:** a shared counter or a proof of convergence and its delay ([mls-desync-prevention](protocols/mls-desync-prevention.md#the-checkpoint-window-and-the-per-document-snapshot-counter-moved-from-the-backlog-2026-10-08)).

## Payments

Lydia ("Paiement Canari") and cash are the only payments since Stripe was removed (#1589, [stripe-archive](stripe-archive.md), which lists the names kept for rollback and old clients). `payment_provider` is `lydia | disabled`, default `disabled`; mechanism in [payments](frontend/modules/payments.md) and [core-service](services/core-service.md#payments-stripe--lydia).

### WP-LYDIA-1 - Lydia live in production, with one payment observed end to end

**Release checklist for the first stable carrying the production pair (2026-10-23).** The production core was recreated by hand with `LYDIA_ENV=production`, and a deploy re-renders `.env` from the manifest, so: (1) no stable and no deploy of any kind before the pull request that makes `LYDIA_ENV` a required production secret is merged; (2) cut a PRE-RELEASE AFTER that merge and check that its commit contains the change before tagging the stable (a stable ships the latest pre-release of its version, so an older alpha would carry the old manifest); (3) after the stable, read the running core's `LYDIA_ENV`; (4) a rollback to any release before it re-renders `homologation` in silence - set `LYDIA_ENV=production` in the production `.env` and recreate the core by hand ([payments](frontend/modules/payments.md#which-payment-provider-is-live)).

**What to read on the running production core right after that stable deploys (2026-10-24).** All read-only, none prints a token; the stable counts as verified only when every line holds. #2323, #2324 and #2325 are merged.

| # | Read | Expected | If not |
|---|---|---|---|
| 1 | The release run: the `preflight` step "Production names the real Lydia", then `serve-prod` | both green; the step ran, since it is stable-only and this is its FIRST execution | red at the step = the secret is not exactly `production`: fix the secret, never the step |
| 2 | The core's startup log, `Lydia configured: yes (<base URL>)` (the provider prints it once per start, `lydia-payment-provider.ts`) | `yes (https://lydia-app.com)` | `yes (https://homologation.lydia-app.com)` = the deploy put the core back on the sandbox with the production pair: set `LYDIA_ENV=production` in the production `.env`, recreate the core by hand ([payments](frontend/modules/payments.md#which-payment-provider-is-live)), and tell the lead |
| 3 | The container's own `LYDIA_ENV` (inspect its environment, print that ONE key) and the `.env` the deploy wrote (that one key) | both `production`, one line each | they disagree = a hand recreate outlived a deploy, or the reverse: align them |
| 4 | `platform_config.payment_provider` | `lydia` (it STAYS `lydia`, user 2026-10-23) | `disabled` = something reset it; nobody sets it back without the user |
| 5 | The Business links: associations holding a Lydia `vendorToken`, and how many are validated or hold a stored callback key | only the associations the user knows about; none validated yet unless the user enrolled one | an unknown association with a `vendorToken` = report at once |
| 6 | Core and social-service logs since the deploy, for `[LydiaPaymentProvider]` lines: `refused by Lydia`, error `104` ("Provider inconnu"), error `5` ("temporairement bloque"), any `request/do ->` | no `104`; no `request/do` unless a validated Business was used on purpose | `104` = the pair and the environment disagree (the signal the mismatch fails loudly); a `request/do` nobody launched = report at once |
| 7 | Migrations `100` and `101` in social-service's migrations table, and the callback route answering a body signed with nothing | both applied; the route refuses it with a 4xx, never a 5xx (not measured on production: the one answer known is the 400 for an association with no stored key) | a 5xx on the callback route = the stable broke it |
| 8 | Nothing else in production moved: no new pending form payment or boutique attempt rows without a person behind them | none | report at once |

**A test PAYMENT after the stable needs a validated Business, which does not exist yet** (the three Businesses made through the onboarding on 2026-10-23 wait for Lydia's validation and for the answer on how their holder signs in, [lydia-api](lydia-api.md#activating-a-business-that-businesscreate-made-production-2026-10-23)). Until then the payment path is proved only by the 2026-10-23 manual run (one real payment of the minimum amount through an older merchant account, its `confirm` verified), NOT by the stable. When a Business is validated: the manager pastes its private key, the global admin marks the onboarding complete, then ONE payment of the minimum amount (0.50 EUR) through a form, read to the end - the `confirm` callback arrives and verifies, `request/state` answers `1`, the answer is recorded as paid once, and the payer's return page agrees. A cancel on that paid request answers error 2 and changes nothing (measured). Refund and `end_mobile_url` stay unmeasured.

**Done 2026-10-23:** one real production payment, its `confirm` verified with the Business key ([payments](frontend/modules/payments.md#enrolment-goes-through-canari-and-only-through-it-2026-10-23)); the production Provider tokens are set. **Owed:** `LYDIA_ENV` carried by a GitHub secret (#2323) before the next stable; each association re-onboarding on Lydia (**an association with a Stripe-only payment account is no longer payment-ready until it does**); Lydia's still-open Livrable A answers ([plan](../../plans/stripe-to-lydia-migration.md)). The `business/create` `BUSINESS_VALIDATED` webhook is deliberately NOT built: no documented signature and `vendor_token` is public, so anyone could forge an association's onboarding state - ask Lydia whether it signs before building it.

### Enrolment through Canari - the screen owes the path to validation (2026-10-23)

The user decided that every Business is created by Canari's onboarding, never linked from outside ([payments](frontend/modules/payments.md#enrolment-goes-through-canari-and-only-through-it-2026-10-23)). The first production enrolments showed the screen leaves the manager with no next step: the dashboard link answers 404 when signed out, and the Lydia Pro app did not show a Business made by the Provider, even one created with the signed-in person's own phone ([lydia-api](lydia-api.md#activating-a-business-that-businesscreate-made-production-2026-10-23)). **Owed, in order:** Lydia's answer on how that Business's holder signs in to its console, and which documents an association gives; then the card rebuilt around the three steps of Lydia's activation e-mail, saying who does what; a "waiting for Lydia" state told apart from "validated", with error 5 of `request/do` as the measured signal; and the existing refuse-or-confirm item on a re-run onboarding below.

**The user's requirement, 2026-10-26:** enrolment must become much more user-friendly, step by step, once Lydia's information is complete - *"Je n'ai pas envie d'avoir à expliquer le fonctionnement à tout le monde, il faut que ce soit clair."* `business/addcashier` (provider-signed, in [the migration plan](../../plans/stripe-to-lydia-migration.md)) may be the step that attaches a person's phone to a Business made by `business/create`; Lydia's help center says a cashier is added in the console "Caissiers" tab or in the Lydia Pro app by mobile number, with rights chosen at the add (an administrator right manages cashiers). **Tried on the sandbox and on one production Business (2026-10-27/28): refused with a signature error (444) across every signing variant attempted, both Provider-key and Business-key.** Outcomes-only findings are in [lydia-api](lydia-api.md#6-still-unknown). **The user sent an outcome-only message to the Lydia contact on 2026-10-29**, asking their engineer to check the server-side signature-verification log for one specific sandbox request. **The production sweep (wiring `addcashier` into enrolment) stays OFF until Lydia answers AND one sandbox probe passes with a working signature.**

### The shop screens - decided by the user on 2026-10-26 after the first real Cercle top-up

**State:** the first real top-up of the Cercle through Canari worked end to end (Lydia state `1`, purchase recorded paid once, delivery to the Cercle `delivered` on attempt 1, balance moved by the amount paid). The screens around it are what is left. **Decided:** (1) a member already holding the highest tier sees NO membership card (the profile page already says they are a member); (2) membership is ONE card with the tiers inside it; (3) a member of a lower tier is offered the rise, and pays the COMPLEMENT, not the full price - **owed first: read what the code does for tiers today** and measure it, since the user does not know; (4) a top-up is chosen with quick amounts plus "other amount" on an in-app keypad - no native `<input type="number">` (browser spinner on desktop, system keyboard on mobile) anywhere in a shop view; (5) no maximum top-up; (6) after a paid Lydia payment the payer returns to the shop with a banner ("+5 EUR credited", "membership active"), and when the Cercle cannot be reached the banner says the payment was received and the credit follows (the retry ladder already exists); (7) no Cercle balance on the card for now (it needs a route on the Cercle's host, which is not ours); (8) the WHOLE shop is in scope (`/shop`, the association page, `ProductPurchaseButton`), with the app's own tokens and the payment apps (Revolut, Lydia, Wero) as the visual reference; product names shown to people are never the technical ones (`balance_topup`), prices follow the locale (`15,00 EUR`). The Lydia card page itself is Lydia's and cannot be changed.

**Measured and decided the same day (user, 2026-10-26).** (a) The audit (`resolvePurchase`, `grantPurchaseTag`) found that a tier holder pays the FULL price of a sibling tier unless the admin sets the existing preferential price (`memberPriceTag` + `amountCentsMember`), that buying a LOWER tier silently replaced a higher one, and that `variantLevel` (tier order) was NULL for both Cercle tiers. The Cercle admin then set the preferential price by hand (Alcool 30 EUR, 15 EUR for holders of Cotisation): **the complement is the admin's preferential price, nothing is computed automatically**; the server refuses a tier priced lower than or equal to the held one (typed code) and exposes per product `viewerTierRelation` and `viewerDueCents` so the client never recomputes money. (b) **The admin screen "Prix de la cotisation" is unclear** (the preferential-price fields, the tier identifier, the tier order) and the WHOLE Achats tab is in scope for a rework: a rise is described by a fill-in sentence ("a holder of X who moves to Y pays [15] EUR instead of 30 EUR") with a preview of what the member sees, and the order of the tiers is visible. (c) **A TECHNICAL ID IS NEVER SHOWN, NEVER TYPED AND NEVER EDITED BY A PERSON** - a real name is shown instead (the tier's `variantKey`, shown and editable today, is derived from the label at creation and fixed afterwards); the same rule found the id in the title of an association's page and a field to set it at creation of an association, list or institution, which serve no one. **Owed:** the sweep of every screen for a technical id shown or typed (the association page title and the creation form first), then the Achats rework.

### P2 - the Lydia reconciliation sweep is built; the `request/state` signature it verifies is documented, not measured (2026-10-27)

The sweep ([lydia-api](lydia-api.md#7-reconciliation---the-sweep-lydias-documentation-asks-for)) acts only on an answer whose signature verifies over the row's amount written as `request/do` sent it (`"12.50"`). Lydia's documentation names the signed fields but not how the amount is written. The sweep ships OFF in production (`LYDIA_RECONCILE_ENABLED`, computed `false` there, `true` on dev). **Owed, in order:** (0) BEFORE production is switched on, all of: the user's one-off sandbox probe on a validated Business - the `0.50` format read by `request_uuid` AND by `order_ref`, the signature on a PAID and on a CANCELLED request (the command is in #2595); one full dev sweep read in its logs; a clean day of dev logs; and a read-only count on production of the open ended attempts the first tick will read and close (`count`, `min("expiresAt")`, the query is in [lydia-api](lydia-api.md#7-reconciliation---the-sweep-lydias-documentation-asks-for)) - then `compute_lydia_reconcile_enabled` turned `true` for production in a commit; (1) the first real request the sweep reads - a `verified` line settles it; a `does NOT verify` ERROR on a row whose amount is right means the amount is signed another way, fixed in `lydiaStateSignedFields` and nowhere else; (2) then the payer's return and the callback's read made to verify too (they do not, and settling unverified there is unchanged by this lot); (3) a form answer keeps no snapshot of the Business its request was issued to, so one whose association re-linked meanwhile does not verify - a column, so a migration and the user's yes, only if it is ever seen. (4) On the sandbox, which Lydia refusal codes are PERMANENT for `request/state` and for `request/cancel` on a request Lydia ISSUED - first error `2` on an issued-then-expired uuid, measured so far only on a never-issued one: a refusal closes an attempt only from an allowlist, EMPTY for both calls until then, so every refusal is retried and accused at ERROR when the accused list changes - the starvation trade, taken knowingly; a durable bound on retries is a column, so a migration and the user's yes, not built.

### P3 - while core-service is mid-deploy, a retry meeting an older core's `closed` is refused (review of #2215, 2026-10-21)

Since #2210 social-service reads a request state through `toRequestState`, which knows `open | paid | declined | cancelled-or-expired | unknown`. An OLDER core-service still answering `closed` for state 6 during a deploy is read as `unknown` (one WARN, `readRequestState`'s wire-mismatch line), so a retry's `settleOpenRequest` refuses it with 409 `PREVIOUS_PAYMENT_OPEN` (WARN) instead of freeing the row. Deliberate (a deploy in either order refuses rather than releases) and TEMPORARY: it ends when the new core serves. **Owed:** nothing unless a deploy is observed to leave payers refused past the core restart - then check the deploy order rather than teach social-service the old word.

### Owed to the user after the Stripe removal

Delete the GitHub secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUB_KEY` and the Stripe webhook endpoint (the CGU and privacy text naming Lydia was APPROVED by the user on 2026-10-08). Three later items: the unsigned Lydia partnership contract, proof the payer e-mail is not kept, and association enrolment with conditions and uploaded documents. Later, once the previous release is no longer a rollback target: drop the three Stripe columns and rename the permission with a data migration ([stripe-archive](stripe-archive.md#the-names-that-outlived-the-processor---what-2026-10-09-renamed-and-what-stays)).

### P2 - an answer whose Lydia request is still OPEN shows "pending" with no button for up to 28 minutes (2026-10-21)

A payer who leaves Lydia's page without paying or declining (tab closed, back button) leaves the request in state `0`: the form page reads "En attente" with the pay button disabled until the request expires (1680 s) or the hold ends (30 min). A retry would work server-side (`settleOpenRequest` cancels the open request and issues a new one), but the page offers none. #2210 covers declined and expired requests only ([forms](frontend/modules/forms.md#a-declined-payment-releases-the-answer-2026-10-21)). **Owed:** a decision on offering "pay again" on an open request, and its two-tab hazard (the retry cancels the request another tab may be paying).

### P3 - a success-page poll during a retry is a second trigger of the self-caused cancel (review of #2210, 2026-10-21)

A retry's `settleOpenRequest` cancels the old request BEFORE its transaction; until the transaction re-reads the row, the row still names that request. Lydia's cancel callback landing then was the one known trigger of a self-caused cancel (the take-back in `submit` re-checks capacity). Since #2210 a `confirm-payment` poll from a success page still open in another tab is a second one: it reads the old request `cancelled-or-expired` and releases the row (`releaseSettledRefusedRow`), so the seat is free from that write to the take-back, and a single-seat form filled in between answers "Form is full" to the payer who was retrying. Same outcome as the callback race, a wider trigger. **Owed:** a decision whether the retry should mark the row as being settled (durable state the release honours) rather than rely on the take-back, and a seat-hold test interleaving the poll with `duringCancel`.

### P2 - a crash between a top-up's purchase commit and its Cercle dispatch loses the top-up silently (review of #2218, 2026-10-21)

Three ways lose a top-up WITHOUT a line, and none of them credits twice:

- **The crash.** `settlePaidCheckout` (and `completePaidWithoutRequestId`) commit the purchase record, THEN `dispatchCercleWebhook` saves the `webhook_deliveries` row, outside that transaction. A process killed between the two leaves a paid top-up with no delivery row: the `*/5` scheduler (`retryDueWebhookDeliveries`) only retries `failed` rows that carry `nextAttemptAt`, so nothing retries it, and nothing logs it. **Why it was not built in #2218:** writing the row `pending` inside the settle transaction (an outbox) is not enough by itself - the scheduler would then have to tell "a dispatch is running" from "a dispatch died", and today only a clock could say which. Using a clock for that risks crediting the Cercle twice. The outbox needs a durable claim on the row (who is sending it), which is its own change.
- **A commit whose acknowledgement is lost**, or a process that dies after the commit and before the dispatch: the record is written and carries its id, so a retry (the callback again, or the next return read) finds the attempt `paid` and dispatches nothing.
- **Lydia answers `open` to a callback that said confirmed** (its state lagging its own callback): `readAndApplyRequestState` returns that stale `open`, so the callback skips `completePaidWithoutRequestId` and an attempt the return had already settled without an id keeps a record with no id and no dispatch.

**Recovery query, until then** - read-only. It returns every paid online top-up with no delivery row, which covers all three cases. A record still without an id (the third case) is included, because `NULL` matches no delivery. **Run on a throwaway local PostgreSQL only, never on production** (2026-10-21): its schema came from the entities, with four top-up records: three paid online (one with a matching delivery, one unmatched, one with no id) and one paid in cash. The query returned exactly the unmatched one and the id-less one.

```sql
SELECT pr.id, pr."userId", pr."amountCents", pr."stripePaymentIntentId", pr."paidAt"
FROM purchase_records pr
JOIN association_products p ON p.id = pr."productId" AND p.type = 'balance_topup'
WHERE pr.status = 'paid' AND pr."paymentMethod" = 'online'
  AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d."paymentIntentId" = pr."stripePaymentIntentId");
```

**Not covered by it:** a confirmed callback answered `open` for an attempt nobody had settled leaves NO record at all. Core answers Lydia 200, so the callback is not retried. Only a later return read, or the buyer's next attempt, finds the payment.

**Owed:** the outbox with a claim, and a report that runs this query - a mechanism with no report is found by hand. A row with a NULL `stripePaymentIntentId` is the id-less case that Lydia's confirm callback completes ([payments](frontend/modules/payments.md#a-product-checkout-is-a-row-one-per-attempt-2026-10-21)).

### A PAID PUBLIC FORM (user, 2026-09-30) - the paid half waits for Lydia

The free half is shipped (`/f/:id`, migration 068, [forms](frontend/modules/forms.md#a-public-form-is-answered-without-an-account-2026-09-30)). **Owed:** one guest answer sent from a private window on `dev.canari-emse.fr`, with the `canari-dev-frontend-1` log showing a real client address rather than the Docker gateway (the `real_ip` change it carries); the paid half is scoped on [forms](frontend/modules/forms.md#the-paid-half-what-it-needs-scoped-2026-09-30) and needs WP-LYDIA-1.

### P2 - the history rule saved by an admin is not applied from the live frame

Found by COMM-12 on `1.5.0-alpha.1` (2026-10-27), and never worked: the admin's card resets to the old rule right after a `200` save, and the rule applies at the next listing. The server publishes `workspace.updated` with `historyVisibility`, but `channelEventHandler.ts:276-283` forwards only `workspaceId`, `imageMediaId` and `channelsReordered`, so `handleWorkspaceUpdated` never receives it; the frame replaces the sidebar entry with the old rule a millisecond after the save, and the panel re-reads it. A post-stable chantier: the fix turns on a path that has never run live.

### P3 - a read mark for a salon that no longer exists is retried forever

Seen on most rows of the `1.5.0-alpha.1` replay (2026-10-27): every load on W1 and W2 posts `POST /api/channels/<id>/read-mark` for a deleted salon, gets `404`, and `salonReadMarkQueue.ts` logs `[READ] salon mark ... not delivered - kept, and asked again at the next load`. A `404` there is an ANSWER - the salon is gone - and never a reason to retry: the mark must be dropped on that status (typed by status, never by message) and the drop logged once. Today it is dirt on nearly every row; a fix-after-stable item, not something to narrate.

**FIXED AT THE SOURCE 2026-10-29, owed its reading.** The read-mark route now answers `404 CHANNEL_NOT_FOUND`, `ChannelService.advanceReadMark` turns exactly that into `ReadMarkTargetGoneError`, and the flush drops the mark with one `[READ] salon mark ... dropped - the server answered that it no longer exists` (an unnamed 404, a 403 or a transport failure stay owed); a `channel.deleted` frame forgets the owed mark before any POST ([offline-and-weak-network](frontend/offline-and-weak-network.md)). **Owed:** a pre-release carrying it on dev, then KICK-COMMIT, SALON-REVOKE-COMMIT and DEVREVOKE-KEYGROUP re-run - the FIRST run still posts the old mark once (one 404 and the drop line), every later run none. Delete this row then. Not done: a `403` (a member no longer allowed into the salon) still keeps its mark owed; not seen in any log.

### P2 - a group joined by Welcome, opened while another conversation was showing, renders an empty transcript

Found by TOK-3 and reproduced by OFF-2 on `1.5.0-alpha.2` (2026-10-27): W2 is added to a group by W1's commit while W2 shows another conversation (its DM with W4). The Welcome is processed, both following messages are decrypted and added (`[ADD_MSG] Batch into "<group>": 1 added, 0 upgraded, selected=true`), and the rig then opens the group. Its pane carries the right heading and the composer, and **no message at all** for 20 s: `renderedParagraphs: 0`, the last marker visible only in the sidebar preview. A reload renders both. With W2 parked on that DM before the row, OFF-2 missed both times (16:31Z and the run after it); in the three runs where W2 was last on a deleted group instead, it rendered. Evidence: the rig ledger, OFF-2 at `2026-10-27T16:31:47Z` (pane outline in the miss line), its screenshot under `STATE_DIR/logs/shots/`, and W2's console beside it. **Owed:** the cause in the client's selected-conversation state across a Welcome; then OFF-2 and TOK-3 replayed with W2 parked on another conversation.

### P3 - an admin who never joined a private salon is not told when it is created or deleted

Not on the roster, so no `channel.deleted`; the sidebar keeps a stale row until the next load. **Do not widen the audience** (that is what leaked private-salon traffic to non-members); the shape that would work is a contentless `channel.gone` addressed to the community, worth doing only if the stale row is ever seen to matter.

**The creation half (COMM-13 on `1.5.0-alpha.1`, 2026-10-27):** a private salon's creation is announced as `channel.member.joined` to its audience, which is `allowedUsers` alone, so an administrator who is online sees no "join as administrator" row until their next full listing - though [channel-encryption](protocols/channel-encryption.md) intends that row to be visible to them. COMM-13's premise (the unjoined row on the admin's screen) therefore never arms on a live client; it passed on `0.16.3` (2026-09-05), and what brought the row to the admin then is not established. The same contentless shape (`channel.listed`, no name beyond what the listing already serves to a manager) would close both halves.

### P2 - WP-RESTORE-1: Zero-Tap Sign-In restoration, required by Google Play from April 2027

The principle is accepted (user, 2026-08-26) and **DECIDED 2026-10-18: planned NOW, independent of the campaign** ([WP-RESTORE-1](#decided-by-the-user-on-2026-10-18---every-design-question-answered)); the Block Store exemption date of 30 September 2026 has passed and enforcement begins April 2027. **BUILT 2026-10-18 on a draft pull request (server, client, Android plugin): the design and what each claim is verified by are on [account-restore](account-restore.md).** What closes it is a device reading, never more code: a real restore A -> B on the Mi 9T and a second Android phone (zero tap, the old phone signed out), the UP/UV flags a real key carries, and the platform replacing the consumed key at the new phone's first start. One one-off for the user: the GitHub secret `DEV_ANDROID_APP_LINK_SHA256` (the same value as production's), without which dev answers every restore route 503. The requirement and the three traps: [mobile](frontend/mobile.md#wp-restore-1---zero-tap-sign-in-restoration-accepted-2026-08-26-built-2026-10-18).

### P3 - a sign-out that never reached the server leaves a restore key alive in the Google backup

A restore key dies with the session that registered it (`ON DELETE CASCADE`), and a sign-out revokes that session under a deadline (`clearAuthUnderway`). Past the deadline the row lives on for its 7-day idle life, and so does the key's copy in a Google backup taken before the sign-out: a new phone restored from that backup would restore a session its owner signed out of. The phone that signed out cannot do it (`canari_restore_attempted` is written at every sign-out). This is the residual the refresh row already has, made reachable from a restored phone. **Remedy, not built:** a durable sign-out - the revocation kept and retried until a status answers it - which is a sessions change, not a restore one ([account-restore](account-restore.md#threat-model)).

## Tooling

### P2 - a cargo bump in `mls-core` leaves two committed lockfiles Dependabot will never fix

`mls-wasm` and `src-tauri` carry committed locks and depend on `mls-core` by path, so Dependabot's single pull request (against `mls-core/Cargo.toml`) is incomplete by construction. **BUILT 2026-10-19 (WP-RUST-LOCK-AUTOMERGE), owed what only a live run can show:** `cargo-lock-refresh.sh` completes it on a new branch opened by the `canari-auto-merge` App, and `arm-auto-merge.yml` arms only that, against a closed allowlist ([cicd](cicd.md#a-dependabot-cargo-bump-that-is-incomplete-by-construction-is-completed-and-merged-wp-rust-lock-automerge-2026-10-18), with the threat model). **Owed:** the first real run on a Dependabot `mls-core` pull request (or a dispatch while one is open), read end to end - the refresh pull request opened, ARMED (the one unmeasured fact: that the API resolves the App's commits to `canari-auto-merge[bot]`; if not, it is refused, the safe direction), and merged on `CI passed`. **The structural remedy is still not done:** one cargo workspace with ONE `Cargo.lock` for `frontend/`, which restructures a Tauri build this workstation can only compile.

### P3 - MiGallery's `resolve()` bypasses, and an inherited disable is the only reason nobody sees them

The Canari half is done; `../MiGallery/oxvelte.config.json` still disables `svelte/no-navigation-without-resolve` (16 call sites). Wrap them with the same `internalPath()` pattern, then delete the disable. Measure by MOVING the config file, never by dropping `--config`.

## Localisation

### P2 - NO REFUSAL CAN BE TOLD FROM ANOTHER, BECAUSE ONLY SOME ENDPOINTS CLASSIFY AT THE THROW

The English-on-a-French-screen sweep is finished ([durable-rules](durable-rules.md), [social-service](services/social-service.md)).
**Done 2026-10-10:** `SocialApiError` extends `ApiRefusalError` (so `refusalStatus`/`refusalCode` read it),
and every refused call of `forms/api.ts` and every bare-`fetch` upload, export and provider lookup of
`associations/api.ts` throws it with the status and the code (`refusal`, `socialRefusal`).
**Done 2026-10-18:** `minesweeper/api.ts`, `mls/groupInvites.ts`, `adminerSession.ts`, `vaultDownload.ts`
and `mlsDeliveryApi.ts` (key package publish, device update, commit submit and replay) throw
`refusalFromResponse`'s `ApiRefusalError`; the join page and the minesweeper submit word it from the status.
**Done 2026-10-18 (later):** the remaining plain status sites of `mlsDeliveryApi.ts` (device list, GroupInfo,
rename, image, members, user groups, dismiss, device memberships, kick) throw `refusalFromResponse`'s `ApiRefusalError`.
**Done 2026-10-19:** the delivery and core services carry one stable code per refusal a member can act on,
worded on the client by `describeRefusalCode` ([table](services/chat-delivery.md#refusal-codes---one-stable-name-per-refusal-a-member-can-act-on-2026-10-19)).
Wired to a screen so far: group invite join and link, PIN change, blocked list, directory. Worded but
waiting for a caller that types the refusal: `NOT_A_MEMBER` on notification settings, `USER_BLOCKED` on
add-member, `ADMIN_SELF_DEMOTE` (no admin screen calls it).
**Still owed:** the social-service refusals not yet coded. The
`sessionAuth.ts` site closed with step 2 of the damaged-MLS-state P1 (PK1): the init throws typed errors,
and `serverProse.test.ts`'s allowlist is empty.

## Infrastructure

### P2 - MIGALLERY'S ONLY OFFSITE STILL LANDS ON THE OLD CANARI VM

MiGallery's offsite backup copy still lands on the old VM. **DECIDED 2026-10-18: it goes to Canari's own offsite server** ([WP-MIGALLERY-OFFSITE](#decided-by-the-user-on-2026-10-18---every-design-question-answered)). **Owed:** a MiGallery PR, before the old VM can be wound down. User gestures: a real Sky sign-in with `/admin/legacy` showing the June data, and deleting the stopped Sky container and its old database directory ([estate-migration](infrastructure/estate-migration.md)).

### P2 - A DEPLOY NO LONGER ERASES THE LOGS, BUT NO ARCHIVE HAS BEEN SEEN YET (merged 2026-10-08)

**Owed after the next deploy of each estate:** one `.log.gz` per container in `~/deploy-log-archive/<project>/` and `max-size` on a recreated container ([logging](infrastructure/logging.md)). Authentik's hand-run stack is bounded only when next recreated and is not archived.

## What the duplicated group notice left behind (2026-09-16)

- **P2 - nothing repairs a notice already duplicated on a device.** Owed: the population first (on one real device, the count of `isSystem` rows sharing `(conversation, content)`). Only if large, a one-shot pass gated on proof of breakage with an allowlist of rows - never a heuristic collapse.
- **P2 - 13 full archive walks and 37 reconciliation answers in ten minutes, for one group.** Owed: from production logs (`[HISTORY]` carries `user=`/`device=` since 2026-09-16), walks per group per hour across the estate and the `after=start` fraction per DEVICE.

## Post-campaign projects - decided, not scheduled

- **The MLS + Graine guide for the user** shipped ([chiffrement-et-historique](../user-guide/chiffrement-et-historique.md), #1585). **Owed: the user's read**, and a re-check whenever retention, history rules or device limits change.
- **One MLS client in a SharedWorker** - decided 2026-08-17, after the campaign: [mls-wasm](frontend/mls-wasm.md#one-mls-client-in-a-sharedworker---decided-2026-08-17-not-scheduled).

### `dev.canari-emse.fr` - the two things that outlived the chantier

Environment and decisions: [dev-environment](infrastructure/dev-environment.md). **Owed to the user, nothing here can do it:** the mobile half - a dev Firebase project (the Play service account lacks `serviceusage.services.enable`), a dev keystore and where it is backed up, and a second package id so a pre-release can be measured against production (one item with "a second package id" above).

### A SECOND campaign, for everything that is not chat - asked 2026-08-16

Not started. **Venue DECIDED 2026-10-18: a test association on the DEV estate only** ([WP-SECOND-CAMPAIGN-VENUE](#decided-by-the-user-on-2026-10-18---every-design-question-answered)). Design, the named starting point (the `social` notification family) and the two things left to settle (observer, what a verdict rests on): [cross-client-campaign](cross-client-campaign.md#the-second-campaign-for-everything-that-is-not-chat---asked-2026-08-16).

## THE DELIVERY CHAIN REVIEW - opened by the 2026-09-06 outage

**Open: a real sign-in against the deployed estate, in the pipeline, right after the dev deploy and before a stable proceeds.** The wasm check ships as a gate (2026-10-06, [cicd](cicd.md)) but is not a login. **BUILT 2026-10-18 for DEV only (user decision: no production login in GitHub); owed the user's two secrets and a first-run read** ([cicd](cicd.md#the-smoke-sign-in-wp-smoke-login-decided-2026-10-18)). The other items shipped or were decided not to be built ([cicd](cicd.md#two-incident-time-items-decided-not-to-be-built-2026-10-06)); any proposal must keep four visible workflows.

## The first iOS feedback (2026-09-20) - one reading and one measurement

- **One reading on the reporting iPhone**: the `/posts` and associations scroll on a build carrying the fix ([design-reference section 28](frontend/design-reference.md#28-every-scroll-in-the-app-ran-on-the-main-thread-for-a-gesture-ten-prefixes-cannot-perform)); the Mi 9T settles only Chromium.
- **P3 - one memory measurement on a long feed** (not virtualised; avatars deliberately not lazy). Measure before changing either.

## Audiences of associations, lists and institutions - built, in production since `v1.2.0`

WP-A (#1582), WP-B (#1584), the star reading its audience (#1593), the nominative read grants WP-C (#1606) and their write-boundary fixes (#1608) are built. Decisions and as-built: [profiles-and-access](profiles-and-access.md#the-audiences-chantier---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08). **Owed:**

- **The on-device look** at the Audience tab, the profile campus prompt and the `/admin/read-access` grid.
- **The 8 dev checks of the read grants PASSED on 2026-10-09** ([verdicts](profiles-and-access.md#the-eight-dev-checks-2026-10-09-devcanari-emsefr-on-121-alpha1-same-code-as-v121)). Check 2 (no personal post) passed on the predicate only; an end-to-end reading needs a personal post by a gardanne account, and `canari-test-epsilon`'s credentials are NOT in `<harness-dir>/test-accounts.json`. **User:** add them there (never on a command line).
- **User decision:** let the directory be widened for grantees? (not widened now; only posts, comments, reactions and events are).
- **Ambiguity to answer:** what "an institution of another campus" means for a reader (the grant reaches it today).
- The document-reviewer rows were NOT moved into the grants table (a separate capability on the same page).

## CanaReels: the camera tab cannot be guessed (user, 2026-10-09)

Swiping right from the leftmost tab opens the camera, and nothing says so. Wanted AFTER the video, discard and weak-network chantiers are stable, not before. Ideas to weigh with the user: a peeking camera edge on the leftmost tab (a visible handle that nudges once); a first-run coachmark shown once per account and remembered server-side; a permanent camera icon in the app bar next to the plus; and a "Canareels" entry in the plus menu so the feature is reachable without the swipe. Measure how many users have ever opened the camera before choosing. **DECIDED 2026-10-18: a "CanaReels" entry in the + menu** ([WP-REELS-MENU](#decided-by-the-user-on-2026-10-18---every-design-question-answered)); the other ideas are not taken.

### P2 - HOW the token and the MLS identity of a bench phone came to name two accounts is not established (Mi 9T, dev, 2026-10-10)

**The symptom is GUARDED since the `fix/token-identity-split` PR; the cause is not.** The Mi 9T held Delta's refresh credential over ALPHA's local identity (`canari_saved_user` and the MLS `userId` read Alpha, the token `sub` Delta), so every send answered `403 AUTHZ FAIL caller != requester`, the outbox re-posted the same entries 23 times and live frames went to an account that was offline. It is not a `1.2.2` regression (no change to `auth.ts`, `sessionAuth.ts` or `user.ts` since `v1.2.1-alpha.1`). What stands now, and where it is written: [sessions](sessions.md#a-token-that-names-another-account-than-the-local-identity-is-refused-2026-10-10).

**Owed:** the WRITER of the split. The suspect is an account switch on the bench phone (Alpha's device was first seen at 22:39 UTC, minutes before the 403s began): something signed in as Delta without replacing `canari_saved_user`. The guard now logs `IDENTITY SPLIT: the access token is for X but the local/MLS identity is Y` with both ids, so the next occurrence names the sign-in that preceded it; read that line before theorising. Until a reading says otherwise a bench phone is still re-signed in with `pm clear` and a fresh login, never by signing in over another account.

## Decided by the user on 2026-10-10 - built or queued

- **Pure declines travel as a normal message** (no special transport): PR #1720, DRAFT, awaiting its adversarial review ([messaging convergence](#messaging-convergence)).
- **Per-conversation notification group keys, Android**: not built; the single summary also carries the launcher badge count and cancelling it killed its children once (NOTIF-18), so a Mi 9T reading comes before it ships.
- **A client entitlement floor for a re-admitted device**: design first, in the wiki, then a build with an adversarial review.
- **A reason column on a roster seat without a Welcome** (additive migration, one field in the hourly report): not built.
- **Event co-organisers**: the cap of four associations in total shipped (#1721); owed the shared organiser-faces component for the list and day rows, the detail chips with a quiet pending line, the picker counter, and the ICS and share title naming every organiser (mockup: session scratchpad `coorg/coorg-mockup.html`, not committed). No code capped the picker at two; the interface only LOOKED limited (a pending proposal draws nothing, names truncate).

## Decided by the user on 2026-10-11

- **Standing release authority.** The lead agent arms a pull request after an adversarial review and a green CI, and cuts pre-releases AND stables once the pre-release has been read on a phone and nothing blocks, informing the user each time. It replaces the 2026-10-01 rule (the stable only on the user's explicit go). Still asked first: a direct production change (a hand edit on the host, a production setting such as `minClientVersion`), a data migration or backfill, any deletion of data. Rule: [durable-rules](durable-rules.md#release-and-ci---cicd).
- **`minClientVersion` is `1.2.7` on production AND dev since 2026-10-17** (the user's gesture; it was `1.0.3` from 2026-10-11): Graine G2-5's refusal of an arriving v1 seed is unblocked ([Graine v2](#p1---graine-v2---an-author-that-is-proven-and-a-ciphertext-bound-to-its-place-decided-2026-09-28)), and the `1.2.1` key-group epoch floor is met.
- **No native camera access, anywhere.** The new-post composer and the chat each get ONE "Ouvrir la camera" entry that opens the in-app CanaReel camera; the gallery picker stays. This replaces the chat's `capture` inputs ([chat](frontend/modules/chat.md#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02)). The media's retention class follows its DESTINATION: a post takes the post class, a published reel `reel` (30 days), a chat send `chat-reel` (30 days, [reels-in-chat](frontend/modules/reels-in-chat.md#91-decided---the-ui-target-is-snapchat-user-2026-10-09)). Not built.
- **CanaReels in chats is a chantier, RC-0 to RC-11, and RC-0 (the measurement, no code) comes first** ([reels-in-chat](frontend/modules/reels-in-chat.md#7-the-work-packages-in-order)).
- **The Pixel 6a is the user's personal phone: observation only.** No install, reset, sign-in or driving by an agent; a reading on it is the user's own look ([device-verification](device-verification.md)). The bench is the Mi 9T and the iPhone 12.
- **Apple: wait for the review of 1.2.1 (WAITING_FOR_REVIEW, it holds the only version slot), then submit 1.2.4.** No 1.2.2 or 1.2.3 submission.

## Decided by the user on 2026-10-12, and what the evening left open

- **Polls close by hand**: the author or an admin closes a poll, and an end date is optional. Built on #1783 (draft, with the shortcut scroll fix).
- **The double-tap window stays 250 ms**: #1784 (draft) only stops a double tap from also opening the info panel.
- **Releases while the user is away**: pre-releases freely; a stable only if clean, and never carrying the PIN change (#1777) or the notification landing (#1770), which both want a phone reading first.
- **Reaper pass 2 is DONE**: 118 devices revoked, 30 940 queued rows removed ([second pass](infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#second-pass---2026-10-12)).
- **The WebCrypto checkpoint seal: DECIDED 2026-10-18 - an alpha first, read on both bench phones, a stable only if clean.** Re-sequenced 2026-10-23: #2074 ships the hardened reader with the writer OFF, and the flip is a later pull request gated on both floors reaching that reader's tag ([the P2](#p2---the-web-checkpoint-is-82--wasm-chacha20-seal---built-writer-off-draft-pr-2026-10-12)). The other levers (fewer or smaller checkpoints) change durability instead, and wait for the TAB-3b answer ([performance audit, #1776](https://github.com/emse-students/canari/pull/1776)).
- **Production log retention: DECIDED 2026-10-18 - fewer lines, no retention change.** The per-message `LOG` lines roll the container log over in ~20 minutes ([prod-queue-and-epoch-audit](infrastructure/prod-queue-and-epoch-audit-2026-10-12.md)); they are aggregated per batch since #2018 (`v1.3.0`, [prod-queue-and-epoch-audit](infrastructure/prod-queue-and-epoch-audit-2026-10-12.md)).

**Open pull requests at the end of 2026-10-12** (re-read with `gh pr list --state open`, this list goes stale):

| PR | State | What it waits on |
| --- | --- | --- |
| #1770 F1, a notification opens from the local store | draft, conflicting | PIN-adjacent: a phone reading; kept out of a stable while the user is away |
| #1777 PIN salt asked ahead | draft | a phone reading; kept out of a stable while the user is away |
| #1778 history drawn first, #1779 no group check before a send | drafts | #1779 under adversarial review |
| #1773 the open conversation read by its own key | draft, merged with main | adversarial review |
| #1785 a salon re-read once per drain | draft | review |
| #1783 polls, #1784 double tap | drafts | review |
| #1542 the run-locally rule | conflicting | a rebase |

## Decided by the user on 2026-10-18 - every design question answered

Each line: the decision, its scope as a work package (WP), and what blocks it. Rows elsewhere in this file point here. Also standing: the lead may cut STABLE releases without asking each time (under the 2026-10-11 authority above).

- **WP-DEL-LOCAL (S, no native/MLS): an account deletion wipes THAT account's local message database and its vault slot on the device**, never `wipeDeviceToFactory` (other accounts keep theirs). A sign-out still keeps it. Needs a test. Replaces the open row "Deleting the account leaves its local message database".
- **DECIDED, NO WORK: a device revoked while offline keeps its sealed residue until a login on it.** No unauthenticated revocation route (enumeration oracle), no local expiry (a clock).
- **WP-PRESENCE, the push half (M, server, no MLS): the 10 s phone poll is replaced by a push over the live WebSocket.** The audience half (presence visible only to those who share a conversation or a community) SHIPPED in #2031, `v1.3.0`. Blocks: nothing.
- **WP-SMOKE-LOGIN (S-M, CI, no native): a dedicated smoke account on the DEV estate only**, its credentials as a GitHub environment secret, a real sign-in right after the dev deploy and before a stable proceeds (a stable ships the pre-release that served dev). No production credential in GitHub. Must keep four visible workflows.
- **WP-HOLD-NOTHING (M, MLS-adjacent, OPUS): an additive "I hold nothing" answer to a HISTORY ask**, so the requester records a definitive answer and stops re-asking once per launch. Blocks: verify first that an OLD client ignores an unknown answer frame without error (a test on the old reader), then ship reader-then-writer. **BUILT 2026-10-18** ([channel-encryption section 24](protocols/channel-encryption.md#24-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster-wp-hold-nothing-decided-2026-10-18)): the old reader was checked first (an empty bundle, absorbed silently since `1.0.3`), so reader and writer ship together. **Merge order with #2023:** whichever of the two merges second derives `historyAnswered.ts`'s `KEY_PREFIX` from `ACCOUNT_KEY` (its guard test fails on the literal).
- **WP-CHECKPOINT-SKIP (M, native + MLS, OPUS): skip the full checkpoint after a drain that only received application frames**, forced after K deferred receive generations (K about 200, a COUNT never a clock). **MEASURED 2026-10-22 on the Mi 9T, switch ON, K 20-100, up to 60 skipped frames: 0 lost, 0 `live-ahead`, 0 duplicates, 0 `unreadable for good` in 6 valid trials (table in [the question](open-questions.md#decision-owed---may-a-drain-that-only-received-application-frames-skip-its-full-checkpoint-2026-10-13)); what it does not cover is named there, and the build decision is the user's.** Was blocked on: the Mi 9T crash measurement of [the question](open-questions.md#decision-owed---may-a-drain-that-only-received-application-frames-skip-its-full-checkpoint-2026-10-13) (kill, push while dead, resume, read `live-ahead`, duplicates, `unreadable for good`); nothing changes before it. The v2 seal (writer off) is a separate lever.
- **WP-RESTORE-1 is planned NOW, independent of the campaign** (Play enforcement April 2027): [mobile](frontend/mobile.md#wp-restore-1---zero-tap-sign-in-restoration-accepted-2026-08-26-built-2026-10-18); built 2026-10-18, [account-restore](account-restore.md). Size L, native and a new server WebAuthn component, OPUS. First task: the design and the server piece; Mi 9T test before the deadline.
- **WP-MIGALLERY-OFFSITE (M, ops + a MiGallery PR, no native): MiGallery's offsite backup goes to Canari's own offsite server**, then the old Canari VM can be wound down. Needs the offsite server's access arranged (private notes); a restore test.
- **WP-MENTION-NAME (M, native Android and iOS, OPUS): a mention notification names its author from the phone's local copy of names**, "someone" if unknown; the name never rides the push. Owed: one look on each phone, and on the Mi 9T whether the COLLAPSED shade shows only the first line of a mention (the author line is line 1 of the message and may hide the text). **BUILT 2026-10-18**: the author on a salon banner (an MLS banner already names its sender), and the mentioned person inside the text from the same copy.
- **WP-PUSH-I18N (M, Rust + native readings, OPUS): the 16 notification sentences of `mobile/proto_fields.rs` are translated in Rust from the app language, and a voice note stops being announced as an audio file.** One implementation for Android and iOS; a reading on each. **BUILT 2026-10-18** (`mobile/push_text.rs`), owed the two readings.
- **WP-COORG-ACCEPT-NOTICE (S-M, server + native tables, no MLS): notify the organiser when a co-organisation is accepted** (`CoorganisationService.apply`), a push content in the Android, iOS and NSE tables like `coorganise_proposed`. **Blocks: ships only once `minClientVersion` covers the unknown-type fix (#1911)**, the same floor as the paid-form organiser alert.
- **WP-NICK-COMMUNITY-RULES (part of the nicknames build, S): in a community the renamed person sees "set by X"**, and **a nickname STAYS when its setter leaves** (the target may always reset it); same for groups. Closes the two questions left open in the nicknames entry.
- **DECIDED, NO WORK: the stale "added a member to the group" bubbles on devices from before #1870 are left alone** (no data deletion; they age out of view).
- **DECIDED, NO WORK: iOS keeps its native stacking of post reactions** under `post_reaction_<postId>`; no NSE merge.
- **WP-REELS-MENU (S, client, no native): a "CanaReels" entry in the + menu**, beside the already decided "Ouvrir la camera" entries; measure afterwards how many users opened the camera.
- **WP-SECOND-CAMPAIGN-VENUE (M-L, harness): the second campaign (posts, forms, calendar) runs on a TEST association on the DEV estate only**, so no real member is notified. Design page: [cross-client-campaign](cross-client-campaign.md#the-second-campaign-for-everything-that-is-not-chat---asked-2026-08-16); its three open items (venue, observer, what a verdict rests on) lose "venue".
- **WP-TEST-TOOLING-REFORM (L, harness, no native; NOT "after the campaign"): the whole test tooling is reformed NOW** (user: "on est a un nombre de test aberrant"). It covers the shared helpers (the `mut.mjs` helpers, the eight hand-opened IndexedDB runners, the local database access), the starting-point contract, and the number of tests itself - cut what does not earn its keep. It re-validates the controls it touches (rule 33), so a revalidation session is part of it, and it supersedes the "wait for a wholesale rig change" lines of [the harness section](#the-harness-itself) and [cicd](cicd.md). Start with an inventory: which tests exist, what each guards, what its last failure caught; delete the rest. **Done so far**: the inventory (#2129) and the deletion of ten byte-identical spec copies in the NestJS services (-81 jest cases; `http-error-log.spec.ts` kept in both, with its reason) - [test-suite-reform](test-suite-reform.md#72-the-declared-copies-deleted-2026-10-21). **Also done (2026-10-21)**: the `customTabsCommands`/`keystoreCommands` merge, the `features.test.ts` reading and the two `no-assertion` files ([7.3](test-suite-reform.md#73-the-frontend-desk-items-2026-10-21)). **Left**: WP-T7 (the rig change, one campaign session with its re-runs).

## Chantiers in planning (opened 2026-10-15)

- **Bookings** (rooms and slots, a module of its own): 41 decisions and eight work packages in [bookings-chantier](bookings-chantier.md). Draft PRs open: the `MANAGE_BOOKINGS` right (WP-B0, a DATA migration that needs the user's yes before merge).
- **Paid public forms** (the same as a paid internal form, answered with no account): five decisions and five work packages in [public-paid-forms-chantier](public-paid-forms-chantier.md). WP-P0 (a pending payment stops holding a seat for ever) also fixes a defect members have today. The observed payment waits on WP-LYDIA-1.
- **P2 - A MULTIPLE-CHOICE GRID QUESTION WHOSE OPTIONS SIT IN TWO BUCKETS IS PRICED ON THE FIRST BUCKET (found 2026-10-22, paid forms, members and guests alike).** `bucketFor` (`apps/social-service/src/pricing/audience.ts`) returns the first bucket, in the grid's order, that ANY selected option matches. So the price depends on the order of the buckets, not on what was chosen, and an answer can pick a cheaper cell by adding an option. **The fix:** refuse, at save, a grid dimension on a `multiple_choice` question whose options fall in more than one bucket, beside the overlapping-bucket refusal (`findOverlappingBuckets`, checked in `pricing/price-matrix.ts`). That check would need the form's items to know the question's type. Pricing each option on its own bucket and summing is the alternative, but it changes what a grid means. **The test that lifts it:** a `forms.service` spec saving a grid on a multiple-choice question with options in two buckets is refused, and the same grid with every option in one bucket is accepted.
- **The FILE question type** for forms (WP-F) serves both: decisions D7, D8, D22, D40, D41 of the bookings page.
- **Blocked on the Lydia documentation (2026-10-15):** the expiry parameter of `request/do` (D1) and a call that cancels a Lydia request (D2) appear nowhere in the repository and no public Lydia documentation was found; the user is asked for it. Until then a pending form answer past its 30-minute hold is not reused, and a cancel of an old request must never cancel the live one (see [public-paid-forms-chantier](public-paid-forms-chantier.md)).
- **Organiser alert for a paid form that is full (D3, held by the user's decision of 2026-10-15):** it ships ONLY once the minimum client version covers the client fix of PR "unknown notification type" (an unknown type renders neutral with no link). Then: a durable flag `organiserNotifiedAt` claimed through `claimFulfilment` and `releaseFulfilment`, recipients = the owner plus holders of `MANAGE_FORMS` through `mayAct` (never a global admin), a new `PushContentKey` whose argument is the form title only, filed under the EXISTING `forms` category (no new id, which also avoids the preferences defect), a migration at the next free number, and a deep link that opens one form's responses (an accordion on `/forms`, so a route or parameter is needed). **BUILT 2026-10-22 and SWITCHED OFF** (`FORM_ORGANISER_ALERT_ENABLED = false`, migration 102, deep link `form-responses/<id>` -> `/forms?responses=<id>`; recipients are the owner and the members whose own rights carry `MANAGE_FORMS`, never the BDE super-admins (user, 2026-10-22), see [forms](frontend/modules/forms.md#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off)). **Owed:** `minClientVersion` at or above the version that CARRIES #2228 (its first stable, not merely `1.2.9`), on BOTH estates (production and dev each hold their own row in `/admin/platform`), once BOTH Play AND the App Store serve that version (the user's gesture; it reads `1.2.7`), then a follow-up pull request flipping the constant and its spec.
- **While that alert is switched off, a GUEST who pays over capacity is told to nobody (paid public forms, 2026-10-22).** The row lands `paid_over_capacity` and is listed first in the form's responses; the refund, owed outside Canari, depends on the organiser looking at that table. Switching the alert on (above) closes it for guests as for members.
- **Accord of the user, recorded (user, 2026-10-22, relayed by the lead session): migrations 100 (Lydia Business key per association) and 101 (product checkout attempts) MAY ride the next STABLE to production; payments stay OFF in production.** Nothing is enabled by it ([payments](frontend/modules/payments.md)). No "migrations need the user's yes" line exists in the owed table on `main`; that wording lived in the #2215/#2218 PR bodies.
- **Two decisions of the lead session (2026-10-22) on single-answer paid forms**: a refund or a manager delete does not free the slot, and a pending cash answer still refuses an online submit ([forms](frontend/modules/forms.md)).
- **Accords of the user, recorded (user, 2026-10-15, in session, relayed by the planning session at Master's request), covering: D1-D3 of the paid-form chantier, the backfill of migration 083, the data half of migration 084 before production, `minClientVersion` 1.2.7 (the user's own action), the anonymous-form file question refused, and Lydia states 1 and 5 to be measured by hand on the homologation payer page.** What it does NOT do: it starts no work package (WP-B1 and later lots wait for the lead session), marks nothing ready, merges and releases nothing. The 084 deploy ships with the next STABLE under the lead session's release authority; `minClientVersion` and the two Lydia measurements stay the user's own gestures.
- **FUTURE lot: a file question on a PUBLIC form (no account) - the user asks for it (2026-10-15).** Refused in #1908 (public and anonymous forms). It needs an abuse design before any code: a limit per address or per token, a size cap, a global quota, a scan, an anonymous upload path with its own purge of files never linked to an answer. Nothing in the repository holds that design yet.

## Decided by the user on 2026-10-19 - lives before calls, and what a live owes before a stable

Wording in [live](frontend/modules/live.md#decisions-of-2026-10-19). Lives come BEFORE the calls revival (calls stay dev-only; supersedes L7). v1 bitrate (720p or 480p) is fixed at launch by the server from the total live load: no transcoding, no mid-live change. Any member may start a live, so **WP-L8 moderation (like posts: `content_reports`, "cut the live" in place of "delete the post", posts code reused) and the per-account limits are a RELEASE BLOCKER before any stable, and the Apple 1.2 / Play UGC answers precede store submission.** Comments and floating reactions are wanted (WP-L6). The "X est en live" notification: server half WP-L7 in progress (draft PR), **owed: the client LIVE card and deep link.** **Open question from the user:** why ask the school IT department - only for raising the shared host nginx connection budget (about 1500 across its sites), not needed until an audience would exceed it.

## Decided by the user on 2026-10-22 - a 48-hour autonomy window, and what it covers

1. **Autonomy window, 2026-10-22 to 2026-10-24 (48 hours).** The lead may cut pre-releases AND STABLE releases (production plus both stores) without asking, once the alpha has been read on both bench phones and nothing blocks. The user is told AFTER each release. This extends the release authority of [durable-rules](durable-rules.md#release-and-ci---cicd) for the window only.
2. **Kill switches for calls and lives.** The lead may switch them on in dev, and in production if ALL device readings pass (a reversible kill switch). **Payments stay OFF in production.** (Measured 2026-10-23: the flag already read `lydia`; the sandbox pair and the lack of any onboarded Business kept it inert, and the user then had production tested the same day - [payments](frontend/modules/payments.md#enrolment-goes-through-canari-and-only-through-it-2026-10-23).)
3. **Migrations.** 100 (Lydia Business key per association) and 101 (product checkout attempts) may ride the next stable.
4. **Cleanup authority.** The stale draft pull requests #2117, #2098, #2127, #2109, #2090, #2074, #2065, #2041, #2039, #2013 and #2011 may be closed, each ONLY after verifying that its content is already in `main` or that it is abandoned, and with a comment saying which. A local branch holding unique commits is archived as a tag before it is deleted.
5. **Priorities for the window, in order:** lives and calls; payments and reservations; MLS robustness (replay markers, group history, Graine); the backlog and the test-tooling reform ([WP-TEST-TOOLING-REFORM](#decided-by-the-user-on-2026-10-18---every-design-question-answered)).
6. **Organiser alert (#2228).** Recipients stay the owner plus the holders of `MANAGE_FORMS`; super-admins are excluded. The lead may raise `minClientVersion` on both fleets AFTER verifying that Play AND the App Store both serve the carrying version, then flip the alert constant (see the organiser-alert item under [2026-10-15](#decided-by-the-user-on-2026-10-12-and-what-the-evening-left-open)).
7. **Store text.** The lead writes the stable's `store/whats-new.txt` in plain French from the merged changelog fragments and checks it with `--check-notes` before tagging.
8. **Contact.** This conversation only; no push notification.
9. **Incoming share (Android)** is erased at sign-out and at account switch. This REVERSES the earlier documented decision, which kept it. **iOS share lot S4 is left aside** until an App ID and a provisioning profile exist.
10. **The local estate was stopped.**
11. **Privacy texts for calls (#2183) and lives (#2199).** The lead may publish them as drafted, together with the production activation, AFTER an opus review covering GDPR, minors and recording.
12. **Lives on R2 (#2211), decisions O-1 to O-7.** The lead decides following the recommendations in that pull request and records EACH decision here with the measurement that justifies it. No visible viewer cap; the technique follows.
13. **Store questionnaires and pieces** (App Store privacy answers and the review video for lives, #2196; Play data safety, calls B14, #2188). The lead submits only what accompanies a stable it cut, and NEVER changes a data declaration without the user.
14. **Production incident during the window.** The lead may cut a kill switch, restart a container, or redeploy the previous stable. Nothing destructive: no data deletion, no reverse migration, and no admin bypass without writing to the user first in the conversation.
15. **More migrations (2026-10-22).** chat-delivery 033, 034, 035 (#2254, #2260, #2270) and social-service 106 (#2265) MAY ride the next stable. **034 makes chat-delivery forward-only**, and the release notes say so.
16. **Store listings (2026-10-22).** Redo everything, texts AND images, with FICTIONAL demo accounts created on dev and no personal data. The user sees the texts and the images BEFORE any submission.
17. **The next pre-release (`1.4.1-alpha.1`)** is cut as soon as the ready batch of security and sharing pull requests has merged, without waiting for the rest.
18. **Standing reminder from the user:** *"il faut toujours vider le backlog, et assez rapidement avoir les lives et les appels en production"*. The backlog is always drained, and lives and calls reach production quickly ([live-production](frontend/modules/live-production.md), [calls](frontend/modules/calls.md)).
19. **Phone at-rest key (#2274): the built design stays** (user, 2026-10-22, after first choosing a variant that also mixed the PIN into the key, then seeing what it would add). Notifications stay complete, the PIN is verified by the server, the hardware key protects the stored data, practicality first.
20. **Migrations chat-delivery 036 (`dm_seat_evictions`) and social-service 108 (`distribution_departures`) may ride the next stable** (#2258).
21. **Lives: the live key is encrypted at rest under an environment secret** (a migration, the user's yes). `calls_mode` may be set to `audio` in production by the lead as soon as the stable is deployed and read on both phones, with an immediate notice to the user; `lives_mode` may be opened in production by the lead once everything is read, with an announcement from the lead. The incident rule of the window is unchanged.
22. **iPhone ring: practicality.** Until a native ring exists (PushKit VoIP token plus CallKit, its own switch), the iPhone call alert is generic ("Appel entrant", no name); that work package joins the calls queue.

## Decided by the user on 2026-10-23 - bookings redesign, sharing, reels, calls, payments, MiConnect, release

All taken in session on 2026-10-23. Bookings rows are D44-D54 in [bookings-chantier](bookings-chantier.md#redesign-decided-2026-10-23).

**Release and priorities.** The next stable ships *"as soon as possible, we reach a big update"*; this REPLACES the 2026-10-27 date, and `ADMISSION_PROOF_SINCE` must follow the real day. UI changes ride the `1.4.1` pre-release after adversarial review and green CI, are read on the Mi 9T and the iPhone, then shown to the user. Priorities named: lives in production, video calls (lot 2), association enrolment with conditions and documents, dependency majors (SvelteKit 3, adapter-node 6, webrtc 0.21, mediabunny), bookings. Containers are a SEPARATE lot (non-root users, Debian trixie for the Rust runtimes), pre-release first. Store listings come AFTER the stable. The Pixel 6a is the user's personal phone, looked at only when the user asks.

**Bookings redesign** (mockups first, built *"Tout de suite, en parallele de la stable"*): rows D44-D54 of [bookings-chantier](bookings-chantier.md#redesign-decided-2026-10-23).

**Sharing (#2311).** A shared reel card opens the reels viewer; the post page header Share opens the same sheet; no warning to the sender; no dedicated MLS message type (link plus card); the external link preview stays as is; single-destination send first, multi-send later.

**Reels and comments (#2309, #2310, #2314, #2327).** A long press on the reaction opens a vertical drawer. Minimal player: thin progress line at the bottom, no timecode, never a play/pause button at load or autoplay; rail order reaction, comments, share, download, then sound. Post comments use the same drawer as CanaReels with a short animation, no quoted post header, over the interface on phones. The Instagram quick-emoji strip is NOT wanted.

**Calls.** Full-screen call screen with name and photo on every platform (#2306). The iPhone Recents history of calls is KEPT. The app is not distributed in China. The native ring switch is split per platform (Master's decision).

**Payments.** Production Lydia is live for the user's test with the production pair; production accepts ONLY `LYDIA_ENV=production`; `payment_provider` stays `lydia` after the test.

**MiConnect** (user: *"MiConnect est une partie extremement sensible, beton, securisee; s'il faut signer, on signe"*). The Alumni SAML source is disabled in production (#2318, applied 2026-10-23, two fields changed); every SAML source must be signed and is enabled only with a verification certificate. The default `akadmin` account was DEACTIVATED in production on 2026-10-23. Impersonation is to be disabled; the profile-editor token is to be restricted to non-admin accounts. The `localhost:1420`/`1421` redirects are kept for now (local development has no dev identity provider). The authentik bump to 2026.8.5 is authorised (#2315).

**Repository settings.** Secret-scanning push protection is enabled; a `code_scanning` rule (CodeQL, high or higher) was added to ruleset `22152902` on 2026-10-23.

**#2273.** The cut date is the day the production stable carrying it ships (fixed constant `ADMISSION_PROOF_SINCE`, re-checked before the stable's final pre-release). Old invite links are accepted as a "from arrival" reading. A removed signer's voucher counts only if the device saw it BEFORE the removal. The invite-link grant expires with the link (30 days when it has none). Migration social-service 107 may ride the stable.

## Decided by the user on 2026-10-23 - the night of the open pull requests

Taken in session on 2026-10-23, one decision per open pull request.

1. **#2260** (key-group frame stored once, table `queued_payload`, a migration) ships in the NEXT STABLE, after an Opus review.
2. **#2322** (Trivy image scan, with the `postgres:18-alpine` digest and the nginx tag in `docker-compose.prod.yml`) merges as is. The user accepts a short availability break when production's database container is recreated.
3. **#2321** (MiConnect password-sign-in guard) merges as is. The only accounts with a password are test accounts, recreatable at will, so the per-username lockout and the admin-name distinguishability are accepted.
4. **#2299** (in-app 1:1 audio calls) is in the next stable with `calls_mode` left OFF server side. Master opens it after a reading on both bench phones and tells the user at once.
5. **#2269** (periodic MLS key refresh, post-compromise security, 93 files) ships IN the next stable, after a full Opus review and a reading on the Mi 9T and the iPhone.
6. **#2282** (CLAUDE.md cleanup) merges LAST, rebased just before.
7. **#2183** (public privacy policy and GDPR register for calls) is published with the next stable. The Cloudflare data-processing-addendum row of the register stays OPEN.
8. **Housekeeping.** Merged pull requests' remote branches are deleted in one pass, and obsolete drafts (#2316, superseded by #2329) are closed, each head archived as a tag first.
9. **Review of #2264** (history visibility reconciled with the proven-admission gate): an unknown rule parks the ask; `unverifiable` answers with silence on both paths; the "nothing for you" stays lasting, and only the repair path recovers the past.
10. **P3 - CI: split the 15-minute `Test Frontend (Svelte)` job into parallel jobs.** Not started ([cicd](cicd.md)).

## P3 - the vendored websocket plugin: four upstream behaviours found by the review of #2167

All four are upstream behaviour kept by the vendored copy (`frontend/src-tauri/patches/tauri-plugin-websocket/src/lib.rs`), none introduced by the happy-eyeballs patch.

- **`send` holds the global `ConnectionManager` mutex across `write.send(...).await`.** A stalled send (a dead peer, a full buffer) blocks every other `send`, and the registration in `connect`, until it resolves. Fix: release the lock before awaiting (take or clone the writer out first).
- **Frames can reach the Channel before the page calls `addListener`, and are dropped.** `connect` returns the id, then the page registers its listener (`TauriMlsService`, `this.ws.addListener`) while the read task is already running. So even an ON-TIME socket can lose the gateway's `pending_welcome_notify` drain (`apps/chat-gateway/src/handlers.rs`, which deletes the key once the send succeeded), not only a late one ([mobile](frontend/mobile.md)). Fix direction: buffer frames until the first listener exists.
- **The writer is removed only on `Message::Close`.** A read error, or a page reload during or after `connect`, leaves a registered writer and a live socket for the life of the process. Fix: remove the writer when the read stream ends for any reason, and when the window is destroyed.
- **The `every address failed` WARN is reported twice**: once by `happy_eyeballs.rs` (`[WS-NET] ... could not connect`) and once by the caller that logs the rejection with its reconnect decision. Keep the one that carries the decision.

## P3 - Android lint crashes on the Gradle build script, and no CI gate runs Android lint (found 2026-10-20)

`./gradlew :app:lintUniversalDebug` (in `frontend/src-tauri/gen/android`) crashes inside Android lint's `UastGradleVisitor.visitBuildScript` on `main` as well, so it is not a regression of one branch. Nothing in CI runs Android lint, which is why nobody saw it. Owed: find which build-script construct the visitor cannot read (or the lint version that fixes it), then decide whether lint belongs in a gate.

**What is known (2026-10-21, not reproduced).** `frontend/src-tauri/gen/android/app/build.gradle.kts` already carries a comment on its `lint {}` block naming the same family of crash (`KotlinScriptUClass` / `findFirCompiledSymbol`, an Android Gradle Plugin bug) and works around it for the RELEASE gate only (`checkReleaseBuilds = false`); an explicit `lintUniversalDebug` still reaches the analyzer. The pins are AGP `9.0.1` (`buildSrc/build.gradle.kts`) and Gradle `9.1.0`; the lint version is AGP's own. **Why it was not reproduced:** the Android SDK is present on the dev box, but a bare `./gradlew` stops at `settings.gradle` line 11 (`tauri.settings.gradle` does not exist), so reproducing needs the project generated by the Tauri Android tooling and the Rust Android targets first. **What is needed:** (1) generate the project, run `./gradlew :app:lintUniversalDebug --stacktrace` and keep the full trace: the frame under `UastGradleVisitor.visitBuildScript` names the construct; (2) bisect the root `build.gradle.kts` and `app/build.gradle.kts` (the `run { ... }` cargo-registry block in the root script is the likeliest non-declarative construct); (3) try a newer AGP patch release. Nothing in CI runs Android lint, so no gate is affected meanwhile.

## Found by the dev payment end-to-end of 2026-10-21 (Lydia, sandbox)

Run through the harness Chrome on dev with `echecs-fictif` linked to the sandbox Business. Substance and
measurements: [lydia-api](lydia-api.md) and [payments](frontend/modules/payments.md).

| Sev | Finding | State |
|---|---|---|
| P1 | A payer who DECLINES (`request/state` 5) is stuck "pending" with no retry; the retry answers `PREVIOUS_PAYMENT_OPEN` | fix in review (#2210) |
| P1 | A single-answer paid form accepts a second submit and records a second payment | fix in review (#2215) |
| P1 | A boutique `order_ref` is the same string per product and user, so Lydia refuses every second attempt (error 3) and a product cannot be re-bought after a decline | agent lot running (stored product checkout + unique `order_ref`) |
| P2 | Turning payments on platform-wide never put withheld products on sale | fix in review (#2205) |
| P2 | An out-of-range amount shows only a generic error and writes no log | fix in review (#2208) |
| P3 | `request/state`'s `signature` was logged in clear; a free-amount product read "Libre (0-inf EUR)" | fix ready (#2209) |
| P3 | The expired-form page has no retry control | covered by #2210 |
| P2 | Re-running the Lydia onboarding silently replaces a linked, validated Business | open: refuse or ask for confirmation |
| P3 | A product with no price is creatable and its checkout answers 400 with no log | open |
| Owed | The confirm callback verified with a Business key | done in production 2026-10-23 ([lydia-api](lydia-api.md#3-callbacks-confirm_url-cancel_url-expire_url)) |
| Owed | A refund end to end, the default `expire_time` (at least 47 min), the deep link as `end_mobile_url` | open, [lydia-api](lydia-api.md#6-still-unknown); `request/cancel` on a PAID request measured 2026-10-23 (error 2, stays paid) |

## P3 - legacy link seats written before migration 038 would now be listed by the group panel (found 2026-10-25)

The group panel reads the user-level roster (`user-members`) and drops only seats flagged
`awaitingAdmission`. A link seat written BEFORE migration 038 got `awaitingAdmission` defaulting to
`false` and never entered the MLS tree, so it would now appear as a member. Owed ONE production count,
read-only: roster rows with no active or admitted device of that user in that group. Nothing was run
on production. If it is 0, delete this section; otherwise a backfill migration the user approves.
