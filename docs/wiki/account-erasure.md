# Account erasure - complete and guaranteed

> Decision of the owner, 2026-10-16: **deleting an account is COMPLETE and GUARANTEED, not best
> effort.** This page is the only description of the mechanism; the services' pages point here.

## What was wrong

`UsersService.deleteUser` called chat-delivery, social and media once each with `.catch(warn)`,
then deleted the `users` row whatever happened. A service that was down at that moment orphaned the
account's data in it for ever: nothing remembered the erasure was owed, and nothing retried it.

And each service's delete set was a hand-written list nobody compared with the schema. A GDPR review
found what it missed:

- **social**: comments, likes, reactions and poll votes left on OTHER people's posts (inside the
  `posts.comments` / `reactions` / `polls` JSONB, out of reach of any column statement); form
  submissions (`userId`, `email`, `answers`), `form_respondents`, `form_reminders`,
  `post_notifications`, the three minesweeper tables, `document_reviewer_grants`,
  `webhook_deliveries.userId`, `product_checkouts.userId` (per row, `'[deleted]:' || id`, because
  of its partial unique index), `legacy_cotisations.claimedByUserId`, and about twenty authorship
  columns (`createdBy`, `grantedBy`, `decidedBy`, ...);
- **chat-delivery**: `device_signature_key`, `notification_preference`, `dm_user_dismissed_groups`,
  and the queued messages the account SENT;
- **core**: `profile_changes` and `profile_correction_requests` were kept on purpose, with whole
  before/after profiles in them. The decision was that **erasure wins: nothing nominative stays**.

Three of the downstream deletes were also not safe to RETRY, which a queue needs: media marked an
object purged even when its delete failed, social deleted every community membership before repairing
the communities and swallowed a failed repair, and chat-delivery read the device list it cleaned
Redis with from rows its own first run had deleted.

## The mechanism

```
DELETE /api/users/me
  -> ONE transaction in core (AccountErasureService.requestErasure)
       core's own data about the account      (CORE_ERASURE_STATEMENTS)
       one job per service                    (account_erasure_jobs, migration 012)
       DELETE FROM users                      (nothing nominative left in `users`)
  -> 204, and an immediate drain

worker (every 60 s, and at once after a request)
  claim due jobs: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING
  DELETE <service>/internal/users/:id
     2xx, call started AFTER every token expired  -> completedAt, subjectId := sha256 digest
     2xx, call started before                     -> one final pass at credentialsExpireAt
     anything else                                -> attempts+1, retry in 30 s x 2^n (cap 6 h)

daily report (and 5 min after boot)
  one summary line; one ERROR line per job pending > 24 h, with its service, attempts, last failure
```

**Deactivated at once.** The transaction deletes the user row and every `auth_sessions` row, so no
refresh can succeed. A sign-in is REFUSED while a job is pending (`ACCOUNT_ERASURE_PENDING`, a 403
the client renders through Paraglide), because `users.id` IS the OIDC subject: signing in again would
recreate the account under the same id, and the erasure's next pass would delete what the new account
wrote. Once every job completed, the person may come back and gets a new, empty account.

**Why a final pass, and why it is not a timer.** An access token stays valid for
`ACCESS_TOKEN_TTL_SECONDS` (one hour, `auth/token-lifetimes.ts`, the ONE number both the token and
this page depend on) and nginx's `auth_request` does not consult the user row - so for up to an hour
a token issued before the deletion can still write (a post, a key package). A job is therefore
complete only when a successful call STARTED after `credentialsExpireAt` (deactivation + TTL + 60 s
of skew): from that moment no request can act as the account, so nothing can be written that the call
did not see. That is a termination proved by the token's own expiry. A first success earlier is real
and is followed by exactly one more call. An open WebSocket outlives its token, but the gateway only
relays ephemeral frames (typing, Welcome requests), and the account's routes are removed from every
group by the first pass.

**The journal keeps a digest only 30 days.** An unsalted SHA-256 of an identifier guessable from the
school's directory is still an identifier, so completed rows are DELETED after 30 days (backups
live 14, so a replay of the erasures they predate still has its digests), by the daily report.

