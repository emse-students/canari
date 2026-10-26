# Reporting and blocking

Two mechanisms that look adjacent and are deliberately kept apart.

A **report** asks a moderator to look at something. It is a public act inside the platform: it
creates a row a third party reads and acts on.

A **block** is between two people and reaches nobody else. It is not a moderation signal, it is not
counted anywhere, and no administrator sees it - by the user's decision of 2026-08-27, because these
are conflicts, break-ups and fallings-out, and a dashboard tallying them would turn a private
gesture into a record somebody else reads. Someone who wants a moderator involved files a report,
which is a separate and deliberate act. The profile page offers both, as two distinct controls.

---

## Reporting

### One store, and how it came to be one

`content_reports` (social-service) is the only report store. It is written by
`POST /api/moderation/reports`, read by `/admin/moderation`, and it is what the auto-hide threshold
counts.

There was a second one until 2026-08-27: a `reports` JSONB column on `posts`, written by
`POST /api/posts/:postId/report` and read by `GET /api/posts/reported`. **Neither end had a
caller** - the client wrappers `reportPost` and `getReportedPosts` existed and nothing invoked
them - so no report a user ever filed went there. Production held 112 posts, 0 with a report in that
column and 0 hidden. Both routes, both wrappers and the column are gone (migration
`055_drop_post_reports_column.sql`).

The backlog entry that opened this (WP-REPORTS-1) said the auto-hide counted the JSONB store. It did
not: `hiddenByModeration` is set in `ModerationService.createReport`, off `content_reports`. **There
was never an arbitration between two live stores - one of them had simply never run**, and the entry
describing it as a live rival is what made it look like a design decision rather than a deletion.

### What can be reported

