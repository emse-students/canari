# Legacy compatibility - the shims still standing, and the date each one may go

Every entry here is a branch that exists ONLY to keep working against something older than the
current protocol. Each one is dead weight the day its condition is met, and each one is a place where
a future reader has to reason about two protocols at once.

**Why this file exists rather than a comment per site.** A compatibility shim is invisible once it
works: nothing fails, nothing warns, and the condition that would retire it is never re-checked. So
the condition is written down HERE, and the removal becomes a diary entry somebody acts on rather
than an archaeology exercise. Every shim below also carries a comment at its site pointing back here.

**Nothing below is WORK.** Each entry is a date, and the code change behind it is minutes. What is
being waited on is the world, not a decision - do not "do" these early, and do not re-argue them.

---

## What the 2026-08-17 gate actually retired, and what it did not

`minClientVersion` went to **0.14.0** on 2026-08-17. The gate is hard - `ensurePlatformAllowsUnlock`
blocks the MLS unlock outright, so a client below it cannot put a group frame on the wire at all.

It was assumed at the time that this retired most of this page. **Measured, it retired exactly one
entry**, and the distinction is worth keeping because it is the one this page was getting wrong:

- **A shim that humours a LIVE PEER is retired by the gate.** Only one was:
  `history_bundle` with no `since`, deleted 2026-08-17.
- **A shim that decodes DATA AT REST is not**, whatever the fleet is running. The bytes were written
  before the change and they are still there; the gate says nothing about them. Four entries below.
- **A shim that protects the SERVER's response shape is not either**, because the replacement has
  never shipped. One entry below, and it has no date for that reason.

**And a date is only worth what the mechanism under it is worth.** These four were dated on the claim
that `history:{groupId}` expires after `RETENTION_WINDOW_MS`. It did not: the key carried a TTL
*refreshed on every write*, and `HISTORY_STREAM_MAXLEN` bounds the entry COUNT, so a group under the
cap kept every row it had ever held, for ever. Measured on production 2026-08-17: **four of five
streams still carried rows from before 2026-08-15**, at 1 to 11 entries each, in streams nowhere near
the 8 000 cap. The write path now trims by `XTRIM ... MINID` at `RETENTION_WINDOW_MS`
(`messaging.service.ts`), which is what makes the dates below mean something.

