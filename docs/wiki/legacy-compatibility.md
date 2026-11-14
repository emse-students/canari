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

## The floor rule: raised when both stores serve the latest update (owner, 2026-10-24)

**`minClientVersion` is raised, on both estates, to the latest stable as soon as BOTH Play AND the App
Store serve it** - read with `bun tools/play-vitals/vitals.mjs` and the App Store state, never inferred.
It replaces every per-entry "the user's gesture, when the time comes": a removal condition below names
the version the floor must pass, and this rule is what moves the floor there. The raise is a production
setting, so it is done by the owner or with the owner's go, and written into the entry it unblocks.

**The floor is `1.6.6` on both estates**: production by the owner's raise of 2026-11-08, dev by the lead on
the owner's go of 2026-11-09, once Play and the App Store both served `1.6.6`. This line was merged with the pull request that removes
the shims below, and that pull request was armed only after `GET /api/version` read
`minClientVersion: "1.6.6"` on production AND on dev - so from its merge it states a read, not an
intention. Before it, both estates read `1.6.2` (2026-11-04; read again unchanged on 2026-11-08
before the raise). An older figure on this page is the floor at the date its entry names.

### A tolerated degradation: an unbounded booking space on a build older than migration 153 (owner, 2026-11-09)

- **What.** A booking space may have NO longest booking (`maxSteps` NULL, migration 153, #3196), and a
  new one starts so. A build that predates it reads `maxSteps ?? 1` (`bookingUnitLimit`): a booker
  can pick ONE step only on such a space; and its organiser editor treats an empty `maxSteps` as
  required, so it cannot save that space's settings.
- **Who.** Native apps at or above the floor `1.6.6` but older than the release carrying #3196 (they
  embed their own frontend); the web app is always current.
- **Why tolerated.** The wrong reading is a smaller choice, never a wrong booking: the server judges
  every range (`rangeLengthRefusal`), and the organiser can still edit on the web or an updated app.
  Gating the server on a client version would defeat the owner's rule that nothing limits unless the
  organiser typed it.
- **Removal.** Nothing to remove (no shim in the code): the degradation ends when `minClientVersion`
  passes the first stable carrying #3196, and this entry is then deleted.

### A tolerated degradation: a media caption edit read by a build older than the caption edit (owner, 2026-11-11)

