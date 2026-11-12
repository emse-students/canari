# Engagement - who is told, whom to follow, and how much is too much

## The product principle (owner, 2026-11-10)

*"La philosophie de Canari c'est de permettre aux gens de retrouver toutes leurs informations rapidement. L'engagement (et avoir une activité agréable) n'arrive qu'après, et ne doit jamais gêner le premier point."*

**It takes precedence over every engagement choice on this page.** Finding information comes first;
a ranking, a suggestion or a notification that makes a reader's information harder to find is wrong
whatever it does for engagement. That is why Campus and Associations are strictly chronological
with nothing inserted, why Pour toi leads with the fresh posts of the people a reader follows before
any suggestion, and why a global search is the next design question
([backlog.d](backlog.d/global-search-to-design-after-1-6-9.md)). Also in
[design-reference](frontend/design-reference.md#0-the-product-principle-above-every-choice-owner-2026-11-10).

The owner's engagement chantier (2026-11-07): more people notified, following made easy, and
Instagram-style follow suggestions, with a ceiling on the noise. This page holds the decisions, the
design that answers each one, what each surface reveals and to whom, and the work packages in order.
The queue entry is [backlog.d](backlog.d/engagement-chantier.md).

**The feed tabs of 1.6.9 (owner, 2026-11-10)**: Suivis became **Pour toi** (what the people one follows write
or repost - an entity's post a followed person reposted included -, ranked by freshness and
popularity, the suggested posts of people merged into it with no quota) and "Mon espace" became
**Campus** (chronological, nothing inserted) - every decision, the score, the bands and the paging are
in [posts](frontend/modules/posts.md#the-owners-decisions-of-2026-11-10). What that changed on this
page: WP-6's carousel lives in Pour toi only and offers people only; WP-7's posts are placed by the
server's ranking, not by `placeSuggestedPosts` (deleted), so L13 no longer applies to Pour toi. WP-10's
campus-trend notifications were reshaped the same day after the deploy of 1.6.9 announced a backlog
([below](#the-deploy-of-2026-11-10-and-what-it-changed)): at most ONE a day per reader, a post past
the threshold before it was first evaluated never announced, "Suggestion :" wording, their own
**Suggestions** push (OFF by default since the charter, its in-app suggestions on, [below](#aligned-with-the-charter-owner-2026-11-10)), and never sent to a build too old to draw them.

**Quieter, for 1.6.10 (owner, 2026-11-10, second batch: *"on y est allés un peu fort"*)**: friends'
activity no longer notifies - a campus trend NAMES the followed people who liked the post instead;
at most TWO trends a week per reader on top of one a day; and ONE global daily push cap of THREE
across every engagement-only kind. Every decision and the lead's placements are
[below](#the-owners-decisions-of-2026-11-10---quieter-1610).

**State: WP-1 and WP-1b BUILT (the association live audience, and its 6-hour bound); WP-3 BUILT
(the bell, 2026-11-08, [below](#wp-3---the-bell-built)); WP-2 BUILT ([below](#wp-2---suivre-everywhere-built), with one small server route); WP-4 BUILT (openings for followers, 2026-11-09, [below](#wp-4---openings-for-followers-built), its copy HELD); WP-5 BUILT (the suggestion query, 2026-11-09, [below](#wp-5---the-suggestion-query-built)); WP-6 BUILT (the surfaces, 2026-11-09, [below](#wp-6---the-surfaces-built)); WP-7 BUILT (suggested posts, 2026-11-09, [below](#wp-7---suggested-posts-built)); WP-8 BUILT (the daily cap, 2026-11-09, [below](#wp-8---the-daily-cap-built)); WP-9 BUILT (friends' activity, 2026-11-09, [below](#wp-9---friends-activity-built-retired-2026-11-10)); WP-10 BUILT (campus trends, 2026-11-09, [below](#wp-10---campus-trends-built)) - every work package is built. R1 and R2 READ on production 2026-11-09 ([R1](#r1---the-trend-threshold), [R2](#r2---the-cap-check)).**

Context it must respect, and which nothing here changes:

- **Every PERSON account is private**: following a person is a request they accept (`user_follows.status`,
  WP-F1). Associations, lists and institutions are free to follow (`association_follows`).
- **A private account stays findable** in search and suggestions ([backlog](backlog.md), "Follow
  requests... decided 2026-10-25", Q4).
- **The notification categories keep applying**: chat-delivery's `push-category.ts` (`posts`,
  `forms`, `events`, `bookings`, ...) decides last, after everything on this page, and an
  association mute (`association_push_mutes`) keeps silencing that association's pushes.
- **Design references**: the feed and CanaReels follow Instagram.

## Aligned with the charter (owner, 2026-11-10)

"Nos principes", the owner's charter of 2026-11-10: **principle 1**, nothing about a person is
shared or processed for engagement unless they asked; **principle 3**, the reader decides what the
app takes of their attention and their data - no trap scrolling, a chronological view always
exists. Each decision below is built in `1.6.10-alpha.2`, and names the principle it applies.

| Decision | Principle | What existing accounts get | Where |
| --- | --- | --- | --- |
| **"Deux niveaux" (owner, 2026-11-11): "Suggestions dans l'app" ON by default, the suggestion PUSH OFF by default** - principle 3, *"chaque suggestion... se coupe en un geste"*, and the owner's choice of two levels over one opt-in switch | 3 | **in the app: on**, as before 1.6.10 (opt-out); **the push: off for every account** - the switch shipped in `1.6.10-alpha.1` stored only the DISABLED categories, so an explicit "on" and "never touched" are the same row, and no push is backfilled. **An account that switched the alpha.1 "Suggestions" off keeps BOTH off** (its row lists `suggestions` as disabled). That is an explicit choice, never a by-product: `v1.6.10-alpha.1` (a pre-release, so its tester builds and web wrote the dev estate only - the store builds bake `DEV_BASE_URL`, [mobile](frontend/mobile.md); production has no row from it) drew "Suggestions" as an ordinary opt-out category whose GET answered the stored set, and had no push opt-in, so no account carries a push "on" from it; the client that defaulted it to off was the first draft of #3329 and never shipped (read from the tag, 2026-11-11) | ONE category, `suggestions`, two columns: `"disabledCategories"` lists it when the app switch is off; `"enabledCategories"` (chat-delivery migration **047**, plain `ADD COLUMN`) lists it when its push is on. It is pushed only when both say so (`effectiveDisabledCategories`; social's `pushCategoryOffSql` for the daily cap). Each is switched off in one gesture: the app switch off also takes the push off, and turning the push on turns the app switch on (a push of suggestions the reader does not see in the app would be unreadable) - a reversible lead placement. The GET answers both sets as stored (`disabled`, `enabled`); **only a save carrying `enabled` - how a build declares it knows the opt-in reading - may change the push** (review of #3329, P3): an alpha.1 or older save never turns a push on |
| **"Suggestions dans l'app" covers every in-app suggestion** | 3 | on, as above | the server decides: `suggestionsOn` (the app switch) gates `SuggestionsService.suggestionsFor` (the carousel and "Suivez aussi...") and `suggestedPostIds` (the suggested posts of Pour toi, and the legacy `me/suggested-posts`); `suggestionsOnSql` gates the campus-trend candidates (their bell rows); the Settings switches forget the follow-suggestion read the session held (`resetSuggestions`) |
| **The bell withholds ONLY suggestion and engagement content** (review of #3329, P2) | 3 | applies at once | ONE allowlist, `BELL_ROW_GATE` (social's `push/notification-category.ts`, a `Record` over every type, its gated list pinned by `notification-category.spec.ts`): `campus_trend` (the app switch), `friend_reaction`/`friend_comment` ("Publications"), `birthday` ("Anniversaires") - withheld while that category is off in the app. EVERY other notice is written, its push still following its category: what asks the reader to act (`form_paid_over_capacity`, `lydia_payments_paused`, `delegation_receiver_not_ready`, `repost_personal_requested`, `repost_proposed`, `event_pending`), what answers their own request (`event_validated`/`_rejected`, `repost_personal_accepted`/`_refused`), what is addressed to them, what they subscribed to. The withheld count is logged at debug |
| **"Partager mon activité" is OFF by default** | 1 | **off for every account that never chose**; an explicit choice is kept. No migration: no row now READS as off (`sharesActivitySql`, the ONE predicate); the column's `DEFAULT true` was never relied on, every write sets the value | `engagement-sql.ts` `sharesActivitySql`, read by `campusTrendNamedSql` and `resolveTrendLikedBy` (who a trend names) and by `GET me/activity-settings`. No feed surface of friends' activity is left to read it (WP-9's push was retired the same day) |
| **"Défilement infini des CanaReels"**, ON by default | 3 | unchanged (on) | per device (`canari_infinite_reels_enabled`); off, a FEED video opens a viewer that ends at that post (`feedReelsContinue` is false and the viewer is handed `NO_FURTHER_REELS`, the list a conversation's reel already used, with no order switch); on, the stream after the video follows the reader's order with the switch (owner, 2026-11-11, [reels](frontend/modules/reels.md#the-order-of-the-stream-and-a-change-of-order-is-a-new-list-owner-2026-11-10-crash-fixed-2026-11-11)); the CanaReels entry is the reader's choice of the stream and is not affected |
| **"Pour toi / Récents" at the top of CanaReels** | 3 (a chronological view always exists) | Pour toi, as before | `reels/reelOrder.ts`, remembered per device like the feed's tab; Récents asks `feed=reels` WITHOUT `ranked` - the server's newest-first list, paged by offset, no ranking |
| **"Lecture automatique des vidéos"**: Toujours / Wi-Fi / Jamais, Toujours by default | 3 | unchanged (Toujours) | `video/autoplayPolicy.ts`, asked at the ONE ambient start (`playWhileVisible`'s `tryPlay`); not allowed, the feed video keeps its first frame and draws the play button. Wi-Fi reads `navigator.connection.type`, which only Chromium (the Android app) exposes - **an unknown link is not Wi-Fi**: on iOS, Safari and Firefox the setting offers only Toujours and Jamais (owner, 2026-11-11), and a "wifi" stored there applies AND is drawn as Jamais (`videoAutoplayMode`, logged once at debug). The link is read reactively (`video/networkLink.svelte.ts`, the `change` event). A video the READER started plays again when a viewer over it closes, even at Jamais (`playWhileVisible`'s `readerStarted`). A full-screen viewer plays whatever the setting; a conversation's video never started by itself |
| **Register and policy** | 1 | - | [register](compliance/register-of-processing.md) C5 (reels kept one year, `REEL_RETENTION_DAYS` = 365; in-app suggestions opt-out, their push and the activity opt-in), C7 (the opt-in push, the bell allowlist), C8 (`form_drafts`, migration 146), **C28 Minesweeper** (challenges, scores, per-promo ranking showing the promo, the profile badge, bans); `/legal/privacy` changed with it |

**Owed**: a reading on both phones of the two settings and the Récents order; a production read,
after the stable, of how many accounts turn "Suggestions" and "Partager mon activité" on.

## The owner's decisions of 2026-11-10 - quieter (1.6.10)

Taken after 1.6.9 reached production, on what its first day pushed. Built in #3316, with the fixes
of its adversarial review.

1. **Friends' activity is no longer a notification.** `friend_reaction` and `friend_comment` write no
   bell row and no push any more (`posts/friend-activity.ts` and its spec are deleted); the feed's
   "X a aimé" is unchanged. **The campus trend names them instead**: per reader, ONE account they
   follow (accepted) that LIKED the post (`TREND_LIKE_REACTIONS`: "J'aime" or "J'adore" - a "Rire"
   is not a like; the lead's reading) - the smallest id, so the choice is deterministic - under
   friends' activity's disclosure rule (rule 0 the account's "Partager mon activité", rule 1
   accepted, rule 3 reactors not withheld from the reader, rule 4 no block either way, rule 6 never
   the post's author - an ANONYMOUS author included, since the guard is on the id; the review
   cohort; rule 2 holds because the reader is a trend candidate), and how many OTHER accounts liked
   it - never counting the author, the named account or the reader themself:
   "Suggestion : <début> - aimée par Léa et 9 autres". Read in the trend's own statement
   (`campusTrendNamedSql`).
   - **The row keeps the account's ID, never its name** (`meta.likedBy = {userId, others}`). The
     bell resolves the name when it is SERVED (`PostNotificationsService.resolveTrendLikedBy`, one
     statement per page) and shows it only while the naming still holds - every condition the send
     path asked, re-asked with the same helpers: the account exists, still LIKES the post (the same
     list, `TREND_LIKES_SQL` in `engagement-sql.ts`), shares its activity, is still followed
     (accepted), no block stands either way, it is not the author, both stand on the same side of the
     review cohort (`sameSideOfReviewCohortSql`), and the post's reactors are not withheld from the
     reader (`commentsWithheldFromViewerSql`); otherwise the row names nobody. So an erasure, a like
     taken back, a block, an unfollow or the switch turned off takes the name out of rows already
     written, and the erasure also removes the id
     (`post_notifications_liked_by`, `meta - 'likedBy'`). The push is sent at once and carries the
     name of that moment (`actorName` plus `contentCount`); a delivered push cannot be recalled.
   - The three trend keys stay; every native table chooses one of three sentences by the count
     ("Aimée par Léa", "... et 1 autre personne", "... et 9 autres", English "Liked by ..." at
     parity), and the bell row draws the same through Paraglide from the served `{name, others}`.
   - A reader who follows nobody that liked it gets the fixed sentence, as before. Under the
     **Suggestions** switch like every trend. The client floors do not move: 1.6.10 is the first
     build that draws a trend at all. "Partager mon activité" now governs exactly that naming (its
     hint rewritten).
   - **Every bell row is written first, in one insert** (`createNotificationRows`), then one push per
     group of readers who read the same sentence, each group's failure caught and logged on its own;
     `[TREND] ... told N` closes the announcement. The rows are written AFTER the statement that
     claimed the week committed, so an insert that fails still spends each reader's slot for the
     day and the week - logged at WARN (`[TREND] post=... not told`), as the ledger row already was:
     a reader is never told twice, at the price of one trend lost on a failed write.
2. **At most TWO trends a week per reader**, on top of one a day: a Monday-to-Sunday week on the
   Paris calendar, counted in ONE row per reader and week (`campus_trend_weeks`, migration 163,
   plain): `told` the week's count, `"lastDay"` the day of the latest trend. The trend's statement
   upserts it under its row lock and takes the reader only while both bounds hold
   (`campusTrendWeekClaimSql`), so two posts crossing at once for one reader are ordered by the
   lock - exact, with no clock heuristic and no reset (a new week is a new row). The row names no
   post, so deleting a post frees nothing (the ledger's rows cascade with their post; the first
   draft counted those and would have freed a slot). Kept 14 days after its week ENDS (`week` is
   the Monday, so the row goes on day `week + 7 + 14`, `CAMPUS_TREND_WEEKS_KEPT`) by the daily GC,
   erased with the account. A post that crossed for a reader already at two is stamped all the same, so it
   is never announced later.
3. **ONE global daily push cap of THREE per person** for the non-essential pushes: the cap of
   migration 157 (`ENGAGEMENT_DAILY_PUSH_CAP`, 5 for trends alone) becomes 3 and widens.
   - **Counted** - the lead's list, shown to the owner on 2026-11-10: campus trends, reactions and
     comments on your posts, member reposts, followed accounts' posts (`followed_post`), booking and
     event openings - and friends' activity, which is no longer written.
   - **Not counted** (the owner's list): messages and calls (chat-delivery's, never through here),
     bookings (reminders and changes), follow requests and acceptances, direct mentions and replies,
     moderation and the organiser workflow, BIRTHDAYS, ASSOCIATION POSTS.
   - **The lead's placements** (reversible): a live STARTING is not counted (worth only in its moment,
     and an account's bell already reduces it); a FORM opening is not counted (the reader asked for it
     by pressing "Me rappeler"); an association's repost is an association post; a repost or
     co-organisation PROPOSED, a personal-repost request, the event workflow and the payment notices
     are organiser workflow.
   - ONE exported table, `PUSH_BUDGET` in `posts/engagement-push-cap.ts`, a `Record` over every
     notification type (a new type does not compile until it is placed) and a test asserting the same
     against the bell's and the push-only lists; `CAPPED_PUSH_TYPES` is derived from it, with each
     type's FLOOR (`PUSH_KEY_MIN_CLIENT`, shared by all its keys - asserted).
   - **The floor is asked before a unit is spent**: chat-delivery drops a device known to run an
     older build AFTER the claim, so the claim asks the same tables first (`push_token`,
     `key_package."deviceAppVersion"`, a device of unknown build kept as chat-delivery keeps it) - a
     reader with no device able to show the push spends nothing.
   - Above the cap the bell row is still written; ONE line per call says how many were withheld
     ("type=X withheld k of n").
   - Every send of a counted type asks `PostNotificationsService.withinPushBudget`: the batch fan-out,
     the singular `createNotification` (the openings), and the reaction and comment pushes
     `PostInteractionsService` composes itself.
4. **Proof**: `campus-trend.integration.spec.ts` on PostgreSQL - the database's `now()` pinned
   through a schema of its own: Monday and Tuesday told, Wednesday and Sunday evening not, the next
   Monday (half past midnight Paris, still Sunday in UTC) told again, the cap per reader, and two
   deleted posts freeing no slot; the named account (the smallest id of two followed likers; one
   that does not share; one that only laughed; one behind a block; a pending follow; an anonymous
   author the reader follows; the review cohort), "autres" leaving out the reader, the row's
   `meta.likedBy` id and the push's name, count and legacy body; the bell's resolution through a
   block, the switch, an unfollow and the erasure statement; every row written when every push
   fails. `engagement-push-cap.integration.spec.ts` - the 4th counted push refused across a trend, a
   reaction, a comment, two openings, a followed post and a member repost; two birthdays, two
   association posts and every other uncounted kind beyond the cap still pushing with no counter
   row; the floor (a 1.6.9-only reader spends nothing, a mixed one and an unknown build do).
5. **Owed**: a dev pass and a phone reading on both bench phones - a trend liked by an account the
   bench reader follows reads "Aimée par ..." on the lock screen and in the bell, and a fourth counted
   push in a day reaches the bell only.

## The decisions, verbatim

### First batch (owner, 2026-11-07)

1. **Who is notified when a live starts**: an ASSOCIATION's live notifies everyone who can SEE it,
   like its posts already do (`announceRecipientsSql`). A MEMBER's live keeps notifying only their
   accepted followers. Today both reach followers only (`liveAudienceSql`, `lives/live-announcer.ts`,
   docs/wiki/services/lives.md "The push to the followers").
   *(Kept verbatim; "Today" is the state before WP-1. Since WP-1 an association's live reaches its
   whole audience and only a member's live reaches followers only.)*
2. **Sources for follow suggestions, all four**:
   - friends of friends: accounts followed by the accounts you follow, ranked by the number of shared links;
   - members of your associations and lists;
   - your promo, then your formation, then your campus;
   - the most-followed associations of your campus that you do not follow.

   Always excluded: accounts you already follow, pending requests, blocks in either direction,
   yourself, and accounts you dismissed.
3. **Where suggestions appear, all four**:
   - a carousel of cards in the feed (photo, name, "N en commun", Suivre, and an X to dismiss);
   - "Suivez aussi..." right after a follow;
   - an empty Suivis feed shows suggestions;
   - a bell per account on a profile to choose what you receive from it: posts, lives, or nothing (Instagram's bell).
4. **Mutual links on a card**: a count plus the faces of accounts the VIEWER already follows, which
   is Instagram's "followed by". Only accepted follows count, and a block in either direction removes a face.

### Second batch (owner, 2026-11-07)

5. **Which posts also notify** (all chosen):
   - (a) any post or live of an account whose bell you turned on;
   - (b) friends' activity: "X a aimé / commenté un post" from an account you follow;
   - (c) campus trends: a post from your space that takes off (many reactions in a short time), even from an account you do not follow;
   - (d) the opening of a form, booking or event of an association you follow.

   For (d), a per-form opt-in reminder ("Me prévenir" / `form_view_remind_me`) already exists. Make
   (d) the automatic version for followers, and make sure nobody gets it twice (the opt-in and the
   follower notice dedupe to one). **Confirmed by the owner the same day:** followers of an
   association are notified AUTOMATICALLY when one of its forms, bookings or events opens (a
   shotgun). The existing per-form "Me prévenir" opt-in stays for people who do not follow the
   association. Each person gets ONE notification, never two.
6. **A daily cap**: beyond N engagement notifications per person per day (start at 5, explain the
   choice), the rest go to the in-app bell with no push. Messages, mentions, replies and calls are
   never capped. The cap must come from durable state (a counter row), not a timer.
7. **Onboarding**: no dedicated screen. A simple banner or carousel at the top of the feed for an
   account that follows almost nobody.
8. **Suggested posts in the feed**: popular posts already visible in the viewer's space, marked
   "Suggestion", with Suivre in the header. Nothing the viewer could not already see.

### Third batch (owner, 2026-11-07)

9. **Friends' activity (5b).** It has a setting to hide your own activity. The setting is ON by
   default (activity visible), and each person can turn it off in Settings.
10. **The bell's default.** Following an account sets it to "posts and lives". The bell is how you
    reduce what you get. A no-row state therefore means posts and lives, so check that L3 matches.
11. **The daily cap.** It applies ONLY to the new engagement notifications: friends' activity, campus
    trends, suggestions and suggested content. It never applies to shotgun openings or association
    posts, and nothing that exists today changes. Messages, mentions, replies, calls and comments or
    reactions on your own content are never capped either (L5 stands).
    **Amended by the owner on 2026-11-10:** *"On ne plafonne que les suggestions des gens que l'on ne
    suit pas."* Following an account is the reader's own choice and, by default (decision 10), means
    hearing from it - so the cap applies ONLY to notifications about accounts the reader does NOT
    follow: today `campus_trend` (5c). Friends' activity (5b) names an account the reader follows and
    is no longer capped: it pushes like that account's post, still reduced by its bell, the `posts`
    switch and the told-once ledger (L14).
12. **"X a rejoint" in a live's chat** is visible to every viewer, rate-limited. This is for the
    live-chat work, so just record it here as a decision.
13. **Shipping.** Each engagement WP ships to production on its own after an adversarial review, a
    pass on dev and a phone reading, without waiting for the owner.
14. **Production reads.** The owner explicitly authorized the lead to run read-only SELECT and
    EXPLAIN on production for the readings: the trend threshold and the cap check. The exact
    queries are [on this page](#the-production-readings---the-exact-queries).

Decision 12 belongs to the live chat ([lives](services/lives.md#live-chat-and-floating-reactions-wp-l6))
and is recorded here only; no package on this page builds it.

## Decisions the lead took (reversible, written here as the rule asks)

| # | Decision | Why, and how it is reversed |
| --- | --- | --- |
| L1 | An association live keeps excluding either side of a block with the broadcasting MEMBER and a viewer the broadcaster removed, though an entity post's announcement excludes neither. | The live audience is "exactly who `assertMayWatch` lets in", and the watch path refuses both; a push to a live that answers 404 is the defect L10 was built to avoid. |
| L2 | The `[LIVE_ANNOUNCE] ... followers=<n>` log field keeps its name although an association's count is now its whole audience. | `tools/cross-client-harness/srvlog.mjs` matches the line; renaming is a two-file change for no reader's gain. A comment at the log call says it. |
| L3 | The bell has THREE states, and only the two reductions are stored: no row = "posts and lives" (decision 10, today's behaviour), `lives`, `none`. A follow that COMES INTO BEING deletes the reader's row for that account, in the SAME statement, and only then: a data-modifying CTE on the write that creates it - the `association_follows` `INSERT ... ON CONFLICT DO NOTHING RETURNING`, or for a person the acceptance `UPDATE user_follows SET status = 'accepted' WHERE status = 'pending' RETURNING` - with the `DELETE FROM account_bells` reading that CTE's rows. A retried follow, a double tap or a re-sent acceptance returns no row and touches no bell. **Following a muted association again therefore UNMUTES it** (an unfollow then a follow is a new follow). Choosing "posts and lives" again deletes the row too. | The absent row is what every account has, so it needs no backfill; a stored `all` would be a second spelling of the default. Re-checked against decision 10 (2026-11-07): it matches. Tied to the creating write so that "a follow happened" is the row's own fact, never a guess from a request that may be a retry. |
| L4 | The bell and the daily cap never meet: the cap counts only notifications about an account the reader does NOT follow (decision 11 as amended 2026-11-10 - campus trends today), and a bell exists only on an account the reader follows. Friends' activity meets the bell only. | Rewritten after decision 11: the first version exempted a bell set to `all` from a cap that covered posts and lives; decision 11 takes those out of the cap altogether, so there is nothing left to exempt. |
| L5 | Comments on and reactions to the reader's OWN content are not capped, like replies and mentions. | They are about the reader's own words, not discovery; the cap targets what the reader did not write. |
| L6 | The cap's day is the Paris calendar date read from the DATABASE (`(now() AT TIME ZONE 'Europe/Paris')::date`), first come first served within it. | A date key is durable state, not a timer: no job resets anything, a new day is a new row. No priority between sources - priorities would be a ranking nobody can explain from the bell. |
| L7 | The bell is offered on a person the viewer follows (accepted) and on any entity the viewer can see; a person not followed shows Suivre instead. | Instagram's shape; a bell on a person whose posts the reader is not announced would be a second, silent follow. |
| L8 | `association_push_mutes` is folded into the bell table (a mute is level `none` on an entity). The copy is a HELD migration (a backfill). **The old mute endpoints stay and write `account_bells`** (mute = level `none`, unmute = delete the row), so a build older than the bell control loses no mute it sets after the copy; that shim is [listed with its removal condition](legacy-compatibility.md#no-date-yet---an-association-mute-set-by-a-build-older-than-the-bell-designed-2026-11-07). The old table is then read and written by nothing, and dropped later by a second HELD migration. | Two stores for one fact diverge; a mute written to the old table after the copy would be silently lost. |
| L15 | "Suivez aussi..." after a follow or a follow REQUEST is built from the VIEWER's own sources - their current suggestion ranking (friends of friends among accounts they already follow, co-members, cohort, entities), minus the account just followed - and NEVER from the target's follows. | Ranking by the target's follow list would reveal it, and to someone the target has not accepted when the follow is a pending request to a private account. Reversed by changing the one input of that call. |
| L16 | Lives of ONE association are announced at most once per 6 hours: a second live within 6 hours of the association's last ANNOUNCED live is claimed (`announcedAt` stamped, so never announced later) but not pushed. Built from durable state, `associations."lastLiveAnnouncedAt"`, not from `lives` (a live row is deleted at its end). WP-1b. | Since WP-1 an association's live reaches its whole campus, and `live_starts` allows 6 starts an hour per broadcaster; without a limit an association could ring the campus six times an hour. 6 hours is a constant. |
| L17 | A MEMBER REPOST (`member_repost`) is one of the reposter's "posts" to the bell: a bell on X at `lives` or `none` withholds the push of X's reposts as it does X's own posts. | The reader receives a repost BECAUSE they follow X (WP-F6), so it is something X puts in their feed; a bell that let X's reposts through would not be "what you receive from X". Reversed by moving the type out of the `post` kind in `BELL_PUSH_KINDS`. |
| L18 | `repost_personal_requested` (an association asking the reader to carry their post) is withheld by that association's bell at `lives` as well as at `none`. | The old mute silenced it; it is not a live, and `lives` means "only its lives". Reversed by one entry of `BELL_PUSH_KINDS`. |
| L19 | Migration 143 installs a TRIGGER on `association_push_mutes` mirroring every insert, upsert and delete into `account_bells`, in the copy's transaction, under `SHARE ROW EXCLUSIVE`. | During a rolling deploy an older social-service image may still write a mute to the old table AFTER the copy: without the mirror it would be read by nothing (a race that does not even heal). The lock orders a concurrent mute after the copy, so every row is copied or mirrored, never neither. The trigger goes with the table's held drop, and so does its function: that migration must `DROP FUNCTION canari_push_mute_to_bell()` as well as the table. Meanwhile the new code deletes the old table's row whenever it moves an association bell off `none`, so the old table stays a subset of the bells. |
| L20 | A bell row SURVIVES an unfollow (it is inert: an unfollowed person's posts are not announced to the reader) and is deleted by the next follow's own statement (L3). The settings list ("Notifications réduites") shows every reduced bell, people included, each with "Tout recevoir". | Deleting on unfollow would be a second write on a path L3 already covers; the list makes every reduction visible and reversible. Reversed by a `DELETE` in the unfollow statements. |
| L21 | `PUT` on an entity's bell needs only the entity to exist (the old mute's rule), not that the reader sees it; on a person it needs an accepted follow, checked IN the upsert statement. An id that is no uuid is `404 BELL_TARGET_NOT_FOUND`, never the database's type error. | An entity's posts reach readers whatever they follow, and a bell that reduces nothing is harmless; the person check is the one L7 owes, and a check apart from the write would let an unfollow slip between them. |
| L22 | A BIRTHDAY notice (`birthday`, push `social_birthday`, [birthdays](birthdays.md)) is one of the celebrant's "posts" to the bell: a bell on that person at `lives` or `none` withholds its push, and the bell row is still written. | The reader is told BECAUSE they follow the person, like L17; `none` means "nothing from them", and `lives` means "only their lives", which a birthday is not. The row stays so the bell reduces the push, never what the reader can find. Reversed by one entry of `BELL_PUSH_KINDS`. |
| L23 | A birthday date counts from the NEXT Paris day; a member is announced at most once per 300 days wherever the date moves, and a removal after an announcement keeps `noticeOpensOn = lastAnnouncedOn + 300` (nothing else) so a new date is neither announced nor ringed before it; the ring follows the notice's eligibility; a new date is accepted at most once per 30 days (a removal then a set included), a correction the same Paris day keeping the window - [birthdays](birthdays.md#a-date-cannot-be-moved-to-buy-a-ring-or-a-notice-lead-decision-2026-11-09). Amended 2026-11-09 after the re-review of #3180. | Without them, moving the date daily bought a daily school-wide ring and a daily push to every follower, and a removal then a set reopened the notice monthly. Reversed by `dateInEffectSql`, `noticeOpenSql`, `celebratedTodaySql`, `BIRTHDAY_NOTICE_EVERY_DAYS` or `BIRTHDAY_CHANGE_WINDOW_DAYS`. |
| L24 | "Ne plus me prévenir" (`DELETE /api/forms/:id/remind`) deletes the reader's opening row WHATEVER wrote it, a follower's included: the reader is then not told of that opening. A later MOVE of the opening writes the followers again, them included. `GET` answers `subscribed: true` for a follower's row as for an ask - it says "you will be told". | The button is about THIS target; a follower who presses it means "not this one". Reversed by adding `AND origin = 'asked'` to `cancelOpening`. |
| L25 | The follower rows ask the ASSOCIATION's visibility only (`associationVisibleToUserSql`, plain: a member, or a reader its rules reach; never a read grant; nothing for an archived association), NOT the target's own audience condition (a form's `submitCondition`, a booking space's `audience`). | Those are profile predicates evaluated in code against core-service facts, one call per person; at publication that is one call per follower. A follower the form does not admit opens it and reads why. Reversed by filtering the rows at the claim with `matchesCondition`. **Amended after the review of #3188 (lead, reversible): a booking space whose `audience` is SET gets NO follower row** (`announceSpaceOpening`), and a follower row of such a space written earlier is claimed and told nothing (`DUE_OPENINGS_SQL`, `stillOwed`): Reservations hides such a space from a reader it refuses and its page answers 403, so naming it on their lock screen would disclose it. An ask is unaffected (only a reader who sees it can ask). Forms keep L25: their title is fixed and readable by id. **And visibility is read AGAIN at the opening:** a follower row is told only while the reader still follows the association AND sees it (a member, or reached by its rules) - one who unfollowed, left the association or moved campus after the publication is claimed and told nothing. Decided at the claim rather than by deleting rows on unfollow: one statement reads the follow, the membership and the rules at the instant the push is decided, so no writer (unfollow, leave, a profile change from core-service) has to remember to delete anything, and no write can race it. |
| L26 | An opening is neither a post nor a live of the association, so on a FOLLOWER's row ANY stored bell level (`lives` or `none`) withholds its push; the in-app row is still written, as for a post. An ASKED row is never withheld: the reader asked for this target. Read in the claim's select (`DUE_OPENINGS_SQL`, `bellWithholds`), not through `BELL_PUSH_KINDS`, whose seam is `fanOutPush`. | "Lives seulement" means only its lives, and an opening is not one (the reasoning of L18). Reversed by testing `level = 'none'` only. **Amended after the review of #3188: an ARCHIVED association pushes nothing, a follower row or an ask** - its rows are claimed and told nothing, as Reservations and the forms hide it. A target merely not live YET (a form back in draft, an event sent back to validation between its validation and the tick) is NOT claimed: it is told the tick after it is live again, and the 30-day purge (every row whose opening is that old, told or not) bounds what waits. A gone target (deleted) is claimed and told nothing. |
| L27 | An agenda event "opens" when it is VALIDATED (`validateCalendarEvent`, in its lock's transaction), once. NOT announced: an event with a registration form (the form is the shotgun, and its publication tells the followers), a `break`, and a NEUTRAL event - not announced at all, rather than to its audience as "Nouvel événement sur le campus". The member who filed it is not told. | A neutral event must not be pushed under its BDE's name, and a campus-wide unnamed push to every reader is a new kind of notice nobody decided. Reversed in `announceEventOpening` (`associations.service.ts`). |
| L28 | An ask re-arms the heads-up while the opening is still to come (not only beyond five minutes): an ask on a follower's row inside the last five minutes is told at the next tick, as a fresh ask always was. A moved opening re-arms an ASKED row's heads-up the same way. | Found by the integration spec: re-arming only beyond five minutes gave the same ask a heads-up or none depending on whether the reader followed. Reversed in `ASK_OPENING_SQL`, `followOpeningMove` and 152's trigger together. **Amended after the review of #3188:** the ask re-arms the OPENING's stamp the same way (an opening still to come is owed even on a row told of an earlier one - the target moved ahead after it opened), as `form_reminders`' upsert did on main; in `ASK_OPENING_SQL` and 152's trigger. |
| L29 | A booking space is announced only when LISTED and an association's, at its creation and when its `opensAt` moves or it becomes listed; one with no `opensAt` (bookable at once) is announced at once, as a form published with no `opensAt`. A link-only space is never announced. **Amended after the second review of #3188: also when its `audience` is CLEARED** (a listed space that had one, L25 as amended, is announced once it has none; `ON CONFLICT DO NOTHING`, so saving it again tells nobody twice). | A link-only space is not meant to be found, and its name never reaches a lock screen (Q-R5). Reversed in `announceSpaceOpening` (`booking-spaces.service.ts`). |
| L9 | The opening reminders of forms, booking spaces and events share ONE table (`opening_reminders`, kind + target), replacing `form_reminders`. | One unique key `(kind, targetId, userId)` is what makes "one notification, never two" a constraint instead of a convention. |
| L10 | Suggestion score = `4 * min(mutual, 10) + 3 * min(sharedAssociations, 3) + tier` (tier 3 same promo and formation, 2 same formation, 1 same campus), ties broken by id. | Deterministic and explainable from the card ("N en commun" carries the dominant term). The weights are one constant each. |
| L11 | A suggestion card shows NO reason line besides "N en commun" and the faces. | A line "Promo 2027" or "Membre du BDE" would disclose a profile fact or a membership to someone who may not see it elsewhere; the count and the faces are what decision 4 chose to show. |
| L12 | "Almost nobody" (decision 7) is fewer than 5 follows in total (accepted person follows plus entity follows). | One constant, measured against the production distribution in WP-6's proof. |
| L13 | ~~A suggested post (decision 8) is at most one in every 8 feed items, never two in a row, and only in the space tab.~~ SUPERSEDED 2026-11-10 (owner): suggested posts are in Pour toi only, ranked by the same score as the followed posts, with no quota. | - |
| L14 | Friend activity (5b) and trends (5c) tell a reader about a given post AT MOST ONCE, whichever comes first, and never when the reader was already told about that post by its announcement. | One told-once ledger `(postId, recipientId)`; see [no double notification](#no-double-notification). |

## WP-1 - an association's live reaches everyone who can see it (BUILT)

`liveAudienceSql(asAssociation)` in `apps/social-service/src/lives/live-announcer.ts`. The decision
asked for the post path's predicate, not a copy of it, and that is what the shape gives:

- **ONE visibility predicate** for both kinds: `liveVisibleToUserSql` (`spaces/reader-spaces.ts`),
  whose association branch is `associationVisibleToUserSql` - the same fragment the post rule
  (`postVisibleToUserSql`) ANDs in for an association post. A live has no republication, which is the
  only term of the post rule it does not carry.
- **Only the CANDIDATES differ**: a member's live offers the accepted `user_follows` rows of the
  broadcaster; an association's live offers every `users` row, exactly as an entity post's
  announcement scans `users` (`announceRecipientsSql(false)`). The visibility term then keeps who
  sees it - a member of the association anywhere, or anyone its rules reach.
- Both then drop the broadcaster, either side of a block with the broadcaster (L1) and a viewer the
  broadcaster removed; read grants never notify (the PLAIN predicate, as for a post).
- The `$3` parameter is gone: the association is read from the live row by the predicate.
- Mutes and categories are untouched: `association_push_mutes` is applied by
  `PostNotificationsService` (`live_started` is in `MUTABLE_PUSH_TYPES`), the `posts` category by
  chat-delivery.

**Cost.** The association candidate set is the whole `users` table filtered by the same predicate an
entity post's announcement already runs on production for every association post: one statement per
live, at its first stored segment, never per segment.

**The JIT threshold, now switched off (2026-11-09).** Every social-service connection starts with
`jit=off` (`PG_SESSION_OPTIONS`), after the same cliff made the bell's read take 1-13 s
([posts](frontend/modules/posts.md#the-bell-re-checks-the-post-review-of-2965-2026-11-03)); the
bound below no longer exists, and is kept as the record of why. The review of #3119 read the association
audience plan at an estimated cost of about 83,000 on a 3,000-user fixture, against PostgreSQL's
default `jit_above_cost` of 100,000. Past it, PostgreSQL JIT-compiles the plan, which adds a fixed
compilation time (tens to a few hundred milliseconds) and changes no result. The statement runs once
per live, AFTER segment 0 has been answered (the announcement is not awaited by the ingest), so that
time lands on nobody's request; it is accepted, and NOT switched off with `SET LOCAL jit = off`,
which would need a transaction around a single read. The bound to watch: the plan cost grows with
`users`, so the cliff is crossed at roughly +20 % users; WP-5's EXPLAIN on dev re-reads it, and a
`[LIVE_ANNOUNCE]` line whose duration jumps is the symptom. The entity post announcement
(`announceRecipientsSql(false)`) runs the same shape and has the same bound.

**An archived association cannot go live** (review of #3119): `LivesService.start` refuses it with
`403 LIVE_ASSOCIATION_ARCHIVED`, since its live would ring a former audience; one archived between
the start and the first frame is not announced (WP-1b's slot requires `NOT archived`).

**Proof.** `lives.integration.spec.ts`, "an association's live goes to EVERYONE WHO SEES IT", on a real
PostgreSQL: a non-follower in the audience is told, a follower is told, a reader of another campus
holding a read grant is not, a reader who blocked the broadcaster is not, a removed viewer is not, and
a MEMBER outside the rules' spaces is (the membership door). Mechanism and table: [lives](services/lives.md#the-push-to-the-followers-wp-l7-server-half).

### WP-1b - one announced live per association per 6 hours (BUILT, in the same pull request)

L16. Since the audience is now the whole campus, an association that ends and restarts a live (six
starts an hour are allowed per broadcaster) must not ring it each time. It ships in WP-1's own pull
request, so no release - a hotfix included - can carry the wider audience without its bound.

- **Durable state, on the association**: migration 139, `ALTER TABLE associations ADD COLUMN IF NOT
  EXISTS "lastLiveAnnouncedAt" timestamptz` (plain, no backfill: NULL means never; declared on the
  entity with `select: false`, never served). Not read from `lives`, whose rows are deleted at the
  end of each live.
- **In the claim's transaction** (`LivesService.confirm`, where segment 0 stamps `announcedAt`,
  through `takeAssociationAnnounceSlot`): for an association live, `UPDATE associations SET
  "lastLiveAnnouncedAt" = now() WHERE id = $1 AND NOT archived AND ("lastLiveAnnouncedAt" IS NULL OR
  "lastLiveAnnouncedAt" <= now() - make_interval(hours => 6)) RETURNING id`
  (`LIVE_ASSOCIATION_ANNOUNCE_INTERVAL_HOURS`). The row lock orders two lives of the same
  association. A row returned: announced as before. No row: the live is still claimed (stamped, so
  never announced later) and one line says so, at log level - `[LIVE_ANNOUNCE] <liveId> not
  announced: association <id> announced a live at <time>, less than 6 h ago` - an expected outcome,
  counted, not a warning.
- **Proof**: `lives.integration.spec.ts`, "an association announces at most one live per 6 hours":
  a second live within 6 hours pushes nothing and stays stamped; one after the stamp is moved back
  past 6 hours by SQL (the database's clock, no wall clock asserted) pushes; a member's live right
  after the association's is pushed as ever; and "an ARCHIVED association cannot go live, and one
  archived after its start is not announced".

## WP-3 - the bell (BUILT)

Built 2026-11-08 to the design [below](#the-bell---data-model-and-how-it-combines-with-categories-and-mutes)
(L3, L7, L8) plus L17-L21 above. The decisions it applies are 3d, 5a and 10.

- **Migrations.** 142 (`account_bells` and its target index; plain, not held) and 143 (the mirror
  trigger, L19, then the copy of `association_push_mutes`; **HELD**, marked `-- canari:hold-for-owner`,
  its approval line written in `infrastructure/migration-approvals.txt` in the same pull request, so
  the pull request is never auto-armed and is merged by hand - step 2 of the order
  [below](#which-migrations-are-held) is that merge).
- **Server.** `follows/account-bells.service.ts` (the levels, `BELL_PUSH_KINDS`, `bellTargetOf`,
  `withheldAmong`, the legacy mute methods, `resetBellOnNewFollowSql`) and
  `follows/account-bells.controller.ts` (`GET /api/posts/me/bells`, `GET|PUT
  /api/posts/me/bells/:kind/:targetId`). The seam is `PostNotificationsService.fanOutPush`, where the
  mute was: `MUTABLE_PUSH_TYPES` and `AssociationPushMutesService` are gone. The reset rides on
  `FollowsService.followAssociation` (now ONE `INSERT ... ON CONFLICT DO NOTHING RETURNING` with the
  `DELETE` reading it) and on `FollowRequestsService.accept` (the acceptance `UPDATE ... RETURNING`
  with the same `DELETE`). An association's deletion deletes the bells on it; the account erasure
  deletes the reader's bells and every bell on the erased person, and its association lock set reads
  `account_bells` (the association delete now writes it).
- **Client.** `AccountBell.svelte` (the app's `Picker`: "Publications et lives", "Lives seulement",
  "Rien", each with a one-line hint; optimistic, back with a toast on a refusal; disabled while its
  level is unread) beside "Suivre" on an association's page (followed or not) and on a person's
  profile once followed (accepted); "Notifications réduites" in the notification settings
  (`SettingsAccountBells.svelte`) replaced the muted-associations list. The old mute button, its
  strings and its client calls are gone.
- **Proof.** `follows/account-bells.integration.spec.ts` on PostgreSQL: 143 copies every mute and
  keeps a newer bell, and re-runs clean; the mirror turns an old image's insert, upsert and delete into
  the bell write; a level is idempotent and `all` is no row; a person's bell is refused unfollowed,
  pending and across a block (severed follow); a NEW association follow resets the bell, a retried one
  or five concurrent ones do not; a person's acceptance resets the new follower's bell, a re-sent one
  or one refused across a block does not; the level table through the REAL notification service
  (association post and live, a person's post and live, a mention never withheld); the legacy routes
  read and write the bell; the settings list; the erasure. Unit: `account-bells.service.spec.ts`,
  `post-notifications.batch.spec.ts`. Client: `AccountBell.svelte.test.ts`,
  `SettingsAccountBells.svelte.test.ts`.
- **Owed on the phones** (after the approval line is merged and a NEW pre-release serves dev): on the
  Mi 9T and the iPhone 12, set an association's bell to "Rien" and publish as that association from
  the other phone - the post is in the feed and the notifications list, with no push; "Lives
  seulement" then a live of it - pushed; a followed person at "Lives seulement" - their post silent,
  their live pushed; unfollow then re-follow (accepted) - "Publications et lives" again; a mute set
  before the pre-release reads "Rien" on the association page and in "Notifications réduites".

**The daily cap (WP-8) is NOT built with it**, by the design's own order: WP-3 and WP-8 never meet
(L4), and WP-8 ships immediately before WP-9, the first package that sends a capped kind - built
earlier it would guard nothing - and only once [R2](#r2---the-cap-check) has been read on production
and written back here.

## WP-4 - openings for followers (BUILT)

Built 2026-11-09 to [(d)](#d-openings-for-followers---one-notice-never-two) (decision 5d, L9) plus
L24-L29 above. Never capped (decision 11).

- **Migrations.** 151 (`opening_reminders`, its due and user indexes; plain) and 152 (**HELD**,
  marked `-- canari:hold-for-owner`; its approval line is NOT in this pull request - the lead adds it
  after the review, step 3 of the order [below](#which-migrations-are-held)). 152 takes `SHARE ROW
  EXCLUSIVE` on `form_reminders`, installs `canari_form_reminder_to_opening()` - AFTER INSERT/DELETE
  and BEFORE UPDATE - then copies every reminder as `asked`, keeping its id and stamps. The trigger
  covers an image older than WP-4 during the rolling deploy: its ask and unsubscribe become the same
  writes on the new table, and its scheduler's CLAIM is made on `opening_reminders` first - a claim
  the new image already made cancels the old row's update (`RETURN NULL`, the old image reads
  `affected = 0` and pushes nothing), so an opening due while both images run is pushed once.
  Verdicts (`migration_gate_verdict`): 151 `plain`, 152 `held`.
- **Server.** `openings/opening-reminders.ts` - plain statements over a manager, called inside the
  writers' own transactions: `askOpening` (the ask, `ASK_OPENING_SQL`, spelt the same way by 152's
  trigger), `cancelOpening`, `isTold`, `announceOpeningToFollowers`
  (`ANNOUNCE_OPENING_TO_FOLLOWERS_SQL`, `ON CONFLICT DO NOTHING`: never overwrites an ask),
  `followOpeningMove`, and the scheduler's reads `DUE_HEADS_UP_SQL` / `DUE_OPENINGS_SQL` (the target
  read in the same statement with the follow and the visibility: a gone target or an archived
  association is claimed and told nothing, a target not live yet is left for a later tick, a
  follower who no longer follows or sees is told nothing, the bell, L25-L26) and its 30-day purge
  of every row whose opening is that old. Entity `openings/entities/opening-reminder.entity.ts`.
  `FormReminderScheduler` claims and sends every kind: a form keeps `form_opening_soon` /
  `form_open` (type `form_reminder`); a booking space is `booking_open` (push
  `social_booking_open`, category `bookings`, tap: Reservations), an event `event_open` (push
  `social_event_open`, category `events`, tap: the agenda), both named by the association, its
  logo on the row. Writers: `FormsService.createNew` (published at once), `publishChanges` (a draft
  published), `update` (a published form's `opensAt` moved - rows follow, followers written again,
  in the save's transaction); `BookingSpacesService.create` / `update` (L29);
  `AssociationsService.validateCalendarEvent` (L27). The three `/api/forms/:id/remind` routes keep
  their shape and write the new table (L24). `form_reminders` stays mapped (`FormReminder`, read by
  no code) until its held drop, so a `synchronize`d local database still has it; the erasure
  deletes from both tables.
- **Native and client.** The two keys in `strings.xml` (fr, en), `CanariFirebaseMessagingService`,
  `canari_push.mm`, the NSE (`NotificationService.swift`) and the four `Localizable.strings`;
  chat-delivery's `push-category.ts` files them under the EXISTING `bookings` and `events`. The bell
  row: `notificationTarget.ts` (Reservations, `/calendar`) and `NotificationRow.svelte` (the
  association's logo, "a ouvert les réservations :" / "a publié un événement :", Paraglide
  `notif_booking_open_text`, `notif_event_open_text`). A build older than this shows the two new
  types as an unknown row and the push in the server's French wording (`legacyTitle/Body`).
- **Proof.** `openings/opening-reminders.integration.spec.ts` on PostgreSQL 18: 152 copies two
  reminders against real rows (ids, stamps, instants kept) and re-runs clean (151 and 152 applied
  twice); the followers who see the association are written, never the publisher, a follower its
  rules do not reach, or anyone of an archived association, and a MEMBER anywhere is; **a follower
  who also asked gets ONE opening push, a follower gets the opening and no heads-up, a non-follower
  who asked gets both**; a reduced bell withholds a follower's push but not an ask's, the bell row
  written; two scheduler replicas in the same tick push each row once; a move re-arms an ask and
  carries the untold rows; "Ne plus me prévenir" removes a follower's row; a booking space and an
  event open to their followers with their own keys, rows and names, and an archived form is told
  nothing; an OLD image's insert, upsert and delete on `form_reminders` are the same writes on the
  new table, and its claim and the new claim exclude each other in both orders; the erasure deletes
  both tables' rows. **After the review of #3188** (five tests, each failing before its fix): a
  booking space with an audience writes no follower row and an earlier one is told nothing; a
  follower who unfollowed, left the association or moved campus is not told; a re-ask after a told
  opening moved ahead is told again (and the old image's re-ask re-arms the same way); an event
  sent back to pending is left and told once validated again; an archived association pushes
  nothing, follower or ask. **After the second review** (each failing before its fix): an archived
  association sends no heads-up either (`DUE_HEADS_UP_SQL` reads the form and the association
  under the opening's rule: claimed, told nothing); an old image never claims a new row whose
  opening the new code moved ahead (152's claim mirror also requires the NEW row to be due -
  `"opensAt" <= now()` for the opening, within five minutes for the heads-up); the 30-day purge
  logs its told and never-told counts apart; the audience-test now moves its rows to the past by
  the database's clock (it was flaky, about 5 runs in 27: the rows open at the database's `now()`
  in microseconds, the tick compares a JS `Date` in milliseconds) - the spec then ran 30 times in a
  row with no failure; and in `bookings.service.integration.spec.ts`, a listed space whose audience
  is cleared tells its followers, once. **After the third review:** 152's heads-up mirror also
  requires the new row's opening to be still to come and not yet told (`NOT "notifiedOnOpen" AND
  "opensAt" >= now()`): test (9) - the organiser moved the opening to now, the new image told "it's
  open", and the old image's heads-up claim on its row still at T+3 then affects 0 rows (it
  matched before, so "opens in 5 minutes" would have followed "it's open"); and test (10) - a form
  back in DRAFT with a due heads-up is neither claimed nor told, then told once when published
  within the window (it fails with the draft clause of `DUE_HEADS_UP_SQL` removed). The existing form specs run against the new store (`forms.service.*.spec.ts`,
  the five forms integration specs, which now build `opening_reminders`). Unit:
  `push-content.spec.ts` (the two keys against `strings.xml`), `push-category.spec.ts`. Client:
  `NotificationRow.svelte.test.ts`, `notificationTarget.test.ts`, `nativeStrings.test.ts`.
- **Owed.** The approval merge of 152, then a NEW pre-release on dev, then on the Mi 9T and the
  iPhone 12: follow an association from one phone; from the other publish a form of it opening in
  ten minutes - the follower gets "Formulaire ouvert !" at the opening and no heads-up; press "Me
  prévenir" on it as well before the opening - the heads-up, and still ONE opening push; a listed
  booking space created by the association - "<asso> ouvre les réservations" opening Reservations;
  an event validated - "<asso> publie un événement" opening the agenda; the association's bell at
  "Rien" - the bell row, no push. **And the drop** of `form_reminders` (held) after WP-4 has served
  one stable.

## Follow suggestions - the query

### Shape

Two statements per request: the person suggestions, then the faces of the page it returns. A third,
independent one, for entities. All three live in social-service (the `users`, `user_follows`,
`association_members`, `association_follows` and `user_blocks` tables are read there already).

```sql
-- $1 the viewer. Bounded: LIMIT 20.
WITH me AS (SELECT id, campus, promo, cursus FROM users WHERE id = $1),
followed AS (SELECT f."followedUserId" AS id FROM user_follows f
             WHERE f."followerUserId" = $1 AND f.status = 'accepted'),
fof AS (SELECT f2."followedUserId" AS id, count(*) AS mutual        -- friends of friends
        FROM followed f1 JOIN user_follows f2
          ON f2."followerUserId" = f1.id AND f2.status = 'accepted'
        GROUP BY 1),
comembers AS (SELECT m2."userId" AS id, count(DISTINCT m2."associationId") AS shared
              FROM association_members m1 JOIN association_members m2
                ON m2."associationId" = m1."associationId"
              WHERE m1."userId" = $1 GROUP BY 1),
cohort AS (SELECT u.id, CASE WHEN f.shared AND u.promo = me.promo THEN 3
                             WHEN f.shared THEN 2 ELSE 1 END AS tier
           FROM users u JOIN me ON u.campus = me.campus
           -- a formation of the viewer's cursus is in the candidate's: the containment
           -- isReaderSpaceSql uses (users.cursus @> [{"formation": ...}])
           CROSS JOIN LATERAL (SELECT EXISTS (
             SELECT 1 FROM jsonb_array_elements(me.cursus) mine
              WHERE u.cursus @> jsonb_build_array(jsonb_build_object('formation', mine->>'formation'))
           ) AS shared) f),
candidates AS (SELECT id FROM fof UNION SELECT id FROM comembers UNION SELECT id FROM cohort)
SELECT c.id, COALESCE(fof.mutual, 0) AS mutual,
       4 * LEAST(COALESCE(fof.mutual, 0), 10) + 3 * LEAST(COALESCE(cm.shared, 0), 3)
         + COALESCE(co.tier, 0) AS score
FROM candidates c LEFT JOIN fof ... LEFT JOIN comembers cm ... LEFT JOIN cohort co ...
WHERE c.id <> $1
  AND NOT EXISTS (any user_follows row $1 -> c, accepted OR pending)
  AND NOT EXISTS (a user_blocks row between $1 and c, either direction)
  AND NOT EXISTS (a dismissal of c by $1)
  AND NOT <c in the review cohort>             -- inReviewCohortSql, as every reader path
  AND <c is a live account>                    -- not an erased one (DELETED_ACCOUNT)
ORDER BY score DESC, c.id LIMIT 20;
```

- **The promo is `users.promo`** (derived from the first `cursus` entry at sign-in), never
  `cursus->0->>'promo'`, which the review of #3119 found NULL (the first draft read it, and so
  would have ranked nobody in the viewer's promo); the formation is the `cursus` containment
  `isReaderSpaceSql` already uses, so a student with two cursus entries shares either formation.
- **"Shared links" (decision 2) is `mutual`**: the number of accounts the viewer follows (accepted)
  that follow the candidate (accepted) - the same number the card shows as "N en commun", so the
  ranking and the card cannot disagree.
- **Faces** (decision 4): for the 20 returned ids, a `LATERAL` of up to 3 accounts from `followed`
  that follow the candidate (accepted), minus either side of a block with the VIEWER, ordered by id.
  A face is therefore an account the viewer follows AND who accepted the viewer.
- **Entities** (the fourth source): entities not archived whose audience rules reach the viewer
  (`associationVisibleToUserSql`, the agenda's predicate), not followed, not dismissed, ordered by
  their `association_follows` count, LIMIT 10. Lists and institutions included; they are free to
  follow, so the card's button follows at once.
- **The review cohort** is excluded both ways, as on every reader path (`review-cohort.ts`).

### Bounds and cost, measured

Measured 2026-11-07 on PostgreSQL 18 (`postgres:18-alpine`, local container, stopped after) with a
production-SHAPED fixture: 3,000 users on two campuses (80/20), six formations, eight promos; 115,500
`user_follows` rows (109,746 accepted, median 29 accepted follows per user, a 5 % tail at ~200);
150 entities; 24,000 entity follows; 6,000 memberships; 100 blocks; 3,000 dismissals; the indexes
production carries (`followerUserId`, `followedUserId`, the unique pair). The fixture is a SHAPE, not
production ([durable-rules](durable-rules.md#a-proportion-measured-in-another-browser-on-another-route-without-the-session-is-a-shape---and-a-shape-can-invert)):

| Statement | Viewer | Execution | Buffers |
| --- | --- | --- | --- |
| person suggestions | heaviest follower (196 accepted follows) | 90.4 ms | - |
| person suggestions | median follower | 78.8 ms | - |
| faces of 20 suggestions | heaviest follower | 3.4 ms | - |
| entity suggestions | median follower | 6.6 ms | - |

Re-measured after the review's promo fix (`users.promo` and the cursus containment): the first
draft read 26.7 / 15.6 ms with the NULL-promo expression. The containment test per same-campus user
(about 2,400 here) now dominates the median viewer; it is linear in the campus, so it stays well
under a feed page's own cost, and WP-5 may precompute the viewer's formations once if dev reads it
higher. The friends-of-friends aggregate (2,688 groups for the heaviest viewer, a hash aggregate in
600 kB) is the other term. It grows with (follows of the viewer) x (follows of each followed account), so
the bound that matters is the follow count, which the follow limits already cap
(`FOLLOW_PENDING_LIMIT`, `FOLLOW_DAILY_LIMIT`). **The query is computed on request, not stored**: at
these costs a cache would be a second truth to invalidate on every follow, block and dismissal.
WP-5's proof re-reads the plan on dev with the real tables.

### The dismissal store - a new table, NOT held

```sql
CREATE TABLE IF NOT EXISTS follow_suggestion_dismissals (
  "userId"     varchar(255) NOT NULL,          -- who dismissed
  "targetKind" varchar(16)  NOT NULL CHECK ("targetKind" IN ('user', 'association')),
  "targetId"   varchar(255) NOT NULL,          -- a user id, or an association uuid as text
  "createdAt"  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "targetKind", "targetId")
);
CREATE INDEX IF NOT EXISTS "IDX_follow_suggestion_dismissals_target"
  ON follow_suggestion_dismissals ("targetKind", "targetId");
```

- **Not held**: `CREATE TABLE` and `CREATE INDEX` are plainly additive, so the one judge
  (`infrastructure/lib/migration-hold.sh`, [cicd](cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01))
  passes it; it carries no `-- canari:hold-for-owner` marker because it backfills nothing and locks no
  hot table. **Which migrations of this page are held** is one list,
  [below](#which-migrations-are-held).
- **A dismissal is permanent** (Instagram's): the X is the reader's answer, and no clock brings the
  account back. Following then unfollowing does not clear it either; a dismissed account is still
  findable by search (Q4).
- **The account erasure** deletes the rows where the erased account is `userId` OR `targetId`
  (`internal/account-erasure.ts`, a statement in code, not in the migration), with its spec.
- The index on the target serves that erasure; the viewer's own lookups use the primary key.

### WP-5 - the suggestion query (BUILT)

Built 2026-11-09 to the shape above, in `follows/suggestions.service.ts` and
`follows/suggestions.controller.ts`, migration 155 (`follow_suggestion_dismissals`, plain).

- **Routes**: `GET /api/posts/me/suggestions[?limit=&exclude=]` answers `{ people: [{ userId, mutual,
  faces }], entities: [{ id, name, slug, logoUrl, type }] }`; `POST /api/posts/me/suggestions/dismiss`
  takes `{ kind: 'user' | 'association', targetId }` (400 `SUGGESTION_DISMISS_INVALID` for an unknown
  kind, an empty or over-long id, the caller themself, or an entity id that is no uuid; 60 a minute per
  caller). **Under `/api/posts/me/...`, not `/api/suggestions`** as the first draft said: the follow
  routes' prefix, so nginx needs no new location. `exclude` is the account just followed - "Suivez
  aussi..." (L15) - and the page is read one longer so dropping it never shortens it.
- **ONE statement for the people and their faces**, not two: the faces are an `ARRAY(... LIMIT 3)` over
  the same `followed` pool the count is drawn from, so "N en commun" and the faces cannot disagree.
  That pool is the viewer's ACCEPTED follows with no block either way and on the same side of the
  review cohort: a block with a face removes it from the faces AND the count (decision 4).
- **The review cohort is excluded both ways** with `sameSideOfReviewCohortSql`: a review account is
  suggested to nobody outside the cohort and is suggested nobody outside it.
- **The viewer's formations are read once** (`my_formations`), and a `cursus` that is not an array
  contributes none rather than failing the statement.
- **Entities exclude those the viewer is a MEMBER of** (lead, reversible): the Suivre chip is never
  offered on one (WP-2), so a card for it would be a button that does nothing new.
- **A row naming a deleted association is not deleted with it**: it is inert (a deleted association
  is never suggested) and goes with its dismisser's erasure. Deleting it with the association would
  put `follow_suggestion_dismissals` in the erasure's association lock set for nothing.
- **Proof**: `follows/suggestions.integration.spec.ts` on PostgreSQL - L10's order (friends of
  friends, a co-member, the three cohort tiers, ties by id); every exclusion of decision 2 (self, an
  accepted follow, a pending request, a block either way, a dismissal, a review account, an account
  that no longer exists); the faces (at most three, by id; a pending ask and a blocked follow neither
  counted nor shown; a block with a face removes it); the entities (follower order, none followed,
  archived, joined, dismissed or outside the reader's audience); `exclude`; a permanent, idempotent
  dismissal that a follow then an unfollow does not clear, and its typed 400s; the erasure both ways;
  155 re-run.
- **Owed**: the EXPLAIN on dev with the real tables (the cost table above is a fixture's); the phone
  readings come with WP-6, which draws it.

## Where suggestions appear (decision 3)

| Surface | Reads | Shown when |
| --- | --- | --- |
| Feed carousel | the PERSON suggestions, 10 cards (entities left out since 2026-11-10: Pour toi is people only - lead's decision, reversible) | Pour toi only (owner, 2026-11-10: Campus and Associations are pure lists), once, after the 3rd post; hidden once every card is followed or dismissed |
| "Suivez aussi..." | the VIEWER's own person suggestions, minus the account just followed, limit 5 - never the target's follows (L15) | right after a follow or a follow request, under the profile header; nothing when empty |
| Empty Pour toi | the same carousel, as the page body | Pour toi has no post ("Suivis" until 1.6.9) |
| Onboarding (decision 7) | the same carousel, as a banner at the top of the feed | the viewer follows fewer than 5 accounts (L12) |
| Bell on a profile | the bell row for (viewer, account) | a person the viewer follows (accepted), or any entity they can see (L7) |

One component (a suggestion carousel) serves the first, third and fourth rows; every string is
Paraglide from the first draft (`suggestions_common_count` "{count} en commun", `suggestions_follow`,
`suggestions_dismiss`, `suggestions_title`, `suggestion_post_badge` "Suggestion", ...). A card's Suivre
uses the existing calls (`askToFollow`, the association follow) and therefore the existing limits; on
a person it becomes "Demandé", as on the profile.

### WP-6 - the surfaces (BUILT)

Built 2026-11-09 to the table above. The client is `follows/suggestions.svelte.ts` (the shared,
per-reader state), `components/suggestions/` (`SuggestionCard`, `SuggestionCarousel`,
`FeedSuggestions`, `FollowAlsoSuggestions`) and the two calls in `follows/api.ts`.

- **ONE read per reader** of `me/suggestions` for the carousel, the empty Pour toi and the banner,
  asked when Pour toi opens (Mon espace and Suivis until 1.6.9); a failed read is a `console.warn` and is not asked again in
  the session (the carousel is a bonus: a retry on every mount would be traffic with no event behind
  it). A per-reader cache, forgotten on sign-out and account switch; an answer for the previous
  reader is dropped.
- **ONE placement rule** (`feedSuggestionPlacement`), one place at a time, so the same cards are never
  twice on one screen: only Mon espace and Suivis, only while a card is open; an EMPTY Suivis feed -
  the carousel is the page body, under the existing empty message; fewer than 5 follows (L12, read
  from the answer's `followingCount`: accepted person follows plus entity follows, one server count) -
  the banner at the top; otherwise once, after the third post.
- **The cards.** A person: photo, name, "N en commun" with up to three faces (only when N > 0 - never
  "0 en commun"), the WP-2 `FollowChip` in its `soft` variant; a follow OR a request removes the card
  (owner, 2026-11-10): it shrinks away, the next cards slide into its place (`animate:flip`, none under
  reduced motion) and the next person the read carried (up to 20, ten drawn) joins the end of the row,
  a toast confirming; an
  entity: logo, name, the chip (it follows at once and the card leaves). An X on each, dismissing for
  good (`POST me/suggestions/dismiss`) - optimistic, back with a toast on a refusal - and the row
  disappears once no card is left OPEN (every one followed, requested or dismissed). No reason line
  (L11).
- **The row slides first and changes after** (owner, iPhone, 2026-11-11: horizontal swiping "very weird
  and not smooth"). The row is FROZEN from the first `touchstart` (or `scroll`) until the touch has ended
  AND, where the engine fires it, `scrollend` has - a card that leaves (the server said yes to a follow)
  or the next person who slides in lands at that idle moment, with the usual flip. The proof is an event,
  never a clock; `touchend`/`touchcancel` carry it because a pointer event is cancelled when a scroll
  takes the touch. A tap on the X or on Suivre has ended before its click, so it still acts at once.
  Also: the row is free scroll and one axis (no scroll-snap, which re-settled a 160px card grid after
  every momentum and re-snapped when a card left; `overflow-y-hidden`; `overscroll-x-contain`), and the
  card objects are built once per read so a recompute of the list no longer hands every card a new prop.
  The tab swipe was ruled out: it ignores a touch that starts in a horizontally scrollable region
  (`shouldIgnoreSwipeTarget`). Owed: one reading on the iPhone 12 and the Mi 9T.
- **"Suivez aussi..."** after a follow or a request made on a person's profile, and after a follow on
  an association's page: its own read, `limit=5&exclude=<that account>`, people only (L15), nothing
  when empty or failed.
- **Server**: `me/suggestions` also answers `followingCount` (`FOLLOWING_COUNT_SQL`), proven in
  `follows/suggestions.integration.spec.ts`.
- **Proof**: `follows/suggestions.svelte.test.ts` (the placement rule, each branch, and the
  interleaving), `components/suggestions/SuggestionCarousel.svelte.test.ts` (cards, count and faces,
  no "0 en commun", the X and its refused rollback, a request keeping its card, a followed entity
  leaving, the row hiding when nothing is open; "Suivez aussi..." asking `limit 5` minus the followed
  account, people only, nothing on a failed read).
- **Owed on the phones** (Mi 9T and iPhone 12, after a pre-release on dev): a fresh account sees the
  banner; Mon espace shows the row after the third post; an empty Suivis shows it as the body; a
  follow request from a card reads "Demande envoyée"; an X removes the card and it does not come
  back after a reload; "Suivez aussi..." after a follow on a profile.

### WP-7 - suggested posts (BUILT)

Built 2026-11-09 to decision 8 and L13. The server is `GET /api/posts/me/suggested-posts`
(`posts/suggested-posts.ts`, `PostsService.listSuggestedPosts`), the client
`lib/posts/suggestedPosts.svelte.ts`, drawn by the feed route.

- **What is suggested.** A post (`kind = 'post'`, scheduled, not hidden, not anonymous, not the
  viewer's own) published in the last 7 days, that reaches one of the viewer's spaces
  (`postReachesSpaceSql`) and is visible to them by `postVisibleToUserSql` with the follower door
  CLOSED and no read grant - so nothing a grant or a follow is the only reason they could see. The
  feed's own filters apply as on every feed row: the review cohort, the promotion cutoff, and the
  block filter both ways (`blockedAuthorSql`, now ONE function in `common/blocked-user-ids.ts` that
  the feed and the suggestions both call). Its author is an account the viewer does not follow
  (accepted or requested) and, for an association post, an entity they neither follow nor belong to -
  the header then carries Suivre (WP-2).
- **Popular** is the number of distinct accounts that reacted or commented, the author excluded:
  `posts/engagement-sql.ts` `engagedAccountsSql`, the ONE definition WP-10 and R1 also use. At least
  3; best first (then newest), at most 10 per read.
- **Placed by the SERVER since 1.6.9** (owner, 2026-11-10): the suggestions of PEOPLE
  (`suggestedPostIds(..., { peopleOnly: true })`) are merged into Pour toi's ranked window by the same
  score as the followed posts, in their own band after the followed posts under 48 h, with no quota,
  served with `feedSuggested` ([posts](frontend/modules/posts.md#pour-toi---the-ranked-tab-owner-2026-11-10)).
  The client's `placeSuggestedPosts` and its per-reader read are DELETED, and so is Campus's slot.
  Marked "Suggestion" as plain small muted text on the post header's meta line
  (`suggestion_post_badge`, `PostHeader`), no longer a yellow corner badge (owner, 2026-11-10).
- **`GET /posts/me/suggested-posts` stays** for the installed clients (1.6.8 and older), which still
  interleave it in their Mon espace ([legacy-compatibility](legacy-compatibility.md#no-date-yet---a-feed-client-newer-than-its-server---rankedfeeds-2026-11-10)).
- **Proof**: `posts/suggested-posts.integration.spec.ts` on PostgreSQL (visible by the space rule;
  never through a read grant nor through the follower door; never an author blocked either way;
  not the viewer's own, not followed or requested, not an entity they follow or belong to; the
  engagement floor and the 7-day window; the order; a reader of another space gets that space's
  posts); since 1.6.9 `posts/for-you-feed.integration.spec.ts` (merged into Pour toi by the score, in
  its band, people only) and `routes/posts/page.forYou.svelte.test.ts` (drawn in its own place with
  its badge in Pour toi, never in Campus).
- **Owed**: a phone reading on dev (Pour toi shows a "Suggestion" card where its score puts it, its
  header carrying Suivre; Campus shows none).

## The bell - data model, and how it combines with categories and mutes

```sql
CREATE TABLE IF NOT EXISTS account_bells (
  "userId"     varchar(255) NOT NULL,                    -- the reader
  "targetKind" varchar(16)  NOT NULL CHECK ("targetKind" IN ('user', 'association')),
  "targetId"   varchar(255) NOT NULL,
  level        varchar(8)   NOT NULL CHECK (level IN ('lives', 'none')),   -- no row = posts and lives
  "updatedAt"  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "targetKind", "targetId")
);
-- L8: today's association mutes become level 'none' on the entity. A BACKFILL, so this file is
-- HELD (-- canari:hold-for-owner), and its CREATE TABLE ships in a separate plain file before it.
INSERT INTO account_bells ("userId", "targetKind", "targetId", level)
SELECT "userId", 'association', "associationId"::text, 'none' FROM association_push_mutes
ON CONFLICT DO NOTHING;
```

| Level | Posts of that account | Its lives |
| --- | --- | --- |
| no row: "posts and lives" (the default, set by following - decision 10) | pushed as today (followed person, or an entity whose audience reaches the reader) | pushed as today |
| `lives` | bell row only, no push | pushed |
| `none` | bell row only, no push | no push |

None of these is counted by the daily cap (decision 11, L4): posts and lives are what exists today.

**The order of the decision, per recipient, and where each step lives - ONE place each:**

1. **Who is a recipient** - the announce queries (`announceRecipientsSql`, `liveAudienceSql`, the
   republication and repost rules). The bell never ADDS a recipient: decision 5(a) is satisfied
   because a bell can only be set on an account whose posts the reader is already announced (L7).
2. **The bell row is written** for every recipient (`post_notifications`), whatever the level - the
   bell in-app is the reader's full history, as an association mute does today. A live writes none
   (L3 of the lives plan: it is deleted at its end).
3. **The bell level** filters the PUSH, in `PostNotificationsService.fanOutPush`, where
   `association_push_mutes` is read today (`MUTABLE_PUSH_TYPES`) - the same seam, now reading
   `account_bells` for both kinds of account, fail-closed as the mute lookup is.
4. **The daily cap** filters the push of the NEW kinds only ([below](#the-noise-budget---a-daily-cap-from-a-counter-row));
   a post or a live of an account never reaches it.
5. **The category** (`posts`, `forms`, `events`, `bookings`) is applied by chat-delivery from the
   push's `contentKey`, last. A category switched off wins over a bell left on "posts and lives": the
   switch is the broader statement and is what the settings screen promises.

**The followed account never learns the bell level**, as on Instagram; no endpoint returns another
user's row.

## Which posts also notify (decision 5)

### No double notification

Every new path writes into ONE told-once ledger before it pushes, and pushes only the rows it
inserted:

```sql
CREATE TABLE IF NOT EXISTS post_engagement_notices (
  "postId"      uuid         NOT NULL,
  "recipientId" varchar(255) NOT NULL,
  reason        varchar(16)  NOT NULL CHECK (reason IN ('friend', 'trend', 'suggested')),
  "createdAt"   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY ("postId", "recipientId")
);
```

`INSERT ... SELECT <candidates> WHERE NOT EXISTS (a post_notifications row for this post and
recipient) ON CONFLICT DO NOTHING RETURNING "recipientId"` - the announcement, a republication, a
repost and the previous engagement notice all leave a trace that excludes the reader, and two
concurrent paths are ordered by the primary key, not by a clock. It is the same pattern as
`member_repost_notices` (WP-F6). Deleted with the post (cascade) and by the erasure.

### (a) the bell

Nothing new to send: (a) is the default level above, "posts and lives", which every follow sets
(decision 10); the bell only ever REDUCES it.

### (b) friends' activity - the disclosure rule

**No longer a notification since 2026-11-10** ([quieter](#the-owners-decisions-of-2026-11-10---quieter-1610)):
the rule below now decides whether a campus trend may NAME X to R as someone who liked P (rules 0,
1, 3, 4 and 6, for a reaction). It is kept whole as the record of what WP-9 sent.

"X a aimé votre ... / X a commenté un post" sent to R when X reacts to or comments on post P. R is
told ONLY when ALL of these hold, each a predicate that already exists except rule 0:

0. **X shares their activity** (decision 9): X has not turned the setting off. Stored as
   `user_activity_settings("userId" PK, "shareActivity" boolean NOT NULL DEFAULT true, "updatedAt")`,
   **no row = ON**, the `user_repost_settings` pattern (WP-F6): a row exists only once the person
   chose, so the default needs no backfill. Read in the same statement as the other rules, at the
   write; turning it off stops every notice not yet sent and retracts none already sent. The switch
   lives in Settings, its strings in Paraglide (`settings_share_activity`, `settings_share_activity_hint`).
1. **R follows X, accepted** - X accepted R as an audience for X's own activity. A pending request,
   or an entity, never carries activity.
2. **R sees P** - `postVisibleToUserSql(P, R)` with the PLAIN options (no read-grant door), so the
   students-only gate, the spaces, the follower doors and the repost doors all apply.
3. **R would see X's act on P's own page**: for a comment, `commentsWithheldFromViewerSql(P, R)` is
   false and the comment is not hidden; for a reaction, the post shows its reactors to R.
4. **No block** between R and X, nor between R and P's author **when P names its author**: an
   anonymous or an association post is exempt, exactly as the feed's block filter exempts it
   (`blockedAuthorSql`) - a notice withheld on a block with the hidden writer would be a
   de-anonymisation oracle (block a suspect, see whether the notice comes). `namedAuthorUnblockedSql`,
   review of #3281.
5. **P is not anonymous** when the act is a comment (a comment thread under an anonymous post is
   already the one place the author is hidden; naming X there adds nothing and risks inference) - a
   reaction to an anonymous post may be told, since it names only X and the post.
6. **R is not P's author** (they get the existing reaction or comment notice) and **X is not P's author**
   (that is the author's own activity, announced by the post itself).
7. **R has no row for P in the ledger or in `post_notifications`** (told once, L14).
8. **The comment speaks as X** - a stored comment keeps its writer's REAL `userId` whatever it says
   it is (`posts/comment-identity.ts`), so a comment that is `anonymous`, written AS an association
   (`associationId` set), or `removedByModeration` NEVER produces an activity notice: naming X there
   would unmask an anonymous writer or the member behind an association's voice, and point at a
   removed comment. Only a reaction (always X's own) or a plain comment of X's qualifies.

Rule 2 and 3 are what "never reveal an activity on a post the recipient cannot see" means; rule 1 is
what "never reveal activity of a person on a post the actor's own audience rules hide" means: X's
activity only travels along X's own accepted followers, and only onto posts those followers can
already open. Taking back the reaction does not retract a sent notice (Instagram's), and the bell row
links to P, whose own predicate is re-asked on open.

Sent at the WRITE (the reaction or comment commits under the post row's lock, `comment-write.ts`), one
statement for all of X's followers, then pushed through X's bell - not counted by the daily cap
(decision 11 as amended 2026-11-10: the reader follows X).

### WP-9 - friends' activity (BUILT, RETIRED 2026-11-10)

**Retired by the owner on 2026-11-10**: nothing writes `friend_reaction` or `friend_comment` any more,
`posts/friend-activity.ts` and its spec are deleted, and the trend names the friends instead
([quieter](#the-owners-decisions-of-2026-11-10---quieter-1610)). The types stay in the client floors,
`BELL_PUSH_KINDS` and the native tables for the rows already in bells; the ledger's `friend` rows
keep excluding their readers from a trend of the same post. What follows is the record.

Built 2026-11-09 to the rule above. Migration **159** (`user_activity_settings` and
`post_engagement_notices`, plain); `posts/friend-activity.ts` holds the one statement.

- **Two notice types, not one**: `friend_reaction` and `friend_comment`, each with its own push key
  (`social_friend_reaction`, `social_friend_comment`) and native sentence ("X a réagi à une
  publication" / "X a commenté une publication"), since a native table states one fixed sentence per
  key. Both file under `posts` in chat-delivery (the category applies), are NOT capped since
  2026-11-10 (decision 11 amended: the reader follows X, so X's activity pushes like X's post), are in
  `BELL_PUSH_KINDS` as a post (an account's reduced bell reduces its activity too), and in
  `POST_BOUND_NOTIFICATION_TYPES` (the bell row is shown only while its reader still sees the post).
  The row's text and the push's body are the POST's opening, never the comment or the reaction.
- **One statement at the write** (`friendActivityLedgerSql`): rules 0-7 and the review cohort, the
  ledger insert `ON CONFLICT DO NOTHING RETURNING`, one lock order. Rule 8 is asked of the stored
  comment before it (`commentSpeaksAsWriter`). Then `createNotifications` writes the rows and pushes
  through the bell (never the cap since 2026-11-10). Called after a NEW reaction (changing the emoji is not news) and
  after every comment (`PostInteractionsService.tellFriends`, fire-and-forget, a failure logged) -
  a comment's only once its own comment, reply and mention rows are written, so a follower it
  answers or mentions is told once by rule 7, never twice by a race (review of #3281).
- **"Partager mon activité"**: `GET` / `PUT /api/posts/me/activity-settings`, the switch in
  Settings > Préférences (`ActivitySharingSetting.svelte`, strings `settings_share_activity`,
  `settings_share_activity_hint`).
- **Erasure**: the person's setting and every ledger row naming them as recipient; a ledger row of
  a post goes with the post.
- **Proof**: `posts/friend-activity.integration.spec.ts` on PostgreSQL - the told set exactly (rules
  1, 2, 4, 6), the rows and pushes; rule 0 off then on; a hidden post; a reader reaching the post only
  through a read grant (rules 2 and 3); rule 5 (comment refused, reaction told); rule 6; rule 7 (a
  `post_notifications` row, and told once across acts); rule 8 for an anonymous comment, one written
  as an association and a removed one, none of which reaches the database; the review cohort; the
  erasure; the cascade. `ActivitySharingSetting.svelte.test.ts`, the native-strings test.
- **Owed**: a dev pass and a phone reading on both bench phones (a follower's push "X a réagi à une
  publication", its bell row opening the post; the switch off silencing it).

### (c) campus trends - "takes off", defined without a clock heuristic

**A post takes off when the number of DISTINCT accounts that reacted to or commented on it reaches
`TREND_THRESHOLD` within 24 hours of its `publishedAt`** (the instant it became visible - not
`createdAt`, which is earlier for a scheduled post), read at the reaction's or comment's own
write, under the post row's lock, against the database's `now()`:

- **Deterministic**: the count is a property of the row (the keys of `posts.reactions` plus the
  distinct authors of `posts.comments`), the crossing happens at exactly one write, and that write
  stamps `posts."trendAnnouncedAt"` in the same transaction (`WHERE "trendAnnouncedAt" IS NULL`) -
  the `lives."announcedAt"` pattern. No sweep, no window that slides, no rate.
- **The 24-hour bound** is a stated rule of what "a short time" means, read from the database clock
  at one write; it decides eligibility, it never decides idempotence (the stamp does).
- **Recipients**: everyone who sees P through the SPACE rule (P reaches one of their spaces -
  `postReachesSpaceSql` - and `postVisibleToUserSql` holds), minus P's author, minus blocks with the
  author when P names it (rule 4 of (b)), minus the ledger and `post_notifications` (L14). Never through a follower door or a read
  grant: decision 5(c) says "from your space".
- **`TREND_THRESHOLD` is a MEASUREMENT owed before WP-10 merges**, not a guess: the smallest integer
  at which **at most one post per campus per day** would have crossed, over the last 90 days -
  amended 2026-11-10 by the lead to **at most one per three days per campus**, burst days left to
  the per-reader daily cap ([R1](#r1---the-trend-threshold): `10`). That
  target rate is the explanation the rule carries: a trend is rare by construction, and the number
  is re-derived from the same query if the population changes. The query is
  [R1 below](#r1---the-trend-threshold). Until it is read, WP-10 does not merge.

### WP-10 - campus trends (BUILT)

Built 2026-11-09 to the rule above, with `TREND_THRESHOLD = 4` as R1 read it then (**10 since
2026-11-10**, [R1](#r1---the-trend-threshold)). Migration **160**
(`posts."trendAnnouncedAt"`, a nullable column, no backfill, plain); `posts/campus-trend.ts`.

- **The crossing, stamped once** (`STAMP_TREND_SQL`): after every new reaction and every comment,
  one `UPDATE ... SET "trendAnnouncedAt" = now() WHERE "trendAnnouncedAt" IS NULL` that also requires
  a published, unhidden post (not a reel) within 24 hours of `publishedAt` and `engagedAccountsSql`
  (WP-7's one definition) at or above the threshold. Under concurrent writers the row lock lets
  exactly one through; the others re-read a stamped row. No sweep, no timer. **The stamp and the
  ledger are ONE statement** (`campusTrendSql`, the stamp a data-modifying CTE the ledger insert
  reads): they commit together or not at all, so a post is never stamped with nobody told (review of
  #3285; the first draft ran them as two statements).
- **The audience** (`campusTrendLedgerSql`): everyone a space of whom the post reaches
  (`postReachesSpaceSql`) and who sees it by the plain predicate with the follower door closed and no
  grant, minus the author, a block either way with the author when the post names it
  (`namedAuthorUnblockedSql`: an anonymous or an association post is exempt, as in the feed - review
  of #3285), the other side of the review cohort,
  and whoever has a row for the post in the ledger (friends' activity included) or in
  `post_notifications`; inserted into `post_engagement_notices` with reason `trend`.
- **Naming nobody**: the row and the push carry the system actor - an anonymous post stays
  anonymous, and a trend is the space's, not a person's. **Since 2026-11-10 the body may name a
  followed account who LIKED it** (never the author;
  [quieter](#the-owners-decisions-of-2026-11-10---quieter-1610)), and a reader is told of at most
  two trends a week. Type `campus_trend`, key
  `social_campus_trend` ("Une publication fait réagir votre espace", the post's opening as body),
  native strings on Android and iOS, counted by the daily cap (`PUSH_BUDGET`, under `suggestions` since 2026-11-10), in
  `POST_BOUND_NOTIFICATION_TYPES`, not in `BELL_PUSH_KINDS` (no account to reduce).
- **Proof**: `posts/campus-trend.integration.spec.ts` on PostgreSQL - no stamp below the threshold
  (the author's own reaction not counted), exactly one at the crossing write, none at the next one;
  a comment writer counted once; none after 24 hours, for a hidden post, for a reel; the space-only
  audience (the author, a block with the author, a reader with a row, a follower outside the space,
  a reader through a read grant all left out); a reader told by friends' activity not told again;
  six concurrent writers over the crossing stamping once and telling each reader once; an anonymous
  post told to a reader its hidden writer blocked; a ledger that cannot be written leaving the post
  unstamped.
- **Owed**: a dev pass and a phone reading (a post of the bench account's space reaching ten
  engaged accounts within a day pushes "Suggestion : <its opening>" once, and a second post crossing
  the same day pushes nothing to the same reader).

#### The deploy of 2026-11-10, and what it changed

**What happened.** The 1.6.9 deploy started evaluating trends on posts already in the 24-hour window.
Five of them were past `TREND_THRESHOLD` = 4 already, so the next reaction or comment on each
"crossed" it: within 8 minutes `campus_trend` wrote 2,483 notifications to 498 readers. A 1.6.8
build drew each row as "Une notification que cette version de l'application ne peut pas afficher";
1.6.9 drew "Quelqu'un", an initials disc and nothing after "fait réagir :" for a post with no text.
**The 2,483 rows are left as they are**: deleting production rows needs the owner's yes. The owner's
decisions of 2026-11-10, as built:

- **A crossing is a crossing, read from durable state, never a clock** (migration **161**, plain:
  `posts."trendEngagedSeen"`, `ADD COLUMN`, then `SET DEFAULT 0`, no backfill). Every evaluation
  (`EVALUATE_TREND_SQL`) records the engaged count it read, and keeps two answers apart (review of
  #3312, H1 and H2): **the STAMP** (`trendAnnouncedAt`) is written at the first evaluation that finds
  the count at or above the threshold - a level, a hidden post included - and a stamped post is never
  evaluated again; **the ANNOUNCEMENT** is made only when that stamp is a crossing observed: the count
  recorded before this write (`RETURNING old."trendEngagedSeen"`, PostgreSQL 18, the row version the
  UPDATE replaced under its lock) was below the threshold, and the post is not hidden. A post created
  after 161 is born at 0, a fact (nobody has engaged yet), so its crossing is announced as before. A
  post from before 161 has NULL - "never evaluated": past the threshold at its first evaluation, it is
  stamped SILENTLY; below it, it records a count and a later real crossing announces. So no deploy
  can announce a backlog. **A post that takes off while hidden is stamped silently**, so a
  moderator's restore cannot announce it on a level read; a post restored below the threshold is
  announced at its real crossing after the restore. **A changed `TREND_THRESHOLD` is handled the same
  way**: raising it only makes crossings rarer; lowering it to `t` stamps silently a post whose
  recorded count is already at or above `t` - only a post whose next write takes it from below `t`
  to `t` is announced. The write is skipped when the count did not change (`IS DISTINCT FROM`), so an
  unchanged reaction set costs no row version. A silent stamp logs `[TREND] ... stamped without an
  announcement`.
- **A rollback to `1.6.9` must run ONE statement first.** `1.6.9` announces on a LEVEL any unstamped
  post within 24 hours, so a rollback would announce every post that is past the threshold and was
  never evaluated since `1.6.10` (its stamp is written only by an evaluation). Before the rollback,
  in its own transaction, on the estate rolled back:

  ```sql
  UPDATE posts SET "trendAnnouncedAt" = now()
   WHERE "trendAnnouncedAt" IS NULL AND "publishedAt" > now() - interval '24 hours';
  ```

  It stamps every post of the window, announced or not, so `1.6.9` announces nothing it did not see
  cross; the price is that no post of those 24 hours can trend after the rollback. Written in
  `CHANGELOG.md` with the rollback, as every rollback is.
  **Run once on production, 2026-11-10, about 19:45 Paris time, under the owner's explicit yes**,
  with a 7-day window instead of 24 hours, to stop 1.6.9's level-based bursts (three more after
  17:00, about 500 recipients a post): 75 posts stamped, no row deleted.
- **ONE trend per reader per Paris day** (161: `post_engagement_notices."trendDay"` and the partial
  unique index `UQ_post_engagement_notices_trend_day` on `("recipientId", "trendDay")`). The ledger
  insert writes the Paris date of the database's `now()` and `ON CONFLICT DO NOTHING` with no target,
  so it yields to BOTH the per-post key and the per-day index: a reader told of one trend today is not
  told of a second, inbox row AND push, whatever the order or the concurrency (two posts crossing at
  once tell each reader exactly one). The second post is stamped all the same - it took off, and is
  never announced later. The ledger IS the daily counter; nothing resets anything, a new day is a new
  date.
- **Wording.** Inbox row and push title read **"Suggestion :"** and the post's opening; a post with no
  text says what it shows - "une photo", "une vidéo", else "une publication" - never a colon followed
  by nothing. The row carries `meta.media` (`trendMediaOf`, the post's first image or video); the
  push uses three keys, `social_campus_trend` ("Suggestion : %1$s", body "Une publication qui fait
  réagir votre espace"), `social_campus_trend_photo` and `social_campus_trend_video`, in the Android
  and iOS tables (app and NSE).
- **The row is not a person**: no actor name, no initials disc. `CampusTrendThumb.svelte` draws the
  post's first picture (read once the row is near the viewport, through the shared-post preview
  cache) or a video's ThumbHash, else lucide `TrendingUp`; the badge is `TrendingUp` too.
- **Its own switch, "Suggestions"** ("Une publication qui fait réagir votre espace, une fois par jour
  au plus"), on by default when it shipped - **since the charter, two levels: "Suggestions dans
  l'app" (every suggestion surface, on by default) and its push (off by default, opt-in)** ([below](#aligned-with-the-charter-owner-2026-11-10)) -,
  independent of "Publications": a new member of chat-delivery's closed set
  `NOTIFICATION_CATEGORIES`, which stores only the DISABLED categories, so no migration and on for
  everyone. The three keys are filed under `suggestions`, and so is `campus_trend` in
  `CAPPED_PUSH_TYPES`. **A reader who switched "Publications" off to silence trends hears them again
  until they switch "Suggestions" off** - the price of separating the two. **Measured on production
  2026-11-10 (the lead, read-only): exactly 1 account has "Publications" off, of 4
  `notification_preference` rows**, so no backfill copies that choice into "Suggestions".
- **Never to a build too old to draw it**: the rule is general and lives in
  [legacy-compatibility](legacy-compatibility.md#the-client-floor-of-every-notification-type-owner-2026-11-10);
  `campus_trend` and its three keys have the floor `1.6.10`.
- **Proof**: `campus-trend.integration.spec.ts` on PostgreSQL adds the deploy case (an unrecorded post
  past the threshold stamped silently and never announced, an unrecorded one below it announced at its
  later crossing), a recorded count at the threshold stamped silently, a post that took off while
  hidden never announced once restored, a post restored below the threshold announced at its later
  crossing, the recorded count and the skipped write (`xmin` unchanged), one
  trend per day, the next Paris day, two posts crossing at once, and a photo post's row and push key;
  `bell-page.integration.spec.ts` the floor filter; `notification-client-floor.spec.ts` the tables;
  `NotificationRow.svelte.test.ts` the row.

### (d) openings for followers - one notice, never two

The owner confirmed it: a follower is told automatically when an entity they follow opens a form, a
booking space or an event (a shotgun); "Me prévenir" stays for everyone else; one notification per
person.

- **One table, one unique key** (L9): `opening_reminders(kind, "targetId", "userId", "opensAt",
  origin, "notified5min", "notifiedOnOpen")`, `kind` in (`form`, `booking`, `event`), `origin` in
  (`asked`, `followed`), unique `(kind, "targetId", "userId")`. WP-4 copies `form_reminders` into it
  (`origin = 'asked'`; a backfill, so a HELD file - [which migrations are held](#which-migrations-are-held)) and points `FormReminderScheduler` at it; dropping `form_reminders`
  is a later HELD migration.
- **At publication** (or when `opensAt` is set or moved), the entity's `association_follows` rows
  that can see the target are inserted with `origin = 'followed'`, `"notified5min" = true` (a
  follower gets the opening, not the five-minute heads-up), `ON CONFLICT DO NOTHING` - a reader who
  already asked keeps their row and its heads-up.
- **"Me prévenir" after the fact** upserts the reader's row to `origin = 'asked'` and re-arms
  `"notified5min"` while the opening is still to come (L28): the same row, so still one opening
  push.
- **The push** is the scheduler's existing claim (`notifiedOnOpen` flipped before the send): one row,
  one claim, one push, whoever caused the row. A target with no `opensAt` (open at once) is inserted
  with `opensAt = now()` and claimed at the next tick.
- An event's shotgun is its registration form when it has one (the form's row is the one used); an
  event without a form "opens" when it is published to the agenda.
- **A NEUTRAL event (owner, 2026-11-08) is not an opening of its BDE**: it notifies no follower of
  the BDE under the BDE's name. If WP-4 announces it at all, it is to the event's audience as
  "Nouvel événement sur le campus", with no association - the masking rule of
  [calendar](frontend/modules/calendar.md#neutral-campus-events-owner-2026-11-08).
- Categories: `form_open` stays `forms`, a booking opening files under `bookings`, an event opening
  under `events`. **Never capped**, whatever the row's origin (decision 11: shotgun openings are
  outside the cap).

## The noise budget - a daily cap from a counter row

Decision 6 settles that a cap exists; the design is:

```sql
CREATE TABLE IF NOT EXISTS engagement_push_days (
  "userId" varchar(255) NOT NULL,
  day      date         NOT NULL,
  pushed   integer      NOT NULL DEFAULT 0 CHECK (pushed >= 0),
  PRIMARY KEY ("userId", day)
);
```

At each fan-out of a CAPPED type, ONE statement for all its recipients:

```sql
INSERT INTO engagement_push_days ("userId", day, pushed)
SELECT r, (now() AT TIME ZONE 'Europe/Paris')::date, 1
  FROM (SELECT DISTINCT r FROM unnest($1::varchar[]) r) ids
 -- the CATEGORY first: a reader who switched it off is never pushed, so must not spend the budget
 WHERE NOT EXISTS (SELECT 1 FROM notification_preference np
                    WHERE np."userId" = ids.r AND np."disabledCategories" ? $3)
 ORDER BY r                                          -- one lock order for every fan-out
ON CONFLICT ("userId", day) DO UPDATE SET pushed = engagement_push_days.pushed + 1
  WHERE engagement_push_days.pushed < $2            -- ENGAGEMENT_DAILY_PUSH_CAP
RETURNING "userId";
```

The returned ids get the push; the others keep only their bell row. Three properties, each owed by a
line of the statement:

- **`DISTINCT`**: a fan-out that names a reader twice would otherwise make `ON CONFLICT DO UPDATE`
  touch the same row twice in one command, which PostgreSQL refuses (the whole fan-out would fail).
- **`ORDER BY`**: the `ON CONFLICT DO UPDATE` row locks are taken in the order rows arrive; two
  concurrent fan-outs over overlapping readers in different orders could deadlock. One order, no
  cycle. The lock then orders the two on each shared reader, so the cap is exact, not approximate.
- **The category before the count**: `notification_preference` (chat-delivery's, the same database
  the service already reads `user_blocks` from) is read with `$3`, the category the capped type files
  under. chat-delivery still applies it at the send (it stays the one place a push is filtered), and
  `$3` comes from ONE exported map in social-service that a contract test pins against
  `push-category.ts`, as the frontend mirror already is - so the two cannot disagree about which
  category a capped type belongs to.

A new day is a new row: nothing resets anything. The daily GC that already prunes notifications
(`FormReminderScheduler`) deletes rows older than 7 days.

- **Since the second batch of 2026-11-10 the two lists below are superseded** by ONE table,
  `PUSH_BUDGET`, and a cap of THREE across every engagement-only kind
  ([quieter](#the-owners-decisions-of-2026-11-10---quieter-1610)); what follows is the record of the
  first amendment.
- **Capped types - ONLY accounts the reader does not follow** (decision 11 as amended 2026-11-10;
  `CAPPED_PUSH_TYPES`, one exported map): campus trends (5c), and a push about a suggestion or a
  suggested post if one is ever added (the design adds none: suggestions and suggested posts live in
  the feed, not in a push). **Friends' activity (5b) is no longer capped**: it names an account the
  reader follows, and following is the choice to hear from it (decision 10).
- **Never capped** - everything that exists today, unchanged: association posts and reposts,
  followed posts, member reposts, lives, shotgun openings of every origin (5d), messages and channel
  messages, mentions, replies and comments, reactions to the reader's own content (L5), calls,
  friends' activity (since 2026-11-10),
  follow requests and acceptances, bookings, events, forms and money notices, moderation notices.
- **Why 5 to start.** (Written when friends' activity was capped; since 2026-11-10 the cap guards
  campus trends alone, which are at most one per READER per day since 2026-11-10 by their own
  ledger, so it is a guard for kinds yet to
  come rather than a bound that binds today.) The cap guarded only what is new and what the reader did not ask for: an
  account's activity on someone else's post, and a post that took off. Trends are at most one per
  campus per day by construction (R1), so friends' activity is what can grow: it scales with
  (accounts followed) x (their reactions and comments), and the most social readers - the ones a
  burst would reach - are also the ones most likely to switch the category off, after which every
  post of the people they follow is silenced too. Five is roughly one per waking slot (morning,
  midday, afternoon, evening, night), above a quiet day, so it binds only on busy days, and the excess
  stays in the bell. **The number is a constant to re-read**: [R2](#r2---the-cap-check) gives the
  production distribution of what friends' activity WOULD have pushed per reader per day; the
  constant moves with that reading, before WP-9 merges.

### WP-8 - the daily cap (BUILT)

**3 since 2026-11-10, over every type `PUSH_BUDGET` counts, asked by every send through
`withinPushBudget`** ([quieter](#the-owners-decisions-of-2026-11-10---quieter-1610)); the text below
is the state of 2026-11-09 and the first amendment.

Built 2026-11-09 to the design above, with the cap at 5 as R2 read it. Migration **157**
(`engagement_push_days`, plain); `posts/engagement-push-cap.ts` holds the constant, the allowlist
`CAPPED_PUSH_TYPES` (`campus_trend` alone, filed under `suggestions` since 2026-11-10 - under
`posts` before, L30; `friend_reaction` and
`friend_comment` were in it from WP-9 until the owner's amendment of decision 11 on 2026-11-10), the
one claim statement and the GC statement.

- **The seam** is in `PostNotificationsService.fanOutPush`, AFTER the bell (a reader the bell
  silenced never spends a unit) and before the bounded fan-out: a type outside the allowlist goes out
  exactly as before and never touches the table; a capped one pushes only the readers the claim
  returned, the others keep their in-app row. A failed claim fails CLOSED and loudly, as the bell
  does: nobody is pushed, an error names the type, and the error reaches the caller.
- **The table the category is read from** is chat-delivery's `notification_preference` (singular,
  its migration 028; the design text above said `notification_preferences`).
- **chat-delivery** files `social_friend_reaction` and `social_friend_comment` under `posts`, and the
  three trend keys under `suggestions` (2026-11-10), so each switch governs its own, capped or not;
  `engagement-push-cap.spec.ts`
  reads chat-delivery's `CATEGORY_BY_CONTENT_KEY` and pins every capped type's category against it.
- **The GC**: `FormReminderScheduler.purgeEngagementPushDays`, daily at 03:05, rows older than 7
  days. **The erasure**: the recipient's rows (`account-erasure.ts`).
- **Proof**: `posts/engagement-push-cap.integration.spec.ts` on PostgreSQL - the 6th claim of a day
  refused; 24 concurrent fan-outs over overlapping readers (in two orders, one naming a reader twice)
  never exceed 5 per reader; a reader with `posts` switched off never counted; the GC's 7-day bound
  and the erasure; through the real `fanOutPush`, the 6th capped push reaching the bell only, an
  association post, a live, a booking opening, an event opening and a mention on the same day never
  counted, and a failed claim pushing nobody; since 2026-11-10, eight friend-activity pushes in a
  day all going out without a counter row, the five trend pushes after them still taken in full.
  Superseded the same day by the quieter batch: ONE cap of 3 over `PUSH_BUDGET`'s counted kinds,
  proved as listed [there](#the-owners-decisions-of-2026-11-10---quieter-1610).
- **Owed**: nothing of its own on the phones - the cap is exercised by WP-10's trend pushes; a dev
  pass with them.

## The production readings - the exact queries

Decision 14: the lead runs them, read-only, on production. Each runs inside a read-only transaction
with a timeout, `EXPLAIN` first, and reports counts per campus and percentiles only - never an id
([durable-rules](durable-rules.md#a-measurement-taken-from-production-names-roles-and-counts-never-people---this-repository-is-public)).

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
-- EXPLAIN <the query>;  then the query itself
ROLLBACK;
```

### R1 - the trend threshold

Per campus (the author's `users.campus`; an association post counts on its publishing member's
campus, an approximation stated here), for each candidate threshold `t`, how many posts of the last
90 days reached `t` distinct engaged accounts. Reactions carry no timestamps, so the reaction half is
the post's TOTAL - an upper bound of its 24-hour count, which makes the threshold read conservative
(it can only come out too high, never too low). The comment half is cut at 24 hours, which comments
allow (`createdAt` per element).

```sql
WITH engaged AS MATERIALIZED (   -- computed ONCE, not once per threshold (19.5 s -> 0.24 s)
  SELECT p.id, u.campus,
         (SELECT count(DISTINCT x) FROM (
             SELECT jsonb_object_keys(p.reactions) AS x
             UNION
             SELECT c->>'userId' FROM jsonb_array_elements(p.comments) c
              WHERE (c->>'createdAt')::timestamptz < p."publishedAt" + interval '24 hours'
           ) s
          WHERE x IS NOT NULL AND x <> p."authorId") AS n
  FROM posts p JOIN users u ON u.id = p."authorId"
  WHERE p."publishedAt" > now() - interval '90 days'
    AND NOT p."hiddenByModeration" AND u.campus IS NOT NULL
)
SELECT campus, t AS threshold,
       count(*) FILTER (WHERE n >= t) AS posts_crossing,
       round(count(*) FILTER (WHERE n >= t) / 90.0, 2) AS per_day
FROM engaged CROSS JOIN generate_series(3, 60) t
GROUP BY campus, t ORDER BY campus, t;
```

**Reading it:** per campus, the smallest `t` whose `per_day` is at most `1.00`; `TREND_THRESHOLD` is
the LARGEST of those per-campus values (one constant, so no campus exceeds the rate). Written back
here with the date, the row counts and the distribution's tail.

**Superseded on 2026-11-10 by the per-DAY reading below.** An average of 1.00 a day still allows five
on one busy day, which is what the owner rules out: "at most one trend a day" is a bound on the
BUSIEST day, so the reading groups by the Paris date of `publishedAt` and takes the maximum. Reels
are left out, as the rule leaves them out. `TREND_THRESHOLD` in `posts/campus-trend.ts` is a
one-line change, and a raise or a lowering announces no backlog
([the crossing rule](#the-deploy-of-2026-11-10-and-what-it-changed)). Read on production the same
day - the table and the decision follow the query.

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH engaged AS MATERIALIZED (
  SELECT u.campus,
         (p."publishedAt" AT TIME ZONE 'Europe/Paris')::date AS day,
         (SELECT count(DISTINCT x) FROM (
             SELECT jsonb_object_keys(p.reactions) AS x
             UNION
             SELECT c->>'userId' FROM jsonb_array_elements(p.comments) c
              WHERE (c->>'createdAt')::timestamptz < p."publishedAt" + interval '24 hours'
           ) s
          WHERE x IS NOT NULL AND x <> p."authorId") AS n
  FROM posts p JOIN users u ON u.id = p."authorId"
  WHERE p."publishedAt" > now() - interval '90 days'
    AND p.kind = 'post'
    AND NOT p."hiddenByModeration" AND u.campus IS NOT NULL
),
per_day AS (
  SELECT campus, t, day, count(*) FILTER (WHERE n >= t) AS crossing
  FROM engaged CROSS JOIN generate_series(3, 60) t
  GROUP BY campus, t, day
)
SELECT campus, t AS threshold,
       sum(crossing) AS posts_crossing,
       count(*) FILTER (WHERE crossing > 1) AS days_over_one,
       max(crossing) AS max_in_a_day
FROM per_day GROUP BY campus, t ORDER BY campus, t;
ROLLBACK;
```

**Read on production 2026-11-10** (the lead, read-only), 90 days, Saint-Etienne:

| `t` | posts crossing | days with more than one | max in a day |
| --- | --- | --- | --- |
| 4 | 90 | 21 | 12 |
| 6 | 55 | 10 | 11 |
| 8 | 37 | 5 | 10 |
| **10** | **28** | **5** | **10** |
| 12 | 20 | 4 | 9 |
| 15 | 15 | 3 | 8 |
| 20 | 9 | 2 | 5 |
| 22 | 5 | 1 | 3 |
| 25 | 3 | 0 | 1 |

Gardanne: 0 posts crossing at every `t`, so it constrains nothing.

**Why "max in a day at most 1" was NOT the rule kept.** The busiest day stays high because of a few
burst days (one day carried up to 12 posts over the threshold at 4); bounding it at 1 forces `t = 25`,
three trends in 90 days - too rare to be a feature.

**The decision rule (lead, 2026-11-10): `TREND_THRESHOLD` is the smallest `t` at which the posts
crossing over 90 days are at most one per three days per campus (at most 30 in 90 days); the
per-reader daily cap absorbs burst days.** That is **`TREND_THRESHOLD = 10`** (28 posts in 90 days,
about one every three days; 8 gives 37). On a burst day several posts may still be stamped, but the
ledger's per-day index (`trendDay`, migration 161) tells each reader of one at most - the threshold
decides how many posts are STAMPED, the index how many a reader hears of. Re-read with the same query
when the population changes; the largest per-campus value wins, a campus with no row constrains
nothing.

**Read on production 2026-11-09** (the lead, with the owner's yes - decision 14), 90 days, by the
AVERAGE rule above (superseded 2026-11-10):

| Campus | t = 3 | t = 4 | t = 5 | t = 10 |
| --- | --- | --- | --- | --- |
| saint-etienne | 106 posts (1.18/day) | at most 1.00/day - the smallest `t` meeting the rate | 60 (0.67/day) | 21 (0.23/day) |
| gardanne | 0 | 0 | 0 | 0 |

Gardanne has no post crossing at any threshold from 3, so it constrains nothing. `TREND_THRESHOLD =
4` was Saint-Etienne's value by that rule, until the per-day reading above set it to 10.

**When no threshold up to 60 gets a campus to 1 per day or below** (more than 90 posts in 90 days
reached 60 engaged accounts), the reading does NOT pick 60: it is re-run with the upper end of
`generate_series` raised until a row reaches the rate, and the value found is written back with that
fact. A campus with NO post at all in the window (no row) constrains nothing and is said so. The
timing (19.5 s without `MATERIALIZED`, 0.24 s with it, on 3,000 posts) is the review's measurement of
2026-11-07.

### R2 - the cap check

What friends' activity (5b) WOULD have pushed per reader per day over the last 30 days: one notice
per (reader, post) - the told-once ledger - dated by the first act of an account the reader follows
(accepted). An UPPER BOUND: it applies neither the visibility rules nor the activity setting (no one
has turned it off yet), and it counts a post the reader was already announced. Reactions are dated by
the post's `publishedAt` (they carry no time), comments by their own `createdAt`; days are Paris dates
as the cap's are (L6).

```sql
WITH acts AS (
  SELECT p.id AS post, p."authorId" AS author, k AS actor,
         (p."publishedAt" AT TIME ZONE 'Europe/Paris')::date AS day
    FROM posts p, jsonb_object_keys(p.reactions) k
   WHERE p."publishedAt" > now() - interval '30 days'
  UNION
  SELECT p.id, p."authorId", c->>'userId',
         ((c->>'createdAt')::timestamptz AT TIME ZONE 'Europe/Paris')::date
    FROM posts p, jsonb_array_elements(p.comments) c
   WHERE p."publishedAt" > now() - interval '30 days' AND c->>'userId' IS NOT NULL
), told AS (
  SELECT f."followerUserId" AS reader, a.post, min(a.day) AS day
    FROM acts a
    JOIN user_follows f ON f."followedUserId" = a.actor AND f.status = 'accepted'
   WHERE a.actor <> a.author AND f."followerUserId" <> a.author
   GROUP BY 1, 2
), per_day AS (
  SELECT reader, day, count(*) AS n FROM told GROUP BY 1, 2
)
SELECT percentile_disc(ARRAY[0.5, 0.9, 0.99]) WITHIN GROUP (ORDER BY n) AS p50_p90_p99,
       max(n) AS max_per_day,
       count(*) AS reader_days,
       count(DISTINCT reader) AS readers,
       round(100.0 * count(*) FILTER (WHERE n > 5) / NULLIF(count(*), 0), 1) AS pct_reader_days_over_5,
       round(100.0 * count(DISTINCT reader) FILTER (WHERE n > 5)
             / NULLIF(count(DISTINCT reader), 0), 1) AS pct_readers_ever_over_5
FROM per_day;
```

**Reading it:** the percentiles are over reader-DAYS with at least one candidate notice (a silent day
is not a row). If p90 is already above 5, the cap binds for most active readers and the constant is
re-read; if p99 is below 5, the cap never binds and stays only as the guard. Either way the reading is
written back here before WP-9 merges.

**Read on production 2026-11-09** (the lead, with the owner's yes - decision 14), 30 days, the upper
bound: per reader-day p50 = 2, p90 = 5, p99 = 12, max 13; 261 reader-days, 22 readers; 10.0 % of
reader-days over 5; 50.0 % of readers over 5 at least once. **p90 is not above 5, so
`ENGAGEMENT_DAILY_PUSH_CAP` stays 5**: it binds on the busiest days, as intended. (Lowered to 3
and widened to every non-essential kind by the owner on 2026-11-10 - the quieter batch.)

## What each surface reveals, and to whom

| Surface | Reveals | To whom | Why it is acceptable |
| --- | --- | --- | --- |
| Association live push (WP-1) | that the association is live | everyone who can already watch it | the audience of its posts; read grants never notified |
| Member live push | that the member is live | their accepted followers who see it | unchanged |
| Suggestion card | a name and photo | any viewer | Q4: a private account is findable; nothing of its posts |
| "N en commun" and faces | that face F follows candidate C | only a viewer F accepted as follower, with no block between viewer and F | F already let the viewer into their audience; a block removes the face; C learns nothing |
| Ranking (promo, formation, campus, co-membership) | nothing explicit (L11) | - | the card carries no reason line; order alone discloses no single fact |
| Entity suggestion | the entity and its follower count order | viewers its audience rules reach | an entity's page is already visible to them |
| "Suivez aussi..." | the viewer's own suggestions again | the viewer | built from the viewer's sources, never from the followed account's follows (L15), so a request to a private account reveals nothing of whom they follow |
| Dismissal | nothing | - | never shown to the dismissed account |
| Bell | nothing | - | the followed account never sees the level |
| Friend activity (5b) | that X reacted or commented on P | R, an accepted follower of X who sees P and would see the act on P - and only while X shares their activity (decision 9) | the [disclosure rule](#b-friends-activity---the-disclosure-rule) |
| Trend (5c) | that P is popular | readers whose SPACE P already reaches | they can open P from the feed already |
| Opening for followers (5d) | that a form, booking or event opened | followers who can see it | the same audience as the target itself |
| Suggested post (8) | P, marked "Suggestion" | readers who already see P by the space rule | decision 8: nothing they could not see |
| Onboarding banner (7) | the carousel | the viewer themself | - |

## The work packages, in order - one small pull request each

**How each one ships** (decision 13): on its own, to production, after an adversarial review, a pass
on dev through a pre-release, and a phone reading - without waiting for the owner. A package with a
held migration - the WP-3 and WP-4 copies and the two later drops, [listed below](#which-migrations-are-held) -
still needs its approval line under the
[held-migration rule](cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01), in the order
written there.

**The order, and why.** Cheapest win first. The first guess handed with the decisions (the follow
button, the association live audience and the bell before the suggestion graph) holds as it was
given. The first version of this page put the daily cap third, ahead of every package that added
pushes; decision 11 then took every existing push and the shotgun openings OUT of the cap, so the cap
now guards only friends' activity and trends, and ships IMMEDIATELY BEFORE the first of them (WP-8,
then WP-9). Shipping it earlier would guard nothing.

| WP | What | Starting point | Proof |
| --- | --- | --- | --- |
| **WP-1** (BUILT, #3119) | An association's live reaches everyone who can see it | `lives/live-announcer.ts` | `lives.integration.spec.ts` on PostgreSQL ([above](#wp-1---an-associations-live-reaches-everyone-who-can-see-it-built)) |
| **WP-1b** (BUILT, #3119) | One announced live per association per 6 hours (L16) | `lives/lives.service.ts` (the claim) | [above](#wp-1b---one-announced-live-per-association-per-6-hours-built-in-the-same-pull-request) |
| **WP-2** (BUILT, [below](#wp-2---suivre-everywhere-built)) | Suivre everywhere a person or entity is named: post headers of an account the viewer does not follow, search results, association cards (today only the profile and the association page carry it) | `frontend/src/lib/follows/api.ts` | component tests per surface; a phone reading of a follow request from a post header |
| **WP-3** (BUILT, [below](#wp-3---the-bell-built)) | The bell (decisions 3d, 5a, 10): `account_bells` (`lives` and `none` only, L3), the HELD copy of `association_push_mutes`, the old mute endpoints writing `account_bells` (L8), a follow deleting the row in the creating statement, the seam in `fanOutPush`, the profile control, the association mute UI moved onto it | `follows/association-push-mutes.service.ts` | integration spec of the level table above; a new follow resets a reduced bell and a RETRIED follow does not; following a muted association again unmutes it; a mute set through the old endpoint after the copy is honoured; the existing mute specs still green against the new store |
| **WP-4** (BUILT, [below](#wp-4---openings-for-followers-built)) | Openings for followers (5d): `opening_reminders`, the HELD copy of `form_reminders`, follower rows at publication, "Me prévenir" upsert, booking and event openings; never capped | `forms/forms-reminder.scheduler.ts` | integration spec: a follower who also asked gets ONE push, a follower gets the opening and no heads-up, a non-follower who asked gets both |
| **WP-5** (BUILT, [above](#wp-5---the-suggestion-query-built)) | The suggestion query, its faces, entities, `follow_suggestion_dismissals`, `GET /api/suggestions`, `POST /api/suggestions/dismiss`, the erasure | `follows/` | integration spec of every exclusion of decision 2 and every face rule of decision 4; EXPLAIN on dev |
| **WP-6** (BUILT, [above](#wp-6---the-surfaces-built)) | The surfaces (decisions 3 and 7): the carousel in the feed, "Suivez aussi...", the empty Suivis feed, the onboarding banner | the feed route | component tests; phone readings on both bench phones |
| **WP-7** (BUILT, [above](#wp-7---suggested-posts-built)) | Suggested posts (decision 8), through the feed's own block filter (`PostsService.blockedAuthorSql`) as every feed row | the feed query | integration spec: a suggested post is visible by the space rule to the viewer, never through a grant or a follower door, and never by an author blocked either way |
| **WP-8** (BUILT, [above](#wp-8---the-daily-cap-built)) | The daily cap (decisions 6 and 11, amended 2026-11-10): `engagement_push_days`, `CAPPED_PUSH_TYPES` holding ONLY the kinds about an account the reader does not follow (`campus_trend`), the statement in `fanOutPush` | `posts/post-notifications.service.ts` | [R2](#r2---the-cap-check) read and written back; integration spec: the 6th capped push of a day is a bell row with no push, two concurrent fan-outs never exceed 5, and an association post, a live, an opening and a mention on the same day are never counted |
| **WP-9** (BUILT, [above](#wp-9---friends-activity-built-retired-2026-11-10)) | Friends' activity (5b) with the ledger `post_engagement_notices` and the activity setting (decision 9: `user_activity_settings`, no row = ON, the Settings switch) | `posts/comment-write.ts`, the reaction write | integration spec, one case per rule of the disclosure list, rule 0 included, and for rule 8 one case EACH: an `anonymous` comment, a comment written as an association, and a `removedByModeration` comment, none of which notifies |
| **WP-10** (BUILT, [above](#wp-10---campus-trends-built)) | Campus trends (5c) | the reaction write | [R1](#r1---the-trend-threshold) read FIRST and written back; integration spec: exactly one stamp at the crossing write, none after 24 hours, the space-only audience |

### WP-2 - Suivre everywhere (BUILT)

**QUIET BY RULE (owner, 2026-11-10, after reading 1.6.9: "Suivre agresse trop").** One component,
`components/follows/FollowChip.svelte`, in two variants and never solid yellow (solid yellow is the
primary action of a screen). `link` (default): a bare accent TEXT, no fill, no icon, on a meta line -
the post header (`PostHeader`: `19 h . Suggestion . Suivre`; the association of an association post,
the author of a personal post, nothing on an anonymous one - a revealed author included - and nothing
in the moderation preview, `showFollow={false}`), the directory rows (on the line under the name, the
row being a stretched link) and `AssociationTile` (`7 membres . Suivre`, matching `18 membres . Membre`).
`soft`: a neutral light-grey secondary button with no icon, for the "Suggestions pour vous" cards only.
A tap follows at once and the control GOES AWAY (a request already sent draws nothing; it is withdrawn
from the profile or the sent-requests list), with a NAMED toast worded from the status the SERVER
returned, by `FollowChip` (never `followState`, so `FollowBackButton` does not toast): "Demande de suivi
envoyee a {name}" for a request (every personal account is private), "Vous suivez {name}" for a follow.
The `soft` look is `ui/Button`'s own variant (`cn-surface-alt`). The link is outside the meta line's
dimming (each muted item carries its own `opacity-80`) with a 44 px hit area. It
is NEVER drawn for yourself, a blocked account, a person already
followed or requested, an association already followed, an ARCHIVED association, or one
the reader is a MEMBER of (lead decision), and it draws nothing while its answer is unknown.
A post header does not know whether its association is archived (the feed payloads do not carry it), so an archived association's post still shows the chip - accepted for now.

**The server half, two small routes (both under `/api/posts`, `FollowRequestsController`).**

- `POST me/follow-statuses` takes `{ userIds }`, at most 100 (400 `FOLLOW_STATUS_BATCH_TOO_LARGE`; a
  body that is not a list of non-empty strings, 400 `FOLLOW_STATUS_BATCH_INVALID`), runs ONE
  `= ANY($2)` query on the CALLER's own `user_follows` rows and answers `{ statuses: { id: 'pending' |
  'accepted' } }`, an absent id meaning none. It says what `follow-status` says per id and no more: the
  review cohort's boundary reads as none, a block already reads as none (it severs both follows), and
  nothing about the OTHER side is visible. Blocks are NOT in the answer on purpose ("they blocked
  you" is knowledge no single route gives); the chip reads the caller's own blocks once.
- `DELETE users/:userId/follow-request` WITHDRAWS: `DELETE ... WHERE status = 'pending'`. An
  accepted row is never touched - 409 `FOLLOW_REQUEST_ANSWERED` - and no row (the person refused,
  or already withdrawn) is 404 `FOLLOW_REQUEST_NOT_FOUND`. The old `DELETE users/:userId/follow`
  stays for unfollowing and for old clients; every WP-2 surface withdraws through the new route, so a
  tap on "Demande envoyee" that raced an acceptance is never a silent unfollow.

**The ledger** (`follows/followState.svelte.ts`) is the ONE source of truth in the session, and every
writer goes through it: the chips, the profile page (`askPerson`, `withdrawPerson`, `leavePerson`,
and what its status read found), the association page (`followAssociationLedgered`,
`unfollowAssociationLedgered`, and what its status read found) and the sent-requests list
(`withdrawPerson`). The `ProfileFollowersSection` followers list removes a FOLLOWER, which is not a
follow of the reader's, so it writes nothing.

- **Reads are batched, not per author**: the ids asked in the same tick leave in ONE call through a
  microtask (no timer), chunked at the cap, deduplicated, cached per session. Followed associations
  and memberships are one read each, shared by every card.
- **A failed read is asked ONCE per epoch.** The ids it failed for are recorded and never asked again
  until a real event: the connection coming back (`connectivity.onReconnect`) or the next navigation
  (`beforeNavigate` in the chip - an online 5xx is what no reconnect heals), each of which retries
  exactly the failures once; a block or unblock on this device (`onBlocksChanged` - a block severs follows,
  so everything read is void), or another account. (The first version kept the asked ids in a
  reactive set read by the chip's effect: a failure re-ran every effect, a new request each
  microtask, forever.) The ledger's sets are plain on purpose, and a failed read is a `console.warn`
  carrying the status, not a debug line.
- **An epoch ends every read of a previous reader.** The ledger is a per-reader cache
  (`registerPerReaderCache(resetFollowState)`, run on sign-out and account switch); a read, an
  association read or a blocks read that left for account A compares the epoch when it lands and is
  dropped after the switch to B. A chip still on screen reads the reactive epoch and asks again.
- **Writes are epoch-guarded and win over older reads.** Every writer (the chip taps, `askPerson`,
  `withdrawPerson`, `leavePerson`, the association pair, and the pages' own status reads) captures
  the epoch before its await and writes - or rolls back - nothing if it moved, so a tap on account
  A answered after the switch to B leaves B's ledger alone. A read that left before an association
  write never overwrites it (a per-id write marker in the epoch, as for persons). A page's status
  read teaches the ledger ONLY from a real answer (`readAssociationFollowed`): a failed read is a
  warning, never "not followed".
- **Membership unknown is hidden.** `ensureMyAssociations` turns a failure into `[]` (and caches it
  for the session: fail-closed for the BDE flags, which is right for them); the ledger asks
  `didMyAssociationsProbeFail()` and offers nothing on any association when membership is unknown.
- **A tap** flips the state at once, is guarded by a per-id in-flight set (a second tap does nothing),
  and puts the state back with a toast on a refusal (the profile's sentences); `tapPerson`
  answers the server's status (`tapAssociation` a boolean), which the chip words and hands to
  `onFollowed`; a card stays drawn while its tap is out (`isTapSettling`) and leaves only on success,
  so a refusal never makes it vanish and come back. A withdraw
  (`withdrawPerson`, from the profile) that raced the other side ends in what the server says now - a
  follow (409) or none (404) - with no toast and no stuck state. An association follows at once and
  the chip goes away.

Proof: `follow-requests.integration.spec.ts` on PostgreSQL (statuses; one statement; caller side
only; a stranger's private account; blocks both ways; agreement with `follow-status`; the withdraw
route: pending removed with its bell row, accepted refused and kept, refused/absent is a 404, another
asker untouched), `follow-requests.controller.spec.ts` (cap, typed 400s), and the chip specs (N chips
= 1 request, chunking, session cache, block refetch, a rejected read asked once and again on a
reconnect, an account switch mid-flight, the withdraw races, double taps, member and archived
hidden, the aria-label of a pending request naming the person and containing the visible text, with
a nameless fallback).

**"Suivre en retour" (owner's request, 2026-11-09).** On `/notifications/follow-requests`, an accepted
request keeps its row and the Accepter/Refuser pair becomes `FollowBackButton`, which reuses this
ledger (`personChipState`, `tapPerson`: a REQUEST, every personal account being private). Its states
are `followBackView` (`followButton.ts`): offered when the reader has no row; "Demande envoyee" (a tap
withdraws) or "Abonne" only once the offer was drawn; nothing for a pair already pending or following
on arrival, a blocked account, or the reader. No server change. The notification rows add nothing:
`follow_request` leads to this inbox, and `follow_accepted` means the reader already follows.

### Which migrations are held

The [held-migration rule](cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01) holds a
file that is not plainly additive, and its author marks a BACKFILL with `-- canari:hold-for-owner`
(the judge matches no `UPDATE` or `INSERT ... SELECT` on its own). So a package that creates a table
AND copies rows into it ships TWO files: the `CREATE TABLE` (plain) and the copy (held).

| Migration | Package | Held? | Why |
| --- | --- | --- | --- |
| `associations."lastLiveAnnouncedAt"` | WP-1b | no | `ADD COLUMN`, no backfill |
| `account_bells` | WP-3 | no | `CREATE TABLE` |
| copy of `association_push_mutes` into `account_bells` | WP-3 | **yes**, marked | a backfill (`INSERT ... SELECT`) |
| `opening_reminders` (151) | WP-4 | no | `CREATE TABLE`, `CREATE INDEX` |
| copy of `form_reminders` into `opening_reminders`, and its mirror trigger (152) | WP-4 | **yes**, marked | a backfill (`INSERT ... SELECT`); the trigger body holds a `DELETE FROM` |
| `follow_suggestion_dismissals` | WP-5 | no | `CREATE TABLE`, `CREATE INDEX` |
| `engagement_push_days` | WP-8 | no | `CREATE TABLE` |
| `user_activity_settings`, `post_engagement_notices` | WP-9 | no | `CREATE TABLE` |
| `posts."trendAnnouncedAt"` | WP-10 | no | `ADD COLUMN`, no backfill |
| `posts."trendEngagedSeen"`, `post_engagement_notices."trendDay"` and its partial unique index (161) | WP-10 reshape, 2026-11-10 | no | `ADD COLUMN` (NULL for existing rows), `SET DEFAULT`, `CREATE UNIQUE INDEX` on a column every existing row has NULL in |
| `campus_trend_weeks` (163) | the quieter batch, 2026-11-10 | no | `CREATE TABLE` |
| drop of `association_push_mutes` | after WP-3 has served one stable and the floor passed it | **yes** (a `DROP`) | destructive |
| drop of `form_reminders` | after WP-4 has served one stable | **yes** (a `DROP`) | destructive; it must also `DROP FUNCTION canari_form_reminder_to_opening()` and unmap `FormReminder` |

**Approval.** Each held file is approved by the owner or by the lead under the 2026-11-03 delegation
([the conditions](backlog.d/owner-decisions-of-2026-11-03-evening.md)). **A held migration on `main`
blocks EVERY release - pre-release and stable - until it is approved or reverted** (gate 6,
[cicd](cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)), and `apply_migrations` refuses
an unapproved held file on dev exactly as on production. So the file CANNOT run on dev before its
approval, and the real order for the WP-3 and WP-4 copies is:

1. The package's pull request is reviewed adversarially (the file's SQL included) and its integration
   spec runs the copy against a real PostgreSQL - the only run before approval.
2. It is merged only when its approval line can follow AT ONCE; from that merge every release is
   refused until step 3.
3. The approval line (`<path> <sha256>` in `infrastructure/migration-approvals.txt`) is merged by
   hand, by the owner or the lead, and reported on the private tracking page.
4. Then a NEW pre-release tag: the deploy takes the backup right before the file and runs it on dev,
   and the package's phone reading is taken on that pre-release.
5. The stable follows as for any package (decision 13).

A copy whose approval cannot follow at once is not merged; one merged and then found wrong is
reverted rather than left blocking the release train for every other package.