**The journal.** `account_erasure_jobs` is queue and journal at once. A pending row carries the
OIDC subject (authentik's opaque `hashed_user_id`) because the call is made with it and the sign-in
refusal looks it up; a completed row carries `sha256:<digest>` and its timestamps only. No name, no
profile, at any point. One pending row per (subject, service) - a partial unique index - so a replayed
`DELETE /users/me` adds nothing, while a returning person who deletes a second account gets new rows.

**What would make it wrong is reported.** Every failed attempt is a `warn` naming the service, the
attempt count and the next attempt; a job owed for more than a day is an `error` in the daily report
(`[ERASURE] OVERDUE service=... attempts=... lastError=...`), which is either a service that has been
refusing all day or a defect - the line carries what tells them apart. A failure is recorded as a
status or an error code (`describeFailure`), never a URL, which would carry the id.

## Every downstream erasure is idempotent, and says so with its status

| Service | Route | 2xx means |
| --- | --- | --- |
| chat-delivery | `DELETE /api/internal/users/:id` | every row in `ACCOUNT_ERASURE_COVERAGE` (`src/utils/account-erasure-coverage.ts`) is gone or anonymised |
| social | `DELETE /api/internal/users/:id` | the account left every community (each repaired first), `ERASURE_STATEMENTS` ran in ONE transaction around the JSONB scrub (the proposal statements after it), the feed cache was dropped |
| media | `DELETE /api/media/internal/users/:id` | every object the account uploaded is deleted, except what `survivesAccountDeletion` names; **503 while any delete failed**, and a failed object keeps its live entry so the retry finds it |

### The coverage is asserted against the schema

`libs/contracts/account-reference-columns.json` defines, as data, which property names can hold an
account id (`user`, `author`, `actor`, `createdBy`, `email`, ...). In social-service and in
chat-delivery a spec reads every `*.entity.ts` (and, in social, the two tables that exist only as
migration SQL) and fails until every matching column has a disposition in that service's
`ACCOUNT_ERASURE_COVERAGE` - `delete`, `anonymise`, `code`, or `kept` with a reason - and, in social,
until every `delete`/`anonymise` is carried out by a statement that names its column. A table added
later cannot ship unclassified. `account-erasure.integration.spec.ts` (social and core, gated on
`SOCIAL_IT_DATABASE_URL` / `CORE_IT_DATABASE_URL` like the other integration specs) runs the real SQL
against a copy of an estate's schema and asserts that **no row of any table still contains the id**
(`row::text LIKE '%id%'`), that the other account is untouched, and that a second run changes
nothing. It caught two defects the unit specs could not: `association_role_history`'s column is
`user_id`, and PostgreSQL refuses a bind with more parameters than the statement names.

### The dispositions, and why

- **Deleted**: the account's own content and standing - posts, memberships, follows, mutes, tags,
  moderation state, reminders, respondent marks, form files (the row here, the blob in media),
  notifications to OR from it, minesweeper, reviewer grants, read grants, **its community salon
  messages (reactions and pins included; the salons are told a pin is gone) and the client-id
  tombstones its deleted ones left (`channel_message_client_tombstones`, migration 090: author,
  salon and a random id - an erased account repeats no send, so nothing needs them; a message
  delete racing the erasure locks the row first, so it waits and writes none; the fan-out outbox
  entry of a message (`channel_message_fanout`, migration 093) goes with its message by cascade, and
  its mentions of other accounts live only until the broadcast is handed off)**, its key packages, devices, PIN verifier, push tokens, signature keys,
  notification preferences, dismissal markers, DMs (tombstoned for the other party), queued
  messages to it and queued APPLICATION messages from it; in core, blocks, sessions, the profile
  trail and correction requests, announcement readership.
- **Its marks on other people's posts**: its comments are removed and a reply to one is RE-PARENTED
  to the nearest surviving ancestor (another person's reply is theirs); its likes and reactions are
  removed; a vote on a NAMED poll is removed (the tally drops by one); on an ANONYMOUS poll the tally
  is kept - nothing ever recorded which option was theirs - and the account leaves `voters`.
- **Kept on purpose: posts published AS an association** (user decision, 2026-10-16). They are the
  association's communication; only their `authorId` becomes `[deleted]`, and their media are
  re-classed `association` by social BEFORE media's part runs.
- **Anonymised to `[deleted]`** (NULL where the column allows and the meaning survives): rows that
  also belong to other people or are accounting records - purchase
  records, webhook deliveries, a submission (its seat and payment fields stay; `userId`, `email` and
  `answers` go), a form's owner, a consumed partnership code (NULL would hand the code to the next
  student, and a constant would collide on the partial unique index `(cardId, claimedByUserId)`:
  the replacement is `[deleted]:<row id>`), reports filed by or about it, and every authorship
  column (`createdBy`, `grantedBy`, `decidedBy`, `republishedBy`, ...). In core, an admin's edit of
  somebody else's profile keeps that person's history with `actorId = '[deleted]'`, and an
  announcement's author becomes the nil UUID.
- **Bookings** (`BOOKINGS_ERASURE_STATEMENTS`): a PERSONAL space it owns is deleted with everything
  under it, other people's coming bookings there included; its coming bookings are cancelled and
  coming participations withdrawn; its answers are purged; every id in the frozen history becomes
  `[deleted]`, and the NAME SNAPSHOTS are KEPT (decision D15), bounded by the one-year maximum age
  (D19) - [bookings-chantier](bookings-chantier.md#a-deleted-account-2026-10-16-review-of-1963).
- **Lives** (`LIVES_ERASURE_STATEMENTS`): a live it broadcast is ENDED (`erased`) and its broadcaster
  becomes `[deleted]` in one statement, and the live sweep deletes its segments and its row within
  30 seconds (no replay, L3); a removed-viewer row naming it, and its `live_starts` rows, are deleted - [lives](services/lives.md#a-deleted-account).
- **Associations, FIRST** (`ERASURE_ASSOCIATION_LOCK_SQL`, before any write): every association one of
  its writes reaches is locked `FOR NO KEY UPDATE`, in id order. An association delete locks its
  association first and the erasure used to reach it last, so they deadlocked (`40P01`) -
  [profiles-and-access](profiles-and-access.md#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built).
- **Proposals and republications, LAST** (`ERASURE_PROPOSAL_STATEMENTS`, after the scrub of other
  people's posts): an acceptance locks the post before the proposal, so an erasure that took a
  proposal before a post it had reacted to deadlocked against it. A pending request to an author it
  asked (D38b) is voided (`[voided]`; its bell row, whose actor is the asker, goes with the account's notifications), the rest anonymised -
  [profiles-and-access](profiles-and-access.md#d38b---a-personal-post-republished-with-its-authors-consent-decided-2026-10-19-as-built).
- **Legacy cotisations**: a row the account claimed is DELETED. The claim had already turned it into
  a `user_tags` row (deleted above); what was left is the name it was matched on.

## What is NOT covered, and why

- **Backups keep everything for their retention (14 days)**, then rotate out. An erasure cannot
  reach into a backup; restoring one REPLAYS the erasures the archive predates
  ([below](#a-restore-replays-the-erasures)). What no replay can reach: an erasure made after the
  last archive on a server lost WITH its database - its journal is gone with it. A server that is
  only being LEFT still has it: export it there and hand it over (`ERASURE_JOURNAL_FROM`).
- **A queued commit or Welcome keeps its `senderId`** in chat-delivery: it is the recipient's protocol
  state, read when it is delivered (push suppression, routing), and rewriting it was not shown safe.
  It leaves the queue when delivered.
- **media `association` documents and public assets survive** the uploader, by design
  (`survivesAccountDeletion`): a vault document and a logo belong to the association; their
  `ownerId` is rewritten to `[deleted]`, so nothing attributes them to the account. Blobs uploaded
  before 2026-08-11 carry no owner and cannot be attributed to anyone.
- **MLS ciphertext in multi-member groups stays**: on the other members' devices, which received it
  and are the only holders of a key, and on the server in the group's shared history stream
  (`history:{groupId}`, ciphertext the server cannot read, trimmed at 90 days / 8000 entries -
  `retention.constants.ts`), which the remaining members still catch up from. Picking one sender's
  entries out of it would need the sender's identity per entry, which the stream does not index. A
  commit or Welcome still queued is left to be delivered (deleting it would fork the group for its
  recipient). The account's MLS LEAF stays in each group's ratchet tree until a member commits a
  Remove - no server purge can change a tree.
- **Salon messages of OTHER members that quote the account** are their content; only the account's
  own messages are deleted (decision 2026-10-16: erasure beats continuity).
- **Another author's text that names the account is ANONYMISED, not kept.** A mention is the
  account's identifier whoever wrote the post: it is removed from `posts.mentions`, and the
  `@[<id>]` token becomes `@[deleted]` in `posts.markdown` and in other people's comment text
  (`scrubComments`; the candidate filter also matches the token). The frontend does not parse
  `@[deleted]` as a mention (it is not an id), so it shows as that literal text. A QUOTE of the
  account's words inside another author's free text is not found and stays. Poll question/option
  text is not scanned for tokens.
- **The MiConnect (authentik) identity is not deleted**: it is the school's identity provider, not
  Canari's data. Signing in after the erasure creates a new, empty Canari account.
- **Logs** keep the first eight characters of the subject on the erasure lines, for their retention.

## A restore replays the erasures

Restoring an archive brings back every account erased after it was taken, and the restored journal
predates those erasures, so nothing in the restored database remembers them. `restore.sh` therefore
reads the CURRENT journal first and hands it back once the restored database is live:

```
restore.sh
  core-service: bun dist/account-erasure/restore-replay.js export  -> GET  /api/internal/account-erasure/journal
  psql < postgres_auth_db.sql                                         (the archive replaces the database)
  core-service: bun dist/account-erasure/restore-replay.js replay  -> POST /api/internal/account-erasure/replay
```

**The export** (`exportJournal`) is one entry per completed subject (its digest) and one per pending
subject (named outright by its row), each with the LATEST time an erasure of it was requested. It is
written to a `0600` file beside the backups and deleted once the replay succeeded; an export that
fails stops the restore BEFORE anything is overwritten, because the file is then the only record of
those erasures. Three things guard that file:

- **the public entry (`frontend`) is stopped from the export to the end of the replay** - a
  `DELETE /users/me` in that window would land in the database being overwritten and in neither
  journal, while the person was told their account is gone;
- **an existing file REFUSES a new restore**: it is an unfinished replay, and a second export, read
  from the already-restored database, would overwrite it with a journal that no longer knows those
  erasures;
- **a migration hands the OLD server's journal over** (`ERASURE_JOURNAL_FROM=<file>`, exported there
  with the same command): on the new server the "current" journal is an empty database's.

**The replay** (`replayAfterRestore`) hashes every restored `users.id` with `subjectDigest` (the one
implementation) to find the completed subjects, matches the pending ones by id, and calls
`requestErasure` for each - the same transaction and the same jobs as a person's own request, so the
account is deactivated at once. **ONLY a row created BEFORE that request is erased** (an allowlist,
not a denylist). A person may come back once every job completed, and `users.id` is the OIDC subject,
so a row created after the request is their NEW account, under the same id; erasing it would delete
an account nobody asked to erase. It is logged as `replay keeps user=... it is a new account`. The
test holds for a pending subject too, because the replay printed on a failure may be re-run hours
later, after a replayed erasure completed and the person came back. `users."createdAt"` is a NOT NULL
`timestamp` written by `CURRENT_TIMESTAMP` on core's own connection and compared on that same
connection, so both sides read the one session zone (UTC in the images).

Why `users.id` is the whole match: every service's tables live in `auth_db`, which one archive
restores at one instant. An account erased BEFORE that instant is in the restored journal itself
(pending rows are re-run by the worker, completed ones are done); one erased after it still had its
`users` row at that instant. Both calls are idempotent, so a restore run twice with the same export
adds nothing. Tested against a real PostgreSQL in `account-erasure.integration.spec.ts` (an erased
account restored, a returner's new account kept, a pending one replayed, a second run inert).

## Ordering, failure classes and operating it

**Four jobs per subject**: `core` (core's own rows, once more after the tokens expire), `chat-delivery`,
`social` and `media`. `media` is claimed only once `social` has COMPLETED for the subject
(`ERASURE_TARGETS`' `after`, enforced in the claim's `NOT EXISTS`): social re-classes the media of
the posts that stay, and media deleting first would delete them under a live post. **`chat-delivery`
waits for `social` the same way (2026-10-22)**: social's part removes the person from every
community, each removal evicts their key-group seats in chat-delivery, and that eviction writes a
`dm_seat_evictions` row under their id. Run after social's part completed, chat-delivery's part - its
final pass included - cuts every remaining seat per group under that group's seat lock (`eraseSeats`:
the GROUP's seat generation moves, then the queue, the device rows and the routes go), the groups
named only by one of those rows included. **Then the `dm_seat_evictions` rows are DELETED**
(`ACCOUNT_ERASURE_COVERAGE`), and that costs nothing: what refuses a seat claim the account took
before the erasure is the group's generation, which names no one, never the account's row
([channel-encryption](protocols/channel-encryption.md), "A seat is written against a CLAIM"). Proven
on PostgreSQL with the whole erasure run between a claim and its check
(`seat-lock.integration.spec.ts`, "a claim in flight across a whole account erasure"). **A seat
written while the erasure runs cannot outlive it either**: the account's key packages are deleted
first, in a transaction of their own, and every writer that admits a device reads its device's key
package `FOR SHARE` under the seat lock, so the delete waits for a writer holding one and a later
writer finds none and writes nothing - with two known exceptions, the demotion (below) and the
creation bootstrap of `addGroupMember` (a caller enrolling ITSELF into an empty roster), which takes
no seat lock and reads no key package under one. Since ADM-3 (2026-10-25) that route enrols nobody
else: for any other person it writes device rows through `writePendingSeats` under the seat lock, or
refuses ([backlog](backlog.md), P2 "addGroupMember can enrol an erased account after the final
erasure pass", narrowed). Every group the account's rows still name is then cut under
its own seat lock, its rows and its routes together, so a run that stops anywhere leaves each uncut
group still named for the retry; an eviction after the erasure writes no row naming the account.
**The ordering alone does not hold during the first pass**: a device of the account that reconnects
with a token still valid republishes its key package (`register-device`), and a writer may seat it
again. So the roster rows go once every group was cut (a registration seats a device only where its
owner is on the roster), and the run ends with a sweep - the key packages deleted again, every group
a device row names then cut through the same `eraseSeats`, a WARN line when it found anything. **No
device row is deleted outside `eraseSeats`**: a row is what names its route, so a seat admitted after
the sweep's read keeps its row beside its route, with a WARN line, for the final pass to cut. That
pass starts once no token can act as the account, so it meets no republish at all: it is what
terminates the erasure, not the ordering. The one row that can follow it is a demotion's `pending`
row, route-less and naming a device with no key package, which `cleanupStaleDevices` collects.
Proven on PostgreSQL in `seat-lock.integration.spec.ts` ("a key package republished after the first
delete", "a seat admitted after the sweep's read"). The cost of the ordering is that an
account's MLS data waits for social's final pass, the account itself being deactivated at once. The claim is
`FOR UPDATE SKIP LOCKED` with a lease, so several workers never run one job twice at once; a
completion write is guarded by `"completedAt" IS NULL`, so a pass that outlived its lease cannot
reopen a finished row. A job naming a service this build does not know fails as `UNKNOWN_SERVICE`.

**Failures are classed** (`classifyFailure`): `transient` (5xx, timeout, connection, database) is
retried with backoff (30 s doubling, 6 h cap) and reported when owed 24 h; `permanent` (4xx other
than 408/429, unknown service) is STILL retried but accused at once with an `error` line, and a
sign-in is then refused with `ACCOUNT_ERASURE_BLOCKED` - "contact bureau@rootz-emse.fr" - instead of
"try again later" (`ACCOUNT_ERASURE_PENDING`), because waiting is not expected to help.

**Operator escape hatch.** Find the job (`SELECT id, service, attempts, "lastError",
"lastFailureKind" FROM account_erasure_jobs WHERE "completedAt" IS NULL`), do by hand what its service
could not, then close it with the reason, which the daily report counts as `closedByOperator24h`:

```sql
UPDATE account_erasure_jobs
   SET "completedAt" = now(), "subjectId" = 'sha256:<digest>', resolution = 'what was done, why'
 WHERE id = '<job id>' AND "completedAt" IS NULL;
```

Closing a job early only lifts the sign-in refusal and unblocks `media`; it erases nothing.

**Timing constants.** The final pass waits for the access token's TTL plus 120 s of skew (the
gateways accept a token 60 s past its expiry, so the skew is double that leeway). One job is
claimed at a time with a 300 s lease: jobs run one after the other, each up to 120 s, so a batch
leased together would let the last ones' lease run out while the first still ran.

**Sticky classes, and the core pass.** A job's `lastFailureKind` never goes from `permanent` back to
`transient` while it keeps failing (it clears on a success): the sign-in message must not flip. The
`core` job's pass is local, so a database error has no network to blame: the SAME failure five
times in a row (`sameFailureRun`, reset by a different fingerprint or a success - not a cumulative
count) is classed `permanent`. A failure's fingerprint is its status or code, or for a bare driver error
its name plus a message with digits, long hex and quoted or parenthesised values normalised away.
social answers 503 (transient) when any community failure was infrastructure - chat-delivery down, a
database blip - and 409 (permanent) when every failure was a refusal or a programming error
(TypeError, RangeError, ReferenceError). The daily purge of old journal rows is isolated from the
report, so a failing purge cannot hide an overdue job.

**CI.** The two integration specs run in `ci.yml`'s `boot-nest-apps` job, after the boot has
synchronised the schema into its disposable PostgreSQL (a step, not a new workflow).
