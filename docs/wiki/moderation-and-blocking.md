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
`/api/moderation/*` and by the post controls that give the same people the same reach.

---

## Blocking

### What a block does, exhaustively

- The two accounts stop finding each other in **target pickers**: `GET /api/users/search`, which
  feeds the New chat modal, the salon invitation field and the mention autocomplete.
- Neither can open a **1-to-1** with the other.
- Neither can **add the other to a group**.
- Neither can **invite the other into a private salon** - inside a shared community included.
- The two **follows** are severed, in both directions.

### What a block does not do

Existing conversations, existing groups, community membership and post visibility are all untouched.
The directory (`GET /api/users/directory`) still lists both - it is a browsing view with promo and
cursus filters, not a target picker, and punching a hole in it would make a block visible in a
screen that has nothing to do with it. Invitation **links** are out of scope: a block stops somebody
from pushing you somewhere, not from you walking in.

The blocked person is never notified. No administrator sees anything.

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
So the refusals sit at the mutations:

| Refusal | Service | Answer |
| --- | --- | --- |
| `POST /mls/groups/:groupId/members` | chat-delivery | `403 { code: 'USER_BLOCKED' }` |
| `POST /api/channels/:channelId/members/invite` | social-service | `403 { code: 'USER_BLOCKED' }` |

`addGroupMember` is the choke point for **both** paths a block closes. Without a `GroupMember` row
the target's devices never receive a pending membership, so no Welcome is ever built for them. It is
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
