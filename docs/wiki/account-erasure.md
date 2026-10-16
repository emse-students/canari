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
  `webhook_deliveries.userId`, `legacy_cotisations.claimedByUserId`, and about twenty authorship
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
| social | `DELETE /api/internal/users/:id` | the account left every community (each repaired first), `ERASURE_STATEMENTS` ran in ONE transaction, the JSONB scrub ran, the feed cache was dropped |
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
  moderation state, reminders, respondent marks, notifications to OR from it, minesweeper, reviewer
  grants, read grants, its key packages, devices, PIN verifier, push tokens, signature keys,
  notification preferences, dismissal markers, DMs (tombstoned for the other party), queued
  messages to it and queued APPLICATION messages from it; in core, blocks, sessions, the profile
  trail and correction requests, announcement readership.
- **Its marks on other people's posts**: its comments are removed and a reply to one is RE-PARENTED
  to the nearest surviving ancestor (another person's reply is theirs); its likes and reactions are
  removed; a vote on a NAMED poll is removed (the tally drops by one); on an ANONYMOUS poll the tally
  is kept - nothing ever recorded which option was theirs - and the account leaves `voters`.
- **Anonymised to `[deleted]`** (NULL where the column allows and the meaning survives): rows that
  also belong to other people or are accounting records - community salon messages, purchase
  records, webhook deliveries, a submission (its seat and payment fields stay; `userId`, `email` and
  `answers` go), a form's owner, a form file's uploader and file name, a consumed partnership code
  (NULL would hand the code to the next student), reports filed by or about it, and every authorship
  column (`createdBy`, `grantedBy`, `decidedBy`, `republishedBy`, ...). In core, an admin's edit of
  somebody else's profile keeps that person's history with `actorId = '[deleted]'`, and an
  announcement's author becomes the nil UUID.
- **Legacy cotisations**: a row the account claimed is DELETED. The claim had already turned it into
  a `user_tags` row (deleted above); what was left is the name it was matched on.

## What is NOT covered, and why

- **Backups keep everything for their retention (14 days)**, then rotate out. An erasure cannot
  reach into a backup; restoring one would resurrect erased accounts, and the restore procedure owes
  a replay of the completed erasures (their subjects are digests, so the replay must be by digest
  match, which is not built - see [backlog](backlog.md)).
- **media `association` documents and public assets survive** the uploader, by design
  (`survivesAccountDeletion`): a vault document and a logo belong to the association. Blobs uploaded
  before 2026-08-11 carry no owner and cannot be attributed to anyone.
- **MLS ciphertext in multi-member groups stays**: on the other members' devices, which received it
  and are the only holders of a key, and on the server in the group's shared history stream
  (`history:{groupId}`, ciphertext the server cannot read, trimmed at 90 days / 8000 entries -
  `retention.constants.ts`), which the remaining members still catch up from. Picking one sender's
  entries out of it would need the sender's identity per entry, which the stream does not index. A
  commit or Welcome still queued is left to be delivered (deleting it would fork the group for its
  recipient). The account's MLS LEAF stays in each group's ratchet tree until a member commits a
  Remove - no server purge can change a tree.
- **Community salon messages are anonymised, not deleted**: the ciphertext stays for the salon's
  continuity under `[deleted]`.
- **Another author's text that names the account** (a mention, a quote) is that author's content;
  `posts.mentions` keeps the id.
- **The MiConnect (authentik) identity is not deleted**: it is the school's identity provider, not
  Canari's data. Signing in after the erasure creates a new, empty Canari account.
- **Logs** keep the first eight characters of the subject on the erasure lines, for their retention.