| `contentType` | `contentId` | Preview a moderator sees |
| --- | --- | --- |
| `post` | post id | first 250 characters of the markdown |
| `comment` | comment id | the comment text, plus `postId` for navigation |
| `user` | the reported account's id | the account's display name |
| `live` | a live's id | the broadcaster's display name, plus `live: { state, ..., broadcasterStanding }` - open, ended, cut or gone ([lives](services/lives.md#moderation-wp-l8-server-half)) |
| `live_chat` | a live chat MESSAGE's id (with `liveId` and the plaintext `message`) | the kept line's text, plus `liveChat: { text, authorName, keptUntil, integrity, ... }` ([lives](services/lives.md#a-reported-chat-line-wp-l8b)) |

`live` arrived with WP-L8 (2026-10-19, decision D6: a live is moderated like a post). Its `reportedUserId` is
the broadcaster read from the live row, never the client's; the live must still have a row and be
visible to the reporter (the rule of a post, no block), else `404 LIVE_NOT_FOUND`. Where a post's
answer is "delete the post", a live's is **"cut the live"**: `POST /api/lives/:id/cut`, the same
`isContentModerator` predicate, which ends the live for everyone, records the cut (`live_cuts`: who,
when, which reason code) and marks the live's pending reports `reviewed`. A live is never
auto-hidden by a count. **A strike ladder reads the cuts** (WP-L8b, 2026-10-21): a warning, then a
30-day suspension of BROADCASTING (posts untouched - the account mute stays the one posting
sanction), then a withdrawal staff decide ([lives](services/lives.md#the-strike-ladder-wp-l8b)).

`live_chat` arrived with WP-L8b (2026-10-21): the one case where a report CARRIES content. A live
chat line is sealed with the live key, which the server holds while the live runs, so unlike an MLS
message it CAN check what the reporter hands over: the server opens the line, compares it to
`message`, keeps the checked text signed until the report is handled (90 days at most), and never
keeps the key. Every refusal that would tell a line exists is `404 LIVE_NOT_FOUND`
([lives](services/lives.md#a-reported-chat-line-wp-l8b)).

`user` arrived with blocking, as its counterpart: blocking is silent, reporting is how a person asks
for help. A `message` case was declared in the DTO, the entity and the client type and produced by
nobody; it could not have worked, because message bodies are MLS ciphertext and the server has
nothing to show - `contentPreview` was hard-coded null for it. It was removed rather than
implemented. Reporting a message would mean the client attaching the decrypted excerpt, which is a
privacy decision about what a reporter discloses, not a missing endpoint.

### One reason list, everywhere

`spam` / `harassment` / `inappropriate` / `other`, from `frontend/src/lib/moderation/reasons.ts`,
offered by `ReportReasonDialog` for a comment and for a person, and by the post card's own control
for a post. It used to be three different questions - a post asked for a reason, a comment sent
`inappropriate` with nothing asked, a person could not be reported at all - and **a moderator
comparing rows can only do so when the same question produced them.**

### One report per person per thing

The duplicate check ignores `status`. It was scoped to `pending` until 2026-08-27, which meant a
dismissal re-opened the door and one person could file the same accusation indefinitely. **A
dismissal is an answer, not an invitation to try again.**

The refusal is `409` with `{ code: 'ALREADY_REPORTED' }`. The client reads the code; it read
`message.includes('already')` until 2026-08-27, which is a distinction carried in prose - see
[durable-rules](durable-rules.md).

### Auto-hide

Five pending reports on a post set `hiddenByModeration`, which drops it from every feed until a
moderator restores or deletes it. The threshold has never fired on production. It is unchanged, and
it counts `content_reports` - the only store there is.

### Retention: one policy, one place

Handled reports (`reviewed` / `dismissed`) are deleted **90 days after they were handled**, by the
weekly cron `purgeResolvedContentReports` (Sunday 04:30, `forms-reminder.scheduler.ts`). Pending
reports are kept indefinitely.

There were **three** statements of this, and they disagreed:

- a lazy 7-day purge fired from `ModerationService.listAllReports`, so a moderator opening the page
  deleted rows as a side effect of reading;
- this cron, at one year - **dead**, because the lazy purge always emptied its population first;
- `internal.controller`'s docblock, claiming the rows were kept for legal obligation.

The lazy purge is gone, the cron is the only mechanism, and its clock is `reviewedAt` rather than
`createdAt` - keying it on filing would purge an old report the day after it was finally handled.
**A mechanism can be correct and still be dead if something upstream empties its population first.**

### Who may read the queue

`isContentModerator`: a platform admin, or a BDE member holding `MODERATE`. One predicate, shared by
`/api/moderation/*` and by the post controls that give the same people the same reach - and, since
WP-L8, by the staff cut of a live.

### Anonymous posts - the fourth control that predicate now gates

A personal post (never an association one - the two are mutually exclusive, and an association
post already anonymizes its author for everyone unconditionally) can be marked `anonymous` at
creation - one option in the same "who is publishing" identity picker as the personal profile and
each managed association, open to every user rather than gated to association admins.
`PostsService.mustHideAnonymousAuthor` strips `authorId` from the response for every viewer
**except** the same `isContentModerator` tier, or the post's own author (2026-09-17: a moderator
must be able to tell WHO published an anonymous post, and so must the author looking at their own
post - not just THAT it exists). `canUnmaskAnonymous` (same shape as `canPin`) is drawn from the
moderator tier only, never from self-authorship. `PATCH /posts/:postId/unmask` (`PostsController`,
guarded by the same `assertContentModerator` pin/hide already use) clears the flag,
one-directional: an author who did not choose anonymity at creation has no route back into it
later, and the flag is otherwise immutable on edit - like `associationId` already is.

On the client, an anonymous post is named "Anonyme" with the mask for EVERY reader, and what
`authorId` decides is one more line. Absent (a regular reader): "Anonyme", nothing more. Present
(moderator, admin, or self): "Anonyme" stays the name, big, and the real author follows SMALL under
it, linking the profile (`RevealedAuthorLine`; user, 2026-10-24 - it replaced the 2026-09-17 shape,
the real name and photo with an "Anonyme" badge beside the time). The same holds for an anonymous
COMMENT: `serveComment` sends its `userId` to the writer, a content moderator and a platform admin
only, the comment stores no name, so the client resolves the name from that id
(`commentRevealedAuthorId`). The client never decides who may see an author; it draws what the
server sent ([posts](frontend/modules/posts.md#who-wrote-it-anonyme-big-the-real-author-small-2026-10-24)).

**`mustHideAnonymousAuthor` was never wrong; the two feed queries never asked it the real
question (2026-09-18, reported by a user who posted "test" anonymously and read their own name
off a second account's feed).** `listPosts`'s shared `selectBody` and `searchPosts`'s own copy
both named `posts."authorId"` but never `posts.anonymous`, so every raw row arrived with
`anonymous: undefined` and the predicate's first line, `if (!post.anonymous) return false`, read
that as "not anonymous" for every post, moderator tier or not. `getById` (single-post view) loads
the full TypeORM entity and was never affected - only the two feed-producing paths anyone actually
browses. Fixed by adding the column to both queries;
`posts.service.anonymous-list.spec.ts` asserts on the SQL text itself, because a unit test
building its own `{ anonymous: true }` fixture and calling `shapeListRow` directly would have
passed every day this shipped.

**A NOTIFICATION HAS NO READ-TIME MASK AT ALL, SO THE SAME BUG'S SECOND HALF LIVED AT WRITE
TIME (2026-09-18, same user).** `PostNotification.actorName` is denormalized onto the row when it
is created (its own docblock says so) and `getNotifications` returns the stored rows verbatim -
there is no per-viewer shaping step for a notification the way `shapeListRow` gives a post one.
Two write paths never checked `anonymous` before resolving and storing the real identity:

- **A mention.** `createPost` resolved `actorName` and wrote `actorId` unconditionally for every
  `@mentioned` recipient. Fixed by masking both to `ANONYMOUS_NOTIFICATION_ACTOR_ID` (an empty
  string - what `Avatar.svelte` already reads as "no user to look up", so the client needed no
  change) and `ANONYMOUS_NOTIFICATION_ACTOR_NAME` (`'Anonyme'`) before calling
  `createNotification`, exported from `post-notifications.service.ts` so both call sites share
  one pair of constants. A mention's recipient is not a leak the way the second path is - see
  below - so masking the actor is the whole fix here.
- **"Someone you follow published" (`PostAnnounceScheduler.announcePersonalPost`).** THIS ONE IS
  NOT MASKED, IT IS SKIPPED ENTIRELY, and the difference matters: `announcePersonalPost` exists
  only because its recipient follows a small, known set of people, so even a perfectly masked
  "someone you follow just posted anonymously" notification still narrows the author down to that
  set - the leak is the recipient's membership in `user_follows`, not the name on the row, and no
  amount of masking removes it. `listPosts`'s `feed: 'followed'` branch has the identical shape
  for the identical reason: appearing in that feed at all already says "authored by someone you
  follow", so its `WHERE` clause now excludes `posts.anonymous` from the authored-by-a-followed-
  user arm rather than relying on `shapeListRow` to hide the name once the row is already there.

---

## Blocking

### What a block does, exhaustively

- The two accounts stop finding each other in **target pickers**: `GET /api/users/search`, which
  feeds the New chat modal, the salon invitation field and the mention autocomplete.
- Neither can open a **1-to-1** with the other.
- Neither can **add the other to a group**.
- Neither can **invite the other into a private salon** - inside a shared community included.
- The two **follows** are severed, in both directions.
- Neither can **call** the other, in an existing conversation included: a call is a new ring, not
  the existing conversation (`initiate`, `ring` and `room-token` answer `403 USER_BLOCKED`,
  [calls](frontend/modules/calls.md#the-switches-agree-and-a-silent-frame-stays-unread)).
- Neither sees, watches, reports nor is notified of the other's **live** (the list, the key and the
  manifest answer `404`, the push skips them; [lives](services/lives.md#who-may-watch-the-rule-of-a-post)).
- Neither is shown the other's **personal posts**, nor their **comments** under anybody's post -
  in the feed, in search, by id, and under an agenda event. **An association post and an anonymous
  post are exempt**, and the section below is why.

### What a block does not do

Existing conversations, existing groups and community membership are untouched.
The directory (`GET /api/users/directory`) still lists both - it is a browsing view with promo and
cursus filters, not a target picker, and punching a hole in it would make a block visible in a
screen that has nothing to do with it. Invitation **links** are out of scope: a block stops somebody
from pushing you somewhere, not from you walking in.

**Presence is not hidden by a block** (WP-PRESENCE, 2026-10-18). Its audience is "shares a live
conversation or a community with you" ([chat-gateway](services/chat-gateway.md#who-may-see-whose-presence-wp-presence-2026-10-18)),
and a block ends neither, for the reason in the first paragraph above. So a blocked person who still
shares a conversation or a community with you still sees your dot, and you theirs. The audience
check reads only membership tables and never `user_blocks`: honouring a block there would mean the
gateway asking a third service, and would make the block observable from the dot going dark.

The blocked person is never notified. No administrator sees anything. They can, since posts started
being hidden, NOTICE that one reader stopped seeing them - that is what a symmetric hide costs, and
it was taken knowingly (2026-09-25): "not notified" is about the platform telling them, and the
alternative was a block that does not do the one thing people expect of it.

### Hiding a post must not become a way to ASK WHO WROTE IT

`PostsService.blockedAuthorSql` filters on `authorId`, so it covers **only a post whose author the
viewer could already read**. An association post hides its publisher from everyone unconditionally,
an anonymous one from everyone but a moderator - and filtering either on authorship would answer
exactly the question those masks exist to refuse:

> block a suspect, watch whether the anonymous post leaves your feed, unblock.

Nobody is notified of a block, no administrator sees one, and lifting it costs a click, so that
probe is free, silent and repeatable - a dichotomy over the 200-row cap names the author of any
anonymous post in a handful of rounds. The exemption is the feature, not a gap in it. `listPosts`'s
`followed` arm already excludes anonymous posts for the neighbouring reason: **presence in a feed is
itself an answer about authorship**, which is also why that arm EXCLUDES rather than masks.

An ordinary comment carries its author's name, so it is filtered on its author. **Since 2026-10-21 a
comment can be anonymous or written as an association, and those two are EXEMPT for the reason a post
is** - filtering one on `userId` would make a block a probe of who wrote it. The SQL (`postSelectBody`,
window and count), `getById` and `pageComments` all apply it. The identity rules themselves are in
[posts](frontend/modules/posts.md#comment-sheet-rework-2026-10-21).

### Where the hide is applied, and why not in JS

| Path | What it does |
| --- | --- |
| `listPosts` (4 feed arms) | the clause in the `WHERE`, never on the page after `LIMIT` - filtering a rendered page would hand back short pages |
| `searchPosts` | same clause |
| `getById` | `404`, not `403` - the refusal never says a block caused it. **A platform admin passes** (`allowHidden`, the flag that already opens a moderation-hidden post), so a reported post never 404s for the moderator who has to read it |
| `findPostLinkedToCalendarEvent` | same card, same clause |

The **comment window and the comment count are both filtered in SQL**, in `postSelectBody`. They
answer two different questions - the window is the last 20 rows, the count is the TOTAL - so a JS
filter could only correct the window and would leave the count promising comments the viewer is
never going to be shown. The `associations` feed gets the comment half only: every row there is an
association post, which the author clause exempts by construction.

Replies to a hidden comment are not re-parented. A reply whose parent is absent renders nowhere,
which is already what the 20-row window does to an older thread - one behaviour, not two.

### The cache, which is the part that made it look broken

The feed is cached per reader for 30 s, so nothing about a block reached the feed until the TTL ran
out: block somebody, open the feed, their posts are still there. Core-service now calls
`POST internal/posts/list-cache/invalidate` on block **and on unblock** - the second is why it is
its own route rather than a line inside `severFollowsBetween`, which does not run when a block is
lifted. Best-effort and logged, like the follow severing beside it: the block is already durable,
and a stale page for the rest of one TTL is the whole cost of a failure.

### Found while wiring it: search served what every feed refused

`searchPosts` carried **none** of the feed's exclusions - not the moderation hide, not the
store-review service account. A post auto-hidden by the report threshold, which `listPosts` drops
from every feed, was reachable by anyone who typed a word of it. A search result renders the same
card as a feed row, so it owes the same exclusions; `hiddenFilterSql` and `serviceAccountFilterSql`
are now one implementation each, shared by both. The promo cutoff is still absent from search - it
is a relevance limit rather than a confidentiality one (`promo-visibility.ts`), and it is left
alone deliberately.

### Symmetric by construction

The row records who blocked whom, because only the blocker may lift it. **Every consumer reads it
symmetrically**, asking whether a row exists between two accounts in either direction:

- hiding only the blocked party would leave them able to keep finding the blocker;
- hiding only the blocker would let the blocker re-open a conversation they closed, which turns
  "block" into a one-way channel rather than a closed door.

### Where it lives, and where it is enforced

`user_blocks` is owned by **core-service** (migration `007_user_blocks.sql`), which serves the three
routes that manage it. It is **read directly out of `auth_db`** by the two services that must refuse
a mutation - the same way this repo already reads `users` from social-service a dozen times over. An
internal HTTP hop on the critical path of every group creation would buy a boundary and cost a round
trip.

**Hiding somebody from a search enforces nothing** - a known uuid is enough to open a conversation.
The read-time hide above is no different, and is not trying to be: it does not enforce anything, it
stops putting a person in front of somebody who asked not to see them. Enforcement sits at the
mutations:

| Refusal | Service | Answer |
| --- | --- | --- |
| `POST /mls/groups/:groupId/members` | chat-delivery | `403 { code: 'USER_BLOCKED' }` |
| `POST /api/channels/:channelId/members/invite` | social-service | `403 { code: 'USER_BLOCKED' }` |
| `POST /api/calls/initiate`, `POST /api/calls/ring`, `GET /api/calls/room-token` | chat-delivery | `403 { code: 'USER_BLOCKED' }` |

`addGroupMember` is the choke point for **both** paths a block closes. Without a `GroupMember` row
the target's devices never receive a pending membership, so no Welcome is ever built for them. Since
ADM-3 (2026-10-25) the roster row of a new person is written by the accepted commit alone
(`enrolAdmittedPeople`), which refuses a person a block stands between and the committer
(`NOT_ENROLLED reason=blocked`); the route keeps its block check and answers it first. It is
scoped to adding a **new** member: an existing member's later devices enter through `registerDevice`,
which fans that user's existing groups out on its own and never comes through here - so healing a
shared group keeps working across a block, which is the intent.

The message is neutral in both cases: it says the person cannot be added, never who blocked whom.
The `code` is what a client branches on.

### Asked before, not discovered after

`GET /api/users/:otherUserId/block-status` answers `{ blocked }` for the caller and one other
account. Both creation paths call it (`startNewConversation`, `processBulkAddition` in
`frontend/src/lib/utils/chat/groupCreation.ts`) **before** any MLS work.

The server refusals above are authoritative, but reaching one means the group has already been
minted and the Welcomes already delivered - a conversation half built on both sides. **Never learn by
failing what a fact could have told you.** A failure to *ask* is not an answer either: the 1-to-1
path stops and says so rather than proceeding as though nobody had blocked anybody. On a group
invitation naming several people, only the unreachable ones are dropped - one block must not cancel
an invitation naming four others.

`registerMember` keeps its historical tolerance for every other non-2xx, but no longer in silence:
`f` resolves rather than throwing on a bad status, so an HTTP failure was swallowed there without so
much as a line.

### API

| Method | Route | Answers |
| --- | --- | --- |
| GET | `/api/users/me/blocks` | the people the caller blocked, with display names |
| POST | `/api/users/me/blocks` | `{ userId }` - idempotent |
| DELETE | `/api/users/me/blocks/:blockedId` | lifts it; only the blocker can |
| GET | `/api/users/:otherUserId/block-status` | `{ blocked }`, symmetric |

The list carries display names because **a blocked person is hidden from search**: without them the
unblock screen would be a column of uuids nobody can act on, and there would be no way to reach the
profile that offers the control.

Cap: 200 blocks per account. Not a product rule - it bounds the table and, more to the point, the
`NOT IN` list handed to every user search.

### Surfaces

| Where | What |
| --- | --- |
| `/profile/[id]` | **Signaler** and **Bloquer** / **Débloquer**, two separate controls |
| `/settings` | **Personnes bloquées** - the list, and the only place a block is lifted |

### Account deletion

`deleteUser` (core-service) sweeps `user_blocks` in both directions before deleting the user row - a
block row naming a deleted account would keep hiding a live person from the search of somebody who
no longer exists. Reports **about** that account as a person are deleted by social-service's
`internal/users/:userId` handler: their subject is gone. Reports about their *content* are left
alone and anonymised on the reporter side, like every other one.
