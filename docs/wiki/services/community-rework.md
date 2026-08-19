# The community rework - master plan (2026-08-17)

> **Status: axes 2 and 3 SHIPPED 2026-08-18; axis 1 - the crypto - is the remaining work.** This
> page is the plan of record for the whole community subsystem. The protocol half has its own page -
> [channel-encryption](../protocols/channel-encryption.md) - and is not repeated here. The FRONTEND
> is explicitly out of scope: it is good, and only its unreadable-message state (axis 1) and its
> invite form (axis 3) are touched.

## What triggered it

A user question - "could someone with server access invite themselves into a community?" - turned
into a one-day audit on 2026-08-17. Every figure below is a `GROUP BY` over prod that day. The audit
found one design decision that has to change and five missing invariants that share a single shape:

> **Every community operation checks what the ACTOR may do, and never what the community would be
> LEFT AS.**

Nothing counts admins on the way down, nothing counts members on the way down, nothing bounds an
invite, nothing bounds message growth, and there is no platform-level recourse - the `/admin`
"Communauté" group is associations, document reviewers and the carte, with no route touching a
workspace. So these are not five bugs in five operations; they are one absent postcondition seen
from five sides, and fixing one without the others leaves the hole open.

## Axis 1 - the server stops being able to read (the reason for the rework)

Full design, measurements and the rejected alternatives: [channel-encryption](../protocols/channel-encryption.md).

In one paragraph: `channels.masterSecret` is a plain Postgres column, every epoch key is
`HKDF(masterSecret, ...)`, and the media CEK travels inside the body - so the database reads every
message and opens every attachment of every salon. It is replaced by megolm's shape: a per-sender
session, generated client-side, sealed to each member over a pairwise MLS system group, rotated
lazily on the first send after a departure. **Not Olm** - MLS already fills Olm's role, and adding a
second ratchet would be the opposite of this rework's purpose.

The measurement that made it cheap: **nothing on the server reads a channel body today** - push
inlines the ciphertext, search is client-side, moderation acts on ids. Server readability funds no
feature, so this costs writing and migration only.

Migration is a **clean cut**: at cutover every community and all its content are deleted. Decided
2026-08-17 by the user, which removes the legacy read path, the dual-version window and the
re-encryption pass in one stroke.

## Axis 2 - a community can never be left ungoverned - **SHIPPED 2026-08-18**

`leaveWorkspace` deleted the row and broadcast, counting neither admins nor members.
`kickFromWorkspace` checked the actor and never looked at the target's roles, so `KICK_MEMBERS`
alone removed the sole Administrateur. `updateWorkspaceMemberRole` replaced roles outright with no
admin count and no self-check, so `MANAGE_ROLES` alone demoted the last admin - including oneself.
**15 of the 29 communities on prod had exactly one admin**; that is the median, not the tail.

The invariant, enforced server-side at every exit as a refusal rather than a repair:

- **A community always has at least one admin, or it has no members.** Leaving, being kicked and
  being demoted all consult `listWorkspaceAdminIds` before acting. The last admin is refused with a
  stable code (`WORKSPACE_WOULD_HAVE_NO_ADMIN`) until they hand the role over.
- **A community with no members does not exist.** The last member leaving takes it with them -
  `hardDeleteWorkspace`, one transaction, seven tables named in dependency order because there is
  not one foreign key here to cascade. Five such communities existed on prod and were removed by
  hand on 2026-08-17; the fix is the postcondition, not the cleanup.
- **No repair route is added, deliberately.** A destructive control needs an allowlist and a reason
  to exist; making the broken state unreachable is strictly better than shipping a button that
  restores it.

**The sixth side, found while implementing: account deletion.** `internal.controller` deletes
`channel_members` rows by `userId` directly, so it bypasses every guard above - and it is the one
path that cannot refuse, because the account is going regardless. So it is the one place a repair
exists, and it is deterministic rather than a heuristic: a community left with nobody is deleted,
and a community left with members and no admin promotes its highest-priority survivor, ties broken
by the lowest user id. Deleting other people's community because one person deleted their account
would be far worse, and leaving it ungoverned is the state everything else here exists to prevent.

## Axis 3 - an invite is one link, bounded - **SHIPPED 2026-08-18**

`createWorkspaceInvite` documented itself as "creates (or returns)" and only ever created; the UI
called it on every click. **One member minted 3 tokens for the same community in 59 seconds**, all
three still valid, one ever used - so revoking the link you shared revoked nothing. And all 10 live
invites carried `expiresAt = NULL` and `maxUses = NULL`, because the form offered neither field.

- One live invite per community. The call returns the existing valid token; `rotate: true` is the
  ONLY way to get a new one and revokes the previous in the same call. Opening the panel therefore
  cannot invalidate a link somebody already shared, and "the link" is a single object a human can
  reason about. Tokens still live from before this rule are revoked on the first call, keeping the
  newest.