**One deliberate break, recorded here so it is not read as an oversight.** `DELETE
/api/channels/workspaces/:id` requires a `confirmationName` since 2026-08-18, and a client that does
not send it is refused. No shim was written on purpose: that route stopped archiving and now destroys
a community outright, while older clients still ask "are you sure?" in the words of the reversible
action. Accepting their call would let them destroy something behind a warning that no longer
describes it, so the missing argument IS the protection - see
[social-service](services/social-service.md#deleting-a-community). It retires itself when no client
below 0.15.0 remains; there is nothing to delete when it does.

**And one deliberate NON-break, recorded for the same reason.** `DELETE /api/channels/:channelId`
made the identical archive -> destroy move on 2026-08-20 and took **no** new argument. The rule the
entry above establishes is not "a delete that becomes real needs a token" - it is *check what the
deployed clients are promising before changing what the server means*. Here they were already
promising it: `chat_delete_channel_confirm` has read "Supprimer definitivement le canal #x ?" since
`5babb466` (2026-06-16), the first version of the string that shipped. A gate would have broken
working clients to protect them from a warning that was accurate all along - see
[social-service](services/social-service.md#deleting-a-channel-took-no-new-argument-deliberately-2026-08-20).

---

## Removable at floor 1.2.7

**Audited 2026-10-15, against `main` at `9f7ccfef8`**, when the user reported `1.2.7` served by BOTH
stores (Play `1.2.8`, the App Store `1.2.7`), so that `minClientVersion` could rise from `1.0.3` to
`1.2.7`. A removal marked "with the floor" REFUSES what an older build sends, so it may only deploy
once `minClientVersion` reads `1.2.7` or more **on the estate it deploys to**: `platform_config` is
PER ESTATE (production and `dev.canari-emse.fr` each hold their own row), so the floor is raised in
`/admin/platform` on BOTH, dev included, or a pre-release carrying a refusal breaks a dev tester on an
older build. "First release" is the first stable tag containing the replacement (`git tag --contains`);
a shim is removable by the floor only when that release is `<= 1.2.7`. A floor never retires DATA AT
REST: those rows need a count, then a migration.

| Shim (entry below) | Condition | Met at floor 1.2.7? | Data at rest | Removal size | Disposition |
| --- | --- | --- | --- | --- | --- |
| `paymentMethod: 'stripe'` STORED | rows written before 2026-10-08 | no - data | `purchase_records` and `submissions` | type + 3 client arms, after a migration | owed: count + migration (user) |
| Salon push held for a sender with no `seedFrame` | floor >= first release sending `seedFrame` | version YES (`v0.18.28`); proof NO | none | server refusal + Kotlin hold registry, native | NOT removed: nothing has measured that EVERY admitted send carries the frame (the server never stores it), so a required field could refuse an honest send. Owed: a log of frame-less non-silent sends, read for a week, then a native PR |
| Server `legacyTitle`/`legacyBody` on social/form pushes | clients reading `contentKey` (2026-08-19) | version YES (`v0.14.1`) | none | ~-50 lines server + Kotlin + Swift arms | NOT removed: dropping them leaves an iOS alert EMPTY whenever the NSE does not run, a visible behaviour change, not a removal. Needs a decision and an iPhone reading |
| Reaction push keeps wire type `social` + a generic `body` (`notify-reaction`; had no entry here) | clients knowing `reaction: 'true'` (2026-08-15) | version YES (`v0.14.0`) | none | server + Kotlin dispatch | NOT removed, same iOS-alert question as the row above |
| Post `images` field (in and out, `posts.service.ts`; had no entry here) | clients sending `media` | not established | `posts.images` is the column itself | DTO + normaliser | NOT removed: the client switch is undated; find it before judging |
| Pre-MLS send path + `queued_message.content` | log silence (`LEGACY_CONTENT_PATH`/`_ROW`), dated 2026-11-19 | not a version question | the column | `else` arm + migration | owed: log read + count + migration |
| Graine v1 reader | 0 unsigned rows | NO | 373 rows (2026-10-14) | - | revisit 2027-10-13 |
| `read_receipt` (both entries), `remove_reaction`, `pin`/`unpin` undated, no `sender_device_id`, no `message_id` | live peers (met) AND archive retention | live half YES, archive NO | Redis history streams | per entry | dates 2026-11-13 to 2026-12-15 stand |
| Refresh cookie on `tauri://localhost` | floor AND a desktop measurement | floor YES, measurement NO | none | - | unchanged |
| MiConnect `formation`/`promo` claims | WP9 | NO (not a version) | Authentik attributes | - | unchanged |
| `GET /history` bare array | replacement shipped, then floored | NO (never shipped) | none | - | unchanged |
| `LEGACY_PERMISSION_MAPPING` (`channel-role.entity.ts`; no entry here) | no `channel_roles` row holds an old key | not a version question | `channel_roles.permissions` | 1 map + 1 hook | owed: count |
| Form `dependsOn`/`dependsValue` (`forms/visibility.ts`; no entry here) | no stored form uses the pair | not a version question | `forms.items` | reader branch | owed: count |
| State blob v1 header WRITER (`frame_v1`, CORRUPT-1/2) | floor >= the reader (`v0.18.18`) | YES | it CHANGES device data at rest | 1 line + `serverProse.test.ts` | FLIPPED in its own MLS PR (PK1, 2026-10-17, unshipped until a tag carries it); the LEGACY reader stays for blobs not yet rewritten ([backlog](backlog.md)) |
| `MLS_STATE_SEAL_V2_WRITER_ENABLED` | `minClientVersion` AND the web rollback floor >= the tag carrying the HARDENED v2 reader (#2074) - a v2 reader alone (`v1.2.7`) is not enough: `v1.2.7` and `v1.4.0` misread a refused v2 blob, the second as `STATE_ALTERED` | NO (floor `1.2.7`; the hardened reader is in no tag yet) | it CHANGES device data at rest | 1 line in its own PR, then the encrypt worker | NOT done: #2074 ships the reader with the writer OFF ([mls-protocol](protocols/mls-protocol.md#v2---the-browser-seals-with-webcrypto-every-platform-reads-it-2026-10-12)) |
| The `1.2.1` key-group epoch floor (backlog owed line) | floor >= `1.2.1` | YES | - | - | closed (floor is now `1.2.9` on production) |
| Group removal hold (#1878) | floor >= the release carrying it | YES on production since 2026-10-29 (floor `1.2.9`) | - | - | floor met |
| `GET mls/groups/:id` and `GET mls/group-info/:id` answer `{ found: false }` / `{ groupInfo: null }` instead of a bare `null` (an empty untyped 200), #2428 | the server deploys | not a version question: a deploy-order WINDOW | none | - | A stable ships both stores BEFORE production deploys, so for days new native clients talk to the old server. There, an empty untyped 200 reads as `error`, so a group deleted for everyone is not auto-purged on those clients until the server ships. That costs cleanup, not data. Once the server deploys, OLD clients change too: `fetchGroupInfo` returns `null` instead of throwing on an unpublished base (benign), and their `GroupInfo fetch failed` warn goes quiet ([chat](frontend/modules/chat.md#a-2xx-a-captive-portal-answered-is-no-answer-2026-10-25)) |
| Send answered without `receivedAt` read as accepted-undated (`postApplicationMessage`, #1878) | no estate runs a chat-delivery older than #1878 | not a client version question | none | the `null` arm | kept: harmless (the copy is undated); only the API's PARSEABLE JSON reaches it since 2026-10-25 - a non-JSON 2xx is no answer ([chat](frontend/modules/chat.md#a-2xx-a-captive-portal-answered-is-no-answer-2026-10-25)) |
| `canari_post_feed_kind` drop (`posts/retiredFeedKind.ts`, run by the feed's `load`) | every device that ran a `1.2.9-alpha.2`/`.3` has opened the feed once on a later build | not a version question (alphas only) | one device-global `localStorage` key | 1 module + 1 call | remove with the first stable after `1.2.9` ([reels](frontend/modules/reels.md#the-canareels-entry---an-icon-beside-the-tabs-that-opens-the-viewer-user-2026-10-16)) |
| Plaintext native cache reader (`native_cache::open_file`/`open_line`, the `Plaintext` arm, and the one-pass migration) | floor >= the release carrying the at-rest seal | NO (unreleased) | `graine_seeds.json`, `fcm_message_cache*.ndjson` on devices not yet updated | 2 match arms + 3 migration functions | waits for the floor ([diary](#no-date-yet---a-plaintext-native-cache-written-by-a-build-older-than-the-at-rest-seal)) |
| OIDC callback with no PKCE `code_verifier` (`auth.controller.ts`, `oidcCallback`) | floor >= the first stable carrying the client half, AND the `without a PKCE verifier` warning silent for a week on production | NO (unreleased) | none | 1 branch: refuse instead of warn | waits for the floor ([diary](#no-date-yet---an-oidc-callback-with-no-pkce-verifier)) |
| `klipy_cid` drop (`utils/chat/retiredKlipyCustomerId.ts`, run at the root layout's mount) | every install older than 2026-10-16 has started once on a later build - a CLIENT FLOOR, since an install that never updates keeps the key and also keeps sending it | `minClientVersion` past the release carrying it | one device-global `localStorage` key, the per-install id older builds sent to KLIPY | 1 module + 1 call | remove with the first stable after the floor passes that release ([chat](frontend/modules/chat.md#the-gif-search-goes-through-canari-2026-10-16)) |
| Send-ledger entry with no epoch (`sendRatchetLedger.ts`, `parseKey`) | floor past the first stable carrying #2269 | NO (unreleased) | `mls_send_ledger_<user>` in `localStorage` on devices not yet updated | 1 parse branch + 1 debt arm | waits for the floor ([diary](#no-date-yet---a-send-ledger-entry-with-no-epoch-written-by-a-client-older-than-2026-10-23)) |
| Plaintext live key: the `"liveKey"` column, `openLiveKey`'s plaintext arm, `LivesService.sealPlaintextKeys` (migration 110) | 0 rows with `"liveKey" IS NOT NULL` on both estates, read AFTER the first deploy carrying 110 has fully replaced the previous replica | not a version question (server only) | `lives."liveKey"` | 1 arm + 1 sweep step + a migration dropping the column, the index and `lives_key_one_form` | owed: the count below, then that migration ([lives](services/lives.md#the-live-key-at-rest)) |
| `follow-status` answers `following: true` for a PENDING follow request (`posts.controller.ts`, `getUserFollowStatus`; WP-F1) | floor past the first stable carrying the request screens (WP-F4), which read `status` | NO (unbuilt) | none | drop `following`, or make it mean accepted | waits for the floor. An older client's button shows the leave action for a request, so its user can withdraw what they asked; reading `following` as "accepted" would show "Suivre" and leave the request unwithdrawable there ([backlog](backlog.md#follow-requests-member-reposts-and-visibility-between-spaces---decided-by-the-user-on-2026-10-25)) |
| A new person admitted only by a member's decision (#2358): member clients that still Add automatically | floor >= the first stable carrying #2358, raised once BOTH stores serve it (not at deploy, no date), AND migration 038 deployed with it | NO (unreleased) | `dm_group_members."awaitingAdmission"` | nothing to remove - the floor is what makes the rule TRUE | waits for the floor ([diary](#no-date-yet---a-member-client-older-than-the-admission-rule-still-adds-a-new-person-automatically)) |
| The `join-ask-1` capability gate: `group.join_ask` / `group.join_ask.settled` reach only devices every session of which declared `join-ask-1` (chat-delivery `JOIN_ASK_PUBLISH_LUA`, gateway `requiresCapability`) | floor >= the first stable carrying the ask frames (#2442), raised once BOTH stores serve it | NO (unreleased) | none - the gateway's twin hash `addressing:join-ask:*`, one field per session with a TTL | the twin hash + its script + the `requiresCapability` field + `JOIN_ASK_CAPABILITY` in three places; the presence check stays | waits for the floor: an older build routes only `channel.`/`workspace.` frames and would log each ask as reaching no handler, so until the floor the gate is what keeps that line from every older client ([mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23), [chat-gateway](services/chat-gateway.md#presence)) |
| `PUT associations/:id/lydia-business-key` answers a typed `410 LYDIA_KEY_PASTE_RETIRED` and writes nothing; `GET` on the same path still answers `{ set }` (enrolment lot 1) | `minClientVersion` past the first build without the paste field, on BOTH stores | NO (unreleased) | none - the key column stays, written at `business/create` | 2 routes + `isLydiaBusinessKeySet` + 1 spec block | waits for the floor ([diary](#no-date-yet---the-lydia-key-paste-field-of-a-build-older-than-enrolment-lot-1)) |

**Owed to the user, read-only, before any migration above** (production Postgres, as
[databases](infrastructure/databases.md#reaching-it-from-a-workstation) describes):

```sql
SELECT count(*) FROM purchase_records WHERE "paymentMethod" = 'stripe';
SELECT count(*) FROM submissions WHERE "paymentMethod" = 'stripe';
SELECT count(*) FROM queued_message WHERE content IS NOT NULL;
SELECT count(*) FROM channel_roles WHERE permissions ~ '(MANAGE_WORKSPACE|MANAGE_CHANNELS|MANAGE_ROLES|MODERATE_MESSAGES|INVITE_USERS|SEND_MESSAGES)';
SELECT count(*) FROM forms WHERE items::text LIKE '%"dependsOn": "%';
SELECT count(*) FROM channel_messages WHERE "signature" IS NULL AND "senderSessionId" IS NOT NULL;
SELECT count(*) FROM lives WHERE "liveKey" IS NOT NULL;
```

---

## The diary

### Revisit 2026-12-31 - a `DEVICE_REVOKED` refusal that does not say who revoked the device

**Site:** `classifyRevokedDeviceRefusal` in `frontend/src/lib/mls-client/mlsDeliveryApi.ts`.
**What it humours:** a delivery service older than migration 040, whose `DEVICE_REVOKED` carries no
`reason`. It cannot tell an id its own install retired from a device its owner revoked, so a client
reads it as the owner's - a sign-out and a wipe, said at `error` - and only `reason: 'retired'`
licenses a re-enrolment. That reading is the safe one and stays; what goes is only the ACCUSATION
wording about an older server, once no server without the reason can answer.
**The other direction needs nothing:** a client older than `DEVICE_REVOKED_BY_OWNER` reads it as an
unknown 403 and does not re-enrol (the code is new precisely so it cannot), and still re-enrols on
`DEVICE_REVOKED`, which a current server sends only for a retired id. A `revoked_device` row written
before the column holds NULL and is read as the owner's for good - data at rest, not a shim, so it
has no date.
**The window this opens, and it is a real one:** the stores can ship this client BEFORE production
runs migration 040. In that window an install whose own rotation retired its id gets a reasonless
`DEVICE_REVOKED` and is signed out and wiped instead of taking a fresh id - the fail-safe direction,
paid by the few installs that rotate in it. The same client's `?reason=retired` is ignored by such a
server, which records a plain ban (read as the owner's once 040 lands - see below).
**Old clients record retirements as owner bans, for good:** a client older than `?reason=retired`
deletes its abandoned id without a reason, which a current server records as the owner's. The id is
abandoned, so nothing re-enrols it; the cost is only that the delete also ends the sessions bound to
that id (never the caller's own, which is the one the install is using). Permanent data at rest, no
date.
**Condition:** every estate serves migration 040 (one deploy of each). The date is when to check.

### Removal at deploy + one access-token lifetime - an access token that names no session

**Site:** the `legacy` branch of `AuthController.sessionOfToken` in
`apps/core-service/src/auth/auth.controller.ts`.
**What it humours:** an access token minted before its issuer wrote `sid`. The issuer always writes it
now, so such a token is pre-deploy by construction and dies by its own `exp` within
`ACCESS_TOKEN_TTL_SECONDS` (1 h) of the deploy; it is accepted without a session read, `X-Session-Id`
empty, logged once per process at `log`. Refusing it would answer every client signed in at the
deploy anonymous for up to that hour. The dev estate cannot rehearse it (its tokens already carry
`sid`).
**Condition:** production has run the release carrying the check for longer than one access-token
lifetime. Then delete the branch, so a token naming no session is answered anonymous like an ended
one ([sessions](sessions.md#an-access-token-is-only-as-alive-as-its-session-2026-10-25)).

### No date yet - the Lydia key paste field of a build older than enrolment lot 1

**Site:** `retiredLydiaBusinessKeyPaste` (`PUT :id/lydia-business-key`) and `lydiaBusinessKeyStatus`
(`GET` on the same path) in `apps/social-service/src/associations/associations.controller.ts`, with
`AssociationsService.isLydiaBusinessKeySet`.
**What it humours:** since enrolment lot 1 the Business private token is captured at `business/create`
([payments](frontend/modules/payments.md#the-key-is-captured-at-businesscreate-enrolment-lot-1)) and the
paste field is gone from the app. An APK or IPA older than that release EMBEDS the old field: it reads the
`GET` status (kept, so the panel still shows "set" or "not set") and may `PUT` a key. The `PUT` writes
nothing and answers `410` with the code `LYDIA_KEY_PASTE_RETIRED`; the old field shows its own "could not
save" line for any refusal (it never reads the body), so a bare status is enough there. Each hit is
logged at WARN, naming the association and never a value: the count of old clients still using it. The
shim keeps the old route's throttle and `MANAGE_PAYOUT_ACCOUNT` check, so a non-manager gets the `403`
it always got and only a manager's hit is counted.
**The cost while it stands:** none - nothing is written; an old screen shows a save error.
**Removal condition:** `minClientVersion` past the first build without the field, on BOTH stores. Then
delete both routes, `isLydiaBusinessKeySet`, their spec block, and this entry.

### No date yet - an explicit slug sent on association creation, by a client older than the derived slug

**Site:** the `explicitSlug` branch of `AssociationsService.create`
(`apps/social-service/src/associations/associations.service.ts`) and the optional
`CreateAssociationDto.slug`.
**What it humours:** since the slug became derived by the server (2026-10-26,
[associations](frontend/modules/associations.md#the-slug-is-a-technical-id-derived-by-the-server-never-shown-typed-or-edited-user-2026-10-26)),
the app sends none. An APK or IPA older than that release EMBEDS the old form, which still sends the
slug its creator typed; the branch validates it (pattern, reserved route words) and refuses it `400`
when taken, as before, so those builds keep creating.
**The cost while it stands:** any API caller - not only an old build - may still choose its slug.
That squatting is NOT new (every client could before), and it ends with the branch.
**Removal condition:** `minClientVersion` covers the release carrying the derived slug on BOTH stores,
so no supported client still sends one. Then make the DTO refuse `slug` (or drop it) and delete the
branch and its tests; the derived path is then the only one.

### No date yet - a member client older than the admission rule still adds a new person automatically

**Site:** `automaticAdmission` in `frontend/src/lib/utils/chat/actions.ts` (the rule), and the server's
`GroupMember.awaitingAdmission` with its lift (`liftAwaitingAdmission` in `messaging.service.ts`).
**What holds before the floor:** "a new person joins only through a member's decision" is a CLIENT
rule - a member's device refuses to Add a user absent from its tree - so it holds only for members
running a build that carries it. A member on an older build still Adds from the `pending` row the
link wrote, with no human asked: that is the behaviour this rule replaces, and nothing on the server
can tell it from a member's Add. The server honours it as one: that older client's commit declares
the joiner in its `admits` (every client at the floor does, #1151, `v0.18.28`), and the accepted
commit lifts the joiner's `awaitingAdmission`. **The Welcome-sent-apart lift is GONE since ADM-3
(2026-10-25)**: it existed for a commit older than `admits`, which no client at the floor sends, and
it was the door through which a Decline the gate had honoured was undone
([mls-protocol](protocols/mls-protocol.md#the-commit-is-the-one-writer-of-a-new-person-adm-3-2026-10-25)).
**When the floor is raised (user, 2026-10-24):** once BOTH stores serve the version carrying #2358 -
never at the deploy, never on a date. Until then an older client gets the tolerated 409
`awaiting_admission` path (the external-join base refused as a wait, not a 403, so it asks a member
instead of retiring the conversation), and an older member's automatic Add is honoured through its
commit's `admits`. That tolerance is the shim; its removal condition is that floor, and there is no
calendar date.
**The rule becomes TRUE when** `minClientVersion` reaches the first stable carrying #2358, both stores
serving it - AND migration 038 is deployed with that build: the column is what holds a link joiner
outside (the base, the commit gate, the joiner's own membership read), and the server reads it on
every one of those paths, so the build does not run without it.
**Removal:** nothing - this entry closes when the floor passes; the lift by the accepted commit is
how every Add admits, and stays.
**A one-off population, not a shim: link seats written BEFORE migration 038.** The column defaults
every existing row to `false`, so a person who accepted a link before the deploy and had not entered
yet holds an ORDINARY seat, not an ask. Nobody is asked in their name and a Decline answers
`not-awaiting`. Neither the base nor the commit gate refuses them, so they may still enter by their
own external commit exactly as before the rule, and the members then report it:
`[UNINVITED_ENTRY] kind=new-person` in the delivery log, the count the rollout is read on. The
population cannot grow (only `acceptGroupInvite` writes the flag from then on). It is LISTED
read-only on production, once, right after the deploy - each seat with no trace of an admission:

```sql
SELECT m."groupId", m."userId" FROM dm_group_members m
WHERE NOT m."awaitingAdmission"
  AND NOT EXISTS (SELECT 1 FROM dm_device_group_memberships d
                  WHERE d."groupId" = m."groupId" AND d."userId" = m."userId"
                    AND (d.status = 'active' OR d."admittedAtEpoch" IS NOT NULL));
```

**How the rollout count subtracts it:** an `[UNINVITED_ENTRY] kind=new-person` line whose `group`
and entrant user (the `entrant` up to its `:`) are a pair of that list is this population entering
the way it always could - not a bypass of the rule - and is counted apart. Every other `new-person`
line after the floor is the rule failing. The list stays in the private operations notes with the
deploy date; only this query and the rule live here.

### No date yet - a notification TYPE the client does not know, from any new server type

**Site:** `NotificationRow.svelte` and `notificationHref` in `frontend/src/lib/posts/notificationTarget.ts`.
**The defect in released clients (v1.0.3 up to main before the release carrying PR #1911):** an unknown
`type` fell into the row's final `{:else}`, the COMMENT branch ("<actor> a commente : <title>", comment
glyph), and `notificationHref` answered `/posts/<id>`, a dead link when the id is not a post. Native
pushes are not affected: Android and iOS (NSE and `canari_push.mm`) keep the server's own wording for
an unknown `contentKey` and log it. An unknown deep-link HOST of our scheme used to open the app and go nowhere; it
now lands on `/notifications`. **But a push for a new type does not get there by itself:** the server
(`socialDeepLink`, `apps/social-service/src/push/push-target.ts`) and Android
(`CanariFirebaseMessagingService.kt`) map ANY `postId` to `fr.emse.canari://post/<id>`, so a new type whose
id is not a post keeps a DEAD tap on every client.
**Consequence for the ones already shipped:** `profile_correction_*`, `coorganise_proposed` and
`repost_proposed` (and the agenda's types before their own rows) show the comment sentence on a client
older than the release carrying their rows.
**THE MINIMUM CLIENT VERSION MUST COVER THIS FIX BEFORE ANY NEW NOTIFICATION TYPE SHIPS** - the release
carrying PR #1911, both stores serving it, then `minClientVersion` raised to it. A new type shipped
earlier reaches the floor clients as a wrong sentence and a dead link, which no server change can undo.
**Checklist - a NEW notification type** (no other checklist existed; this is it):
1. The floor above covers PR #1911 first.
2. The server sends an EXPLICIT `deepLink` (or a dedicated host) for it in `socialDeepLink`; never rely on the `postId` -> `post/<id>` default when the id is not a post.
3. Add the type to `KNOWN_NOTIFICATION_TYPES` and the `notificationHref` switch (`notificationTarget.ts`), and give `NotificationRow` its glyph, colour and Paraglide sentence; the tests walk every known type through both.
4. Native tables (`composeServerNotification`, NSE, `canari_push.mm`) get its `contentKey`.
**Removal condition:** none; this is a floor requirement, not a shim.
**Built and waiting on this floor (2026-10-22): `form_paid_over_capacity`**, the organiser alert for a
payment that landed on a full form ([forms](frontend/modules/forms.md#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off)).
**Step 1 is MET (2026-10-29):** production's `minClientVersion` was raised from `1.2.7` to `1.2.9` by the
owner's explicit decision, read back from the public version endpoint as `1.2.9`; both stores serve `1.5.0`,
far above the floor, so the raise cannot lock out a shipped client (compare the v0.14.0 incident above). A new
notification type, bookings included, may now ship once its own flag flips. Dev's floor is a separate row
([backlog](backlog.md)). Steps 2-4 are done for `form_paid_over_capacity`, which ships behind `FORM_ORGANISER_ALERT_ENABLED = false` (`apps/social-service/src/forms/organiser-alert.service.ts`).
**The exact precondition to set it to `true` (user, 2026-10-22):** `minClientVersion` at or above the
version that CARRIES #2228 (not merely `1.2.9`: that build also declares the `form-responses` host and
knows the type), on BOTH estates, once BOTH Play AND the App Store serve that version. The switch stays
ONE one-line constant; the flip is a follow-up pull request changing the constant and the spec that
pins it, run by someone else.

**Switched on by the flip pull request (2026-10-29), on the `1.2.9` floor: the bookings' four** - `booking_cancelled`,
`booking_withdrawn`, `booking_added`, `booking_reminder` ([bookings-chantier](bookings-chantier.md#wp-n-as-built---the-bookings-notices-and-the-reminder-d53-2026-10-29)).
Steps 2-4 are done in the same pull request (target `bookings`, the four rows, the three native
tables). They ship behind `BOOKING_NOTIFICATIONS_ENABLED = false`
(`apps/social-service/src/bookings/booking-notifications.service.ts`) and its client mirror
`BOOKING_NOTIFICATIONS_LIVE`. A `1.2.9` client draws them as the neutral unknown-type row, shows the
push's French legacy sentence, and on Android a tap opens the app where it was (no `bookings` host);
the version CARRYING this pull request draws all of it. That degraded display between `1.2.9` and
the release carrying #2692 was ACCEPTED (2026-10-29); raising the floor to that release, once both
stores serve it, is owed after the stable ([backlog](backlog.md#owed-after-the-stable---raise-the-floor-to-the-release-carrying-the-bookings-notices)).
The flip is a one-line pull request of its own, merged once the floor read-back showed `1.2.9`.

**Built and waiting on their floor (2026-10-31): `lydia_payments_active` and `lydia_payments_paused`**, the
notices telling an association's `MANAGE_PAYOUT_ACCOUNT` holders that its Lydia payments became active or were
paused (Lydia enrolment lot 2). They ship behind `LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED = false`
(`apps/social-service/src/associations/lydia-payments-notifier.service.ts`); while it is off nothing is
written and the caller's ERROR/WARN line plus the payments screen state carry the fact. **Flip condition:**
`minClientVersion` at or above the first release carrying Lydia enrolment lot 2 (PR to be numbered), on BOTH
estates, once Play and the App Store serve it - then a one-line pull request sets the constant to `true` and
changes the spec that pins it. A client older than that release draws them as the neutral unknown-type row.
Steps 2-4 are done: the push keys and French legacy sentence, the `forms` push category, the native
tables (Android, the iOS app and its notification extension), the client row, `KNOWN_NOTIFICATION_TYPES` and the
`payments` section of the association edit page. The push opens the notifications list (`notifications`
host): no deep-link host exists for an association's edit section. The type names are shared through
`libs/contracts/lydia-refusal-codes.json`.

### No date yet - a send-ledger entry with no epoch, written by a client older than 2026-10-23

**Site:** `parseKey` and `sendRatchetDebt` in `frontend/src/lib/mls-client/sendRatchetLedger.ts`.
**Shim (2026-10-23):** the send ledger is keyed `<groupId>@<epoch>` since #2269
([mls-desync-prevention](protocols/mls-desync-prevention.md#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)).
A device updated with frames counted but not checkpointed still holds entries keyed by the group
alone, in `localStorage`. They are read as their writer counted them, against the epoch the state is
restored at, and forgotten once settled at a load (the burn's checkpoint commits them).
**Removal condition:** a CLIENT FLOOR - `minClientVersion` past the first stable carrying #2269. An
install below it keeps writing epoch-less entries; above it, each one is settled at its first load
and gone. Then `parseKey`'s `null` epoch and its arm in `sendRatchetDebt` go.

### No date yet - a bare `userId` MLS credential, written by builds before 2026-07-24

**Site:** `canonical_user_of` / `is_legacy_bare_identity` in `frontend/mls-core/src/device_trust.rs`,
and its twin `canonicalUserOf` in `frontend/src/lib/mls-client/leafIdentity.ts`.
**Shim (2026-10-22):** builds before device identities (61ac71d7c9, 2026-07-24) minted a credential
naming the user alone, with no `:` and no device, and a tree a device still holds may carry such a leaf.
The one canonical reader treats it as naming its user (ASCII-lowercased) and NO device. So
`remove_members_for_users` removes it with its user, and the native push sender check accepts it as
that user. `canonical_identity` still refuses it, so it is never pinned and never matches
`user:device`. Tests: `tests/legacy_bare_leaf.rs`, `a_push_from_a_bare_legacy_leaf_is_its_users`
(`background.rs`) and the bare cases of `leafIdentity.test.ts`.
**Removal condition:** no held tree carries a bare leaf. This is measured on the device: every load's
state-composition line ends `N legacy bare leaves` (`MlsManager::legacy_bare_leaves`). Remove the shim
when that reads 0 on the bench phones and on the rig's clients, and no build older than 61ac71d7c9 can
still commit into a group. Then the bare arm goes from both readers, and a bare identity names nobody.

### No date yet - an owed Welcome stored as ONE bare entry per group (2026-10-25)

**Site (client, native and WASM alike):** `decode_entries` in `frontend/mls-core/src/owed_welcome.rs`.
**Shim:** since DUP-7 (2026-10-25) a group's owed-Welcome record is a CBOR LIST, one entry per Add,
because every accepted Add now owes its Welcome and a second Add must not erase the first. A build
before it wrote one bare entry; the reader takes that shape as a list of one. Every write is the list.
An older build reading a list fails to decode it, says so at error level and drops it at its next
save - its invitee then joins by its own repair, as before this change.
**Removal condition:** `minClientVersion` is at or above the first stable carrying DUP-7 on both
stores, and 30 days have passed: a bare entry exists only in a state an older build left with a
Welcome unsent, and the first connection after the upgrade sends it and rewrites the record. After
removal such a record fails to decode and is dropped, costing at most one invitee's self-repair.

### No date yet - the add-lock released by OWNER alone, with no token (2026-10-25)

**Site (server):** `releaseAddLock` in `apps/chat-delivery-service/src/utils/add-lock.ts`
(`RELEASE_IF_OWNER_LEGACY`), reached by both doors (`DELETE mls/add-lock`, `DELETE
mls/push/release-add-lock`) when the body carries no `token`.
**Site (client):** `MlsDeliveryApi.acquireAddLock` / `releaseAddLock` in
`frontend/src/lib/mls-client/mlsDeliveryApi.ts`: an acquire answered without a `token` (a server
older than this change) is released with none.
**Shim:** since #2426 every acquisition writes `owner#token` and answers the token, and a release
naming it deletes that acquisition or nothing. A release with no token still deletes ANY acquisition
of the same device (the bare `owner` an older server wrote, or a `owner#token` value). It is kept
ONLY for builds older than #2426: web and app clients, and above all the Android background service
of those builds (`CanariFirebaseMessagingService.kt`). Since #2426 that service also reads the token
from the acquire answer and sends it on its release. The legacy path is exactly as blind as before: a
late release can still free a live lock of the same device.
**Removal condition:** `minClientVersion` is at or above the first stable carrying #2426 on both
stores (the Android service of every allowed build then sends its token). After that a token-less
release is refused, not legacy. On the client side, the token-less release (the web client's and the
Android service's) goes once every estate's chat-delivery-service answers the token.

### No date yet - the profile batch answered without `deleted`, by a server older than 2026-10-18

**Site:** `flushProfileBatch` in `frontend/src/lib/stores/user.ts` (`legacyAnswer`).
**Shim (2026-10-18):** `GET /api/users/batch` answers `{ users, deleted }` since #2022, and a client
reading that shape meets an OLDER server whenever the two are not in step - a rolling deploy, a
rollback, a store build live before production deploys. That server sends no `deleted` and answers
an unknown id by its absence, so an answer with the field MISSING is read the old way: absence is
`UserProfileFetchError(404)`, cached, rendered as the unknown-user label, one `console.debug` per
chunk. Without it every absent id counted as a contract breach (`console.error`, 502, never cached)
and `displayName.ts` warned, backed off 120 s and asked again.
**Removal condition:** every estate's core-service sends `deleted` (dev and production both deployed
past #2022, and no rollback below it planned); then the `legacyAnswer` branch goes and a missing
field becomes the breach. A server version, not a client floor.

### No date yet - the presence ids in a URL

**Two halves, two conditions** ([chat-gateway](services/chat-gateway.md#the-ids-travel-in-a-body-never-in-the-url-2026-10-28)).
Since 2026-10-28 the presence read is `POST /api/presence` with the ids in the body; until then it was
`GET /api/presence?users=<id>,...`, which wrote every watched id into every proxy's access log.

**Server half - site:** `get_presence` and `LegacyGetTally` in `apps/chat-gateway/src/presence.rs`,
the `get(...)` on the `/api/presence` route in `main.rs`, and the `/api/presence?query-redacted` rule
of the access-log map (`Dockerfile.frontend`, `access-log-redaction.test.mjs`). **What it humours:**
every install built before the POST client, which keeps calling the GET until it updates - a store
build is not reached by a deploy. **Removal condition:** a CLIENT FLOOR AND A MEASUREMENT -
`minClientVersion` at or above the first stable carrying the POST client, on both estates with both
stores serving it, AND the gateway's `[presence] legacy GET /api/presence served ...` line absent from
production for a week (the tally writes nothing for a window nobody called in, so silence is the
zero). Then delete `get_presence`, `PresenceQuery`, the tally and its `AppState` field, the map rule
and its test cases; a GET is then answered 405 by axum.

**Client half - site:** `fetchPresence`'s `legacyGet` arm and `legacyRouteAnnounced` in
`frontend/src/lib/stores/presenceStore.ts`, `serverPresencePost()` in `appVersionCheck.svelte.ts`,
the `presencePost` field in `appVersion.ts` and in core-service's `version.service.ts`. **What it
humours:** an estate whose gateway predates the POST - production for the days between a stable's
store release and its deploy, and any estate rolled back below it. The client reads the capability
before asking, so it never learns the route by a 405. **Removal condition:** a SERVER VERSION, not a
client floor - every estate's gateway serves the POST (dev and production both deployed past this
change, no rollback below it planned). Then the client always POSTs and the capability field goes from
both sides; a client that no longer reads it is unaffected by a server that still sends it.

### No date yet - `registerMember` after an accepted Add, for a server older than 2026-10-25

**Sites:** every Add path that calls `registerMember` for the people it added once the commit
returned - `processBulkAddition` and `performDirectAdd` in `frontend/src/lib/utils/chat/groupCreation.ts`,
the pending-invitation and `welcome_request` Adds in `frontend/src/lib/utils/chat/actions.ts`.
**Shim (2026-10-25):** the commit gate enrols the people an Add admits IN THE TRANSACTION THAT
ACCEPTS IT (`enrolAdmittedPeople`, [mls-protocol](protocols/mls-protocol.md#an-add-enrols-its-people-with-the-accepted-commit-2026-10-25)),
so against a current server the call after the accept ENROLS NOBODY (ADM-3, 2026-10-25): it writes
the device rows of a person the commit admitted, and answers `409 MEMBER_NOT_ADMITTED` for anyone
else (absent, or a seat still awaiting a member) - typed client-side as `MemberNotAdmittedError`,
on which the caller withholds the Welcome. And the gate refuses WHOLE a commit that would admit a
person it may not (`{accepted: false, reason: 'admit_refused'}`), so no such commit gives anyone a leaf. So a departure or a
member's Decline holds against an Add decided before it on EVERY path, the direct accept included
([mls-protocol](protocols/mls-protocol.md#the-commit-is-the-one-writer-of-a-new-person-adm-3-2026-10-25)).
It stays for a store build live before production deploys, whose server does not enrol with the
commit: dropping it there would lose the enrolment of every Add.
**The one re-invite this used to rescue:** a re-invite right after a Decline, at an unchanged epoch,
by a client that sends no `invitationSeatGeneration` (older than ADM-3), is ordered by the base
epoch and refused; the member re-invites after the next commit. A current client sends the
generation it read and is a fresh invite.
**Why the refusal is an answer in the body, not a status:** a client older than ADM-3 (read in the
`v1.4.0` tag) clears its staged commit on a `200 {accepted: false}` and reports the Add failed, never
retrying it in a loop; a thrown 4xx from `POST /api/mls/commit` would leave that stage in place. So
`admit_refused` takes the shape `WelcomeSeatGone` already answers, and an older client loses nothing
but that one Add.
**Transitional loss, accepted:** an Add the PRE-DEPLOY server accepted with its answer lost, and
settled after the deploy as a `duplicate`, is never enrolled - the duplicate is answered before any
transaction, and the enrolment ran with an advance that predates it. Its Welcome is refused
`WELCOME_TARGET_NOT_MEMBER`, cleared as terminal by a current client (an older client keeps
re-sending it, as before), and the stray sweep REMOVES the leaf - it repairs nothing; the person
needs a new Add.
**Removal condition:** every estate's chat-delivery-service enrols with the commit (dev and
production both deployed past the 2026-10-25 change, no rollback below it planned); then the
post-accept `registerMember` calls go. A server version, not a client floor. The CREATOR's own
`registerMember` before `createGroup` is not this shim - it puts the creator on the roster before the
group exists, and stays.

### No date yet - an OIDC callback with no PKCE verifier

**Site:** `oidcCallback` in `apps/core-service/src/auth/auth.controller.ts`, the branch that logs
`OIDC callback without a PKCE verifier` and redeems the code anyway.
**Shim (2026-10-23):** core-service forwards a `code_verifier` to MiConnect when the client sends one,
and says so in `GET /api/version` (`oidcPkce: true`). A client sends a `code_challenge` only after
reading that capability ([auth](frontend/modules/auth.md#login-flow)), so a callback with no verifier
is one of: a build older than the client half, a new build that read no capability, or a caller that
is not the app.
**The order the two halves ship in, and the constraint it adds:** core-service first, the client
later. A core-service older than the capability DROPS the verifier, and MiConnect refuses a
challenged code redeemed without one, so a client that challenged it could not sign in. The
capability makes a new client facing an old server send no challenge at all. That is a CAPABILITY,
not a fallback: it states what the server CAN do, read before the request, and there is no failed
path behind it. **core-service is never rolled back below the first release whose `/api/version`
publishes `oidcPkce: true`**: a client that read the capability before the rollback still
challenges, and its sign-in fails against the older server until it reads `/api/version` again.
**Removal condition:** `minClientVersion` at or above the first stable carrying the client half, on
both estates with both stores serving it, AND the warning silent on production for a week. Then the
branch becomes a 400, which is what makes PKCE REQUIRED rather than offered. It also needs the
redirect hardening in [backlog](backlog.md#p2---the-mobile-sign-in-returns-through-a-custom-scheme-pkce-binds-the-code-not-the-app-2026-10-23)
to close what PKCE alone does not.

### No date yet - the exclusions route answered without `withheld`, by a server older than 2026-10-22

**Sites:** `entitledHistorySelection` (the inviter's push) and `dropOwnExcludedMessages` (the
receiver), both in `frontend/src/lib/utils/chat/historyEntitlement.ts`, on `WithheldUnsupportedError`
(thrown by `MlsDeliveryApi.getGroupWithheld`) and on nothing else.
**Shim (2026-10-22):** a server that predates the field answers the exclusions route without
`withheld`, which is an ordinary state while a store build runs ahead of production. Both sites then
do exactly what they did before the field existed. The push filters on the union of gaps, so a
continuous member's new device and a 1:1 keep their restore. The receiver filters on its own gaps.
**What it costs:** in that window a genuine newcomer to a group conversation is still pushed what
preceded their arrival - the leak the field exists to close, unchanged from before it. That is why
the push's branch is a FALLBACK and accuses: one `console.error` per session. The receiver's line is
per bundle. Every other failure of the read still sends and ingests nothing.
**Removal condition:** every estate's chat-delivery answers `withheld`; then both branches go and the
error is an ordinary refusal. A server version, not a client floor.

### No date yet - the exclusions route answered without `addressedAnswers`, by a server older than step A

**Site:** `readerHistorySelection` in `frontend/src/lib/utils/chat/historyEntitlement.ts`, on
`addressedAnswers !== true` and on nothing else
([history-answer-addressing](protocols/history-answer-addressing.md), rule 2).
**Shim (2026-10-22):** a server that predates step A refuses an addressed conversation frame, so
every history answer - the push, the diff, the scrollback - is sent as the broadcast it was before,
filtered on the union of gaps (plus the invitee's span on a push).
**What it costs:** against such a server the answer is a broadcast, filtered on the union of gaps
and, on the receiving side, on that receiver's own windows. It is a FALLBACK and accuses: one
`console.error` per session.
**Removal condition:** every estate's chat-delivery answers `addressedAnswers: true`; then the branch
and `entitledHistorySelection` go. A server version, not a client floor.

### No date yet - history answers and asks from clients older than step A

**Sites:** none to delete on the new client: an older client still asks without a `requestId` and
answers by broadcast. A new answerer sends nothing addressed to an ask with no id
(`sendBundleChunks`), and a new receiver drops from a broadcast bundle what falls in its own windows
(`dropOwnExcludedMessages`).
**What it costs:** a product choice: an older client is answered only by older peers, until
`minClientVersion` carries step A.
**Removal condition:** `minClientVersion` is a release carrying step A; then the broadcast branch of
the `history_bundle` receiver and the no-id refusal line can go.

### No date yet - a plaintext native cache, written by a build older than the at-rest seal

**Sites:** `open_file` and `open_line` in `frontend/src-tauri/src/native_cache.rs` (the `Plaintext`
arm), `migrate_legacy_files` and `seal_legacy_seed_mirror` there, and `remove_legacy_channel_keys`.
**Shim (2026-10-22):** the seed mirror (`graine_seeds.json`) and the push cache
(`fcm_message_cache*.ndjson`) are sealed at rest since the release carrying this change
([mobile](frontend/mobile.md#the-native-caches-are-sealed-at-rest-and-kept-out-of-backups-2026-10-22)).
A file or line with no seal marker is what an older build wrote, and is read as such. The mirror is
sealed on its first pass, and the legacy `channel_keys.json` is deleted. A plaintext cache line is
taken once and never written back. **What keeps writing plaintext is an OLDER BUILD still
installed:** its push service, or on iOS its notification extension writing into the App Group
until the app updates.
**Removal condition:** `minClientVersion` at or above the release carrying this change, on both
estates, with both stores serving it. No floor client writes plaintext then, and every install
that ran the new build once has had its files sealed. After that the `Plaintext` arms become a
refusal (`SealError`), and the three migration functions go. A client floor, not a server version.

### No date yet - a stored `paymentMethod` of `stripe`, written before the Stripe removal

**Site:** `PurchasePaymentMethod` in `apps/social-service/src/users/entities/purchase-record.entity.ts`,
`Submission.paymentMethod` in `apps/social-service/src/forms/entities/submission.entity.ts`, and the
`'stripe'` arms of the client's `paymentMethod` types and labels (`EditAchatsTab`,
`EditDelegationTab`, `account/purchases`).
**Shim:** purchase rows AND form submissions written before 2026-10-08 hold `stripe`, read as
`online`. Nothing writes `stripe` any more, and since floor 1.2.7 nothing may SEND it either: the
form input and the `fr.emse.canari://stripe` return host are gone ([stripe-archive](stripe-archive.md)).
**One known cost of the host's removal:** a checkout STARTED on a build from 1.2.0 to 1.2.3 (Lydia
already, `stripe` host still) and finished after the phone updated returns to a host the new build
no longer registers - the payment itself is recorded server-side, only the in-app landing is lost.
The server's refusal of a `stripe` callback URL is logged (`[CHECKOUT] callback URL REFUSED`).
**Removal condition:** data at rest, so a data migration of `purchase_records` AND `submissions`
(`stripe` -> `online`), counted first, and no version: then the type and the client arms go.

### No date yet - MiConnect's `formation` and `promo` claims, derived from the profile

**Site:** the scope mappings `miconnect-claim-formation` and `miconnect-claim-promo` in
`infrastructure/authentik/blueprints/10-mappings.yaml`; and the old attribute keys `formation`,
`promo` and `school_status`, still written by enrolment and left in place by the migration.
**Shim:** since WP1 (profile reform) the profile holds a LIST of cursus and posts
([profiles-and-access](profiles-and-access.md)). Every application still reads one `formation` and
one `promo`, so both claims are the FIRST cursus - a person with two cursus shows only the first.
**Removal condition:** WP9 - every application reads `cursus` / `posts` / `campus` and no longer
requests the `formation` or `promo` scope. Measured then on authentik's access log: no
`/authorize` naming either scope for a week.

### No date yet - the Graine v1 reader: a salon row with no signature, under a session with no endorsement

**Site:** `openChannelMessage` in `frontend/src/lib/utils/graine/channelSeal.ts`, the `openWithGraine`
branch taken when the session carries no `v2` block; its native twin is `open_graine_message` in
`src-tauri/src/mobile/graine.rs`. `storeIncomingSeed` REFUSES a new v1 seed since 2026-10-11
(step one below, [channel-encryption 21.7](protocols/channel-encryption.md#217-an-arriving-v1-seed-is-refused-wp-g2-5b---the-floor-reached-the-writer-2026-10-11)); a held one still opens.
**Shim:** Graine v2 (channel-encryption section 21) binds a row to its salon, author and index and
signs it. A v1 row proves none of that, and a v1 seed names no minter. v1 is kept because every row
written before the v2 writer is v1, and they stay readable for as long as they are kept.
The v1 WRITER is already gone (G2-5): `sealWithGraine` lives only in the test fixture
`crypto/graine.testSeal.ts`, so this entry is a reader alone.
**Removal condition, in two steps (user, 2026-09-28):**
- DONE (floor `1.0.3`, 2026-10-11): a v1 seed that ARRIVES is refused, since a modified client
  could otherwise keep minting v1 sessions to forge an author. An unsigned row under a session not
  held is `GraineV1SessionNotHeldError` and asks nobody;
- the v1 READER goes when no v1 row is left:
  `SELECT count(*) FROM channel_messages WHERE "signature" IS NULL AND "senderSessionId" IS NOT NULL`
  on production answers 0. Rows age out of the 365-day window, so that is at most a year after the
  writer ships. A count, not a date: a salon nobody prunes keeps its rows. **Since the server refuses
  an unsigned row (2026-10-13, see the section below) that count can only fall**, so a 0 stays 0.
  **Measured 2026-10-14 on production: 373 rows in 15 salons, none pinned**, oldest 2026-09-02,
  newest 2026-10-09. A pinned row escapes the retention purge, so pinning one of them would hold the
  count above 0 after the date: then name the salon, as the section below says.
  On the same day, `channel_messages."signature"` becomes `NOT NULL` (a migration), and the DTO's
  `signature?` and the `?? null` in `ChannelService.sendMessage` go with it.

### No date yet - a restored private message with no author signature, from a client before signed authorship

**Site:** `vetRestoredMessage` in `frontend/src/lib/utils/chat/restoredAuthorship.ts`, the
`unverified` verdict, and the `restoredUnverified` marker it writes (`MessageMetadata.svelte`).
**Shim:** a `history_bundle` message with no author proof is KEPT and drawn normally, under a small
"non verifie" marker that explains itself on tap ([history-reconciliation](protocols/history-reconciliation.md#restored-history-carries-its-authors-signature-2026-10-22)).
It exists because every message a client sent before signed authorship carries no proof, and
hiding them would empty restored history.
**What is NOT shimmed (lead decision, 2026-10-22):** an edit, deletion or reaction in a bundle
still needs its author's signature, and an unsigned one is dropped. The cost is accepted: a
mutation made by an author on an older client is missing from restored history until that author
updates (their later, signed mutations travel normally).
**Removal condition:** `minClientVersion` is a signing build on BOTH stores, AND the oldest unsigned
message has left every retention window that can still restore it. Then an unsigned message is
refused like any other proof-less entry, and the marker, its strings and the `restoredUnverified`
field go with it.

### No date yet - the salon push HELD for its seed, for a sender that attaches no seed frame

**Site:** `CanariFirebaseMessagingService.handleChannelMessage`, the branch after `openSeedFrame`
answers null: `PENDING_CHANNEL_FRAMES`, `PENDING_CHANNEL_LOCK`, the `genericStamp == 0` claim in
`drainPendingChannelFrames` and `arrivedMeanwhile`. On the server, `assertSeedFrame` accepting a
message with neither field.
**Shim:** since [channel-encryption §19](protocols/channel-encryption.md) every message carries the
MLS frame that distributed its session's seed, and the phone opens it when the mirror misses. A
sender older than that attaches nothing, so its first message still races its seed push, and the
generic banner held and redrawn (§14) is what covers it. Since §19 both pushes run on the one MLS
lane, so the lock and the in-flight claim guard a window that can no longer open.
**Removal condition:** `minClientVersion` at or above the first release that sends `seedFrame`. Then
`seedFrame` / `seedGroupId` become REQUIRED on a non-silent message (a typed refusal, like
`CHANNEL_SESSION_REQUIRED`), and the hold, the registry, its lock and the drain go with it - a
mirror miss with no frame becomes a line that accuses, not a path.
**Cost of keeping it:** eight map entries at most and a redraw nobody on a current build reaches.
The hazard is the redraw itself: it is the defect §19 removes, alive for exactly this population.

### No date yet - the `read_receipt` system event, accepted from clients that predate the watermark

**Site:** `systemMessageHandler.ts`, the `event === 'read_watermark' || event === 'read_receipt'`
branch - the second name, and the `watermarkAfterReading` conversion behind it.
**Shim:** before `0db47a87` (2026-08-12) read state travelled as a LIST OF MESSAGE IDS. The app has
sent an instant ever since, and as of 2026-08-31 so does the native notification shade, which was
the last emitter of the old shape anywhere in this repo. Incoming `read_receipt` frames are still
translated: the ids we hold give the instant directly, and ids we do not hold say nothing we could
have acted on anyway.
**Why it is not just "old clients":** a `read_receipt` is a MESSAGE, so it can arrive from any peer
running any build, and history replay can hand one back long after every device has updated. The
population is not "installs older than X", it is "frames older than X", which no version gate
retires.
**Removal condition:** `minClientVersion` at or above the first release carrying the native
watermark AND no `read_receipt` observed in a history bundle for a full retention window (90 days),
because a stored frame outlives the client that wrote it. Until someone measures the second half
this entry has no date - a date here would be a guess about what is sitting in the frame table.
**Cost of keeping it:** one string comparison and one `watermarkAfterReading` call on a branch that
already runs. It is cheap; what it must not become is the reason nobody notices that the two names
mean subtly different things - ids are a SET and an instant is an ORDER, and the translation is
lossy in exactly one direction.

### No date yet - the refresh COOKIE accepted from a `tauri://localhost` client

**Site:** `presentedRefreshToken()` in `apps/core-service/src/auth/auth.controller.ts` - the last
`return cookie` after the header has been found absent.
**Shim:** a client on the custom-scheme origin is expected to carry its refresh credential in
`X-Canari-Refresh` (`refresh-transport.ts`), because WKWebView drops the third-party cookie -
measured on prod 2026-08-27, `cookies=[]` on 120 consecutive refreshes from one iPhone. When that
header is absent the cookie is still read.
**Why it is not just "old iOS clients":** `tauri://localhost` is ALSO the macOS and Linux desktop
origin, and nothing has ever measured whether their engines keep the cookie. (No Linux desktop
artifact SHIPS since 2026-09-03, but the origin is a property of the engine and returns with anyone
who builds that target locally, so the shim's population is unchanged in kind.) If they do, refusing it
here would log every desktop install out on the deploy that introduced the header - so the shim is
covering an unknown population, not only an old one.
**Removal condition, and it has two halves:** (1) `minClientVersion` is at or above the first release
carrying `nativeRefreshToken.ts`, so no client on that origin predates the header; AND (2) desktop
persistence has been MEASURED on macOS and Linux - if the cookie works there, that platform keeps it
and the removal is instead a narrowing of `BODY_TRANSPORT_ORIGINS`, not a deletion. Until (2) exists
this entry deliberately has no date: a date would be a guess about a platform nobody has run.
**Cost of keeping it:** one header read and one cookie read per refresh. The hazard is not cost, it
is that a client sending neither looks identical to one sending a stale cookie, which is why the
refusal already logs the cookie names it received.

### No date yet - the two paid-form tier codes of #2667, on an embedded build that predates them

**Site:** `providerRefusalMessage` in `frontend/src/lib/associations/paymentRefusal.ts`, read by the
paid form page (`frontend/src/routes/forms/[id]/+page.svelte`); the codes come from `formTierRefusal`
(`apps/social-service/src/associations/tier-pricing.ts`).
**What an older build shows:** the APK and the IPA EMBED the frontend, so a build older than the
release carrying #2667 does not know `FORM_TIER_NOT_SOLD` (a form granting a tier whose product was
deleted) or `FORM_TIER_ALREADY_HELD` (a submitter already holding the form's tier): `providerRefusalMessage`
answers null and the form page shows the server's English `message` instead of the fr/en sentence.
The refusal itself holds on every build - no money is taken; only the wording differs. Before #2667
those builds got the shop's codes (`TIER_NOT_RANKABLE`, `PRODUCT_ALREADY_PURCHASED`) and their sentences.
**Removal condition:** none, nothing on the server humours old builds; the line is right everywhere
once `minClientVersion` covers the release carrying #2667 (both stores serving it). Do not map the
codes back to the old ones to cover the gap: those sentences were the wrong ones.

### Removed 2026-10-22 - the pre-MLS send path; the `content` column and its read arm wait for a migration

**Removed per measurement, 2026-10-22**, ahead of the 2026-11-19 date, which was conditional on
silence: `POST /mls/send` refuses a send with no `proto` (`proto_required`, 400), and the `else` arm of
`MessagingService.sendMessage` refuses too instead of fanning out over `dm_group_members`.
**The measurement that replaced the date:** `queued_message` held 0 rows with `proto` NULL and 0 with
`content` set out of 278 717, from 2026-08-21 to 2026-10-21; the live chat-delivery log held 0
`LEGACY_CONTENT_PATH` lines against 596 sends. The queue records only what was undelivered, so this
is strong rather than a census. An optional confirmation, not a blocker, is the user's one-off count
over the 30-day deploy-log archive ([backlog](backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).
**Still owed, in their own migration:** the `QueuedMessage.content` column
([`queued-message.entity.ts`](../../apps/chat-delivery-service/src/entities/queued-message.entity.ts))
and the read side, `queued.proto ?? queued.content ?? ''` in `push.controller.ts`, which logs
`LEGACY_CONTENT_ROW` at warn if a row ever carries it. Then this entry goes.

### 2027-04-25 - a salon access rewrite with no `baseAccessRevision`

**Site:** `ChannelService.updateChannelAccess` (`ignoredDrops`) in
[`apps/social-service/src/channels/channel.service.ts`](../../apps/social-service/src/channels/channel.service.ts),
and the optional `baseAccessRevision` of `UpdateChannelAccessDto`.
**Shim:** since 2026-10-25 the settings panel sends the access revision it edited, and a stale one is
refused `409 CHANNEL_ACCESS_CHANGED` ([social-service](services/social-service.md#an-access-rewrite-names-the-revision-it-edited-2026-10-25)).
An older client sends none, and its list is the one it read when the tab opened, so it proves
nothing but the name it appended. `baselessAllowList` reads the request as the one gesture of the
`v0.18.29` panel (every client the `1.0.3` floor admits) it can be: on a salon that stays private,
Add grants its LAST element only and a write-policy save grants nothing, and nobody is ever dropped
(that panel removes through the per-member `DELETE`, unchanged); a request that flips the visibility
WITH a write policy, or goes private WITH a list, read the other visibility and is refused `409`.
**What it does not cover:** a stale TOGGLE - a panel that read private, while another admin made the
salon public and private again, can still flip it; the toggle carries nothing that tells.
**Why a date and not the floor alone:** the panel ships inside the phone apps, which update when their
store decides; six months, as for the push wording above.
**On removal** (the date, or earlier once `minClientVersion` is a build carrying the base): make
`baseAccessRevision` required (a `400` without it) and delete `baselessAllowList`. Its warn line,
`baseless rewrite (client older than the access revision)`, measures the traffic first.
**Cost of keeping it:** an old client cannot remove anyone through a PATCH - which it never did.

### 2027-02-19 - a server-composed `title` / `body` on social and form pushes

**Site:** `PushContent.legacyTitle` / `legacyBody` in
[`apps/social-service/src/push/push-content.ts`](../../apps/social-service/src/push/push-content.ts),
passed through by `PushService.notifyContent`.
**Shim:** since 2026-08-19 those pushes carry `contentKey` + `actorName` + `contentArg`, and the
device writes the sentence from its own two-language table. Clients built before that read `title`
and `body` and know nothing of the key, so both are still sent, in the wording they had - French for
the post notifications, English for the form reminders.
**Why a shim rather than a clean break:** dropping the two fields does not degrade an old client, it
BLANKS it - `data["body"] ?: ""` on Android, `content.body` left as the empty alert on iOS. Every
phone installed today would show a notification with no text, and nothing would say why.
**Why the date is six months out, not three:** an Android or iOS user updates when their store
decides to. The other entries here are protocol shims between a client and a server that deploy
together; this one waits on app installs.
**On removal:** delete the two fields from `PushContent` and its six builders, have `notifyContent`
call `notify` with empty title and body exactly as the MESSAGE push path already does, and delete
the `?: data["title"]` arms in `CanariFirebaseMessagingService.composeServerNotification`'s caller,
`NotificationService.applyServerContent` and `CanariComposeServerNotification`. All three already
log when they take that arm, so the traffic is measurable before the date rather than guessed at.
**Cost of keeping it:** two short strings per push, and a real hazard the log answers - while both
halves are sent, a key missing from a native table is invisible, because the phone silently shows
the server's wording and it looks deliberate. `nativeStrings.test.ts` is what closes that.

### 2026-11-13 - history rows with no `sender_device_id`

**Site:** `historyTypes.ts` (`HistoryStreamRow.sender_device_id?`) and the `kind === 'own-message'`
arm of the replay's catch in `frontend/src/lib/utils/chat/history.ts`.
**Shim:** the replay skips a row whose `sender_device_id` is this device before offering it to MLS. A
row written before 2026-08-15 has no such field, so it still reaches MLS and is still recognised by
its refusal - `CannotDecryptOwnMessage`, classified at the throw in `mls-core`. That arm is the shim;
the skip is the mechanism.
**Why the field and not `sender_id`:** the archive is ONE stream per group and must hold this
device's own frames, because every other member reads it. The user cannot discriminate - the same
account's other device wrote frames that are both decryptable and wanted. Only the device can.
**On removal:** delete the `ownFramesSkipped++` line in the catch, keep the classification itself,
and make `sender_device_id` non-optional in `HistoryStreamRow`.
**Cost of keeping it:** none in traffic. The old rows are still handed to MLS to be refused, which is
what happened before the field existed; the fix only stopped that from being the design.

### 2026-11-15 - `remove_reaction` as a system event

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the
`remove_reaction` branches.
**Shim:** both branches translate the old frame into `applyReaction(..., removed = true)`, dated with
the entry's own delivery time because that frame shape carries no timestamp of its own.
**Replacement:** taking a reaction back is the SAME `ReactionMsg` that placed it, with `removed` set -
so both legs of one operation have one shape and both carry the `at` the merge orders on.
**On removal:** delete both branches, and drop `remove_reaction` from the silent-event list in
`proto_fields.rs`.
**Cost of keeping it:** a removal replayed from an old stream entry is ordered by its delivery time
rather than by the sender's clock. Only distinguishable if a placement and its removal were sent
within the same delivery, which cannot happen - the outbox serialises them.

### 2026-11-15 - `pin`/`unpin` with no `at`, and a pinned set stored as a bare array

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the `pin`/`unpin`
branches; `mergePinEntries` and `parseStored` in `pinStore.svelte.ts`.
**Shim:** three readings of the same missing clock. An undated frame arriving LIVE is dated on
receipt - later than anything held, the right answer for a frame arriving now and the only one
available. An undated frame REPLAYED is dated by its position in the shared log
(`parseServerTimestampMs`), the best clock a replay has. A `pins` array of bare id strings - the shape
shipped for one commit on 2026-08-16, and the shape of every `canari_pins_*` entry written before it -
is read at `at: 0`, so any dated statement about the same message beats it.
**Replacement:** the frame carries `at` on both legs, exactly as a reaction's two legs do, and the
register is a last-write-wins entry per message with dated tombstones for the unpins.
**On removal:** delete the three `Number(data.at) ||` fallbacks, the `typeof raw === 'string'` arm of
`mergePinEntries`, and the `Array.isArray(parsed)` arm of `parseStored`.
**This one has a SECOND store behind it, and the date does not cover it.** `canari_pins_*` is
`localStorage` on each device, which nothing on the server can reach and no retention window bounds.
The `Array.isArray` arm may only go once every device has rewritten its own entry - which happens on
the first pin change in each conversation - so on the date, delete the two frame-shape fallbacks and
re-read that arm as its own question.
**Cost of keeping it:** an undated pin loses every tie against a dated one, so a device that pinned on
an old client and a device that unpinned on a new one converge on unpinned even if the pin came
second. The user can always pin again; the reverse - a resurrected pin nobody can explain - is the
outcome the dating exists to prevent.

### 2026-11-15 - `read_receipt` naming message ids

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the `read_receipt`
branches; and the per-message `readBy` / `readAt` still sitting inside encrypted rows written before
the change.
**Shim:** a receipt is translated into a watermark - the latest instant among the named messages THIS
DEVICE HOLDS. An id it does not hold contributes nothing, which is the only honest reading: the frame
names messages, and without one there is no instant to compare against.
**Replacement:** `read_watermark`, one monotone instant per participant merged as `max`. See
[history-reconciliation](protocols/history-reconciliation.md#read-state-becomes-a-watermark).
**On removal:** delete both branches and the `event === 'read_receipt'` half of their conditions.
Nothing else has to move - the stored `readBy`/`readAt` are already ignored on read, and the watermark
column is additive (SQLite v6).
**Cost of keeping it:** a receipt for messages this device never had reads as no read state at all,
where the sender did read something. It corrects itself on the next watermark that peer sends.

---

### 2026-12-15 - a visible system notice with no `message_id`

**Site:** `systemMessageHandler.ts` (the `messageId?` field of `SystemEventContext`, undefined for an
old frame) and `historySystemEvents.ts` (`parsed.messageId || undefined`). Both then let
`addMessageToChat` mint a `crypto.randomUUID()`, which is the pre-2026-09-16 behaviour.
**Shim:** none is written as a branch - the shim IS the undefined, and what it buys is that an old
frame still draws its notice instead of being dropped.
**Replacement:** `mkVisibleSystem` (`proto/codec.ts`) mints the id at the SENDER, once, so the live
path, the archive replay and a peer's `history_bundle` all write one row for one event. See
[chat](frontend/modules/chat.md#a-visible-system-notice-needs-an-identity-the-sender-minted).
**Two conditions, not one, and the date covers only the second.** A LIVE PEER below the version that
ships this keeps sending id-less frames, and that half is retired by `minClientVersion`, not by a
date. The ARCHIVE holds id-less rows written before it, and those are trimmed by `XTRIM ... MINID` at
`RETENTION_WINDOW_MS` (90 days) - hence 2026-12-15.
**On removal:** make `messageId` required on `SystemEventContext`, drop the `|| undefined` in the
replay, and delete this entry.
**Cost of keeping it:** exactly the defect this replaced, confined to old frames - a notice from
before the change still duplicates once per replay and once per bundle. **Nothing repairs the rows
already on disk**; see [backlog](backlog.md).


---

## Nothing to remove - a calendar subscription saved before D40 now gets a 400 (2026-10-05)

**This is a BREAK, not a shim, and there is no code to retire later.** `GET
/api/associations/calendar/feed.ics` and the anonymous `calendar/feed` now REFUSE a read that names no
campus, formation, `associationId` or `eventId`: a 400 with code `AGENDA_SELECTION_REQUIRED`
(`assertAgendaSelected`, `associations/directory-query.ts`). The user chose this on 2026-10-05,
knowing it (user decision, D40: no per-user URL, no fallback to "everything").

- **Who is affected:** anyone who subscribed to the WHOLE agenda before this release - a calendar
  app polling the bare `feed.ics?from=..&to=..` URL, or one pasted into Google Calendar. Their
  calendar stops updating (the app shows an error or an empty calendar) until they subscribe again
  from `/calendar`, whose modal now asks for a campus and/or formation. A subscription to ONE
  association (`?associationId=`) and the one-event link (`?eventId=`) are NOT affected. Nothing is
  lost server-side. An app installed before this release embeds the old frontend, so its subscribe
  modal and PDF export keep building the bare URL until it updates (the signed-in JSON feed keeps
  answering: it is narrowed to the reader's spaces).
- **Why nothing is removed later:** the refusal IS the rule. The day nobody has a bare URL saved it
  merely stops being hit; no branch waits to be deleted.

## Nothing to remove - an UNSIGNED calendar subscription now gets a 403 (2026-10-06)

**A second BREAK in two days, and again no shim.** `feed.ics` and the anonymous `calendar/feed` now
REFUSE a `campus` / `formation` / `associationId` selection that carries no valid `sig`: a 403 with code
`AGENDA_SIGNATURE_REQUIRED` (absent) or `AGENDA_SIGNATURE_INVALID` (wrong), `associations/agenda-signature.ts`.
The user decided it on 2026-10-06 ([D40 amended](profiles-and-access.md#d40-amended---the-selection-is-signed-and-only-the-readers-own-spaces-are-signed-2026-10-06)):
a subscription is restricted to the reader's own spaces by a signed URL, and the old ones are NOT honoured.

- **Who is affected:** every calendar subscription saved from `/calendar` between the D40 release
  (selection URLs `?campus=..&formation=..`) and this one, and any association subscription saved
  before (`?associationId=..`). The calendar app shows an error or an empty calendar until the reader
  subscribes again from `/calendar` or the association's page; the modal says so (`calendar_subscribe_old_links_notice`).
  The single-event link (`?eventId=`) is NOT affected. An installed app embeds the old frontend, so its
  modal builds unsigned links until it updates: they are refused.
- **Why nothing is removed later:** the signature IS the rule. Rotating `AGENDA_SIGNING_KEY` repeats this
  break on purpose (it is the revocation) and needs no code.

## Nothing to remove, revisit 2027-10-13 - an UNSIGNED salon row now gets a 400 (2026-10-13)

**A BREAK, not a shim.** `POST /api/channels/:channelId/messages` refuses a row with no Graine v2
`signature`: a 400 with code `CHANNEL_SIGNATURE_REQUIRED`, logged `[CHANNEL_SIGNATURE] REFUSED` at
ERROR (`ChannelService.assertSigned`,
[channel-encryption 21.8](protocols/channel-encryption.md#218-the-server-refuses-an-unsigned-salon-row-2026-10-13)).
It became possible when `minClientVersion` reached `1.0.3` (2026-10-11), the first release that
signs every row.

- **Who is affected:** no admitted client. A build below `1.0.3` cannot unlock MLS, so it cannot
  seal a salon row at all. The only sender left is a process unlocked BEFORE the floor rose and still
  running older code: its salon send shows the generic refusal and is not retried. And a modified
  client minting v1, which is the point.
- **The constraint it adds:** the floor must never go back below `1.0.3`. §21.7 already required it.
- **Why nothing is removed later:** the refusal IS the rule. **Revisit on 2027-10-13** (365 days after
  this refusal, the retention window): every unsigned row predates it, so the count in the v1-reader
  entry above should then read 0. That is when the v1 reader, the nullable column and the optional
  DTO field go together - and if it does not read 0, the salons keeping the old rows are named, not
  the date.

## Nothing to remove - a call media frame is v2 only (2026-10-21)

**A wire BREAK, and no shim, because no production client ever placed a call.** Call media is now
sealed under one key PER DIRECTION, `exportSecret(groupId, 'mls-webrtc-media-v2', '<callId>|<sender
role>', 32)` (`frontend/src/lib/utils/callKeys.ts`), and every frame's AES-GCM additional data starts
with `canari-call-v2|<audio|video>` (`frontend/src/lib/utils/callFrameAad.ts`). Before it, both
directions shared one `mls-webrtc-media` key and audio carried no additional data
([calls](frontend/modules/calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only)).

- **Who is affected:** a call between a build carrying this change and one older than it - only dev
  builds and tester pre-releases, since `CALLS_COMPILED` is still `false` on production. Neither end
  decrypts the other: after 100 failed frames the newer end logs `ERROR E2E key mismatch` and shows
  the `call_e2e_key_mismatch` notice; the older end hears silence. Both phones updated cures it.
- **Why nothing is removed later:** no reader of the old frame was kept, so there is nothing to
  retire. **The constraint it adds:** the day `CALLS_COMPILED` flips, the `minClientVersion` raise the
  owner decided (both stores serving the release) is what keeps a pre-v2 tester build out of a
  production call.

## No date - `GET /api/mls/history/:groupId` answering with a bare array

**The gate does not reach this one, and the page used to claim it did.** Retiring it is not a matter
of which clients are alive: **the replacement has never shipped**. Every deployed client, 0.14
included, reads the head out of `X-History-Head`, so changing the body today breaks the current fleet
rather than an old one.

**Site:** `MessagingController.getHistory` (the body stays `Record<string, unknown>[]`, the stream
head goes in the `X-History-Head` response header) and `MlsDeliveryApi.fetchHistory` (a page whose
`head` is `undefined` walks unbounded, exactly as before).
**Replacement:** the page IS `{ rows, head }`, one shape for both routes, and the head is not
optional - a walk always knows its upper bound. The batch route already has it: its response was
always an object, so `heads` was simply an added field.
**Condition, in order and it is a chain:** ship `{ rows, head }` and a client that reads it in some
release **R**; raise `minClientVersion` past **R**; then delete.
**On removal:** return `{ rows, head }` from the GET, delete the `res.setHeader` and the
`@Res({ passthrough: true })` it needs, drop `X-History-Head` from `exposedHeaders` in `main.ts`, and
make `HistoryPage.head` required.
**Why the header needs the CORS entry, for whoever ships R:** the app runs cross-origin under Tauri
(`http://tauri.localhost`), and a response header absent from `Access-Control-Expose-Headers` is
invisible to the client reading it. Without that line the bound would have been silently missing on
mobile only - green build, green deploy, wrong behaviour.
**Cost of keeping it:** two shapes for one concept, and a head typed optional at every use site
though the server always sends one. No correctness cost: a missing head means an unbounded walk,
which is what every client did before the bound existed.

---

Retired shims are not listed here. Each one's story is in `CHANGELOG.md` at the release that removed
it - `history_bundle` with no `to` and `history_request` with no `withDigest` on 2026-08-12,
`history_bundle` with no `since` on 2026-08-17.