- **What.** A media message's edit replaces its caption only, in the unchanged `edit_message` frame
  ([chat](frontend/modules/chat.md#a-media-messages-edit-is-a-caption-edit-2026-11-11)). An older
  build applies a non-empty caption edit in a DM or group like this build, through
  `applyEditToBody`'s media branch (`v0.18.18`). It keeps the OLD caption, unmarked, on any caption
  edit in a salon (its `applyChannelEdit` refuses every non-text target). An emptied caption in a DM
  or group gives **either result on one old build**: the live and replay paths drop `''` (truthiness
  check, old caption kept), while a history bundle carrying the author's signed edit goes through
  `vetRestoredEdit`, which takes any string and stores `caption: ''` (photo bare, marked).
- **Who.** Native apps at or above the floor `1.6.6` but older than the release carrying the caption
  edit; the web app is always current.
- **Why tolerated.** It is a stale caption, never a lost or corrupted attachment: no build at the
  floor writes an edit's text over a whole body. A new wire field would not have reached those builds
  either.
- **Removal.** Nothing to remove (no shim in the code): the degradation ends when `minClientVersion`
  passes the first stable carrying the caption edit, and this entry is then deleted.

### A tolerated breakage: an institution post from a build older than the reach (owner, 2026-11-10)

- **What.** An institution's post must carry a reach (migration 162,
  [profiles-and-access](profiles-and-access.md#an-institutions-reach-per-post-as-built-owner-2026-11-10)):
  the server answers a create without one `400 institution_reach_required`. A build that predates the
  reach sends none, so it **cannot publish as an institution at all**; a personal, association or
  list post is untouched, and so is an EDIT (absent leaves the stored reach alone).
- **Who.** Native apps older than the first release carrying the reach (they embed their own
  frontend), for the officers of an institution only; the web app is always current.
- **Why accepted knowingly.** The owner's decision is "no default": a server that filled one in for
  an old client would publish a reach nobody chose, which is the thing decided against. The refusal
  is typed (the old build, which does not know the code, shows its generic publish failure), and an
  update or the web publishes.
- **Where it lands on a current build.** A post queued by an old build and published after the
  update meets the same refusal; the durable queue holds it as FINAL (`retryCannotCure`) and offers
  Delete alone, never an endless Retry.
- **Removal.** Nothing to remove (no shim in the code): the breakage ends when `minClientVersion`
  passes the first stable carrying the reach, and this entry is then deleted.

### A tolerated breakage: an institution event from a build older than the event reach (owner, 2026-11-13)

The events twin of the entry above.

- **What.** An institution's calendar event must carry a reach (migration 165,
  [profiles-and-access](profiles-and-access.md#an-institutions-reach-per-calendar-event-as-built-owner-2026-11-13)):
  the server answers a create without one `400 institution_reach_required`. A build that predates the
  event reach sends none, so it **cannot file an event as an institution at all**; an association's
  event is untouched, and so is an EDIT (absent leaves the stored reach alone).
- **Who.** Native apps older than the first release carrying the event reach, for the people who
  file an institution's events only; the web app is always current.
- **Why accepted knowingly.** The posts' precedent: "no default" - a server that filled one in for
  an old client would file an event to a reach nobody chose. The refusal is typed, and the old build
  shows its generic deposit failure; an update or the web files it.
- **Removal.** Nothing to remove (no shim in the code): the breakage ends when `minClientVersion`
  passes the first stable carrying the event reach, and this entry is then deleted.

### Entries `1.6.6` retires or unblocks (the owner's raise of 2026-11-08)

"Carried by" is the first stable whose history holds the pull request (`git tag --contains` on its
squash commit as it sits on `main` - the `mergeCommit` GitHub reports for an older pull request may
no longer be on `main`, so read the commit by its `(#N)` subject:
`git log origin/main --format='%H %s' | grep -E "\(#N\)$"`, anchored on the SUBJECT - `git log --grep`
also matches commit BODIES, so a later commit that merely cites `#N` would be taken for it). **A removal REFUSES what an older
build sends, so it deploys only to an estate whose floor already reads `1.6.6`.**

| Entry | Carried by | Disposition at `1.6.6` |
| --- | --- | --- |
| `GET /api/associations/spaces/audiences`, the whole-table rule read of an older `/admin/spaces` | #2951, `v1.6.3` | **REMOVED** (route, `listAudiences`, its spec case): such a request now reaches `associations/:id/audiences` with `spaces` as the id, a `400` from its `ParseUUIDPipe` |
| A body-less `PATCH /api/posts/:postId/pin|unpin`, pinned in the ONE space that fits (`onlySpace`, `space_required`) | #2984, `v1.6.3` | **REMOVED**: `PinPostDto.spaceId` is required, a body naming no space is a `400`; `space_required` and `GOVERNS_ANY_SPACE_SQL` are gone |
| A list profile save resending its unchanged `parentAssociationId` (`dropUnchangedPlatformFields`, dated 2027-05-03, "or earlier once the floor is a build that stopped resending it") | #2964, `v1.6.3` | **REMOVED** with its `[LEGACY]` line: any parent a non-admin sends is the typed `403` |
| An admin preset without `EDIT_PROFILE` on a member add (`legacy-admin-presets.ts`, dated 2027-05-03, "or earlier once the floor carries the flag") | #2964, `v1.6.3` | **REMOVED** with its `[LEGACY]` line: the mask is written as sent |
| An institution's republication request accepted by a build that never showed its audience (nothing to remove) | #2965, `v1.6.3` | **CLOSED**: no floor build can meet the stuck case |
| A creator managing two BDEs reading an old build's generic creation error (nothing to remove) | #2986, `v1.6.3` | **CLOSED** |
| A post whose comments are withheld (`canSeeComments`), a live chat withheld (`withheld`), a moderation tombstone (`removedByModeration`) drawn by a build that knows none of them (nothing to remove) | #2998, #3014, #2999, `v1.6.5` | **CLOSED**: three dead controls no floor build draws |
| The CanaReels modes `singlePhotos`, `singleMedia` and the link kept out without `withLinks` (`full-screen-post-sql.ts`) | #3056, #3062, #3074, `v1.6.6` | **REMOVED** (2026-11-11, five entries): one clause, `FULL_SCREEN_POST_SQL`, read by `multiMedia` alone, links allowed; the three DTO fields are gone (the whitelisting pipe strips them, so a floor client that still sends them gets the same list); the cache key keeps `+carousel-links`, the one every floor client already used. A stale web tab of a pre-`1.6.6` bundle degrades rather than breaks: a `v1.6.5` bundle receives the link posts and drops them, and a tab older than `multiMedia` gets the reels only. The floor does not reach a web tab left open, so this is the tolerated cost; `list-posts-query.dto.spec.ts` pins the strip (never a `400`) |
| The client sending `singlePhotos`, `singleMedia` and `withLinks` beside `multiMedia` (`buildListPostsSearchParams`) | server version, not a floor | **REMOVED** in the same pull request: the client sends `multiMedia=true` alone |
| `kind=reel` on `feed=all` read as `feed=reels` | #2990, `v1.6.3` (server) | **kept**: the client switch to `feed=reels` is not made, so the floor that retires it is the stable that will carry it, then a week of `[LEGACY]` silence |
| The further-device self-join held shut | needs D2/D3 (`1.6.7` at the earliest) | not met |

**Met by an earlier floor and still standing - not judged in this pass:** every row of the `1.6.2`
table below, and a salon access rewrite with no `baseAccessRevision` (#2445, `v1.5.0`), which that
table did not re-check. Their removals are their own pull requests; the ones owed a measurement
(the PKCE warning, the presence GET line) or touching MLS state, data at rest or native code (the
send ledger, the join-ask gate, the plaintext native cache, the device-notice markers) stay
regardless.

### Entries `1.6.2` unblocks (both estates read it, 2026-11-04)

"Carried by" is the first stable tag containing the pull request (`git tag --contains`). **Nothing is
removed by this change**: removal is its own pull request, and an entry with a second half keeps waiting
on it. The first eleven rows were already met by `1.6.0`; the last four need `1.6.1` or `1.6.2`.

| Entry | Carried by | Still owed besides the floor |
| --- | --- | --- |
| Send-ledger entry with no epoch | #2269, `v1.5.0` | - |
| Member clients that still Add automatically | #2358, `v1.5.0` | - (the rule becomes true; nothing to remove) |
| The `join-ask-1` capability gate | #2442, `v1.5.0` | - |
| Add-lock release with no token | #2426, `v1.5.0` | - |
| Plaintext native cache reader | #2271, `v1.5.0` | - |
| OIDC callback with no PKCE verifier | #2317, #2326, `v1.5.0` | the `without a PKCE verifier` warning silent for a week on production, and the redirect hardening |
| `follow-status` answers `following: true` for a pending request | #2616 (WP-F4), `v1.5.1` | - |
| Explicit slug on association creation | #2545, `v1.5.1` | - |
| `PUT lydia-business-key` answers `410` | #2772, `v1.5.2` | - |
| `X-Canari-Client-Version` on `/api/lives` routes | #2812, `v1.6.0` (floor condition `1.5.4`) | - |
| `klipy_cid` drop | `v1.2.9` | - (already met at floor `1.5.1`) |
| Presence GET (server half) | #2661, `v1.5.1` | the `legacy GET /api/presence served` line absent from production for a week |
| Paid-form tier codes of #2667 (wording only) | #2667, `v1.5.1` | - |
| Device-notice marker named by the key in hex | #2871, `v1.6.1` | every build has run since and migrated its markers (data at rest: the floor alone does not retire it) |

**NOT unblocked by `1.6.2`** (judged at `1.6.6`, above): the entries whose carrying pull request first ships in `v1.6.3` (the
institution's republication consent, #2965; WP-PIN's body-less pin, #2984; `GET spaces/audiences`, #2951;
`kind=reel` on `feed=all`, #2990; the creator-with-several-BDEs error, #2986), a restored message with
no author signature (#2276, `v1.5.0`; the oldest unsigned message must also leave retention), and the
refresh cookie on `tauri://localhost` (a desktop measurement). Entries not named here were not re-checked.

---

## What the 2026-08-17 gate actually retired, and what it did not

`minClientVersion` went to **0.14.0** on 2026-08-17. The gate is enforced IN THE CLIENT ONLY:
`isBelowMinClientVersion` and `shouldBlockSessionUnlock` (`stores/appVersionCheck.svelte.ts`) block
the login and the MLS unlock of a build that carries them. The server refuses no old client, so the
gate says what a build that obeys it can do, never what reaches the server.

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
| `CHAT_REEL_WRITER_ENABLED` (`reels/chatReelWriter.ts`, [reels-in-chat](frontend/modules/reels-in-chat.md#7-the-work-packages-in-order) item 6) | `minClientVersion` on the estate the writer writes to >= `v1.2.2`, the first stable carrying the reader (#1659, RC-1: a reel message is drawn as a tile, never as a downloadable chat video); a push says "CanaReel" from `v1.3.1` (#2112, RC-7), below it "video" - a softer line, not a misread. RC-6's "CanaReel supprime" (#2911) is NOT part of the floor: an older reader draws the player's expired state on the same `410` | YES on both estates, read 2026-11-02 from `GET /api/version`: production `1.5.1`, dev `1.2.7` (the push half too on production; on dev a `1.2.7`-`1.3.0` device would announce a reel as "video") | none | the floor is a precondition, nothing to remove | MET - the switch waits only for its other items (section 7) and the bench readings; how it turns on for dev only is the switch's own PR |
| The `1.2.1` key-group epoch floor (backlog owed line) | floor >= `1.2.1` | YES | - | - | closed (floor `1.5.1` on production, read 2026-10-31) |
| Group removal hold (#1878) | floor >= the release carrying it | YES on production since 2026-10-29 (floor `1.2.9`) | - | - | floor met |
| `GET mls/groups/:id` and `GET mls/group-info/:id` answer `{ found: false }` / `{ groupInfo: null }` instead of a bare `null` (an empty untyped 200), #2428 | the server deploys | not a version question: a deploy-order WINDOW | none | - | A stable ships both stores BEFORE production deploys, so for days new native clients talk to the old server. There, an empty untyped 200 reads as `error`, so a group deleted for everyone is not auto-purged on those clients until the server ships. That costs cleanup, not data. Once the server deploys, OLD clients change too: `fetchGroupInfo` returns `null` instead of throwing on an unpublished base (benign), and their `GroupInfo fetch failed` warn goes quiet ([chat](frontend/modules/chat.md#a-2xx-a-captive-portal-answered-is-no-answer-2026-10-25)) |
| Send answered without `receivedAt` read as accepted-undated (`postApplicationMessage`, #1878) | no estate runs a chat-delivery older than #1878 | not a client version question | none | the `null` arm | kept: harmless (the copy is undated); only the API's PARSEABLE JSON reaches it since 2026-10-25 - a non-JSON 2xx is no answer ([chat](frontend/modules/chat.md#a-2xx-a-captive-portal-answered-is-no-answer-2026-10-25)) |
| `canari_post_feed_kind` drop (`posts/retiredFeedKind.ts`, run by the feed's `load`) | every device that ran a `1.2.9-alpha.2`/`.3` has opened the feed once on a later build | not a version question (alphas only) | one device-global `localStorage` key | 1 module + 1 call | remove with the first stable after `1.2.9` ([reels](frontend/modules/reels.md#the-canareels-entry---an-icon-beside-the-tabs-that-opens-the-viewer-user-2026-10-16)) |
| Plaintext native cache reader (`native_cache::open_file`/`open_line`, the `Plaintext` arm, and the one-pass migration) | floor >= the release carrying the at-rest seal | NO (unreleased) | `graine_seeds.json`, `fcm_message_cache*.ndjson` on devices not yet updated | 2 match arms + 3 migration functions | waits for the floor ([diary](#no-date-yet---a-plaintext-native-cache-written-by-a-build-older-than-the-at-rest-seal)) |
| OIDC callback with no PKCE `code_verifier` (`auth.controller.ts`, `oidcCallback`) | floor >= the first stable carrying the client half, AND the `without a PKCE verifier` warning silent for a week on production | NO (unreleased) | none | 1 branch: refuse instead of warn | waits for the floor ([diary](#no-date-yet---an-oidc-callback-with-no-pkce-verifier)) |
| `klipy_cid` drop (`utils/chat/retiredKlipyCustomerId.ts`, run at the root layout's mount) | every install older than 2026-10-16 has started once on a later build - a CLIENT FLOOR, since an install that never updates keeps the key and also keeps sending it | `minClientVersion` past the release carrying it | one device-global `localStorage` key, the per-install id older builds sent to KLIPY | 1 module + 1 call | remove with the first stable after the floor passes that release ([chat](frontend/modules/chat.md#the-gif-search-goes-through-canari-2026-10-16)) |
| Send-ledger entry with no epoch (`sendRatchetLedger.ts`, `parseKey`) | floor past the first stable carrying #2269 | NO (unreleased) | `mls_send_ledger_<user>` in `localStorage` on devices not yet updated | 1 parse branch + 1 debt arm | waits for the floor ([diary](#no-date-yet---a-send-ledger-entry-with-no-epoch-written-by-a-client-older-than-2026-10-23)) |
| Plaintext live key: the `"liveKey"` column, `openLiveKey`'s plaintext arm, `LivesService.sealPlaintextKeys` (migration 110) | 0 rows with `"liveKey" IS NOT NULL` on both estates, read AFTER the first deploy carrying 110 has fully replaced the previous replica | not a version question (server only) | `lives."liveKey"` | 1 arm + 1 sweep step + a migration dropping the column, the index and `lives_key_one_form` | owed: the count below, then that migration ([lives](services/lives.md#the-live-key-at-rest)) |
| `follow-status` answers `following: true` for a PENDING follow request (`posts.controller.ts`, `getUserFollowStatus`; WP-F1) | floor past the first stable carrying the request screens (WP-F4), which read `status` | NO (unbuilt) | none | drop `following`, or make it mean accepted | waits for the floor. An older client's button shows the leave action for a request, so its user can withdraw what they asked; reading `following` as "accepted" would show "Suivre" and leave the request unwithdrawable there ([profiles-and-access](profiles-and-access.md#follow-requests-member-reposts-and-visibility-between-spaces---the-decisions-of-2026-10-25-all-shipped)) |
| The account-seat `awaitingAdmission` on the groups list read off `deviceMembership.awaitingAdmission` when a row lacks it (`syncAdmissionFlags`, `admissionState.ts`; #2894) | production's chat-delivery serves the top-level field (one read of `GET mls/users/:userId/groups` on production showing it) | not a client version question: a deploy-order WINDOW, a store build ahead of production | none | the `??` arm and its WARN line | remove once production serves the field; until then each pass that takes it logs `[DISCOVERY] [WARN] ... read off this device's seat` |
| The `join-ask-1` capability gate: `group.join_ask` / `group.join_ask.settled` reach only devices every session of which declared `join-ask-1` (chat-delivery `JOIN_ASK_PUBLISH_LUA`, gateway `requiresCapability`) | floor >= the first stable carrying the ask frames (#2442), raised once BOTH stores serve it | NO (unreleased) | none - the gateway's twin hash `addressing:join-ask:*`, one field per session with a TTL | the twin hash + its script + the `requiresCapability` field + `JOIN_ASK_CAPABILITY` in three places; the presence check stays | waits for the floor: an older build routes only `channel.`/`workspace.` frames and would log each ask as reaching no handler, so until the floor the gate is what keeps that line from every older client ([mls-protocol](protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23), [chat-gateway](services/chat-gateway.md#presence)) |
| `PUT associations/:id/lydia-business-key` answers a typed `410 LYDIA_KEY_PASTE_RETIRED` and writes nothing; `GET` on the same path still answers `{ set }` (enrolment lot 1) | `minClientVersion` past the first build without the paste field, on BOTH stores | NO (unreleased) | none - the key column stays, written at `business/create` | 2 routes + `isLydiaBusinessKeySet` + 1 spec block | waits for the floor ([diary](#no-date-yet---the-lydia-key-paste-field-of-a-build-older-than-enrolment-lot-1)) |
| A `closed` admission classification dropped at load (`drop_closed_admission_policies`, `mls-core` `state.rs`; review of #2817) | every device that ran a dev build of #2815 has loaded its state once on a later build - dev and alpha builds only, nothing shipped `closed` to a store | not a version question (dev/alphas) | `PersistedState.admission` in `mls.bin` | 1 function + 1 call + 1 test | remove 2027-02-01, or when the fix-forward re-arms the rule - whichever is first, since a re-armed rule writes `closed` again and must not have it dropped ([mls-protocol](protocols/mls-protocol.md)) |
| `canari_admission_frozen` removed at session setup (`forgetLegacyAdmissionFreeze`, `setupMessageHandler.ts`; review of #2817) | every device that ran a dev build of #2815 has opened a session on a later build | not a version question (dev/alphas) | one device-global `localStorage` key, read by nothing | 1 function + 1 call + 1 test | remove 2027-02-01 ([mls-protocol](protocols/mls-protocol.md)) |
| `posts.pinned`, the retired global pin: read by nothing since WP-PIN, and UNMAPPED from the entity since 2026-11-04, so no INSERT names it any more (#3023); dropped by migration 134 (#3024, held: a DROP) | 128 applied on BOTH estates (MET: dev through `v1.6.3-alpha.6`, production through `v1.6.3`, 2026-11-03 - its one flagged post carried, `INSERT 0 1`); AND **each estate the drop reaches already serving a build with the unmapping** - production (`git merge-base --is-ancestor <#3023 squash commit> prod-released`) AND dev: no pre-release carrying 134 is cut while dev runs an image without the unmapping, since dev applies it first | MET (2026-11-07): #3023 first shipped in `v1.6.4-alpha.3` (dev) and the stable `v1.6.5`; `prod-released` (`v1.6.6`) and `dev-deployed` both contain it | the column; one `true` row on production, already carried into a space pin | migration 134 `ALTER TABLE posts DROP COLUMN IF EXISTS pinned` | **not in the release that unmaps it**: migrations apply BEFORE the rolling replacement, and every image up to `v1.6.4-alpha.2` names `"pinned"` in the column list of each `INSERT INTO posts` (TypeORM lists every mapped column, `DEFAULT` for an unset one), so a drop in the same deploy fails every post created by an old container until the rollover ([durable-rules](durable-rules.md#release-and-ci---cicd)). **AND A ROLLBACK FLOOR, for good once 134 ships**: a rollback to ANY image older than #3023 fails every post INSERT on that estate, so the oldest image a rollback (the emergency path included) may reach is `v1.6.4-alpha.3` on dev and `v1.6.5` on production |
| `internal/reel-purge` with NO `reason` read as the pre-RC-14 delete (`purgeReels`, `media.service.ts`; review of #2898) | BOTH estates run the social-service carrying RC-14, which always names one | not a client version question: a deploy-order WINDOW (media-service may be replaced before social-service, or rolled back past it) | none | the `undefined` arm, its warn and the controller's absent-reason branch | remove once both estates deploy RC-14: then a missing reason is a `400`. Until then the old caller gets the old delete for a file no LIVE chat hold keeps; for a file a live chat hold keeps, the post hold is RELEASED and the answer is `refused` (the old caller drops its post row on any answer, and an older reel worker counts outcomes by name, so `released` would read as NaN), since that caller cannot say moderator from post end and the release is the safe reading - each call logs `Reel purge ... with NO reason - an older social-service` ([media-service](services/media-service.md#holds-one-file-for-the-feed-and-the-chats-rc-14-2026-11-01)) |
| `X-Canari-Client-Version` floor on every `/api/lives` route (`live-client-version.ts`, `LiveEnabledGuard`; new 2026-10-31, shipped with `1.5.4`) | the global `minClientVersion` floor >= `1.5.4` AND production serves `1.5.4` on both stores - then every client that can reach a lives route sends the header | NO (lives are off in production until `1.5.4`) | none | the header constant, `liveClientVersionAllowed` and one guard branch (~40 lines), the web client's `withClientVersion` | owed at the floor: a request with NO header is REFUSED (that is what a `1.5.1`-`1.5.3` build sends, the only evidence the server has), so the rig and `tools/live-bench` send `1.5.4`; once the floor covers them the branch is dead and goes ([lives](services/lives.md)) |
| `kind=reel` on `feed=all` (or no feed) read as `feed=reels`, the CanaReels viewer's list (`resolveListFeed`, `posts/list-feed.ts`; 2026-11-03) | (1) BOTH estates serve `feed=reels`, then the client sends it; (2) `minClientVersion` >= the first stable sending it, and the `[LEGACY]` line silent | (1) MET (#2990, `v1.6.3`, on both estates); the client still sends `feed: 'all'` (`reels/allReels.ts`), so (2) has not begun | none | 1 branch + its spec cases + 1 log | owed: the client switch, then a floor past the stable carrying it, then a week of silence ([diary](#no-date-yet---kindreel-on-feedall-read-as-the-canareels-viewer-list-2026-11-03)) |

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

### Removal once no association is left with a historical active account - the Lydia account bridge (owner, 2026-11-13)

**Site:** `apps/social-service/src/associations/lydia-account-bridge.ts` and every caller of its three
definitions (`managedVendorTokenSql`, `HELD_BUSINESSES_SQL`, `vendorTokensHeldBy`), the bridge branches
of `AssociationsService.setLydiaReadiness` (`standbyReadinessStep`, `switchBackOnRefusal`), the
re-issue in `ProductsService.openCheckoutAttempt` and in `FormsService`'s paid submit, the code
`LYDIA_BUSINESS_PENDING_VALIDATION` (social, core, the contract, the frontend), the admin panel in
`LydiaBusinessOnboardingForm.svelte`, the `meta.bridge` wording in `NotificationRow.svelte`, the strip
in `copy-strips.sh`, the historical-account exclusion of the platform's flux
(`measureLydiaFlux`'s `h` join, `lydia-contract-flux.ts`), and the table `lydia_account_bridges`
(migration 167).
**What it humours:** an association that collected through a Lydia account it held before Canari's
enrolment (the BDE and Le Cercle): it keeps collecting there until Lydia validates the Business the
enrolment created, then switches by itself
([payments](frontend/modules/payments.md#a-historical-account-collects-until-the-enrolled-business-is-validated-owner-2026-11-13)).
**The cost while it stands:** a second place a Business lives, every row-token lookup through a union,
and the owner's error-5 re-issue - a path that exists for the bridge alone.
**Removal condition:** no association left with a historical active account: `SELECT count(*) FROM
lydia_account_bridges WHERE state = 'historical'` answers 0 on production, AND every switched bridge's
historical account has nothing left to refund (its rows deleted by an admin, payments page). Then, in
one pull request: a held migration dropping the table, the module and its callers back to the
association's columns, the code, the panel, the wording, the strip and this entry.

### Removal once upstream adminer ships `libpq >= 18.7-r0` - the adminer image this repository builds (owner, 2026-11-13)

**Site:** `infrastructure/local/Dockerfile.adminer`, its two lines in `.github/workflows/build.yml`
(`SERVICE_DOCKERFILE`, `ALL_SERVICES`), its line in `scheduled.yml`'s GHCR prune list, and production's
`adminer` service (`image: ghcr.io/.../canari/adminer:${TAG}`, `build:`, `canari.deploy.replace: exclusive`).
**What it humours:** upstream's newest image, `adminer:6.3.0` (`sha256:3a07decd...`, 2026-11-06), carries
Alpine's `libpq 18.6-r0` and its 38 HIGH PostgreSQL advisories, fixed in Alpine 3.24's `18.7-r0`; the
image scan failed every pull request from 2026-11-13. The owner chose a patched image over an allowlist
and over removing the console: that same digest, `apk upgrade --no-cache libpq`, back to `USER adminer`.
The scan builds it and reads the result ([cicd](cicd.md#container-images-are-scanned-2026-10-23)).
**The cost while it stands:** a tenth image built per release, and adminer replaced by every release (a
gap on a console only a global admin opens) where a pinned image moved only with its digest.
**Removal condition:** Dependabot moves the `FROM` (the `docker` ecosystem reads `infrastructure/local`)
to an upstream build whose own `libpq` is `>= 18.7-r0` - read in the scan of that pull request, or with
`trivy image adminer:<tag>`. Then, in one pull request: production's service back to `image:
adminer:<tag>@sha256:<digest>` with `canari.deploy.replace: pinned` and no `build:`; delete the
Dockerfile, its `build.yml` and `scheduled.yml` lines, the image checks of `adminer-route.test.mjs`, and
this entry. The scan then reads the upstream reference again (`image-scan-targets.sh`).

### Removal once both estates log `drained=0` - live segments an older release left in Garage (2026-11-09)

**Site:** `LiveSegmentsService.drainObjectStore`, run by `onApplicationBootstrap`
(`apps/media-service/src/media/live-segments.service.ts`).
**What it humours:** a media-service before live replays WP-R3 wrote live segments and posters into
the backed-up object store (Garage) under `live/`; since WP-R3 they live on the `live_segments`
volume ([live-replays](live-replays.md#wp-r3-as-built-the-segments-outside-the-backup)), and
`StorageService` refuses a `live/` key. The segments of a live on air at that deploy stayed in Garage,
where no purge and no reaper looks any more. Each boot deletes every live segment key of the object
store (`live/<uuid>/<uuid>`, an allowlist: any other `live/` object is logged at WARN and kept) and
logs `[LIVE_STORE] object store drained of old live segments: drained=N leftAlone=M` (an ERROR line if
the store failed; the next boot retries). A rollback to an older image writes there again, and the
next forward deploy drains it.
**The cost while it stands:** one empty prefix listing of Garage per boot.
**Removal condition:** the release carrying WP-R3 deployed on both estates and, after it, one boot of
each logging `drained=0`. Then delete the method, its hook, its two spec cases and this entry.

### Removal at the portail's deploy + one silent week - the public carte read that names no space (2026-11-08)

**Site:** `PosterService.getSoleLegacyPublished` and the no-`space` branch of
`PublicController.getPublishedCarte` (`apps/social-service/src/associations/poster.service.ts`,
`apps/social-service/src/public/public.controller.ts`).
**What it humours:** a portail-etu deployed before it sent `?space=` ([carte](carte-vie-asso.md#rules)).
While EXACTLY one map is live anywhere it is served, logged `[LEGACY] GET public/carte with no space`;
otherwise the call is a typed 400 (`CARTE_PUBLIC_SPACE_REQUIRED`), never a guess.
**The cost while it stands:** a second space publishing a map makes that old showcase lose its map
(the 400) - the right failure, and the reason the window is short.
**Removal condition:** the portail-etu deploy that sends `PUBLIC_CANARI_CARTE_SPACE` is in production,
then a week with no `[LEGACY] GET public/carte` line. **Re-dated 2026-11-14:** the portail's `v1.0.8`
names its space for the carte only; its directory (`/api/public/associations`, the slug page) is
read with no space until `v1.0.9`, so the week is counted from the deploy of `v1.0.9`. Then make `space` required, delete the method,
its branch, their spec cases and this entry.

### Removal when the floor passes the release carrying `scheduled-to-edit` - `GET /api/posts/my-scheduled` (2026-11-13)

- **What.** The editors' strip at the top of `/posts` reads `GET /api/posts/scheduled-to-edit`
  (whole cards, for whoever may edit). Builds before it read `GET /api/posts/my-scheduled`, which
  used to answer the author's own `{ id, markdown, scheduledAt, createdAt }` rows. It now answers
  the SAME list as the new route (`getMyScheduledPostsLegacy`, one `[LEGACY]` line per call): a
  superset of those fields, so an old strip still draws, now with the association posts its reader
  may edit as well.
- **Removal.** Delete the route and its controller method once `minClientVersion` passes the first
  release carrying the new route and the `[LEGACY] GET /api/posts/my-scheduled served` line has
  been silent on production for a week.

### No date yet - `GET /api/associations/categories`, for a build older than the per-map carte zones (2026-11-08)

**Site:** `AssociationCategoriesController`
(`apps/social-service/src/associations/association-categories.controller.ts`), GET only.
**What it humours:** an APK or IPA older than migration 147's release loads the global categories in
its association settings and its carte hub; the shim answers `[]`, logged `[LEGACY] GET
associations/categories`, so those screens draw empty instead of erroring. Their writes (create,
rename, delete a category; `categoryId` in a PATCH) are gone: the routes 404 and the whitelist strips
the field.
**The cost while it stands:** none beyond the route.
**Removal condition:** `minClientVersion` covers the first release carrying 147 on BOTH stores. Then
delete the controller, its `anonymous-surface` and `auth-request-coverage` lines, and this entry -
together with the drop of the table ([backlog](backlog.d/drop-the-global-association-categories.md)).

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

### No date yet - a frontend image older than the target lists, drained by DNS (2026-11-01)

**Site:** `rotation_is_legacy` and the `legacy` branch of `rotation_apply` in
`infrastructure/lib/rolling.sh`.
**What it humours:** a frontend nginx from before the target lists, which reads no
`targets/frontend.conf` and names every service by `<service>:<port>` - by `set` before any list, by
1.6.2's `upstream` list at rest since (2026-11-02). The first deploy carrying the target lists finds
one running, and so does every deploy after a rollback to a release older than them. Kept for the same
reason: `infrastructure/edge/rotation/` and its `.gitignore`, where 1.6.2's frontend reads its list
and 1.6.2's library writes it on a rollback; this library never touches it. Its retiring replica is kept
up `ROLLING_RESOLVER_TTL_SECONDS + 1` while that nginx re-resolves - the drain every deploy made
before the lists - with a `::warning` naming it, rather than refused
([cicd](cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)).
**Only a transition takes it:** the branch compares the proxy's running image with the one the plan
says this release deploys (`rotation_runs_this_release`, the plan's fifth field). The previous
release's image is the transition, warned and drained; THIS release's own image reading no list is a
release built wrong, refused at `::error`; an image that cannot be compared is drained and logged at
`::error`. `deploy-replace.test.sh` asserts the first two.
**Condition, and its trigger:** no release a rollback may still target predates the target lists -
the GHCR prune keeps 30 pushes, so once the 30 newest releases of each estate carry them. Measured,
not remembered: `git tag --contains <the squash commit that brought the target lists> | grep -cE '^v[0-9]+\.[0-9]+\.[0-9]+(-alpha\.[0-9]+)?$'`
reaching 30. Then delete the branch and `edge/rotation/`, so a proxy that reads no target list is
refused like any other. The
resting DNS form of the lists is NOT part of this entry: it is the design, and stays.

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
carrying PR #1911 (`v1.2.9`), the floor moving by [the floor rule](#the-floor-rule-raised-when-both-stores-serve-the-latest-update-owner-2026-10-24). A new type shipped
earlier reaches the floor clients as a wrong sentence and a dead link, which no server change can undo.
**Checklist - a NEW notification type** (no other checklist existed; this is it):
1. The floor above covers PR #1911 first.
2. The server sends an EXPLICIT `deepLink` (or a dedicated host) for it in `socialDeepLink`; never rely on the `postId` -> `post/<id>` default when the id is not a post.
3. Add the type to `KNOWN_NOTIFICATION_TYPES` and the `notificationHref` switch (`notificationTarget.ts`), and give `NotificationRow` its glyph, colour and Paraglide sentence; the tests walk every known type through both.
4. Native tables (`composeServerNotification`, NSE, `canari_push.mm`) get its `contentKey`.
5. **Declare its client floor** in `apps/social-service/src/push/notification-client-floor.ts` - the
   type in `NOTIFICATION_TYPE_MIN_CLIENT` and every push key in `PUSH_KEY_MIN_CLIENT` - as the
   version of the release that first DRAWS it (the [section below](#the-client-floor-of-every-notification-type-owner-2026-11-10)).
   `createNotification(s)` take a `NotificationType`, so an undeclared type does not compile, and
   `notification-client-floor.spec.ts` fails when the floor table and `KNOWN_NOTIFICATION_TYPES` (or
   the `PushContentKey` union) disagree.
**Removal condition:** none; this is a floor requirement, not a shim.

### The client floor of every notification type (owner, 2026-11-10)

**The rule: the server never sends a notification type to a client too old to render it.** The 1.6.9
deploy sent `campus_trend` rows to 1.6.8 builds, which drew "Une notification que cette version de
l'application ne peut pas afficher" ([engagement](engagement.md#the-deploy-of-2026-11-10-and-what-it-changed)).
The unknown-type row above is a SIGNAL that this rule failed, never the path.

- **One table, the server's**: `notification-client-floor.ts` (social-service) gives every bell type
  (`NOTIFICATION_TYPE_MIN_CLIENT`) and every push key (`PUSH_KEY_MIN_CLIENT`) the first release that
  draws it; `null` means every build the update gate admits draws it. The floors were read from the
  release tags (`KNOWN_NOTIFICATION_TYPES` and the native tables at each tag).
- **The client names itself**: `X-Canari-Client-Version` (`CLIENT_VERSION_HEADER`, one spelling in
  `frontend/src/lib/utils/appVersion.ts`, the lives routes' header), sent on the bell read.
- **The bell read filters on it** (`getNotifications` / `bellPageQuery`: `type IN` the types the build
  draws). **A read with no header is a build up to 1.6.9** (`HEADERLESS_CLIENT_VERSION`): every one of
  those sent none, so it is served what 1.6.9 draws - the types it was already served - and every type
  added from now on takes a floor ABOVE 1.6.9, so no headerless build ever receives it. A header that
  does not parse is served only the `null`-floor types (fail closed).
- **Pushes carry their key's floor**: `PushService.notifyContent` writes `minAppVersion` from
  `PUSH_KEY_MIN_CLIENT` AFTER the caller's data (a caller cannot lower it), and chat-delivery's
  `sendPushToUser` skips every device whose registered build (`key_package.deviceAppVersion`) is below
  it - the lives mechanism of 2026-10-31, now one table for every key. A device whose build was never
  reported is kept and counted in the log. **Consequence**: since this change a device below a key's
  floor stops receiving that key's push (it drew it only as the server's legacy sentence before).
- **Not at the WRITE**: the inbox row is written for every recipient, whatever their device - a reader
  has several devices of several builds, and the row is drawn on the next read by whichever device
  reads it, an updated one included.
- **The same rule for the notification CATEGORIES** (review of #3312, D1): a build draws a switch only
  for the categories it knows, so its save of the switches is no choice about the others. chat-delivery
  holds `CATEGORY_MIN_CLIENT` (`services/push-category.ts`, the first release drawing each switch,
  read from the tags) and `PUT mls/notification-preferences` keeps the STORED choice of every category
  the caller's build cannot name (`categoriesNameableBy`, the same header, none = a build up to 1.6.9,
  through the shared `keysKnownBy` of `utils/app-version.ts`), merged in one `INSERT ... ON CONFLICT DO
  UPDATE`. From `1.6.10` the client also keeps the switched-off ids it does not know and sends them
  back (`preferencesApi.ts`), so either side alone suffices. A new category takes the version of the
  release that adds its switch; the record type makes a missing floor a compile error.
  **One gap, accepted (lead, 2026-11-10): a `1.6.8` save erases a stored "Anniversaires" choice.**
  No header reads as `1.6.9`, which names `birthdays`, so a headerless save is taken to speak for
  it; a `1.6.8` phone saving its switches therefore switches "Anniversaires" back on if another
  device had switched it off. Covering it would need the server to tell a `1.6.8` from a `1.6.9`
  without a header, which nothing allows. Birthdays shipped in `1.6.9`, so the population - a reader
  who switched them off on a `1.6.9` device and then saves from a `1.6.8` one - is near zero, and it
  ends with the update. Every category from `suggestions` on is covered, by the header.
**Built and waiting on this floor (2026-10-22): `form_paid_over_capacity`**, the organiser alert for a
payment that landed on a full form ([forms](frontend/modules/forms.md#the-organiser-is-told-when-a-payment-lands-over-capacity-d3-built-2026-10-22-switched-off)).
**Step 1 is MET (2026-10-29):** production's `minClientVersion` was raised from `1.2.7` to `1.2.9` by the
owner's explicit decision, read back from the public version endpoint as `1.2.9`; both stores serve `1.5.0`,
far above the floor, so the raise cannot lock out a shipped client (compare the v0.14.0 incident above). A new
notification type, bookings included, may now ship once its own flag flips. Dev's floor is a separate row
([backlog](backlog.md)). Steps 2-4 are done for `form_paid_over_capacity`, which ships behind `FORM_ORGANISER_ALERT_ENABLED = false` (`apps/social-service/src/forms/organiser-alert.service.ts`).
**The exact precondition to set it to `true` (user, 2026-10-22):** `minClientVersion` at or above the
version that CARRIES #2228 (`v1.4.0`, not merely `1.2.9`: that build also declares the `form-responses` host and
knows the type), on BOTH estates, by [the floor rule](#the-floor-rule-raised-when-both-stores-serve-the-latest-update-owner-2026-10-24). The switch stays
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
the release carrying #2692 was ACCEPTED (2026-10-29); the floor passed that release: both estates read `minClientVersion` 1.6.6 (2026-11-13).
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

**Shipped UNSWITCHED, accepted on review (2026-11-03): `delegation_revoked`,
`delegation_receiver_not_ready`, `delegation_resumed`**, the notices telling a list's `MANAGE_PRODUCTS`
holders that its payment delegation paused or resumed its collection (owner review of #2967: "pause +
notify", so they are not behind `LYDIA_PAYMENTS_NOTIFICATIONS_ENABLED`). The floor rule's step 1 is met
(`1.2.9`); steps 2-4 are done in the same pull request (the push opens the `notifications` host, the
three native tables, the `forms` push category, the row opening the list's delegation section). A
client older than the release carrying them draws the neutral unknown-type row and the push's French
legacy sentence - the same degraded display accepted for the bookings' four
([payments](frontend/modules/payments.md#payment-delegation-parent-association-routing)).

**Built and waiting on its floor (2026-10-31): `lydia_cashier_added`**, the bell row telling a member
they were added as a cashier of an association's Lydia Business (Lydia enrolment lot 3). It ships behind
`LYDIA_CASHIER_NOTIFICATIONS_ENABLED = false` (`apps/social-service/src/associations/lydia-payments-notifier.service.ts`);
while it is off nothing is written and Lydia's own SMS reaches the person. **Flip condition:**
`minClientVersion` at or above the first release carrying Lydia enrolment lot 3, on BOTH estates, once
Play and the App Store serve it - then a one-line pull request sets the constant to `true` and changes the
spec that pins it. A client older than that release draws it as the neutral unknown-type row. It is a bell
row only, no push (so no push key, category or native string is owed); the client row, the type in
`KNOWN_NOTIFICATION_TYPES` and its link to the Lydia Pro help page (`/help/lydia-pro`) ship with lot 3.
The type name is shared through `libs/contracts/lydia-refusal-codes.json`.

**What a client older than Lydia enrolment lot 3 (1.5.1, 1.5.2) shows on the Responsable's step.**
While the number change is switched off (`LYDIA_CASHIER_ADD_ENABLED = false`), core answers another
number with `LYDIA_RESPONSABLE_PHONE_LOCKED`, the code those clients already word ("the Responsable's
number cannot be changed yet"); a lot 3 client reads the same code as "not possible yet" through the
same flag. **After the flip**, those clients can reach a number change and meet codes they do not
know, each drawn as their generic "Could not save the Responsable." with nothing lost:
`LYDIA_CASHIER_PHONE_IN_USE` (the number is already a cashier's - nothing claimed, nothing asked of
Lydia), and `LYDIA_CASHIER_REMOVAL_PRECONDITION` or `LYDIA_CASHIER_REVOKE_UNCONFIRMED` (the new number
is recorded; the old one is still listed in the cashiers, with its "Retirer cet autre numéro" button,
on any up-to-date client). `LYDIA_RESPONSABLE_NUMBER_CHANGE_FORBIDDEN` is a 403, which they word as
"not allowed to manage the payout account". Nothing to remove: these are wordings, and the floor
rule above (`minClientVersion` at or above lot 3) retires them.

**Built and waiting on its floor (2026-10-31): `lydia_refund_issued`**, the notice telling a payer that an
association refunded one of their payments (Lydia enrolment lot 4). It ships behind
`LYDIA_REFUND_NOTIFICATIONS_ENABLED = false` (`apps/social-service/src/associations/refunds/lydia-refund-notifier.service.ts`);
while it is off nothing is written, Lydia's own e-mail to the payer (`notify_payer`) tells them and the
refund's row is the record. **Flip condition:** `minClientVersion` at or above the first release carrying
Lydia enrolment lot 4 (PR to be numbered), on BOTH estates, once Play and the App Store serve it - then a
one-line pull request sets the constant to `true` and changes the spec that pins it. A client older than
that release draws it as the neutral unknown-type row. Done in the same pull request: the push key and
French legacy sentence, the `forms` push category, the native tables (Android, the iOS app and its
notification extension), the client row, `KNOWN_NOTIFICATION_TYPES`, and the destination (the payer's
`/account/purchases`, where the payment reads `Remboursé`). The type name is shared through the same
contract file (`refund.notificationTypes`).

### No date yet - a feed client newer than its server - `rankedFeeds` (2026-11-10)

**Site:** `serverRankedFeeds()` (`frontend/src/lib/stores/appVersionCheck.svelte.ts`), read by
`listPosts` and applied by `wireFeed` in `buildListPostsSearchParams` (`frontend/src/lib/posts/api.ts`);
the server half is `rankedFeeds: true` in core-service's `GET /api/version`.
**Why.** The 1.6.9 client's Pour toi is `feed=foryou` and its CanaReels viewer `feed=reels&ranked=true`,
paged with `asOf`. A stable ships both stores before production deploys, and an older social-service
refuses `feed=foryou` `400` (`@IsIn`) - the tab would be empty for those days.
**What the client does.** On an estate that says `rankedFeeds: true` it asks the ranked lists; otherwise
- an estate that ANSWERED without it - it asks Pour toi as `feed=followed` (the chronological Suivis,
entities included) and the CanaReels list in its older shape (`feed=all&kind=reel`, newest first),
with neither `ranked` nor `asOf`; the rows carry no `feedAsOf`, so `nextListPage` pages by the count
as before. A `Log.d` names the downgrade. **No answer yet is not "no"** (alpha.6, 2026-11-10): the
capability is kept in `sessionStorage`, so it is `null` on EVERY cold start until the root layout's
`/api/version` answers, and the feed's first page is asked before that. Read as "no", Pour toi was
asked as `followed` on a server that serves it, and that answer - a followed association's post
included - was drawn and stored on the device as Pour toi, until a manual refresh. Now a RANKED list
with the capability `null` awaits `refreshAppVersionCheck()` (the layout's own request, deduped)
and decides on its answer (`rankedFeedsKnown` in `posts/api.ts`); every other list asks at once. The
wait is one round trip on a cold start (the device's stored copy is drawn meanwhile), and up to the
probe's retry ladder (~26 s) only when `/api/version` does not answer; it is pinned as a decision in
`versionProbeOnUnlockPath.test.ts` (an open session, never in front of an unlock).
And **a list never holds another list's rows**: a Pour toi page whose rows lack `feedAsOf` (the
`followed` shape) is neither kept in the memory tab cache (`writeFeedCache`) nor stored on the
device (`writeStoredFeedPage`), and a stored Pour toi copy in that shape - what alpha.6 wrote - is
not drawn and is deleted on its next read (`rowsInListShape`, `posts/rankedFeeds.ts`). **A list
keeps the shape its first page was served in** until a refresh: `nextListPage` returns
`rankedFeeds: false` for rows served without ranking facts, so a ranked page 2 is never asked of an
unranked page 1 - which the server would refuse `400 RANKING_PAGE_INVALID` (a later ranked page
without `asOf`).
**Removal condition:** when no estate older than the release carrying `rankedFeeds` is served (both
estates deployed past 1.6.9), the client branch for `false` may go; the field stays, always `true`.

### No date yet - an answer editor newer than its server - `formAnswerEdit` (2026-11-13)

**Site:** `serverFormAnswerEdit()` (`frontend/src/lib/stores/appVersionCheck.svelte.ts`), read through
`offersAnswerEdit` and `answerEditPayload` (`frontend/src/lib/forms/answerEditGate.ts`) by the fill page
and both form editors; the server half is `formAnswerEdit: true` in core-service's `GET /api/version`.
**Why.** A store build reaches phones days before production deploys. A social-service older than
migration 166 answers `GET /forms/:id/my-answers` and `PUT /forms/:id/submissions/:id/answers` `404`,
and its validation strips `allowAnswerEdit` from a form's save.
**What the client does.** Only on an estate that says `formAnswerEdit: true` does the editor draw the
switch and send it, and the fill page ask for the caller's changeable answers; on any other answer -
`false`, or no answer yet (`null`) - neither the switch nor "Modifier ma réponse" is offered and
nothing is asked: the client never learns the feature by a refusal. Pinned by
`answerEditGate.test.ts` and `appVersion.test.ts`; the server half by `version.service.spec.ts`.
**The reverse skew** (an editor of 1.6.6 to 1.6.11 saving a form whose switch is on): its save carries
no `allowAnswerEdit`, and `FormsService.update` keeps a stored value for an absent field, so the
switch survives - pinned by `forms.service.public.spec.ts` ("the answer-edit switch across an older
editor"). Nothing to remove there.
**Removal condition:** when no estate older than the release carrying `formAnswerEdit` is served (both
estates deployed past 1.6.12), the client branch for `false` may go; the field stays, always `true`.

### No date yet - Suivis (`feed=followed`) and the client-placed suggested posts, for installed clients older than 1.6.9 (2026-11-10)

**Site:** the `followed` arm of `PostsService.listPostRows` (`followedFeedSql` in
`apps/social-service/src/posts/republished-feed-sql.ts`) and `GET /posts/me/suggested-posts`
(`PostsController.listSuggestedPosts`), both UNCHANGED.
**What it humours.** Up to 1.6.8 the client draws a Suivis tab (`feed=followed`: followed associations
AND people, chronological, pins on top) and interleaves `me/suggested-posts` in its Mon espace
(`feed=all`) one in eight. The 1.6.9 client asks neither: Pour toi is `feed=foryou`, Campus is the
unchanged `all`, and a remembered `followed` or a `?feed=followed` link opens Pour toi
(`parsePostFeed`). Nothing in either answer changed (`for-you-feed.integration.spec.ts` pins both).
**Removal** (once `minClientVersion` is 1.6.9 or later on both estates): delete the `followed` value
of `LIST_POST_FEEDS`, its arm and `followedFeedSql`, the `me/suggested-posts` route and
`PostsService.listSuggestedPosts`; the client's `RETIRED_FOLLOWED_FEED` mapping may go one floor later
(a preference stored before 1.6.9 then falls back to the default tab).
**Cost while it stands:** none - one arm nobody new asks, one route.

### No date yet - an event form newer than its server - `eventReach` (2026-11-13)

**Site:** `serverEventReach()` (`frontend/src/lib/stores/appVersionCheck.svelte.ts`), read by
`eventReachOffered` (`frontend/src/lib/calendar/eventReach.ts`) on the global agenda and an
institution's page; the server half is `eventReach: true` in core-service's `GET /api/version`.
**Why.** A stable ships both stores before production deploys, so for days a phone build that
requires an institution event's reach talks to a social-service that answers the options route `404`
and cannot store a reach: the picker would fail to load and "Déposer" would stay disabled - nobody
could file an institution's event until production deployed.
**What the client does.** It draws the reach picker, and requires a choice, only on an estate whose
`/api/version` says `eventReach: true`; otherwise - an older server, or no answer yet - it files the
event as before, with no picker and no reach. The `404` is never read as the signal.
**Removal condition:** when no estate older than the release carrying `eventReach` is served (both
estates deployed past it), the client branch for `false` may go; the field stays, always `true`.

### Removal once `minClientVersion` passes `1.6.12` - a form editor that cannot draw a priced grid's "Obligatoire" switch (owner, 2026-11-13)

**Site:** `productGridRequiredOnSave` (`product-grid-contract.ts`, both copies), its `chosen = false`
branch, read by `normaliseProductGridItems` (`forms/product-grid.ts`) and the editor's
`revisionItems` (`frontend/src/lib/forms/itemsPayload.ts`); the payload field `gridRequiredSwitch`
(`CreateFormDto`, `GRID_REQUIRED_SWITCH`).
**What it humours:** an editor from `1.6.6` to `1.6.11` sends `required: true` on EVERY priced grid -
the flag meant nothing then ([forms](frontend/modules/forms.md#the-priced-grid-product_grid-wp-g1-2026-11-06)).
Honoured as sent, an old app's edit would make every grid of the form required. So a save without
`gridRequiredSwitch: true` keeps each grid's STORED flag and stores a new grid optional, and a
revision such an editor saved opens in a current editor with the same rule. **The cost while it
stands:** an old app cannot change a grid's switch (the web and an updated app can).
**A tolerated degradation beside it, no shim:** an old FILL page still holds a send on "Commandez au
moins un article" when no visible grid holds a unit (the rule this release removed - stricter than
the server), and does not mark a required grid on its card; the server's `FORM_ANSWER_MISSING`, which
it words generically, holds the send instead.
**Removal condition:** `minClientVersion` at or above `1.6.12` on both estates, AND no open revision
saved by an old editor still holding a grid -
`SELECT count(*) FROM form_drafts WHERE document IS NOT NULL AND NOT coalesce((document ->> 'gridRequiredSwitch')::boolean, false) AND document -> 'items' @> '[{"type":"product_grid"}]'`
reads 0 on both. Then, in one pull request: `productGridRequiredOnSave` reads `item.required === true`
alone (its `chosen` and `stored` parameters go, and `ProductGridFormContext`'s two fields), delete
`revisionItems` and its call, stop sending `gridRequiredSwitch` and delete its DTO field (the
`whitelist` pipe strips it from any client still sending it), and delete this entry.

### No date yet - a form editor newer than its server (2026-11-08)

**Site:** `serverFormDrafts()` (`frontend/src/lib/stores/appVersionCheck.svelte.ts`), read by the
form builder and editor; the server half is `formDrafts: true` in core-service's `GET /api/version`.
**Why.** A stable ships both stores before production deploys, so for days a phone build that
creates drafts talks to a social-service that does not know them: its validation strips `draft`,
creating a PUBLISHED form at once (an empty one, for a builder that creates its draft early), and it
answers the revision routes `404` - every editor would fail to open.
**What the client does.** It builds forms as drafts, reads and saves revisions, mints create keys and
resends device copies only on an estate whose `/api/version` says `formDrafts: true`; otherwise - an
older server, or no answer yet - it saves as it always did: one "Enregistrer" that creates the form
published, and an edit saved straight to the form (`PATCH /forms/:id`).
**Removal condition:** when no estate older than the release carrying `formDrafts` is served (both
estates deployed past it), the client branch for `false` may go; the field stays, always `true`.

### No date yet - a form editor or fill page newer than its server's priced grids (2026-11-13)

**Site:** `gridRequiredSwitchOn()` (`frontend/src/lib/forms/gridRequiredGate.ts`, over
`serverGridRequiredSwitch()` in `stores/appVersionCheck.svelte.ts`), read by `FormBuilder`,
`ProductGridQuestion`, both editor pages (`gridRequiredPayload`, `toFormItemsPayload`) and both fill
pages and `BookingSheet` (`firstMissingAnswer`'s `gridSwitch`); the server half is
`gridRequiredSwitch: true` in core-service's `GET /api/version`. Beside it, the words of the two
codes an older server still says (`PRODUCT_GRID_NOT_REQUIRED` in `productGridDefinitionMessage`,
`PRODUCT_GRID_EMPTY` in `productGridRefusalMessage`, compared as strings - neither is a contract code
any more) and the restored `isOrderEmpty`, `ORDER_MISSING_ID`, `revealOrderMissing`.
**Why.** A stable ships both stores before production deploys, so for days a `1.6.12` phone build
talks to a social-service before each grid's switch: that server refuses a grid sent
`required: false` (`PRODUCT_GRID_NOT_REQUIRED`) and its `whitelist` pipe drops `gridRequiredSwitch`,
so every save of a form with a new (optional by default) grid would fail; and it refuses an answer
whose visible grids hold no unit between them (`PRODUCT_GRID_EMPTY`), which the new fill page would
send.
**What the client does.** Only on an estate whose `/api/version` says `gridRequiredSwitch: true` does
it draw the switch and the asterisk on a grid, send each grid's flag with the marker, and hold a
required grid on its own card. Otherwise - an older server, or no answer yet - it behaves as `1.6.11`:
no switch and no asterisk on a grid, every grid sent `required: true` without the marker, a grid's flag
ignored by the fill pages, and an empty ORDER across the visible grids held beside the send button
("Commandez au moins un article"). A newer server reached with the gate still off (no answer yet)
reads a payload without the marker as an old editor's: it keeps each grid's stored flag ("a form editor
that cannot draw a priced grid's switch" above), so nothing is lost.
**Removal condition:** when no estate older than the release carrying `gridRequiredSwitch` is served
(both estates deployed past it), delete the client branch for `false` (the gate, the `gridSwitch`
parameters, the `order` kind of `MissingAnswer` and its helpers, the three restored French and English
strings `form_view_error_order_empty`, `form_refusal_grid_empty`, `form_pgrid_refusal_not_required`, and
the two string-compared codes) and this entry; the `/api/version` field stays, always `true`.

### No date yet - a form created by a build that does not know drafts (2026-11-08)

**Site:** `FormsService.create` (`apps/social-service/src/forms/forms.service.ts`): a create carrying
no `draft` is published at once, logged at INFO (`[FORMS] create without draft`); and
`forms."allowOnlinePayment"` defaults to true for a create or an edit that does not send it.
**What an older build does.** It creates a published form, as it always did, and a paid one is judged
at the create (`assertMayCollectNow`) as before - it never sees the draft state. It edits a draft
like any form (the edit route takes no `draft`, so it cannot publish one) and has no "Publier": a
draft it opens stays a draft until a current build publishes it. It sends no `allowOnlinePayment`, so
a form it edits keeps the stored value. It does not know `FORM_ONLINE_PAYMENT_NOT_OFFERED`: on a
cash-only form it still draws the online choice, and the server refuses that answer before anything
is written ([forms](frontend/modules/forms.md#a-form-is-a-draft-until-it-is-published-owner-2026-11-08)).
An older build also saves an edit straight to the form (`PATCH /forms/:id`), past an unpublished
revision a current build holds ([forms](frontend/modules/forms.md#edits-are-saved-as-they-are-typed-and-published-together-owner-2026-11-08)):
the revision's base fingerprint then no longer matches, and publishing it is refused
`409 FORM_CHANGED_SINCE_REVISION` until the manager confirms the overwrite ("Publier quand meme").
And it sees a DRAFT a current build is building as the empty shell the create page made (a title and
an association): the questions live in the revision, which an older build never reads.
**A rollback of production to an older release is the same hazard, server side, and wider.** An
older social-service does not know `forms.status` (migration 145 is additive and stays): it serves
EVERY draft on every respondent surface - the list, a post's card, the agenda, `/f/:id` - as an
open form, an empty shell for a draft the create page made, and it neither reads nor publishes the
revisions (`form_drafts` stays, unread). A rollback past this change therefore publishes the drafts
in all but name; before one, count them (`SELECT count(*) FROM forms WHERE status = 'draft'`) and
weigh closing them by hand against the rollback.
**Removal condition:** once the floor passes the first stable carrying this change, `draft` may become
the default of a create (a create without it a draft too). Measure before: the `[FORMS] create without draft` lines
in social-service count the older builds still creating forms.

### No date yet - a draft's association, between builds (2026-11-09)

**Site:** `FormsService.associationAfterEdit` (server), `createAssociationOf` (`frontend/src/lib/forms/draftResend.ts`).
**A current editor against an older social-service.** The editor now sends a draft's association in
every revision (`''` for none, never `null`, so an older server's `trim()` reads it). An older server
still refuses a DIFFERENT value at the publication, with an untyped `400`: the builder reads the
generic refusal and the draft stays as it was, revision included - nothing is lost, and the move
works once the server carries this change. The same value is no change on either side.
**An older build against the current server** never sends a draft's association on an edit (its
editor leaves the field out, its create page shut the picker): it moves nothing.
**A device copy kept before `createAssociationId` was recorded** (a create page of the 2026-11-08
build closed with its create unanswered) names its create's association from its document, which
WAS the create's then - that build shut the picker once a create was sent; read with a `Log.d` line.
**Removal condition:** device copies die at sign-out and land within a session, so the copy branch
may go one stable after this change; nothing to remove server side
([forms](frontend/modules/forms.md#a-drafts-association-may-change-a-published-forms-may-not-owner-2026-11-09)).

### No date yet - an association mute set by a build older than the bell (designed 2026-11-07)

**BUILT 2026-11-08 with WP-3 of [engagement](engagement.md) (L8).**
**Site:** the association push-mute routes (`associations.controller.ts`, `push-mute` and
`me/push-mutes`) and the four legacy methods of `follows/account-bells.service.ts` (`mute`, `unmute`,
`isMuted`, `listMuted`). WP-3 moved an association mute into `account_bells` (level `none`) by a held
copy (migration 143), and the bell control replaced the mute toggle on the client.
**What an older build does.** It still calls the mute and unmute endpoints. Without a shim, a mute it
set after the copy would land in `association_push_mutes`, which nothing reads any more: lost.
**The shim.** The old endpoints stay and write `account_bells` (mute = level `none`, unmute = delete
the row); their reads answer from `account_bells` too (`isMuted` is true at `none` only: a bell at
`lives` reads as not muted to an old build). Each site carries a comment pointing here. **And for an
older SERVER image during the deploy**, migration 143 installs a trigger mirroring every write on
`association_push_mutes` into `account_bells`, so a mute an old image writes while the new one rolls
out is not lost; it goes with the table's held drop, which MUST also `DROP FUNCTION canari_push_mute_to_bell()` (dropping the table removes the trigger, not its function). Since the review of #3156 the new code keeps the old table a SUBSET of the bells at `none`: any write moving an association bell off `none` (a level, the legacy unmute, a new follow) deletes the matching `association_push_mutes` row in the same transaction or statement, so a rollback and the data-subject export read a table that never contradicts the bells.
**Removal condition:** the floor (`minClientVersion`) at or above the first stable carrying the bell
control, raised once BOTH stores serve it. Then the old endpoints go, and the held drop of
`association_push_mutes` follows. Measure before: the endpoints' own debug lines counted per week
name how many older builds still mute that way.

### No date yet - a form reminder written by a server image older than the openings (2026-11-09)

**BUILT 2026-11-09 with WP-4 of [engagement](engagement.md) (L9).**
**Site:** migration 152 (`canari_form_reminder_to_opening()`, two triggers on `form_reminders`) and
the `FormReminder` entity still mapped in `forms/forms.module.ts`. WP-4 folded the "Me prévenir" asks
into `opening_reminders`; the three `/api/forms/:id/remind` routes keep their shape and write the new
table, so an OLD CLIENT needs nothing.
**What an older SERVER image does during the deploy.** It still writes and claims `form_reminders`.
Without a shim, an ask it took after the copy would be lost, and an opening due while both images run
could be pushed twice (each image claiming its own table).
**The shim.** 152's triggers turn an old image's insert or upsert into the same ask on
`opening_reminders`, its delete into the same delete, and make its CLAIM on the new row first: a
claim the new image already made cancels the old row's update (`RETURN NULL`), so one push. The new
code never writes the old table. `FormReminder` stays mapped only so a `synchronize`d local database
still has the table the trigger and the erasure name.
**Removal condition:** WP-4 has served one stable (no older image can be rolled out any more). Then a
HELD migration drops `form_reminders` AND `DROP FUNCTION canari_form_reminder_to_opening()`
(dropping the table removes the triggers, not their function), the entity is unmapped and the
erasure's `form_reminders` statement goes.

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

### No date yet - the further-device self-join held shut for member clients older than D2/D3

**Site:** `FURTHER_DEVICE_SELF_JOIN_OPEN` in `apps/chat-delivery-service/src/utils/device-seat.ts`,
read by `getGroupInfo` and `notifyWelcomeRequest` (`messaging.service.ts`).
**Shim (2026-11-01, review of #2832):** a member on any release up to `1.6.6` (the pull request was
re-merged onto `main` on 2026-11-07, after `1.6.6`) reads a further device that let itself in as an
accusation (`unvouched-device`) and withholds history from it. So the server does not
open D1's door: its `no_peer_online` answer says `selfJoin: false` (the client waits for a member's
Add), the conversation base is served without the asking device's seat (a join reads
`seat_unreadable`), and a `selfJoinIfNobody` ask is stored and woken as any other
([the gate](protocols/mls-availability-no-holder.md#the-gate-d1-waits-for-d2-and-d3-on-every-member-client)).
**Removal condition, two parts, in order:** (1) the self-join and a member's Add of the same device
made exclusive on the server - today a `pending` row withdrawn from Redis is still served by
`getPendingInvitations` ([backlog](backlog.d/p2-the-further-device-self-join-and-a-members-add-are-not-exclusive.md));
(2) a CLIENT FLOOR - `minClientVersion` at least the first release carrying D2/D3 (`1.6.7` at the
earliest; read it from `gh release list` and the merge commit). Then the constant flips to `true` in its own one-line pull request, and once a later floor is
reached the constant and its two reads go.

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
redirect hardening in [backlog](backlog.d/p2-the-mobile-sign-in-returns-through-a-custom-scheme-pkce-binds-the-code-not.md)
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

### No date yet - a push registration saying `wake: true` instead of `wakeVersion` (2026-11-07)

**Site:** `parseWakeVersion` in `apps/chat-delivery-service/src/utils/push-mode.ts`, and the
`wakeCapable` write beside `wakeVersion` in `PushController.registerPushToken`, and
`effectiveWakeVersion` in the same `push-mode.ts`, which reads a row's version as 0 while its
`wakeCapable` is false (a row re-registered by a server that knows only `wakeCapable`).
**Known gap, closed only by WP-W3c:** `wakeCapable` cannot tell version 1 from version 2. A server
rolled back before 046 that re-registers a downgraded binary still saying `wake: true` (version 1)
writes `wakeCapable = true` and leaves the stale `wakeVersion = 2`, so that device is read as
version 2 and sent envelope wakes its binary drops, until its next registration on a new server.
**Shim:** a registration body without `wakeVersion` that says `wake: true` - every build of step 1
(#2918) - is read as wake version 1 (the MLS frame wake), and `push_token.wakeCapable` is still written
(`wakeVersion >= 1`) so a rollback to a server that reads it sends the same pushes
([content-free-push](protocols/content-free-push.md#8-rollout-and-old-clients)).
**Removal condition:** `minClientVersion` at or above the first release whose client sends
`wakeVersion` (WP-W4), on both estates with both stores serving it, for the `wake: true` read; and
the held migration that drops `wakeCapable` (WP-W3c) merged and deployed, for the second write and
for `effectiveWakeVersion` (which then becomes a read of `wakeVersion` alone).

### No date yet - a device-notice marker named by the key in hex, written by a build before 1.6.1

**Site:** `announced_by_an_older_build` and `legacy_marker_name` in
`frontend/src-tauri/src/mobile/device_notice.rs`, and the legacy half of `remove_device_notices_of`
(with `device_notice_legacy_name`) in `frontend/src-tauri/src/commands/push.rs`.
**Shim (2026-11-01):** the device-notice ledger names a marker by the SHA-256 of its key since 1.6.1;
before, by the whole key in hex, which the filesystem refused for any key over 127 bytes
([mls-protocol](protocols/mls-protocol.md#new-device-notices-decided-by-the-user-2026-10-22-refined-the-same-day)).
So an old marker exists only for a SHORT key: **the shim applies only to accounts with a short user
id** (a key of at most 127 bytes, so a user id of roughly 40 characters or fewer); every other
account never had a marker written. The claim reads such a marker as "already announced", so the
upgrade posts nothing twice, and on that hit MIGRATES it: the digest marker is created
(`create_new`) in the account's directory. It is never written under the old name; an account's
deletion removes its own legacy markers from the ledger's root.
**Removal condition:** `minClientVersion` at or above 1.6.1, on both estates, with both stores
serving it, AND every installed build has run since and migrated its legacy markers. The
registration pre-claim does NOT settle it: it skips devices idle for 30 days (absent from the device
list) and keys still "new" by `isNewToItsOwner`, so a legacy marker can outlive it; only the
migration on a hit retires one. Data at rest, so the floor alone does not retire this.

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

### No date yet - read marks on the `sentAt` clock: the stamped map, and the `at` of a `read_watermark` frame (2026-10-31)

**Site:** `readState.ts` (`readWatermarks` beside `serverReadWatermarks`, `isCoveredBy`,
`readWatermarkFrameMark`), `systemMessageHandler.ts` and `historySystemEvents.ts` (a frame with no
`serverAt`), `readWatermarkCache.ts` (the native shade), `readWatermarkFrameData` (the `at` this build
still sends).
**Shim:** since 2026-10-31 a DM or group is ordered and read on the SERVER's clock
([chat](frontend/modules/chat.md#conversations-are-ordered-by-the-servers-clock-decided-by-the-owner-2026-10-31)).
Every mark written before, every frame from an older client, and the native shade's "mark as read"
are on the author's `sentAt` clock, and a bare number cannot say which. So they are KEPT in the
stamped map and compared against the row's `timestamp`, and a row is read when either map covers it.
In the other direction this build sends `{ at, serverAt }` with the same value: an older client reads
`at` and compares a server instant against `sentAt` - off by the delivery latency, which it already
was against its own peers' clocks.
**What it costs:** a late message whose `sentAt` is older than a STAMPED mark still reads as read, the
pre-2026-10-31 behaviour, wherever that stamped mark is the newer of a reader's two. An upgraded
reader's stamped mark stops moving (its own reads write the server map), so the residue shrinks to the
iOS shade, an Android notification posted by an older build, and older peers.
**Removal condition:** the native shade sends `serverAt` on BOTH platforms (Android does since
2026-10-31, `EXTRA_SERVER_AT`; iOS must hand the push's `createdAt` down to
`canari_native_build_read_watermark_proto` and `CanariAppendReadWatermark` - owed), the floor passes
the first release where both do, AND no frame with a bare `at` is observed in a history bundle for a full
retention window (90 days) - a frame outlives the client that wrote it, as for `read_receipt` above.
Then the stamped map is read for salons only (whose two clocks are one) and the `at` alias goes.

### No date yet - a downgrade below the server-time order: SQLite v16, IndexedDB v12, `outbox_sent` lines (2026-11-01)

**Site:** `sqlite.ts` (the v16 step and the open-time `MESSAGE_PROVISIONAL_ORDER_FILL`),
`sqliteMigrations.ts` (`MESSAGE_ORDER_MISSING_INDEX_STATEMENT`), `indexeddb.ts` (the v12 upgrade),
`outboxMirror.ts` (`id<TAB>receivedAt` lines), the native drains (`CanariFirebaseMessagingService.kt`,
`canari_push.mm`).
**What a build older than the server-time order (`1.5.4` and before) does with what this one leaves:**

- **SQLite, a v16 file opened by an older native build** (a store rollback, or a sideloaded older
  APK). It runs no migration above its own version (15), so it opens the file as it is: it recreates
  its `idx_messages_conv_time` (unconditional), reads pages on `timestamp` and ignores `order_at`,
  `order_pending` and `server_read_watermarks`. Every row it WRITES names no `order_at`, so it lands
  with none - and a row it rewrites (`INSERT OR REPLACE`) loses its key. **Back on this build** the v16
  step does not run again (`user_version` is still 16); the open-time fill re-keys those rows
  provisionally through the partial index `idx_messages_order_missing`, and the page reads derive them
  (`messagesPage.test.ts`, "a row written by an older build that opened the v16 file"); the
  `idx_messages_conv_time` it recreated is dropped again on the same open.
  **The `server_read_watermarks` residue:** the older build writes a conversation row with
  `INSERT OR REPLACE` naming no `server_read_watermarks`, so every conversation it saves comes back
  with that column NULL - the server marks of EVERY reader of it, this device's and its peers', are
  gone. Its own reads in the meantime land in the stamped map, covered by the rule above, so nothing
  it read turns unread; what is lost is the server-clock part: a peer's "seen" head falls back to
  their stamped mark (or disappears) until their next `read_watermark` frame or a history bundle
  carries the server map again, and a late message this device had read only by its server mark
  reads as unread until it reads the conversation again. Nothing repairs it on open: the values are
  not anywhere on the device to restore from.
- **IndexedDB, a v12 database opened by an older web build** (a web rollback). `indexedDB.open` with
  the older version number fails with `VersionError` - IndexedDB never opens a database below its
  version - so the older build cannot open the store at all, as with every earlier version bump. **A web
  rollback past this change is therefore not a path**: the answer is a fix forward, or the older build
  rebuilt with this upgrade's version number and its own schema. The desktop and mobile apps are not
  affected (SQLite, above).
- **`outbox_sent.ndjson` lines of the form `id<TAB>receivedAt`**, written by this build's native drain
  and read after a downgrade by an older TypeScript, which takes the whole line as the id. It matches
  no outbox entry, so the entry stays and the next foreground flush sends it again - a duplicate the
  receivers drop on `messageId` (the same cost as a missed reconciliation, `outboxMirror.ts`), and
  the sender's own row stays undated until that send answers.

**What it costs:** nothing on the way up. On a downgrade: pages on `sentAt` again (the older build's
order), one duplicate POST per background send whose line it reads, and no web rollback.
**Removal condition:** none to remove - the provisional fill on open is the steady-state answer to a
file an older build touched, and it costs one probe of an empty partial index. Revisit when the floor
passes the first build that writes `order_at` (then no supported build writes a row without it, and
the open-time fill and its index can go with a migration that drops the index).

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

### No date yet - `kind=reel` on `feed=all` read as the CanaReels viewer list (2026-11-03)

**Site:** `resolveListFeed` in
[`apps/social-service/src/posts/list-feed.ts`](../../apps/social-service/src/posts/list-feed.ts),
called first in `PostsController.listPosts`.
**What it humours:** every installed client up to `1.6.x` asks the CanaReels viewer's list as
`GET /api/posts?kind=reel&singlePhotos=true` with NO `feed` (`buildListPostsSearchParams` drops
`feed=all`), which ran the "Mon espace" arm - filtered by spaces, so a reel the reader may see only
as an accepted follower, or through a member repost, never reached the viewer
([reels](frontend/modules/reels.md#the-canareels-entry---an-icon-beside-the-tabs-that-opens-the-viewer-user-2026-10-16),
point 3). The server reads that shape as `feed=reels`, so installed apps get the fix with the server
deploy. **Why the mapping is safe:** since `1.2.9` no tab sends `kind` - the filtered-feed mode was
deleted (reels.md point 5; `routes/posts/+page.ts` and `buildListOptions` never set it), and the
only `listPosts({ kind })` caller in the client is `reels/allReels.ts`. Production's floor is past
`1.2.9`, and dev's `1.2.7`-`1.2.8` builds predate the filter, so their only `kind=reel` was the
viewer too. A `1.2.9-alpha.2`/`.3` device still filtering its "Tout" tab would get the viewer's set
there: reels it may see, nothing more. Since 2026-11-11 the server reads `multiMedia` alone; a
pre-floor client asking `singlePhotos` alone now gets the reels only, and none unlocks under the
`1.6.6` floor.
**Why the client still sends the old shape:** a stable ships both stores BEFORE production deploys,
and `feed=reels` is refused `400` by an older server's `@IsIn` - a native build sending it would
lose the viewer for those days. So the client switches (`listAllReels`: `feed: 'reels'`, and
`ListPostsOptions.feed` learns the value) in a PR merged once BOTH estates serve `feed=reels`.
**That condition is MET** (#2990 is first in `v1.6.3`; production and dev both serve past it,
2026-11-08) and the switch is NOT made: `listAllReels` still sends `feed: 'all'`, so floor `1.6.6`
retires nothing here - the floor that matters is the first stable carrying the switch.
Measured by its line at `log` level, one per legacy request: `[LEGACY] list: kind=reel on feed=all
read as feed=reels (an installed client)`.
**Cost while it stands:** none - one comparison per list request.
**Removal** (once `minClientVersion` is the first stable sending `feed=reels` on both estates, and the
`[LEGACY]` line is silent on both): delete the `all` + `reel` branch of `resolveListFeed`, its log and
its spec cases; `kind=reel` on `all` is then "Mon espace" narrowed to reels, which no client asks.

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
**This one has a SECOND store behind it, and the date does not cover it.** The stored register
(`canari_pins_*`, per account since 2026-11-12 as `canari_pins:v1:<account>:<conversation>` - see
[the entry below](#2027-02-12---the-pin-register-stored-under-the-conversation-alone-canari_pins_conversation),
which moves the old copies without rewriting their shape) is `localStorage` on each device, which nothing on the server can reach and no retention window bounds.
The `Array.isArray` arm may only go once every device has rewritten its own entry - which happens on
the first pin change in each conversation - so on the date, delete the two frame-shape fallbacks and
re-read that arm as its own question.
**Cost of keeping it:** an undated pin loses every tie against a dated one, so a device that pinned on
an old client and a device that unpinned on a new one converge on unpinned even if the pin came
second. The user can always pin again; the reverse - a resurrected pin nobody can explain - is the
outcome the dating exists to prevent.

### 2027-02-12 - the pin register stored under the conversation alone (`canari_pins_<conversation>`)

**Site:** `takeLegacyRegister` and `legacyKey` in `pinStore.svelte.ts`.
**Shim:** builds before 2026-11-12 stored the register under the conversation id alone, so every
account of an install shared it and neither a sign-out nor the account deletion's sweep removed it.
When the signed-in account reads a conversation it holds no register for, the legacy copy is moved to
it (`ACCOUNT_KEY.conversationPins`) and the legacy key removed, with one `[PINS] legacy register ...
moved` line; a write that fails keeps the legacy key, read again and moved on the next try.
**On a shared install the FIRST account to open the conversation takes the old register**, the
other accounts there start from none: the old copy cannot say whose pins it held, since it was all
of theirs. Nothing is lost for them - every history bundle restates a conversation's pins, so the
others converge on the next bundle they receive.
**Replacement:** the per-account key, forgotten at sign-out (`forgetConversationPins`, as the nickname
registers are) and swept by the deletion with every other per-account key.
**On removal:** replace the move by a one-shot removal of every `canari_pins_*` key left (a
conversation nobody opened in three months), then delete both functions. Three months from the
change, so that a device opened even rarely has moved what it holds.
**Cost of keeping it:** one `getItem` on the first read of a conversation that has no register yet.

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

## Nothing to remove - an UNSIGNED single-event calendar link now gets a 403 (2026-11-02)

**A BREAK, not a shim.** `feed.ics?eventId=..` now needs that event's signature (`sig`, served with the
event as `icsSig`); without it, or with another one, the answer is a bodyless 403 logged
`[AGENDA_ICS_REFUSED]`. The owner decided it on 2026-11-02, with no time-based grace period
([D40 closed](profiles-and-access.md#d40-closed---no-event-is-published-to-an-anonymous-reader-2026-11-02)).

- **Who is affected:** a one-event link opened from an app build that predates the signature (it builds
  the unsigned form), or one saved before this release. The reader opens the event again in an
  updated app, which builds the signed link.
- **What to measure:** the `[AGENDA_ICS_REFUSED]` count in the social-service logs after the release;
  the day it is zero, nobody holds an old link. There is no branch to delete: the refusal is the rule.

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