- Expiry and a use cap surfaced in the UI (never / 1 / 7 / 30 days, unlimited / 1 / 5 / 25 / 100).
  Both columns existed and `inviteIsValid` already honoured them; only the form was missing. Bounds
  that would mint a dead link - an expiry in the past, a cap below one - are refused rather than
  stored, because `inviteIsValid` would otherwise hand back a token dead on arrival with nothing
  saying why.
- Accepting an invite requires the community to still have a member. It used to check
  `archived: false` and nothing else, so one forwarded link resurrected an empty community into a
  populated one with **zero** admins - the one state nothing can repair from inside.
- After axis 1, a leaked link stops granting the past: the joiner receives current sessions only.

**Every refusal above carries a stable `code`**, and the three screens that surface them - the
sidebar leave, the admin modal's remove, the invite landing page - map that code to a Paraglide
sentence through one shared `describeCommunityRefusal`. A distinction carried in prose is one that
exactly one call site will make.

### Prod after the fix (2026-08-18)

Re-measured the day it shipped, on 19 active communities:

| | |
|---|---|
| communities with no members | **0** |
| communities with members and no admin | **0** |
| communities with exactly one admin | 15 - unchanged, and no longer a hazard: that admin can no longer disappear |
| live invites | 10, over 7 communities |
| live invites with no expiry / no cap | 10 / 10 - every one of them predates the form |

**Two communities still carry surplus live tokens** ("Le Glory's de la Bdthèque" holds 3, "QA
Invitation" 2). They are revoked lazily, on the first call to the invite endpoint for that community,
which is what makes the singular true again without a migration. Deliberately not revoked by hand:
the exposure is months old and the mechanism is now correct, so a destructive prod write for it is
the user's call rather than a cleanup to slip in.

## Axis 4 - message growth is bounded, or it is not a system

**No cron in social-service touches `channel_messages`.** A salon message lives for ever. The app
promises ninety days for MLS conversations and enforces it; channels promise nothing and enforce
nothing, which is why the storage panel could not answer "why is this growing".

**OPEN DECISION, and it is the user's:** channels get a retention window (ninety days, matching
conversations, is the obvious candidate), or an explicit statement that they are permanent and the
growth is accepted and measured. Either answer is fine; the current state - no policy, no
measurement, no statement - is not. Nothing else on this page is blocked by it.

## Axis 5 - the data model the audit walked into

Not blocking, but every one of these cost time during the audit and will cost it again:

- **There is not one foreign key** on `channel_workspaces` or `channels` (checked against
  `information_schema`). Deleting a community by hand means naming seven tables in dependency order
  or creating orphans; that is what the 2026-08-17 purge had to do.
- `channel_members.roleIds` and `channel_roles.permissions` are `simple-array` **text**, so
  "does this member hold an admin role" is a `string_to_array` join with a `LIKE` over a
  comma-joined column, and cannot be indexed. Legacy permission names still live alongside the
  unified ones, normalised only in an `@AfterLoad`, so SQL has to match both spellings.
- `channel_members.keys` is a jsonb of per-channel keys - a leftover of the distribution model axis
  1 replaces. It goes with it.
- Two communities may share a name; only `slug` is unique. **Accepted by the user 2026-08-17**, kept
  here so nobody re-opens it: prod holds two "MiTV" and two "Test".

## Axis 6 - the documentation, which was wrong where it mattered most

The audit found the wiki asserting the opposite of the code on the one question a reader would care
about. Corrected 2026-08-17, listed so the pattern is visible rather than the individual lines:

- [social-service](social-service.md) claimed each member receives the channel key "encrypted with
  their MLS group key". Nothing ever wrapped it - `buildChannelBootstrap` returns raw base64.
- [cross-client-campaign](../cross-client-campaign.md) claimed the server sees everything "except
  message bodies". The exception did not exist.
- `libs/proto/canari.proto` still says of `MediaMsg.key` that "Only group members can decrypt both
  the key and the blob" - true of MLS, false of channels. **Not yet fixed**; it goes with axis 1.
- `soft-crypto.ts` had no call site anywhere in `apps/`, `frontend/src` or `libs/` and was deleted.
  It shared the `canari-channel-e2ee-v1` info string with the live derivation, which is exactly the
  shape that gets mistaken for the real mechanism while reading.

The rewrite owed at the end of axis 1: the channel encryption section of
[social-service](social-service.md), the transport table in
[cross-client-campaign](../cross-client-campaign.md), the schema row in
[architecture](../architecture.md), the channel routes in [api-surface](../protocols/api-surface.md),
and the `.proto` comment.

## Order of work

1. ~~**WP-0** - the storage panel already in the working tree.~~ Shipped 2026-08-18.
2. ~~**WP-1** - axes 2 and 3, server-side, with tests.~~ Shipped 2026-08-18: twelve cases in
   `channel.service.spec.ts` pin the postcondition from each side it can be reached from.
3. **WP-2..WP-8** - axis 1, as broken down in
   [channel-encryption](../protocols/channel-encryption.md#6-the-work-packages).
4. **Axis 4** once the user has answered it; **axis 5** opportunistically, inside whichever package
   already touches the table.
5. The campaign restarts only after all of it, on one rebuilt Android APK.
