# Device verification runbook

Everything native in Canari is verified by **compiling**, which proves nothing about running. A
manual `workflow_dispatch` of either release workflow is the only way to compile Swift/ObjC/Kotlin
from a Windows machine, so that is what the mobile work has been gated on - and it is why several
Work Packages sit open with correct-looking code that has never executed on hardware.

This file is the single ordered pass that closes them.

**Its sibling is [cross-client-testing](cross-client-testing.md).** This page asks "does this native
path work on hardware at all?" - one device, one check. That one asks "does the system stay correct
when several clients, several lifecycles and a damaged store meet?" - two browsers and a phone at
once. Checks H, K, L and M below are re-exercised there, in context, rather than in isolation.

**It is the only place they are tracked.** On 2026-08-04 every Work Package whose sole remaining
debt was "run this on a device" was deleted from `CLAUDE.md` and folded in here - a check owed is
not a work package, it is a line in this table. The WP ids are kept in the table because commits and
`CHANGELOG.md` name them. **A check that FAILS earns a new WP; a check that passes earns a PASS
here and nothing else.**

**The bench is the Mi 9T and the iPhone 12. The Pixel 6a is the user's personal phone: observation only** (user, 2026-10-11) - no agent installs, resets, signs in over or drives it; a reading on it is the user's own look.

## The readings triage of 2026-11-14 - what is kept, what each needs, and the sittings

**The rule (owner, 2026-11-14):** the readings owed reach ZERO before a release; each is READ with evidence or
DELETED with a measured reason; a reading of code not shipped in a STABLE is deleted outright. The latest stable is
`v1.6.12` (it ships the `alpha.2` commit; everything merged after `#3500`, from the group calls `#3489`-`#3502`
onward, is NOT in it). The triage kept 55 of the 77 entries (21 files removed, 1 turned into a defect entry), each
below naming a reading this bench can do. Every entry carries its own "Triage 2026-11-14" paragraph in
[plan](plan.md#readings-owed). **Deleted, with the reason in the entry's changelog line:** the GIF relay (every half
read), the iOS launch logo (no outcome changes anything), the desktop screen broadcast and the three group-call
entries (unshipped, `#3508` and `#3489`-`#3502`; the group-call readings are carried in
[the group-call decision](backlog.d/group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md)), the
institution event reach (all nine read, row 3's staff half pinned by an integration spec). **Merged:** the salon
banner readings, the shade and quick-reply readings, the killed-phone background joins, the two iPhone ring
readings, the two Android call-service readings, the two sealed-at-rest readings, the two CanaReels camera
readings, the two chip-and-switch readings, the mention and speaker readings. **Deleted halves:** whatever needs an
ear, a hand turning a phone, a shaped link, an iOS 16 device, a screen picker, an older iOS build, or a state only
production holds.

**Needs a state the bench has: dev sends push to a KILLED phone since 2026-10-21** (the old "WAITS: no Firebase
sender" lines were wrong), the iPhone's banners are read and tapped with `ios.mjs nc`, `hold`, `tap`, and a web seat
plays any peer.

| Sitting | What it holds | Minutes |
| --- | --- | --- |
| Web and rig, no phone | pseudos 30, script policy (web) 10, waiting-seat ring 20, LEAF-REFRESH rows 10, NOTIF-17b 5, staging the institution reel and post 20, live titles on a web seat 10 | 105 |
| Bench build | F1 on the iPhone (`ios.yml` with `local_url`) 40, seeds mirrored before the label (old APK, Mi 9T) 30, sealed caches upgrade (v1.4.0 APK, Mi 9T) 30 | 100 |
| Both phones together | noise suppression routes 30, the call that survives the app leaving the screen and the audio focus 50, the deploy drill 40, campus trends 30, new-device notices 30 | 180 |
| Mi 9T alone | see the list below | 735 |
| iPhone 12 alone | see the list below | 520 |

**Mi 9T alone (735 min), one push sitting then one UI sitting.** Push sitting (dev push, web seat as the peer):
resume reload (2) 15, shut phone catches up 15, post push with a dead session 15, NOTIF-10 15, killed-phone
background joins 30, history ask 20, mention and speaker 20, republish push 25, co-organiser push 25, comment and
reply opens at the comment 15, first message from nobody 25, notification face 5, ciphertext once 10, Rust push
sentences 10, row carries the group name 15, blind salon banner and Marquer comme lu 25, the shade (6b/6c/6d, K,
D2, D3) 40, F1 killed 10, openings WP-4 20, bell WP-3 15, checkpoint
durations 15. UI sitting: follow suggestions 25, routes sweep 10, CanaReels 30, in-session join 15, 13 MB 15, reply swipe 15, menus 10,
live chat of named readers 40, live titles 25, birthdays 15, institution and Entre etudiants 25, Voir plus 10,
camera volume keys 20, rotation (lock ON) 20, overlays 15, read receipts 10, microphone channel 10, script policy
10, sharing 30.

**iPhone 12 alone (520 min), the same two sittings.** Push sitting (`ios.mjs nc`/`hold`): mention unknown author 15,
republish push 15, co-organiser push 10, comment and mention replies 10, ciphertext once 10, Rust push sentences 10,
group name 15, the shade 20, killed-phone join foreground half 10, follow 25, openings 20, bell 15, native ring and
foreground ring 25, caches (b)(c)(d) and hardware key 20, checkpoint 15. UI sitting: routes by eye 25, emoji rows 10,
CanaReels 35, in-session join 15, 13 MB 20, reply swipe 15, menus 10, live titles 25, birthdays 15, institution and
Entre etudiants 25, Voir plus 10, camera volume buttons 15, rotation (lock ON) 20, overlays 15, microphone channel
10, tab swipe class A 10, sharing banner tap 10.

The total is about 1640 minutes, 27 hours.

## Where the pass stands

**2026-11-15, the web and rig sitting (dev answering `1.6.12-alpha.2`, build `dd9053e4e`; one gamma seat on the harness Chrome slot W4 in its own tab, one alpha seat in its own tab of slot W3; no phone; every group was created by the sitting and deleted at its end, the one block between the two accounts was lifted within 20 minutes).**

| Row | Verdict | What was seen |
| --- | --- | --- |
| W1. A waiting seat is not rung | **PASS** | Gamma made a one-member group and minted its link; alpha followed it and read "Demande envoyee" (`user-members`: alpha `awaitingAdmission: true`, with an `askId`). Gamma then rang the group (`POST /api/calls/initiate` then `/ring`, then `/ring-end`): the server wrote `[ring] call=... has no other member to ring` and `ring-end ... notified=1/1`, against `rang=1/1` and `notified=2/2` for a call of two admitted members in the same minute. The ask card ("X wants to join the conversation", Accept / Decline) was on gamma's seat. Alpha was then accepted: `[COMMIT] ... admits 11 device(s) at epoch 2`. The control "the same group rings alpha once admitted" was NOT taken (it would have rung the Mi 9T's account) |
| W2. "Modifier les pseudos" | **2 PASS (approval path), 4 PASS (group half), 7 PARTIAL, 1, 3, 4 (community), 5, 6, 8 LEFT** | (2) Gamma set a nickname on itself, then alpha was added by the approval of its link ask (the same `inviteMembersToGroup` as "Ajouter"; alpha's other devices held no leaf in this group): at once alpha's panel read "Canari Test Gamma - Defini avant votre arrivee" and `canari_nicknames:v1:<alpha>:<group>` held the entry (`verified: false`); the inviter logged `[JOIN_PUSH] ... join push -> <device>`, `Empty bundle sent` and `Full history sent: 1 of 3 message(s)`; 8 of its 11 devices answered `NOT DELIVERED` (offline or an older session, the known limit). (4) Gamma set a nickname for alpha, alpha saw it ("Defini par ..."), then alpha blocked gamma: alpha's row for itself read "Un pseudo que vous ne voyez pas est defini pour vous. Reinitialisez-le pour l'effacer pour tous." (7) alpha's reset of it cleared it on gamma's seat (row back to "Set a nickname"). **Not read:** a third device offline (1, 3: no third seat that is free), a community set answering `USER_BLOCKED` and its report in `/admin/moderation` (4, 6: no community with gamma as moderator and alpha a member was staged), an older build (5), the sign-out then another account (8: it would sign out a shared seat), and 7's "blocked setter's nickname" for a THIRD member (the setter's own nickname set before arrival still displayed for alpha after the block, because its setter is unverified there) |
| W3. Script policy, the gestures | **PASS (web)** | A `securitypolicyviolation` listener and the CDP console on gamma's seat, driven by real mouse input: a CanaReel played in the conversation viewer (`readyState 4`, 540 px wide), an image sent and opened in the viewer, a PDF sent and opened in the PDF viewer (page drawn, "1 page"), the GIF picker (relay media loaded), the association "Directory" (trombinoscope) export (a `blob:` download began). 0 violations and no policy line in the console but the edge's injected-script refusal that each document load writes (documented). The four `404` resource loads the export page wrote were not traced to a URL |
| W4. LEAF-REFRESH-1..4 | **LEFT** | The four rows are `pending - no runner` ([the table](cross-client-testing-archive-1-4-0.md)); the nearest runners (CC-4, KILL-1..2, DEV-2..3, NET-2) drive W1 and W2, which are ports 9224 and 9223, and 9223 was another sitting's. Nothing was run |

**Found on the way, filed:** a newcomer's thread read "Compte supprime a ajoute Compte supprime au groupe" for its own Add ([entry](protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice)).

**2026-11-09, the bench readings of `v1.6.9-alpha.1` (dev answering `1.6.9-alpha.1`, build `100600901`): Mi 9T `canari-test-alpha` (the release `app-universal-release.apk` sideloaded with `adb install -r`: Play had not been asked, the install carries no installer), iPhone 12 `canari-test-gamma` (TestFlight offered `1.6.9 (100600901)`, taken from the TestFlight app), the harness Chrome slots as beta, gamma and delta (W5 started for delta).** Screenshots are kept out of the repo.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. iOS share suggestions donation (#3167) | **PASS** | After the unlock, `pymobiledevice3 syslog live` carried `[ShareSuggestions] publish: 5 of 5 donated`, no refusal code (1901) anywhere in the capture. The share sheet itself was not opened to look at the suggestions |
| 1b. Tab title of an association page after in-app navigation (#3167) | **PASS** | iPhone, feed then the association link: the page's accessibility title read `Club d'Echecs Fictif - Canari`; the same route on the `alpha.3` build read the slug `echecs-fictif - Canari`. A second hidden label of the screen read `Association - Canari` (a route-announcer text, probably; not investigated) |
| 2. Chat long-press (#3168) | **PASS** | iPhone and Mi 9T, arriving in a conversation then a 900 ms press on a bubble: no selected word, no handles; the reaction bar plus ONE row of icons (seven on the iPhone for an own message: reply, forward, copy, share, pin, edit, delete; five on the Mi 9T for another's message) |
| 3. Emoji picker paints at once (#3170) | **PASS** | iPhone, app terminated and relaunched, FIRST picker open of the session (reaction "+"): the screenshot taken straight after the tap, while the sheet was still sliding in, already held the tab bar with its nine icons and the first screen of cells at full size, none blank, none growing. A warm open the same |
| 4. "Mes formulaires" actions on one row (#3169) | **PASS** | iPhone (a draft with 5 actions and two forms with 7) and Mi 9T (7): every action of a card on one line, each 44 px tall (rects `y=427` for all five of the draft, `y=581` for all seven of a form); the card description shows plain text, no markdown markers |
| 5. Two-tab follower header, selection across promotion (#3173) | **PASS, live End NOT TAKEN** | One browser profile, tab A (communities) and tab B (chat, new, PIN unlocked): tab B read `Connecte` (the pill, not `Hors-ligne`), a conversation opened in B stayed open and `Connecte` held after tab A was closed. That B was the follower at the time was inferred from the order, not proved (`navigator.locks` lists the `canari-tab-leader` lock without its holder). A live was not started (no camera) |
| 6. Drag and drop into the post composer, Chrome (#3171) | **PASS** | Real `Input.dispatchDragEvent` with a file path (enter, over, drop) at three places of the open sheet: on the media strip area and the text area (a PNG each: `1/10`, `2/10`) and on the toolbar row (a text file: `3/10`, drawn as a file tile); the sheet was closed unpublished. An image dragged from another web page (URL, no file) was NOT tried |
| 7. Engagement WP-2, Suivre (#3176) | **PASS** | Mi 9T: the chip on an association post header followed at ONCE and disappeared (and from every other header of that association); the chip on a personal post header (icon-only on the phone) became `Demande envoyee - retirer la demande de suivi ...` on all six headers of that person at once; the person accepted from the web bell (`Demandes d'abonnement en attente: 1`, `Accepter`) and `follow-status` answered `accepted`. Web: the chip on six association cards (beta) and on three directory rows (never on itself). No chip on an association post of a club the account is a member of |
| 8. Community role names (#3175) | **PASS** | Delta (administrator) of the bench community: the `Roles` tab holds a `Noms des roles` editor; renaming the member role made the member badges of the open member list of another account read the new name at once without a reload; a blank save restored the default (checked after a reload). A non-admin (gamma): no `Roles` tab and no editor |
| 9. Nicknames, the 8 readings | **1 PASS, 2 FAIL, 3 PASS, 4-8 NOT TAKEN** | See [the entry](plan.md#readings-owed); **FAIL 2**: a member added after a nickname never showed it - fixed by #3185 (first stable `v1.6.9`), re-read as item 2 of that row |
| 10. Birthdays | **5 PARTIAL, 6 PASS, 1-4 and 7 NOT TAKEN (need the day)** | See [birthdays](birthdays.md); what is left is an entry of [the readings owed](plan.md#readings-owed). The date was set on the iPhone account for TOMORROW and the Mi 9T account follows it, so the morning notice and the ring can be read on 2026-11-10 |
| 11. Community open on the Mi 9T (#3174) | **MEASURED** | See [community-open-budget](frontend/community-open-budget.md#per-bubble-and-per-day-work-cut-2026-11-08): cold and warm, five runs each, 1x |

**What this pass left on dev, for the next reading to know:** the account of the iPhone has tomorrow's birthday saved (visibility followers) and the Mi 9T account follows it; the Mi 9T account follows "Liste Fictive 2026" and the web account `beta` is a fourth member of the bench group "nse banc groupe" (it has no remove path run). Nicknames, the role name, the post and every attachment of the drag-and-drop were removed.

**2026-11-04, the bench readings of `v1.6.4-alpha.2` (dev answering `1.6.4-alpha.2`): Mi 9T `canari-test-alpha` (the release APK sideloaded, versionCode `100600402`), iPhone 12 `canari-test-gamma`, the harness Chrome as gamma and delta.** TestFlight offered only `1.6.4 (100600401)` (`alpha.1`) on the iPhone; `alpha.2` changed only the deploy scripts (#3003), so the iPhone read the same client code.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| SC. Cancelling the iOS sign-in sheet (#2995) | **PASS** | The system sheet cancelled three times in a row: each time the button read "Se connecter" again at once and the next tap reopened the sheet; never the stuck "Redirection..." |
| T. The native tab bar under the tour (#2997) | **PASS** | Tour replayed from Settings: taps on the four tab icons and the bar's band at steps 1, 3 and the last left the tour on its step and the route on the feed; after "Terminer" the chat tab worked; after a terminate and relaunch mid-tour the bar worked at once |
| Guided help, batch 2 (#2996) | **PASS** | Both phones: the feed-tabs hint (1/3 to 3/3), then CanaReels alone at the next visit, then the chats hint; one help per visit. Mi 9T: "Revoir les aides" lists the four hints and replays one; a hint left at 2/3 by navigating away came back at 1/3 |
| Named readers' comment switch (#2998), the procedure of its backlog entry (entry deleted 2026-11-15) | **PASS** | Through the app's routes on dev, a throwaway association, post, comment, reaction and named poll: switch OFF - post 200 with `canSeeComments:false` and no comments, reactions as delta's own plus `otherReactionCounts`, the poll as tallies, `GET`/`POST /comments` 404, `POST /reactions` 201; switch ON - the comment and the names back, `GET /comments` 200, `POST` 201; the journal shows the grant and the switch. Every fixture removed |
| The moderation tombstone (#2999) | **PASS** | delta (a non-admin BDE moderator) deleted a student's comment under the BDE's post that carried an institution's reply: 200 with one tombstone; the list shows "Commentaire retiré par la modération" with the institution's reply kept under it and the badge counting 1; a reply and a heart to the tombstone answer 409 `COMMENT_REMOVED_BY_MODERATION`; delta's delete of the institution's reply answers 403 `MODERATION_RESERVED_TO_PLATFORM_ADMIN` on both delete routes. Every fixture removed |

**The dev bench accounts (owner, 2026-11-04).** Their rights live in DEV's own database, never in the
identity provider, which production shares and which is not touched:

- **`canari-test-gamma` is the bench's dev global admin** (`users.admin`); after a dev reset it is
  restored by the one statement of [dev-environment](infrastructure/dev-environment.md#3-the-data-a-fictional-seed-and-nothing-from-production-owner-2026-10-16).
- **`canari-test-delta` is the bench's non-admin BDE moderator on dev**: a permanent membership of
  the fixture "BDE Fictif" with the `MODERATE` permission, added through
  `POST /api/associations/:id/members` as gamma. It must NOT become an admin: a platform admin
  moderates everything, so only a non-admin moderator shows a tombstone. A dev reset removes it; it is
  re-added the same way, and that call is the owner's to approve (an agent's permission layer refuses
  a permission grant). **Since 2026-11-04 it is also a NON-STUDENT (empty cursus)**: see [the 1.6.4 fixtures](#dev-bench-fixtures-for-the-164-readings-2026-11-04).
- `canari-test-alpha` and `-beta` are ordinary students, **until the fixtures below turn them into
  an officer and a non-student**: read [the 1.6.4 fixtures](#dev-bench-fixtures-for-the-164-readings-2026-11-04).
- **Driving dev without typing a password:** from a signed-in dev page, `POST /api/auth/refresh`
  (cookie) returns an access token for `fetch` with `Authorization: Bearer`. Fixtures are created
  through the app's routes (`POST /api/associations/admin`, `POST /api/posts` with `associationId`,
  `.../comments` with `parentId` and `associationId` for a reply in an entity's name) and removed with
  `DELETE /api/posts/:id` and `DELETE /api/associations/:id`. A comment's id is NOT in its create
  answer: read it from `GET /api/posts/:id/comments` before replying with `parentId`.

### Dev bench fixtures for the 1.6.4 readings (2026-11-04)

Prepared on dev for the readings `1.6.4-alpha.3` could not take. Everything went through the app's
own routes as a signed-in bench account (the refresh-cookie token above); **the only SQL writes are
the ones listed under "SQL writes"**. Every association is a seeded fictional one. A dev reset
removes ALL of it (the reels' rows, the memberships, the grants, the product, the cursus change):
recreate it with the recipes below, in this order.

| Reading | What exists on dev | Who reads it |
| --- | --- | --- |
| **(a) 10 video reels** (slow-network CanaReels, #3015) | 10 `kind=reel` posts, 5 by `canari-test-alpha` and 5 by `canari-test-gamma`, captions "Banc reel 1".."Banc reel 10": 540x960, 8 s, H.264 baseline plus AAC, about 2.9 MB each (3 segments of the `segmented-v1` container), declared `durationMs` 8000. The round trip was checked (download, decrypt, `ftyp` header, size equal to the declared size) | any signed-in student account of ICM Saint-Etienne |
| **(b) a shop with a product** (`hint-asso-shop`, guided help batch 3) | "Club Photo Fictif" (`photo-fictif`): one ACTIVE product "Sticker Canari (banc)", 2.00 EUR, type `other`. Payments cannot be taken on it (see "SQL writes"), so it is for the hint's anchor only, never a checkout | any signed-in account opening `/associations/photo-fictif` |
| **(c) an association officer who is not an admin** (students-only switch, edit form, #3010) | `canari-test-alpha` is a member of "Club Photo Fictif" AND "Club d'Echecs Fictif" with role "Bureau (banc)" and permissions `4355` = `POST_AS_ASSO` + `PROPOSE_EVENT` + `MANAGE_PRODUCTS` + `EDIT_PROFILE` (not `MANAGE_MEMBERS`, not an admin). Posts published as the association: Photo "Annonce du Club Photo (banc): sortie photo samedi" and "Club Photo (banc): exposition de fin de semestre"; Echecs "Echecs (banc): tournoi du jeudi, ouvert a tous". All three have the switch OFF. Alpha edits them (`PATCH /api/posts/:id` answered 200 and was put back) | Mi 9T (alpha) |
| **(d1) a non-student recipient of a repost proposal** (bell row, #3019) | `canari-test-delta` AND `canari-test-beta`, both with an EMPTY cursus (campus Saint-Etienne, no space), each a member with `POST_AS_ASSO` of a receiving association (delta: "Club Robotique Fictif", beta: "Fanfare Fictive") that holds a PENDING repost proposal from "Club Photo Fictif", one proposal per Photo post above (switch OFF at proposal time; turn it ON as alpha to read the blanked text). **BLOCKED by a defect: their bell answers 500 until the fix of #3019 (its own pull request) is deployed** | delta on the harness Chrome slot W5, beta on W4 (both signed in) |
| **(d2) a named reader with a grant-only door** (live chat, #3014) | `canari-test-beta`: a read grant on "saint-etienne, whole campus", "voit les commentaires" OFF (the default), NO membership of the association watched, no cursus. Read through the API on an Echecs post: 200, `canSeeComments: false`; a "students only" post 404 | beta (W4) |

**Added 2026-11-05 (booking hints, batch 4):** the booking space "Banc 165 (2 colonnes)", owned by "BDE Fictif", with 2 resources, created through the app's routes as gamma.

**Why beta, not delta, is the named reader.** delta is also the BDE moderator: a `MODERATE` holder
opens an Echecs post by id (200, comments visible, even a "students only" one), so a live read
through delta would be a moderation read, not a grant-only one (the unasserted case of
[profiles-and-access](profiles-and-access.md#nominative-read-grants-as-built-wp-c-2026-10-08)).
beta holds nothing else.

**Broadcasting an association's live on dev** (lives are on: `GET /api/version` says
`lives.mode: on`). Proven by API as alpha: `POST /api/lives` with `{ key: <64 hex>, associationId:
<Photo or Echecs> }` answered 201 and `POST /api/lives/:id/end` 200 (the first-live rules were
already accepted). The `/api/lives` routes answer 404 to a request WITHOUT the header
`X-Canari-Client-Version` (at least the lives floor), which looks exactly like "lives off". A live
needs real video, so it cannot be left standing as a fixture; to take the reading, either:

1. **Mi 9T as alpha** (the app, the real path): feed composer, "Go live", pick the identity
   "Club d'Echecs Fictif", then watch from beta's Chrome (W4); or
2. **a scripted broadcaster** through `tools/live-bench/bench.js` evaluated in alpha's page
   (`inject.mjs`, its README): its `POST /api/lives` body has no `associationId`, so a copy of
   `bench.js` with `associationId` added to that one body is needed; it needs a camera, so Chrome
   must be launched with the fake-device flags (`--use-fake-device-for-media-stream
   --use-fake-ui-for-media-stream`), which the launcher does not set.

Then write a line in the live's chat from a native viewer (a student account) and read beta's view
against the entry's procedure (entry deleted 2026-11-15).

**Recipes** (token = `POST /api/auth/refresh` from the account's signed-in dev page, field
`access_token`; every call carries `Authorization: Bearer` and, for `/api/lives`,
`X-Canari-Client-Version`):

- **(a)** `ffmpeg -f lavfi -i testsrc2=size=540x960:rate=24:duration=8,hue=h=N*36 -f lavfi -i
  sine=frequency=...:duration=8 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -b:v 3M -c:a aac
  -movflags frag_keyframe+empty_moov+default_base_moof -shortest reelN.mp4`; then, per file: encrypt
  with `encryptSegmentedMedia` (`frontend/src/lib/mediaSegmented.ts`, WebCrypto only, runs under
  `bun` once its `$lib/` imports are made relative), `POST /api/media/upload` (multipart `file` plus
  `retentionClass=reel-pending`, under the 10 MiB request budget), then `POST /api/posts` with
  `{ kind: 'reel', durationMs: 8000, markdown, media: [{ type: 'video', mediaId, key, iv, mimeType:
  'video/mp4', size, fileName, width: 540, height: 960, encoding: 'segmented-v1' }] }`. Same path as
  `publishReel.ts`, minus the re-encode (the file is already one fragmented MP4).
- **(b)** as gamma: `POST /api/associations/:id/products` `{ name, amountCents: 200, type: 'other' }`
  (created INACTIVE: the platform withholds it while the association's payment onboarding is not
  done, and `PATCH ... { isActive: true }` answers 400), then SQL write 2.
- **(c)** as gamma: `POST /api/associations/:id/members` `{ userId, role, permissions: 4355 }`;
  then as alpha `POST /api/posts` `{ markdown, associationId }`.
- **(d1)** as gamma: `POST /api/associations/:id/members` `{ userId, role, permissions: 1 }` on the
  receiving association; as alpha `POST /api/posts/:postId/republication-proposals`
  `{ associationId: <receiving> }`; then clear the cursus (SQL write 1).
- **(d2)** as gamma: `PUT /api/associations/read-grants` `{ userId, campus: 'saint-etienne',
  formation: null, granted: true }` (the "voit les commentaires" switch stays OFF).

**SQL writes on dev, each one** (the owner allows the campaign to write to dev's database,
[dev-environment](infrastructure/dev-environment.md#3-the-data-a-fictional-seed-and-nothing-from-production-owner-2026-10-16)):

1. **A non-student account** has no route: a cursus is the identity provider's attribute and
   `findOrCreateFromOidc` REPLACES it at every OIDC sign-in. So, AFTER the sign-in:
   `UPDATE users SET cursus = '[]'::jsonb, promo = NULL, formation = NULL WHERE id = '<id>'`. Done
   for delta and beta. **The next sign-in as that account restores the student cursus: run it again
   afterwards**, and read `GET /api/users/me` (`cursus: []`) before the reading. To give an account
   its student life back: `cursus` to `[{"promo": 2024, "formation": "ICM"}]`, `promo` 2024,
   `formation` 'ICM' (delta, alpha, gamma; beta's own were 2023 / ICM). A session already open keeps
   working.
2. **The product on sale**: `UPDATE association_products SET "isActive" = true,
   "activationWithheld" = false WHERE id = '<product id>'`, because dev's payment target is not
   ready (a reset puts payments back to `disabled`,
   [dev-environment](infrastructure/dev-environment.md#payments-on-dev-are-switched-on-by-hand-2026-10-21))
   and the API refuses to activate. A product listed this way answers 400 at checkout.
3. Read-only selects of `users`, `associations`, `association_audiences`, `association_products`,
   `posts` and `post_notifications` to pick the fixtures.

**Left as found.** `canari-test-gamma` joined a community "nse banc communaute" by accident during
the readings; it is still a member, because it disturbs none of these readings. The harness Chrome
slots W4 (beta) and W5 (delta) were started and signed in for this; W1, W2 and W3 were not touched.

**2026-11-04, the bench readings of `v1.6.3-alpha.10` (dev answering `1.6.3-alpha.10`, server fixes #2992 and #2990): Mi 9T `canari-test-alpha`, iPhone 12 `canari-test-gamma`, gamma also on the harness Chrome (W2 slot, port 9223).** Mi 9T: the release `app-universal-release.apk` sideloaded with `adb install -r` (versionCode `100600310`), Settings > A propos reads `1.6.3-alpha.10`. **iPhone: TestFlight still offered only `1.6.3 (100600309)` (`alpha.9`) about 40 min after the release run went green, so the iPhone ran the `alpha.9` client, not `alpha.10`.** Both fixes are server-side, so readings 1-3 hold for an `alpha.9` client on the iPhone (the web tab was reloaded and runs the `alpha.10` bundle); the iPhone was not re-read on `alpha.10`. After the update the iPhone asked for the PIN again; the typed text did not reach the web field (`ios.mjs type`), the numeric keypad did.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Read state Mi 9T -> iPhone (#2992) | **PASS** | alpha sent `a10_r1_0003` with gamma online (green dot), gamma's conversation list showed it, gamma opened it at 00:01:03: the Mi 9T showed the reader head and the double check at 00:01:07 (4 s), no reload. Before the open the bubble carried one check |
| 2. Reverse, iPhone -> Mi 9T (#2992) | **PASS** | alpha on the conversation list with "1" unread, gamma sent `a10 r2 gamma` from the iPhone; alpha opened it at 00:01:49: the iPhone showed the reader head and the double check on the bubble at 00:01:54 |
| 3. Own devices: iPhone reads, the web tab's badge clears (#2992) | **PASS** | alpha sent `a10_r3b_web` while gamma's iPhone sat on the list: the web tab (gamma) showed title `(2)` and the row's unread "1". gamma opened the conversation on the iPhone at 00:05:02: within 4 s the row's badge was gone and the title read `(1)` (the remaining unread is another conversation), no reload. The web console carried `[READ] <peer> has read up to ... (server clock)` lines and NO `[READ] REFUSED` line from the reload onwards |
| 4. CanaReels, an accepted follower from another campus (#2990) | **NOT-READ** | The bench has no pair that can say "another campus": alpha and gamma both read ICM / SAINT-ETIENNE on their profile page, and a campus is the identity provider's attribute (`users.campus`), not something a bench account can set; changing it would need a database write on dev. The union is proven on PostgreSQL by `reels-list.integration.spec.ts` (same-campus reader, other-campus accepted follower, pending follower), so what is owed is only the phone reading, once a dev account of another campus exists |

**Left on the bench:** both phones signed in and unlocked (the Mi 9T on Settings, the iPhone on the conversation with alpha), the harness Chrome back on `/chat` as gamma. Nothing blocks the `1.6.3` stable from these readings: the read-mark defect is closed (its backlog entry is deleted), and reading 4 is a verification owed, not a failure.


**2026-11-03, the bench readings of `v1.6.3-alpha.7` (build `100600307`): Mi 9T and iPhone 12, `dev.canari-emse.fr` answering `1.6.3-alpha.7`; accounts `canari-test-alpha` (Mi 9T) and `canari-test-gamma` (iPhone).** The iPhone took the build from TestFlight and Settings > About reads `1.6.3-alpha.7`. The Mi 9T was SIDELOADED (its install carries no installer, and Play offered nothing newer than `alpha.2`), so the release's `app-universal-release.apk` went over it with `adb install -r` (versionCode `100600307`): a reading of the same binary, not of the Play delivery. **Mid-pass the Mi 9T showed the system "Arret en cours..." screen and left adb at 21:11, right after a tap on "Nouveau formulaire" in `/forms`. Cause found afterwards: an EMPTY BATTERY (boot reason `shutdown,battery`), not the app; it clears the "Nouveau formulaire" suspicion. The phone was put back on its charger and the rows below were read in a second pass.** Screenshots are kept out of the repo.

| Reading | Phone | Verdict | What was seen |
| --- | --- | --- | --- |
| GIF over the comments sheet (#2981) | Mi 9T | **PASS** | "GIF" in the comments sheet of a feed post: the picker opens above the sheet, loads, a tap attaches the GIF, send posts it and the comment renders it |
| GIF over the comments sheet (#2981) | iPhone 12 | **PASS** | Same path with gamma: picker above the sheet, GIF picked and sent, rendered as the newest comment; alpha's GIF from the Mi 9T showed in the same sheet |
| Welcome tour (#2952): steps, "Passer", Back | Mi 9T | **PASS in part** | Six steps (alpha), "Passer" visible. System Back while the tour is up closed it and left the app on `/posts`. NOT read: the step-by-step Back, the Settings replay |
| Welcome tour (#2952): steps, Back | iPhone 12 | **PASS in part** | Three steps for gamma (welcome, camera, profile) with "Passer", "Precedent" (3/3, 2/3, 1/3 walked back and forth) and "Terminer" at 3/3. NOT read: the native bar's band on iOS 26 (gamma's tour has no tab step) and the Settings replay. **Observed: the native bar stays tappable under the tour's backdrop; a tap on the chat tab left the tour and opened `/chat`** - fixed since (the bar takes no touch while a tour's backdrop is up, [guided-help](frontend/guided-help.md)); the reading is owed in check T |
| One help per visit, then "Publier" (#2982) | Mi 9T | **PASS** | After the tour was closed by system Back: no hint on the same visit (two screenshots, 4 s apart). After a force-stop and relaunch: the "Publier un message" hint on the "+" with "Passer" and "Terminer" |
| One help per visit (#2982) | iPhone 12 | **PASS** | Tour left through the tab bar, `/posts` opened afterwards: no hint on that visit. After a terminate and relaunch the "Publier" hint showed on the next visit |
| `/calendar` hint (#2982) | iPhone 12 | **PASS** | gamma may deposit: the hint anchors on "Deposer un evenement". On the Mi 9T alpha cannot deposit, so no hint there, as designed (a precondition, not a failure) |
| `/forms/create` hint, 3 steps (#2982) | Mi 9T | **PASS** | Three steps with "Passer" and "Terminer". The iPhone was not read |
| Pins (#2984) | both | **PASS in part** | gamma pinned a post on the iPhone (a governing BDE); alpha on the Mi 9T saw it first in the feed with the pinned badge. The 4th pin of a space was refused with "Cet espace affiche deja 3 posts epingles : desepingle-en un d'abord.". NOT read: a reader of another space |
| iPhone A -> B -> A (#2919) | iPhone 12 | **NOT-READ** | Started, not finished: gamma was signed out, then the login page stayed on "Redirection..." (the web-auth consent sheet of the identity provider, then an empty accessibility tree) and B was never signed in. Procedure [AS](#as-two-accounts-on-one-iphone-install-a---b---a---b---owed-on-the-iphone-12-before-the-stable) also needs a third device to write to A and to B and read the notification content on the locked phone, plus the device log. **gamma is left signed OUT on this iPhone** |
| iOS sign-in after a sign-out (the stall above) | iPhone 12 | **PASS, and one pre-existing defect** | Re-read at 22:18 with the device log: the app was still on "Redirection..." with NO sheet on screen (the first attempt's sheet had been closed). After a relaunch, "Connexion externe (service-account)", "Continuer" on the consent alert, then the identity provider's two stages inside the sheet (its form reaches the accessibility tree only once the page has drawn - the "empty tree" of the first pass), and the callback signed gamma in within 4 s; the PIN gate unlocked through "Saisie manuelle". Not a regression: a sheet closed without signing in leaves the button busy for good (fixed in the plugin since, the reading owed: check SC below). **gamma is signed IN again on the iPhone** |
| Mi 9T F4 reload | Mi 9T | **PASS** | Cold relaunch in airplane mode: the salon "general" drew its stored last page, up to the last message sent before going offline |
| iOS read state across devices | both | **FAIL - a server defect, not iOS** | alpha sent a DM from the Mi 9T, gamma's iPhone listed "1 message non lu" and opened the conversation; the Mi 9T kept ONE check (no head, no double check) for over 2 min and after reopening the thread. Reproduced at 22:28 (`1.6.3-alpha.8` on dev), and the same with gamma reading on a web tab (22:31). That web tab's console names the cause: `[READ] REFUSED a read mark from <gamma> ...: the frame carries no server time to bound it` - the iPhone's own mark, refused on gamma's other device too. The gateway drops `createdAt` from every live frame. (A release build prints no console line to logcat, so "no read-mark line" there proved nothing.) Cause and fix: [chat](frontend/modules/chat.md#conversations-are-ordered-by-the-servers-clock-decided-by-the-owner-2026-10-31); fixed by #2992, read PASS on `1.6.3-alpha.10` (entry above) |
| `event_pending_coorganiser` native strings | both | **NOT-READ** | No dev scenario triggered it in this pass |
| Wry wake (WMP, #2974) | Mi 9T | **NOT-READ** | No abort, no ANR, process alive, but the trigger was not reached: with `always_finish_activities 1` this MIUI build kept the activity alive, so no `[WRY_MAIN_PIPE] no WebView for activity` line appeared. The setting was reset to 0 |
| Cold avatars (AV) | Mi 9T | **NOT-READ** | The bench accounts show initials, not photos: no signed avatar request to time and the server `[AVATAR]` count is not reachable from the bench. Cold start to the communities tab took about 3 s |

**2026-10-22, the background Welcome read on the Mi 9T (debug build, frontend `2547870a7`, from `dabc36813` plus an uncommitted manifest whitespace change; local estate with chat-delivery from `4f31a81ad` and the frontend of `5fa025d87`).** The phone was killed (no process), one `mls_group_info` row was deleted, and a new web device of another member asked for a Welcome. Phone: `Welcome created ... baseEpoch=1`, `HTTP 201`, `Welcome sent`, no `sendWelcomeAndCommit failed`. Server: `[BG_WELCOME] START ... baseEpoch=1`, then `REJECT commit epoch_mismatch (server epoch: 3, sent base: 1)`, so there is no `commit accepted`. The commit-caller checks did not refuse. The stale base and the 201 are in [backlog](#one-background-welcome-on-the-mi-9t-the-procedure-2026-10-22). Not read: the newcomer afterwards.

**2026-10-13, the bench pass of the owed rows: Mi 9T on `v1.2.6-alpha.1`, iPhone 12 on `1.2.3-alpha.5` (the newest pre-release TestFlight serves it).** `PASS`: check V, check W on the Mi 9T, the "Rester connecte" cold path and its landing preview, #1603 both halves, #1605 on Android, #1548 and the send path on the iPhone. `FAIL`: Android at 200 % text (two P3 in the agenda) and, met in three-button mode, ONE system Back closing both the message action sheet and the conversation (P2). Answered in part: #1604. Detail: [the bench readings of 2026-10-13](#the-bench-readings-of-2026-10-13---the-owed-rows-a-bench-phone-can-settle).

**2026-10-11, `v1.2.3-alpha.5` on the iPhone 12 (iOS 27.0.1, TestFlight build 100200305, `dev.canari-emse.fr`, account `canari-test-gamma`).** `PASS`: the login page's "Ouvrir dans l'application" opens the app (#1605, iPhone half), the conversation's glass chrome (alignment, "+" > Photos opens ONE picker, the four accessible names), the camera opening full-bleed on the front lens 15 of 15 times with a home-and-return (#1370, front half), the emoji pictures in the composer and the bubble (rows 3 and 12, in part), the profile hub's breadcrumb, a 5 s video sent, the associations list scroll. **`FAIL` in a new shape: check W on the iPhone** (3 of 3 rises). Every reading, what is blocked and what waits for the next pre-release: [the inventory below](#the-iphone-12-owed-readings-inventory-2026-10-11).

**2026-10-07, `v1.0.4-alpha.5` on the iPhone 12 (iOS 27.0.1, TestFlight build 100000405, `dev.canari-emse.fr`).** Read and `PASS`: the signed calendar subscription for the reader's own campus and formation, copied and opened in Calendar (#1541, #1551), the reel camera opening on the FRONT lens (#1552), the post composer draft per account (#1549), the glass tab bar, the profile page, the tab swipe and the reel review controls. **Not read: the reaction toast, the send path and the reply context (#1548)** - `canari-test-gamma` is the service account and cannot discover or be discovered by a non-admin peer. Detail and owed causes: [backlog](backlog.md).

**2026-10-06, `v1.0.4-alpha.4` on the iPhone 12 (iOS 27.0.1, the TestFlight build, `dev.canari-emse.fr`).** Read and `PASS`: the profile page and header (#1513), the glass tab bar, the tab swipe showing its destination and a drift staying put (#1515), the reel review letterbox with its controls, Next to publish and the confirmed discard (#1539, #1505, #1506), Noto emoji, the feed scroll. `FAIL`: the signed calendar subscription refuses the reader's own campus (#1541). Not reached: the reaction toast, the send path and the scheduled-post time (no second account on dev). Detail and owed causes: [backlog](backlog.md).

**2026-10-06, `v1.0.4-alpha.3` on the Mi 9T (a debug build of the same tree on the LOCAL estate - the harness accounts exist nowhere else; the release APK is signed with another key and cannot replace the debug app without an uninstall that costs the device).** Read and `PASS`: the tab swipe with no leftover shift (#1515), the profile header (#1513), conversation order across both accounts (#1510), the top-placed reaction-failure toast (#1509), the reel editor end to end (#1504-#1506), the own-message reply swipe icon, #1287, #1288, D1 and D4. **FAIL or owed, with the evidence on [device-readings-2026-10](device-readings-2026-10.md)**: no haptic on Android (the manifest lacks `VIBRATE`), NOTIF-10, GRP-3..10 ([cross-client-testing](cross-client-testing.md)), D2, D3 and #1520 (not reachable from the phone account).

**2026-10-06 (second pass), `v1.0.4-alpha.4` on the Mi 9T, same method.** Read and `PASS`: VIBRATE granted (#1535, no haptic can be felt on this phone's silent ringer), the salon reaction failure toast and rolled-back pill (#1536), the review pencil ring and the camera close (#1539), a scheduled post listed then published (#1520), the profile page (#1531), the signed calendar subscription (#1541), the tab swipe, the resume reload (`reloaded`). **Still `FAIL`: NOTIF-10** - one batched real banner and three refused pushes leave one nameless line ([backlog](device-readings-2026-10.md)).

**2026-10-07 (third pass), `v1.0.4-alpha.5` on the Mi 9T (debug APK built from tag `1be223001`, identical to `10115526c` apart from the version bump, versionCode 100000405, installed over the previous one; LOCAL estate rebuilt from the same tree).** Read and `PASS`: the reply context is per conversation (#1548: armed in the DM, absent in the salon, back in the DM), the reel camera opens on the FRONT lens and the flip control swaps front and back both ways (#1552, log `[camera] opened user: camera 1, facing front`, then `environment: camera 0, facing back`), the signed calendar subscription (sign 201, feed 200 signed, 403 unsigned), the post composer draft is keyed by an owner hash (#1549; only ONE account is enrolled on the phone, so the cross-account isolation itself is not observable here), the profile page, the four-tab bar, the tab swipe, a scheduled post listed then published on the minute. The JNI call of #1550 (`ZJI`, `covers`) ran with no `UnsatisfiedLinkError` or `NoSuchMethodError`. **Still `FAIL`: NOTIF-10** - the batching works only when one banner stands for several messages; a run where each message got its own real banner long before its push arrived still leaves one nameless line ([backlog](device-readings-2026-10.md)).

**Android is done except B-bis, H, K, L, M and R.** The full ladder was run on **v0.11.7** on 2026-07-31 (log
archived on the user's desktop) after partial runs on v0.11.5 and v0.11.6. Two defects came out of
it, both tracked as WP-NOTIF-1 and both re-checked by **check K**. **Check H was recorded PASS and
was not one**: the user reported on 2026-08-01 that a tapped notification still does not open the
conversation. That is the lesson this file exists for - a check whose verdict is "it looked right"
is not a check, so H now names the log lines that decide it.

**iOS WAS UNRUNNABLE UNTIL 2026-08-27** - there was no iPhone, and every iOS cell was BLOCKED rather
than pending (the user, 2026-08-18). An iPhone (iOS 18.7) has run against production since, so iOS
cells are now OWED and schedulable; check S is the only one that has actually run. **There is still
no iPad, and on 2026-08-30 that stopped being an academic gap**: App Review ran one, and the login
defect it found had been in every build the store ever had - check T, and the paragraph there saying
why an iPhone settles that particular check for both.

**iPad: switching into Canari from another app does not rotate the window (reported 2026-08-28)** - needs an iPad. Android phone rotation is decided: portrait under 600 dp, free on a tablet (`canari_lock_portrait`, [mobile](frontend/mobile.md#the-window-layout-the-keyboard-and-the-orientation-lock)). **iOS lifecycle classes (suspension and resume, the WebView evicted under memory pressure, a socket that does not come back; named by the user 2026-08-27) are closed by lettered checks here, one at a time, never by a fix written against a lifecycle bug nobody has seen** - three of three iOS defects so far were invisible to every gate.

Two consequences to carry deliberately rather than rediscover:

- **The iOS half of the app ships on compilation alone**, and compilation proves nothing about
  running. Every iOS-specific claim in this wiki is a claim about source, not behaviour.
- **v0.14.0's App Store publication was never verified, and `minClientVersion` is 0.14.0** - so any
  iOS user the store has not reached is locked out, with nothing here able to detect it. The user
  decided on 2026-08-18 to leave it as is. It is recorded because the state is real, not because
  something is owed.

Before 2026-08-27 not one check had ever run on iOS hardware, and only check S has since. The iOS half of WP-SEC-1 and WP-IOS-1 has only ever been
compiled, and a green CI run is not
proof a given file compiled - the pbxproj is hand-maintained, so grep the log for
`SwiftCompile ...<file>.swift` / `CompileC ...<file>.o` before believing any of it. That caveat is
iOS-only: Tauri runs Gradle quietly, so there is no Kotlin task line to look for, and Gradle
compiles by source set, so no Kotlin file can be silently skipped.

**The build to test both platforms on** is the 2026-08-01 compile run of `2b5ba1b0` (v0.11.8), both
workflows green - iOS [`30704254549`](https://github.com/emse-students/canari/actions/runs/30704254549),
Android [`30704255667`](https://github.com/emse-students/canari/actions/runs/30704255667). A
`workflow_dispatch` publishes nothing (Release, TestFlight and Play upload are each gated on
`workflow_run`), so take the **artifact**: the Android APK carries WP-DEEPLINK-1, WP-NOTIF-1 and the
WP-XP-7 removal at once, which means H, I, K and the dev-panel check all ride a single install.

| Check | Closes | Android | iOS |
|---|---|---|---|
| B | WP-VERIF-0 (background decrypt), WP-VERIF-2 | PASS v0.11.7 | owed |
| B-bis | `G2` - a dismissed notification not coming back at launch, and a new one still arriving | **owed** | n/a (the record is Android's) |
| B-reel | WP-RC-7 - a CanaReel sent in a DM, a group and a salon reads as one on the lock screen of a killed app, in French and English | **PASS, French, DM + group, `1.6.3-alpha.2`, 2026-11-02**; English, salon (RC-8) and caption (no writer) owed | **PASS, French, DM + group, `1.6.3-alpha.2`, 2026-11-02** (and one finding, below); English, salon and caption owed |
| D, E | WP-VERIF-0 (PIN change, fresh install) | PASS v0.11.7 | owed |
| F | WP-VERIF-1 | PASS v0.11.7 | owed |
| G | WP-VERIF-3 | PASS v0.11.6 | owed |
| H | WP-DEEPLINK-1 residual | **RE-OPENED** (the v0.11.7 pass missed the DM half) | owed |
| I | WP-UI-1 residual | PASS v0.11.7 | owed |
| J | WP-VERIF-4 | PASS v0.11.7 | owed |
| K | WP-NOTIF-1 | **steps 1-4 PASS on A1 0.14.12, 2026-08-30** (every line named below, observed end to end). Step 5 (self avatar) not observed; **K2 still owed** | owed |
| L | WP-DEV-PANEL-1 | owed | owed |
| M | WP-POST-DOC-2 | **PASS** on A1 0.13.0, 2026-08-06 (chat half) | `docs/wiki/cross-client-testing.md` |
| N | Offline unlock + promotion | owed | owed |
| O | WP-STORE-1 (install source + version gate) | owed | n/a |
| P | Cookie durability across a kill (the iOS half of WP-ANDROID-SESS-1) | n/a (fixed + verified) | owed |
| R | The shrunk release APK still having what it needs | owed | n/a |
| S | An iPhone obtaining a push token AT ALL (the P1 of 2026-08-27) | n/a (49 rows, healthy) | **RUN 2026-08-28 on 0.14.8: report PASSES, token FAILS.** Cause found and fixed the same day - **RE-RUN OWED on the build carrying it** |
| AV | Signed avatar URLs: the community open with COLD avatars ([backlog](backlog.d/p2-avatar-urls-refuse-unsigned-requests.md#the-cold-avatar-cost---owed-before-the-phase-1-stable)) - the [community-open budget](frontend/community-open-budget.md) rows on the Mi 9T, first open of the day after a sign-in (no warm blob, no browser-cache entry for the new URLs), against the same rows on the build before | **owed BEFORE the phase-1 stable**, on its pre-release | n/a |
| T | The welcome tour ([guided-help](frontend/guided-help.md)): starts after the PIN on `/posts` of a fresh account, six steps light the real bottom-bar tabs and the avatar, Back closes it, it does not return after a reinstall (the account's `help_seen`), Settings replays it | **PASS in part, `1.6.3-alpha.7`, 2026-11-03** (six steps, Passer, system Back; the replay owed) | **PASS in part, `1.6.3-alpha.7`, 2026-11-03** (three steps, Passer, Precedent; the replay owed) - and the native bar's band on iOS 26 (the halo is the bar's whole band, the bubble's icon names the tab), and **the bar takes NO touch under the tour** (owed on the first pre-release carrying `set_tab_bar_interactive`): with the tour up, a tap on each tab and on the bar's band does nothing but what the backdrop does (the tour stays on its step, the route does not change, the device log carries `setTabBarInteractive interactive=no`); after "Passer" or "Terminer" (`interactive=yes`) a tab tap navigates again; a first-time HINT (not modal, e.g. "Publier" on `/posts`) leaves the bar tappable |
| SC | A cancelled iOS sign-in sheet hands the login button back ([mobile](frontend/mobile.md#oidc-login-opens-a-dedicated-in-app-browser-session-wp-oidc-tab-1-android-shipped-and-verified-2026-08-08-ios-verified-on-hardware-2026-08-27)): on `/login`, tap "Se connecter", then (1) "Annuler" on the consent alert, (2) again, "Continuer" then the sheet's close button, (3) again, a full sign-in. Each of (1) and (2) must give the button back (no "Redirection...") at once, with `[CustomTabsPlugin] session cancelled by the user` in the device log and no relaunch; (3) must sign in as before (`session completed`, `/auth/callback` runs). Also: sign out from Settings and close the end-session sheet - the app is on `/login` and its button works | n/a (Android answers `handedOff`; its tab's end is the foreground edge, unchanged) | **`PASS`**, `1.6.4-alpha.2`, 2026-11-04 ([where the pass stands](#where-the-pass-stands)) |

**The `ios-release` artifact CANNOT be installed on a device, and this paragraph said to install it
until 2026-09-07.** The export is `method: app-store-connect` signed *Apple Distribution*
(`.github/workflows/ios.yml`, the `ExportOptions.plist` heredoc): that profile names no device UDID
and carries no `get-task-allow`, so `installd` refuses the `.ipa` outright - App Store Connect is the
only thing that accepts it. A dispatch does not upload to TestFlight either, so TestFlight stays on
the previous build and check K would be meaningless on it. **A `workflow_dispatch` therefore puts an
iOS build on no hardware at all** - an iOS pass costs a PRE-RELEASE, whose TestFlight upload is the
only thing that reaches a phone.

**What lifts it is a second export from the same archive**, `method: development` against a profile
naming the test device's UDID. It also buys `get-task-allow`, which is what makes the WKWebView
inspectable - so the one change that makes an artifact installable is the same change that makes the
webview readable. Owed, not done.

## Readings of v1.6.5-alpha.1 (2026-11-05)

Dev answering `1.6.5-alpha.1`. Web on the harness Chrome (gamma, delta, beta), Android on the Mi 9T
`canari-test-alpha`, iOS on the iPhone 12 `canari-test-gamma`.

**Web: PASS on every row.** Guided help batch 3; batch 4 on `/bookings`, including the multi-column
week hint (desktop and 375 px); the "Entre étudiants" form, the non-student 404 and the empty bell
text; the republisher label wrapping at 375 px; grant-only live chat withheld then unwithheld (read
through the API); a tab re-tap going back to the top.

**Web console, two kinds of lines, judged by the owner as NOT blocking.**

- Cloudflare JS detections (14 per session): injected on the dev zone only and blocked by the CSP.
  The owner is to switch JS detections off in the Cloudflare dashboard, because the API token lacks
  the permission. Production is not behind Cloudflare.
- The old documented `[MLS] key package worker state DISCARDED` guard
  ([key-package-pool](protocols/key-package-pool.md)).

**Mi 9T: PASS on every row.**

| Reading | Verdict | What was seen |
| --- | --- | --- |
| M1. The resume fix (#3030) | **PASS** | 3 runs, every message readable, no "Quelqu'un" |
| M2. No false "arrived twice" at launch | **PASS** | One `pull:queued` crossing line seen; it is benign |
| M3. Salon banners and push-blind counters | **PASS** | 16 salon banners, all showing text; 0 `[PUSH_BLIND]` and 0 `SEALED_BEFORE_ADMISSION` on dev since the deploy |
| M4. The reel spinner on a slow link | **PASS** | The spinner shows, and the sound stays uncut |
| M5. The 1.6.4 rows | **PASS** | All read |

Noise lines N1-N4 were fixed or filed: #3042, #3041, #3043, #3044.

**iPhone 12.**

| Reading | Verdict | What was seen |
| --- | --- | --- |
| The update | **PASS** | |
| The status-bar tap | **PASS** | Its log line is now readable, so #3037 is proven |
| Guided help, batch 4 | **PASS** | |
| A 1:1 push after a foreground kill | **FAIL** | The banner showed the generic "Nouveau message de ...". The cause was found and fixed in #3040; it is owed its reading on `alpha.2` |

Also measured: the extension's Swift `NSLog` lines are `<private>` on TestFlight.

**The owner's two gestures** (the silent switch, the pinch zoom) were read on `1.6.4-alpha.4`. They
carry over because #3018's and #3008's files are unchanged (owner, 2026-11-05).

**Sideloaded bench APK.** It is signed by the upload key, so dev refuses its restore key (see
[account-restore](account-restore.md)).

## IOS-3075. The iOS follow-ups of #3075 - owed on the iPhone 12

Built and merged by #3075 (2026-11-06); **the first build carrying them is `1.6.6-alpha.2`**, and the
stable `1.6.6` ships them. Compiled only: the Rust half is tested on the host (`cargo test --lib --
nse_outcomes push`), the Swift and Objective-C halves have never compiled here, only in the release
workflow. Read on the iPhone 12 (`canari-test-gamma`, then a second bench account for R2) with
`python -m pymobiledevice3 syslog live` running, on any TestFlight build `>= 1.6.6-alpha.2`. Each
row closes its [backlog.d](backlog.d/README.md) entry, linked in the row.

| Row | Do | PASS when | FAIL when |
| --- | --- | --- | --- |
| R1a. Swift lines in clear, the extension ([entry](#the-iphone-12-batch-6-readings-of-2026-11-14)) | Kill the app (`bun tools/ios-device/ios.mjs terminate`), send gamma a DM from the harness Chrome | The syslog shows `[CanariNSE] outcome=decrypted cause=... stage=... peakMB=...` with every value readable | The `[CanariNSE]` line reads `<private>` |
| R1b. Swift lines in clear, a plugin ([entry](#the-iphone-12-batch-6-readings-of-2026-11-14)) | Sign out, tap "Se connecter" | The syslog shows `[CustomTabsPlugin] openCustomTab: presenting a session`, then `session completed - re-dispatching the callback to the app scheme`, subsystem `fr.emse.canari`, category `customtabs` | Either line is `<private>`, or the plugin line is under `Canari{Foundation}` (an `NSLog` left) |
| R2. `push_context.json` follows an account switch ([entry](frontend/mobile.md#the-extensions-copy-of-the-state-follows-every-write-2026-11-05)) | Signed in as A with the app in the FOREGROUND, switch to account B, stay in the foreground, then `ios.mjs terminate` (no swipe, no background first); send B a DM | B's banner carries the message text, and the extension's line reads `outcome=decrypted` | The banner is the generic "Nouveau message de ..." or the line is `outcome=fallback` with a cause naming the context or the device - the extension still read A's context |
| R3a. No more sandbox refusal ([entry](frontend/mobile.md#what-the-extension-did-in-the-apps-log-2026-11-01)) | Any push to the killed app (R1a's is enough) | No `kern.bootsessionuuid unreadable` line in the syslog | The line is there: the build does not carry #3075 |
| R3b. A marker from before a reboot ([entry](frontend/mobile.md#what-the-extension-did-in-the-apps-log-2026-11-01)) | Kill the app, send a DM, and power the phone off while the banner is still being made (a large photo makes the window longer); power on, unlock, open the app | The app's log has an `[NSE_OUTCOME] {...}` line with `"outcome":"killed"` for that run: the marker's `up` was ahead of the new uptime | Neither `killed` nor any line for that run AND no later drain counts it: the marker waits (stamped below the new uptime and `kill(pid, 0)` answered `EPERM`, logged `[NSE_OUTCOME] pid liveness not provable`) - which says the one-sided proof is not enough, and a new entry is owed |

R3b is a race the bench cannot force: a run that FINISHED before the power-off leaves no marker
(its line reads `decrypted` or `fallback` at the next drain), which is no verdict - repeat until a
drain reports either a `killed` line or the `pid liveness not provable` warning.

## The production read-only readings of 2026-11-15

**What this is.** The halves of the [readings owed](plan.md#readings-owed) whose evidence is the
production population rather than a phone: the server-side rule of a notice, measured over every
account it ran on, by `GROUP BY` and by the social-service log's own lines. Granted by the owner on
2026-11-15 (*"La prod t'es completement accessible en lecture"*): every statement ran in a session
whose `SHOW default_transaction_read_only` printed `on` first; logs were read with `docker logs
--since 30h` of the production social-service container (started 2026-11-14 09:12 UTC, the `v1.6.12`
deploy). Only aggregates are written here: no id, no name, no text. Paris days are
`(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris')::date` (the database runs in UTC and
`post_notifications."createdAt"` is a UTC timestamp without zone). **No phone half is read here; every
entry keeps its device halves.**

### Campus trends and the daily cap (WP-8, WP-10, the quieter batch) - the server half PASSES on production

[Entry](backlog.d/reading-owed-campus-trends-and-the-daily-cap-wp-8-wp-10-and-the-quieter-batch.md),
[engagement](engagement.md#the-owners-decisions-of-2026-11-10---quieter-1610).

- **One trend a day per reader.** `post_notifications` of type `campus_trend`, grouped by reader and
  Paris day: 2026-11-10 (the `1.6.9` backlog, before the quieter batch, [as recorded](engagement.md#the-deploy-of-2026-11-10-and-what-it-changed))
  4,459 rows to 499 readers, up to 9 each; **from 2026-11-11 on, 1,001 rows and no reader-day above
  one** (11-11: 499 rows / 499 readers; 11-12: 499 / 499; 11-14: 1 / 1; 11-15: 2 / 2). No reader holds
  two rows for one post (`GROUP BY recipient, post HAVING count(*) > 1`: 0).
- **Two a week.** Per reader and Paris week, the rows written since 2026-11-11: 500 readers at 2, 1 at
  1, none above; `campus_trend_weeks` agrees row for row (joined on reader and week: 501 equal, 0
  above the ledger, 0 below, 0 without a ledger row). The log shows the bound biting: the two trends
  since the deploy each logged `took off: k to tell of ~500 eligible (498 already told of a trend
  today, twice this week, or concurrently)` and `told k: 1 push group(s), 0 failed`.
- **The told-once ledger and a deleted post.** 498 of the 2026-11-12 rows have no
  `post_engagement_notices` row: their post was deleted, and the ledger's rows cascade with their post
  while the bell rows (`postId` a string, no foreign key) stay - the documented shape, not a reader
  told twice.
- **The daily cap of three.** `engagement_push_days`: 2026-11-10, 497 readers at 5 (the old cap of
  `1.6.9`); **from 2026-11-11 the counter never exceeds 3** (max 3, 0 rows above). **The fourth counted
  push reaches the bell only:** reader-days with MORE than three counted bell rows (the `PUSH_BUDGET`
  counted types of `v1.6.12`) from 2026-11-12 on: 42 reader-days with the counter at exactly 3 (11-12:
  18, 11-13: 14, 11-14: 9, 11-15: 1) and 3 with no counter row (pushes withheld by category or device)
  - the bell rows were written, the push stopped at 3. The log's withheld lines since the deploy:
  `event_open` 72 of 72, `reaction` 30 of 30, `comment` 4 of 4, `campus_trend` 3 of 3; that build's
  line names the three causes together (the per-cause line of the 2026-11-14 decision is not in
  `v1.6.12`), so the cause of each is not separable from the log.
- **"Aimee par ..." cannot be read on production.** One account shares its activity, and none of the
  1,001 trend rows since 2026-11-11 had a followed reactor sharing it (upper bound: any reaction,
  0 rows), so `named=0` in every `[TREND]` line is the expected value; the naming stays a dev reading.
  The trend PUSH itself is not observable either (the suggestion push is off by default; the three
  told readers since the deploy were all withheld).
- **Verdict:** the server's "once a day, twice a week, three counted pushes a day, the rest to the
  bell" holds over the whole production population since `1.6.10`. **Left:** the phone halves (the
  pushed texts, "Aimee par ..." with a followed liker, the Recents order).

### Birthdays - the morning notice's claim PASSES on production, restart included

[Entry](backlog.d/reading-owed-birthdays-on-profiles-3180-first-stable-v1-6-9-birthdays.md),
[birthdays](birthdays.md#the-morning-notice).

Dates and counts that would point at one member (which day is whose birthday, their followers,
their visibility) are deliberately left out of this public page; the reading only needs the shape.

- `profile_birthdays` grouped by `lastAnnouncedOn`: exactly one announcement in the window read, on
  the day of the `v1.6.12` deploy.
- **Its bell rows:** type `birthday`, written at the FIRST morning tick (08:13 Paris), only to
  accepted followers; max rows per (recipient, celebrant): 1.
- **None again after a restart:** the social-service was restarted about two hours later the same
  day (the `v1.6.12` deploy) and ticked every hour to the end of the day; no second row, and
  `lastAnnouncedOn` did not move. The ring read the claim: every `[BIRTHDAY] today` line after the
  restart counted the celebrant, and the next day's ticks before 08:00 Paris each logged `before the
  morning, nothing to do`; a tick with no due celebrant logs nothing, by design.
- **Not readable here:** the push of that notice (it was sent by the container the deploy replaced,
  whose log is gone), and every phone half.
- **Verdict:** one bell row per follower allowed the date, and none again after a social-service
  restart: READ on production, population of one. **Left:** the phone halves (the ring on initials,
  the morning notice's push texts and tap on both phones, `Anniversaires` off).

### Openings for followers (WP-4) - "one notice, never two" PASSES on production

Entry closed 2026-11-16,
[engagement](engagement.md#wp-4---openings-for-followers-built).

- `post_notifications` of the opening types, max rows per (type, recipient, target): `event_open`
  130 rows, 15 events, 37 followers, max 1; `form_reminder` 25 rows, 5 forms, 16 followers, max 1.
  No booking-space opening has happened on production yet (no `booking` kind in `opening_reminders`).
- `opening_reminders` (unique on kind, target, user; 0 duplicates): every opened row is
  `notifiedOnOpen` (event 130, form 25), and their counts equal the bell rows one for one; the 15
  form rows not yet open are waiting. Every row is `origin = followed`.
- **Verdict:** a follower is told of an opening once, never twice, over every event and form opened
  on production. **Left:** the iPhone halves (the booking space, the validated event, the bell at
  "Rien") and the card's bell after #3576.

### What was looked for and is not a production reading

The other entries of the list were read for a production half and have none: their evidence is a
phone (a push drawn, a tap, a console), a staged dev fixture, or a client-only log line (the seed
mirror's `[GRAINE_MIRROR]` count lives on the device and never reaches a server).

## The Mi 9T sitting 5 readings of 2026-11-15 - the verdicts of the entries it closed

`1.6.12-alpha.2` (build 100601202, built for dev, tag on `fa1bc2655`; `v1.6.12` is the bump commit `0b6947d20`
directly over it, so the code read is the stable's), dev estate, the `alpha` account on the Mi 9T, the `beta` and
`delta` web seats, the iPhone 12 on TestFlight with `gamma`. These rows are what is left of the backlog entries
closed that day; the entries themselves are deleted. Evidence is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| A salon carries read receipts, Mi 9T | **`PASS`** (sitting 7, entry deleted) | Read in [the seventh sitting](#the-mi-9t-readings-of-2026-11-15-seventh-sitting): `alpha`, a plain member, sent in a community salon, `gamma` opened it on the web seat, and the sent bubble drew the reader's face with "Message lu par Canari Test Gamma". The rig half (`READ-6`, twice, 2026-11-14) passed before |
| A live and a reel ask the microphone for one channel, Mi 9T | **`PASS`** (entry deleted, both halves read) | The page console over CDP (the release-style bench build prints nothing to logcat): `[LIVE-CAM] audio layout: mono (ch=1, rate=48000Hz)` for a live preview and `[camera] audio layout: mono (ch=1, rate=48000Hz)` for the in-app post camera, the reels' capture path; read again in [the seventh sitting](#the-mi-9t-readings-of-2026-11-15-seventh-sitting). No `stereo`, so no decode is owed |
| A live and a reel ask the microphone for one channel, iPhone 12 | **`PASS`** (by the audio server) | The `audio layout:` line is a `console.info` the syslog does not carry, and a TestFlight WebView is not inspectable; one layer down, a reel and then a live of about 20 s each opened ONE microphone input for the app's WebKit GPU process, and `audiomxd` logged `Got input layout ... numberDescs=1, descs=[Mono]` for both, while the hardware and the capture daemon stayed `[L, R]`: the mono request was honoured |
| `event_pending_coorganiser` push, iPhone 12, app killed, English then French | **`PASS`** | A partner accepted to co-organise a validated event (`[COORG] ... was validated: back to pending, a partner ... joined it`); gamma, a validator, got "Event needs approval again" / "“<event>” needs approval again: an association accepted to co-organise", then in French "Événement à revalider" / "« <event> » doit être revalidé : une association a accepté de co-organiser" |
| `event_pending_coorganiser` push, Mi 9T, app sent home, English then French | **`PASS`** | The proposal `accepted` and the event back to `pending`; in about 8 s one `canari_social` notification (`CanariFCM: onMessageReceived type=social action=pending`, `showSimpleNotification`, deep link `fr.emse.canari://calendar`) with the same English and French sentences; the earlier invitation read "Club randonnée propose de co-organiser un événement". Staging note: a BDE validator sees "Confirm" in the pending list of the associations the BDE governs, and an association whose space no BDE governs refuses the verdict (`no BDE governing its association`); the partner's page is `/associations/<slug>/edit/republications` |
| A salon mention, Mi 9T, known author, killed then backgrounded | **`PASS`** | Killed: `notification posted showsMessage=true ... mentionsMe=true`; the COLLAPSED shade showed only the author line under the salon title, expanded the speaker's name with the face and the text, in French; backgrounded: the same notification (`android.title` "<salon> : <author>", `conversationTitle` the salon) |
| The push sentence from Rust in the app language, Mi 9T, voice note, app killed | **`PASS`** | "Message vocal" with the microphone glyph in French, "Voice message" after switching the app to English; language restored |
| A mention or salon banner from an UNKNOWN author ("Quelqu'un", "?"), both phones | **`DELETED`** (measured limit) | The bench holds four accounts and each phone names all four; a fifth account that SENDS needs an identity-provider sign-in (dev users are created by `findOrCreateFromOidc`, both login paths go through it, a fixture `users` row cannot sign in). `ChannelBannerAuthorTest` guards the rule meanwhile; the reading comes back the day such an account exists |
| The initials of a named author with no photo, Mi 9T | **`NOT-REACHABLE`** | All four rig accounts render a photo (measured on the beta web seat); removing one would write to an account other sittings read |
| "Marquer comme lu" from a salon notification, Mi 9T | **`PASS`** | `postChannelRead: HTTP 201`, the row removed; server `[CHANNEL_READ] advanced` and `[CHANNEL_READ_PUSH] ... moved=true` |
| A BLIND salon banner (no author, no mention, one sound on the redraw; no "Marquer comme lu" while blind) | **`NOT-STAGED`, entry closed** | The bench phone runs a release build, so `run-as` cannot remove the seed mirror, and the channel push carries its own seed frame (`[CHANNEL_PUSH] ... seedFrame=...`); the owner declined a debuggable APK (2026-11-15). The iPhone half was deleted earlier: a sound cannot be observed from the bench, and iOS never redraws |
| CanaReels "Voir plus", Mi 9T (entry closed 2026-11-16, reopened for what is left) | **`PASS`** (part) | Gesture navigation, `--safe-area-inset-bottom` 24 px: one line, no toggle; a long caption's "Voir plus" at `top` 800 / `bottom` 814 CSS px, the seek slider at 828 / 860, no overlap collapsed or expanded; a seek tap moved the slider expanded. Not read: the just-overflowing caption and a phone with no bottom inset |

## The desktop screen-share reading of 2026-11-16 (`1.7.0-alpha.5`)

The bench took the owner's reading of [screen share in a desktop live](backlog.d/reading-owed-screen-share-in-a-desktop-live-the-scenes-read-by-the-owner.md)
on `dev.canari-emse.fr` (`1.7.0-alpha.5`), by the owner's 2026-11-16 decision: the bench first, the owner only for the hand rows.
**Broadcaster**: web seat W6 (`alpha`), desktop Chrome 157, relaunched with the scene flags; **viewer**: web seat W7 (`beta`),
the feed card then the live viewer. Evidence (screenshots of what the viewer saw, the broadcaster's console) is outside the
repository. Lives written to dev are in `WRITTEN-IDS.txt`; every one was ended through the product and its `lives` and
`live_segments` rows read back 0 (read-only).

**How the share was driven, and what that is not.** The rig's browsers run `--use-fake-device-for-media-stream`, which also
makes `getDisplayMedia` a synthetic picture, so that pass proves the scenes and not a real capture. The real pass therefore ran
the broadcaster WITHOUT the fake-device flags: the camera and microphone came from a script shim of `getUserMedia` (a canvas with
a moving disc and a test tone, so no real webcam and no private room), and the screen from a **browser tab** of the bench's own
page, chosen by `--auto-select-tab-capture-source-by-title`. A WINDOW could not be targeted (Chrome ignored the title flags, and
`--use-fake-ui-for-media-stream` picks a screen), and one attempt shared the ENTIRE screen for about a minute before it was
noticed: it was stopped at once, the live ended and deleted, the screenshots deleted, and the entire screen is never shared again.

| Step | Verdict | What was seen |
| --- | --- | --- |
| 1. Scenes camera, screen, screen + camera, side by side, "Je reviens", back: no gap, no restart | **`PASS`** (bench; the bell and push half not taken) | Every click changed what the viewer saw within one buffer (a screenshot per scene: the shared tab, the tab with the round camera overlay, the two side by side, the "Je reviens tout de suite" card, then the tab again). The viewer's player stayed `playing` on ONE live, its `currentTime` advancing as the wall clock, the video `1280x720` throughout. The studio logged each switch (`scene screen -> screen-camera: switch`). A dismissed picker was not tried (the flag skips the picker) |
| 2. Overlay: four corners, three sizes, round and rectangle, the keys | **`PASS`** | Dragged to each corner, it snapped on release (`snapped to top-left`, `top-right`, `bottom-left`, `bottom-right`); the three sizes and the two shapes each logged and showed on the viewer; ArrowLeft and ArrowUp moved it a corner each, and Enter twice cycled clockwise. Each CDP mouse drag took about 70 s of rig time (not explained, not measured against the app) |
| 3. Microphone muted then back, camera off then back | **`PASS`** (the camera light is the owner's) | `microphone muted` / `microphone on`, `camera off` / `camera on` logged; with the camera off the viewer saw the "Caméra coupée" disc in the overlay's place, and the camera came back. The tone was not listened to (the viewer was muted) and the camera light cannot be read on a synthetic camera |
| 4. The shared window resized twice | **`PASS`** (a tab; a real window not taken) | The window was resized to 1200x700 then 760x950 with the shared tab in front: the viewer's picture re-letterboxed to the new aspect each time (the tab's own text read `1184x549` then `744x799`), no streaks, the video stayed `1280x720`. A window not in front does not report its new size until it is brought forward, so the resize was read with the shared tab in front |
| 5. The tab hidden more than five minutes | **`PASS`** (the owner's machine's cost is not this one's) | The live tab `hidden` for 5 min 48 s while the shared tab was in front: the viewer's `currentTime` advanced 58 s per 58 s of wall time and the picture moved. The console printed `[LIVE-STUDIO] drew 900 frames, X ms each on average` every 30 s, twelve lines in the window, X between 0.94 and 1.27 ms (this workstation, screen + camera scene) |
| 6. Stop sharing | **`PASS`** (the bar's button is the owner's) | The shared tab closed (the `ended` event the bar's button fires): the studio logged `the screen share ended outside the app - scene screen-camera -> pause`, the broadcaster showed "Le partage d'écran s'est arrêté : le live montre « Je reviens »...", the viewer saw "Je reviens tout de suite", the live did not end and the camera was not shown. A new tab and a click on "Ecran" asked again and the viewer saw the fresh capture |

No defect was found. **Left to the owner** (the entry): the real picker and a real window, a real window resized, the bar's own
"Arreter le partage", the camera light, how a drag feels, and one live in the bell with one push on a phone.

## 1.7.0-alpha.2

**2026-11-15 (the sitting ran past midnight), the bench readings of `v1.7.0-alpha.2` (build `100700002`, dev answering it): Mi 9T `canari-test-alpha`, iPhone 12 `canari-test-gamma`, the `delta` web seat (CDP 9227) as the sender.** Evidence is kept out of the repo, in `sitting-1700a2/` of the harness directory.

**How each build got there.** iPhone: TestFlight offered `1.7.0 (100700002)` about 100 min after the release run, taken with "Update". **Mi 9T: SIDELOADED, not the Play delivery.** The install carries no installer (`installerPackageName=null`, as since `1.6.3`), so Play offers it nothing; the release `app-universal-release.apk` went over alpha.1 with `adb install -r` (`firstInstallTime` unchanged, so the same device; `versionCode` `100700002`). It is a reading of the same binary, not of the Play path. The iPhone store build's WebView is not inspectable, so every iPhone reading is a WDA screenshot or touch, never a console line.

| # | Reading | Mi 9T | iPhone 12 |
| --- | --- | --- | --- |
| 1 | App icon (#3643), home screen next to the neighbours, against `icon-study-1115/` | **READ.** The bird fills about two thirds of the disc and sits fully inside the round mask: no clipping at the wings or the tail (`mi-drawer.png`) | **READ.** The bird is visibly larger than in the study crop and well inside the tile (`iphone-page2.png`) |
| 2a | A tap on the inline chat video opens the viewer, never toggles the sound | **READ**, centre tap (`mi-viewer.png`); the viewer opened with its sound icon on. Only the centre was tapped | **READ**, a tap near the top-right of the tile opened the viewer (`ip-viewer.png`), so "anywhere" holds there; sound icon on in the viewer. "Did not toggle the inline sound" is read from the viewer icon, not from a media element (no console) |
| 2b | The seek line follows a finger | **READ** with synthetic CDP touch events (not a finger): down near the left end, dragged to 69 % of the width, `currentTime` 4.8 s then 24.1 s of 35 s | **READ** with a WDA drag (40 to 250 pt): the progress bar ended at about 64-68 % (`ip-seek.png`) |
| 2c | One glyph at a time around a pause; glass at a transport glyph | **READ** on a 14 s `screenrecord` at 20 fps over the pause (`mi-pause.mp4`, `mi-pausezoom.png`): the pause glyph fades in and out, one empty frame, then the play glyph fades in; never two in one frame. The glyph is translucent with a soft halo | **READ** at about 6.5 fps (14 WDA screenshots, `ip-pause-sheet.png`): the same order, one glyph per frame, the pause bars blurred behind the glass. A screenshot cadence: an overlap shorter than 150 ms could hide between frames |
| 2d | Compared with posts and CanaReels | **NOT TAKEN** side by side; the post video shows its own mute control at rest (`mi-feed2.png`) | **NOT TAKEN** |
| 3a | Back arrow, feed to association chip, then the arrow (#3648) | **NOT TAKEN as written**: the alpha feed holds no association post, so there was no chip. The mechanism was read from a profile instead: profile, tap an association, the arrow (labelled "Retour : Associations") landed on the PROFILE, the Android hardware Back did the same, and the next Back reached the feed. **The restored feed offset was 1726 css px against 1500 left, about 226 px lower** ([entry](backlog.d/p3-the-feed-offset-restored-after-a-back-from-an-association-lands-about-226-px.md)) | **READ.** Organisations tab, scrolled a third of a screen, tap the chip of a post, then the header arrow: it landed on the feed at the SAME post, at the same height (`ip-after-arrow.png`) |
| 3b | Controls: a cold open of an association then the arrow; a notification's association then the arrow | **NOT TAKEN** | **NOT TAKEN** |
| 4 | Push registration (#3649) | **READ.** One `[PUSH_REGISTER]` `platform=android` at the unlock after the update, no `[PUSH_MISSING]` seen; a DM from the delta seat with the screen off posted a notification 0.23 s after the send (`dumpsys notification`, `when` against the send stamp); gateway line `FCM sent batch pushed=1` | **READ.** One `[PUSH_REGISTER]` `platform=ios` (`voip=set`); a DM sent with the app on the home screen put the badge "1" on the Canari icon (`ip-push.png`); gateway line `FCM sent batch pushed=1`. The banner itself was missed (the tree was read 5 s after the send), so the reading is the badge and the server line |

The same dev window also logs `No push token for` several other devices and one `[PUSH_COVERAGE]` warning for `1.6.12-alpha.2` Android builds with no registration: other bench installs, counted not named, and neither is this phone.

**Not re-read on alpha.2:** the reply swipe (#3605) and the turn frame hold (#3626), both read on alpha.1.

**Two things seen on the way, not filed as defects.** (1) On the iPhone the post of a paysage reel showed "Cette video ne peut pas etre lue sur cet appareil" after the app came back from the chat viewer, where the same post had played minutes earlier (`ip-org.png`); one screenshot, not reproduced. (2) A bare `adb input swipe` that STARTS at x = 80 px on the Mi is the system's edge gesture: it left the app and raised the identity provider's "signed out" page in a custom tab, yet the session was alive when the app was reopened (PIN gate only). The seek drag was redone with touch events inside the page.

**Does anything block the 1.7.0 stable?** Nothing found here blocks it. Still unread: the Android feed-to-association route, the two arrow controls, and the side-by-side look with posts and CanaReels. The scroll offset after a Back is filed as a P3.

## The Mi 9T readings of 2026-11-16, the owed rows (`1.7.0-alpha.2`)

`1.7.0-alpha.2` on the Mi 9T (release APK sideloaded earlier, `versionCode` `100700002`), dev estate, the `alpha` account, CDP on
the phone and `adb logcat`. Peers: the `beta` web seat (W2) for the deploy drill and the `alpha` web device W3 (minted by
`newdevice.mjs`, so a SECOND device of the same account) for the new-device and background-Welcome rows. Evidence (screenshots,
logcat, the drill logs) is outside the repository, in `sitting-mi-all/` of the harness directory. Fixtures written to dev are in
`WRITTEN-IDS.txt`. **Two limits met all through the sitting:** the lens of the phone is covered (both cameras draw black), and a
bare `adb input swipe` was refused by the session's policy, so nothing that needs a held press (the video shutter) was taken.
**Camera permission:** the app's `CAMERA` permission was found NOT granted at the start (the camera log said
`cannot open camera "1" without camera permission`, so the live sheet's Start was greyed for that reason, not for a suspension);
it was granted with `pm grant` and the app restarted before the live readings below.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Pre-live screen says a suspension (entry deleted 2026-11-16, every half read) | **`PASS`** (French; the `/admin/moderation` cuts still owed) | Control, good standing, camera granted: "Passer en direct" with "Demarrer le live" ENABLED. Two `live_cuts` fixture rows (strikes 1 and 2, the second dated the day before, as the web reading did): the sheet reads "Vous ne pouvez plus lancer de live jusqu'au 15 decembre." with "Reessayer" beside it and Start greyed; rows deleted, the next open shows no line and Start enabled again. NOT read: English on the phone (the web seat read it), the two cuts through `/admin/moderation`, and the `[LIVE] standing` / no `[LIVE] start` console lines (a release build prints no console to logcat) |
| Stricter script policy, Mi console half (entry deleted 2026-11-16, every half read) | **`PASS`** (Mi half) | A `securitypolicyviolation` listener on the page, then ten routes by SPA navigation (feed, communities, notifications, calendar, forms, bookings, shop, dashboard, settings, chat), a chat video opened in the viewer and the GIF picker opened and loaded: 0 violations, nothing in logcat. The embedded app is served from `tauri.localhost`, so the edge's injected script (the one violation the web seat saw) never reaches it. Not driven: the PDF viewer, a trombinoscope export, and a document RELOAD under the listener |
| A new-device alert is posted once ([entry](backlog.d/reading-owed-the-new-device-alert-posted-once-on-the-mi-9t.md)) | **`PASS`** (first half) | App killed (no process), `newdevice.mjs --device W3` added a device to the account: `CanariFCM: decryptProto: 1 new device(s) on this account - local notification`, the shade row "Nouvel appareil / Un nouvel appareil a ete ajoute a votre compte...", ONE posting line in the whole window, no `[DEVICE_NOTICE] marker ... not written`; the app opened afterwards raised no second one. NOT read: the heal commit naming an OLD device right after an update and before the first open (the update is past) |
| PK2, a group created by the account's other device while the app is dead ([entry](backlog.d/reading-owed-a-group-joined-in-the-background-before-its-row-existed-the.md)) | **`PASS`** (Mi half, partly) | Google's push connection checked up first (`MCS_HEARTBEAT`, `connected=`), the app dead, W3 created a group and wrote into it: `isWelcome=true ... background join`, `processReceivedWelcomeBackground: group joined`, `markMembershipActive: HTTP 201`, then the message from the other device was silent (`FCM silent from self`). Cold start: the group is in the list with its first message, no restart needed. logcat holds no `LOST frame` and no `Message for absent conversation` (the JavaScript console lines are not in a release build's logcat, so that absence is weak). Checks (a), (b) and (c) of the entry were NOT taken |
| Follow suggestions, the Mi rows left (entry deleted 2026-11-16, every half read) | **`PASS`** (every Mi row) | Staged on dev: three of `alpha`'s association follows removed (restored after), a post of `gamma` (a person `alpha` does not follow) with three reactions written as fixture rows (deleted after). **The banner:** with 4 follows Pour toi opens on "Suivez des comptes pour remplir votre fil" with a card row. **A "Suggestion" post:** Pour toi shows the fixture post with the meta line "A l'instant - Suggestion - Suivre". **A request from a person's post header:** "Suivre" there toasted "Demande de suivi envoyee a Canari Test Gamma" and a `user_follows` row `pending` exists (deleted after). **Campus:** the same post is listed there with NO "Suggestion" mark |
| Overlays by open order, Mi rows ([entry](backlog.d/reading-owed-overlays-stacked-by-open-order-not-by-rung.md)) | **`PASS`** (part) | From a CanaReel viewer the comments sheet sits above it, and the GIF picker opened from that sheet is above both (screenshot); Escape closes the picker first and leaves the sheet and the viewer as they were, then the sheet, then the viewer. In the composer dialog the event picker ("Lier a un evenement valide") is a sheet above it. Not read: the comment REPORT dialog (no comment of another account on a reel), the message-actions sheet and an emoji picker over a reel, a confirmation raised from a modal (closing a composer with a draft asks nothing: it keeps a draft), the guided help over a quiet app, the toast over the stack |
| Sharing into Canari, the Mi leftovers ([entry](backlog.d/reading-owed-sharing-into-canari-on-ios.md)) | **`PASS`** (part) | A SEND intent with a `file://` stream is refused (`scheme 'file' is not content://`) and a `content://` stream without a read grant is refused (`SecurityException`): the share is dropped and reported. With a granted `content://` stream a PDF ("mi-all-doc.pdf") and then a video are copied, the picker "Envoyer a..." lists the conversations most recent first, and the pick stages the file in the composer ("1 fichier en attente"; two shares in a row, "2 fichiers"). **A second share while the first waits:** a video share then a PDF share before any pick: the picker held the PDF, and only the PDF was staged. **S5:** with `android.intent.extra.shortcut.ID` the share is logged `suggestion=true` and the picker opens with that conversation first and selected (nothing sent). **The toggle:** `dumpsys shortcut` lists 5 `c:<id>` share targets; Settings > Preferences > "Suggestions dans le partage" OFF removes all 5 (`ShareTargets: clear: 5 target(s) removed`), ON puts 5 back; the `chat_<id>` conversation shortcut stays. Not read: a sign-out, a second account (neither can be driven without an identity-provider sign-in), the first share's copies leaving the disk (a release build refuses `run-as`) |
| Alpha.2 rows, the feed-to-association chip and the two arrows | **`PASS`** | A post published AS an association is in the feed. Feed scrolled to 500 css px, a tap on an association name in a card header, then the header arrow ("Retour : Associations"): back on `/posts` at 474 px (26 px above where it was left, not the 226 of the profile route filed earlier). The Android hardware Back (`KEYCODE_BACK`) did the same. A COLD open of the association (full navigation, no history): the arrow goes to the associations list. Not taken: an association opened from a notification |
| Alpha.2, flat versus glass look | **NOT TAKEN side by side** | The chat viewer's paused play glyph is white with a soft halo (crop kept), the post's mute glyph and the CanaReels rail glyphs are flat white with no disc. The CanaReels viewer's own pause glyph was not caught on a frame |
| `Back` at the root goes to the background (#3544) | **`PASS`** | Four warm relaunches then Back at the root: `MainActivity: Back at the root with no history on API 36 - moving the task to the background`, the process kept (same pid), the launcher in focus, no `onDestroy`; 0 `FORTIFY` lines. The `FORTIFY` line itself cannot be provoked from Back any more, and no other exit path could be taken from here |
| A deploy's `502`/`503`/`504` is "not now" ([entry](backlog.d/reading-owed-a-deploy-s-502-503-504-is-not-now-never-a-send-failure.md)) | **PARTIAL** | `serve-dev.yml` is a `workflow_call` library and cannot be run by `gh workflow run`; the drill was a rolling restart of dev's `chat-delivery-service` and `chat-gateway` containers (4 s), then a 38 s stop of `chat-delivery-service`, with the Mi sending a DM text to `beta` every 2-8 s (22 then 14 texts). All 36 arrived on the `beta` seat exactly once, none missing, and no "Echec", "Non confirme" or "En attente du serveur" was on the Mi's screen afterwards. **The edge showed no 502/503/504 line in those windows** (the grep was empty; the edge may not log them), so the status path itself was not shown, only that a stop did not surface as a failure. Salon texts and the production deploy were not taken |
| Birthdays, the ring ([entry](backlog.d/reading-owed-birthdays-on-profiles-3180-first-stable-v1-6-9-birthdays.md)) | **PARTIAL** | `beta` given today's birthday (visibility `followers`, `dateSetAt` two days back, because a date counts from the next Paris day): after a reload the Mi shows the gradient ring on `beta`'s avatar in the conversation list and on the profile, with "16 novembre" and "C'est son anniversaire aujourd'hui" for `alpha`, who follows `beta`. **The non-follower case:** the follow removed (restored after), the same profile draws the ring and "C'est son anniversaire aujourd'hui" with NO date line, and the button is "Suivre". NOT read: the ring on initials, the morning notice (below), "gone the next day" |

**What needs a time the bench cannot wait for.** The morning notice runs at minute 13 of every hour and does nothing before 08:00 Paris:
the read is **08:13 Paris today or later**. `beta`'s row is left staged for it (`lastAnnouncedOn` null, `alpha` following), so a sitting at
08:15 Paris reads the shade row, the bell row and, with `Anniversaires` off, no push. Delete the row afterwards.

**Not staged, and exactly why:** the CanaReels composer on real content (lens covered; the shutter's video needs a held press the
session refused), "Voir plus" with a just-overflowing caption (needs a reel uploaded with one) and with no bottom inset (the
navigation mode did not change through `settings`, MIUI keeps the gesture bar), the seeds-mirror reading (needs a `>= 1.6.6`
build from before 2026-11-07 installed after an uninstall, two accounts enrolled on the install and a sign-in at the identity provider),
the history ask (needs a web seat joining a community after its history), nicknames and the institution phone half (an institution
reel and a fourth account), the first-contact reading (no account pair without a conversation), and the sealed-caches legacy pass.

## The Mi 9T readings of 2026-11-16, readings-ready sitting on `1.7.0-alpha.5`

Mi 9T, `1.7.0-alpha.5` (`versionCode` `100700005`), dev, `alpha` (the `beta` web seat on CDP port 9301 as the peer); the console was read from the in-app log ring (`CanariDBLog` over CDP, after a home press that flushes it) and `adb logcat`. `POST_NOTIFICATIONS` was found NOT granted at the start (the app asked "Activez les notifications") and was granted with `pm grant`. Evidence is outside the repository, in `sitting-mi-ready/` of the harness directory; fixtures written to dev are in `WRITTEN-IDS.txt`.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| A history ask answered "I hold nothing" (entry kept) | **`PARTIAL`** | Joining HOLD1116 from `beta`'s invitation logged no history ask (a join hands the phone the current session, and the ask is made only while no seed is held), so no ask-answer-record was produced on it. Three cold starts (one with Wi-Fi and data off, two online) asked nothing again; the ring's 15:23 launch holds one ask per answerer for another community, each answered "holds nothing", ending `final at distribution epoch 8`. HOLD1116 deleted by `beta` through the product |
| A FIRST message from someone with no conversation, the INVITATION variant (entry deleted 2026-11-16, every half read) | **`PASS`** | `alpha` left HOLD1116 (Quitter la communaute), the phone's process was killed (`am kill`, proven dead), and `beta` invited `alpha` from the community's member panel. 8 s later the shade held "Canari Test Beta - vous a invite a rejoindre << HOLD1116 >>" (`decryptProto: success type=system chars=38`, `showMessageNotification ... shortcut=true`); the community's key group was joined in the background (`isWelcome=true`, `processReceivedWelcomeBackground: group joined`, `markMembershipActive: HTTP 201`). A tap on the row (Android-MCP selector click) opened the app on `/chat`; after the PIN gate the DM with `beta` was open and the invitation card ("Rejoindre la communaute") was already in it, with no restart. `builtBy` not read. A first attempt was lost to a failed `uiautomator` dump (the row was consumed with no landing read) and repeated |
| Stricter script policy, the trombinoscope export on the Mi (entry deleted 2026-11-16, every half read) | **`PASS`** | A `securitypolicyviolation` listener on the page, then the association list's "Trombinoscope" on a list's members page: "Generation..." then the system save dialog for "Liste Fictive 2026.pdf"; saved (a 179 546-byte file, deleted from `Download` afterwards): 0 violations |
| Guided help over a quiet app ([entry](backlog.d/reading-owed-overlays-stacked-by-open-order-not-by-rung.md)) | **`PASS`** | "Revoir la visite" in Settings > Preferences drew "Bienvenue sur Canari 1/6" over the feed, wrapper `z-index` 200, the bubble the topmost element at its centre; "Passer" closed it |
| The toast over the stack | **NOT read** | "Texte copie" drew at `z-index` 310 and was topmost, but the message-actions sheet had closed before it appeared |
| Seeds mirrored before the writer label, step 5 | **NOT TAKEN** | Needs a throwaway account deleted from Settings; none exists and `alpha` is not to be deleted. The push-writer steps are deleted under decision (20) |
| "Modifier les pseudos" item 5 (older build) | **NOT TAKEN** | Needs an uninstall and a fresh sign-in; not reached |
| Sharing into Canari (sign-out, second account) | **NOT TAKEN** | Not reached; the copies-leaving-disk half is deleted under decision (20) |
| PK2 (a), (c) | (a) deleted under (20); (c) **NOT read** | See the entry |
| CanaReels edited PHOTO take ([entry](backlog.d/reading-owed-the-canareels-composer-viewer-and-editor-on-real-content.md)) | **`PASS`** (emoji overlay) | Composer camera, short shutter tap, "Modifier la photo ou la video", an emoji, "Suivant": a 718x1278 attachment with the emoji burned in; text typed but not confirmed; not published |
| Sealed caches, "file opened on the other phone" and the new-backup notice | **NOT TAKEN** | Not reached; the Mi legacy pass is deleted under (20) |

**Upgraded to `1.7.0-alpha.6` (`versionCode` `100700006`, `adb install -r`, Play Protect answered "Ne pas envoyer", the account and enrolment kept, PIN gate then unlocked).** The alpha.6 rows read on the Mi in this sitting:

| Reading | Verdict | What was seen |
| --- | --- | --- |
| "Server already unreachable" once per spell | **`PARTIAL`** | Wi-Fi and data off, six rounds of in-app navigation over about 2.5 min, then back on: the ring holds ONE `[CONNECTIVITY] server unreachable (transport failure)` (17:03:26), then `browser reports online`, `server reachable again`, `probe answered (online event, attempt 1)` (17:06:13), and NO `(server already unreachable)` line at all. A repeat is one only a stalled request raises; the navigation made none, so the "once, not once per request" half is NOT shown |
| A salon message before its seed raises its badge (5 trials, gap under 300 ms); the salon invitation notice live and after reload; the live viewer top bar (longest name); the on-air top row screenshot; the in-session join's private-salon badge | **NOT TAKEN** | Each needs a second seat acting inside a sub-second window or a live with the longest bench name, not reached in this sitting |

**Traps met.** `leave.mjs`-style helpers built on `openCommunity` do not work on the Mi's mobile layout (the community bar has no picker): tap `[aria-label="<name>"]` and `[aria-label="Parametres de la communaute"]`. A full navigation re-arms the PIN gate (`pin.mjs --device A1`). `phone.mjs tapNotification` died on `uiautomator dump` ("Killed") and the shade was then tapped with `mcp__android-mcp__ClickBySelector` on the row's text. The notification-permission prompt covers the community bar until "Plus tard" is tapped.

Dev data written: community HOLD1116 joined by `alpha` (invited by `beta`), left and re-invited once, then deleted by `beta`; no other write.

## The Mi 9T readings of 2026-11-16, second sitting (`1.7.0-alpha.2`)

Same phone, build and account as the sitting above (Mi 9T, `1.7.0-alpha.2`, dev, `alpha`), CDP on the phone, `adb logcat` and `adb screencap`.
Peers: the `delta` web seat (the liker, the commenter and the receiver of the drill's texts). Evidence is outside the repository, in
`sitting-mi-next/` of the harness directory; the fixtures written to dev are in `WRITTEN-IDS.txt` and all are removed again except the
posts other sittings use. **Two corrections to the sitting above.** (1) A held press IS possible: `holdAndSlide` in `cdp.mjs` presses the shutter
as a touch through the WebView (3.5 s hold = a 3 s video; the lens is covered, so the take is black); only a bare `adb input swipe` was refused.
(2) To read an institution's publish step the `alpha` account was made a member of the institution "Ecole Fictive" by one
`association_members` row (deleted afterwards); the account then offers the institution under "Publier en tant que".

| Reading | Verdict | What was seen |
| --- | --- | --- |
| CanaReels "Voir plus", the just-overflowing caption (entry closed 2026-11-16) | **`PASS`** | Gesture navigation (`--safe-area-inset-bottom` 24 px). A 125-character caption fits two lines whole on this phone (no toggle); a 153- and a 160-character caption overflow: collapsed it ends "texte..." with "Voir plus" at `top` 801 / `bottom` 815 CSS px over the seek slider (`top` 829 / `bottom` 861), a 14 px gap; a tap on it reads "Voir moins" at the same place, the caption growing UPWARD to three lines clear of the author row (`adb screencap`), a second tap restores it, `scrollTop` of the viewer stays 0. **The seek line still seeks, with the caption expanded:** taps at 11, 65, 88 and 97 percent of the width of a 3.05 s reel moved it to 0.41, 1.98, 2.70 and 3.01 s (targets 0.34, 1.98, 2.68, 2.96): the far-right tap that read no jump on 2026-11-15 works. NOT read: a phone whose bottom inset is really 0 (this one reads 24 px, 49 px with three buttons) |
| The institution reel publish step ([entry](backlog.d/reading-owed-an-institution-chooses-each-post-s-spaces-and-public.md)) | **`PASS`** | A reel taken in the composer ("Ouvrir la camera", shutter held), "Suivant", then "Publier en tant que" lists "Institutions: Ecole Fictive". Picked: the "Rayon d'action" box with Espaces vises (two campuses, their formations, "Toute une formation") and Public (Tous / Etudiants / Personnel), nothing pre-selected, the hint "Choisissez au moins un espace et un public pour publier." and "Publier" greyed (`reel-publish-picker-empty-dark.png`). With the Saint-Etienne campus and "Etudiants" ticked the hint reads "Seuls les etudiants des espaces coches et les membres de Ecole Fictive le verront." and "Publier" is enabled; published, the post row carries `reachPublic = students` and five Saint-Etienne spaces |
| The edit form with its chips ([entry](backlog.d/reading-owed-an-institution-chooses-each-post-s-spaces-and-public.md)) | **`PASS` drawn, `FAIL` saved** | "Modifier le post" on that reel opens the form with the saved chips ticked (five spaces, "Etudiants") and the hint, dark and light (`edit-form-light.png`). **Saving a changed caption answers `PATCH` -> 400 and the form shows "Impossible de modifier le post"**: the form sends the reel's own video as `media` and the server refuses it. Filed as a P2, fixed in #3670 and read `PASS` on `1.7.0-alpha.5` (entry deleted) |
| The chip on a card and in the CanaReels viewer, light and dark | **`PASS`** | "Etudiants - 5 espaces" beside the age in the reel's viewer footer (gamma's staged institution reel and the sitting's own), and on the post card in dark and in light, legible in both |
| Overlays: the comment report dialog over a post's comments sheet ([entry](backlog.d/reading-owed-overlays-stacked-by-open-order-not-by-rung.md)) | **`PASS`** | A comment by `delta` on `alpha`'s post, "Commenter" opens the sheet (wrapper `z-index` 200), "Signaler ce commentaire" opens the dialog (202) drawn whole above it with Spam / Harcelement / Contenu inapproprie / Autre; "Annuler" closed the dialog only |
| Overlays: the message-actions sheet | **`PASS`** | A held press (900 ms) on a text in a DM: the reaction row and the actions row (reply, forward, copy, share, pin) draw above the thread, the composer and the header, the page dimmed behind. Not readable: over a reel (CanaReels in chats are not flipped) |
| Flat versus glass look, side by side | **`PARTIAL`** | In the chat video viewer, one frame while a finger drags the seek line: the resting speaker is a bare white glyph with no disc, and the time bubble "0:27" is a dark pill with a rim (the transient glass), seek line and thumb in brand yellow (`fg-drag-bubble.png`). The play/pause pop (600 ms) was not caught on a frame and the staged video is black, so the glass's blur over moving pixels is not judged |
| A first message from someone with no conversation yet (entry deleted 2026-11-16, every half read) | **NOT TAKEN** | The rig signs in four accounts; `alpha` has a DM with each of the other three, so no pair is without a conversation, and the fifth dev account has no rig credentials. Nothing was deleted to make one |
| A deploy's `502`/`503`/`504` is "not now", Mi DM half ([entry](backlog.d/reading-owed-a-deploy-s-502-503-504-is-not-now-never-a-send-failure.md)) | **`PASS`** | Dev's `chat-delivery-service` container stopped 41 s (01:39:40Z to 01:40:21Z) while the Mi sent a text to `delta` every 6 s (7 sends). **The status path was exercised: the edge's access log holds, for the phone's own requests (`tauri-plugin-http`), four `POST /api/mls/send` -> 502, ten `GET .../user-members` -> 502 and five `POST /api/presence` -> 503** (the page's own `fetch` saw only the presence 503: the send runs in the native HTTP client). The screen read "En attente du serveur..." during the stop and never "Echec" or "Non confirme" (scanned after every send and 20 s after the end). After the restart the held sends went out in a burst (five `201` at 01:40:34-35Z), and the `delta` seat reads texts 1, 3, 5, 7, 9, 11, 13 exactly once each, its list showing 7 unread. NOT read: the salon half and the iPhone |
| Campus trends: the crossing push, "Aimee par" and the day cap ([entry](backlog.d/reading-owed-campus-trends-and-the-daily-cap-wp-8-wp-10-and-the-quieter-batch.md)) | **`PASS`** (Mi rows) | `delta` (not among the nine fixture reactors, `alpha` follows it, "Partager mon activite" set on for the sitting) liked "Trend probe A" on a web seat: the post crossed `TREND_THRESHOLD` 10 and `alpha` was in the ledger (17 readers, the four bench accounts among them, each with one `campus_trend` bell row). **The account that rings on the Mi is `alpha`**: the app backgrounded, the push "Suggestion : Trend probe A 1700" with the body "Aimee par Canari Test Delta" (`CanariFCM showSimpleNotification type=social channel=canari_social`, one line, `trend-shade.png`), and the bell row "Suggestion : Trend probe A 1700 - aimee par Canari Test Delta" (meta `likedBy` the id of `delta`, `others` 0). The push setting "Notifications push de suggestions" is opt-in and had to be turned on from the Mi first (and was turned back off). **The second crossing the same day pushes nothing:** `delta` then liked "Trend probe B": the post was stamped (`trendAnnouncedAt` set, 10 engaged) and the ledger holds 0 rows for it, no push on the phone. NOT read: the fourth counted push reaching the bell only, the Recents order |
| The CanaReels composer on real content (lenses uncovered) | **`PASS`** | "Ouvrir la camera" shows a live rear-camera viewfinder (cables and a desk, `composer-lens.png`); a 3.5 s hold of the shutter (`holdAndSlide`) records a 3.04 s, 718x1278 take that previews with the real picture and "Suivant" (`composer-lens-after-hold.png`). Discarded with "Supprimer et refilmer" then "Abandonner", nothing published. NOT read: the front camera, publishing real content |
| Real deploys under a sending phone, `1.7.0-alpha.3` and `1.7.0-alpha.4` (same entry as the stop drill) | **`PASS`** | The Mi (still on the alpha.2 APK) sent a text to `delta` every 6.6 s across each redeploy of dev: 80 sends during alpha.3 (02:2xZ to 02:37Z) and 90 during alpha.4 (to 04:33Z), none labelled failed or unconfirmed on screen. The old nginx's access log followed live during alpha.4 holds 27 sends, all `201`, and no 5xx reached the phone. The edge itself did see the swap: its error log holds `connect() failed` to the old upstream, and four access lines carry `ust=502, 201` (the first upstream refused, the retry to the other answered 201), so the window was real and the edge hid it (`drill-real-deploy*.log`, `edge-follow-alpha4.log`). **Builds:** the server side of each reading was dev at the moment of the reading (alpha.2 until the alpha.3 cut, alpha.3 and alpha.4 after); only these two rows were timed to a specific deploy. The phone was the alpha.2 APK throughout |
| The morning birthday notice ([entry](backlog.d/reading-owed-birthdays-on-profiles-3180-first-stable-v1-6-9-birthdays.md)) | **`PASS`** | `beta`'s birthday set to today on dev, `alpha` following it. At 07:16Z (08:16 Paris, app backgrounded) `dumpsys notification` holds one `fr.emse.canari` notification on channel `canari_social` titled "C'est l'anniversaire de Canari Test Beta" with the text "Souhaitez-lui un bon anniversaire"; `lastAnnouncedOn` of the row reads the day's date (`birthday-shade.png`, `birthday-lockscreen.png`). The fixture row was deleted afterwards. NOT read: the in-app tap-through, the opt-out |

**Harness traps met.** `cdp.mjs click "text=..."` scrolls the element into view; inside the reel viewer (a fixed `overflow-hidden`
container holding two reels) that moved the viewer's `scrollTop` to 335 px and read as a displaced reel and an overlapping caption that the app does not
have: a coordinate tap (`clickAtPoint`) does not, and measured `scrollTop` 0 throughout. `Page.captureScreenshot` drew the expanded caption's block clipped
where `adb screencap` showed it whole: judge a layout on `screencap`. `fill` on a contenteditable composer appends to its content.
A click whose target moved because the keyboard rose answers "click missed its target": send it again.


## The iPhone 12 batch 6 readings of 2026-11-14

TestFlight `1.6.12-alpha.2` (About reads "Canari version 1.6.12-alpha.2"), dev estate, bench accounts
gamma and delta, driven over WDA (`tools/ios-device`), native lines from `pymobiledevice3 syslog live`
(processes `Canari` and `CanariNotifications`), the sender a harness Chrome. Evidence is outside the
repository. The bench iPhone has no passcode and no SIM; Wi-Fi was turned off for one row and back on.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Status bar and home indicator under the glass chrome | **`PASS`** | The clock, signal and battery stay legible over the feed, a DM and a salon; the glass tab pill ends at 823 pt and the composer at 810 pt, above the indicator (about 833 pt on the lock screen; `safe area ... bottom 34 pt` is published) |
| PIN gate at the largest standard text size | **`PASS`** | At XXXL (`DYNAMIC_TYPE` 0.545, held through `pymobiledevice3 developer accessibility settings set`, which reverts when the process ends) "Saisie manuelle" and "PIN oublie ?" sit under the sticky Unlock at first; one scroll of 126 pt brings them clear of it with the four dots still on screen |
| Left-edge swipe over a sheet and over a gate | **`PASS`** | Over the Nicknames bottom sheet one swipe closed the sheet and left "Conversation info" open; over the PIN gate nothing moved. Observation: the "Conversation info" panel itself (a side panel, not a `Modal`) does not close on an edge swipe |
| Rear lens preview | **`PASS`, dark scene** | Front and rear show the same rounded card (225-2305 px high, edge to edge) over the blurred backdrop, and the rear scene reaches the card edges. The phone lay flat, so the rear image is dim |
| DM ending in a tall card, keyboard up (3 rounds) | **`PASS` geometry** | "+" and "Envoyer" both at y=487 pt, header at y=55 pt. The log line and the salon are not read (entry deleted, below) |
| Sign in as a different account on a live process | **`PASS`** | gamma signed out and delta signed in without a relaunch: the PIN gate is shown, the previous key is not reused |
| One MLS state per account, A -> B -> A -> B | **`PASS`, lines not read** | gamma, delta, gamma, delta: each sign-in meets its own PIN, then opens its own conversations and decrypts them. The `[MLS_ACCOUNT]` lines are app-log lines, not in the syslog, and a TestFlight WebView is not inspectable |
| R1a. Extension lines in clear | **`PASS`** | `[CanariNSE] didReceive type=message`, `message shape isGroup=false`, `applyBadgeCount: badge=1`, `outcome=decrypted cause=- stage=attach peakMB=3`, every value readable, 4 of 4 pushes to the killed app |
| R1b. Plugin lines in clear | **`PASS`** | `[CustomTabsPlugin] openCustomTab: presenting a session`, `session completed - re-dispatching the callback to the app scheme`, `callback re-dispatched`, in `Canari{Canari}`, none `<private>` |
| R2. `push_context.json` follows an account switch | **`PASS`** | gamma -> delta in the foreground, `terminate`, DMs to delta: the lock-screen banner reads the sender and the text, and the line is `outcome=decrypted` (3 of 3) |
| R3a. No sandbox refusal | **`PASS`** | No `kern.bootsessionuuid unreadable` from Canari in 4 runs |
| R3b. A marker from before a reboot | **deleted, cannot be provoked** | One run lasts about 250 ms (`peakMB=3`); no power-off can be landed in it |
| iOS no longer aborts on an accessibility-tree read | **`PASS`** | `[CanariPush] APNs token received (32 bytes) -> FIRMessaging` after `registerForRemoteNotifications`, and `became active: app delegate is the kept-alive one`, with the tree read hundreds of times in the same sitting |
| Silent frames: hook and banner clear | **`PASS`** | `[CanariPush] remote notification hook installed on AppDelegate (chained=0)`; a DM raised a lock-screen banner while the app was backgrounded, and reading the message on the same account's web client removed the banner within 15 s with the app still in the background |
| Reaction-failure toast | **deleted, cannot be provoked on this bench** | Wi-Fi off: the pill stays and no toast, in a DM and a salon (the reaction is held offline) |
| Waiting share locked with the device (steps 1, 3, 4, and a cold start with the PIN gate) | **`PASS`** | Read with a temporary device passcode on the bench iPhone. Cold launch: `[CanariShare] launch sweep: 0 orphan share(s)`, no `deferred`. A Safari share to Canari waited while Canari was killed and the phone locked for over 10 s with two pushes arriving (notification cells on the lock screen, one banner with sender and text after unlocking); the next launch logged `share imported (launch)` and `a share waits (launch) before the WebView`, no `dropped`, no `unreadable`, no `513`; after the PIN gate the `Send to...` picker was offered at once. Steps 2, 5, 6, 7 are not readable on a store build or cannot be provoked (the copy-protection line is a web `[SHARE]` line, a store build exposes none; a large iCloud video mid-capture; deleted with that reason, owner directive 2026-11-14). The bench passcode could NOT be removed by the agent: turning it off asks for the Apple ID password, so the owner removes it |
| Share in, Safari URL | **partial `PASS`** | Card, banner, tap opens the picker warm; the suggestions row lists four conversations ([entry](backlog.d/reading-owed-sharing-into-canari-on-ios.md)) |
| Emoji pictures, rows 1-3 on the iPhone | **`PASS`** | Seven emoji kinds all drawn as pictures, flag and family one picture each |
| Salon banner for a session started while the phone was shut (NOTIF-20 NSE half) | **`PASS`** | iPhone 12 killed and locked, a second account sent one text in a salon the phone had never seen: the NSE logged `openSeedFrame: stored 1 seed(s)` then `handleChannelMessage: seed source=frame`; the lock screen showed one banner titled with the community and salon, the sender and the text; chat-delivery's `[PUSH_BLIND]` count over the preceding 90 minutes was 0 on dev (the dev server clock reads one hour behind local time) |
| Trills | **`DELETED`** | Delivery proved (6 of 6 pushes arrive with the requested sound); the sound itself is not judged (owner, 2026-11-14) |

**Entries deleted with their reason (owner directive of 2026-11-14).** R3b (cannot be provoked, above); the
reaction-failure toast (offline the reaction is held, an API refused while the phone believes itself online
needs a proxy the iPhone bench has not got; the web code is the one the Mi 9T read on 2026-10-06); the tall-card
DM (geometry read 3 of 3; the `compensating a document scroll` line is an app-log line that a store build does
not expose, and the salon shares the DM's `ChatArea` piece); the Firebase-slot row (the sender works for a
TestFlight build, the O4, TAB-1 and HEAL-NEW-5 rows live on the cross-client iOS board, not here).

**Delivery to a TestFlight build works on dev.** Pushes sent from dev reached the killed iPhone (banner
and `decrypted`) 6 of 6, so the backlog row that blames a missing development-slot APNs key concerns
the dev-signed bench build only.

**Bench notes.** An edge swipe started beyond the screen's height leaves the app for the previous app;
a WDA session left on another app answers "not running" until it is deleted; a tap on a CanaReel card
in a DM opens the viewer.

## The iPhone 12 batch 8 readings of 2026-11-14

TestFlight `1.6.12-alpha.2`, dev estate, `canari-test-gamma`; the peer is the `delta` web seat (CDP 9227);
notifications read and tapped with `tools/ios-device/ios.mjs` `nc`, `hold` and `tap` (see the notes at the end of
batch 7). Evidence is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| A comment push, app killed | **`PASS`** | NC row, `hold`, tap the card: PIN gate, then the post with the comments sheet open and the comment ringed; a banner tap did the same |
| The bell row of a comment | **`PASS`** | The post opens with the sheet open and the comment ringed |
| A comment push, app backgrounded | **`PASS`, explained 2026-11-15** | Comments 3 to 7 raised no banner because they were the daily cap (read in social-service `[NOTIFY] ... withheld`); a backgrounded reply then opened the post at the comment: [entry](engagement.md) |
| A salon mention, app killed, known author (entry closed 2026-11-15, read on the Mi 9T) | **`PASS`** | Title "nse banc communaute - #general", subtitle "Canari Test Delta vous a mentionne", body "@vous reading M mention", `TIME SENSITIVE`, the author's face |

Not staged this batch: the readings of Android-only code (the Mi 9T half of each entry stays), the F1 iPhone runs
(they need an `ios.yml` bench build with `local_url`, not a store build), the new-device notice (a gamma web seat
was not available: seat w2 is another account and seat w3 is a signed-in profile of an unknown account at a PIN gate,
neither touched), the republish request push and the co-organiser push (each needs a staged event or consent flow).

## The iPhone 12 batch 7 readings of 2026-11-14

TestFlight `1.6.12-alpha.2`, dev estate, `canari-test-gamma` (no passcode), driven over WDA
(`tools/ios-device`), traffic from `python -m pymobiledevice3 pcap`, the second seat a harness Chrome.
Evidence is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Emoji pictures, rows 6 (French), 8, 9 (entry deleted 2026-11-15, every row read) | **`PASS`** | App language French then restored; peer reaction round trip and the distinct-reaction limit; the lock-screen banner. The evidence lines were not kept as text |
| Emoji pictures, row 10 (exports) | **`DELETED`** | The agenda's PNG export draws only the selected campus and formation, so the new event was absent from it (the export's scope, not a defect) |
| Emoji pictures, row 11 (cold start offline) | **`PASS`** | Wi-Fi off, cold launch: the PIN gate, no crash; unlocking refused with "Impossible de contacter le serveur. Verifiez votre connexion puis reessayez." |
| Share in from Photos, Notes, Files ([entry](backlog.d/reading-owed-sharing-into-canari-on-ios.md)) | **`PASS`** | Card, banner, and the "Envoyer a..." picker carrying the item. Notes defaults to an iCloud collaboration link: choose "Envoyer une copie" |
| A share, then a sign-out | **`PASS`** | Nothing offered after signing back in |
| Share sheet suggestion row | **not reproduced** | A pick opens the card and banner, and Canari opened by hand shows the picker with the suggested conversation highlighted. A finger tap on the banner is not read (a Notification Center banner tap does not open the app over WDA) |
| GIF relay, iPhone (entry deleted 2026-11-14, every half read) | **`PASS`** | Picker thumbnails and a sent GIF drew; an 11 MB packet capture holds zero `klipy` and 46 `dev.canari-emse.fr`; two `cloudflare-ech.com` names are the stated caveat |
| Institution post chip and composer, light and dark ([entry](backlog.d/reading-owed-an-institution-chooses-each-post-s-spaces-and-public.md)) | **`PASS`** | Picker, hint, disabled "Publier", chip "Etudiants - 5 espaces" with the spaces in its title, both themes |
| Institution event chip, reading 7 ([as built](profiles-and-access.md#an-institutions-reach-per-calendar-event-as-built-owner-2026-11-13)) | **`PASS`** | "Tous - 5 espaces" on the event detail, both themes |

**Bench notes.** Changing the iPhone language restarts SpringBoard and kills the WDA runner, and the old
`wda-daemon.py` keeps port 8100: kill it before starting a new one. The app's own theme (Settings >
Preferences > Theme) is independent of the phone's appearance. In the feed, a card's actions menu is
longer than the screen: scroll inside it to reach "Supprimer le post". `ios.mjs swipe` takes four
separate numbers (`x1 y1 x2 y2`), `long` takes `x y ms`.

**Notifications over WDA (read 2026-11-14, `tools/ios-device/ios.mjs`).** A BANNER opens the app with a plain
`tap x,y` within about 4 s of its arrival. A ROW in Notification Center or on the lock screen does not answer a
plain tap (a stack expands, a lone row slides to an "Open" button that does nothing): `ios.mjs hold <label>`
(an XCUI element touch-and-hold, 1 s) expands it into its card, and a tap on that card opens the app, while
"Repondre" and "Marquer comme lu" are plain taps. `ios.mjs nc` opens Notification Center (a W3C pull from
y=1; `swipe` does not start the gesture). A coordinate `long` press on a banner falls through to the home
screen and starts the icons' jiggle mode (`button home` ends it). The display sleeps 8-10 s after a push
wakes it and a `tree` costs about 1 s, so do wake, find and tap in ONE process, a couple of seconds after the
send. `tools/ios-device` has no README: the usage lives in the header of `ios.mjs`.

## The layout pass of 2026-09-09, and the sixth check that ran later the same day

Six fixes shipped in `v0.16.6-alpha.5`'s ancestors on the strength of a browser emulated at 393px.
**The Mi 9T reports 436 CSS px**, not 393, which is the first reason to run them on glass: every
breakpoint claim was made against the wrong number, and it happened to survive. Built from a tree
carrying all six (`bun a1apk.mjs`, code 1600605) and driven over CDP, element by element.

**Five measured, all PASS.** Each line is the number that decides it, not an impression:

| What was reported | What the phone answers |
| --- | --- |
| the reaction picker ran off the right edge | the row is 363px inside a 436px viewport, `scrollWidth - clientWidth = 0`, all eight reactions between x=42 and x=395. Nothing behind a scroll |
| the associations header overlapped its own buttons | the block is `flex-direction: column` under `sm`, so the title owns the whole row at **404px** where it had 99.6, `scrollWidth - clientWidth = 0`, and the two controls sit on their own line below. No pair of boxes intersects |
| the agenda was a seven-column grid on a phone | **no element in the tree has seven grid columns**, and every day number shares one `left` (33) - a single gutter, which is what makes it a schedule. Today carries `rgb(255, 212, 93)` and no other day does. Day 13 is absent between 12 and 14, so an empty day draws nothing |
| the conversation header painted over the message panel | the sheet is now **a direct child of `<body>`, `position: fixed`, `z-index: 160`** - one entry in its whole ancestry, so it is in the ROOT stacking context. `elementFromPoint` at the header's centre returns the sheet's scrim, and the header is `z-index: 20`. Verified on an OWN message, which is the case the report named: Modifier and Supprimer are both in the panel |
| the voice note was three taps | all FIVE outcomes of one gesture, on glass: hold-and-release keeps it, sliding left past 96px discards it, sliding right past 72px locks it **while the finger is still down**, and the locked bar's two buttons keep or discard. A locked recording ran 0:23 -> 0:31 with nothing touching the screen |

**The sixth ran once its precondition was arranged, and BOTH halves pass.** A proposed event is
supposed to notify an association's calendar managers ([#465]), and the phone's account held no
calendar-validator grant on any association - the precondition is not ambient, and it is more
specific than it first looked: the recipient query is `a.isBDE = true AND (permissions &
VALIDATE_EVENTS)`, so the grant must be on **the BDE**, while the proposer needs `PROPOSE_EVENT` on
a NON-BDE association. **That last clause stopped being true on 2026-09-14** - no creation path
validates any more, whoever asks, so a proposal is now the only outcome and the precondition it
described is gone ([social-service](services/social-service.md#nothing-is-validated-by-the-act-of-creating-it)).
It is left here because the 2026-09-09 run was arranged around it.
Both grants name their account by its OIDC SUBJECT (`subjectFor` in the harness's `accounts.mjs`),
because the display name that was used for this on the morning of the same day granted the wrong
user and produced a P1 ([testing-methodology](testing-methodology.md)).

| half | measured on the Mi 9T, 2026-09-09 |
| --- | --- |
| the shade | **2 271 ms** from the proposal, app in the background. Channel `canari_social`, `BigTextStyle`, `AUTO_CANCEL`, `timeout=PT72H`, a `contentIntent` that starts the activity. Title `Evenement a valider`, body `Canari Test Beta propose << Proposition agenda 496596 >>` - composed by the PHONE from its own `values/strings.xml`, which is the whole point of the key-not-a-sentence seam |
| the in-app row | `Canari Test Beta propose un evenement` + the title, marked `Nouveau`, with a relative time. It renders from Paraglide's `notif_event_proposed_text`, NOT from the native table |
| the fan-out | two `event_proposed` rows written, to both `VALIDATE_EVENTS` holders on the BDE - the phone's account and one other. The event stayed `status=pending` |

**A ROUTE CHANGE IS NOT A REFETCH, and the first reading of the in-app half was a false negative.**
Pushing `/notifications` through `history.pushState` rendered the page and found nothing; the same
page after a reload showed the row. Anything asking whether a LIST contains something must make the
list fetch, or it is reading the one it already had.

**Two defects came out of reading the notification rather than counting it.** The agenda's five
resource pairs had shipped **with their accents stripped** - `Evenement a valider`, `Evenement
valide` - while every neighbour in the same file carries them, and the loss changes the word:
`valide` is an adjective, `valide` with its acute a participle. In the same file the two FORM pairs
were still ENGLISH on the legacy side while the resource beside them had been French for weeks, so
the oldest clients got the one language the app does not speak. Both are fixed, and both are now
held by a test that compares the server's `legacyTitle`/`legacyBody` against the Android resource
for every key - two copies of one sentence that nothing had ever compared. **The in-app row was
correct throughout**, which is exactly why neither was noticed: the two halves read from two
different string tables, and only the native one was written without accents.

**The estate is left as it was found**: both grants, the proposed event and the two notification
rows were deleted by an allowlist on the marker role and the marker title, and both accounts read
zero memberships afterwards - an undeclared membership reattributes whatever the next run measures.

**One thing the pass found that no report had asked about**, filed rather than fixed here: the
composer's pending-attachment chip painted its filename TWICE - a `span.line-clamp-2` inside the tile
and a `div.truncate` under it, overlapping by 7 px in a 62 px column and disagreeing about how to
shorten the name. **Closed the same day by #470**, which left one name and the guard that keeps it
that way (`ChatComposer.attachments.svelte.test.ts`, *"writes a plain file name exactly once, where
it used to write it twice"*). The story is in `CHANGELOG.md`; the backlog entry is gone, because the
backlog is only what is left to do.

**And one instrument came out of it.** `cdp.mjs` could click and it could drag to another element;
it could not HOLD. `holdAndSlide` slides a distance rather than to a node - a threshold has no node
to name - and `release: false` leaves the pointer down, without which `holding` and `locked` cannot
be observed at all: both are gone by the time a release lands.

## Putting the phone at a chosen CSS width - the four densities, measured

**The Mi 9T is 436 CSS px at its own settings, and every phone breakpoint in this repo is written
for 390, 375 or 360.** So a layout check on glass has to move the device to the width it is about
to make a claim about, rather than make the claim at 436 and hope. The screen is 1080 physical
px wide and Android's CSS scale is `density / 160`, so the width is `172800 / density` - and the
four values that matter were **measured on the device**, not computed and trusted (2026-09-14,
`window.innerWidth` read over CDP, app 0.16.6):

| `adb shell wm density <n>` | `window.innerWidth` | what it is for |
| --- | --- | --- |
| 443 | **390** | the phone width every sweep in this repo uses |
| 461 | **375** | the reference width the truncation budgets are derived at ([design-reference](frontend/design-reference.md)) |
| 480 | **360** | the narrow end - where a string that merely fits at 390 is cut |
| **396** | **436** | **A1's baseline. Restore it when you are done.** |

`wm density` with no argument prints both the physical and the override, which is how you check you
put it back. Two traps: the change **restarts the app**, so a devtools forward made before it points
at a dead process - re-read `pidof fr.emse.canari` and forward again; and the socket is
`localabstract:webview_devtools_remote_<pid>`, **not** `chrome_devtools_remote`, which answers
nothing and looks like a dead WebView rather than a wrong name.

## Before you start

- **KNOW WHAT THE DEVICE IS RUNNING, before anything else.** Not `versionName` - that is a constant
  edited at release time and it read `0.13.1` for both a current build and a stale one on 2026-08-11.
  Two readings that cannot be faked:

  ```
  adb shell dumpsys package fr.emse.canari | grep -E "pkgFlags|signatures|lastUpdateTime"
  ```

  `pkgFlags=[ DEBUGGABLE ]` means a debug APK, which is **~10x slower than release on the same
  fixture** (WP-ANR-1's own measurement) - every behavioural check still holds, every timing verdict
  is void. And a debug-keystore install cannot be replaced by a release-signed APK
  (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`): crossing that line needs an **uninstall, which wipes
  `mls.bin`** and re-enrols the device, so it is a decision to take before the setup, never at the
  install step. **That refusal is SYMMETRIC and names neither side** - it fires just as well when
  the phone carries the release build and the APK is the debug one, which is the case in which the
  uninstall has ALREADY happened; `pkgFlags` answers which is which. **And afterwards nothing says
  it happened**: the replacement package reads the right version and launches, so the only witness
  is that `install -r` preserves `firstInstallTime` and a fresh install does not. **`firstInstallTime
  == lastUpdateTime` means a NEW device** - no enrolment, no MLS store, and `POST_NOTIFICATIONS`
  back to denied, which a push check needs granted. `a1apk.mjs` prints all of it after every
  install. **A1 lost its device this way on 2026-09-24**: a release APK built to verify the WebView
  devtools fix was installed over the rig's debug build, and the uninstall that allowed it took the
  enrolment with it - the phone now carries a device created 2026-09-24 03:11 and joined to nothing.
  Then date the CODE from a string the running app logs - `git log -S "<that line>"` -
  because a log string is version-stamped evidence the process hands you for free. See rule 17 in
  [testing-methodology](testing-methodology.md).
- **KNOW WHICH ESTATE THE BUILD POINTS AT, because it decides what EMPTINESS means.** Read it from
  the client's own request origins, never from the build's name. The test population - the accounts
  the harness drives, their conversations, their history - lives on the **LOCAL** estate; a phone
  pointed at `dev.canari-emse.fr` has neither those accounts nor any MLS state of its own, so
  `/chat` reading "Aucune discussion" there is the expected reading of a new device on an empty
  estate, not a defect. The same holds for a directory search that returns nothing. Measured on A1
  on 2026-09-14, where it cost a session's worth of readings before it was noticed.
- **A PHONE CANNOT BE PUT IN LANDSCAPE, AND A MANIFEST GREP ANSWERS THAT QUESTION WITH SILENCE.**
  The lock is in Kotlin, not the manifest: `MainActivity.kt:47-53` sets
  `SCREEN_ORIENTATION_PORTRAIT` when the resource boolean `R.bool.canari_lock_portrait` is true and
  leaves `SCREEN_ORIENTATION_UNSPECIFIED` otherwise, so a tablet keeps its rotation.
  `android:screenOrientation` takes one literal value and cannot serve both, which is why a resource
  qualifier carries it.
- **A second account.** Every push check needs a peer to send from. A second phone, or the web app
  in another browser profile, both work.
- **A log capture.** iOS: Console.app or the Xcode device console, filtered on the app and on
  `fr.emse.canari.push` for the notification extension. Android (check K only):
  **[`tools/android/verify-on-device.py`](../../tools/android/verify-on-device.py)** - a tkinter GUI
  that builds, installs, and tails per-device logcat with this runbook's tags already whitelisted.
- **Screen genuinely locked, app genuinely killed** for B. A backgrounded app is a different code
  path and passing it proves nothing about the one under test.

---

## B. Decrypted push, app killed, screen locked

**Proves** the whole background chain: FCM wakes the extension, the keychain hands back the device
key, the MLS state loads read-only, and the ciphertext decrypts. On iOS this is the first ever
proof that background decrypt works at all.

1. Kill the app. Lock the screen.
2. From the peer account, send a DM with recognisable text.
3. Read the notification on the lock screen **without unlocking**.

**Pass** = the notification shows the actual message text. A generic "Nouveau message" is a FAIL -
it is the fallback for a decrypt that did not happen.

**Where to look:** Console.app, filtered on the `fr.emse.canari.push` extension process. The Rust
`[MLS]` lines are the same code as Android's, so `[MLS] Keystore key failed to decrypt blob - key
deleted.` means the same thing here. iOS keychain service is `fr.emse.canari`, accounts
`mls_key_<alias>` and `mls_bg_key_<alias>`. The Android equivalents, for comparison, are tags
`CanariFCM` and `MlsDeviceKeyStore`, ending in `decryptProto: success type=... -> "..."`.

**Known limit, not a bug:** background decrypt is read-only and applies no commits, so a message
sent in a *newer epoch* than the persisted state cannot be decrypted and correctly falls back to
the generic text. `decryptProtoWithCommits: success after catch-up` is the in-memory catch-up path
succeeding. If a check fails, confirm which of the two you are looking at before filing anything.

## B-bis. A DISMISSED notification does not come back at the next launch - owed on Android

**Proves** the one thing no gate here can see: that the builder's durable record of what it has
announced (`canari_alerted_messages`) actually survives the process and is consulted. The vitest
suite `dismissedNotificationReplay.test.ts` reads the Kotlin source and proves the code is WRITTEN;
only a phone proves the shade stays empty.

1. Kill the app. From the peer account, send a DM with recognisable text.
2. Wait for the notification, then **swipe it away** without opening the app.
3. Launch the app and let the startup catch-up finish.

**Pass** = nothing reappears in the shade, and the message is in the conversation. A notification for
that same message is a FAIL: the push was redelivered over the socket (it was never ACKed) and the
record did not recognise it.

**Then, in the same run, the case that must NOT be silenced:** with the app killed again, have the
peer send a SECOND message and do not dismiss it. Open the app. Dismiss nothing. Have the peer send a
THIRD. **Pass** = the third notifies. A silent third means the record is behaving like a watermark
rather than a set, which is the failure mode its shape exists to avoid.

**Where to look:** `adb logcat -s CanariFCM`. `showMessageNotification: already announced and
dismissed -> nothing posted` is the suppression firing; `already in the shade -> refreshed without
alerting` is the OTHER guard (the notification was still visible) and does not test this one.

**Known limit, not a bug:** a SALON message is not covered. Its push payload carries no timestamp, so
the builder can identify no message of its own and never guesses - see `docs/wiki/backlog.md`.

## B-reel. A CanaReel announces itself on the lock screen of a killed app - owed on BOTH platforms

**Proves** WP-RC-7 where no gate here reaches: the Rust scanner reads `MediaMsg.intent` and words
the line (`mobile/push_text.rs`, `PushText::Reel`), but only a phone proves that the line it returns
is the one the Android service and the iOS NSE post, through all three decrypt paths - MLS for a DM
and a group, Graine for a salon - and that no thumbnail is ever attempted
([reels-in-chat](frontend/modules/reels-in-chat.md#push-text)).

**Precondition, not ambient:** the SENDER must run a build with the reel writer (RC-4, behind its OFF
switch) turned on; nothing else can produce a reel message. The receiving phone runs any build
carrying RC-7.

1. On the receiving phone set the app language to **French** (Settings, inside Canari - not the
   phone's). Kill the app. Lock the screen.
2. From the peer, send a CanaReel with NO caption in a **DM**, then one in a **group**, then one in a
   **salon** of a shared community.
3. Read each notification on the lock screen **without unlocking**.
4. Send one more in the DM WITH a caption.
5. Open the app once (so the locale is mirrored), switch the app language to **English**, kill it,
   lock, and repeat 2-4.

**Pass** = French: the DM reads `🎬 CanaReel` under the sender's name, the group and the salon read
it under their own titles as any message does there, and the captioned one reads `🎬 CanaReel : <caption>`;
English: `🎬 CanaReel` and `🎬 CanaReel: <caption>`. **No picture** on any of them. **FAIL** =
`🎥 Vidéo` / `🎥 Video` (the receiving build does not carry RC-7, or the sender did not declare the
intent), a generic "Nouveau message" (the decrypt did not happen: that is check B's failure, not this
one's), or any thumbnail.

**Where to look:** Android `adb logcat -s CanariFCM`: `decryptProto: success type=media -> "🎬 CanaReel"`
(`decryptProtoWithCommits` after a catch-up; the salon's Graine path logs its own open). iOS:
Console.app on the `fr.emse.canari.push` process (`[CanariNSE]`). The Rust
`[MediaBG] ... reel=true - no thumbnail, key withheld` line is a `debug` line of a process the app's
logger may not run in - its absence proves nothing; the missing picture is the reading.

## WMP. The wry main pipe after an activity destroy - owed on Android

**Proves** the vendored wry fork ([mobile](frontend/mobile.md#wry-main-pipe-patch)) on a device: a
message for a destroyed activity no longer aborts the process (Play crash `e3697bc4...`).
Compiling it proved nothing about that. Mi 9T, a build carrying the fork, logcat filtered to the
three lines that decide it: `adb logcat | grep -E "WRY_MAIN_PIPE|SIGABRT|ANR in"`.

**The ANR (`f51255a5...`) is NOT what this row proves.** It is fixed by construction - an unbounded
channel's `send` cannot block, and the wake write is non-blocking - and no bench sequence fills an
eight-slot channel on demand, so a quiet bench would prove nothing about it. Its proof is the field
reading below.

1. `adb shell settings put global always_finish_activities 1` ("Don't keep activities": leaving the
   app now destroys its activity while the process lives, `isChangingConfigurations` false - the
   path that removes the activity's proxy).
2. Open the app, sign in, open a conversation, press Home. **Expect** the process still alive
   (`adb shell pidof fr.emse.canari`).
3. From a second device, send three messages to that conversation, and wait one minute. **Expect**
   `[WRY_MAIN_PIPE] no WebView for activity N: it was destroyed, so its queued messages are dropped`,
   exactly ONCE for that activity id. **That line is the proof the trigger was reached** - a message
   did arrive for a destroyed activity, which on `v1.6.2` was the abort. Without it the row proves
   nothing and says so; the chat socket lives in Rust (`tauri-plugin-websocket`) and is the expected
   sender. **And expect** no `SIGABRT` line and the process still alive.
4. Reopen the app from the launcher. **Expect** the conversation to load normally, no `ANR in
   fr.emse.canari`, and no other `[WRY_MAIN_PIPE]` line - `failed`, `left a Java exception
   pending`, `stopped waiting` each name a defect, with the Java stack just above for an
   exception; so do `the wake pipe reached end of file` and `the wake pipe read failed`, each followed
   by a SIGABRT (the deliberate abort of a dead wake pipe, owner decision 2026-11-03).
5. Repeat 2-4 five times (each destroyed activity logs its own one line), then
   `adb shell settings put global always_finish_activities 0`.

**And in the field - the ANR's only proof, and the crash's second**: once a release carrying the fork
has served a fortnight, run `bun tools/play-vitals/vitals.mjs`; neither `f51255a5...` nor
`e3697bc4...` may show a report at or above that release's versionCode. Then add both to
`tools/play-vitals/known-issues.json` (the merge commit, and that versionCode as
`fixedInVersionCode`), so any later report reads as a REGRESSION.

Play may cluster the deliberate dead-wake-pipe abort with `e3697bc4`, both being a SIGABRT from the
looper callback, so read the frames below `cb_handler`: an `onFirstActivityCreateWry` closure means
a dead pipe (the owner-decided abort); `get_webview` or `handle_message` means a real regression.

## CFP-W3. The step-1 wake still wakes after migration 046 - owed on the Mi 9T, on dev

**Proves** that moving the wake capability from `push_token.wakeCapable` to `wakeVersion` (content-free
push WP-W3, [design](protocols/content-free-push.md#8-rollout-and-old-clients)) left the step-1 MLS
wake working on a real phone, and that the envelope half is inert while no client declares version 2.
Nothing native changed; the server reads a different column, writes it from the same `wake: true`,
and the wake answer gained a `presentation` key the Android reader must ignore. Needs dev on a release
carrying 046, `push_mode = wake` on dev (WP-W1), and the Mi 9T on any build carrying the step-1 client.

1. BEFORE reopening the app after the deploy, send the Mi 9T a 1:1 text with the app killed.
   **Expect** a banner with content, and on the server `[PUSH_SEND] ... mode=full` for that device: its
   row reads `wakeVersion = 0` until the app starts (046 writes no backfill - the full push is the
   contract the binary registered under, never a lost notification).
2. Open the app once (a cold start registers), then kill it. **Expect** on the server
   `[PUSH_REGISTER] ... wake=1`, and no `[PUSH_ENVELOPE] register sweep FAILED` line.
3. Send three texts (1:1, group, salon) with the app killed - reading 1 of the
   [backlog entry](backlog.d/push-payloads-carry-nothing-for-google-and-apple.md#readings-owed-the-code-is-verified-only-by-compiling-and-ios-not-even-that-before-a-release).
   **Expect** the 1:1 and group banners with their text, `[PUSH_WAKE] fetched` in
   `adb logcat -s CanariFCM` before the decrypt (the extra `presentation` key read by nothing), and on
   the server `mode=wake` sends with one `[PUSH_WAKE] served queued=...` each. **Expect** the salon to
   arrive as a FULL push (`[SOCIAL_PUSH] sent ... mode=full`): the device declares version 1, so no
   `[PUSH_ENVELOPE]` line and no `mode=wake` on `[SOCIAL_PUSH]` anywhere.
4. On the dev database: `SELECT platform, "wakeVersion", count(*) FROM push_token GROUP BY 1, 2` and
   `SELECT count(*) FROM push_envelope`. **Expect** the Mi 9T's row at 1 and ZERO envelopes - an
   envelope before WP-W4 ships is a writer this row did not expect.

The envelope wake itself (a salon, a comment and a chat reaction, each drawn with content from its
envelope; a repeat fetch drawing ONE notification) is WP-W4's reading, owed once Android declares
version 2.

## The VoIP ring announces a video call as video - owed

**Proves** that the native ring carries the media kind (alpha.2 bench: a video call rang as audio).
Needs a dev build (`CALLS_VIDEO_ENABLED`, `calls_mode = audio_video` on the dev server), the iPhone 12
locked and the app killed, and a second device calling it with VIDEO.

1. Place a video call from the other device. **Expect** the CallKit screen to read as a video call
   (the video-call label and the video button on the lock screen), and the log
   `[CanariCallKit] voip push type=call_ring call=... video=1` then `ringing call=... video=1`.
2. Answer, unlock. **Expect** the camera on in the call (`pending accept hasVideo` true, the local
   preview visible) and the caller seeing video.
3. Repeat with an AUDIO call: `video=0`, audio screen, camera off.
4. With `calls_mode = audio`, a video ring attempt is refused by the server: no CallKit ring at all.

## The emoji picker paints at once - owed on the iPhone (2026-11-08)

Cause and fix: [emoji](frontend/emoji.md#the-picker-paints-at-once---2026-11-08). On a pre-release, killed app, a conversation with at least one message: open a conversation, wait for it to settle, tap a message's reaction "+" (then the composer's emoji button on a second run). Read: no cell of the first screen of "Smileys et emotions" is blank or grows, "Recents" has no empty tile, the tab bar shows nine icons and no stray glyph, on the FIRST open after a cold launch. Record the first-frame state with a screen capture. **Since the emoji setting (2026-11-09) this reading is of the "Canari" mode**: choose it in Settings > Preferences first.

## The emoji setting - owed on both phones (2026-11-09)

Mechanism: [emoji](frontend/emoji.md#the-setting---one-resolver-2026-11-09). On a pre-release, both phones, an install that had the app before the update. Read: **(1)** with nothing chosen, Settings > Preferences > "Emojis" shows "Systeme" selected, and a bubble, a reaction pill, the picker's cells and tab bar and the composer draw the platform's emoji (Apple's on the iPhone, the phone maker's on the Mi 9T), a skin-toned thumb in one glyph; **(2)** the picker's cells sit centred at the size of the pictures, nothing clipped; **(3)** switching to "Canari" redraws the open conversation in Noto's pictures without a restart, and a cold start opens straight in pictures with no system glyph on the first frame; **(4)** back to "Systeme", a cold start draws no picture first; **(5)** a jumbo emoji-only message is large in both modes; **(6)** under "Systeme", a poster export still shows Noto's pictures.

## The seed mirror labelled by account - owed (2026-11-07)

**Proves** that the Graine seed mirror's account labels are written on hardware by both writers (the
page and the push decrypt) and that one account's wipe removes its own seeds and leaves the other
account's ([auth](frontend/modules/auth.md#the-seed-mirror-labels-each-entry-with-its-writers-2026-11-07)).
Verified so far by host tests only, and no mobile target was compiled on the Windows box that wrote
it: the Kotlin absorber now reads `{stored, leftToApp}` from the JNI writer, and the Objective-C
activation mirror hands the seed file to Rust (`canari_ios_mirror_graine_seeds_to_app_group`) instead
of copying it. Needs a pre-release carrying the change, the iPhone 12 (`tools/ios-device`) - the
platform with TWO copies of the mirror (app and App Group) - then the Mi 9T, and two test accounts A
and B that are both members of one community with two salons S and T, plus a second device for B. A
message is "under a session" until that salon rotates (a member joining rotates it): keep T quiet of
joins for the whole reading.

1. On the phone, sign in as A and let its community sync settle, then sign out and sign in as B -
   for the FIRST time on this phone. Opening a salon mirrors nothing: the page mirrors a seed when it
   RECEIVES one (B's first community sync replays the key-group frames that carry T's current
   session) or when it MINTS one. After B's first sync settles, T's current session is labelled A
   and B.
2. Still as B, app killed: have a member mint a new session in S (a member joining is enough), then
   send a message in S: **expect** a decrypted banner - the seed frame went through the push writer,
   whose entry is labelled B alone.
3. From B's other device, remove this phone from B's devices. **Expect** the per-account wipe (A
   still lives here), with the page's line `[REVOKED-LOCAL] ... mirrored Graine seeds: N seed
   entry(ies) removed from the app's copy (alone on the install: false)` and, from Rust, one line PER
   COPY: `[GRAINE_MIRROR] the account's seeds in the app's copy: N removed, M kept for another
   writer, 0 of unknown writer removed, K of unknown writer left, C channel(s) dropped`, and on iOS
   a second line `... in the App Group copy: ...` with its own counts (equal to the app's when the
   group copy was current). N counts the sessions only B wrote (step 2's at least), M the ones A also
   wrote (T's at least), K the ones mirrored before this build. `0 of unknown writer removed` is the
   point: another account lives here.
4. Sign in as A WITHOUT the community sync reaching T (airplane mode right after sign-in), kill the
   app, back online, send a message in T from another client: **expect** a decrypted banner - A's
   label kept the shared entry through B's wipe.
5. On the OTHER phone, holding ONE account only and updated over a pre-label build (so its mirror
   has entries of unknown writer), with a throwaway test account: delete that account from
   Settings. **Expect** `(alone on the install: true)` on the page's line and `K of unknown writer
   removed` with `0 of unknown writer left` on Rust's - the pre-label entries go with the install's
   last account. (A signed-out account keeps its parked MLS state, so it still counts as "on the
   install": steps 1-4's phone never reads `true`.)
6. Nothing in the log at ERROR `[GRAINE_PUSH] seed ... carries no writer account` at any step: that
   line means a push decrypt reached the writer without its stamp. On Android, a seed RELAYED for the
   app (no channel known to the push) logs at INFO `left to the app`, never at ERROR.

**Steps 2 and 4 (the push writer) and the push half of step 6 are deleted (deleted 2026-11-16 by the owner's decision (20): not stageable on the bench).** Step 5 is the one still owed (the entry's reading).

## The camera tab and Android Back - read on the Mi 9T, `1.6.3-alpha.2`, 2026-11-02

**Method.** The WebView's DevTools socket (`adb forward` to `webview_devtools_remote_<pid>`) read `location.pathname`, `<html>` classes and the console (`[reel-capture]`, `[historyOverlay]`) after each press; no personal data.

| Attempt (about 12 presses) | Result |
| --- | --- |
| Idle camera, Back (x4, then swipe back to the camera each time) | `/posts`, chrome back (`fullscreen-place-open` removed), camera reopens by swipe: **PASS** |
| Hold the shutter 3-4 s, release (review), Back | the "Abandonner cette capture ?" question; `[historyOverlay] Back closed 1 overlay(s), 0 left open` |
| Back DURING the recording | the camera returns idle on `/camera`, chrome as designed; one more Back goes to `/posts`: **PASS** |
| Review, Back (question up), Back again (x2, 100 % repeatable) | **the app leaves** (`Setting back callback null`, task closed, no `[historyOverlay]` line for that press) instead of the feed |

**The stuck `/camera` without chrome of alpha.2 did NOT reproduce.** Signature to watch for if it returns: `location.pathname` still `/camera` with `<html class="fullscreen-place-open">` and `[reel-capture] leaving (navigation) ... the camera stays closed` with NO `a navigation ended on this screen` / `did not happen` line after it. That is the same-URL popstate hypothesis (a drain by `beforeNavigate` that no `afterNavigate` follows), still untested.

**The double Back that left the app - cause found, fixed on the web side, the native half owed a build.** Review, Back (the question), Back again finished the activity: `finishing=true`, no `popstate`, no `[historyOverlay]` line. The chain, read on the phone: the question's overlay entry (`ConfirmDialog` -> `ModalOverlay` -> `bindHistoryOverlay`) IS on the stack and history (`history.length` 3, DevTools `Page.getNavigationHistory` shows it), but Wry's callback asks `WebView.canGoBack()` first and it answered false, so `MainActivity.onBackPressed` finished the app. What decides it: an entry pushed from a Back's own handler has no user activation behind it, and Chromium declines to step back from it until the page sees one - a TAP on the dialog text between the two Backs made the second Back close the question (3 of 3), the same question opened by the review's X (a tap) never failed, and `history.back()` from DevTools stepped it fine (a DevTools evaluation may itself count as a user gesture, so that line is weak evidence; the fresh-launch reading below is the real proof). Fix: the page PUBLISHES how many overlays a Back can still close (`window.canariBack.setOverlayDepth`, from the one place `historyOverlayStack` changes: the live overlays minus the Backs issued and not yet landed, as `settleArrival` will close them - a ghost between two live overlays still has one to close; zero on the router's own entry and where no entries are written), and `MainActivity.onBackPressed` reads that number SYNCHRONOUSLY: above zero it lowers it at once and calls `window.__canariBackFromNative()`, which steps the page's own history (the Back closes the question, "Keep"); zero leaves as before. Lowering the depth at the hand-over, not at `popstate`, is what makes two fast Backs close one overlay each. Pinned in `historyOverlayStack.test.ts` (two fast Backs; router entry, no-entry runtime and ghost promise nothing); the Kotlin compiles in CI ("Compile Android app") but HAS NEVER RUN. **Owed: a build with it, then on a fresh launch:**

1. Film a take, Back (the question), Back again: the second Back closes the question, not the app; a third asks again.
2. Two Backs pressed fast on a review: one overlay closes per press, the page below the camera is never reached.
3. Back on an incoming call's full-screen overlay: it is minimised, not hung up.
4. Back on a conversation opened from a notification: it closes to the list.
5. Back at a root screen (no overlay open): it still leaves the app.

**Untouched stages, read the same day.** The send sheet: Back closes the sheet and leaves the review; the next Back asks the question (a document that had taps: fine). The Android edge-swipe Back in a review asks the same question. The publish sheet was not reached.

**Reading of 2026-11-02 (`1.6.3-alpha.2`, both phones, French; [reels-in-chat section 20](frontend/modules/reels-in-chat.md#20-the-bench-reading-of-163-alpha2-2026-11-02)).**
The sender was the other bench phone with the dev writer on. No caption (the chat camera has no
caption field), no salon (RC-8), English not run.

| Phone | App state | Conversation | Lock screen | Verdict |
| --- | --- | --- | --- | --- |
| Mi 9T | killed (`HOME`, `am kill`, `pidof` empty), screen off | DM | title `<sender>`, text `🎬 CanaReel`; `decryptProto: success type=media chars=11`, `showNotification ... hasMedia=false` | **PASS** |
| Mi 9T | same | group | title `<group> : <sender>`, text `🎬 CanaReel`; `hasMedia=false` | **PASS** |
| iPhone 12 | backgrounded (Home), locked | group | `<group>, <sender>, 🎬 CanaReel` | **PASS** |
| iPhone 12 | backgrounded, locked | DM | `<sender>, 🎬 CanaReel` | **PASS** |
| iPhone 12 | killed (`ios.mjs terminate`), locked | DM | `<sender>, 🎬 CanaReel` | **PASS** |

No picture of the reel on either platform. The iPhone's notifications carry one attachment on every
message, text included (the sender's avatar, `Received replacement content ... attachments: 1`),
so its "Piece jointe" is not a thumbnail.

**One finding on the iPhone, not specific to reels (P1 iOS notifications):** in a DM created a few
minutes earlier, while the app was open, and the app then killed with `terminate`, BOTH a reel and
a control text read `Nouveau message de <sender>` - the generic line, so the extension did not
decrypt. The same DM read its content once the app had been opened again and left by Home, and a
DM killed afterwards read `🎬 CanaReel`. The group, older, read its content throughout. Read as:
the state the extension decrypts with did not yet hold the new DM when the process was killed. The
syslog shows the extension ran and delivered mutated content (`Service extension delivered mutated
content`, `Delivered user visible push notification`); its `[NSE_OUTCOME]` line is not readable on a
TestFlight build (its backlog entry was withdrawn by the owner on 2026-11-03). **Read again on
`1.6.5-alpha.1` (2026-11-05) and explained:** the App Group copy of the state was made only at an
activation or a resignation, and a process killed in the foreground never resigns; the copy now
follows every write of the state ([mobile](frontend/mobile.md#the-extensions-copy-of-the-state-follows-every-write-2026-11-05)).
Owed: this row again on a build carrying it.

## C. The row a push creates carries the GROUP's name - owed on BOTH platforms

**Proves** the half of the push cache no browser can reach. `consumeFcmCache` writes a placeholder
conversation row beside the message - it must, the message has a foreign key to `conversations(id)` -
and until 2026-09-15 it labelled that row with the SENDER. For a DM the two coincide; for a group it
was whoever spoke first, and the label was never corrected afterwards, so a two-person group sat in
the sidebar under the other member's name directly above the real DM with that same person.

The decision is pinned deterministically (`pushConversationLabel.test.ts`, and
`fcmCacheFields.test.ts` for the two native writers), so what is owed here is the one thing neither
can see: that the group name really is in `data["groupName"]` on a delivered push, and really does
reach the file.

1. From the peer account, create a group with a distinctive name, and add this device to it.
2. **Kill the app** - the cache path only runs when the app was not up to receive the frame.
3. From the peer account, send one message into that group.
4. Open the app and read the sidebar **before** the MLS sync finishes (the row is drawn from the
   cache first - that is the whole point of the pre-injection).

**Pass** = the row carries the GROUP's name. **FAIL** = it carries the sender's name, which is the
defect, or the group id / "Groupe", which means `groupName` arrived empty and the server half is
what to look at.

**Where to look:** `adb logcat -s CanariFCM` for the delivered `data` map, then the app's own
`[FCM_CACHE]` lines. A `[DISCOVERY] ... relabelled "<sender>" -> "<group>"` line afterwards is the
REPAIR firing, which is a pass for the repair and means step 4 was read too late to see the cache
label.

**THE "CHEAPER CASE" DOES NOT EXIST, AND THIS PARAGRAPH USED TO CLAIM IT DID.** Renaming the group
from the peer account while this device is away was offered here as a way to reach the repair without
a push. It cannot: `groupRenamed` is a DURABLE frame, so the device that was away receives it on
reconnect and applies the new name through route ONE. Discovery then finds the two names already
equal and correctly says nothing. Measured 2026-09-15 on a web client - 371 console lines, zero
relabel lines, the new name on screen in 1 ms. The seam is only reachable when the local label is
wrong and no frame is coming to fix it, which is what a push placeholder leaves behind and is
therefore the push case above. Reaching it deliberately means writing the wrong label straight into
the device's own store, with an observer attached before the reload - a rig procedure, not a
hardware check.

## D. PIN change, then repeat B

**Proves** that rewriting the device key under the same alias leaves the background reader working -
this is where a writer/reader format mismatch shows up.

1. Change the PIN in the app.
2. Repeat B.

**Verdict:** `[MLS][Tauri] Device key changed - state re-encrypted and persisted.` in the app log,
then a full pass of B. A pass on B *before* the change and a fail after is the signature of the
alias being written in a format its reader does not accept.

## E. Fresh install + login, then repeat B

**Proves** the same chain on a device with no migration history - the path every new user takes,
and the only install path still tested (the upgrade path was retired on 2026-07-31: staging it now
means deliberately downgrading to a pre-WP-SEC-1 build, and every install worth testing has long
since migrated).

1. Uninstall completely. Install from TestFlight. Log in.
2. Repeat B.

## F. Login end to end: init, save, KeyPackage

**Proves** WP-VERIF-1. On the login of check E, confirm in the app log:

- `[DB] Using SQLite storage (Tauri)` - and **never** the IndexedDB fallback. That fallback is a last
  resort, not a mode; seeing it means `SqliteStorage.init()` threw.
- `KeyPackage published.` - without this, no peer can invite this device.
- A relaunch restores the conversation list, which is the only proof the state was actually saved.

## G. Biometrics: enable, relaunch, disable, and the PIN modal

**Proves** WP-VERIF-3.

1. **Enable** biometric unlock from the profile screen. The prompt must show **two** app-supplied
   lines on iOS, not four: a title naming the action and a generic confirmation line. (Android
   stacks title+subtitle+description and adds its own hint - four fields, four lines. Same strings,
   different shape.) No string anywhere may name a sensor - there is no Face ID on Android and no
   fingerprint on a Face-ID-only iPhone.
2. **Relaunch** and unlock with the face/finger. The login must complete, *not* fall back to the PIN
   modal after a successful biometric.
   - `[BIOMETRIC] Biometric login attempt`
   - `[BIOMETRIC] Authenticating for userId=... via device keystore...`
   - `[BIOMETRIC] Skipping PIN verification - using device keystore...` &larr; the decisive one. Its
     absence with the two lines above present is exactly the v0.11.4 failure.
3. **No swallowed first tap.** `[LOGIN] Call ignored, a login already owns the flow` must appear
   **nowhere**: `isLoginInProgress` is one flag with two owners, and an entry point that does not
   release it before `loginImpl` makes every cold launch refuse its own automatic attempt -
   deterministic, not a race.
4. **The biometric session must persist its messages.** A biometric session used to run with an
   empty device key in the WebView, so nothing it received was written to SQLite and nothing already
   stored could be read. Expect zero `Failed to decrypt SQLite row`, one biometric prompt per login,
   and `MLS state loaded from mls.bin (native).` naming the right backend. The decisive line is
   `[HISTORY_BUNDLE] Full history sent: N message(s)` where N has **grown** by the messages received
   under biometrics: the bundle is built by reading the local store back with the device key, so a
   grown N proves the session both wrote and read. `[FCM_CACHE] Injection done: 1/1` confirms the
   same for the push cache.
5. **The PIN modal keeps its "use biometrics" button** when biometrics are enrolled. It derives that
   button from the same flag as the sheet, so if the sheet stops opening the button vanishes too.
6. **Disable** biometric unlock, relaunch, confirm the PIN is required and the keychain entry is
   really gone (the biometric sheet must not appear at all).

## H. Deep link from an OS notification tap - RE-OPENED on Android

**Proves** the WP-DEEPLINK-1 residual. The fix is verified on the web for the two link paths; the
notification tap could not be driven from a headless browser. It publishes to `notifNav` exactly like
the two verified paths.

**RUN IT TWICE - backgrounded, then from a KILLED app.** They are not the same code path and they
have never both worked: a running app receives the URL over the `onOpenUrl` *event*, a cold start has
to *ask* for it with `getCurrent()`, and only the second is gated by the Tauri capability file. The
grant was missing outright, so the cold start failed on every launch while the backgrounded case was
perfect — see
[`mobile.md`](frontend/mobile.md#how-a-deep-link-actually-reaches-the-app--two-paths-only-one-of-them-gated).
This is what the user reported on 2026-08-01 and what NOTIF-7 finally measured on 2026-08-07;
fixed in `916ed696`. **A pass on the backgrounded case alone proves nothing about the one users hit**,
which is a tap on a notification that woke them up.

1. Kill the app. Have the peer send a DM, then a channel message.
2. Tap each notification. Each must land in the right conversation, **not** merely the right tab.
3. Repeat with the app merely backgrounded (HOME, not killed).
4. **With the session dead** (sign in, delete the device's session server-side, kill the app), tap a
   POST push: the app must land on `/login?returnTo=%2Fpost%2F<id>` and, after signing in, on the post
   ([sessions](sessions.md#a-dead-session-sends-the-user-to-login-carrying-where-they-were-going-2026-10-09)).
   Read `[AUTH] Session expired - logging out and redirecting to /login?returnTo=...` in the log. A bare
   `/login` means the deep link never reached `goto` (then `[hooks] Processing URL` is absent too, and
   the fault is upstream of this fix: read `[hooks] launch URL read on attempt N`).

**Read the log, not just the screen.** This check was recorded PASS on v0.11.7 and the DM half was
broken the whole time: the tap does reach the right tab, and "right tab" is what a pass looks like
from across the room. Three lines, in order, and each one names the hop that failed if it is the
last one you see:

- `[notifNav] deep link received: fr.emse.canari://chat/<id> -> target <id>` - everything native
  worked (PendingIntent, `onNewIntent`, the deep-link plugin, `hooks.client.ts`). Absent: the
  failure is upstream of the product code, and none of the JS below ever ran. Split it further with
  `[hooks] Deep-link listener registered` (the WebView booted) and
  `[hooks] deep-link getCurrent() failed` (the cold-start path was refused - a capability gap, not a
  native one).
- `[notifNav] routing to /chat|/communities for pending conversation <id>` - only printed when a
  route change was actually needed.
- The thread on screen, with its history. A DM that lands and then empties is the landing being
  ended by its own selection - the group-id-vs-map-key bug fixed on 2026-08-01.

Remember `/c/<groupId>` and `/chat/<groupId>` are not routes: a conversation opens by publishing to
`notifNav`, and a channel target can only be opened on `/communities`.

## I. The enrolment sheet under a light theme

**Proves** the WP-UI-1 residual. The enrolment sheet reported DARK under a LIGHT theme. The `dark:`
variant is correct on web (verified by computed style in both themes), so the suspect is the native
runtime.

Set the phone to light mode, open the biometric enrolment sheet, and see whether it renders light.

## J. Outbox retry worker (short version)

**Proves** WP-VERIF-4 partially: that the worker wakes and drains. The three-failure branch (a
persistent flag plus a nudge notification) is deliberately **not** covered here - it needs the network
down long enough to exhaust the backoff.

1. Airplane mode on. Send a message. Close the app.
2. Airplane mode off. Wait ~1 minute.
3. The message must arrive without reopening the app.

**Verdict:** iOS schedules the work as `fr.emse.canari.outboxRetry` via `BGTaskScheduler`, which the
OS runs on its own schedule - so an **iOS failure here is inconclusive rather than a defect**. The
Android equivalent (tag `CanariOutboxRetry`) already passed and is not owed.

## K. The notification quick reply - owed on BOTH platforms

**Proves** WP-NOTIF-1 (a) and (b); K2 below proves (c). The reply always did send; what it left behind was nothing. It is
built natively and never becomes an outbox entry, and `reconcileOutboxSent` only ever DELETES, so
the sender's own conversation showed the reply nowhere. Both platforms now write the delivered reply
into `fcm_message_cache.ndjson` under OUR user id.

1. Kill the app. Have the peer send a DM.
2. Answer from the notification itself, **without opening the app**.
3. Confirm the peer receives it (`sendQueuedMessagePush: HTTP 201`, `1 sent, 0 remaining`).
4. **Reopen the app.** The reply must be in your own conversation - that is the half that was
   missing.
5. **Android only:** in the notification thread, your own avatar must be drawn, not a blank
   placeholder. (iOS has no self `Person`, so this half does not apply.)

**K2 - the UNDELIVERED reply, WP-NOTIF-1 (c).** This used to be listed here as out of scope; it is
fixed now, and it is the half most likely to still be wrong, because unlike (a) and (b) it has no
compile check worth the name - it is pure TS + Rust, so it built the moment it was written.

An undelivered reply lives only in `outbox_pending.ndjson`, and `store_outbox_mirror` rewrites that
file wholesale from the TS queue, which has never heard of it. `adoptOrphanedMirrorEntries` now runs
at login, before conversations load, and turns every unknown mirror line back into a real outbox
entry plus its local message.

1. Put the device in airplane mode, then have the peer send a DM (send it *before* going offline, or
   there is no notification to answer).
2. Answer from the notification. The drain must FAIL - the point is a reply that never left.
3. Reopen the app, still offline. The reply must be in your conversation, marked pending.
4. Restore the network. It must send on its own, without retyping it.

**Verdict lines:** `[OUTBOX_MIRROR]` adoption at login, then the ordinary `[OUTBOX]` flush. A silent
proto stays `control` and is sent verbatim with no push - that is intended, not a miss.

### Steps 1-4 MEASURED on A1 0.14.12, 2026-08-30 - the reported defect does NOT reproduce

**The report that the quick reply "does not work" is not true of this build.** The whole chain was
observed, and each of the three causes the [backlog](backlog.md) entry left open is eliminated by a
line rather than by an argument:

```
07:20:17  Start proc 17650:fr.emse.canari for broadcast {FirebaseInstanceIdReceiver}
07:25:46  CanariNotifAction: handleReply: queued id=45ae4d3c group=642f389a
07:25:46  CanariFCM: drainOutboxBackground: 1 message(s) queued, taking 1
07:25:50  CanariFCM: sendQueuedMessagePush: HTTP 201 group=642f389a msg=45ae4d3c
07:25:50  CanariFCM: drainOutboxBackground: 1 sent, 0 remaining
07:27:22  [OUTBOX_MIRROR] 1 entry/entries written
07:27:24  [OUTBOX_MIRROR] 1 background send(s) to reconcile
```

- **The app really was down.** The kill was `phone.killAndProveDead` (`deadInMs: 82`), and the only
  thing that restarted the process was the FCM broadcast itself - no `MainActivity`, no WebView, no
  WebSocket. That last part is what makes the rest mean anything.
- **The push decrypted in the background**: the shade carried the peer's display name and the
  message text, not one of `GENERIC_BODIES`, and `fcm_message_cache.ndjson` held the plaintext.
- **Step 4, the half that was missing, HOLDS.** Read on all three clients at once and without
  navigating any of them: the peer has the reply, and so does the phone's own conversation.
- **The native residue is clean afterwards**: `fcm_message_cache.ndjson` empty and no
  `outbox_pending.ndjson` at all, so the entry was adopted rather than stranded.

**PROVENANCE, BECAUSE IT DECIDES WHAT THIS IS WORTH.** The reply at 07:25:46 was typed by a PERSON on
the device, not by the harness - which is what this file's checks ask for, and why the row can be
taken at all. But it also means the run had no gate, no dirt classifier and no recorded ledger row:
**it is a MEASUREMENT, not a campaign verdict**, and NOTIF-6 on the board is not answered by it. Step
5 (the self avatar in the thread) was never looked at, and **K2 - the airplane-mode reply that must
NOT be delivered - is untouched and is still the half most likely to be wrong.**

### The BACKGROUNDED run that failed, and the defect it found

**A KILLED RUN IS THE BRANCH THAT HEALS THIS DEFECT, SO THE PASS ABOVE PROVED LESS THAN IT LOOKED.**
Re-run on 2026-08-30 with the app merely backgrounded - `am kill` never issued, process alive at
`proc=LAST`, `foregroundedAtSend: false` - the same reply on the same build, device and conversation
was refused:

```
07:55:57  CanariFCM: sendQueuedMessagePush: HTTP 201   <- app KILLED, fresh process
07:57     MainActivity resumed and unlocked -> /register mints a NEW secret,
          pending_push_secret.txt written (32 bytes, mtime 07:57)
07:59:30  CanariFCM: sendQueuedMessagePush: HTTP 403   <- app BACKGROUNDED, same process
```

The file was still sitting there unconsumed at 08:06, which per the code can only happen when the
Keystore answered first - with the previous process's secret, which `/register` had already
invalidated. Cause, fix and rules: [backlog](backlog.md), `CHANGELOG.md`,
[mobile](frontend/mobile.md), [durable-rules](durable-rules.md). Two further defects fell out of the
same branch: the `RemoteInput` spinner never ended (screenshot evidence: the action row was gone and
the reply text sat under a spinner eight minutes on), and no retry was ever scheduled.

**THE RE-MEASUREMENT IS OWED AND IS THE ONLY THING LEFT.** The fix is written, `assembleUniversalDebug`
is green and the APK is installed on A1 (`install -r`, data kept, 2026-08-30 08:16). It has never
been run. To re-arm the precondition - it is NOT ambient, and a run made without it proves nothing:

1. `adb shell input keyevent KEYCODE_HOME`, then `am kill fr.emse.canari`, and assert `pidof` is
   empty. **Never `force-stop`**, which puts the app in the STOPPED state and cancels every FCM
   broadcast.
2. `bun run.mjs --preflight A1` - it foregrounds, sends the app to `/chat` and unlocks the PIN.
   That unlock is what calls `/register` and writes the file.
3. **Assert the precondition is armed**: `run-as fr.emse.canari ls -l /data/data/fr.emse.canari/pending_push_secret.txt`
   must show 32 bytes. If the file is ABSENT the window is closed (a resume already migrated it) and
   the run measures nothing - go back to step 1. Use the PowerShell tool for this, never Bash, which
   rewrites the absolute device path.
4. `bun tools/cross-client-harness/archive/k.mjs`, then answer from the shade when it says to.
   **It is an atom now** - the `scratch/k-run.mjs` this line used to name never existed in the tree,
   which is the whole reason this re-measurement sat unmade for a week. It performs steps 1-3 itself
   and asserts each, so the only human part is the reply.

   **The backgrounded case CAN be answered since 2026-09-18**: the WebSocket trigger posts through the same Kotlin builder, so the shade carries `Repondre` there too ([mobile](frontend/mobile.md#notification-quick-actions-are-on-every-android-message-notification-whoever-posts-it-resolved-2026-09-18-audited-2026-10-10)). `k.mjs` still records `SKIPPED` rather than `FAIL` when no reply is made, so a run cannot be mistaken for a product verdict.
5. **Verdict lines:** `retrievePushSecret: newer secret adopted from pending_push_secret.txt -> Keystore`,
   then `sendQueuedMessagePush: HTTP 201`, then `1 sent, 0 remaining`. A `403` means the fix is
   wrong, not that the rig is.

One rig note, met twice: the adb daemon died mid-session and the preflight reported the PHONE
unreachable. `adb kill-server && adb start-server` fixes it, and it kills any background `logcat`
capture with it.

## L. A revoked device coming back - the dev panel

**Proves** WP-DEV-PANEL-1. The cause is known and fixed; only the recovery has never been seen run.
`registerDevice` never consulted the denylist, and `resolveDeviceId` restores the same id across
reinstalls on purpose - so a device deleted from the panel came back under its old id, got a 200,
and was then filtered out of `getUserDevices` and resolved to a null KeyPackage: enrolled, invisible,
never invitable, silent, forever. Registration now answers `403 DEVICE_REVOKED` and the client
re-enrols under a fresh identity.

1. On a second device, delete this device from the dev panel (or use one whose id was deleted
   earlier).
2. Relaunch the app on the deleted device and log in.

**Verdict:** `[MLS] Device <old> was revoked - re-enrolled as <new>`, then the panel lists the new
id and the device receives again. **It costs that device's local history, by design** - a new id IS
a new device, so do not run this on a device whose messages you want.

## M. A PDF preview, on Android

**Proves** WP-POST-DOC-2. Android is the platform that decides it: its WebView has no PDF engine,
which is the whole reason pdf.js was chosen over an `<iframe>`, and nothing in the compile or the
tests can tell you the canvas path works there.

The prod half of this is already fixed and **verified live on 2026-08-04**: nginx has no `.mjs` type,
so the worker was served as `application/octet-stream` and the module loader refused it. A `HEAD` on
`/_app/immutable/assets/pdf.worker.min.*.mjs` now answers `application/javascript`.

1. Open a post carrying a PDF: the first page must render full-width under the file row.
2. Open a chat message carrying a PDF: the same page must render in the 44 px icon square.

`ConversationMediaPanel` and `AssociationDocumentManager` show no preview on purpose - they list
files without fetching them - and a password-protected vault document cannot be decrypted without
its password at all. Neither is a failure.

**Step 2 PASSED on A1 0.13.0, 2026-08-06** (prod, PDF sent from W1). The rendered first page is an
`<img alt="Aperçu de la première page du document">` fed from a `blob:`, `naturalWidth` 116x116 in
a 44 px box - two of them, one per PDF sent. Logcat clean over the whole run.

Two traps this cost, both about ASSERTING the right thing rather than about the app. The preview is
an `<img>`, **not** a `<canvas>`: a check looking for a canvas reports FAIL on a surface that plainly
works, which only a screenshot caught. And a mounted `<img>` proves nothing on its own - a broken
picture keeps its `src` - so the assertion has to be `naturalWidth > 0`. Step 1 (a PDF in a POST) is
still owed.


## M-bis. Several documents in a post: compact rows, and the save that needs its own tap - owed on iPhone

**Proves** the compact document rows of [posts](frontend/modules/posts.md#several-documents-compact-rows-and-a-cap-of-ten-attachments-owner-2026-11-02).
A row fetches nothing until tapped, so a SAVE on an unfetched row is a download that finishes AFTER
the tap; the code therefore never saves from there - the row turns "Pret - touchez pour enregistrer"
and the save runs on a second tap, inside a gesture. Whether WKWebView (the iOS app) really accepts
that second tap, and whether a save started from the first one would have been refused, only the
iPhone 12 can say.

1. Post with three PDFs: three rows, no preview, no network request for the files (the log shows no
   `downloadAndDecrypt`).
2. Tap a row: a spinner, then the in-app reader opens. Tap another row while the first loads: ignored.
3. Tap a row's download button: spinner, then "Pret - touchez pour enregistrer"; tap it again: the
   share/save sheet appears and the file is the right one.
4. A post with one PDF still shows its first page and saves in one tap.
---

## N. Offline unlock and the promotion back - owed on BOTH platforms

**Proves** the offline-unlock work. Nothing in a compile or a unit test can answer it: the whole
feature is about what a real cold start does when `POST /api/auth/refresh` cannot leave the device,
and both the keystore read and the SQLite store behave differently on hardware than under jsdom.

Requires biometrics enrolled, or "rester connecté" on. **A PIN-only account is expected to FAIL to
unlock offline** - that is the designed behaviour, not a defect.

1. Sign in normally, exchange a few messages, then force-quit the app.
2. Enable flight mode. Launch the app.
3. The biometric prompt appears and the conversation list opens on the local history. Verdict line:
   `[LOGIN] Offline unlock (no token) - local session, will promote on reconnect.`
   The offline banner is visible. It must appear **fast** - the version gate is short-circuited
   offline, so if the launch hangs ~26 s before the prompt, that short-circuit is not working.
4. Send a message. It stays `pending`, and the log must NOT show flush attempts:
   `[OUTBOX] Flush skipped - offline; the queue is kept intact for the next reconnect.`
   Repeated `transient failure (attempt N)` lines here are a failure - the queue is burning its
   backoff against an absent network.
5. Disable flight mode. Expect, in order:
   `[PROMOTE] Access token acquired`, `[WS] Connected to Chat Gateway`, then the outbox draining.
   The message turns `sent`, the banner clears, and anything the peer sent meanwhile arrives.
6. **The session-death half**, which is the one worth being careful about: unlock offline as above,
   revoke that session from Réglages > Connexions actives on another device, then restore the
   network. Expect `[PROMOTE] Session expired while offline - signing out.` and a redirect to
   `/login` - then sign back in and confirm **the full local history is still there**. Losing it
   would mean the logout wiped the encrypted store, which it must not.

## O. The update target, and the blocking version gate - owed on Android

**Proves** WP-STORE-1. The optional nag modal is gone (the version now sits passively in
`/settings` > A propos), so `minClientVersion` is the only thing that can interrupt a user, and the
destination it offers is resolved at **run time** from `installer_package.txt` - a Kotlin writer,
then `get_installer_package`, then `appVersion.ts`. `buildUpdateTarget` and the cross-process
contract are unit-tested; three things are not, and cannot be.

1. **The Kotlin actually compiles.** A `workflow_dispatch` run of `android.yml` is the only
   real compile of `recordInstallerPackage`. Nothing local exercises it.
2. **The target follows the install source.** On a **Play-installed** build the blocking gate must
   offer the Play Store; on a **sideloaded CI APK** it must offer the APK. Capture the verdict line
   with `tools/android/verify-on-device.py`:
   `[appVersion] install source: ...`
   Both sides have to be seen - the two paths differ only in that one string.
3. **The gate itself.** In `/admin/platform`, raise `minClientVersion` above the running version,
   confirm the app blocks with a button leading to the right destination, and **reset it
   afterwards**.

**Do not raise `minClientVersion` on prod until a build is actually live on Play.** Raising it
before the rollout has reached devices locks everyone out behind a button that leads to the version
they already have.

## P. The refresh cookie surviving a kill - owed on iOS

**Proves** that the iOS half of WP-ANDROID-SESS-1 does not exist. On Android the WebView cookie jar
is written lazily, so a kill with no lifecycle callback restored a refresh token one rotation behind
the one already spent; presenting it is a replay, and the server correctly revoked the session. The
fix forces `CookieManager.flush()` at the moment of rotation.

**iOS has no equivalent, and that is not the same as not needing one.** `WKHTTPCookieStore` exposes
no flush API at all, so `flush_webview_cookies` is a no-op there — a fact about the API, not
evidence about the behaviour. A suspended app swiped out of the switcher is terminated without
`applicationWillTerminate`, which is precisely the shape that broke Android.

1. Sign in. Use the app long enough for at least one refresh (5 min at the current cadence), so the
   stored cookie is *not* the one issued at login.
2. Send the app to the background, wait for it to be suspended, then swipe it out of the switcher.
3. Relaunch. It must come back **signed in**, first try.
4. Repeat immediately: a session revoked by a replay looks fine for exactly one launch.

A failure here looks like the login screen, or the app appearing signed in with nothing in it — and
it is confirmed server-side by a `revokedReason` of replay on the session row. If it fails, the
remedy is not a flush call (there is none): it is to stop depending on the jar's durability, e.g.
mirroring the rotation into the keychain the way the device key already is.

## Q. The conversation list scrolls clear of the bottom nav - CLEARED 2026-08-26 (Pixel 6a)

Ran on a freshly built and installed universal debug APK (bundle `2a4297cb`, built 15:04:49Z), which
matters because a CSS reservation is exactly the kind of change a stale bundle hides. Kept because
**two of its four criteria did not follow from the mechanism and one of the four turned out to be a
dead instrument** - all three discovered by running it, and each would have returned a false verdict.

| # | Criterion | Result |
| --- | --- | --- |
| 1 | `scrollHeight > clientHeight` on the list | **796 > 744**, where it read `744 === 744` before |
| 2 | `paddingBottom` carries `4rem` + safe-area | **88px** = 64 + 24, so the reservation reached the bundle |
| 3 | Scrolled to the end, the last tile clears the nav | bottom **878 -> 826**, exactly the nav top; `elementFromPoint` returns the TILE |
| 4 | A real swipe moves the accessibility tree | **VOID - see below** |

Geometry checks out to the pixel: 698 px of tiles + 10 px top padding + 88 px reservation = 796.
`clientHeight` stayed 744, and the nav still sits topmost at the list's bottom edge - both as
predicted once the box model is read correctly, and both the reason the original criteria 1 and 3
were wrong (they asked for a shorter box and for the nav to stop being hit there; neither can happen).

**Criterion 4 is void, and this is the important finding.** A `Swipe-Tool` gesture demonstrably drives
the scroll - CDP read `scrollTop` 0 -> 52 -> 0 across a swipe up and a swipe back, the full range -
and the user confirmed it by hand. The accessibility tree reported **identical tile coordinates before
and after**, to the pixel. So the tree does not reflect an inner scroll container's offset in this
WebView, and the criterion cannot distinguish a working scroll from a broken one: it has now been
observed identical in BOTH states. **This retroactively voids the 2026-08-26 baseline inference that
"a device swipe moved the accessibility tree by zero pixels, confirming the defect"** - that was an
insensitive instrument, not evidence. The defect's real evidence was the geometry
(`scrollHeight === clientHeight`), which was sound. The witness to use instead is CDP-read
`scrollTop` across a real `Swipe-Tool` gesture, in both directions.

**The spinner half is half-established.** With the list at the top, a full pull-down raised **no
indicator at all** (a `MutationObserver` armed before the gesture saw zero insertions, so this does
not rest on CDP round-trip timing), which is what a live socket should produce. What was NOT
independently confirmed is that the socket was in fact up at that moment: the preflight had reported
A1 `OFFLINE` ten minutes earlier, right after the fresh install, and the UI showed no offline banner
by the time of the gesture. **A declined gesture is correct while connected and a DEFECT while
offline, so "no spinner" only means what the socket state says it means.** The offline direction -
spinner present, and persisting for the reconnect rather than a fixed 600 ms - is unrun. Worth one
pass with `net.mjs` the next time the phone is on the bench; it is not what the P1 was about.

## R. The shrunk release APK actually runs - owed on Android

**Proves** that enabling `isShrinkResources` and excluding `com.google.android.material` did not
remove something the app needs at run time. **Every Android gate in this repository misses both.**
The debug build type sets `isMinifyEnabled = false`, so a debug APK never runs R8 or the resource
shrinker at all; a green `assembleUniversalRelease` proves the shrinker did not crash, never that
what survived is enough; and `androidPlayRecommendations.test.ts` reads the two settings as text and
can say nothing about either outcome. Reasoning and the evidence behind each change are on
[mobile](frontend/mobile.md#the-release-builds-shape-and-what-google-plays-analysis-asked-of-it).

Test the **release** artifact from `android.yml`, not a local build: a locally re-signed
release cannot be installed over the existing app without an uninstall, and an uninstall costs a
re-enrolment. **IT DOES NOT COST A 2FA PROMPT, AND THE SENTENCE THAT SAID SO HELD THIS CHECK UP.**
The campaign's test accounts are Authentik service accounts reached through the "Connexion externe
(service-account)" link, and they carry no second factor; 2FA is a PRODUCTION-account property
(user, 2026-09-23). A session declined to start this check on the strength of the old wording, which
is the cost of a precondition nobody re-measured. **TWO signed artifacts now exist and the RELEASE one is the target:**
v0.14.5 of 2026-08-26 carries both Android fixes and went to Google Play production, so its attached
`app-universal-release.apk` (36 MB, beside the 15 MB `.aab`) is the build users actually got - test
THAT, and note a release asset does not expire. The `workflow_dispatch` of 2026-08-27 (run
`33024610295`, signal given, green in 12m37s) is a second, LATER build off `main` with the bun
backend migration in it, and it is kept ONLY as the run artifact `android-release` (29 MB),
**which expires 2026-11-24** - so it is not a thing to plan a device pass around.

That run also PROVED the gating rather than asserting it: `Upload to Release` and `Publish to Google
Play (production)` both **skipped**, because each is `if: github.event_name == 'workflow_run'`. A
dispatch therefore attaches nothing to any release, cannot overwrite v0.14.5's assets, and ships
nothing to users. Use one only to re-check a fix made after the release was cut.

**RUN 2026-09-23 ON THE SHIPPED `v0.18.21` ARTIFACT - FIVE OF SIX PASS, AND STEP 2 IS BLOCKED ON A
FIXTURE THAT DOES NOT EXIST RATHER THAN ON A DEFECT.** Measured on the Mi 9T against
`app-universal-release.apk` taken from the release itself. **Download it BY ASSET ID**: `gh release
download` and `gh release view --json assets` both read a representation that reports zero assets
minutes after a release is cut, and a session treated that as a regression in the release it had
just shipped; `gh api repos/{owner}/{repo}/releases/{id}/assets` is the authoritative list. The
artifact talks to PRODUCTION - that is what makes it the shipped build, and why the rig's estate
guard correctly refuses to grade a campaign row on it (`pin.mjs` said so, and was right).

| Step | Verdict | The evidence, and not the impression |
| --- | --- | --- |
| 1. own background | **PASS** | The APK's own resource table declares `() #fff9fbff` / `(night) #ff070b12`, the two colours this check names, so the assertion is LOSSLESS and not a pixel judgement. A screen recording of the cold launch holds `#060a12` for the first 500 ms - `#070B12` with one LSB of h.264 chroma loss per channel - before anything else drew. No grey flash. |
| 2. a face in the shade | **OWED, no longer blocked** | The fixture exists and the path answered on the DEBUG build (`decodeSampled: 512x512 -> inSampleSize=2`, `largeIcon=true`), 2026-09-24. What is left is the same run on `bun a1apk.mjs --release`, whose install costs the device. See below. |
| 3. French channels | **PASS** | All six survive R8 WITH their descriptions: `canari_messages` "Messages Canari", `canari_mentions` "Mentions Canari", `canari_calls` "Appels Canari", `canari_social` "Activite sociale Canari", `canari_reactions` "Reactions a vos messages", `canari_forms` "Rappels de formulaires". A seventh, `default`, is named **"Default"** in English - it is `tauri-plugin-notification`'s own hardcoded literal, created on plugin load in BOTH build types, and nothing posts to it. Library blemish, not a shrinking regression ([backlog](backlog.md)). |
| 4. both system bars | **PASS** | `env(safe-area-inset-top)` = `34px`, `env(safe-area-inset-bottom)` = `24px`, left/right `0px`, with `viewport-fit=cover` intact. At `devicePixelRatio` 2.475 that is 84 and 59 physical pixels, matching the status bar and the gesture bar on screen. |
| 5. picker, dialog, biometric | **PASS, all three** | File picker: `com.android.documentsui/.picker.PickActivity` became the top resumed activity on a real touch. Dialog: a `role=dialog` rendered with its French copy and both actions. **Biometric - the one that broke before**: `ActivityTaskManager: Displayed fr.emse.canari/app.tauri.biometric.BiometricActivity for user 0: +84ms`, no `InflateException`, the system `BiometricPrompt` bound its credential view and animated in, and dismissing it rejected the promise and returned to `MainActivity` with no crash. |
| 6. refuses a device transfer | **PASS** | `aapt2` on the artifact reads `android:allowBackup=false` AND `android:dataExtractionRules=@0x7f120000`, which resolves in the resource table to `xml/data_extraction_rules -> res/4j.xml`. The shrinker RENAMED the file but kept it, which is why an `unzip | grep data_extraction` finds nothing and reads as absent. `dumpsys` on Android 16 does not print the attribute at all, so the artifact is the only witness. |

**THE FIXTURE NOW EXISTS, MEASURED ON DEBUG 2026-09-24 - WHAT IS LEFT IS THE INSTALL.** The
paragraph below said no notification the campaign can trigger carries a bitmap. That is no longer
true, and the route it named as second is the one that worked: **an association created on the LOCAL
estate, with a logo uploaded through the app's own cropper**, which writes `logoMediaId` and makes
`/api/media/public/<id>` serve real bytes (`200 image/webp`, measured). Publishing as that
association announces to the whole feed audience through `PostAnnounceScheduler`'s minute tick, and
the phone answered with the line the step requires:

```
CanariFCM: onMessageReceived: type=social ...
CanariFCM: showSimpleNotification: type=social channel=canari_social title=<the association> a publie
CanariFCM: fetchPublicMediaIcon: cached for <media id>
CanariFCM: decodeSampled: 512x512 -> inSampleSize=2, target=158
CanariFCM: showSimpleNotification: notifId=10001 channel=canari_social largeIcon=true
```

**THE RECIPE, BECAUSE A FIXTURE THAT SURVIVES ONLY IN A CHAT HISTORY IS NOT A FIXTURE.** It lives
in the estate's database and object store, so a rebuilt local estate loses it and it is rebuilt like
this, all of it through the app's own code paths:

1. `update users set admin = true where id = <the peer's>` on the local Postgres - association
   creation is global-admin or BDE `MANAGE_ASSO`, and no local account had either.
2. As that account, `/associations/new` - name and slug only; the slug derives from the name.
3. `/associations/<slug>/edit`, "Changer le logo", stage `fixtures/msg4-image.png` on the cropper's
   `input[type=file]` (`attachFiles`), then "Utiliser cette image". This is the ONLY step that
   cannot be an API call: the cropper exports a `Blob` the upload takes.
4. Check the estate, not the screen: `logoMediaId` is set, and
   `curl -o /dev/null -w '%{http_code} %{content_type}' /api/media/public/<id>` answers
   `200 image/webp`.
5. Publish as the association from that client's own page - `apiPost(cx, '/api/posts',
   { associationId, markdown })`. The announce tick is `* * * * *`, so the push follows within a
   minute; `[ANNOUNCE] post=... kind=association recipients=N` in social-service's log says it went.

**A `[NOTIFY] association <id> pushes the actor's face, not its logo` warning means the fixture is
broken, not the app** - that line separates a logo nobody uploaded from a column that cannot be
read, and neither of them measures step 2.

**That run was on the DEBUG build, so it is not check R** - `isMinifyEnabled` is false there and
nothing was shrunk. It settles the FIXTURE and nothing else: the path is reachable, the bytes are
real, and the evidence line fires. Re-running it against `bun a1apk.mjs --release` is the whole of
what step 2 has left, and that install is what costs the device.

**AND THE FIRST ROUTE NAMED BELOW IS NOT AVAILABLE AT ALL.** "Giving a test account an avatar
server-side" cannot be done on any estate here: `users` has no avatar column, and
`/api/mls/push/avatar/:id` proxies core-service's `users/:id/avatar`, which fetches from
**MiGallery** - another repository's estate, keyed by the school's own photo directory. An account
without a photo there returns `absent`, and writing one is not a change this repository can make.
The association-logo caller is the only feeder a fixture can reach.

**WHY STEP 2 COULD NOT BE MEASURED ON 2026-09-23, AND WHAT UNBLOCKED IT.** The step needs a notification
carrying a real bitmap, because `decodeSampled` is the line that separates "the avatar arrived" from
"the fallback looked fine". Its ONLY feeder is `cachedRemoteIcon`, which has exactly two callers: a
user avatar and an association logo. **No test identity on any estate has an avatar image** - the
app renders initials for them - and **the frontend exposes no user-avatar upload anywhere**: every
`input[type=file]` in it belongs to association documents, the association logo cropper, a calendar
event, the chat composer, the form builder, post create/edit, the settings backup or the community
admin panel. So no notification the campaign is able to trigger can carry a bitmap, and the log line
is unreachable by construction. The association-logo path is reachable only by posting AS an
association on production, which publishes to real students and is therefore not a test. **Unblocking
it means giving a test account an avatar server-side**, or setting a logo on a test association on
the LOCAL estate and running step 2 against a release-configured APK built for that estate - the
minification is identical, so it measures the same R8 output ([backlog](backlog.md)).

**THE P1 THIS RUN FOUND - AND THE READING THAT LOOKED LIKE ITS PROOF AND WAS NOT.** The shipped
`v0.18.21` library compiles `setWebContentsDebuggingEnabled`, because the `devtools` Cargo feature
sat in plain `[dependencies]` and wry gates that call as
`#[cfg(any(debug_assertions, feature = "devtools"))]`; `tauri.conf.json` supplies its argument as
`true`. On an ordinary phone that is an inspectable WebView, and with it the MLS state, decrypted
message content and the access token the repository's rule keeps in memory *precisely* because
memory is supposed to be unreachable. **`open_devtools()` at `src/lib.rs` is correctly
`#[cfg(debug_assertions)]`-gated, which is why auditing that call site clears a release that is not
clear** - nothing opens a panel, and that was never the security property. The feature is removed in
`0.18.22`.

**THE PROOF IS THE BINARY, AND THE PHONE IS DISQUALIFIED FROM GIVING ONE.** `strings | grep -c` on
`lib/arm64-v8a/libmines_app_lib.so`: **1 in the shipped `v0.18.21` artifact, 0 in the new build**,
same architecture, same release profile, and 0 in `classes.dex` too. The runtime probe cannot
corroborate either half, and the reason is a property of the test device rather than of the app:
**the Mi 9T reports `ro.build.type=userdebug`, a ROM that enables WebView debugging for every
application on it.** Measured, not assumed - the new APK, which provably contains no enabler
anywhere, still opened `@webview_devtools_remote_<pid>` for its own pid. So the 2026-09-23 reading
that first raised this was TRUE and EMPTY: it would have appeared whatever the artifact contained.
**What is owed is the same `/proc/net/unix` probe on a `user`-build device**, which is the only kind
that can tell an app's own setting from the ROM's.

1. **The app starts on its own background, not grey.** `windowBackground` is now
   `@color/app_background`, so the gap before SvelteKit hydrates is `#070B12` dark / `#F9FBFF` light
   - the colour the page settles on, where it used to be the parent theme's `colorBackground`.
2. **A notification with a face still shows the face.** This is the only path that decodes an image,
   so a stripped class or resource surfaces here as the initials disc. Require both: a face in the
   shade, and `decodeSampled: <W>x<H> -> inSampleSize=<n>, target=<t>` in logcat - the log line is
   what separates "the avatar arrived" from "the fallback looked fine".
3. **The notification channels are still named in French.** Strings are the resources most exposed
   to shrinking, and a stripped `values/strings.xml` entry is invisible until someone opens the
   app's notification settings.
4. **The two system bars still have their gap.** The theme parent changed, so re-read
   `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` through CDP and require non-zero,
   as measured on 2026-08-07.
5. **A file picker, a dialog, AND THE BIOMETRIC PROMPT still open.** The claim under test is that
   nothing referenced the excluded library. **This step said "the only native UI this app has" and
   named two of three** - and the one it left out is the one that broke: `app.tauri.biometric`'s
   `auth_activity.xml` inflates an `androidx.coordinatorlayout` root that only
   `com.google.android.material` was carrying, so every biometric call died in the inflater. An
   enumeration of native UI is a claim about the whole app and must be derived from the LAYOUTS the
   dependencies ship, never from the Kotlin this repo wrote - a layout is a reference no source grep
   sees. Google Play reported the same crash from the field on versionCode 14005 on 2026-08-27,
   which is what [the vitals watch](../../tools/play-vitals/README.md) now reads.
6. **The installed package refuses a device transfer.** `adb shell dumpsys package fr.emse.canari`
   must show `dataExtractionRules` resolved, not just `allowBackup=false` - the attribute that does
   NOT cover device-to-device transfer on Android 12+. Asserting the merged manifest is what the
   build already proves; this asserts the artifact Play will actually ship.

**A debug pass covers none of this**, which is why this check is separate from Q - cleared on a
debug APK on 2026-08-26, on a build that by definition never ran R8.

## S. An iPhone obtaining a push token at all - RUN 2026-08-28, split verdict

**Proves** that the ordering fix of 2026-08-28 works, and it is the only thing that can: the call it
replaced compiled perfectly and could never succeed, so a green iOS build says nothing here.
Measured 2026-08-27, `push_token` held 49 `android` rows and had **never** held one `ios` row - no
alert, no mention and no CallKit ring had ever reached an iPhone. Mechanism on
[mobile](frontend/mobile.md#the-fcm-token-an-iphone-could-never-obtain-and-the-silence-that-hid-it-for-the-platforms-life).

**Steps.** Install the TestFlight build of 0.14.8 or later on the iPhone, sign in, and put the app in
the foreground once - `didBecomeActive` is the trigger, so a launch is enough. Then, from this
machine:

```
<ssh to the host> 'docker exec <prod postgres container> psql -U <db user> -d <db> -c "SELECT platform, count(*) FROM push_token GROUP BY platform"'
<ssh to the host> 'docker logs --since 30m <chat-delivery container> 2>&1 | grep PUSH_UNAVAILABLE'
```

**PASS** = an `ios` row exists. Then send the iPhone a message from another device with the app
killed, and confirm the alert arrives: the row proves registration, not delivery.

**A `[PUSH_UNAVAILABLE] ... platform=ios reason=no-token` line is NOT a pass, but it is not a
regression either** - it is the first time the platform has reported anything, and it says the
ordering was not the only broken link. The candidates left, and the device log that separates them,
are in [backlog](backlog.md) under the P1; `[CanariPush] APNs token not here yet` versus
`[CanariPush] FCM token synchronised` names the branch, and reading it needs `idevicesyslog` or a Mac.

**Neither answer arriving means the build did not reach the phone.** Check the version the device
runs before reading anything into the silence - TestFlight is the beta channel and an ordinary
install is not automatic.

### The run of 2026-08-28, 01:23 Paris - what it settled and what it did not

**Conditions, which matter because the first attempt was worthless.** A tester uninstalled and
reinstalled 0.14.8 from TestFlight (`REGISTER_DEVICE ... isNew=true` at 01:14:45, a device id never
seen before), in a window with no CD deploy running. An earlier attempt the same night was void:
five CD deploys landed between 00:40 and 00:52 and each restarts every container, so the logs that
would have carried a report were destroyed as they were written. **A hardware check and a push to
`main` are mutually exclusive, exactly as a campaign run is.**

**The half that PASSES.** At 01:23:39 the server printed, for the first time in the platform's life:

```
[PUSH_UNAVAILABLE] user=0acc3ab9... device=tauri-0acc3ab9...-mtc545la-ebnu platform=ios reason=no-token
```

The client classified its own failure, the server printed it unrewritten, and one `GROUP BY` now
answers a question that previously took a CORS incident to stumble into. The instrumentation is
verified on hardware, which is the only way it could be.

**The half that FAILS.** `reason=no-token` means `getFcmToken()` read nothing for four minutes:
the OS never handed this app an FCM token. **The ordering fix was necessary and is not sufficient** -
`push_token` still holds `android | 49` and no `ios` row.

**One inference made during the run and RETRACTED, recorded so it is not made again.** The device
reconnected its WebSocket 12 times in 15 minutes, each reconnection paired with a `REGISTER_DEVICE`,
and that was read as a full client re-initialisation which would reset the module-level
`pushAttempted` and prevent the four-minute ladder from ever completing. **It did complete**: the
ladder that reported started around 01:19:39 and ran straight through the events at 01:20:10,
01:21:36 and 01:22:36. So those events are socket and device-registration churn, not a teardown of
the JS context, and the module state survives them. Android shows the same churn (7 in 10 minutes).
Whether the churn itself is a defect is a separate question and is not evidence about push.

**What the next run must separate, and why it needed a build.** `reason=no-token` cannot say
WHETHER AN APNs TOKEN EVER ARRIVED, which is the fork the two candidates hung on. That fact is known
on the device and was written only to a console this machine cannot open.

#### The cause was then found without another run, and the re-run is what closes this

**Read the order, 2026-08-28.** `FIRMessaging.APNSToken` is set only by
`application:didRegisterForRemoteNotificationsWithDeviceToken:`, this app does not own its
`UIApplicationDelegate` (wry installs one inside `ffi::start_app()`), and Firebase's App Delegate
Proxy - the declared bridge - samples `sharedApplication.delegate` exactly once, at
`[FIRApp configure]`, which runs from `main()` before the application exists. It found nil and never
retried, so the APNs token had nowhere to land on every launch the platform has ever had. Full
account on
[mobile](frontend/mobile.md#the-apns-token-had-nowhere-to-land-because-the-proxy-meant-to-catch-it-installed-nothing).

**The re-run is therefore the proof, and it is worth stating what each outcome means** - everything
native here is verified by compiling, which proves nothing about running.

- An `ios` row in `push_token` closes the P1 outright.
- Another `[PUSH_UNAVAILABLE]` is no longer ambiguous: the reason now names which branch failed -
  `no-apns-token` (APNs still never answered, so look at entitlements, provisioning and the
  notification permission), `fcm-token-fetch-failed` (APNs answered and FCM refused),
  `apns-registration-refused` (the OS refused registration, a branch that previously had no observer
  at all) or `app-delegate-absent`. **None of the four is the cause just fixed**, so a repeat of
  `no-token` itself would mean the hook did not install and the log line
  `[CanariPush] APNs token hook installed on ...` is the thing to ask for.
- Run it in a QUIET WINDOW. The first attempt of 2026-08-28 was voided by five CD deploys in twelve
  minutes: a push to `main` restarts every container and destroys its logs, so a hardware check and a
  push are mutually exclusive, exactly as a campaign run is.

## T. The redirect URI an iOS build asks Authentik for - owed on iOS

**Proves** the fix for App Review's rejection of 2026-08-30 under guideline 2.1(a). **Precondition:**
a build carrying `tauri-plugin-os`; on anything older the check measures the defect, not the fix.

1. Fresh launch, then tap **Sign in**.
2. **The verdict is one log line**: `login returnTo=/chat uri=fr.emse.canari://callback`. Any `uri=`
   containing `tauri://localhost` is a FAIL and is exactly what App Review saw.
3. The login page must arrive in an `ASWebAuthenticationSession` sheet - it carries a Done button and
   names the `auth.canari-emse.fr` host above the page. The app's own view navigating to Authentik is
   the same FAIL wearing different clothes: it is the other half of the branch step 2 measures.
4. Finish the login. `/auth/callback` runs and the conversation list appears.

**Server-side, for a verdict that does not depend on reading the client's log:**
`<ssh to the host> 'docker logs <miconnect server container> --since 10m 2>&1 | grep -a authorize | tail -3'`
prints the request Authentik actually received - its `redirect_uri`, its `status` and the client's
`user_agent`.

**An iPhone settles this check for the iPad**, which is the one place in this file where hardware we
do not own is not owed a run of its own: `platform()` is a constant compiled into the iOS target, and
the iPad's only difference - its user agent - is no longer read by anything
([mobile](frontend/mobile.md#the-ipad-that-called-itself-a-macintosh-and-the-login-app-review-could-not-finish)).
It settles NOTHING about iPad layout, which nothing here has ever measured.

## U. The biometric cadence: every 12 h skips the sheet, every time keeps it - owed on BOTH platforms

**Proves** the cadence ([auth](frontend/modules/auth.md#how-often-the-sheet-comes-back---the-biometric-cadence-2026-09-28)).
**Precondition:** a build carrying `getKeyBytesUnattended`, biometrics enabled. Check G still holds
as written: enabling records no proof, so its first relaunch prompts under either cadence.

1. Default cadence (Settings > Security shows **Every 12 h** selected). Cold launch: the sheet
   appears, unlock. Expect `[BIOMETRIC] Prompt due (cadence=every_12h, lastPrompted=never)`.
2. Kill and relaunch within 12 h: **no sheet at all** - neither the OS prompt nor the in-app
   `BiometricBottomSheet` - and the conversation list appears. Expect `Prompt skipped` and, native
   side, `retrieve_device_key: unattended read (no biometric sheet)`. Check G's step 4 (messages
   persist) must hold on this session too: the key reached the frontend the same way.
3. Switch to **Every time**, kill, relaunch: the sheet is back on EVERY launch. On iOS this is the
   property the user most wanted kept - the read is `getKeyBytes`, the `.userPresence` item.
4. Back to **Every 12 h**, turn biometrics off then on: the cadence radio keeps **Every 12 h**, and
   the next launch prompts (forgetting dropped the proof).
5. From the PIN modal (cancel the sheet once), tap **use biometrics** while inside the window: the
   sheet MUST appear - that button never reads unattended.

**Android, Mi 9T, `c8e572070` against the local estate (2026-09-28): the cadence decisions all hold,
step 5 does not - and the defect behind it predates the cadence.** The phone has no enrolled finger,
so a PROMPTED read ends in `Authentication error: 11` and the PIN modal; the proof was seeded through
CDP (`canari_biometric_last_prompted_unlock_at`) rather than written by a real success, and the
Settings radio was not driven. Measured:

| Case | Log | Verdict |
| --- | --- | --- |
| no proof, every 12 h | `Prompt due (cadence=every_12h, lastPrompted=never)`, `getKeyBytes` | due, prompted |
| proof 1 min old | `Prompt skipped`, `unattended read (no biometric sheet)`, `getKeyBytesUnattended`, `MLS ready` | no sheet, list decrypted, 0 `Failed to decrypt SQLite` |
| message sent in that session, cold relaunch | same skipped path | the message is still there - the key wrote AND read the store |
| every time, proof 6 min old | `Prompt due (cadence=every_launch, ...)`, `getKeyBytes` | due, prompted |
| proof 13 h old | `Prompt due (... lastPrompted=780 min ago)` | due |
| proof 60 min in the FUTURE (clock set back) | `Prompt due (... lastPrompted=-60 min ago)` | due |
| step 5: the modal's button, fresh proof | `unattended=false`, then `[BIOMETRIC] Failed - no local user found.` | **FAILED**: never reached the keystore |
| step 5 again, on the fix (same day, uncommitted diff `112e8236036d` on `3d25f2d76`) | `unattended=false`, `getKeyBytes`, `keystore_empty` read off the typed code, 0 `Unrecognised state-load failure` | prompted - the sheet would appear |
| proof 1 min old, on the fix | same skipped path, `MLS ready` | no regression |

**Step 5 failed because a failed launch unlock forgot who the user is.** The catch of `loginImpl`
called `clearUserLocally()` on every failure, `keystore_empty` included, so the button that follows
found `currentUserId()` null and stopped before any read - with an English, non-Paraglide error.
Fixed the same day and shipped in `v0.18.28`: the catch forgets the identity on
`SessionExpiredError` only (a revoked device is already forgotten by `wipeRevokedDevice`), `mls-core`
throws a typed `KEYSTORE_KEY_UNAVAILABLE` instead of the sentence two call sites matched by regex,
and the English error became `auth_biometric_no_user`.
Still owed: a real finger (the proof written by a success), the Settings radio (step 4), and all of
iOS.

## V. The camera swipe on a fresh Feed after publishing - owed on Android

**Proves** [the modal that left the overlay stack](frontend/mobile.md#a-modal-closed-by-its-owners-state-left-the-overlay-stack-and-the-tab-swipe-stood-down-2026-10-09).
**Precondition:** a build carrying it, the Mi 9T, a signed-in account that may publish.

1. Open the Feed, publish a post from the composer (the modal closes by itself).
2. Immediately, with no other navigation, swipe right from the Feed: the camera must open, first time.
3. Repeat three times. The failure was 3 of 3 on the first load after publishing.

A refusal here means some OTHER overlay is still registered: read `historyOverlayStackDepth()` over CDP.

**`PASS` on the Mi 9T, `v1.2.6-alpha.1`, 2026-10-13, 4 of 4.** A post typed and published from the
header's "Publier" (the modal closed by itself 658-1099 ms after the click), then at once one
`adb input swipe 200 1200 1000 1200 180`: `/camera` every time. The swipe is injected, not a finger;
the same swipe opens the camera from a feed nobody published on. The bench posts were deleted
afterwards. Evidence: `<harness-dir>/a1-bench/r1013-owed/checkV*.json` and frames.

## iPad and rotation - owed on an iPad\n\nSwitching into Canari from another app does not rotate the window on an iPad (reported 2026-08-28); it needs an iPad. The Android phone rotation is decided and shipped: portrait under 600 dp, free on a tablet (`canari_lock_portrait`, [mobile](frontend/mobile.md#the-window-layout-the-keyboard-and-the-orientation-lock)).\n

## AS. Two accounts on one iPhone install: A -> B -> A -> B - owed on the iPhone 12 before the stable

**Proves** [one MLS state per account](frontend/modules/auth.md#one-mls-state-per-account-on-a-native-install-owner-decision-2026-11-02)
on the platform it was built for: every gate on it is a host test, and the switch, the App Group
copy the notification extension decrypts with and the activation mirror are native. **This is the
reading the per-account slot (#2919) owes before a stable carries it.** **Precondition:** a
pre-release carrying #2919 on the iPhone 12 bench phone, two bench accounts A and B where B has
never signed in on this install, a third device signed in as a third account with a DM to A and a
DM to B, and the device log (`tools/ios-device`) for the `[MLS_ACCOUNT]`, `[MLS]` and `[CanariPush]`
lines.

1. **A, then A -> B.** A signed in with a DM open. Sign out, sign in as B. Expect
   `slot selected for the signing-in account: Moved { parked_other: true, unparked: false }`,
   `slot state parked` and `the extension's copy of the previous account's state removed`.
   Background the app, then bring it back. Lock the phone; the third device writes to B - the
   notification shows the CONTENT. It writes to A - the notification shows no content, and nothing is
   written for A (no `[KG_PUSH_JOIN]` or state write naming A's account).
2. **B -> A.** Sign out, sign in as A. Expect `Moved { parked_other: true, unparked: true }`. A's
   history opens. The third device sends, A replies, the third device decrypts the reply. Lock the
   phone; a message for A shows its content.
3. **A -> B.** Sign out, sign in as B. B's DM continues where step 1 left it. Kill the app and
   relaunch it once: `[CanariPush] mirror to App Group done` appears, and no
   `[CanariPush] mirror mls.bin failed`.
4. **Reboot.** Unlock once, lock, the third device writes to B: the content shows.
4b. **B's "forgot PIN" leaves A intact.** With A having signed in last, sign in as B and take "forgot
   PIN" at B's PIN gate. Expect `[MLS_ACCOUNT] the PIN reset is staged` then `the PIN reset is
   committed`, and no `terminer_session_mls` with a sweep; A's state - parked under A's directory - has
   the same sha256 as before, and A then signs in with its history. With the network cut before the
   reset, expect `the PIN reset is rolled back` and B's old PIN still opening B's history.
4c. **An unproven state is never shown to a new account, and goes back to its owner.** On a SECOND
   install (or after steps 5-7 below are read: this step leaves A's state where steps 1-4 did not),
   install a build from before the owner record, sign A in, then install the pre-release over it (A's
   `mls.bin`, no `mls.owner`; at the first start expect `the account its push context names is marked
   as one a state opened for`, and NEVER `could not be seeded at start-up` nor `is created after
   start-up`). **Accepted residue, pre-1.3.0 installs only**: if the old build's last sign-in was B's
   (B used the phone after A and never wrote a state), the seed marks B, and B meets A's state once as
   the old-PIN refusal - A's state stays whole and A still opens it. Record which account the seed line
   names when the reading is taken. Sign in as B, who never signed in on this install, and MISTYPE B's PIN
   once before typing it right: expect `the slot's state of UNPROVEN owner set aside as
   unproven.residue-<n>` at B's sign-in, and B's PIN gate is B's
   ordinary one - "Créer mon PIN" when B has no PIN yet, "Déverrouiller" otherwise - which opens with
   B's own PIN on a fresh state. B never sees "Mon PIN a changé sur un autre appareil → Récupérer mes
   messages", nor any failure to open a saved state (round 6 offered B A's state, and B met it). Sign out,
   sign in as A: expect `a state of unproven owner set aside earlier is offered to the signing-in
   account`, A's history opens, and `mls.owner` names A.
4d. **B revoking the phone with A parked leaves A whole, and takes B's key.** With A parked and B signed
   in, note B's keystore alias (`<B's userId>_<B's deviceId>`, in `keystore_aliases.xml` on Android, the
   `[DEL-LOCAL]` lines on iOS). Remove this phone from B's device list on another device. Expect
   `another account's MLS state is on this install - only the revoked account is wiped` (or `other
   account(s) recorded`), never `wiping this device back to a fresh install`; then `[REVOKED-LOCAL] ...
   done` for B, and no `[DEL-LOCAL]` line about B (B was revoked, not deleted). Afterwards B's alias is ABSENT from the keystore (`BiometricService.isKeyPresent` false; on
   Android no `<B's alias>` entry), and the run holds ZERO `no keystore entry can be named` lines and
   ZERO `the revoked account's wipe did not finish` lines. A then signs in with its history, its PIN and
   its biometric unlock.
4e. **A reset cut by a reload, then an account switch** (rounds 9 to 11 of the review of #2919). At B's
   PIN gate take "forgot PIN", and kill the app the moment `the PIN reset is staged by document <n>`
   appears (before `committed`); relaunch online. Expect, before any unlock, `an unsettled PIN reset is
   adopted by document <m>` and then, from the server's answer, `the reset is committed` with the gate
   at once in "Créer mon PIN" (or `rolled back` when the server had not been reached, and B's old PIN
   opening B's history) - never a `.resetting` left behind, never B's old state unparked after a
   commit. Repeat with the phone OFFLINE at the relaunch: B's sign-in shows "La réinitialisation de
   votre PIN attend la réponse du serveur", logged `sign-in refused, as expected` at INFO; reconnect,
   retry, and the reset settles. Then sign out, sign in as A: A's history opens, its state's sha256
   unchanged; back to B: B's new PIN opens a fresh state. At every activation of this step note the
   `[MLS_ACCOUNT] activation mirror: waited N ms for the state lock, held it M ms` line - a reset holds
   the state lock, and a wait here is the one most likely to stall.
5. **The greps, over the whole run, each ZERO:** `TWO STATES`, `cut part-way`, `sign-in refused`,
   `superseded`, `not the push's account`, `a PIN reset was cut`, `committed PIN reset's removal was cut`, `no keystore entry can be named`,
   `wipe did not finish`, `[DEL-LOCAL]`, `after its erasure`. `residue` appears ONLY on step 4c's install (`UNPROVEN owner set aside as
   unproven.residue-<n>`), never on the install of steps 1-4.
6. **The files** (`xcrun devicectl device info files` on the app container and the App Group), on the
   install of steps 1-4, once step 4d ended with A signed in: NO 64-hex directory under
   `mls_accounts/` - A's state is in the slot again and B's went with its revoked wipe - and no
   `.parking`, `.unparking`, `.resetting`, `.committed` or `.residue-<n>` entry; `mls_accounts/unproven.declined`
   absent or empty (B's entry from 4b, if its reset committed, is pruned by the wipe of B);
   `mls.owner` in the slot names A; the App Group `mls.bin` has the same sha256 as the slot's.
7. **The mirror's cost:** between the two `didBecomeActive` mirror lines of one activation, under
   about 100 ms; and every `[MLS_ACCOUNT] activation mirror: waited N ms for the state lock, held it
   M ms` line of the run, both numbers noted - a wait in the hundreds of milliseconds is a main-thread
   stall behind a multi-megabyte write, and blocks the stable like step 5.

`sign-in refused` is expected ONLY as step 4e's offline `sign-in refused, as expected` (INFO).

**Any line of step 5, a missing content in steps 1-4, a key of B left in step 4d, or any directory or suffix in step 6 blocks the
stable.** The result goes into the [per-account backlog entry](plan.md#readings-owed).

## X. The scroll after an edge swipe - owed on the Mi 9T

**Proves or refutes** [the swallowed scroll](frontend/design-reference.md#41-the-system-back-gesture-takes-the-edge-touch-and-the-swipe-back-stayed-armed-mi-9t-2026-10-05):
adb-injected edge gestures may not behave as a finger, so this is a REAL-FINGER reading. **Precondition:**
a build carrying the `[swipeBack]` lines, gesture navigation on, a conversation with enough messages to scroll,
the page inspectable over CDP (console) or `logcat`.

1. Open the conversation, tap the text field, close the keyboard with the system back swipe from the
   left edge. Expect `[swipeBack] armed at x=<small>` then `[swipeBack] touch cancelled (tracking=true...)`
   and the conversation STILL open.
2. Immediately scroll the list from mid-screen with one finger. Does it move on the FIRST stroke?
3. Repeat the edge swipe, wait 3 s, then scroll. Then repeat with a scroll from the edge strip itself.
4. If the first stroke is swallowed with a `cancelled` line before it: it is the engine after a cancelled
   sequence, and the question moves to the WebView (record it, do not patch the page). If it is swallowed
   with NO `cancelled` line: the edge touch was not seen by the page at all.

## W. The composer stands still while the keyboard rises - owed on BOTH phones

**Proves** [the two stale numbers of a keyboard rise](frontend/modules/chat.md#every-keyboard-rise-moves-the-composer-for-a-moment-on-both-phones-measured-2026-10-02-fixed-2026-10-09-reading-owed).
Method of the original reading (#1345): over CDP, sample the composer's top
(`.chat-composer-footer`, `getBoundingClientRect().top`) every animation frame while tapping the
text field of an open conversation.

1. **Mi 9T**: the top goes from ~877 straight to ~532, with NO frame near 174 (it sat there 60-100 ms),
   and `visualViewport.height` never reads below `innerHeight` by a keyboard's worth.
2. **iPhone 12**: the top goes from 766 straight to ~487 pt, with NO ~400 ms plateau at 465, and the
   closed composer is where it always was (the pin is released on close).
3. Open and close the keyboard five times each: no frame outside the two resting positions.

**iPhone 12, `v1.2.3-alpha.5`, 2026-10-11: `FAIL` in a new shape, 3 of 3 rises.** The store build is
not inspectable, so the composer was read from WDA's MJPEG stream (~22 frames/s, a frame every 45 ms).
Step 2 holds: the composer goes from 766 to 487 pt with no plateau at 465, and a close goes back to
766 in one frame. Step 3 fails. The native "+" twin is at 487 in the first frame of the rise. The web
layer is not: for five or six frames (~250 ms) it is drawn about one keyboard height LOWER, then it
slides up. The web composer is hidden behind the rising keyboard, the "+" floats alone, and the dev
banner slides from y=333-353 pt up over the glass header. In points per frame: banner
333/282/204/117/72/60, composer 713/642/592/546/501/487. Frames:
`<harness-dir>/ios-bench/r1011/kbd2`, `kbd3`, and the contact sheets
`kbd2-contact*.png`.

**Mi 9T, `v1.2.6-alpha.1`, 2026-10-13: `PASS` with the system keyboard (AOSP LatinIME), 5 of 5
rises and 5 of 5 closes.** The composer's top goes from 869.5 straight to 524 CSS px in one frame
and back to 869.5 in one frame on close; no frame near 174 and no other resting position. The raw
double report is still there underneath: in 4 of 5 rises ONE frame reads `visualViewport.height`
230.3 against an `innerHeight` already at 588 (945 - 2 x 357), so step 1's second clause, read
literally, fails - and `computeSnapshot` absorbs it, which is the fix this check proves.
**A short keyboard escapes that guard.** The bench's ADB keyboard is 90 px tall, under the 160 px
`keyboardOpenThresholdPx`, so `layoutGaveUpKeyboard` is false and the double report is trusted: in
2 of 5 rises the composer spends one frame (~60 ms) at 702.1 before resting at 791.8, and in the
other 3 it spends 24 ms at 881.5. No real IME on this phone is that short; a floating or
one-row keyboard would be. Evidence: `<harness-dir>/a1-bench/r1013-owed/checkW-mi9t.json`
(the LatinIME run; the ADB-keyboard numbers above are the only record of that run).

**Two more steps, owed on the Mi 9T on the first build carrying the fix of 2026-10-29**
([the field that stays focused](frontend/modules/chat.md#a-field-that-stays-focused-with-the-keyboard-down-the-rise-that-covered-the-thread-and-the--that-raised-the-keyboard-2026-10-29)):

4. Open the keyboard in a long DM, put it away with Back, scroll up ~150-300 px, tap the text field:
   the thread goes to its last message above the composer (`[ChatArea] keyboard opened:
   follow-bottom`); on `1.5.1-alpha.7` it stayed put and the keyboard covered 345 px of it.
5. Open the keyboard, put it away with Back, tap "+": the menu, and NO keyboard. Then tap the field
   and "+" again: the menu over the keyboard, the keyboard still up.

## DT. A double tap likes a post - owed on BOTH phones

**Proves** [the double tap that likes](frontend/modules/posts.md#a-double-tap-likes-the-post-and-never-unlikes-it-2026-10-19)
on real fingers: every gate here dispatches synthetic `click`s, so whether WebKit and the Android
WebView deliver the two taps as two clicks with a `detail`, and nothing else, is read here only.
**Precondition:** a build carrying `doubleTapLike`, a bench account, a feed holding a text post, a
photo post, a poll post and a reel, none of them reacted to by the account; the console (CDP on the
Mi 9T, the in-app log on the iPhone) for the `[doubleTapLike] double tap` and
`[PostCard.doubleTap]` / `[reel-viewer] double tap` lines.

**When a double tap does NOT like, read what reached the page before suspecting anything** (DT-IOS,
2026-10-21: a native XCUITest double tap never liked on the iPhone, real W3C two-tap sequences did).
Each tap of the gesture logs `[doubleTapLike] press ended (touch)` and then `[doubleTapLike] click
(detail N, surface|opener|owned)`; a sequence under way that ended logs `sequence ended: <why>`.
Two `press ended` with no `click` after them is the engine's own double-tap recognizer swallowing
both clicks - the one case worth a detector change, and only once it is seen with a finger. No
`press ended` at all means the touches never reached the card (another layer took them).

1. **A reel, in the viewer**: open it, double tap the picture. Expect the heart at the finger, one
   `like` line, the controls ending as they started, the video still playing. Double tap again: the
   heart, an `already reacted, heart only` line, no request. Close: the card shows ❤️ as the reader's
   reaction. Single tap: the controls toggle AT ONCE (no wait).
2. **A reel card in the feed**: double tap it - liked, and the viewer does NOT open. Single tap it -
   the viewer opens after a beat (~250 ms) and, if sound was turned on in the app, plays WITH sound
   (the held tap is replayed from a timer: the user-activation question is the one thing reasoned
   rather than measured).
3. **A photo post**: double tap the picture - liked, no lightbox. Single tap - the lightbox opens.
4. **A text post**: double tap the text - liked, no word selected, the page did not zoom or slide
   to a neighbouring tab. A long press still selects the text.
5. **A poll option**: double tap an option - it votes / unvotes as two taps always did, and the post
   is NOT liked (no heart, no line).
6. **VoiceOver (iPhone) and TalkBack (Mi 9T) on**: the reaction button still likes ("Ajouter une
   réaction", then the heart in the picker); activating a photo opens the lightbox at once (no held tap); activating anything never
   likes the post. A two-finger or three-finger screen-reader gesture over a card likes nothing.
7. **Haptic**: the Mi 9T ticks on a like with vibrations on in the settings, and not with them off.
   The iPhone has no web vibration and is expected to stay still.

## Y. Watching a live - owed on BOTH phones (Mi 9T, iPhone 12)

**Proves** [the live viewer](frontend/modules/live.md#the-viewer-as-built-2026-10-19) in the app's
own WebViews, which no gate here runs: the tests drive fake MSE objects, and WP-L1 measured the
bench page, not this player. **Precondition:** a build carrying the viewer (`LIVE_ENABLED` is on
in every build since 2026-10-30; a dev pre-release until a stable carries it), a broadcaster sealing segments in [format v1](frontend/modules/live.md#the-segment-seal-format-v1)
(the app's own broadcaster on the other phone - run with [LIVE-B1](#live-b1-the-broadcaster-on-both-bench-phones---owed-on-both);
the WP-L1 bench's own `live-bench` seal reads "Live indisponible" here, by design), and the console over CDP or the WebKit bridge for the `[LIVE]` lines.

1. **Watch from the other phone.** Start a live on phone A; on phone B open the Feed: the LIVE card is
   at the top, naming A. Tap it: `[LIVE] viewer joined <id> at segment N`, then picture and sound
   (after one tap on the sound button), the LIVE badge and the time on air counting. Read
   glass-to-glass against WP-L1's 5.8-7.3 s p50 (clap in front of A's camera), expecting about 3 s
   more behind a Mi 9T that delivers in pairs. **The [buffer policy](frontend/modules/live.md#the-buffer-policy-l-f1-2026-10-27)
   (L-F1)**: watch two minutes with the Mi 9T as A; past the first delivery gap there is NO
   `stalled at` line and no run of `seek to the live edge (stall)`, and `waiting while seeking` lines
   are allowed (each is a seek's own wait). Record the `target buffer now N ms` the viewer settled on.
2. **Kill the network** on B for 20 s (airplane mode): "Reconnexion..." within a few polls, never
   "Live complet". Back online: `seek to the live edge (catch-up)` and the picture at the edge, not
   replaying the gap. Then kill A's network for 20 s: B says "Le live est interrompu, il devrait
   reprendre." and comes back by itself when A does.
3. **Rejoin**: close the viewer (X, then Android Back on a second try), reopen from the card. The
   server's seat count must not grow (`DELETE /api/lives/:id/seat` in the access log on close).
4. **The cap**: on dev, lower `LIVE_VIEWER_CAP` to 1 for the reading (an operator change on the dev
   estate, put back afterwards), watch from a browser, then open on B: "Live complet" with "Réessayer";
   close the browser viewer, tap "Réessayer" on B: it plays.
5. **Background and foreground** B for 10 s, then 40 s (past the 30 s seat lease): it comes back to
   the live edge, or to "Live complet" if the seat was taken meanwhile - never a frozen frame.
6. **The end**: end the live on A: B reads "Le live est terminé" within about a second, the video
   stops, and no further `[LIVE]` poll line follows.

Record per phone: the engine's MSE flavour (`MediaSource` on the Mi 9T, `ManagedMediaSource` on the
iPhone), any `append failed` or `did not open` line, and whether `endstreaming` from
`ManagedMediaSource` (ignored in v1) left the iPhone starved.

## VQ. Call video at 720p and its quality ladder - owed on BOTH phones (Mi 9T, iPhone 12)

**Proves** [the quality ladder](frontend/modules/calls.md#the-quality-ladder-2026-10-21---720p-and-an-automatic-drop)
where no gate here can: what a 720p VP8 encode COSTS a phone (CPU, heat, battery) and whether the
ladder drops on a real weak link and climbs back. The desktop rig measured only Chrome on a desktop
CPU, on loopback. **Precondition:** a dev pre-release carrying the ladder, a bench account on each
phone and a desktop profile (`bun tools/cross-client-harness/callpeer.mjs`), the phone screen kept on,
the phone at room temperature and above 50 % battery, unplugged during the heat runs (a charger heats it).
The procedure, the commands and the order are on the calls page, section "Measuring it on the
phones"; record each run's numbers in [device-readings-2026-10](device-readings-2026-10.md).

1. **The climb**: a video call from the desktop on a good Wi-Fi. Record the capture size the phone
   logs at the camera's opening (`[Call] camera captures WxH at F fps` - 720x1280 or 1280x720), that
   the ladder logged `starts on 480p30 (degradationPreference=unset)` and NOT
   `video quality ladder not started`. Within ~10 s the phone's log reads
   `video quality up 480p30 -> 720p30`, and `callpeer` prints the phone's picture at 1280x720 (or
   720x1280), ~30 fps, freezes 0. A call that goes through the TURN relay (the path line says
   `relay`) stays at `480p30` by design and is not a failed climb.
2. **The cost, 5 minutes per rung**: the CPU of the app's processes, the temperature and the battery
   drain at 720p, then at 480p (the calls page says how to hold a rung). The verdict is a number per
   rung, compared with an AUDIO call of the same length on the same phone.
3. **The drop**: throttle the phone's link (procedure on the calls page) during a call: a
   `video quality down` line within ~4 s of the throttle, naming its evidence; the screen shows "Votre
   vidéo est envoyée en qualité réduite" once the ladder is at 360p15 or below; the call never freezes
   for longer than the drop. Lift the throttle: the ladder climbs back one rung per ~8 s.
4. **The CPU drop**: on the iPhone, where VP8 is software only, read `limit=` on the
   `video ... send=` line through a 5-minute 720p call: a `video quality down ... limit=cpu ... enc=NN%`
   line is the iPhone saying 720p is too much (the ladder drops on `cpu` only with the encoder busy
   half the time), and the reading records it; after such a drop, the ladder must hold the lower rung
   rather than walk further down while `limit=cpu` lingers.

## CR. The composer's camera films a CanaReel - owed on BOTH phones

**Proves** [one camera, one behaviour](frontend/modules/reels.md#the-two-ways-into-the-camera-publish-the-same-thing-2026-10-19)
on real hardware: every gate here replaces the camera, the recorder and the server, so whether the
overlay, the publish step and the composer's modal hand over cleanly (history entries, the native
chrome on iOS, the keyboard) is read here only. **Precondition:** a pre-release carrying it, a bench
account, the console (CDP on the Mi 9T, the in-app log on the iPhone) for the `[reel-capture]`,
`[reel-publish]` and `[POST_COMPOSER]` lines.

1. **"+" -> new post**, type a line of text, "Ouvrir la caméra", HOLD the shutter ~3 s. Expect the
   review, then "Suivant" opens "Nouveau CanaReel" with the amber line "CanaReel : supprimé au bout
   de 30 jours..." ABOVE the identity, and the text as the caption.
2. **"Publier"**: the toast "CanaReel publié", the camera AND the composer gone, the feed under it
   showing the reel as a 9:16 card that opens the reel viewer. Reopen "+": the text is NOT offered
   again. The server row is `kind='reel'` with `durationMs` (the same as a reel filmed from the tab).
3. **Again, but "Garder comme post"**: back in the composer with the video attached and the text
   intact; "Publier" makes an ordinary post (the file's ratio, the media viewer).
4. **A TAP in the composer's camera** (a photo): "Ajouter" attaches it to the composer, no publish step.
5. **"Photo/vidéo" -> a gallery video**: attached to the composer, published as a post, never a reel.
6. **Edit an existing post -> its camera -> HOLD**: "Ajouter" attaches the video; no publish step.
7. **Back / the edge swipe** from the publish step returns to the take, a second one asks to discard
   it, a third closes the camera onto the composer (iPhone: the native tab bar and chrome stay hidden
   while the camera is up).
8. **Back DURING the upload** (a 60 s take on a throttled network, on the tab AND from "+"): nothing
   happens, the back arrow is greyed, `Back refused: the publish is past its upload` in the log, and
   ONE reel appears. The screen reader (VoiceOver / TalkBack) reads the 30-day notice first when the
   step opens from "+".
9. **A poll (or a schedule) switched on in the new post, then the camera, HOLD**: "Ajouter" attaches
   the video to that post; no publish step. "Garder comme post" after editing the caption and
   choosing "Anonyme" in the step: the composer shows the edited text and "Anonyme"; publishing it
   lands on the "Tout" feed.

## RV. Every vertical video of 90 s or less is a CanaReel, kept a year - owed on BOTH phones

**Proves** [the rule of 2026-11-09](frontend/modules/reels.md#the-rule-every-vertical-video-of-90-s-or-less-is-a-canareel-owner-2026-11-09)
on real hardware: the gates replace the decoder, so whether `videoWidth`/`videoHeight` honour a
phone video's rotation tag (an Android portrait clip is often stored 1920x1080 + 90 degrees) and
whether the prepared frame comes out vertical is read here only. **Supersedes CR steps 3, 5 and 9's
"Garder comme post"** (the button is gone). **Precondition:** a pre-release carrying it on an estate
serving `maxAspectRatio`, a bench account, the console for `[PUBLISH-QUEUE]`, `[reel-capture]`,
`[reel-publish]` and `[reel-rule]`.

1. **"+" -> new post -> "Photo/vidéo" -> a PORTRAIT gallery video under 90 s** (one filmed upright
   with the system camera), a caption, "Publier": the log says `one video 720x1280, N ms: a
   CanaReel`; the feed shows a reel card that opens the reel pager; `my-reels` lists it with an
   `expiresAt` a year out.
2. **The same with a LANDSCAPE video, then a 2-minute portrait video**: `a post` in the log, an
   ordinary post video.
3. **A portrait video PLUS a photo, or with a poll**: a post.
4. **The CanaReels tab -> gallery -> a landscape video**: the toast "Un CanaReel est une vidéo
   verticale...", no review. A portrait one reaches the review and publishes as a reel.
5. **The composer's camera, HOLD**: the step shows "Une vidéo verticale de 90 secondes au plus est
   un CanaReel : supprimé au bout de 1 an" and NO "Garder comme post"; the tab's step reads "Visible
   1 an...".

## RR. The CanaReels rail, the comments sheet and the photo pages - owed on BOTH phones

**Proves** [the rail, the sheet and the photo pages](frontend/modules/reels.md#the-rail-the-comments-sheet-and-the-photo-pages-user-2026-10-19-instagrams-reels)
on real fingers and a real keyboard: every gate here is jsdom, which has no layout, no keyboard
and no WebView. **Precondition:** a build carrying `ReelActionRail` against a social-service
carrying `multiMedia`, a bench account, at least two reels and one post of exactly one photo;
the console (CDP on the Mi 9T, the in-app log on the iPhone) for the `[reel-viewer]` and
`[reel-comments]` lines.

1. **The rail**: open CanaReels. Expect heart, comments and send bottom-right over every page, with
   their numbers, clear of the caption and of the player's bar, at 1x and at 200 % text.
2. **The heart**: tap it - filled, the count +1, one `heart ... like` line; tap again - empty, a
   `take back` line. A double tap on the rail likes nothing more (no burst at the finger). On a
   post the account reacted to with 😂 (from the card's picker), the rail shows 😂, not a heart.
   Two fast taps on a slow network send one request (`in flight, ignored` line).
   The comments number matches the card's on a post of more than twenty comments.
3. **The sheet**: tap comments - the sheet rises over the lower ~60 %, the reel keeps playing above.
   Type a comment: the keyboard does not cover the field. Send it; close the viewer - the card shows
   it. Close the sheet each way: drag the grabber down, Back (the viewer stays open), tap the reel
   above, the X. A swipe over the list scrolls it and does not close the sheet.
4. **Report a comment from the sheet**: the reason dialog is drawn ABOVE the viewer.
5. **Send**: a toast says the link is copied; the clipboard holds `/posts/<id>`.
6. **Photo pages**: the one-photo post appears among the reels as a page, its picture whole, no
   player bar, the caption lower, the same rail. A post of two photos never appears.
7. **VoiceOver / TalkBack**: the rail reads "J'aime, N réactions", "Commentaires, N commentaires",
   "Partager"; the sheet takes the focus on open and gives it back to the comments button on close.
8. **Desktop wheel** (a browser on a desktop, a mouse, then a trackpad): one wheel notch down is
   the next reel, up the previous; a hard spin of a free-spinning wheel and a trackpad flick each
   turn ONE page (`[reel-viewer] wheel` once per gesture); ctrl+wheel zooms the page and does not
   turn it; with the comments sheet open the wheel scrolls the list; over an unfolded caption it
   scrolls the caption.

## LA. Read state follows the iPhone leaving and coming back - owed on the iPhone 12 (step 7 on the Mi 9T)

**ANY FAILURE HERE BLOCKS THE STABLE** that carries the iOS read-lifecycle fix (the follow-up to
#2937). The fix is verified by compiling and by the source contract
(`utils/appForeground.contract.test.ts`) only. Whether iOS delivers the background/foreground pair
to the shell, and whether the page hears it, is read here and nowhere else
([chat](frontend/modules/chat.md#read-state-between-devices---the-census-2026-11-02)).
**Precondition:** a pre-release carrying it on TestFlight, a second device of the SAME account (a web
tab), and a peer account that writes to it. The in-app log must be open to read the `[FOREGROUND]` (page)
and `[CanariIOS]` (shell) lines.

1. **The page hears both edges.** Open a conversation, press Home, come back. Expect one
   `[FOREGROUND] app in the background` and one `... back in the foreground` per transition, and no
   `[CanariIOS] ERROR foreground=... not published` line.
2. **A system sheet is not leaving.** On the open conversation, pull down Control Centre, then trigger
   the Face ID sheet (lock the app if biometrics are on, or open a biometric-gated setting). Expect NO
   foreground edge. A message the peer sends while the sheet is up is marked read once it closes,
   with no change to how the mark leaves.
3. **A frame that lands while the app is in the background is NOT read.** Press Home, and have the peer send a message
   within 5 s. Expect the list badge to show 1 on the web tab of the same account, and no "Vu" on the
   peer. Come back to the conversation: the mark leaves (the badge falls to 0 on the web tab, "Vu" on
   the peer).
4. **The badge after a resume.** Leave the iPhone on another conversation, read the first one on the web tab,
   come back. The iPhone's badge for it is 0 without a reload.
5. **A notification for Y does not read X.** Open conversation X, press Home, and have the peer
   send a message in X and then one in Y. Tap Y's notification. Expect, in the device console, the
   app to show Y; on the web tab of the same account X keeps its badge and the peer shows no "Vu" in
   X; Y falls to 0. **THE ONE ORDERING RULE: the tap line (`[CanariIOS] notification tap during a
   resume (...)`) comes BEFORE `round trip answered: publishing the foreground edge (opening: yes)`.**
   Its `state` and `resumePending` values may be anything the shell accepted (a tap delivered after
   `didBecomeActive` logs `state=0`), and it may come before or after `didBecomeActive: awaiting the
   notification-center round trip`. A tap line AFTER `round trip answered`, or `opening: no` on that
   line, refutes the ordering argument the shell rests on - LIKELY, never proven, until this is read;
   step 8 applies the same rule to the page's own notification.
6. **A plain resume still reads X.** Repeat step 5, but open the app from its icon: X is marked
   read (the web tab drops X's badge, "Vu" in X on the peer).
7. **The same on the Mi 9T** (the Android half, #2937): steps 5 and 6 with the app on X, tapping Y's
   notification - X keeps its badge, Y is read; from the launcher X is read. The logcat shows
   `onResume: opens a link=true` for the tap.
8. **A notification the page raised itself (iPhone).** Open X and press Home FIRST; THEN, within the
   few seconds before iOS suspends the page, have the peer send a message in Y - the page, still
   running but off screen, raises its own notification for it (the push for the same message is then
   suppressed). Tap it. Expect `notification tap during a resume` and `notification tap on a page
   notification - handed to the plugin` BEFORE `round trip answered: publishing the foreground edge
   (opening: yes)` (step 5's one rule, any `state` or `resumePending`); Y opens, X keeps its badge.
9. **A tap on X's OWN notification, X a DM.** Open DM X, press Home, have the peer send a message in
   X, tap its notification: X is marked read AT ONCE (the web tab drops X's badge, "Vu" on the peer)
   - the hold must recognise its own conversation although the link names a group id and the
   selection a map key.
10. **A tap on a notification while the app is already in the foreground.** On X, with the app open,
   let a banner for Y appear and tap it: `notification tap on an active app - not a resume, nothing
   held`, Y opens and is read; X was read while it was on screen, as before.

## LF. A read reaches the other devices when the iPhone leaves the app - owed on the iPhone 12

**ANY FAILURE HERE BLOCKS THE STABLE** that carries the iOS read-lifecycle fix. **This reading
also decides the next step**: if the hold begins and then EXPIRES with no settle, the WebContent
process was suspended under the task, and the delivery moves native, as designed in
[chat](frontend/modules/chat.md#read-state-between-devices---the-census-2026-11-02). **Precondition:** as
for LA, plus the Xcode device console (or Console.app) filtered on `leave flush` (the `[CanariPush]` lines).

1. **Online.** Have the peer send a message. Open the conversation on the iPhone and press Home within
   ONE second, inside the 2 s debounce. Expect, in order: `[CanariPush] leave flush N begun`, the
   mark's send, then `leave flush N ended: done`, and NO `ERROR leave flush` line. The web tab of the same
   account shows the conversation as read and the peer shows "Vu" WITHOUT the iPhone being opened
   again. Repeat 5 times: all 5 must pass.
2. **Offline.** Switch on aeroplane mode, open a fresh unread conversation, and press Home within one second.
   Expect the begin, then either `ended: failed` or, if the send hangs until iOS's deadline, the
   expiration logged as an ERROR by the shell. That ERROR is expected here and nowhere else. Then switch
   aeroplane mode off and open the app: the owed mark leaves at once (the web tab drops the badge).
3. **Off iOS nothing changed.** On the Mi 9T, repeat step 1: there is no `leave flush` line, and the mark leaves
   as before.

## CKS. The checkpoint-skip switch on dev - owed on BOTH phones before the flip

**THE SWITCH STAYS `off` IN PRODUCTION UNTIL BOTH READINGS PASS ON BOTH PHONES** (the Mi 9T and the
iPhone 12). WP-CHECKPOINT-SKIP was built on 2026-11-07 behind `platform_config.checkpoint_skip_mode`
(core migration 020): with it `on`, a live drain that only received application frames leaves its
MLS checkpoint to the next send, commit, background edge or logout, until 100 receive generations are
unsaved. The decision, the measurement of 2026-10-22 and what it left uncovered are in
[open-questions](open-questions.md#decided-2026-11-07-lead-owners-delegation-build-with-k100-behind-checkpoint_skip_mode-off-flip-after-the-dev-readings-below).
What is read here is the two cases that measurement did not cover.

**Precondition - NOT ambient, assert each line:**

- A pre-release carrying the switch serves dev (`GET https://dev.canari-emse.fr/api/version` answers
  a `checkpointSkip` field) and is installed on the phone (Mi 9T: the release APK or the Play tester
  build; iPhone 12: TestFlight). A bench debug build is not needed.
- **The switch is `on` on dev**: as `canari-test-gamma` (dev's global admin) at `/admin/platform`,
  "Sauvegarde de l'état de chiffrement après réception" -> "Différée", saved; then
  `/api/version` answers `"checkpointSkip":{"mode":"on"}`.
- **The phone heard it**: a running session re-reads the mode only at its next version check,
  which focus, coming back online and visibility trigger (there is no periodic refresh), and only a
  LIVE answer counts, never the cached one. After a relaunch (or a return to the foreground), the
  in-app log carries
  `[MLS] Checkpoint skip ON: live receive-only drains defer their checkpoint while fewer than 100
  receive generations are unsaved`. Without that line the run is a control, not a reading.
- A DM between the phone's bench account and a peer driven from the harness Chrome, which sends
  NUMBERED messages (`live-1`, `dead-1`, ...) so a gap or a duplicate is read off the conversation.
- The phone's in-app log open afterwards (the summary and the reload lines go through it; the
  per-drain `checkpoint deferred ...` line is a debug line, read only in a debug build's console).

**CKS-1. A kill DURING a drain of more than K frames.**

1. Phone open on the feed (NOT the DM, so the drain is the only reader). The peer sends `live-1` ..
   `live-10`; the phone receives them and writes no checkpoint line for them (they are deferred).
2. Kill the app: Mi 9T `adb shell am force-stop fr.emse.canari`; iPhone, swipe it away in the app
   switcher.
3. The peer sends `dead-1` .. `dead-300` while the phone is dead.
4. Relaunch and unlock, and kill the app again while the catch-up drain runs - the first time right
   after the unlock, the second time a second or two later, the third time just after the in-app log
   shows `Encrypted state checkpoint persisted. Covers ...` (the drain reached K = 100 and
   checkpointed). Three kills, three relaunches.
5. Relaunch, unlock, wait for the list to settle, open the DM.

**Expect:** every one of the 310 messages exactly once, in order; in the log no `live-ahead`, no
`unreadable for good`, no duplicate row, and at least one `Covers N receive generations left by M
skipped drains` line. A message missing, doubled or unreadable is a FAIL.

**CKS-2. A phone away for HOURS with traffic** - two runs, because they take two different paths.

- **(a) Killed.** Phone open on the feed; the peer sends `live-1` .. `live-20` (deferred). Mi 9T:
  `adb shell input keyevent KEYCODE_HOME`, then `adb shell am kill fr.emse.canari` and assert
  `pidof` is empty - **never `force-stop` here**, which cancels every FCM broadcast and so takes the
  background engine out of the run; iPhone: swipe it away.
- **(b) Backgrounded, not killed** (the native resume reload, the path that can say `live-ahead`).
  Same start, then only Home - the process stays alive.

For each run, over AT LEAST THREE HOURS the peer sends one numbered message every ~15 minutes and,
once in the middle, a burst of 50. Write down every notification the phone shows. The background
engine decrypts each push READ-ONLY from `mls.bin`, which is behind by the deferred generations, and
never writes it (the one background write, a staged Welcome, is refused while the app runs:
`foreground-active` / `warm-process` in `prepare_welcome_background_with_key`,
`mobile/background.rs`). Then open the app, unlock, open the DM.

**Expect:** every message exactly once, in order; every notification shown matches a message in the
DM; no `unreadable for good`, no duplicate. What this targets: that a push decrypted from a file
behind by up to 99 generations still shows its text, and, in run (b), that the resume reload says
`live-ahead` (expected with deferred generations: the live state is persisted over the file,
`TauriMlsService.reloadStateFromDisk`, which discards nothing since the engine never wrote it) and
keeps every message. A missing message, or a notification that could not be read, is a FAIL.

**After the run:** the verdict, the build, the phone and the counts go into a row here and into
[the question](open-questions.md#the-readings-owed-before-the-flip). Any FAIL: the switch goes back
to `off` on dev at once and the question is reopened. Both readings passing on both phones: the lead
flips production at `/admin/platform` and says so.

## The iPhone 12 owed-readings inventory (2026-10-11)

Every reading the wiki, the backlog, `CLAUDE.md` and the pull requests of 2026-10-09 to 2026-10-11
owe the iPhone, classified against the build on the bench that day: TestFlight `1.2.3 (100200305)`,
which is `v1.2.3-alpha.5`, signed *TestFlight Beta Distribution* (aps `production`, no
`get-task-allow`, so NOT inspectable and no app log in the syslog), on `dev.canari-emse.fr`, signed
in through "Connexion externe (service-account)" as `canari-test-gamma`. Driven with
`tools/ios-device/ios.mjs` over WDA, timed from WDA's MJPEG stream on port 9100. Evidence:
`<harness-dir>/ios-bench/r1011/`. **Delete a row when its reading is taken on
the build it names.**

| Reading owed | Source | Status on 2026-10-11 |
| --- | --- | --- |
| #1370 camera letterbox: 20+ opens, both lenses, a home-and-return | backlog verification table | **`PASS` front lens, rear NOT READ.** 22 opens, 8 lens flips, 2 home-and-returns: every front-lens preview full-bleed (0 dark columns, 3 dark rows: the status band). The rear lens faced the table, so its frame was black, with the torch button drawn. Owed: the rear half with the phone held up |
| #1605 "Ouvrir dans l'application" on the login page | backlog | **`PASS` (iPhone half).** `canari.emse.fr/login` in Safari shows the link (dev correctly has none: `MOBILE_APP_LINK_HOSTS`), Safari asks "Ouvrir dans Canari ?", the app comes up on `/chat`. Android half still owed |
| Liquid glass chrome: alignment, keyboard, "+" > Photos, the four names | backlog, the Liquid Glass section | **alignment, picker and names `PASS`**: back, title pill and menu share one centre line, and the pill is centred at x=195. "+" opens Photothèque / Appareil photo / Tous les fichiers / Envoyer un GIF, and Photothèque opens ONE system picker. The AX names (the ones VoiceOver speaks): "Retour au menu", "Paramètres du groupe", "Plus d'actions", "Ajouter". **Keyboard: see W** |
| W, the composer during a keyboard rise | check W | **`FAIL`, new shape**: [W above](#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones) |
| Emoji rows 1, 3, 12 (the iPhone, where the font never drew) | [emoji](frontend/emoji.md#what-a-future-campaign-owes---the-twelve-rows-moved-from-the-backlog-2026-10-08) | **`PASS` by eye, in part**: a flag, a ZWJ family and a skin-toned thumb are ONE picture each in the composer, with the caret after them. One Backspace removes the toned thumb whole. The sent bubble draws the flag and the family as pictures. `naturalWidth` (row 1) needs the DOM; a paste and an IME commit were not read |
| `/posts` and associations scroll (first iOS feedback) | backlog, "The first iOS feedback" | **`PASS` on the BENCH iPhone**: three flicks on the associations list, momentum in 41 of 113 frames, the list moves 0 to 12 members down. The reading owed is on the REPORTING iPhone, which this is not |
| Section navigation on the phone (profile hub, breadcrumb) | CLAUDE.md queue item 0 | **`PASS`**: Mon profil > Cotisations et achats shows the crumb and "Retour : Mon profil", and the crumb goes back. A synthetic edge swipe did NOT go back on that page (not a verdict: whether the edge swipe applies there is not written down) |
| An attachment over 1 MiB on dev (WP-S1 #1708, #1710 on iOS) | backlog Cloudflare P1, offline section | **sent**: a 5 s gallery video in a one-member group read "Message envoyé" in ~2 s. Its size was NOT measured, and the server log read was refused to the agent, so this does not close the 1 MiB question |
| #1604, no PIN prompt after a later sign-in | backlog | **BLOCKED** by the P3 "switching accounts on one iPhone install makes the local store unreadable", which this session met again (below) |
| #1536 / #1548 reaction toast, send path, reply context | backlog | **BLOCKED**: no peer that the dev service account may discover |
| NOTIF-18 (NSE on a silent frame), the iPhone salon banner, a push carrying its ciphertext once, the iOS reaction stack, mention names, check B/C/K on iOS | backlog, notification sections | **Not read that day**: dev could not send a push then (Firebase not initialised in `canari-dev-chat-delivery-service`; superseded 2026-11-14: it sends since 2026-10-21, and a TestFlight pre-release, which talks to dev, receives them) |
| Check U (biometric cadence, all of iOS) | check U | **BLOCKED**: needs an enrolled face |
| The iOS launch logo (#1289): delete, RESTART, reinstall | backlog | **not taken**: a restart kills the WDA runner the session depends on. Owed in a session that can re-arm `wda-daemon.py` |
| The window bars (status bar, home indicator) with the glass chrome | backlog, iOS window layout | **screenshots for the user's look** in `r1011/` (`17-group.png`, `19-plus.png`). Seen: the dev banner sits over the status bar on the camera screen (`09-cam.png`), dev builds only |
| The reel editor end to end (text, drawing, stickers, "Suivant"), real-content take, viewer swipe timing | backlog, CanaReels | **WAITS for the next pre-release**: #1739 and #1742 (the 9:16 frame, the editor full-bleed and keyboard-proof) merged after `v1.2.3-alpha.5` |
| #1742 reel frame parity | PR | **WAITS** (merged, in no release yet) |
| #1738 IndexedDB eviction: kill with a queued 13 MB file, relaunch | PR #1738 (open) | **WAITS**: the PR is not merged |
| #1744 feed reel fetch, playback start | PR #1744 (open) | **WAITS**: not merged |
| An account deletion empties the App Group copies: delete a throwaway account on a debug (inspectable) build, then list `group.fr.emse.canari` - no `push_context.json` or `fcm_message_cache.ndjson` left, `mls.bin` / `graine_seeds.json` / `push_secret.txt` kept; `[DEL-LOCAL] push files: N removed from the extension's container` in the log, no `no App Group container` | [auth](frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18), added 2026-10-19 | **WAITS for a pre-release carrying it**: the `#[cfg(target_os = "ios")]` branch is not even compiled before the release's iOS build |
| PDF viewer performance | branch `perf/pdf-viewer` | **WAITS**: no pull request yet |
| Session holds, check P | [parity](frontend/android-ios-parity.md) | **not re-read by rule**: proven, "must not be re-verified" |

**Met again: the account-switch P3, and how the bench got there.** TestFlight "Mises à jour
automatiques" was ON, and it had replaced the bench's `1.2.2-alpha.1` with the `1.2.3` STABLE, a
build that talks to PRODUCTION. Installing `100200305` from "Builds précédents" turns automatic
updates off for the app (TestFlight says so), which keeps it off. The next sign-in as gamma then
answered `auth_local_state_unopenable` on the right PIN, and the documented remedy cleared it:
uninstall, reinstall, sign in. "PIN oublié ?" was not used, because it would reset the ACCOUNT's
PIN. A fresh install then asks for notifications, the microphone and the camera, and, the first time
a URL is opened, for iOS 27's default browser, which must be answered (Safari) before `ios.mjs url`
or a Safari launch is allowed.

## The Mi 9T readings of v1.2.4-alpha.2 (2026-10-12)

Build `1.2.4 (100200402)`, the `v1.2.4-alpha.2` release APK, on `dev.canari-emse.fr`, signed in as
the `fourth` account (shown as "Canari Test Delta"). It was already installed when the readings
started, and nothing was reinstalled. The WebView is inspectable, so every number below comes from
CDP (console, heap, DOM geometry) and screenshots, and every timestamp is the phone's. Evidence:
`<harness-dir>/a1-bench/r1012-alpha2/` (frames, `send13.jsonl`, `slow.jsonl`,
`dom*.log`). Frames that showed a tester's face were not kept.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| A ~13 MB video, sent in a DM | **`PASS`** | The file was a 12.9 MB, 20 s, 1080x1920 test pattern picked from "Tous les fichiers". `[video-prep]` brought it down to 7.4 MB (720x1280) in 12.1 s, before the send. After the tap on send: the outbox row was durable at +1.4 s (`durable write took 218 ms`), the bubble read `Envoi 24 % - 1,8 Mo sur 7,4 Mo` at about +2.9 s (first byte in under 3 s), and `[OUTBOX] ... sent` came at +6.3 s, with the check mark. No bubble stuck on "Envoi". The JS heap stayed at 18-21 MB throughout. Logcat shows no OOM, no GC storm and no lmk kill. Two things worth noting: the transcode keeps the main thread busy (TaskDuration +7.6 s over 12 s), and the pending tile shows a generic file icon instead of a video thumbnail. The poster appears about 15 s after "sent" |
| Reel camera, 9:16 full-bleed | **`PASS` (geometry)** | Swiping right from `/posts` opens `/camera`. The preview is `436x775` CSS px at x=0 (full width), exactly 9:16, `object-fit: cover`, with a 12 px radius. The stream is 720x1280 from the FRONT lens by default. The room was dark at 02:00, so what the picture showed was not judged. The first time only, the swipe stopped half-way behind the microphone permission prompt |
| Reel editor: keyboard, tray, trash, caption against the bar | **`FAIL`, one defect** | The keyboard lifts the text field and the tray above the IME. Dragging an overlay brings up a central trash that turns red, and dropping onto it deletes the overlay (`PASS`). The caption wraps over two lines, and "Publier" sits above the keyboard (`PASS`). **Defect: an overlay is not kept inside the frame.** Dropped on the tool tray, it is drawn OVER the tray icons. Its visible part cannot be grabbed again: a grab from the screen edge fires Android's back gesture, which opens the "Abandonner vos modifications" dialog. It is then baked into the published reel, clipped at the frame edge ("Test reel al" in the thumbnail and in the feed) |
| Legacy reel in the viewer | **`PASS`** | A reel from before #1742 (588x1040, posted 15 h earlier) opens at `436x771` with `object-fit: contain`: no bars, rounded, on a blurred backdrop, with its controls inside the frame |
| Feed reel playback start | **`PASS`** | An IntersectionObserver records `play`/`playing` 51 ms after the video reaches 50 % visibility. It plays muted, by itself. It was already cached, so a COLD first fetch was not timed |
| The slow-link hint is a corner icon, not the "Connexion lente" banner | **`PASS`** | Provoked with no root by `settings put global ingress_rate_limit_bytes_per_second 18000` plus a Wi-Fi cycle. `[CONNECTIVITY] slow link` mounts `slow-link-indicator`: a 28x28 CSS px round badge at the top right (x=400, y=42), opacity 0.8, with the SignalLow glyph, and no strip. The label is in `aria-label`/`title` only. At 8 and 14 KB/s, two 20 s stalls turn it into the "Hors connexion" banner, which is the offline state and the right one for an unreachable server. On dev, the badge sits over the "Environnement de test" banner |
| Media cards in the dark theme | **`PASS` by eye** | The chat video bubble (dark placeholder, then the poster), the feed image card on its blurred dark backdrop, the link-preview card and the viewer all look right. The light theme was not read |

Also met: in the post composer, "Filmer" opens the SYSTEM camera (`org.lineageos.aperture`), not
the CanaReels camera. In the reel camera, a TAP on the shutter takes a photo. The capture here was
therefore a still, so the editor was read on an image and not on a video. Deleting a post from its
menu asks for no confirmation. The PDF viewer measurement was not taken in this pass.

## The Mi 9T readings of v1.2.4-alpha.3 (2026-10-12)

Build `1.2.4 (100200403)`, the `v1.2.4-alpha.3` release APK (`app-universal-release.apk` from the
GitHub release), installed with `adb install -r` over alpha.2. Play Protect's upload prompt was
declined. The enrolment survived the upgrade, so there was no new sign-in: same `fourth` account
("Canari Test Delta") on `dev.canari-emse.fr`. Every number comes from CDP on the inspectable
WebView, and every timestamp is the phone's. Evidence:
`<harness-dir>/a1-bench/r1012-alpha3/` (frames `a3_*.png`, `a3_pdfm.json`,
`a3-cold-*.json`, `tap-summary.ndjson`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Reel editor: a text overlay dropped on the tool tray (#1755) | **`PASS`** | A photo was taken in `/camera` and a text "Canari bord TEST" was dragged from the middle to the bottom-right, onto the tray (`input swipe`, real touches). The box settled at x 424-1078 of a 1079 px screen, its centre above the tool row and clear of it, and no glyph was cut. It was grabbed again from its centre and moved to the middle with no back gesture. Dropped on the tray a second time, it landed in the same place. The export (718x1278) and the published feed card show the whole caption with about 20 px of margin |
| Restyle with the keyboard up | **`PASS`, one thing to know** | With the field open and the keyboard up, changing the font (serif) and then the background style left the centre exactly where it was (751, 1883). But the restyled box got WIDER than the space left (its right edge went to 1106, then 1150, past the 1079 px screen), so during the edit "TEST" was cut at the screen edge. It is pulled back inside only at "OK" (right edge 1077, centre moved 73 px to the left), and that is the state that publishes. A tap on a style also hid the ADB keyboard (the viewport went from 2116 back to 2339 px) |
| A tap on a stroke | **`PASS`** | A pencil stroke, then two taps on it: the stroke is selected (dashed box) and stays where it was, and the text overlay stays at 424/1818/1078/1949 |
| PDF reader in the app: `pic86.pdf` (81-page 14 MB scan, the owner's file, read with permission), sent in the BenchR1 DM from "Tous les fichiers" | **`PASS`, one defect** | Sent with its check mark. The first-page thumbnail on the card took ~25 s to replace the spinner. Times measured by CDP from a scripted click on "Ouvrir le document" (blob already decrypted by an earlier open): **first page painted at 663 ms, sharp at 852 ms**. **Seven real flings** (`input swipe`, 60 ms each): the landing pages (80-81) were sharp **1.08 s** after the last one, with 7 long tasks over the fling, 758 ms in total, the longest 221 ms. **Page 40**, reached by setting `scrollTop` (the reader has no page-jump control): drawn at **28 ms**, sharp at **609 ms**. **Text selection**: a long press on the OCR layer selects the word ("les", highlighted on the glyph) with the system menu (Copier / Partager / Tout sélectionner). Dragging a handle extends the selection across lines. The copied text joins two lines with no space ("les**autres** Grandes Ecoles"). **Defect, zoom loses the reading position:** zooming in from page 80 (x3, scripted) landed on pages 26-27. A REAL tap on "Agrandir" from page 40 (printed page 39) landed on page 27 (printed page 26). `scrollTop` stays the same while every page gets taller, so the reader ends up at page / zoom. The pinch anchors on its page ([posts](frontend/modules/posts.md#the-pinch-and-why-it-needs-a-focal-point)), but the buttons do not. Sharp after the last of three clicks: 1.49 s, longest task 404 ms |
| Notification tap to conversation, cold, behind the PIN (n=5) | **`PASS`** | Same method and instrument as [notification-to-conversation-latency](frontend/notification-to-conversation-latency.md) (the exact PendingIntent `am start`, then the PIN typed by the instrument). Medians [range], in ms after the tap: PIN gate 1665 [1627-1749], PIN submitted 1953 [1920-2130], `MLS ready` 2749 [2667-2905], route `/chat` 2965 [2870-3125], **pane + composer usable 3296 [3191-3449]**, first history row 3880 [3796-4107]. PBKDF2 106-136 ms, `mls-init` 28-48 ms. That is **0.53 s better than F2 (3825)** and **1.77 s better than the `main` baseline (5063)**. The gate matches F3 (1741). The feed's 20-card mount never ran under the landing. **Back from the conversation**: Back opens the conversation list. The feed tab then shows its posts (no stuck skeletons) |
| Quick regression: a text, then a ~14 MB video in BenchR1 | **`PASS`** | The text was `msg-status-sent` within 3 s. The video was a 14.5 MB, 9 s cut of the 12 Mbit/s test pattern from "Tous les fichiers". After "Préparation de la vidéo", the bubble showed a placeholder and then its poster, with the check mark, within 30 s of the tap. The staged tile still shows a generic file icon. **Slow-link badge: not provoked.** On fast Wi-Fi the `slow-link-indicator` never mounted and no banner appeared over the 180 s of polling. The corner-icon form was read on alpha.2 with the rate limit (above), and nothing between the two builds touches it |

Also met: swiping right on `/posts` (three `input swipe` attempts, on the media and on the post
header) did not open `/camera` in this pass. The camera was reached through a link click. In the
post composer, "Appareil photo" opens the system camera.

## The Mi 9T readings of v1.2.6-alpha.1 (2026-10-13)

Build `1.2.6 (100200601)`, the `v1.2.6-alpha.1` release APK (`app-universal-release.apk`, sha256
`43b5b2a8...`), on `dev.canari-emse.fr` (`dev.7b97c2a`). The phone carried a debug-keystore build,
so this was an **uninstall and a fresh install**: a NEW device, signed in again as the `fourth`
account ("Canari Test Delta"), with "Rester connecte" unticked, so every cold open asks for the PIN.
The peer is `canari-test-gamma` in the `chrome-w2` dev tab. Every number comes from CDP on the
inspectable WebView. Evidence: `<harness-dir>/a1-bench/r1013-a126/` (run JSONs,
`cycle-a126.ndjson`, the console captures `cons-*.ndjson`, frames). The salon items ran in a bench
community, `Bench126`, created by gamma for this pass (gamma administrator, delta member).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Killed notification tap to composer to the notified message, behind the PIN (n=6) | **`PASS`** | Same instrument and method as [the 1.2.5 reading](frontend/notification-to-conversation-latency.md#the-whole-cycle-tap-to-delivered-reply-2026-10-12). Medians [range], ms after the tap, `1.2.5-alpha.1` then this build: route `/chat` **3121 -> 1987** [1934-2092]; composer usable **3632 -> 3168** [3060-3536]; the notified message's row **4606 -> 3673** [3510-3995]; composer -> notified row **945 -> 455** [427-518]. `MLS ready` 2899 -> 2587. Warm (backgrounded 6 s, n=6): composer 1193 -> 935, notified row 1882 -> 1789. Send click -> outbox `sent`: killed 655 -> 638, warm 610 -> 514 |
| F1: nothing drawn before the PIN is accepted | **`PASS`** | The route is `/chat` at ~2.0 s while the PIN gate is up. With the gate on screen, the DOM holds **0** message rows and no message text (read over CDP), and the frame shows the opaque keypad only (`f1-gate-6s.png`). In all six runs `[LANDING_PREVIEW] ... drawn from the local store` comes 85-190 ms after the `pin-check` request has answered |
| PIN entry latency | **`PASS`** | PIN submitted -> `MLS ready`: median **436 ms** [397-1211] against **811 ms** [761-1099] on `1.2.5-alpha.1`. The salt is asked while the keypad is up (`[PIN] Salt asked while the keypad was up`, `pin-salt-fetch` 0-30 ms at submit). The one slow run is `mls-save-state` taking 535 ms, not the PIN path. The gate itself is unchanged: drawn at 1732 ms (1724 before) |
| A salon message is shown at once and settles | **`PASS`** | Three sends with real taps (`adb input`): the bubble is drawn **27-45 ms** after the click with "Envoi...", re-keyed to the server id at **232-759 ms** with "Message envoye", the status line gone at ~2.4-2.9 s. One row on each side (no duplicate), and the peer has it |
| Double tap likes WITHOUT opening the info panel; single tap opens it | **`PASS`** | Four double taps (two as CDP touch pairs 130 ms apart, one as two `adb input tap` in one shell, one in the logged session): one heart each, seen on gamma's tab, and **0 frames** with the info panel in the 1.5 s after. Single taps: the panel ("Envoye a ... Lu par ...") opens, 57-58 frames |
| Polls: manual close, shortcut jump, pinned bar alignment | **`PASS`** | The author (delta, phone) closed poll A: "Cloturer le sondage", system confirm, OK; both clients then read "Termine", `closable: false`, and the "1 sondage actif" pill disappears on both. Gamma (administrator) is offered the close on delta's poll B and closing it from the web ends it on the phone. With 25 messages below, the poll entry of the pill brings the poll into view (its title at y=414 of 945 CSS px), and the pinned entry brings the pinned message into view. The three pills (title, polls, pinned) share one centre line (x=461 of 923 in the frame) |
| The typing bubble stands clear of the composer | **`PASS`** | Gamma typing: the bubble's bottom is **16 CSS px** above the composer's top (wrapper 819.7-869.65, composer top 869.46, the wrapper's 16 px padding below the bubble) (`typing.png`) |
| "Seen by" heads do not flicker in a community | **`PASS`** | Heads sampled every 16 ms. Live exchange: every move is one step to the newest read row, never back. Three reloads of gamma's tab: delta's head is under `seen-c` from the first sample (~200 ms) and never moves in 12 s. Two cold starts of the phone into the salon: gamma's head is under `seenphone3` from its first sample and never moves in 15 s. `canari-dev-social-service-1` logged **0** `[CHANNEL_READ] mark past the newest message bounded` in the 40 min of the pass |
| Nothing fatal in the logs | **`PASS`** | 2326 console lines over the 12 timed runs plus two full captures (a cold start, a salon session; `Runtime.enable` replays from page load): **no** `error`/`warning` entry, **no** exception, **no** `[SELECT] selection dropped`. The only `[RESTORE]` line is the normal `N conversation row(s) seeded - history follows`. Logcat: no `FATAL`, no ANR; every process death is the instrument's own kill |

**Not measured, and why.** T1 (the notification shown) and a REAL notification tap: dev had no push that day
(`DEV_FIREBASE_SERVICE_ACCOUNT_JSON` absent; set since 2026-10-21), so the tap is the notification's exact `PendingIntent`
fired with `am start`, as in the 1.2.5 reading. The PIN is typed by the instrument (~130 ms); a
person adds 1.5-3 s. The landing preview under the vault path ("Rester connecte" ticked) was not
read, since this device is on the PIN path. The first ~100 ms after a salon opens are not covered
by the heads sampler (it is installed before the tap on the phone, after the open on the web).

**Met on the way, not asked about:**

- **The creator of a community is not offered "Epingler" until a reload** (FIXED 2026-10-13: the
  creation answer omitted `viewerCanModerate`, which also hid the close of another member's poll,
  [social-service](services/social-service.md)). Gamma created `Bench126`
  in the web tab; the message menu in its salon showed Transferer / Modifier / Supprimer and no
  Epingler, although the database gives gamma the Administrateur role (`channel.moderate`). After a
  reload the same menu has Epingler. One observation; whether "Cloturer le sondage" was also missing
  before the reload was not read.
- **The poll close confirmation is the system dialog with English buttons** ("CANCEL" / "OK") over a
  French sentence (`poll-close-1.png`). FIXED 2026-10-13: `ChannelPoll` asks through the app's
  `showConfirm`; no `window.confirm` is left in the frontend.
- **The sticky "AUJOURD'HUI" pill sits partly under the pinned pill** after the pinned jump
  (`pinned-jump.png`). **RE-READ 2026-10-13: the pill in that frame is NOT the sticky one** - its
  letters are spaced (`tracking-widest`) and its padding is wider, which is the IN-THREAD date
  separator (`ChatMessageGroups`), a content row scrolling under the floating glass chrome as every
  row does; the sticky pill is `letter-spacing: normal`. The sticky pill's own placement was
  measured in desktop Chrome at 390 px with the glass chrome forced on: `--chat-header-height`
  follows the pinned list closing (159 -> 113 -> 111 px within 100 ms) and the pill lands 13.6 px
  below the pinned bar. Nothing to fix on the sticky pill. Still unexplained: the jumped-to message
  in that frame was not centred, and the frame does not say which message was pinned - the next
  reading should name it.
- **The phone's long-press menu has no "Epingler" for a plain member**, which matches
  `mayPinMessage`.

## The bench readings of 2026-10-13 - the owed rows a bench phone can settle

Both bench phones, dev estate, bench accounts only. **Mi 9T**: the same `v1.2.6-alpha.1` release APK
as the section above, account `fourth` ("Canari Test Delta"), every number from CDP on the
inspectable WebView. **iPhone 12**: TestFlight `1.2.3 (100200305)` = `v1.2.3-alpha.5`, account
`canari-test-gamma`, driven over WDA (not inspectable). Evidence:
`<harness-dir>/a1-bench/r1013-owed/` and `.../ios-bench/r1013/`. Frames in which a
third-party app's heads-up notification showed a real person's message were deleted and re-taken
under Do Not Disturb.

**What the iPhone can run.** TestFlight offers this tester the `1.2.6 (100200699)` STABLE (a
production build: not bench) and, under "Builds precedents", nothing newer than the `1.2.3` group:
**no `1.2.4`, `1.2.5` or `1.2.6` pre-release build reaches the iPhone**, although every one of
those release runs built and uploaded its IPA (`v1.2.6-alpha.1`: "App Store / Build iOS IPA",
success). So every iPhone row below is on `1.2.3-alpha.5`, and every iPhone row whose fix is newer
stays owed until a pre-release build is distributed to the tester group.

| Reading | Phone | Verdict | What was seen |
| --- | --- | --- | --- |
| Android at 200 % text (lot 5) | Mi 9T | **`FAIL`, two P3 in the agenda; the rest `PASS`** | `font_scale 2.0` (root font 32 px). 15 routes walked through the client router plus a DM with the keyboard up: `scrollWidth - clientWidth = 0` everywhere, no text outside the viewport, the wordmark and the conversation name truncate, the composer fits over the keyboard, the PIN sheet scrolls to every option (at rest the `0` row is cut by the footer, reachable by a scroll). **`/calendar`**: (1) "S'abonner au calendrier" is wider than its card and spills 33 px out of the card's LEFT edge (button x=7, card x=41; `flex-wrap justify-end`, `calendar/+page.svelte:670`); (2) today's day number `13` is drawn at 40 px in a fixed 36 px circle and overruns it (`h-9 w-9 ... text-lg`, `CalendarScheduleList.svelte:226`) - the avatar-initials class of defect, not exempted by `.text-zoom-exempt`. Icons do not grow with the text (the WebView scales fonts, not lengths): not a defect by the 2026-09-30 decision. The dev banner takes two lines. Frames `t200-*.png`, audit `t200-audit.json` |
| Three-button navigation (lot 5) | Mi 9T | **layout `PASS`; ONE P2 `FAIL`** | Switched with `cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton` (this phone runs LineageOS, where it works; restored to gestural afterwards). Insets read 34 px top, **49 px bottom**; the tab bar sits above the three buttons on all 15 routes, and the composer, the keyboard and the message action sheet clear them. **`FAIL`: with the message action sheet open (long press on a bubble), ONE system Back closes the sheet AND the conversation**, 3 of 3: `history.state` reads `{canariOverlay:1}` with the conversation open and stays at 1 with the sheet open - `MessageMobileActions.svelte` registers no history overlay, so Back pops the conversation's entry. Not specific to the three buttons: `KEYCODE_BACK` is the gesture's Back too. Frames `b3-*.png` |
| Check W, the composer during a keyboard rise | Mi 9T | **`PASS`** | [W above](#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones): 869.5 -> 524 in one frame, 5 of 5; a 90 px keyboard escapes the double-report guard (P3) |
| Check V, the camera swipe after publishing | Mi 9T | **`PASS`** | [V above](#v-the-camera-swipe-on-a-fresh-feed-after-publishing---owed-on-android), 4 of 4 |
| "Rester connecte" path: cold open with no PIN, and the landing preview | Mi 9T | **`PASS`** | Unlocked once with the box ticked, then killed. A plain cold launch: no PIN gate in 40 samples over 11 s, `[PIN] Device key restored from PinVault - auto-login`, `Initialising MLS (vault device key path)`, `MLS ready` 0.53 s after the vault line. The notification's exact `PendingIntent` (`fr.emse.canari://chat/<id>`, `0x34000000`) on a killed app, n=4: no gate, `[LANDING_PREVIEW] ... drawn from the local store (60 message(s))` twice before and twice after the session is up, composer usable at 2.04-2.32 s of `performance.now()`, **0** error or warning lines. **The phone is LEFT on the vault path** (the box cannot be unticked without a sign-out): the next PIN-path reading must sign out and back in first |
| #1603 half 1: no `pauseSocket: native disconnect failed` on a background | Mi 9T | **`PASS`** | Three HOME-and-return cycles: `[WS] Paused - disconnect sent, socket released until the next foreground.` then `[WS] app back in the foreground with no socket - reconnecting`, each time; nothing in logcat for `pauseSocket` or `disconnect failed` |
| #1603 half 2: a scheduled post leaves the strip at its time | Mi 9T | **`PASS`** | The picker steps by 5 minutes, so the post was set for 11:20 at 11:15. "Publications programmees (1)" listed it until 11:19:31 at least; at 11:20 the strip was gone and the post was in "Tout", "A l'instant". The watcher's CDP call timed out once at the minute, so the second the strip left was not captured. Post deleted afterwards |
| Android fluidity (#1361-#1363), tap -> conversation pane | Mi 9T | **re-measured** | `pointerdown` on the DM tile -> the frame after `.chat-composer-footer` exists, warm: first open 412 ms, then 287-315 ms (median of 6: 310 ms), each with one long task of 257-349 ms. Against 662 ms on the first open before the three changes, on a debug build: the comparison is release against debug and is not a like-for-like attribution |
| #1605 "Ouvrir dans l'application", Android half | Mi 9T | **`PASS`** | `https://canari.emse.fr/login` in Chrome (not signed in) shows the link; the tap starts `act=VIEW cat=BROWSABLE dat=https://canari.emse.fr/... pkg=fr.emse.canari` from Chrome and Canari comes to the front |
| #1548 the reply context is per conversation | iPhone | **`PASS`** | "Repondre" armed on a DM message ("Repondre a Canari Test Delta"); the `Bench126` salon opened with no reply bar; back in the DM the bar and its quote were still there; cancelled afterwards |
| The send path on the iPhone (#1536 row) | iPhone | **`PASS`** | `ios1013send` in the DM: "Message envoye", the double check, and the Mi 9T's list shows it. **The reaction-failure toast was not read**: nothing here makes a reaction fail |
| #1604, no PIN prompt after a later sign-in | iPhone | **answered in part: NOT the "Rester connecte" vault** | The install sat on the login page; a sign-in as gamma landed on the feed and `/chat` with NO PIN, history decrypting and a send working. A cold relaunch ~9 minutes later DID ask for the PIN - which a vault would not have - and its sheet has no "Rester connecte" row (`showStaySignedIn = !biometricConfigured`). So the unlock was skipped on a key the live process still held. **Then the right PIN on that cold launch answered "Vos messages enregistres sur cet appareil n'ont pas pu etre ouverts"** - the [account-switch P3](plan.md#readings-owed) met again, here with no switch inside this session (which account the install held before it is unknown). Remedy taken: uninstall, reinstall `100200305` from TestFlight, sign in (the PIN asked this time), unlock |
| Dynamic Type at the largest standard size (lot 5) | iPhone | **no effect, warm or cold** | Reglages > Accessibilite > Affichage et taille du texte > Police plus grande, slider 50 % -> 100 %: a DM drew at exactly the size it had before, and so did the PIN sheet after a cold relaunch. The WebView ignores the setting, so Dynamic Type users get the default size. Whether that is accepted or wants `-apple-system-body` is a decision, not a reading. Restored to 50 % |

**What a bench phone cannot settle, and why.** Every push row (check H step 4, NOTIF-10, D2/D3 with
a shade reply typed by hand, the sender's face on a notification, NOTIF-6b, check K and C): dev sent
no push that day (`DEV_FIREBASE_SERVICE_ACCOUNT_JSON` absent; set since 2026-10-21) and the iPhone's development slot had no APNs
key (matters to a development-signed build only; not proven done, see the owed table). Check X needs a real finger. The iPhone rear-lens letterbox (#1370) needs the phone held up.
Check U and the iOS launch logo need a person (a face, a restart that kills WDA). The emoji
`naturalWidth`, the liquid glass re-read and every fix newer than `1.2.3-alpha.5` need an iPhone
build newer than the one TestFlight serves this tester.

## The Mi 9T readings of v1.2.7-alpha.1 (2026-10-13/14)

Build `1.2.7 (100200701)`, the `v1.2.7-alpha.1` release APK (`app-universal-release.apk` from the
GitHub release, sha256 `156ae21e...`), on `dev.canari-emse.fr`. The phone had no Canari, so this was
a **fresh install and a new device**, signed in through the service-account link as `fourth`
("Canari Test Delta"), "Rester connecte" unticked. The peer is `canari-test-gamma` in the
`chrome-w2` dev tab. Numbers come from CDP on the inspectable WebView and from logcat (the Rust
lines reach logcat, the WebView console does not). Dev still sent no push
(`DEV_FIREBASE_SERVICE_ACCOUNT_JSON` absent then; set 2026-10-21), so the notification is its exact intent fired with
`am start`. Evidence: `<harness-dir>/a1-bench/r1013-a127/` (frames, `cons-*.ndjson`,
`logcat-*.txt`, `inapp-log*.txt`, `notif-runs2.ndjson`).

**Another session drove this phone during the pass** (00:02-00:05: three force-stops from a shell,
`fr.emse.canari://post/0000...` and `://open/...` deep links, and wrong PINs typed on the gate). The
readings below were taken before it or after three quiet minutes.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Native checkpoint (#1826) | **`PASS`** | 60 `[MLS] checkpoint: manager lock held N ms (export), seal + write M ms off it` lines: **N = 0 ms 51 times, 1 ms 8 times, 2 ms once**; M median 2 ms, p95 5, max 9; state up to 304 KB. **0** `reload REFUSED`, `reload DROPS KEY MATERIAL`, `mls.bin write FAILED` or `ordering lock was poisoned`; no FATAL, no ANR |
| No stall on a salon open | **`PASS`** | Five real taps on a 56-row salon: one long task per open, **293-412 ms (median 335)**, the longest frame gap 425 ms, nothing over half a second. Same shape as the DM open of the 1.2.6 bench (257-349 ms) |
| In-app log (#1819): the save | **`PASS`** | Settings > A propos > "Enregistrer le journal" opens the system picker on Telechargements with `canari-log-1.2.7-alpha.1-<date>-<time>.txt`; "Enregistrer" writes it (68 KB, 748 lines) and the app says "Fichier enregistre." |
| In-app log: the redaction | **`FAIL`** | No name, e-mail, JWT, Bearer, full UUID, password, PIN or OIDC subject in either export. **But message text survives when it is one word or identifier-shaped**: `[SEND] handleSendChat: ... text="ok"`, `text="coucou"`, `text="refuse1-a127"`, while `text="Rendez-vous demain chez Paul a 18h"` became `"[34 chars]"`. `text` is in `PROSE_LAST_WORDS`, yet the quoted-value shape allowlist still keeps a value that looks like an identifier (`appLogRedact.ts`) |
| "Marquer tout comme lu" on a community icon (#1820) | **`PASS`** | A long press opens the menu with nothing selected (`getSelection()` empty). The tap clears the salon's `6` and the rail dot; the badge stays clear after a kill and relaunch. Gamma's tab, reloaded: delta's "Message lu par" head stays on `in-bg-mv6hmrir` (11:53), not on the six newer rows |
| Drag-reorder of the rail | **`PASS`** | With a second community (`Bench127`, created for this), a long press + drag moves it above `Bench126`; no menu is left open |
| Salon send before the salon is loaded (#1821) | **`PASS`** | Cold start from the salon's deep link, link throttled to 15 KB/s, sent at composer-usable: **"En attente..." for 1.9 s**, `[SEND] channel send ... HELD`, then `released: its salon is loaded`, "Envoi...", "Message envoye" at 4.6 s; one copy on gamma's side, no banner. Unthrottled, the same send never waits (the salon is loaded in time) |
| The refusal banner | **`PASS` (geometry)** | Provoked by cutting the Wi-Fi right after the unlock: "Rien n'a ete envoye : vos communautes n'ont pas pu etre chargees..." sits in the composer footer, opaque (alpha 1), the last row ending 24 CSS px above the footer, no overlap |
| A salon after an offline start, once back online | **`FAIL`, P1** | Back online, `[WORKSPACE-LOAD] online event` tried once and gave up as **non-retryable**: the Tauri HTTP error `error sending request for url (...)` is neither a `TypeError` nor a `DeliveryUnreachableError`, so `isRetryableLoadError` calls a transport failure fatal (`[CHANNEL] ... unclassified failure`). For 2.5 min, online with the socket up, the rail was EMPTY ("Selectionner ou creer une communaute") and every salon send and Retry was refused `listing-failed`. Only the next foreground's online event reloaded it |
| Reactors list on a long press | **`PASS`** | Long press on a heart chip (`aria-label` "(1 personne)"): the list ("Canari Test Delta") opens 5 CSS px under the chip, left edges aligned (chip 60-90 x 540-562, list 61-221 x 567-622); no message sheet |
| Typing bubble, three-button navigation | **`PASS`** | Bottom inset 49 px. Gamma typing: the bubble's wrapper ends at 844.8 CSS px, the composer footer starts at 844.5, the bubble itself 16 px above it |
| A salon row tap does not tap a message | **`PASS`** | Control: a tap on a bubble logs `[MESSAGE] bubble tap ... single, info panel`. Then six real taps on the salon row at a point that has a bubble under it once the salon is drawn: six opens, **0** `[MESSAGE] bubble tap` |
| Notification intent, killed, behind the PIN (n=5) | **`PASS`** | `performance.now()` of the new page, medians: PIN gate 1204 ms, route `/chat` 1736, composer usable with 56 rows 3421 (PIN submitted at 2511, the instrument waits 400 ms for a still keypad). Not comparable 1:1 with the 1.2.6 numbers, which count from the tap |
| Double tap / single tap | **`PASS`** | Double tap on gamma's bubble: `bubble tap ... double, heart`, `notify-reaction` 200, no panel in 1.5 s. Single tap: `single, info panel` |
| Polls | **`PASS`** | Created from the phone; gamma votes; "Cloturer le sondage" now asks through the app's dialog in French ("Annuler" / "Cloturer le sondage"); both clients read "Termine", the "1 sondage actif" pill gone on both |

**Met on the way:**

- **A configuration relaunch leaves the old WebView alive.** Switching the navigation mode (an
  overlay change, `Config changes=80000000`, which `configChanges` cannot absorb) relaunched the
  activity in the same process. CDP then listed TWO pages, the old one detached and unresponsive.
  It still held its `canari.salon-unsent.owner.*` Web Lock, so the three refused salon texts were
  never handed back to the composer: `[SALON-UNSENT] 3 entr(y/ies) kept: a live sibling tab owns
  them`. A System WebView update relaunches the same way.
- **Offline, the banner and the send disagree.** "Hors connexion ... les nouveaux messages
  partiront des le retour du reseau" is on screen while a salon send is refused at once
  (`listing-failed`, "Echec / Reessayer"). Offline, the salon's history is not drawn either
  (`[LANDING_PREVIEW] nothing drawn for channel_ (channel)`).
- **"Utilisateur inconnu"** names the DM peer for 60-125 ms after the landing is usable.
- **"Se deconnecter" on the PIN gate signs out with no confirmation**, one row under
  "Deverrouiller": the instrument's tap that raced the keypad animation signed the device out
  (re-signed in, same local state).

## Owed: the in-app camera in the composers (D-camera, 2026-10-11)

Built without hardware; the chain compiles and the vitest rows pass, which proves nothing about a
camera. **Owed one reading each on the Mi 9T and the iPhone 12:**

- **Chat, "+" then "Ouvrir la camera"**: the overlay covers the conversation, a tap takes a photo, a
  HOLD does NOT film, no microphone prompt appears (refuse the microphone: the photo still works), "Ajouter" STAGES the photo in the composer and the member then presses send (an ordinary image bubble), and the conversation (draft, scroll)
  is exactly where it was. Back (Android) and the edge swipe (iOS) end the review, then close the camera.
- **New post, "Ouvrir la camera"**: a tap gives a photo, a hold a video; "Ajouter" attaches it to the
  composer, the published post is a post (post retention), not a reel. No sound button in the review.
- **Android**: no system camera app is launched at any point (the `queries` and the capture
  `FileProvider` root are gone); the library picker still opens. **iPhone**: the camera permission
  prompt is the in-app one (`NSCameraUsageDescription` stays, `getUserMedia` needs it).
- The overlay over the keyboard and over a conversation with a pending draft; a camera refused
  (permission denied) shows the refusal screen with no native fallback.

## LIVE-B1. The broadcaster on both bench phones - owed on BOTH

The broadcaster of WP-L5 ([live](frontend/modules/live.md#the-broadcaster-as-built)), in every build
since the production flip of 2026-10-30 (`LIVE_ENABLED` in `features.ts`; both estates' servers open, `lives_mode` the runtime switch).
Every test of it runs on fakes: none of the readings below has been taken. Written 2026-10-19.

**Preconditions - each a reading:** both phones on a PRE-RELEASE build carrying the broadcaster
(Settings > A propos shows `X.Y.Z-alpha.N`, the store-serves-the-highest-build TRAP of CALL-L1
applies); two dev accounts sharing a space (a member's live is watched by readers sharing one); the
app's own viewer on the other phone - [check Y](#y-watching-a-live---owed-on-both-phones-mi-9t-iphone-12)
reads the same session from that side. Save the in-app log after each run
(Settings > A propos > "Enregistrer le journal"); the `[LIVE-PIPE] summary` and `[LIVE-BROADCAST]`
lines are what decide each row - no key, no segment byte is ever in them.

| Row | Mi 9T (app WebView) | iPhone 12 (app WKWebView) |
| --- | --- | --- |
| **1. Ten minutes on air**, the other phone watching: the composer's "En direct" chip, the rules screen with 60 min and 60 s from the server, Start, the red badge and its clock. Log: `[LIVE-BROADCAST] on air (recorder 1)`, a summary every 30 s with `not on keyframe 0`, `dropped 0`, and `two-fragment chunks` near 14 % of segments on Android (0 on iOS) | owed | owed |
| **2. Background and return**: home for ~20 s, back. The screen shows "Camera en pause" while away, then the badge again on the SAME live; the viewer sees a gap then catches up. Log: `recording paused: the app is in the background`, `re-acquiring`, `on air (recorder 2)`, and `generation 2 begins at +<ms>` | owed (the WebView ENDED the track in WP-L1: the release-on-hidden must make that moot) | owed (WP-L1 saw a MUTE in Safari; the app's WKWebView is unread) |
| **3. Background past the window**: home for 90 s, back. The end screen says the live stopped while the camera was paused; no camera opens. Log: `ended while the camera was away` | owed | owed |
| **4. Network cut and restored** (airplane mode ~20 s, on air): the quiet "Reconnexion..." badge with a growing backlog, which drains by itself when the network returns; nothing ends. Log: `reconnecting`, then summaries resuming with no `dropped` | owed | owed |
| **5. End**: End, "Continuer" keeps the live, End again and confirm. The viewer's live ends; the end screen says you ended it. Log: `ended (broadcaster)` | owed | owed |
| **6. Battery, UNPLUGGED, 30 min on air**: the level before and after, the phone's heat by hand. Also: under 60 % the rules screen shows the battery warning (Android only: WebKit has no Battery API) | owed (WP-L1: ~40 %/h PLUGGED) | owed (no warning expected) |
| **7. The screen stays on** for the whole of row 1 without a touch (the Screen Wake Lock); if the log says `no Screen Wake Lock API here`, that engine dims and it is a finding | owed | owed |
| **8. Does a NEW recorder's media time start at 0?** After row 2's return, read the first segment of `recorder 2` on the viewer side (or the rig's `readTimes`): its `tfdt` must be the `+<ms>` of `generation 2 begins`, NOT that plus the time the first recorder ran. `rebaseFragment` ASSUMES a fresh recorder restarts at zero - WP-L1 never measured it; an engine that keeps counting would put the second recorder's picture in the future for every viewer | owed | owed |
| **9. Network cut longer than the window** (airplane mode ~90 s, on air): the end screen says the connection was lost too long, the camera light goes off. Log: `segments waiting, over the <n> the reconnect window holds`, `ended (connection-lost)` | owed | owed |
| **10. End while offline**: airplane mode, End, confirm. The camera light goes off AT ONCE; the screen says the last seconds are being sent and offers "Quitter sans attendre", which closes it. Log: `camera given back; <n> segments to send` | owed | owed |

## CALL-L1. A 1:1 dev call between the two bench phones - owed on BOTH

Lot 1 of [calls](frontend/modules/calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only):
in-app 1:1 AUDIO, peer to peer, Cloudflare TURN as the last resort, on dev builds only
(`CALLS_ENABLED = CALLS_COMPILED || deployEnvironment() === 'development'`). Nothing in it was ever
run on a phone ([2026-10-18 bench](device-readings-calls-live-2026-10-18.md): `BLOCKED`, dev was on
`1.2.9-alpha.7`). Written 2026-10-19, when dev served `1.3.0-alpha.4` with the dev TURN pair.

**Preconditions - each one is a reading, never assumed:**

1. **Both phones run a PRE-RELEASE build**: Settings > A propos shows `X.Y.Z-alpha.N` and the app
   talks to `dev.canari-emse.fr`. A stable build has `CALLS_ENABLED = false` and no call button.
   **TRAP: a store serves the HIGHEST build number.** The stable `1.3.0` is `100300099` and outranks
   `1.3.0-alpha.4` (`100300004`), so once `1.3.0` is offered, Play updates the Mi 9T to a build that
   cannot call; on TestFlight, pick the alpha build by hand. When Play offers no alpha above the
   latest stable, the reading needs the next pre-release (`v1.3.1-alpha.1` = `100300101`).
2. **Two dev accounts, one per phone, sharing a DIRECT conversation**: calls are offered in direct
   conversations only. No block between them (a block refuses the call with `call_unavailable`).
3. **The call permission is not refused**: the conversation's panel, "Appels", reads "Autorises", or
   no choice was made and the level is not `none`.
4. **Both apps OPEN, in the foreground, screen on.** The ring is the MLS `call_invite` over the chat
   socket. A killed or backgrounded app is NOT rung (`CALLS_COMPILED = false`, no native ring; written before
   dev had a Firebase sender, which it has since 2026-10-21 - `[ring] Firebase Admin is not initialised` on dev is now a finding).
5. **The microphone prompt** appears on the first call on each phone: accept it.

**The log.** A store build is not inspectable: Settings > A propos > "Enregistrer le journal" saves
the in-app log after each call. **Never paste the `[Call] encryption key derived from MLS (fp=...)`
line of a build older than 2026-10-21 into this public repository** - it printed key bytes. From
then on the line reads `media keys derived from MLS (role= send_fp= recv_fp=, sha256)`, a hash of
each direction's key, safe to quote ([calls](frontend/modules/calls.md)).

**Steps:**

| # | Action | Expected on screen | Expected in the log |
| --- | --- | --- | --- |
| 0 | **FIRST, before any other row, on the build carrying #2148**: one p2p call on dev, connected, then left IDLE (nobody speaks, no network change, both apps in the foreground, screens on) for **more than 60 s** | the call goes on: no "Reconnexion...", no end | server (dev `call-service`): `[call] p2p paired ...` and **NO `held dead`, `keepalive-lost` or `not taken within` line** for either peer over the whole idle minute. It proves the keepalive's Pong crosses the PUBLIC path (Cloudflare tunnel + host nginx) - which no local test covers; a `held dead` line here means the path eats Pongs, and every other row would read the keepalive, not the network |
| 1 | Mi 9T opens the DM, taps "Appel audio" | the call screen; the iPhone rings IN-APP within seconds | caller: `[Call] fetching ICE servers for group=...`, `[Call] server ring sent - answer window open`, `[Call] signalling connected, joining p2p room...`, `[Call] p2p room ready (...)`; callee: `[Call] signal from <id> in <group> call=<id>` |
| 2 | iPhone answers | both show the call in progress; each hears the other, both ways, for at least 30 s | caller `[Call] peer ready - this side is initiator`, callee `... is polite`; `[Call] offer (...) -> peer` / `[Call] answer (...) -> peer`; `[Call] connectionState=connected`; `[Call] selected path pair=<local>/<proto>-><remote>/<proto> relayed=yes\|no`; `[Call] E2E encrypting audio` and `[Call] E2E decrypting audio`; `[Call] remote track unmuted kind=audio` |
| 3 | iPhone hangs up | both screens leave the call; the conversation shows the call line | no `[Call] terminal failure` |
| 4 | Steps 1-3 the other way: the iPhone calls the Mi 9T | the same | the same, roles swapped |
| 5 | Mi 9T calls, nobody answers | after 60 s the ring stops; a missed-call line on both | caller `[Call] ring window (60000 ms) closed unanswered - call=<id>` |
| 6 | The callee app KILLED, then called | **nothing rings - EXPECTED in lot 1**, not a `FAIL` | caller as step 5 |
| 7 | Callee sets "Appels" to "Non autorises", then is called; then back to "Autorises" | refused: no ring, a missed-call line at once; allowed again: it rings | callee: `[Call] invite <id> in <group> not rung - calls are not allowed in this conversation` |
| 8 | **CALL-WIFI** (owed on a build carrying the resume, both phones on it). In a connected call, Wi-Fi OFF on the Mi 9T for **6 s**, then on | the call does NOT end; both screens show "Reconnexion..." only on a build that also carries the call UI of #2138 (it reads `callService.reconnecting`); audio comes back both ways | Mi 9T: `[Call] signalling WebSocket closed code=1006 - resuming`, `[Call] signalling resume attempt N/15`, `[Call] signalling resumed on attempt N`, `[Call] peer ready - ... (resumed)`, `[Call] pair resumed: ... audio packets A -> B`; either `the media path carried audio across the outage - no ICE restart`, or on the INITIATOR `[Call] ICE restart 1/3 (...)` + `[Call] ICE restart offer (...) -> peer` then `[Call] media path restored after 1 ICE restart(s)`; NO `[Call] terminal failure`. Server: `[call] p2p seat away ...` then `[call] p2p paired ... resumed=true`. **`1.3.1-alpha.2`: `PASS`** (2026-10-19, [readings](device-readings-2026-10.md)) |
| 9 | **CALL-WIFI**, the same with a **14 s** outage; then once more as callee (the iPhone calls) | as step 8 | as step 8; record the attempt number that resumed (expected 5, at +15 s on the capped ladder). If the initiator's first restart offer was lost: `rolling back an unanswered offer - its answer can no longer come`. **`1.3.1-alpha.2`: `FAIL`** - resumed at attempt 5 (+32 s), the restart request was dropped as "already in flight", both phones stayed on "Reconnexion..." with no audio; cause and fix (explicit restart offer, rollback, per-pairing guard, capped ladder) on [calls](frontend/modules/calls.md#what-the-131-alpha2-bench-reading-found-2026-10-19-and-the-fix); **re-read owed on the build carrying it** |
| 10 | **CALL-WIFI**, Wi-Fi OFF on the Mi 9T for **90 s** (longer than the 60 s seat grace) | the call ENDS on both phones: the Mi 9T by its attempt budget (~+55 s), the iPhone at most ~90 s after the loss | iPhone `[Call] the other party lost its signalling connection` within ~30 s, then `[Call] the other party left the call room`; server `... held dead (half-open socket)` / `disposition=keepalive-lost`, then `p2p seat EXPIRED`; Mi 9T `[Call] signalling resume refused (call-over)` or `... not restored after 15 resume attempts`. **`1.3.1-alpha.2`: `FAIL`** - the Mi 9T ended at +30 s, the iPhone sat on "Reconnexion..." for 100+ s: the server never held the half-open socket dead, so no grace and no `PeerLeft`; fixed by the keepalive liveness proof; **re-read owed** |
| 11 | **CALL-WIFI keepalive, a SUSPENDED app** (owed on the build carrying #2148): in a connected call, lock the screen on ONE phone for **more than 30 s**, then unlock; again with the app sent to the background instead; each phone in turn | EITHER the call goes on (the app kept running: its process answered the keepalive) OR, if the OS suspended the app, the partner shows "Reconnexion..." about 20-30 s in, then the call ENDS on it ~60 s later; on unlock the suspended phone resumes if it is back before that end, else it is told the call is over. NEVER a partner stuck on "Reconnexion..." past ~90 s | server: no `held dead` line while the app runs; if suspended, `... answered none of 2 keepalive pings - held dead (half-open socket)`, `disposition=keepalive-lost`, then `p2p seat EXPIRED` or `paired ... resumed=true`. Record per phone and per gesture whether the app was suspended: the change of behaviour (a suspended app used to keep its seat "present" indefinitely) is the thing measured. Android's background microphone is CALL-LOCK-ANDROID, not this row |
| 12 | **WP-C-BG-I, the iPhone's microphone in the background** (owed on the first pre-release carrying it, in this order). (a) The iOS job's `UIBackgroundModes of the built app:` line lists `audio`. (b) In a connected call: lock the iPhone 60 s, then send it to the background 60 s. (c) Out of a call - **the mode is APP-WIDE**: play a reel with sound, then a voice message, and lock then background the iPhone during each. (d) In a call: an audio ROUTE change (AirPods connected then removed, a wired headset in and out) and a short interruption (an alarm or a Siri press of about 2 s). (e) A call ACCEPTED from the lock screen (the track can be handed over already muted). Record every `mute`/`unmute` pair with its duration BEFORE any debounce is written | (b) the Mi 9T keeps HEARING the iPhone through the lock and the background (its inbound audio packets keep rising - `getStats()` over CDP every 5 s) and the iPhone keeps playing the Mi 9T's voice. (c) RECORD whether playback continues while locked or in the background - it did not before this build, and now may: that is a behaviour change to accept or refuse, not a defect by itself. (d) a route change should NOT produce a `the system took the microphone` line; if it does, how often and for how long - a flicker would put false "Le telephone de ... a coupe son micro" notices on the partner's screen. (e) the call connects, and if the track starts muted the notice shows until it is given back | iPhone log: NO `the system took the microphone` in (b); in (d)/(e), each `WARN the system took the microphone (track muted, page visible\|hidden) - telling the other party` and `gave the microphone back after N s` with N; Mi 9T log: `the other party's system took its microphone` / `gave its microphone back` for each; server: one `p2p mic-suspended relayed` per transition. If (b) still mutes the capture, read the iPhone's syslog (`WebKit`, `mediaserverd`) before any native audio-session code ([calls](frontend/modules/calls.md#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20)) |
| 13 | **B0 of the audio-only plan - a hidden peer video is still under its transform** (owed on the first pre-release carrying #2171). A dev build WITH video calls a build with video FORCED OFF (`CALLS_VIDEO_ENABLED` false: a local build, or the first audio-only alpha), the video side turns its camera on; once with the iPhone as the audio-only side, once with the Mi 9T | the audio-only side shows NO video and the call goes on past 30 s with the camera on; the video side still hears and is heard | audio-only side: `[Call] the peer sends video - this build is audio only, it is received and not shown`, then `E2E path check ...: no media around the transform` with `received ... video=` rising; NEVER `media flowed AROUND the transform on receiver:video` nor a `CallE2eBypassedError` end. A false END here means the engine does not feed a receiver transform whose track has no sink - then the `inactive` route of B0 is owed ([calls](frontend/modules/calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21)) |

**Record per direction:** the verdict, the `relayed=` value (only `relayed=yes` is billed TURN), the
network (bench Wi-Fi; no SIM in either phone, so cellular stays owed), and the build on each phone.

**Failure signatures, and what each names:**

- `[Call] ICE servers HTTP 503`: the dev TURN pair is missing from dev's chat-delivery-service
  (`DEV_CLOUDFLARE_CALLS_API_TOKEN`, `DEV_CLOUDFLARE_TURN_KEY_ID`), or the monthly budget refused.
- `[Call] startCall refused - RTCRtpScriptTransform unavailable` (or `acceptCall refused ...`): that
  WebView has no E2E transform - a finding about the engine, P1 for lot 1, never a reason to degrade.
- `[Call] WARN remote audio still muted after 5s`, or `[Call] E2E decrypt failed`: media arrives
  but cannot be heard or decrypted; note both phones' MLS state.
- `[Call] ERROR E2E key mismatch` and the "ne peut pas être déchiffré" notice (builds carrying the 2026-10-21 port
  of #2013): no receiver decrypted anything after 100 failures - compare one phone's `send_fp` with
  the other's `recv_fp` (`media keys derived from MLS` line); unequal means the two devices derived
  different keys (different MLS epochs, or one build older than the v2 wire) ([calls](frontend/modules/calls.md)).
- `[Call] signalling refused: <reason>`: the relay refused the room (`room-full`, `group-mismatch`,
  `token-refused`; `call-over` on a resume means the seat expired or the other party hung up).
- `[Call] terminal failure: ... the relay gave no resume token`: the call-service on that estate
  predates the resume (CALL-WIFI) - a deploy gap, not a client defect.
- `[Call] connectionState=failed` with no `selected path`: no candidate pair, not even TURN - read
  `iceConnectionState` and the network.

**`[CALL_REPORT]` reaches a build with the first pre-release carrying the 2026-10-21 port of #2011**
(check the release notes; no build before it has the line). From then on each device logs one line per call every 10 s and once at the end
(`[CALL_REPORT] call=<roomId> phase=<tick|end> dur_ms= ring_ms= connect_ms= engine= ice= pair= relayed= ...
e2e=on enc_frames= dec_frames= dec_fail=`); record `connect_ms` (and `ring_ms` apart: a human; one `setup_ms` from the tap on a build before the split of 2026-10-31), `relayed`, `rtt_ms`, `loss_in_pct` and
`dec_fail` per direction, which is the plan's exit criterion
([calls-revival-plan](frontend/modules/calls-revival-plan.md)).

## The Mi 9T readings of v1.2.9-alpha.7 (2026-10-17)

Build `1.2.9 (100200907)`, the `v1.2.9-alpha.7` release APK (`app-universal-release.apk`, sha256
`b3a5129c...`, release run `39026972985` green), `adb install -r` over alpha.5 (`firstInstallTime`
unchanged: enrolment kept). Dev estate, account `fourth` ("Canari Test Delta", NOT an admin), vault
path, phone text size `0.85`. Console over CDP, real taps with `adb input`. Evidence:
`<harness-dir>/a1-bench/r1017-a129a7/` (`hubnav.ndjson`, `weaknet-runs.ndjson`, `wn1-3.txt`,
`signout.json`, `cons-all.ndjson`, `cons-fs.ndjson`, frames `s*.png`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Comment sort row at 200 % text (#1980) | **`PASS`** | `font_scale 2.0` (root 32 px). "Recents / Anciens / Aimes" now sit on their own line UNDER "Afficher les 2 commentaires" (R 351 for a 436 px viewport). `.page-scroll-wrap` `scrollWidth 436 = clientWidth 436` (alpha.5: 553), `documentElement` 436; a `scrollIntoView` on "Anciens" and a real sideways drag both leave `scrollLeft` at 0 (`s10-fs2-sortrow.png`). The only boxes wider than the viewport are long author names, clipped inside their `truncate` parent |
| 2a. Dashboard hub rows (#1958) | **`PASS`** | `/dashboard` from the fourth tab: the identity row ("Voir mon profil"), **Explorer** (Agenda, Associations, Listes, Institutions, Boutique, Formulaires, Notifs), then **Compte** (Parametres, then "Se deconnecter" in the danger tone) - the order #1958 specifies; "Compte" is the LAST group, not the first. No admin or manager group for this account (`s01`, `s02`) |
| 2b. Each row navigates, Back returns | **`PASS`** | Real tap on each of the 9 link rows: `/profile`, `/calendar`, `/associations`, `/lists`, `/institutions`, `/shop`, `/forms`, `/notifications`, `/settings`, each with its own `h1`; ONE system Back returns to `/dashboard` 9 of 9 (`hubnav.ndjson`) |
| 2c. Dashboard at 200 % text | **`PASS`** | `scrollWidth 436`, 0 clipped rows, labels and summaries wrap on two lines (one summary ends in an ellipsis after two lines, by design); scrolled to the end the sign-out row (bottom 832) clears the tab bar (top 873) (`s11`, `s12`) |
| 2d. Sign-out busy state, double tap (#1958, #1966) | **`PASS`** for the button, **see the finding below** | Two `input tap` 191 ms apart: ONE `[A] signout requested by the user`; the row reads `disabled`, `aria-busy="true"` at the next sample, then `/login`. But TWO `POST /api/auth/logout` went out (200 each) - the second NOT from the second tap |
| 2e. Theme still reachable | **`PASS`** | Parametres > Preferences: "Automatique / Clair / Sombre"; Clair sets `data-theme="light"` (body `rgb(240, 242, 245)`), Automatique returns to dark |
| 3. Admin read-access redesign (#1957) | **`NOT-OBSERVED`** | `fourth` is not an admin (`canari_global_admin` false, no Administration group) |
| 4. Airplane mode during a refresh (#1966) | **`PASS`** (n=3 cold, n=1 warm) | Cold start, airplane ON 0.75 s after launch, held 35 s, then OFF. n=2 with the refresh in flight: `refresh->` then `refresh✗transport 111-112ms`, `refresh not sent: the browser reports no network ... held until the reconnect`, `[LOGIN] Offline unlock (no token)`; network back: one more transport failure, then `refresh✓`, `[PROMOTE] ... fully promoted` 46 s after the cut. Route `/posts` throughout, the login page never drawn. n=1 with the cut after `refresh✓`: same, no sign-out. Warm (feed open, airplane on, pull to refresh, 30 s): "Hors connexion.", back online `server reachable again`, no `[A]` line. **Airplane mode fails the request in ~110 ms: the 20 s `REFRESH_DEADLINE_MS` path (a stalled link) was NOT exercised** |
| 5. Avatar photo on the first frame (#1977) | **`NOT-OBSERVED`** | As on alpha.5: no conversation, community or member reachable from `fourth` has a photo avatar (0 `<img>` avatars on `/chat` and `/communities`) |
| 6. `[TAURI] Couldn't find callback id` after a text-size change | **`PASS`** | Text size 0.85 -> 2.0 (the WebView reloads: `Initialised in TAURI mode`): **0** such warnings in the 3 min after, 0 in 210 s, 0 in logcat, 0 across the three force-stop relaunches of reading 4 (alpha.5: 15 in 4 min). The console logger was proven alive by a probe line |

**Findings:**

- **P2 - a user sign-out sends `POST /api/auth/logout` TWICE and ends through the "session
  expired" path.** `signout.json`: `[A] signout requested by the user`, `[A] clear`, `[LOGOUT] MLS
  client retired`, the page re-initialises, and `[PIN] Device key restored from PinVault -
  auto-login...` runs AGAIN (17 ms after) - the vault surviving a sign-out, noted on 2026-10-14. That
  auto-login asks for a token: `refresh->` races the logout, comes back `refresh✗401`, and
  `[AUTH] Session expired - logging out and redirecting to /login?returnTo=%2Fdashboard` runs a
  second `clear` and a second logout POST. The reader lands on `/login?returnTo=/dashboard`.
- **Observed, documented:** `signout: MiConnect session NOT ended (no-id-token)` - this session
  predates the id_token kept by #1866, so its first sign-out is local-only, as
  [auth](frontend/modules/auth.md#signing-out-ends-the-miconnect-session-2026-10-14) says. The
  following sign-in asked for the password.
- **The 2026-10-14 P1 candidate did NOT reproduce:** sign-in again in the same process
  (service-account link, password) reached `handleOidcCallback resolved`, the vault restore, the
  device binding (`PUT .../sessions/current/device` 200), the feed and the DM list, no kill needed.
- **P3 noise:** while the refresh is held offline, `[A] token->refresh` is logged 43-44 times in the
  first 13 s of a cold start (one per caller). Offline `[WS] Gateway connection failed` at ERROR,
  unchanged.
- Logcat: no `FATAL EXCEPTION`, no ANR. The phone is left at text size `0.85`, airplane mode off,
  signed in as `fourth` on the vault path.

## The Mi 9T readings of v1.2.9-alpha.5 (2026-10-17)

Build `1.2.9 (100200905)`, the `v1.2.9-alpha.5` release APK (`app-universal-release.apk` by asset
id, sha256 `96b09481...`), `adb install -r` over alpha.4 (`firstInstallTime` unchanged: enrolment
kept; Play Protect's "send for a check" prompt answered "Ne pas envoyer"). Dev estate, account
`fourth` ("Canari Test Delta"), vault path, bench DM with gamma only. Console over CDP. Evidence:
`<harness-dir>/a1-bench/r1017-a129a5/` (`cons-all.ndjson`, `cons-2.ndjson`, frames).
#1977 (warm avatar cache) is NOT in this tag.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. A gallery video in a chat opens 3 times and plays | **`PASS`** | A 9 s gallery video sent in the DM (prepared 13.8 MB -> 3.2 MB, segmented upload). Opened full screen 3 times in a row (tap off the centre "Lire" button), closed with Back each time: each open has a second `<video>` at 436 px, `readyState 4`, playing (`currentTime` 1.26-1.56 s at +1.5 s, 3.45-3.72 s at +3.5 s), no media error; Back returns to `/chat` with the viewer gone. A tap on the centre button plays inline instead (`InlineVideo: manual play`), by design |
| 2. ReelBackdrop on the camera paints, then repaints once exposure settles | **`PASS`** | `/camera` from the feed swipe: `[reel-backdrop] painted`, then `repainted once the exposure settled (4 reads, 32 frames)` 1.5 s later; after a lens switch `painted` then `(2 reads, 16 frames)` 0.6 s later. The backdrop canvas is 96x168 shown at 436x861, opacity 0.6. In the reel viewer it paints on open and again on the next reel |
| 3. Feed "Tout" at 200 % text | **`FAIL` (P3)** | `font_scale 2.0` (root 32 px). Tab row fine (a scroller; Tout and the CanaReels icon stay in view), names truncate, `documentElement` does not overflow. **But the comment sort row (Recents / Anciens / Aimes, beside "Afficher les N commentaires") does not wrap: `.page-scroll-wrap` gets `scrollWidth 553` for `clientWidth 436`** (`overflow-x: auto`), so the whole feed can be shifted 117 px sideways; a `scrollIntoView` on "Anciens" did exactly that (`t200-sort.png`). 17 px over already at 150 %, none at 100 % or 85 % |
| 4. Posts page tabs and the CanaReels entry | **`PASS`** | Associations / Suivis / Tout each set `?feed=` and draw their list (Suivis: the "Aucun post" empty state). The clap icon opens the viewer at the newest reel (`page of 4, 4 loaded`), playing, author and text over the scrim, a swipe goes to the next reel, the close returns to `/posts?feed=all` |
| 5. Avatars when switching chats | **`NOT-OBSERVED` for photos** | No conversation or member reachable from this account has a photo avatar (0 `<img>` avatars). Initials avatars sampled every frame across DM -> back -> community -> DM (986 frames): 0 frames with an empty avatar |

**Met on the way:**

- **A system text-size change reloads the WebView, and afterwards `[TAURI] Couldn't find callback id
  2851905282 ...` is logged as a warning every ~15 s** (15 times in 4 min, same id), an async Rust
  call still answering the page that went away. Noise by the project rule (P3).
- The video staged in the composer shows a generic file icon and the name `81.mp4`, not a preview
  or the gallery name; the sent bubble shows a grey video icon until tapped (P3, cosmetic).

## The Mi 9T readings of v1.2.9-alpha.4 (2026-10-16)

Build `1.2.9 (100200904)` (`dumpsys package`; "Version de Canari 1.2.9-alpha.4" in
`/settings/about`), the `v1.2.9-alpha.4` release APK (`app-universal-release.apk`, sha256
`b58e4aa7...`) from release run `38888170609`, installed with `adb install -r` over alpha.3
(accepted, account kept), dev estate, account `fourth` ("Canari Test Delta"), phone text size
`0.85` (its default). Same instruments as alpha.3 (`feed.mjs`, `reconnect.mjs`, `st.mjs`, console
over CDP, logcat), plus `reelperf.mjs` (in-page: `requestAnimationFrame` deltas over 5 s, then the
playing reel's `requestVideoFrameCallback` across two loops) and `cap.mjs` (the caption toggle, its
scroller, whether the reel plays). Two dev reels were published to have a long caption and a
landscape frame (a 6 s in-app take, and a 1280x720 test pattern from the gallery), both deleted at
the end (`DELETE /api/posts/...` 200 each); nothing was published on production. Evidence:
`<harness-dir>/a1-bench/r1016-a129a4/` (frames `s*.png`, `reelperf.ndjson`,
`feed-runs.ndjson`, `reconnect-runs.ndjson`, `cons-main.ndjson`, `applog.txt`, `logcat-main.txt`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. One header row (#1942) | **`PASS`** | "Associations", "Suivis", "Tout", then the clap icon at the right ("Ouvrir les CanaReels"); no "Tous les posts" / "CanaReels" filter row; `[POSTS] dropped the retired CanaReels filter choice` once (`s01-feed.png`) |
| 1b. Clap opens the viewer | **`PASS`** | `[reels-entry] opening the viewer at the newest reel`, `[reel-viewer] opened on af19ba1b...`, `page of 3, 3 loaded`; full screen, the feed hidden under it (`s02-viewer.png`). Drag up: `next: 0 -> 1`. ONE system Back: `[reel-viewer] closed`, `/posts`, no dialog left, `history.length` unchanged |
| 1c. Empty state | **`NOT-OBSERVED`** | Every dev account sees the same reels (`feed=all`); reaching "Pas encore de CanaReels" needs deleting other members' reels, which was not done |
| 2a. Overlay, default text | **`PASS`** | Avatar + name + age small at the bottom-left over a scrim; a 9-line caption clamped to 2 lines with "Voir plus" (`s10-viewer-new-reel.png`). "Voir plus" unfolds in place (`caption expanded on f3bbee49...`), "Voir moins" and a tap on the video both fold; the reel plays throughout (`currentTime` advancing and looping, never paused) |
| 2b. Overlay at 200 % text | **`PASS`** | `font_scale 2.0`, root 32 px: unfolded, the caption is a scroller (473 of 1485 px) under the author row with "Voir moins" visible; a drag scrolled it (`scrollTop` 0 -> 377) without turning the reel, the reel playing (`s14`, `s15`). Restored to `0.85` |
| 2c. Landscape (letterboxed) reel | **`PASS`** | `[reel-review] take is 1280x720`, `ratio 1.778`: the frame sits mid-screen, the caption inside it, 2 lines + "Voir plus"; unfolded it scrolls inside the frame (112 of 210 px, `scrollTop` 0 -> 84), author row and toggle never clipped (`s19`, `s20`) |
| 3a. Backdrop | **`PASS`** | A 96x56 / 96x168 canvas, `object-fit: cover`, no CSS filter; `[reel-backdrop] painted` exactly once per source, no timer. Smooth gradient, no blocks (`s19-landscape-viewer.png`) |
| 3b. Frame timing while a reel plays | **`PASS`** | n=3 x 5 s: 302-304 frames, p50 16.6-16.7 ms, p95 16.8 ms, longest 17.0-33.6 ms, frames over 25 ms **0, 1, 0** (alpha.3 bench: 5 over 25 ms with the 250 ms re-sample) |
| 3c. Loop seam | **`PASS`** for a reel published by alpha.4, residual noted | Video frames every 33 ms. **Trimmed reels** (published now, `[video-prep] trimmed to the video: 0.055-6.063 s`): last frame -> first frame after the wrap **100-117 ms**, first frame held **67-83 ms** (n=4 wraps, portrait and landscape). **Old untrimmed reel** (`af19ba1b`, 3.52 s): 100-133 ms, then the first frame held **250-267 ms** (n=5; 383-417 ms on alpha.3) |
| 4a. Camera photo name | **`PASS`** | Edited photo: `handing back canari-photo-<n>.webp (44600 bytes)`, `camera take handed over (image/webp)`. Unedited: `canari-photo-<n>.jpg`. No `.bin` |
| 4b. Camera preview backdrop | **`FAIL`** | Post composer camera, n=3 opens: the backdrop canvas reads near black (mid/bottom rows RGB 2-6) while the preview shows a grey wall; the band under the preview is RGB 16,15,16 (`s22`, `s30`, `s31`). Painted 166 ms after `[camera] first frame`, from an under-exposed first frame. On `/camera` the same paint came out teal over the grey wall (`s06b`) |
| 5. Paid form price (#1938) | **`PASS`** | "Cotisation BDE 2026" by its id: before any answer, no "Combinaison indisponible", no price, no "Payer" (`s40`). After "ICM": "A partir de 60,00 EUR (3A, ICM)", "Paiement Canari" / "En especes", "Payer 60,00 EUR" (`s41`). Nothing paid |
| 6a. Feed after reconnect (#1938) | **`PASS`** | n=2 offline cold start, then airplane off: **20 cards offline and 20 after** (alpha.3: 10); the status line goes at +6.3-7.3 s, the reel decodes at +8.4 s |
| 6b. Reel stream once (#1938) | **`PASS`** | One `[media-seg] stream ... through MediaSource` per cold start (n=3 online, n=2 reconnect), no `play() refused` |
| 7a. Wrong PIN empties the field | **`NOT-OBSERVED`** | As on alpha.3: the vault restores the key on every launch, the gate is never drawn |
| 7b. Online cold first paint | **`PASS`** | n=3: first card **2558-3092 ms** after `am start` (alpha.3 2254-2385), 20 cards, 0 warnings |
| 7c. Offline cold start noise | **`PASS`**, unchanged | n=3: **10** warnings each, the same ten families |
| 7d. 200 % text | **`PASS`** | `/posts` `scrollWidth = innerWidth = 436`; the tabs scroll in their own row |

**Findings:**

- **P1 - a video picked from the gallery on `/camera` (Android) is dropped without a word.** The
  picker opens (`GET_CONTENT video/*`), the app goes to the background, the camera is released and
  `CameraScreen` drops its `controls` snippet with the `<input type="file">` in it. The file comes
  back to that DETACHED input (`isConnected: false`, `files[0] = 96.mp4, video/mp4`), and Svelte 5
  delegates `onchange` from the root, so `onPicked` never runs: no review, no toast, no log line
  (n=3). Handing the same file to the live input reached `ready -> review on picked`, which is how
  the landscape reel was made. Source: `frontend/src/lib/components/reels/ReelCapture.svelte`
  (the input inside `{#snippet controls()}`).
- **P3 - the camera backdrop is painted from the first frame, before exposure settles**: near black
  in the post camera (3 of 3), teal on `/camera`. The live preview is grey.
- **P3 - an old reel still holds its first frame 250-267 ms at the loop** (published before the
  trim); new reels 67-83 ms.
- Observations: at `font_scale 2.0` the selected "Tout" tab sits under the clap icon until the tab
  row is scrolled (`s12-fs2-feed.png`); a system text size change reloads the page (the open viewer
  closes). In-app log export: 24198 lines, 2147637 bytes, `[download] wrote ...`; its W/E lines of
  the session are all the offline runs' transport failures. Logcat: no `FATAL`, no ANR; 99 `Ignoring
  status update of camera`, 34 `Failed to query component interface for required system resources:
  6` (codec stack).

## The Mi 9T readings of v1.2.9-alpha.3 (2026-10-16)

Build `1.2.9 (100200903)` (`dumpsys package`), the `v1.2.9-alpha.3` release APK
(`app-universal-release.apk`, sha256 `935dabda...`, tag commit `a5066d8e2`), installed with
`adb install -r` over alpha.2 (accepted, account kept), dev estate (deployed by the same release
run), account `fourth` ("Canari Test Delta"), bench conversations only, vault path. The phone uses
gesture navigation (`navigation_mode 2`, system Back zones 0-74 px and 1006-1080 px). Same
instruments as alpha.2 (`feed.mjs`, `reconnect.mjs` with its media probe narrowed to `main img`
wider than 150 px and `main video`, console over CDP, logcat), plus `st.mjs` (route, open
conversation, open dialogs, live camera, `history.length`). To give the dev feed media, ONE image
post (in-app camera photo) and ONE CanaReel (a 9.6 s take from the `/camera` swipe place) were
published, then both deleted at the end (`DELETE /api/posts/...` 200 each). Evidence:
`<harness-dir>/a1-bench/r1016-a129a3/` (frames `s*.png`, `feed-runs.ndjson`,
`reconnect-runs.ndjson`, `cons-*.ndjson`, `logcat-main.txt`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. CanaReels filter viewer (#1920) | **`PASS`** | Filter "CanaReels": the new reel first, then the two dev reels. A tap on the reel opens the viewer full screen ON that reel, playing (`[reel-viewer] paging the filtered feed "all" from <its publishedAt>`, `opened on 48e7a896...`, `page of 2, 3 loaded`). Drag up: `next: 0 -> 1` (the text-only dev reel); drag down: `prev: 1 -> 0`. ONE Back: `[reel-viewer] closed`, `0 left open`, the feed is still on "CanaReels" + "Tout" |
| 1b. Media after offline -> online (#1922) | **`PASS`** | n=2, offline cold start then airplane off at t=0: the status line goes and the refreshed page draws at **+6.2-6.3 s**; the photo is loaded (`complete`, `naturalWidth > 0`) at the same sample and the reel's video decodes (`readyState >= 2`) at **+8.2-8.3 s**. Offline, before the refresh, neither media is drawn: the cards show "Reessayer" (`[FEED-STORE] ... drawn, unconfirmed`) |
| 2a. Chat "+" menu / camera / review Back (#1925, Android unchanged by #1936) | **`PASS`** | One press per layer, `st.mjs` after each: "+" menu open -> Back 1 closes the menu, conversation kept. Camera (no take) -> Back 2 closes the camera. Photo review -> Back 3 shows "Abandonner cette capture ?" over the review; "La garder" keeps it; Back 4 the dialog again; "Abandonner" -> live camera; Back 5 closes the camera (`Back closes the camera (chat)`); Back 6 closes the conversation. Never two layers for one press |
| 2b. Salon row after Back | **`PASS`** | Bench community, "general": open, Back, n=3: the row's background stays `rgba(0, 0, 0, 0)`, not focused, no `aria-current` |
| 3. Editor edge gestures (#1936) | **`PASS`** | Reel editor (the `/camera` take) and the photo editor (post composer). Paint strokes starting at x = 120, 90 and 80 px draw and the editor stays. A stroke starting at x = 3 or 40 px is inside Android's own Back zone: it is a system Back (`[swipeBack] touch cancelled`, `Back with the editor open: the editor decides`) - with no edit the editor closes to the review, with an edit it asks "Abandonner vos modifications et revenir a la capture ?" and "Continuer a modifier" keeps them. A sticker dragged to the edge stops at x = 129 px; dragged back from there: reel editor 6 of 6 move, editor never left; photo editor 2 of 6 did not move (no log line, editor stayed), not reproduced afterwards |
| 4. PIN change, relaunch (#1935) | **`PASS`** | `Re-sealed under the new device key: messages=734 seeds=11 outbox=0; already new=0, unreadable=0, changed since read=0`, `2 stored feed page(s) dropped`, "PIN modifie" in 1.6 s. Kill and relaunch: `Device key restored from PinVault`, no keypad, the DM opens with 54 bubbles and 0 undecrypted, 0 warnings. Changed back: the same counts |
| 4b. Wrong PIN empties the field (#1935) | **`NOT-OBSERVED`** | The Android vault restores the key on every launch, so the PIN gate (`showPinGate`) is never drawn; reaching it needs a refused or missing vault, which was not destroyed for this |
| 5a. Online cold first paint | **`PASS`**, unchanged | n=3: first card **2254-2385 ms after `am start`** (page 1641-1693 ms; alpha.2 2397-2798). `[POSTS] stored first page drawn: 20 posts read in 345-372 ms`; the stored-copy line stays 0.39-0.57 s |
| 5b. Offline cold start noise | **`PASS`**, unchanged | n=3: **10** warnings each, the same ten families as alpha.2 |
| 6. Forms smoke (#1916/#1930) | **`PASS`** | The one paid form on dev ("Cotisation BDE 2026", private, opened by its id): `GET /api/forms/<id>`, `.../calendar-link`, `.../check` all 200, no crash, 0 warnings. Choosing "ICM" shows "Paiement Canari" / "En especes" and "Payer 60,00 EUR". Nothing paid |

**Findings:**

- **P3 - the paid form says "Combinaison indisponible" before any answer is chosen** (the banner,
  the footer and the button), with the price only after the first choice (`s51-paid-form.png`).
- **P3 - the feed mounts the reel's stream twice on a cold start**: two `[media-seg] stream ...
  through MediaSource` lines 133 ms apart, then `[video] playWhileVisible: play() refused` (once per
  cold start that draws the reel).
- **P3 - a camera photo is handed over as `canari-photo-<n>.bin`**: `[reel-capture] a take of an
  unknown type "image/webp" - named .bin`. The post published and showed the photo.
- **P3, still open from alpha.2 - back online, the refreshed feed shows 10 cards** where the stored
  page showed 20, and that page of 10 is now what the next offline start draws.
- **P3 - the URL does not carry the filter**: `location.search` is empty on "CanaReels", where
  [reels](frontend/modules/reels.md) decision 3 says a choice writes `kind=reel` into the URL. The
  filter still holds across the viewer and the cold starts.
- Observations: the dev banner covers the status bar on `/camera` (`s15-camera-tab.png`); a reel
  with no media shows a play button that plays nothing in the viewer; the bench salon logs `6
  message(s) of 87ac63f9 are unreadable - missing seed` (old bench history). Logcat: no `FATAL`, no
  ANR; 90 `Ignoring status update of camera` (Chromium camera stack).

## The Mi 9T readings of v1.2.9-alpha.2 (2026-10-15)

Build `1.2.9 (100200902)` (`dumpsys package`), the `v1.2.9-alpha.2` release APK
(`app-universal-release.apk`, sha256 `b3fcc8e2...`, tag commit `adf0b419d`), installed with
`adb install -r` over alpha.1 (accepted, account kept), dev estate, account `fourth` ("Canari Test
Delta"), bench conversations only, vault path. Offline means airplane mode (the phone has no mobile
data). Same instruments as alpha.1 (`feed.mjs`, console over CDP, logcat for the whole pass), plus
`reconnect.mjs` (offline cold start, 10 s, airplane mode off, 40 one-second samples) and `frames.mjs`
(the `mediaTime` of every presented frame of a take). Evidence:
`<harness-dir>/a1-bench/r1015-a129a2/` (frames `s*.png`, `feed-runs.ndjson`,
`reconnect-runs.ndjson`, `cons-camera.ndjson`, `frames-video1.json`, `logcat-main.txt`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. Offline cold start noise (#1921) | **`PASS`** | n=3, same window as alpha.1: **10** warnings each (alpha.1: 68-70). One line per family: `[A] refresh✗transport` once, `[LAYOUT] Profile check did not answer` (twice, P3), revocation check, `push_context` write, `[DISPLAYNAME] profile lookups get no answer` once, `[FEED-STORE] ... drawn, unconfirmed`, `[History] batch ... got no answer`, `[HISTORY] no answer for group ...`, `[PENDING] ... UNDRAINED and stays queued`. No `getToken failed ... proceeding without auth`, no page-size halving, no `[GRAINE] asked <self>`. Feed drawn from the device (20 cards, 2432-2699 ms after `am start`), never "Impossible de charger" |
| 1b. Back online without a restart (#1922) | **`PASS`** (refresh); media `NOT-OBSERVED` | Airplane off at t=0: `[CONNECTIVITY] browser reports online` +4.2 s (the radio), `server reachable again` +5.7 s, `[POSTS] server reachable again - the first page is asked again`, `200 GET /api/posts` +6.2 s; the status line is gone at the +7.2 s sample. `[PROMOTE] Access token acquired` at the same moment. **No post on the dev feed carries an image or video** (40+ cards of "Tout" and both reels scanned: no media element; the reels' API rows have `images: []`), so "media show after reconnect" could not be seen |
| 1c. Online cold first paint (#1922) | **`PASS`** for the stored-copy hang; first card **not** under 1 s from launch | n=4: first card **2397-2798 ms after `am start`** (page 1779-2135 ms; alpha.1 2465-2973). The "Fil enregistre..., mise a jour..." line now stays **0.24-0.54 s** (alpha.1: 3.0-3.6 s), and in 1 run of 4 the server answer came first (`stored first page read after the server answered - not drawn`). `[POSTS] stored first page drawn: 20 posts read in 333 ms`; `<- 200 GET /api/posts` ~0.5 s after. The PR's 650-736 ms was a reload of a warm process; from a cold launch, the app's own boot dominates |
| 2. CanaReels filter (#1920) | **`PASS`** (filter, relaunch); viewer `NOT-OBSERVED` | "Tous les posts" / "CanaReels" row under the header; CanaReels -> `GET /api/posts?...kind=reel` (`[POSTS] feed filter: all -> reel`), 2 reels listed; relaunch keeps "CanaReels" selected (stored page of 2 drawn). The row holds at 200 % text. **The two dev reels have no video** (`kind: reel`, `durationMs: 2219`, `images: []`), so the cards draw text only and a tap opens nothing: open / swipe to the next / return could not be read. Restored to "Tous les posts" |
| 3a. Chat camera Back (#1925) | **`PASS`** | "+" > "Ouvrir la camera", photo. Back 1: "Abandonner cette capture ?" OVER the review; "La garder" keeps it (`discarding the review: kept`). Back 2: the dialog again; "Abandonner" returns to the live camera. Back 3 closes the camera (`Back closes the camera (chat)`), the conversation stays. Back 4 closes the conversation. Logs `historyOverlay ... Back landed on an entry no overlay above owns - closing the top one` twice (P3, below) |
| 3b. Post composer video (#1925) | **`PASS`** | 3.5 s hold: `recording video/webm;codecs=h264,opus`, `take: 967955 bytes, video/x-matroska;codecs=avc1,opus`, `canari-video-*.mkv`, `[capture-poster] ... 3128-byte thumbnail attached`; the composer tile shows the frame, not a grey tile. Back closes the composer; reopening shows "Brouillon restaure (texte, options et medias)" with the video. Draft cleared afterwards, nothing published |
| 3c. Refused camera, fresh permission (#1925) | **`PASS`** | `pm revoke` + flags cleared; chat camera: ONE system dialog, "Ne pas autoriser", no second dialog in the next 6 s (focus stays on Canari). `app away with an open in flight - its answer is awaited`, `refused (denied)`, `back on screen in error - nothing to reopen`. Text: "Canari n'a pas acces a la camera" / "Autorisez la camera pour Canari dans les reglages du telephone, puis reessayez." (no microphone). Permission granted back afterwards |
| 3d. First frames of a take | **`PASS`** | The 2.975 s take plays 63 frames; first presented `mediaTime`s 0.003, 0.033, 0.100, 0.227...; largest gap 127 ms, spread over the whole take (a dim, still scene at ~21 fps), no hold at the start |
| 4. PIN change then relaunch (#1898) | **`PASS`** | `Re-sealed under the new device key: messages=734 seeds=11 outbox=0; already new=0, unreadable=0, changed since read=0`, plus `3 stored feed page(s) dropped - the next feed answer rewrites them`, "PIN modifie" in 1.6 s. Kill and relaunch: `Device key restored from PinVault`, no PIN prompt, the DM history decrypted, 0 warnings. Changed back: the same counts |
| 5. 200 % text and noise | **`PASS`** | `font_scale 2.0`: root 32 px, `/posts`, `/communities`, `/chat`, `/settings/about`, `/dashboard` all `scrollWidth = innerWidth = 436`; the only element past the edge is a truncated author name inside its `overflow: hidden` card. Restored to `0.85`. The whole online pass (1465 console lines): 2 warnings, the refusal itself and one `[TAURI] Couldn't find callback id` after a relaunch. Logcat: no `FATAL`, no ANR |

**Findings:**

- **P3 - back online, the refreshed feed shows 10 cards where the stored page and every cold start
  show 20** (`reconnect-runs.ndjson`: 20 -> 10 at the refresh, still 10 at +37 s). More may load on
  scroll; whether the reconnect path asks a smaller first page was not read.
- **P3 - the dev estate cannot read media in the feed**: no post carries an image or video, and the
  two reels come back with `images: []`. The reel viewer (#1920) and media after reconnect (#1922)
  need a reel published on dev, or another bench.
- **P3 - `[LAYOUT] Profile check did not answer` is logged twice** within 14 ms on an offline start.
- **P3 - the overlay history stack heals itself on Back**: `Back landed on an entry no overlay above
  owns - closing the top one`, then `1 left open` after the camera closed and `0 left open` with the
  conversation. The user-visible order is right; the stack and the history disagree by one entry.
- Logcat, camera stack (Chromium's, unchanged): 117 `Ignoring status update of camera`, 12
  `BLUETOOTH_CONNECT permission is missing`, 3 `cr_VideoCapture` lines.


## The Mi 9T readings of v1.2.9-alpha.1 (2026-10-15)

Build `1.2.9 (100200901)` (`dumpsys package`), the `v1.2.9-alpha.1` release APK
(`app-universal-release.apk`, sha256 `651f740e...`), installed with `adb install -r` over `1.2.8`
(accepted, account kept), dev estate, account `fourth` ("Canari Test Delta"), bench conversations
only, vault path. Settings > A propos reads "Version de Canari 1.2.9-alpha.1". The app console was
streamed over CDP and logcat captured for the whole pass. Evidence:
`<harness-dir>/a1-bench/r1015-a129/` (frames `s*.png`, `cons-*.ndjson`,
`logcat-main.txt`, `co-banc1/`, `feed-runs.ndjson`, `heart-runs.ndjson`, `flicker.txt`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. In-app camera everywhere (#1859) | **`PASS`, two findings** | Chat "+" > "Ouvrir la camera" and the new-post composer's "Ouvrir la camera" both open the in-app layer (`[camera-overlay] open for chat` / `for post`); focus is only ever Canari or the system permission dialog, no capture intent in logcat; "Photo/video" still opens the system photo picker. Chat: `opening user (no microphone)`, no microphone prompt; a 2 s HOLD gives a photo, not a video; "Ajouter" stages `canari-photo-*.jpg` (122 KB) as "1 fichier en attente", send gives an image bubble with its check mark. Camera refused: "Canari n'a pas acces a la camera" with "Reessayer" / "Ouvrir les reglages", no native fallback. Post: the microphone is asked at open; refused, `live with no microphone (post): photos only`, not asked again; granted, a 3 s hold records `video/webm;codecs=h264,opus` (1.07 MB) and "Ajouter" attaches it; the review has no sound button. The post was not published |
| 2. Right-edge exclusion (#1883) | **`PASS`** | `right-edge gesture exclusion: span=(292, 2152) -> ExclusionBand(left=987, top=1657, right=1080, bottom=2152)`; `dumpsys window` shows the same rect. The band follows the list: (292, 1949) with the reply bar, (292, 1757) with the keyboard up. Swipes from x=1070-1078 inside the band: 5 of 5 keep the conversation open; on an own bubble, 3 of 4 arm "Repondre a Canari Test Delta" (the miss was a 200 ms swipe), including with the keyboard open. Above the band (y=900) the system back still closes the conversation |
| 3. Back closes the message sheet (#1817) | **`PASS`** | Long press opens the sheet (reactions + Repondre / Transferer / Copier / Modifier / Supprimer); `KEYCODE_BACK` (2 of 2) and a left-edge back swipe (1 of 1) close the sheet only, the salon stays with its 54 bubbles and `history.state` returns to the conversation's entry |
| 4. Avatars without a photo (#1840) | **`PASS`** | Launch + hub + a 62-bubble salon: **0** avatar image requests, **0** `404` (CDP `Network` and the `[API]` lines); 9 `GET /api/users/avatar-presence`, each answered 200, and `[AvatarPresence] N of N have no photo - not requested`. P3: 7 of the 9 asked about ONE face, so the per-turn batching merges less than the PR's 30-in-1 test suggests |
| 5. Feed local-first (#1896) | **`PASS` offline, two findings online** | Offline cold (Wi-Fi and data off, n=4): the first card is drawn **2454-2561 ms after `am start`** (page 1781-1855 ms) from the device, 20 cards, "Fil enregistre sur l'appareil : pas de reponse du serveur." with "Reessayer", never "Impossible de charger". Online cold (n=7): first card **2465-2973 ms** after `am start` (page 1777-2189), the stored copy drawn every time. Warm (Feed tab tap from Communautes, n=4): **230-289 ms** touchstart to first card, from the in-memory cache. Heart during the first load (2 of 2): tapped on the stored copy while "mise a jour..." showed, `201 POST .../reactions`, then `[PostCardLedger] post 6c736e01: kept reactions over a row read at ...`; the count stays 1 |
| 6. Communities first mount and tabs (#1897) | **`FAIL` against 200 ms, better than 1.2.8, no flicker** | `community-open.mjs --community BancOuverture-1 --runs 6 --start cold --net none --cpu 1`, medians (worst): nav 1139, **tap>rail = tap>salons 384 (406)** [1.2.8 base 415-456], tap>target salons 717, salon>pane 304, salon>msgs 1048, switch>salons 158, **reopen>msgs 919 (967)** [965-1020]. Flicker watch (`flicker.mjs`, every frame's bubble count from the touchstart, 6 reopens of the same salon from the hub): first bubbles **237-265 ms**, counts `0 -> 20 -> 60`, **0 blank frames after the first bubble**: the stored page is not followed by an empty frame, so the instrument's ~920 ms reopen is not a flicker |
| 7. PIN change then relaunch (#1898) | **`PASS`** (change path; recovery not exercised) | Bench PIN to a temporary PIN and back, both in Settings > Securite: `[DEVICEKEY_CHANGE] Re-sealed under the new device key: messages=733 seeds=11 outbox=0; already new=0, unreadable=0, changed since read=0`, then `MLS state re-sealed`, "PIN modifie" in 1.6 s. Kill and relaunch: vault path, no PIN or recovery prompt, salon 63 bubbles (the photo of reading 1 included), DM 54 bubbles, the same 8 `[GRAINE] ... no-seed-held` asks as before the change (no seed lost). The outbox was empty, so a queued row's re-seal was not read. The other devices of `fourth` (W3) must re-enter the PIN |
| 8. 200 % text (Android) | **`PASS`** | `font_scale 2.0`: root font 32 px; `/posts`, `/communities`, `/chat`, `/settings/about`, `/dashboard` all `scrollWidth = innerWidth = 436`; the only elements past the right edge are the feed's chip rows inside their own horizontal scroller. Restored to the phone's `0.85` |

**Findings:**

- **P2 - Back from a camera review closes the camera first, then asks.** In chat, Back on a taken
  photo logs `[camera-overlay] Back closes the camera (chat)` and `camera-session stop`; the
  "Abandonner cette capture ?" dialog then shows over the conversation, and "La garder" keeps
  nothing (`the discard question was answered after the camera closed`), 2 of 2. The overlay's own
  comment promises "Back ends a recording, then discards a review, then closes the camera". The X
  on the review asks with the review still behind it, as designed.
- **P2 - A refused camera is asked twice.** The first `getUserMedia` is answered "denied" by the
  system dialog, but the dialog itself backgrounds the WebView (`app hidden - releasing the
  camera`), and its close re-opens the camera (`app visible - reopening`), which raises the
  permission dialog a second time. The microphone path does not do this (`already refused ... not
  asked again`).
- **P2 - Online, the stored feed stays on screen ~3 s after the server answered.** 4 of 4 timed
  runs: `<- 200 GET /api/posts` lands 0.06-0.5 s before `stored first page drawn`, yet the
  "Fil enregistre sur l'appareil, mise a jour..." status (no rights, no vote) shows for 3.0-3.6 s
  and clears **3.1-3.5 s after that answer**. Nothing in the console names what the answer waits
  on.
- **P2 against the expectation (not claimed by #1896) - back online, the stored feed is not
  refreshed by itself.** After an offline start, `[CONNECTIVITY] server reachable again` and
  `[PROMOTE] ... session is online` at 20:44:06, and 40 s later the feed still says "pas de reponse
  du serveur"; "Reessayer" replaced it (`200 GET /api/posts`, status gone).
- **P3 - Back closes the new-post composer holding a camera video with no question**, and the
  video is not in the composer when it is reopened.
- **P3 - the take reaches the post composer as `canari-video-*.bin`** (`video/x-matroska`), and its
  composer thumbnail is a flat grey tile.
- **P3 - the refusal screen says "Autorisez la camera et le micro"** in the chat camera, which never
  asks for the microphone.

**Noise met on the way (every line is a finding):**

- **Offline cold start: 70 warnings in 6 s.** Each API call logs `[API] getToken failed ... -
  proceeding without auth (TypeError: Failed to fetch)` and goes out unauthenticated; `[A]
  refresh-transport ... TypeError` per attempt; `[PENDING] page did not arrive (TypeError: Failed
  to fetch) - retrying with limit=250`, then 125, 62, 31, 15, 7, 3, 1 (eight requests halving a
  page size against a transport failure); `[DISPLAYNAME] profile fetch failed - this user renders
  as "unknown" for the next 120s` 6 times; `[MLS] revocation check unreachable - treated as NOT
  revoked`. Several still carry a raw `TypeError: Failed to fetch` where #1843 made a transport
  failure ONE type.
- **Every launch asks this account's own devices for the history of 8 bench communities**
  (`[GRAINE] asked 43319a65... (every device) ... reason no-seed-held`), before and after the PIN
  change alike.
- Logcat, Canari pids: no `FATAL`, no ANR. Chromium's camera stack: `E/cr_VideoCapture:
  CameraDevice.StateCallback onOpened` at error level, 45 `W/CameraManagerGlobal: Ignoring status
  update of camera 0`, `W/MessageQueue ... sending message to a Handler on a dead thread` at a
  recording's end; `W/cr_media ... BLUETOOTH_CONNECT permission is missing` per camera open.
- The online cold start's console carried **0** warnings or errors at launch.

## The Mi 9T readings of v1.2.8-alpha.1 (2026-10-15)

Build `1.2.8` (`versionName` from `dumpsys package`), the `v1.2.8-alpha.1` release APK installed with
`adb install -r` over the `1.2.7-alpha.3` build (accepted, no signature or downgrade refusal, account
kept), dev estate, account `fourth` ("Canari Test Delta"), bench conversations only. The phone is on
the vault path ("Rester connecte"), so no PIN gate was drawn. Evidence:
`<harness-dir>/a1-bench/r1015-a128/` (`runs.ndjson`, summaries). Dev had no push then (it sends since 2026-10-21),
so reading 5 could not be taken.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Start, version, unlock | **`PASS`** | Settings > A propos reads "Version de Canari 1.2.8-alpha.1" and "Vous utilisez la derniere version"; the app opened straight onto the feed on the vault path (a PIN-path unlock was not exercised) |
| 2. Communities and a salon | **`PASS`** | `community-open.mjs --community Bench126 --runs 3 --start cold --net none --cpu 1`, medians ms: attach 552, nav 1099, **tap>rail 1134** (worst 1243), tap>salons 2244, tap>target salons 2512, **salon>pane 277**, salon>msgs 1833, switch>salons 143, switch salon>pane 202, reopen>msgs 773; long tasks 728, max gap 443 |
| 3. Notification level, private conversation | **`PASS`** | The phone holds no group, only the DM with gamma (a bench account). Its "Infos de la discussion" panel shows Notifications with Tous / Mentions / Aucune; "Mentions" highlights, then "Tous" restores it. Persistence across a restart not read |
| 4. Reply swipe near the right edge (#1880) | **`PASS`** | A swipe on an own bubble from x=985 of 1080 with a 70 px vertical drift arms "Repondre a Canari Test Delta" with the bubble's text in the composer. **From x=1040 the system back gesture wins** and the conversation closes: the gesture zone is the system's, not the app's |
| 5. Group notification shows the sender | **`NOT-OBSERVED`** | No group on the phone and no push on dev that day (it sends since 2026-10-21) |
| 6. In-app log export | **`PASS`** | "Enregistrer le journal" saves `canari-log-1.2.8-alpha.1-20261015-0130.txt` (1.8 MB, 20471 lines) to Telechargements. All **397** `[SEND] handleSendChat` lines carry `text="[N chars]"`; no quoted value outside that shape, no `eyJ` or `Bearer`. The one-word leak of the 1.2.7 reading (`text="ok"`) is not present |

**Met on the way:** a tap on the profile settings icon during the page transition hit the camera badge
and opened the photo picker; it was cancelled without choosing. Tap again once the page is drawn.

## The Mi 9T readings of v1.2.8-alpha.2 (2026-10-15)

Build `1.2.8` (`versionName`), the `v1.2.8-alpha.2` release APK (`app-universal-release.apk`, sha256
`2ac1560f...`) installed with `adb install -r` over the alpha.1 build (accepted, no signature or
downgrade refusal, account kept), dev estate, account `fourth` ("Canari Test Delta"), bench
conversations only, vault path (no PIN gate drawn). The only delta since alpha.1 is #1889: a salon
message over the socket honours the salon's notification level. Evidence:
`<harness-dir>/a1-bench/r1015-a128a2/` (`runs.ndjson`, summary, frames, `log.txt`).
Dev had no push then (it sends since 2026-10-21), so what #1889 changes (a notification suppressed or kept) could not be observed.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Start, version, unlock | **`PASS`** | Settings > A propos reads "Version de Canari 1.2.8-alpha.2" and "Vous utilisez la derniere version"; the app opened on the feed on the vault path (a PIN-path unlock was not exercised) |
| 2. Communities and a salon | **`PASS`** | `community-open.mjs --community Bench126 --runs 3 --start cold --net none --cpu 1`, medians ms (alpha.1 in brackets): attach 329 [552], nav 1092 [1099], **tap>rail 1072** [1134] (worst 1088), tap>salons 1899 [2244], tap>target salons 2276 [2512], **salon>pane 279** [277], salon>msgs 1834 [1833], switch>salons 174 [143], switch salon>pane 201 [202], reopen>msgs 676 [773]; api calls 65, long tasks 699, max gap 439. Same shape as alpha.1, within run-to-run noise |
| 3. Notification level of a bench salon | **`PASS` (the control), the effect `NOT-OBSERVED`** | Salon "general" of a bench community: Parametres du canal shows Notifications with Tous / Mentions / Aucune, Tous selected; "Mentions" highlights, then "Tous" restores it. No push on dev that day (it sends since 2026-10-21), so a message received over the socket under Mentions/Aucune was not produced |
| 4. In-app log export | **`PASS`** | `canari-log-1.2.8-alpha.2-20261015-0223.txt` (2.15 MB, 23773 lines): 0 `eyJ`, 0 `Bearer`; of 383 `handleSendChat` lines, the 192 carrying a text all read `text="[N chars]"`, the rest are "completed (message queued)"; no bench message text (`coucou`, `heldA*`, `iosA3*`, `Rendez`) found |

## The iPhone 12 readings of v1.2.8-alpha.1 (2026-10-15)

TestFlight build `1.2.8-alpha.1` (the phone had not taken alpha.2 yet: Settings > A propos itself
offers "Une version plus recente (1.2.8-alpha.2) est disponible"), account `canari-test-gamma`, dev
estate, driven over WDA (`tools/ios-device`). The app opened on the PIN gate (no vault); the bench
account's PIN was typed on the keypad with the user's authorisation of 2026-10-15, and the gate
opened onto the feed. Bench community "Bench126" only; nothing sent, no account switched.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1. Start, version | **`PASS`** | PIN gate, then the feed; Settings > A propos reads "Version de Canari 1.2.8-alpha.1" |
| 2. Communities and a salon | **`PASS`** | The Communautes tab lists Bench126 and its "general" salon; the salon opened with its history drawn within the 3 s the tap was followed by (no stopwatch run; a feel, not a measurement) |
| 3. Notification level of a bench salon | **`PASS`** | Parametres du canal shows Notifications with Tous / Mentions / Aucune, Tous selected; Mentions selected (Tous 0, Mentions 1), then Tous restored (1, 0, 0). Effect not observed (no push on dev) |
| 4. Reply swipe (#1880) and back gesture | **`PASS`** | A rightward drag on a peer bubble ("Canari Test Delta") stages "Repondre a Canari Test Delta" and the conversation stays open; a leftward drag from x=350 of 390 on an own bubble stages "Repondre a Canari Test Gamma"; both cancelled with "Annuler la reponse". A left-edge drag (x=2 to 260) from the salon returns to the community's salon list |
| 5. In-app log export | **`NOT-OBSERVED`** | "Enregistrer le journal" opens the system "Enregistrer sous" picker (canari-log-1.2.8-alpha.1...) over an empty "Sur mon iPhone"; dismissed without saving. The file cannot be read off the TestFlight container from the workstation, so the absence of message text was not checked on iOS (the Android export of the same build is `PASS`) |

## The iPhone 12 readings of v1.2.9-alpha.1 (2026-10-15)

TestFlight build `1.2.9` (100200901), About reads "Version de Canari 1.2.9-alpha.1"; account
`canari-test-gamma`, dev estate, driven over WDA (`tools/ios-device`), timings by
`tools/phone-bench`. Evidence (screens, AX trees, syslog, `commtabs.ndjson`) is outside the repo in
the rig's `ios-bench/r1015-a129a1/`. Bench community only; nothing sent.

**Delivery.** At 19:50 the phone still ran `1.2.8-alpha.1` with auto-update ON: it never took
alpha.2. By 20:09 auto-update had silently installed the `1.2.8` STABLE (100200899, a production
build), never launched. The alpha.1 IPA reached TestFlight at ~20:09 (release run 38780575538);
TestFlight offered "Mettre a jour" to 100200901 at 20:12 and one tap installed it. "Builds
precedents" still lists nothing newer than 1.2.3 ([backlog](backlog.md)). After the update the app
was SIGNED OUT and asked camera and microphone permission again.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. Dynamic Type at cold start (#1884) | **`PASS`** | PIN title 202x30 at default, 272x41 at the largest standard size (1.35x), 2x at the largest accessibility size; feed text and bubbles scale with it |
| 1b. Default size unchanged | **`PASS`** | PIN gate identical to `1.2.8-alpha.1` at default |
| 1c. Size changed while backgrounded | **`FAIL`** (P2) | 3 of 3: the "A propos" link kept its old size on return (64x22, 86x30, 128x42 stayed put); the new size applies only after a cold start |
| 1d. Layout at 2x | **findings** | P2: the PIN keypad is mostly below the fold - digits 7-0, "Saisie manuelle", "PIN oublie ?" and "Rester connecte" sit behind the sticky Deverrouiller button, and scrolling to them pushes the dots off screen (the links are already hidden at 1.35x). P3: the community rail's salon name does not scale while "Ajouter un canal" does. P3: feed titles break mid-word ("personnalisati/on") and the header wordmark is dropped. Settings rows and the glass title pill truncate with an ellipsis; the composer and tab bar (icons) are fine. Reel text overlay `NOT-READ` |
| 2. In-app camera (#1859) | **`PASS`** + P2 | Chat "+" > "Ouvrir la camera" and the post composer's "Ouvrir la camera" both open the in-app dialog ("Photo (toucher) ou video (maintenir)", "Changer de camera"). P2: in the chat, the conversation's glass chrome (back, title pill, menu, "+") paints ON TOP of the viewfinder; the post composer's camera is clean. The post camera asks for the microphone at open, the chat camera does not |
| 3. Feed local-first (#1896) | **`PASS`** + P2 | Offline in session, the feed draws under the offline banner (not separable from memory). A cold unlock right after Wi-Fi returned showed "Fil enregistre sur l'appareil : pas de reponse du serveur." with "Reessayer" - the device copy - and did NOT refresh by itself in 20 s (P2); "Reessayer" replaced it. A normal online cold unlock shows no status line. A "Voir plus" tap made right after unlock still held 4 s later. Cold start offline stops at the PIN gate ("Impossible de contacter le serveur", by design) |
| 4. Communities tab (#1897) | **`PASS`** (taps); timings `NOT-MEASURED` | Taps switch tabs. `bench.timed_action`: warm first 800-858 ms, settled 1237-1299 ms; cold first mount 804 / 1183 ms - no first-mount penalty. But the harness dispatch median is 1031 ms (522 ms on 2026-09-30), above the app's latency, so the absolutes are not a measurement |
| 5. PIN change, then relaunch (#1898) | **`FAIL`** (P1) | Settings > Securite & appareils > the key button (no AX label, P3) > "Changer mon PIN". The submit said "Le changement de PIN n'a pas abouti. Reessayez dans un instant." while the dev access log shows `POST /api/mls/security/pin-change` **201**; the retry got 403 ("Le PIN actuel est incorrect."). The server rotated, the local re-seal did not. On relaunch the old PIN is refused, the new one passes the server check and lands on "Vos messages enregistres sur cet appareil n'ont pas pu etre ouverts"; "Recuperer mes messages" (old -> new) fails twice with "La recuperation du PIN n'a pas abouti" after `pin-salt` and `pin-check` 201. The device's messages stay locked. No app-level error in the syslog or core-service log. P2 in both dialogs: with the keyboard up the sticky submit button covers the next field, so tapping it submits the form ("Veuillez remplir tous les champs") and the focused field is hidden while typing |
| 6. | skipped | by the brief |
| 7. Noise | **findings** | Native syslog only (the JS log cannot be read off a TestFlight build): "keyboard accessory bar NOT removed: no WKContent view" (7x per session), "remote notification hook: selector absent on AppDelegate", "push diagnostic: no-apns-token", "APNs token not here yet", UIKit "may only be set for UIKBDynamicRenderFactory" on keyboard show. P3: native lines in French ("FCM token synchronise", "secret plus recent adopte depuis pending_push_secret.txt", "FCM delegate installe") |

**State left behind.** `canari-test-gamma`'s dev PIN is now a scratch PIN held by the rig operator,
not the one in `test-accounts.json`, and the iPhone's local store is sealed under the old PIN and
cannot be opened. Either the account PIN goes back or the harness file follows.



## The iPhone 12 readings of v1.2.9-alpha.2 (2026-10-16)

TestFlight build `1.2.9` (100200902), About reads "Version de Canari 1.2.9-alpha.2"; account
`canari-test-gamma`, dev estate, driven over WDA (`tools/ios-device`). Evidence (screens, AX trees,
syslog, two in-app log exports) is outside the repo in the rig's `ios-bench/r1015-a129a2/`. Bench
community only; nothing sent. The phone has no device passcode.

**Delivery.** Release run 38809585188 finished at ~23:45. At 23:51 TestFlight offered
"Mettre a jour" to 100200902; auto-update had not taken it yet, and one tap installed it. This time
the app was NOT signed out.

**The in-app log CAN be read off a TestFlight build.** Settings > A propos > "Enregistrer le journal"
saves it to "Sur mon iPhone". The Files app's Quick Look shows it, and WDA's element text on its
`TextView` returns the whole file (172 KB). So the line in the alpha.1 reading saying "the JS log
cannot be read off a TestFlight build" was wrong: the log existed. The second export holds every
session since 2026-10-14, the alpha.1 ones included.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. PIN recovery from the alpha.1 left state (#1923) | **`PASS`** + P2 | The server PIN gives "Vos messages ... n'ont pas pu etre ouverts". "Recuperer mes messages" (old PIN -> server PIN) logs `[PIN_RECOVER] Complete - messages preserved` and lands on the feed; the salon's messages read. P2: a banner "Certaines conversations n'ont pas pu etre restaurees" appears, with `[INIT] Partial restore: 0/1 conversation(s) hold their MLS group (missing 3122333c)`. The external join for that same group then fails with `group 3122333c already present locally`, which contradicts "missing". The next cold start applied the queued commit and logged past-epoch frames from the peer as `LOST` |
| 1b. PIN change, relaunch, change back | **`PASS`** | Scratch -> new PIN: the dialog closes with no error. The syslog shows LocalAuthentication `-5 "Passcode not set"` and then only `SecItemAdd` with no failure. The relaunch unlocks on the new PIN and the salon reads. New -> the `test-accounts.json` PIN: same result. The alpha.1 P2 is fixed: the focused confirm field sits above the submit button with the keyboard up. The alpha.1 P3 is fixed: the key button is now labelled "Changer" |
| 2a. Text size changed while backgrounded (#1926) | **`PASS`** 4 of 4 | The new size applies on return, with no cold start. "A propos" goes 64x22 -> 86x30 (largest standard) -> 128x42 (largest accessibility), and back to 53 pt filter buttons at default. The PIN gate title is 272x41 on return at the largest standard size. The syslog logs `Dynamic Type body published to the page: 17.0 / 23.0 / 53.0 pt` at each return |
| 2b. Layout at the largest sizes | **`PASS`** + P2 | The rail salon name now scales ("general" 281x64). Headings hyphenate ("person-/nalisation"), at default too. The CanaReels filter row holds at 390 wide; at the largest size "Tous les posts" wraps onto two lines. Still P2 (from alpha.1): at the largest standard size "Saisie manuelle" and "PIN oublie ?" sit behind the sticky Deverrouiller button, and at the largest accessibility size the keypad's rows 7-0 do too. Still P3: the header wordmark is dropped at the largest size |
| 3a. Chat camera under the glass chrome (#1926) | **`PASS`** | "+" > "Ouvrir la camera" shows only the camera's own close and flip buttons over the viewfinder. The native back, title pill and menu are hidden |
| 3b. Back with the camera and the "+" menu (#1925) | **`FAIL`** (P2) | Over the photo review, the left-edge swipe does nothing (2 of 2), although [reels-in-chat](frontend/modules/reels-in-chat.md) says it discards a review and closes the camera. The review's X asks "Abandonner cette capture ?"; "La garder" returns to the review and "Ajouter" stages the photo. After that, ONE Back leaves the conversation, so no ghost entry is left. With the "+" menu open, ONE Back closes the menu AND leaves the conversation (2 of 2), where it should close only the menu. The staged photos survive leaving the conversation as a draft |
| 4a. Feed offline then online (#1922) | **`PASS`** | Offline in a session, the feed draws under the "Hors connexion." banner. Back online, `GET /api/posts` leaves 0.3 s after `browser reports online` and the banner goes. Sampled for 80 s: no offline/online flap, and no presence or `TransportFailure` line after the reconnect |
| 4b. CanaReels filter (#1920) | **`PASS`** | Taps switch to "Pas encore de CanaReels" with "Ouvrir la camera", then back |
| 5a. Native noise at cold start (#1926) | **`PASS`** + P3 | 5 launches: "keyboard accessory bar removed" once each, 0 "NOT removed"; the APNs line once; app lines in English. P3: Firebase's own `<ERROR> Error while reading embedded mobileprovision` once per cold start (no profile in a TestFlight build). "remote notification hook NOT installed" stays as a known item ([backlog](backlog.md)) |
| 5b. Offline cold start (#1921) | **`PASS`** + P3 | Airplane mode: 22 in-app lines up to the PIN gate, 3 `W`: `refresh✗transport` once, and `[LAYOUT] Profile check did not answer` TWICE, an identical pair (P3). The unlock says "Impossible de contacter le serveur" (by design) and `refresh not sent` is held. No storm. P3: the gate keeps the digits of the failed offline attempt and appends the next ones (12 dots), which costs one "PIN incorrect" |
| 5c. In-app log | **findings** (P2, P3) | P2: `stored: failed (Error: log write failed)` and `E [APPLOG] the in-app log is no longer written to disk` at 00:07:07, the return from Settings at the largest size. The 00:00 and 00:06 sessions are missing from a later export, which reads `stored: ok`. P3: offline in a session, the WS reconnect loop logs `E [WS] Gateway connection failed` on every attempt (6 in 61 s) while the browser reports offline |

**State left behind.** `canari-test-gamma`'s dev PIN matches `test-accounts.json` again. The
iPhone's local store opens under it. Text size is at the default, airplane mode is off and the
composer draft is empty. Two exported logs remain in "Sur mon iPhone".

## The iPhone 12 readings of v1.2.9-alpha.3 (2026-10-16)

TestFlight build `1.2.9` (100200903), About reads "Version de Canari 1.2.9-alpha.3"; account
`canari-test-gamma`, dev estate, driven over WDA (`tools/ios-device`). Evidence (screens, AX trees,
the app's own syslog lines, in-app log exports) is outside the repo in the rig's
`ios-bench/r1016-a129a3/`, with `marks.txt` timing every step. Bench community and the bench DM
only; nothing sent, nothing paid.

**Delivery.** Release run 38825712616 finished at ~02:05. TestFlight offered "Mettre a jour" to
100200903 at 02:17; one tap installed it, and the app was NOT signed out.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. Edge swipe with the "+" menu open (#1936) | **`FAIL`** (P2) | 3 of 3 (DM twice, salon once): ONE left-edge swipe closes the menu AND leaves the conversation, as on alpha.2. A plain tap at the left edge with the menu open closes only the menu. The cause is not read: the `[historyOverlay]` lines are debug, and the in-app log does not record them. First thing to check: whether the menu is already closed (and off the stack) by the gesture's start, so that the swipe's end finds the conversation on top |
| 1b. Edge swipe with nothing open | **`PASS`** | It leaves the conversation (DM and salon), and the salon row "general" is NOT left highlighted |
| 1c. Edge swipe over the camera's photo review (#1936) | **`PASS`** | The swipe asks "Abandonner cette capture ?". "La garder" keeps the review, and the next swipe asks again. "Abandonner" leaves the live camera open; the next swipe closes the camera and stays in the conversation |
| 1d. Paint stroke from the left edge in the editor | **`PASS`** | A stroke dragged from x=2 draws a line from the edge; the editor stays and nothing asks to leave. A sticker dragged from the edge `NOT-READ` |
| 1e. Edge swipe while filming | `NOT-READ` | WDA did not hold the shutter as a video take: a 3.5 s press and a two-finger press-and-swipe both produced a PHOTO review |
| 1f. Legal document page back | `NOT-READ` | Signed in, no screen links to `/legal/*` (only the login page does); not worth a sign-out |
| 2a. PIN change, relaunch, change back (#1935) | **`PASS`** | Account -> scratch: "PIN modifie" in under 1 s. Relaunch, scratch PIN; scratch -> the `test-accounts.json` PIN; relaunch, unlock: the feed, the salon and the DM read, and no "Certaines conversations n'ont pas pu etre restaurees" banner. The log of the second unlock after it (the first one's lines went with 3e) has no `Partial restore` and no `already present locally`, and reads `[MLS][Tauri] group caches rebuilt from the native manager - 2 group(s)`. The interrupted state was NOT reproduced: a kill 300 ms and 650 ms after the submit left the server PIN unchanged both times |
| 2b. Refused PIN empties the field (#1935) | **`PASS`** | Online: a wrong PIN gives "PIN incorrect ..." and the dots go back to the empty placeholder. Offline: "Impossible de contacter le serveur", and the field is empty too |
| 2c. Largest accessibility size on the PIN gate (#1935) | **`PASS`** + P3 | Rows 7-0, "Saisie manuelle" and "PIN oublie ?" scroll into view on a drag up, and the keypad unlocks from there. P3: the "Rester connecte sur cet appareil" row stays half under the sticky Deverrouiller button at the end of the scroll |
| 3a. Text size changed while backgrounded | **`PASS`** | "A propos" 64x22 -> 86x30 (largest standard) -> 126x42 (largest accessibility), no cold start; back to 53 pt filter buttons at the default |
| 3b. Feed offline then online | **`PASS`** | The feed tab opened offline shows "Impossible de charger les posts" under "Hors connexion."; back online the posts draw by themselves within 8 s and the banner goes |
| 3c. Native noise | **`PASS`** | 8 launches: "keyboard accessory bar removed" 8, "NOT removed" 0; Firebase's mobileprovision `<ERROR>` once per launch and "remote notification hook NOT installed", both known from alpha.2 |
| 3d. Offline cold start | **`PASS`** | Airplane mode, cold start (twice): the gate draws and stays; the offline unlock says "Impossible de contacter le serveur" (by design). Back online, the unlock goes through |
| 3e. In-app log | **findings** (P2) | The alpha.2 P2 again, with the same trigger: `E [APPLOG] the in-app log is no longer written to disk (failed): Error: log write failed` at 03:21:39, leaving for Settings at the largest accessibility size. The export after it reads `stored: failed` and holds ONLY the session begun at 03:20 (19 KB, against 191 KB an hour earlier). The next export, after a cold start, is back to `stored: ok` and 216 KB |
| 4. Paid form on dev (#1916, #1930) | **`PASS`** (observation) | `fr.emse.canari://form/<id>` opens "Cotisation BDE 2026" with no crash (this account's answers hit "Combinaison indisponible"). `fr.emse.canari://payment/success?submission_id=<unknown>` shows "Paiement introuvable" with "Retour aux formulaires", right for an id that does not exist; the waiting state needs a real pending submission and was not read. P3: that page's title is still "Paiement reussi - Canari" over "Paiement introuvable" |

**The rig.** `phone-ios.mjs`'s `setAirplaneMode` failed on iOS 27 in French: Control Center's
toggles answer "Oui" / "Non", and a status-bar image labelled "Wi-Fi" sits above the Wi-Fi toggle.
Both are fixed in this PR (`switchState` reads "Oui" / "Non"; `setSwitch` takes the labelled element
that answers as a switch). Airplane on and off then read back right four times.

**State left behind.** `canari-test-gamma`'s dev PIN matches `test-accounts.json`, and the
iPhone's local store opens under it. Text size is at the default, airplane mode is off and both
composer drafts are empty. Five exported logs remain in "Sur mon iPhone".

## The iPhone 12 readings of v1.2.9-alpha.4 (2026-10-16)

TestFlight build `1.2.9 (100200904)`, Settings > A propos reads "Version de Canari 1.2.9-alpha.4",
account `canari-test-gamma`, dev estate, driven over WDA (`tools/ios-device`). Evidence (screenshots,
the three in-app log exports read in Files Quick Look, a syslog capture) is under
`canari-harness/ios-bench/r1017-a129a4/` on the bench workstation. Nothing sent, nothing paid.

**Delivery.** Release run 38888170609 finished green at about 12:53; at 13:02 TestFlight offered the
build with "Mettre a jour" (auto-update had not taken it yet), installed by 13:04. The app came back
on the PIN gate, not signed out.

**Instrument note.** `ios.mjs swipe` is an XCUI press-and-drag: it draws no paint stroke and its
second swipe on the photo review did nothing 3 of 3. A W3C `gesture` touch sequence (x=2 to 260)
does both, so 1c and 1d are read with it; 1a was read with both and they agree.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. "+" menu open, ONE edge swipe (DM x3, salon x3) | **`FAIL` (P2)** | 12 of 12 (6 XCUI, 6 W3C): the swipe closes the menu AND leaves the conversation. The in-app log has one `I [historyOverlay] gesture Back closes overlay N, 0 left open` per swipe (13:07:20.438, 13:07:51.685, 13:08:07.118, ...) and 0 `gesture Back spent`: the menu was on top at the commit and was closed by the overlay owner, and a SECOND Back path then left the conversation, one the in-app log does not name (candidates, not proven: the WKWebView back-forward swipe, or the conversation's own swipe owner also committing) |
| 1b. Edge swipe with nothing open | **`PASS`** | Leaves the conversation, in the DM and in the salon |
| 1c. Photo review "Abandonner ?" | **`PASS`** | The swipe asks "Abandonner cette capture ?"; "La garder" keeps the review and a second swipe asks again; the review's X asks, "Abandonner" returns to the live camera, the next swipe closes the camera and stays in the conversation |
| 1d. Paint stroke from the left edge | **`PASS`** | A stroke from x=2 draws and the editor stays; its back arrow asks "Abandonner vos modifications et revenir a la capture ?" |
| 2. In-app log across Settings at the largest text size | **`PASS`** | Export at 13:32 after the trip: header `# stored: ok`, 2974 lines, 241 KB, sessions back to 2026-10-14 kept. The 14:21 export (262 KB) carries `13:32:15.602 I [APPLOG] a write was cut short as the app left the screen (Error: log write failed) - 23 lines kept, for the return`, then a clean resume |
| 3. PIN gate at the largest text size | **`PASS`** | At the end of the scroll "Rester connecte sur cet appareil" is fully visible above Deverrouiller, with "Saisie manuelle" and "PIN oublie ?"; rows 7-0 reachable and the unlock from the scrolled keypad works. P3: before scrolling, Deverrouiller (y 665-742 pt) overlaps rows 7-9 (654-732) |
| 4. `payment/success?submission_id=<unknown>` | **`PASS`** | Deep link with a nil UUID: WebView title "Paiement introuvable - Canari", heading "Paiement introuvable", link "Retour aux formulaires". P3: the hidden route announcer still reads "Verification du paiement... - Canari" |
| 5a. Feed header | **`PASS`** | One row: Associations / Suivis / Tout and the "Ouvrir les CanaReels" icon at the right, 44x44 pt; at the largest size the tabs scroll and the icon stays |
| 5b. Reel viewer | **`PASS`** | The clap opens the full-screen viewer at the newest reel; avatar and name bottom-left over a scrim; the backdrop is PAINTED on the first reel (mean RGB top 85,83,75, bottom 55,57,50, not black); it loops, a 16-frame burst shows no still longer than 0.6 s; the left-edge swipe returns to the feed |
| 5c. Swipe to the next reel | **`FAIL` (P2)** | The swipe moves, but reels 2 and 3 (another author's, 9 and 8 Oct.) show only the yellow play button on a dark gradient: no "Lecteur video" in the AX tree, a tap on play does nothing; reel 1 plays again when swiped back. Cause NOT read: a Quick Look search of the export found no line at the minute of the swipe. P3: the author link's AX rect is 16,-196 242x869 |
| 5d. "Voir plus", caption scroll, tap folds | **`NOT-OBSERVABLE`** | No reel on dev has a caption past 2 lines, and posting one is outside this reading |
| 6a. PIN change + relaunch | **`PASS`** | "PIN modifie..."; after terminate + launch the old PIN is refused and the new one opens the feed with no restore banner, the DM reads; changed back. P2 still present: with the keyboard up the confirm field sits behind the sticky "Changer mon PIN" button and is reachable only after blurring |
| 6b. Refused PIN empties the field | **`PASS`** | "PIN incorrect : ce PIN ne correspond pas..." and the field returns to its placeholder |
| 6c. Text size on return | **`PASS`** | Back from Settings at the largest size, the "A propos" link measures 126x42 pt, no cold start |
| 6d. Offline cold start | **`PASS`** | Airplane mode, terminate + launch: a calm PIN gate; an unlock reads "Impossible de contacter le serveur. Verifiez votre connexion puis reessayez.", the field empties, stable after 20 s; airplane off, the unlock reaches the feed |

**State left behind.** Canari unlocked in front on dev (Settings > A propos), default text size,
airplane mode off, the bench account's PIN as in the harness file, composer drafts empty. Three log
exports remain in Files > Sur mon iPhone.

## The bench readings of v1.2.7-alpha.2 (2026-10-14)

**Mi 9T**: build `1.2.7 (100200702)`, the release's `app-universal-release.apk` (sha256
`99379a80...`), installed with `adb install -r` over alpha.1: same signature, the enrolment of
`fourth` ("Canari Test Delta") survived, PIN gate first. Numbers from CDP on the inspectable WebView,
logcat and the in-app log export. **iPhone 12**: TestFlight `1.2.7 (100200702)`, account
`canari-test-gamma`, driven over WDA; the native lines read from the device syslog
(`pymobiledevice3 syslog live -pn Canari`). Dev still sent no push then (it sends since 2026-10-21). Evidence:
`<harness-dir>/a1-bench/r1014-a127a2/` (frames, `cons-*.ndjson`, `logcat-*.txt`,
`inapp-log.txt`) and `.../ios-bench/r1014-a127a2/` (frames, `syslog-canari.txt`).

**How the iPhone got the build.** TestFlight's app page offered `1.2.7 (100200702)` with "Mettre a
jour"; the phone was on `1.2.3 (100200305)` with "Mises a jour automatiques" OFF (turned off by the
2026-10-11 install from "Builds precedents"). One tap updated it, the enrolment survived (PIN gate),
and automatic updates are now ON. **Watch it**: with them on, a later STABLE build (which talks to
production) replaces the bench pre-release by itself, as on 2026-10-11.

| Reading | Phone | Verdict | What was seen |
| --- | --- | --- | --- |
| #1843 offline banner text | Mi 9T, iPhone | **`PASS`** | "Hors connexion. Vous pouvez lire vos conversations. Les messages de vos conversations privees partiront des le retour du reseau ; dans un salon, attendez la connexion pour ecrire." on both (`14-off-cold.png`, iPhone `26-offbanner.png`) |
| #1843 offline cold start: the community list | Mi 9T | **`FAIL` against the expectation, not a regression** | On the vault path (a PIN-only cold start cannot unlock offline, by design, check N), the rail is EMPTY offline: "Selectionner ou creer une communaute" (`15-off-comm.png`). Nothing in alpha.2 claims a cached rail; recorded so nobody reads the banner as a promise of one |
| #1843 a salon send whose community is not loaded | Mi 9T | **`PASS`** | Deep link to the salon offline, send: "En attente..." and `[SEND] channel send 8a11887e... HELD: salon a4b30b40 is not loaded on this device yet`, no error (`20-off-sent-15s.png`) |
| #1843 network back | Mi 9T | **`PASS`** | `[WORKSPACE-LOAD] reconnect - listing the communities again (the last one gave up)`, a first attempt that raced the radio (`attempt 1/4 failed: TransportFailureError`, retryable), `[CONNECTIVITY] server reachable again`, `reconnect during a reconnect's own listing - nothing owed`, `released: its salon is loaded`, `communities/channels loaded (attempt 2)`: the rail and the held send settle **3.3 s** after the online event; the message left ONCE (`settled as d9513a22`; gamma's iPhone shows it once). **No** `non-retryable`, **no** `[WORKSPACE-LOAD]` line in the 75 s after |
| #1843 failure lines in the exported log | Mi 9T | **`PASS`** | `TransportFailureError: request got no answer: error sending request for url (https://dev.canari-emse.fr/api/presence?[query]` - the query string is redacted |
| #1842 orphan WebView on a navigation-mode switch | Mi 9T | **`PASS`, one P3** | Six switches (`cmd overlay enable-exclusive` threebutton/gestural): CDP lists **ONE** page, attached, after each. A salon text refused offline before the first switch ("Non confirme") came back: `[SEND] unanswered salon message 05b01dbd... of a past session restored to the composer` (`31-switch1.png`). **P3**: the composer is not kept across a relaunch, so that restored text (and any typed draft, `sheet-38-39.png`) is LOST at the next relaunch |
| #1842 kill/relaunch, background x3, notification intent warm and killed | Mi 9T | **`PASS`** | One page each time, the salon opens from the intent. Logcat: no `FATAL`, no ANR, no destroyed-WebView warning. Four `[TAURI] Couldn't find callback id 1269519213` warnings (the SAME id) after the relaunches: a Rust callback of the first page still fires into the new one (P3 noise) |
| #1839 redaction of the exported log | Mi 9T | **`FAIL`, P2** | The alpha.2 lines are clean: `contact="[17 chars]" text="[9 chars]"`, 0 one-word text, 0 name. **But the export still carries the alpha.1 lines** of the ring, written before the upgrade with the old redaction: 10 lines with `text="coucou"`, `text="ok"`, `text="refuse1-a127"`. Redaction runs at WRITE (`appLog.ts`), never at export, so an upgraded device keeps exporting what the older build let through until the ring rolls over |
| #1835 blind salon banner offers no "Lu par" | Mi 9T | **NOT READ** | Dev sent no push then (it sends since 2026-10-21), so no salon banner could be produced |
| #1841 a join is acknowledged after its checkpoint | Mi 9T | **`PASS`** | Fresh state (`pm clear`), sign-in, PIN: each of the 3 `externalJoin succeeded` lines comes right after an `Encrypted state checkpoint persisted` |
| #1844 the empty store opens with its digest; checkpoints per rejoined group | Mi 9T + iPhone | **`PASS`** | No member was online at the rejoin (`no member online for 3122333c - will ask when one returns`). Unlocking gamma's iPhone woke it: `[HISTORY_RECONCILE] a peer came back online`, then `[HISTORY_DIGEST] Sent for 3122333c - ids mode, 0 id(s)` as the FIRST leg (no state key), and 466 messages back in three bundles. **Checkpoints (native `manager lock held` lines): 9 for the 3 joins (3.0 per group), then 3 for the one exchange (1 + 2 drains)**; 15 in the 11 min after the sign-in, against 247 in 432 s on alpha.1. Lock held 0 ms 13 times of 15 |
| Salon tap, community rail, long-press menu | Mi 9T | **`PASS` in part** | A salon tap opens it; the rail fills. "Marquer tout comme lu" and the typing bubble were not read (no peer driving the salon) |
| Sign out, then sign in again, in the same process | Mi 9T | **`FAIL`, P1 candidate (2 of 2)** | Below |
| Nothing fatal | Mi 9T | **`PASS`** | Four logcat captures: no `FATAL`, no ANR, no crash |
| #1836 cold-start link | iPhone | **`PASS`** | App terminated, `fr.emse.canari://chat/channel_a4b30b40...`: syslog `[CanariDeepLink] scene connected with 1 launch url(s) and 0 web activit(ies)`, PIN, then the salon "general" (`t11.png`). Same for `fr.emse.canari://open?url=https://canari.emse.fr/notifications` cold (`t13.png`) and warm (`t12.png`) |
| "Ouvrir dans l'application" from Safari, app killed | iPhone | **`PASS`** | `canari.emse.fr/login` shows the link, Safari asks "Ouvrir dans << Canari >> ?", the line above is logged, and after the PIN the app is on `/chat` (`t16.png`) |
| Sanity: open, send, no crash | iPhone | **`PASS`** | `iosA2send` in the DM: check mark, decrypted on the Mi 9T |
| Redaction on iOS | iPhone | **NOT READ** | The exported file cannot be pulled off the TestFlight app's container; the redaction is the same JS module as Android |

**The P1 candidate: a sign-out then a sign-in in the same process never unlocks.** On the vault path
("Rester connecte" ticked earlier), Tableau de bord > Deconnexion, then "Connexion externe
(service-account)": the OIDC callback completes (`handleOidcCallback resolved`, `goto -> /posts`)
but NO PIN gate and NO vault restore follow; Communautes and Discussions sit on "Connexion en
cours..." for 4 min (`52-longpress.png`, `56-signin2-60s.png`), no avatar in the header. Twice, same
sequence (`cons-signin.ndjson`, `cons-signin2.ndjson`). In both, the resume of the app coming back
from the browser races the callback: `[A] refresh-latched (cookie already proven dead)` then
`[AUTH] Session expired - redirecting to /login.` and `[A] session->F`, 1-2 s BEFORE the callback's
`got access_token`. A kill and relaunch then opens with NO PIN: `[PIN] Device key restored from
PinVault - auto-login`, so **the "Rester connecte" vault survives the sign-out** (P2 on its own: a
signed-out device reopens without its PIN). A fresh state (`pm clear`) signs in correctly to the PIN
gate. Whether the PIN path (no vault) shows the same hang was not read.

**Also met:** on the Mi 9T, while offline, `Failed to fetch presence` is logged at ERROR level every
10 s and `[API] getToken failed ... proceeding without auth` at WARN for every request (24 times
for the workspace listing alone), and `[PENDING] page did not arrive ... retrying with limit=N`
halves the page from 250 to 1 on a transport failure: ~300 warning lines for 4 offline minutes (P3,
noise). On the iPhone, the feed read "Impossible de charger les posts" after an unlock just after the
network came back and did not retry by itself until "Reessayer" (P3). The tab bar keeps the last
tab highlighted on `/notifications` (P3, cosmetic). The Mi 9T is LEFT on a fresh device of `fourth`
(PIN path, "Rester connecte" unticked).

## The bench readings of v1.2.7-alpha.3 (2026-10-14)

**Mi 9T**: build `1.2.7 (100200703)`, the release's `app-universal-release.apk` (sha256
`96903cde...`), installed with `adb install -r` over alpha.2: same signature, the enrolment of
`fourth` survived, PIN gate first. **iPhone 12**: TestFlight offered `1.2.7 (100200703)` with
"Mettre a jour" although automatic updates were ON (the build was ~30 min old); one tap updated it
and the enrolment of `canari-test-gamma` survived (PIN gate). Evidence:
`<harness-dir>/a1-bench/r1014-a127a3/` (`export1-3.txt`, `export-*.json`,
`ring-*.txt`, `cons-offline.ndjson`, `logcat-main.txt`, frames) and `.../ios-bench/r1014-a127a3/`
(frames, `syslog-canari.txt`).

**How the old lines were produced.** The alpha.2 reading ended on a `pm clear`, so the ring held no
line from alpha.1 any more (411 lines from 12:18, every value already `[N chars]`). The 10 leaking
lines of the alpha.2 export (`inapp-log.txt`: `text="coucou"`, `"ok"`, `"refuse1-a127"`, ...) plus one
`contact="alice" text="coucou"` line were written VERBATIM into `CanariDBLog` as one chunk, over CDP,
while alpha.2 still ran (`inject.mjs`, `old-lines.txt`) - the bytes an older build stores, placed by
hand. alpha.3 was installed over that.

| Reading | Phone | Verdict | What was seen |
| --- | --- | --- | --- |
| #1861 the old lines are redacted at export | Mi 9T | **`PASS`** | The 11 lines come out `contact="[17 chars]" text="[6 chars]"` (`[5 chars]` for `alice`); 0 hit for any known string, 0 `text=`/`contact=` value that is not `[N chars]`, in all three exports. Header `555 lines - 24 values redacted` (22 at read + 2 at write) |
| #1861 the `[APPLOG] ... redacted at read` line appears once | Mi 9T | **`FAIL` against the expectation, P3** | `[APPLOG] 22 values redacted at read, in 11 lines an older build stored` - the count is exact - but it is logged AGAIN, identical, at the second export and the third, and each header counts the 22 again (`25`, then `38`). By design of #1861 (stored records are not rewritten; `ring-end.txt` still holds `coucou` 3 times), so every export of an upgraded device repeats the line until the ring rolls over |
| #1861 the export does not freeze the UI | Mi 9T | **`PASS`, on a small ring** | Tap to the save dialog 482 / 444 / 383 ms; longest frame gap 34 / 28 / 30 ms; no long task; no ANR. The ring was 555-664 lines, not a full ~5000: the yield-by-count path was barely exercised |
| #1861 fresh lines with a double quote | Mi 9T | **`PASS`** | `quote "zorglub" a3` and `trail\ back" end` sent in the DM: `text="[20 chars]"` and `text="[18 chars]"` (the JSON-quoted lengths), nothing of either text in the export or the raw ring |
| App opens on the PIN path | Mi 9T, iPhone | **`PASS`** | PIN gate, then `/posts` (`01-unlocked.png`, iPhone `05-unlocked.png`) |
| DM both ways | Mi 9T + iPhone | **`PASS`** | `a3-plain` and the two quoted texts arrive on the iPhone verbatim; `iosA3send` arrives on the Mi 9T |
| Salon both ways | Mi 9T + iPhone | **`PASS`** | `iosA3salon` arrives on the Mi 9T; `a3salon-mi9t` arrives on the iPhone ("Message lu par Canari T...") |
| Offline cold start: banner, held salon send, network back | Mi 9T | **`PASS`** | PIN path offline: "Impossible de contacter le serveur" (no unlock, by design); vault path ("Rester connecte" ticked online first): the banner on cold start; salon deep link, send: `HELD: salon a4b30b40 is not loaded on this device yet`, "En attente..."; network back: `reconnect - listing the communities again`, `server reachable again`, `released: its salon is loaded`, `settled as 55eabc2d` **4.6 s** after the online event; the iPhone shows `heldA3one` ONCE. **No** `[WORKSPACE-LOAD]` line in the 60 s after |
| Orphan WebView after two navigation-mode switches | Mi 9T | **`PASS`** | threebutton then gestural: same pid, CDP lists ONE page, attached, after each |
| Nothing fatal | Mi 9T, iPhone | **`PASS`** | Logcat: no ANR; the two `FATAL EXCEPTION` lines are `uiautomator` (uid 2000, `UiAutomationService already registered`), not the app. iPhone syslog: no crash line, no crash report |
| #1836 cold-start link | iPhone | **`PASS`** | Terminated, `fr.emse.canari://chat/channel_a4b30b40-...`: `[CanariDeepLink] scene connected with 1 launch url(s)`, PIN, the salon "general" (`14-cold-salon.png`). The DM link lands in the DM (`12-cold-dm.png`). A link to a salon gamma is not in (Bench127) lands on the community list |
| Checkpoints per rejoined group | Mi 9T | **NOT READ** | Needs a `pm clear` and a sign-in; not taken |
| Redaction on iOS | iPhone | **NOT READ** | The exported file cannot be pulled off the TestFlight app's container |

**Noise (P3, unchanged from alpha.2):** ~125 warning/error console lines for two offline cold starts
in ~2 min: `[API] getToken failed ... proceeding without auth`, the `[A] refresh` transport failure,
`Failed to fetch presence` and `[WS] Gateway connection failed` at ERROR, `[PENDING] page did not
arrive`. Logcat adds 24 `AppOps: attributionTag  not declared in manifest of fr.emse.canari`. The
Mi 9T is LEFT on the vault path ("Rester connecte" ticked) - mind the sign-out P1 candidate above.

## The iPhone 12 readings of v1.2.9-alpha.5 (2026-10-17)

TestFlight build `1.2.9 (100200905)`, account `canari-test-gamma`, dev estate, driven over WDA
(`tools/ios-device`), native lines from the device syslog (`pymobiledevice3 syslog live -pn
Canari`). The PIN gate was unlocked with the bench PIN. Evidence:
`<harness-dir>/ios-bench/r1017-a129a5/` (frames, `syslog-canari.txt`). Frames
showing a face, a personal photo library or the iOS password-autofill sheet were deleted.

**How the build arrived.** Automatic updates did their job: TestFlight listed `1.2.9 (100200905)`
with "Ouvrir", so the binary was installed. **But the process still running was the alpha.4 one.**
Settings > A propos read "Version de Canari 1.2.9-alpha.4" and "Une version plus recente
(1.2.9-alpha.5) est disponible". After a `terminate` and a relaunch it read "1.2.9-alpha.5" and
"Vous utilisez la derniere version". The enrolment survived (PIN gate). So, on a bench where WDA
keeps a session open, a background update does not take effect until the next cold start. Read
the version before trusting any row.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. "+" menu open, one edge swipe (#1953) | **`PASS`, 7 of 7** | DM 4 of 4, salon "general" 3 of 3. After the swipe the menu is closed, the conversation is still open ("Retour au menu" and the composer are present) and the menu entries are gone. The control is also `PASS`: with nothing open, one swipe leaves the DM for the list, and leaves the salon for the community's salon list. Each menu open logs one native `Foundation` line (the hold, `<private>` in syslog) and each dismissal logs a second one |
| 1b. The keyboard stays up when the "+" menu opens | **`FAIL`, 8 of 8** | With the composer focused and the keyboard up (`[CanariIOS] keyboard overlap=301 -> webview height 543`), opening the "+" menu drops the keyboard every time: `keyboard overlap=0 -> webview height 844` (`12-plus.png` against `11-kbd.png`). **The cause is the menu presentation, NOT the #1953 hold.** In each of the 8 rounds, UIKit logs `Override focusSystemState: (ENABLED)` for `_UIVariableGestureContextMenuInteraction` right after the touch-up. The WebView's input session ends 0.6 to 2.7 ms later (`End asserting activeInput modality`, `responder:(nil)`, `End input session`). The hold's `NSLog` comes 58 to 91 ms AFTER that, and the hold can only act from `willDisplayMenuFor`, just before that line. The `overlap=0` line sits 1 to 4 ms before the hold only because the keyboard-frame notification is posted at the end of the same presentation pass. The two rounds without a keyboard show the override and no input-session end. **Accepted as platform behaviour**, decision and reopen conditions in [mobile](frontend/mobile.md#the-conversations-native-glass-chrome) and the backlog P3 "Accepted: the native + menu drops the keyboard" |
| 1c. Photos and Camera from the "+" | **`PASS`** | "Phototheque" opens the system picker (Photos / Collections, "Acces prive aux photos"), and "Annuler" returns to the conversation. "Ouvrir la camera" opens the in-app camera ("Fermer la camera", "Changer de camera", the "Photo (toucher) ou video (maintenir)" shutter), and "Fermer la camera" returns to the conversation. The keyboard did not come back after either one, because it was already gone (1b) |
| 2. PIN change, confirm field with the keyboard up (#1952) | **`PASS`, with a limit** | Security > Changer > "Changer mon PIN". With "PIN actuel" focused, the confirm field (y 459-514 pt) is under the sticky "Changer mon PIN" button (y 435-483). Focusing "Nouveau PIN" scrolls the form, and the confirm field moves to y 361-416, clear of the button. A tap on it focuses it with the keyboard still up: WDA's active element is "Confirmer le nouveau PIN" at y 348-403, 32 pt above the button. The limit: from the FIRST field, the confirm field is not visible until the second one is focused. The keyboard is alphabetic on these fields. Nothing was submitted, and one stray letter typed into "PIN actuel" was discarded with the modal |
| 3. Payment return announcer (#1952) | **`PASS` (structure), announcement `NOT-OBSERVED`** | `fr.emse.canari://open?url=https://canari.emse.fr/forms/success` with no `submission_id` lands directly on "Paiement introuvable". The AX tree has ONE status region ("etat de l'application", 16,580 358x93) that holds the heading and its sentence, with "Retour aux formulaires" outside it. VoiceOver was not turned on, so the actual announcement was not heard |
| 4. Reel author link (#1952) | **`PASS` on the first reel, `FAIL` on the next ones** | Reel 1: ONE link "Voir le profil de Canari Test Gamma" at 16,628 176x45 pt (height at least 44), covering the avatar and name drawn in the frame, with "9 h" outside it. A tap opens Mon profil. **Reels 2 and 3: the same link reports 16,-206 161x879 pt and 16,-206 250x1723 pt**, stable across four reads 1.5 s apart, and again after swiping back. A tap at (100,400), inside that reported rectangle, does NOT navigate. So only the accessibility frame is wrong, not the hit area, and VoiceOver would outline a box taller than the screen. Reel 2 plays ("Pause"). Also seen: on a feed post the author avatar link is 20x22 / 22x22 pt next to a separate name link of 136-161x23 pt, both below 44 pt |
| 5. Feed tabs and the CanaReels entry | **`PASS`** | Associations / Suivis / Tout select one at a time (switch values 1/0/0, 0/1/0, 0/0/1). Suivis shows "Aucun post" and Tout shows the bench reel post. At the default text size all three tabs and the CanaReels button (330,211 44x44) fit in the row. The CanaReels button is exposed as `Other`, not `Button`. The 2x-text centring (`feedTabScroll.ts`) was not read: Dynamic Type was not changed |
| 6. Sign-out, then sign-in again | **`PASS`** | On the phone the desktop `Navbar` is not rendered (`hidden md:block`), so this was the phone's sign-out: tab 4 > "Deconnexion". iOS asks "<< Canari >> souhaite utiliser << miconnect.emse.fr >> pour se connecter", then "Continuer" lands on `/login` in about 5 s. "Connexion externe (service-account)" then shows the same iOS prompt and an EMPTY MiConnect form that asks for the username, so the MiConnect session did end. No terms stage was shown. With username + password, the app lands on the feed in about 6 s. Discussions lists the DM and the DM decrypts, including a video Delta sent today. No PIN was asked after the sign-in. A cold relaunch then asks for the PIN, and the bench PIN opens the feed with no "n'ont pas pu etre ouverts" |
| Nothing fatal | **`PASS`** | 366k syslog lines: 0 `crash`, `fatal`, `EXC_` or `Terminating app` |

**Not read:** the hold's own log lines (`NSLog` arrives as `<private>` in the syslog of a TestFlight
build), the in-app log (it cannot be pulled off the TestFlight container), and VoiceOver.

## The iPhone 12 readings of v1.2.9-alpha.7 (2026-10-17)

TestFlight build `1.2.9 (100200907)`, account `canari-test-gamma`, dev estate, driven over WDA
(`tools/ios-device`), native lines from the device syslog (`pymobiledevice3 syslog live -pn
Canari`), the sign-out timed from WDA's MJPEG stream (port 9100, a frame every ~100 ms). The PIN gate
was unlocked with the bench PIN. Evidence: `<harness-dir>/ios-bench/r1017-a129a7/` (frames,
`signout-mjpeg/`, `22-signout-contact.png`, `syslog-canari.txt`). Frames showing the iOS
password-autofill sheet, the keypad mid-PIN or a reel's photographed document were deleted.

**How the build arrived.** This time it had NOT been installed in the background: TestFlight listed
`1.2.9 (100200907)` with "Mettre a jour" ~6 min after the release run went green. One tap installed
it ("Ouvrir"), then a `terminate` and a relaunch. Settings > A propos read "Version de Canari
1.2.9-alpha.7" and "Vous utilisez la derniere version". The enrolment survived (PIN gate).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| 1a. The dashboard hub (#1958): rows and navigation | **`PASS`, 9 of 9** | Tab 4 is "Tableau de bord". The groups, top to bottom: the identity row ("Voir mon profil"), EXPLORER (Agenda, Associations, Listes, Institutions, Boutique, Formulaires, Notifs), COMPTE (Parametres, then "Se deconnecter" in the danger tone). The account is not a manager, so no probed group appears. Each row lands on its page: Mon profil, Agenda, Associations, Listes, Institutions, Boutique, Formulaires, Notifs, Parametres. Tab 4 brings the hub back. The sign-out row (y 688-736 pt, scrolled) clears the tab bar (761). Settings > A propos is reached from Parametres |
| 1b. Sign-out busy state | **`PASS`** | MJPEG, tap at t=0: the row is drawn normally up to ~+250 ms. From ~+350 ms to ~+550 ms the "Se deconnecter" label and icon are dimmed and the header avatar is gone. `/login` is drawn by ~+1.1 s, and the iOS end-session prompt ("<< Canari >> souhaite utiliser << miconnect.emse.fr >> pour se connecter") rises over `/login` at ~+1.3 s. **The order differs from alpha.5**, where the prompt came first and `/login` ~5 s after "Continuer". "Continuer" closes the prompt with `/login` unchanged |
| 1c. Sign-out ends the MiConnect session | **`PASS`, 3 of 3** | Each time, "Connexion externe (service-account)" shows the iOS prompt and then an EMPTY MiConnect form that asks for the username |
| 2. Sign-in again: no terms or consent stage (#1990 holds #1955 out) | **`PASS`, 3 of 3** | Username, then password, then Canari's "Connexion en cours / Echange du code d'autorisation..." and the app. No page between the password and the app, and no element matching conditions / accepter / consentement in the tree, sampled every ~0.5 s for 15 s after the submit |
| 2b. The PIN after a sign-in | **`SUSPECT`, not proven** | Sign-ins 1 and 2 landed on the PIN gate. **The first PIN attempt was refused both times** with "PIN incorrect : ce PIN ne correspond pas a celui enregistre pour ce compte". The second attempt, 6 filled dots counted on the frame, opened the app. The same PIN opened the gate at a cold start before and after. Sign-in 3 landed on the feed with NO PIN gate (as in alpha.5), and the DM decrypts. **The limit:** the dots of the two refused attempts were not counted, so a digit lost by the driver is not ruled out. The app log is not readable on a TestFlight build, so the refusal's cause is unknown. Owed: a sign-in on an inspectable bench build, reading the PIN check's request and its answer |
| 3. The "+" menu, one edge swipe (#1953) | **`PASS`, 9 of 9** | DM 5 of 5 and salon "general" 4 of 4, one round in each with the keyboard up. After the swipe, the menu entries (Phototheque, Ouvrir la camera) are gone and the conversation is still open ("Retour au menu" present). The keyboard drop is accepted and not filed. Control: with no menu open, one swipe leaves the DM |
| 3b. **The DM's native chrome with the keyboard up** | **`FAIL`, 2 of 2 in the DM, 0 of 1 in the salon** | Reproduced after a cold start. With the DM composer focused (`[CanariIOS] keyboard overlap=301 -> webview height 543`), the web composer and "Envoyer" sit at y=487 pt, as check W expects. **The native "+" sits at y=186 pt, mid-thread, beside the video bubble** (186 = 487 - 301, one keyboard overlap too high). **The glass header ("Retour au menu", the title, "Plus d'actions") is gone from the screen and from the AX tree.** Both come back when the keyboard closes (`overlap=0 -> webview height 844`). In the salon "general", the same steps leave "+" at 487 and the header in place. The DM's last message is a tall video. Frames `15-kbd-clean.png` and `16-salon-kbd.png`. The chrome code is unchanged since alpha.5, so this is not new in alpha.7. Check W on `1.2.3-alpha.5` had the "+" at 487 |
| 4. Weak network, no sign-out (#1966) | **`PASS`, with a limit** | (a) Airplane mode ON before a cold start: the PIN gate stays for 30 s, past the 20 s refresh deadline, and no sign-in screen appears. Entering the PIN offline answers "Impossible de contacter le serveur. Verifiez votre connexion puis reessayez.", a transport failure, not "PIN incorrect". Airplane OFF, then the same PIN opens the feed, still signed in. (b) Airplane ON ~60 s after a cold start, with the app in front: the PIN gate stays and there is no sign-out. **The limit:** a toggle inside the cold-start refresh's own flight was not achieved. Control Center takes over 3 s through WDA, and a blind fast tap did not register (no path change in the syslog) |
| 5. Feed tabs and the CanaReels entry | **`PASS`** | Associations / Suivis / Tout select one at a time (switch values 1/0/0, 0/1/0, 0/0/1). Suivis shows "Aucun post", and Tout shows the bench posts. The CanaReels button (330,211 44x44) opens the viewer, the reel plays ("Pause"), and "Fermer les CanaReels" returns to the feed. The button is still exposed as `Other`, not `Button` |
| Observation: edge swipe on a hub row's page | **noted, not filed** | From Agenda, opened from the hub, a left-edge swipe (two gesture shapes) stays on Agenda. No back control is drawn there, and tab 4 returns to the hub. No check states what an edge swipe should do on a hub row's page |
| Nothing fatal | **`PASS`** | 1.75M syslog lines: 0 `crash`, `fatal`, `EXC_` or `Terminating app` |

**Left on the bench:** signed in as `canari-test-gamma` on `1.2.9-alpha.7`, unlocked, on the feed.
Dynamic Type and 200 % text were not read (not owed by this build).

**3b, read again from the same evidence.** The emoji keyboard opened over the already-open DM
keyboard (`overlap=388`, 13:50:58), and `11-dmkbd-menu-open.png` then shows the header and the "+"
in place. Only the rise from a CLOSED keyboard goes wrong. The analysis and the three candidate
causes are in [mobile](frontend/mobile.md#the-dm-whose-chrome-stands-one-keyboard-too-high-2026-10-17).
**Owed on the next build that carries `keyboard settled:` (one reading names the cause):**

1. Run `pymobiledevice3 syslog live -pn Canari`, grepping for `[CanariIOS] keyboard`.
2. Open the same DM (last message a tall video) and tap the composer field with the keyboard
   closed. Then run `bun tools/ios-device/ios.mjs shot` and `bun tools/ios-device/ios.mjs webview`
   (543 tall expected), and `find "Ajouter"` for the native "+" rect.
3. Copy the `keyboard settled:` line that follows `overlap=301`.
4. Control 1: the salon "general", same steps.
5. Control 2: the DM after the emoji keyboard. Switch to it, then back.
6. Close and reopen the keyboard three times in the DM. One line per rise is the measurement.

## Traps that outlived the work that found them

Kept because each one costs a full device pass to rediscover.

- **Adding `.setKeySize(256)` to `generateBiometricProtectedKeyForAlias` only affects NEW aliases.**
  It therefore splits behaviour between fresh and upgraded installs. It was held back while the
  upgrade path was still unvalidated; now that that check is retired, do it once B-E pass.
- **An empty `deviceKeyB64` is not "no context".** Both platforms separate the two; a check that
  conflates them reads a missing key as a missing login.
- **The key sits in the keystore as RAW 32 bytes and crosses the FFI as base64.** Writers decode
  before storing, readers encode after loading, on both platforms and in both migrations. Treating
  the stored bytes as text yields no key, silently.
- **An app extension has its OWN data container.** `app_data_dir` inside the NSE is not the app's,
  so a path that is right in the app process is silently wrong in the extension. The App Group is
  the only shared storage. And the NSE runs on a locked device: write with
  `...UntilFirstUserAuthentication` or not at all.
- **Android's `MlsDeviceKeyStore` uses two Base64 flavours on purpose:** `DEFAULT` for the IV/CT
  (KeystorePlugin's at-rest format) and `NO_WRAP` for the key it RETURNS, because `DEFAULT` appends
  a newline and the Rust `decode_base64_to_32_bytes` does not trim. Do not "unify" them.

## Recording the results

Record them **here**, in the table and next to the check: what passed, on which build, and **the log
lines you actually saw**. Only a FAILURE goes to `CLAUDE.md`, as a new Work Package carrying its
captured log - a failure with no log is worth almost nothing, which is exactly why WP-FWD-1 is still
open with nothing to act on.

## The revocation wipe, read off both devices by hand

Moved off [the board](cross-client-testing.md) on 2026-08-28. Four defects, none of which any row on that board asks about, plus the reading that answers the user's question. The product stories are in `CHANGELOG.md`; what is here is the MEASUREMENT.

**AND HEAL-REVOKE NOW READS THE DISK, NOT THE LOG, 2026-08-28.** The rows asserted
`[RESET] done` and `no step failed`, which is a claim about the steps that RAN. Measured on prod the
same morning, the two disagreed: a revoked device printed `nothing of this device remains` and kept
ten `mls_not_ready_since` keys, its per-user MLS database and 8.2 MB, because the SYNC_WATCHDOG - a
5 s interval the revocation path never stopped - rebuilt them 1.25 s later. **Twenty HEAL rows
asserted the log line and not one asked the disk**, so the wipe was believed for exactly as long as
it was broken. `healrevoke.mjs` now samples `localStorage.length`, the count of `CanariDB*` databases
and `navigator.storage.estimate()` seconds after the wipe, and `theWipeLeftNoDatabase` is a FAIL
condition. The localStorage count is deliberately not asserted at zero - the page writes
`PARAGLIDE_LOCALE` back as soon as it renders - while a database is, because nothing re-creates one
without an MLS client. The product defect itself is fixed and shipped in `v0.14.10`; story in
`CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it). **The four
HEAL-REVOKE rows must run on a build carrying that fix - which for A1 means a new APK, since the
Tauri app embeds the frontend and a CD deploy never reaches it.**

**AND ASKING THE PHONE THE SAME QUESTION FOUND A SECOND DEFECT BEFORE ANY ROW RAN, 2026-08-28.**
`bun footprint.mjs --device A1` answered `canariDatabases: 1`, `bytesInUse: 5939115` on a device
whose message store is SQLite - so the WebView held 5.9 MB that nothing on that platform writes and,
until that morning, nothing on that platform deleted: `wipeDeviceToFactory` had the native stores and
the WebView's as the two ARMS of one branch. The database existed because the posts mini panel named
its backend by hand instead of asking `getStorage`. Both are fixed, with a guard test on the cause;
story in `CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it).

**RUNNING THAT MEASUREMENT BY HAND, ON A BUILD CARRYING THE FIX, FOUND A THIRD DEFECT - AND NO ROW ON
THIS BOARD ASKS THE QUESTION IT ANSWERED, 2026-08-28 14:12.** A1 on a local debug `0.14.11` was
revoked from W1's own panel and STILL kept `canariDatabases: 1` / 5 939 015 bytes, while its native
half fell 42 216 492 -> 29 249 922. **The wipe crashed the app 55 ms in**: `[RESET] wiping...` at
14:12:22.218, the biometric plugin's activity at .223, `FATAL EXCEPTION: main /
ClassNotFoundException: androidx.coordinatorlayout.widget.CoordinatorLayout` at .273, `SIG: 9`. Every
step after the biometric one never ran. Fixed with five tests; story in `CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it).

**AND THE THIRD READING OF THE SAME DEVICE FOUND A FOURTH DEFECT, ON THE HALF NO ROW HAS EVER
LOOKED AT, 2026-08-28.** With the crash fixed, A1 was revoked again and its WebView came back
genuinely empty - `canariDatabases: 0`, 261 localStorage keys down to 0, which is the previous fix
working. Reading the native side with `adb` instead of the log found **twenty-eight paths of account
state still on disk**: `mls.bin`, `canari_<userId>.db` and its WAL, `graine_seeds.json` and
`channel_keys.json` (the material the background push service decrypts notifications with),
`push_context.json`, `pending_push_secret.txt`, `fcm_token.txt`, `session-meta.json`, the
`keystore_aliases` index, five `canari_*.xml` preference files and **six cached avatars of real
people**. `clear_app_data` deleted an entry only when its extension was exactly `db`, and every file
in that list was added after that filter was written. Fixed with four Rust tests; story in
`CHANGELOG.md`, mechanism on
[auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it), two rules in
[durable-rules](durable-rules.md#mls-state-and-keys---mls-protocol-auth).

**AND THE MEASUREMENT ANSWERS YES, ON BOTH HALVES AND ON BOTH DEVICES, 2026-08-28 16:08.** Taken by
hand on a debug **0.14.12** carrying every fix, A1 in the FOREGROUND, both devices deleted from W1's
own panel by allowlist (`deleted 2/2`, `deletableAfter 0`).

| | A1 BEFORE | A1 AFTER |
| --- | --- | --- |
| native `residue` | **28 paths** | **0** |
| native `rewritten` | `logs/Canari.log` | none |
| `identityKeys` | 3 | 0 |
| localStorage / sessionStorage / caches | 36 / 4 / 2 | 0 / 0 / 0 |
| native bytes | 27 893 083 | 19 171 657 |
| verdict | `STATE PRESENT` | **`nothing of the account remains`** |

The logcat is the mechanism, end to end in **55 ms with no crash**: `[WS RCV] device_revoked` at
16:08:10.774, `[SECURITY] This device was revoked by its owner` at .158, `[RESET] wiping` at .604,
eight `[RESET] leaving <dir> to its owner` lines, **`[RESET] native wipe removed 26 entries, 0
failed`** at .628, `[Flags] no native_flags.json - biometricConfigured is already absent` at .653 -
the flag fix declining to recreate what the sweep had deleted - and `[RESET] done` at .659.

**AND THE USER'S SECOND QUESTION IS ANSWERED BY W3, WHICH WAS OFFLINE WHEN IT WAS REVOKED.** It never
received the frame: it sat on `/chat` reading `Hors-ligne / Connexion en cours` with
`CanariDBMls_<userId>` and 8 343 362 bytes intact, which is exactly what the design says -
`isDeviceRevoked` answers `false` when it cannot reach the server, and a transport failure is not an
answer. **One reload with a network and the deferred wipe landed**: `/login`, `canariDatabases 1 -> 0`,
`identityKeys 0`, verdict `nothing of the account remains`. No run had ever shown this, and it cost
nothing to measure because a revocation had already put a device in that state.

**What this does NOT close: neither reading came from a RUNNER, so neither is in the ledger and
`rows.mjs` will not see them.** They are hand-taken, like the six SETUP rows. The HEAL-REVOKE cell is
still owed as a script, and its predicate is now written for it: `bun footprint.mjs --device <d>`
must read `residue: 0` on a phone and `identityKeys: 0` everywhere, with the offline variant driven by
a reload rather than a frame.

### 2026-10-17 follow-up: the sort row (fixed) and the stale Tauri callback (open, cause not proven)

- **Comment sort row.** At 150-200 % text the row "Afficher les N commentaires" + Récents / Anciens / Aimés did not wrap (page scroller 553 px on a 436 px screen). `PostComments.svelte` now wraps the row and the sort group (`flex-wrap`, `min-w-0`, `gap-x-2 gap-y-1`); `textZoomBoxes.test.ts` asserts it. Owed one look at 200 % on the Mi 9T.
- **`[TAURI] Couldn't find callback id N` every ~15 s after a WebView reload** (`r1017-a129a5/cons-2.ndjson`: 27 lines, ONE id, intervals 14.85-15.05 s). The warning means Rust still answers a callback registered by the previous page. The only recurring Rust-to-JS channel in the app is the `plugin-websocket` listener in `TauriMlsService.connect()` (`addListener`); a reload does not run `pauseSocket()` (only the backgrounding path does, `sessionConnection.ts`), so a socket opened by the old page could keep delivering frames to the dead id. **NOT established from source**: no 15 s server frame was found in `backend/`, and the plugin's per-connection channel was not observed. Muting the line or adding a `pagehide` disconnect without that proof would be a guess. Next step: with the warning live, `adb logcat` for the websocket plugin plus the gateway's connection count for the account (two sockets after a reload would confirm it), then release the socket at `pagehide`.

## One background Welcome on the Mi 9T: the procedure (2026-10-22)

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
already sends exactly this body. The reading is a row of [the readings owed](plan.md#readings-owed).

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

## The iPhone 12 readings of 2026-11-15, second sitting

TestFlight `1.6.12-alpha.2`, dev estate, `canari-test-gamma` (`223bc34e`), driven over WDA (`tools/ios-device`), the syslog
from `python -m pymobiledevice3 syslog live`, the second party the rig seat W5 (`43319a65`) with a fake camera and microphone.
Evidence (screenshots, the syslog) is outside the repository. The TestFlight WebView is NOT inspectable
(`pymobiledevice3 webinspector cdp` lists `[]`), so no `[LIVE]`, `[BELL]` or orientation console line can be read on a store
build: such halves are read from the server's `[LIVE_ANNOUNCE]` / `[SOCIAL_PUSH]` / `[NOTIFY]` lines and the phone's picture.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Bell, "Lives seulement" on an association, then a live (entry closed 2026-11-15, both phones read) | **`PASS`** | Phone in the background: `[LIVE_ANNOUNCE] kind=association followers=22 titled=true`, `[SOCIAL_PUSH] sent platform=ios`, and a banner "Club d'Echecs Fictif est en live / Tournoi blitz 1115b" over the home screen. A second live of the same association inside 6 h is not announced, by design |
| Bell, a followed person at "Lives seulement" | **`PASS`** | A person post: `[NOTIFY] type=followed_post ... push withheld by the bell from 1 of 1`; a person live: `kind=member followers=1`, `[SOCIAL_PUSH] sent platform=ios`, SpringBoard `Posting notification ... fr.emse.canari` the same second |
| Live card with title and picture, iPhone (entry closed 2026-11-15, every half read) | **`PASS`** (part) | Title, association, badge and a refreshing picture ("Apercu d'il y a 14 s", then 9 s, a different frame); the push text with a title. Not read: the iPhone as broadcaster, two lives on air, the title-less text, the card's off-screen stop |
| Rotation, live viewer, landscape live ([entry](backlog.d/rotation-on-video-and-camera-screens.md)) | **`PASS`** (part) | "Passer en paysage" turned the app to 844x390 pt, the controls cleared the left side, and "Passer en portrait" returned; the end of the live drew "Le live est termine" |
| Follow suggestions, iPhone half (entry deleted 2026-11-16, every half read) | **`PASS`** (part) | Banner, empty Pour toi carousel, request toast and the card leaving, an X kept across an OS kill, the inline carousel after the third post (swipes; none in Campus), "Suivez aussi...", a request from a post header |
| Emoji pictures, row 4 full recents and row 5 anchors (entry deleted) | **`PASS`** | The picker held a full recents row (12, two lines) and the Flags category still ended on the Wales flag; the full panel sat at the same place inside the viewport (`y` 375-835 of 844 pt) opened from a message at the top edge and from the last one. The thread's first message is a deleted tombstone that takes no reaction, so the first LIVE message was the top-edge one |
| CanaReels "Voir plus" (entry closed 2026-11-16) | **`PASS`** | One line: no toggle; about 110 characters: two lines, "Voir plus" / "Voir moins" at `y` 705-725 pt, the seek slider's zone from 736 pt, a seek tap moved the reading; about 790 characters: expanded, same |
| A killed iPhone is added to a group ([entry](backlog.d/reading-owed-a-group-joined-in-the-background-before-its-row-existed-the.md), check (c)) | **`PASS`** | `terminate`, then the other account created a group and added the phone's account from W5: the Welcome was queued `online=false` and the notification extension drew a banner with the group's name and the GENERIC body "Nouveau message de ..."; the next message was generic too (iOS does not join in the background); at the next foreground the group was listed with the latest message readable, and the message after it came as a banner in clear |
| Openings for followers, forms (entry closed 2026-11-16) | **`PASS`** (part) | A follower: "Formulaire ouvert !" at 06:55 and no heads-up; a follower who asked: "Formulaire bientot ouvert" at 06:50 (5 minutes before) and ONE opening banner. On alpha.2 the attached form card draws no reminder bell (fixed by #3576, unreleased); the form page has it. Not read: booking space, validated event, bell at "Rien" |


## The iPhone 12 readings of 2026-11-15, sixth sitting

TestFlight `1.6.12-alpha.2`, dev estate, `canari-test-gamma` (`223bc34e`), driven over WDA, the syslog and `pymobiledevice3`. Seats: W5 (`canari-test-delta`, fake camera) and W2 (fake camera) as broadcasters, W8 (gamma's second web seat) wiped to make a new device. Evidence (screenshots) is outside the repository. The wireless link of the bench was slow during the whole sitting (the app drew "Connexion lente"), which cost two reads below.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| I3, the tab swipe on a slow start (entry deleted by sitting 4) | nothing owed | 24 of 24 strokes taken and the entry deleted on 2026-11-15; no row left on the iPhone |
| Live titles, the iPhone as BROADCASTER (entry closed 2026-11-15, every half read) | **`PASS`** | A live started from the phone's own camera with a 19-character title: `[LIVE] ... started by 223bc34e, title 19 chars` and `[LIVE_ANNOUNCE] ... titled=true`; the WebKit canvas grab stored `[LIVE_POSTER] ... stored (17715 B)` then `(17976 B)`, about 7 % of the 256 KiB bound |
| Live titles, the push text WITHOUT a title on iOS | **`PASS`** | W5 started a live with no title while the phone was on the home screen: `[LIVE_ANNOUNCE] ... titled=false`, and Notification Center read "Canari Test Delta est en live" / "Appuyez pour regarder" |
| Live titles, the carousel with two lives on air | **`PASS`** | W5 (title-less) and W2 ("Deuxieme live 1115f") on air: the feed's "En direct" row drew two cards side by side, the titled one with its title and the title-less one with "Canari Test Delta est en live", each with its picture and badge |
| Rotation, the broadcaster's preview ([entry](backlog.d/rotation-on-video-and-camera-screens.md)) | **`PASS`** | "Passer en paysage" turned the app to 844x390 pt with the form in a left column and "Fermer" at x 59 pt (clear of the notch); "Revenir en portrait" returned to 390x844; closing the preview while landscape returned to portrait |
| Rotation, nothing else turns | **`PASS`** | The feed, the chat list, a conversation and the settings all read 390x844 pt (WDA `size`) |
| Rotation, a reload while turned | **`PASS`** | With the preview in landscape, `pymobiledevice3 developer dvt kill` on the app's WebContent process: the app came back at 390x844 on the PIN gate (a fresh page, portrait) |
| New-device notices, the iPhone half (entry closed 2026-11-15: the Mi 9T half was read the same day) | **`PASS`** | With the app in the background, W8 (gamma's second seat) had its origin cleared and logged in again (a new gamma device). At the next DM push (W5 -> gamma) Notification Center held ONE "Nouvel appareil / Un nouvel appareil a ete ajoute a votre compte. Si ce n'est pas vous, ouvrez Canari."; opening the app, Notifs held the row "Nouvel appareil sur votre compte (15 novembre 2026 a 12:38)" with its three buttons and the banner was gone, none drawn twice; the DM with delta showed one line "Canari Test Gamma a ajoute un appareil" above the new message; a community salon (empty) drew no line |
| Backup 2: the sealed caches kept out of the backup ([entry](backlog.d/reading-owed-the-native-caches-sealed-at-rest-2026-10-22-the-upgrade-readings.md), (d)) | **`PASS`** (part) | `pymobiledevice3 backup2 backup --full` (unencrypted, 303 MB): the manifest holds `mls.bin` and `push_context.json` in the app domain AND in the App Group, and holds NO `graine_seeds.json` and NO `fcm_message_cache.ndjson` in either (only `graine_seeds.lock`). Control: the same `graine_seeds.json` exists on the phone (pulled over house_arrest, 15439 B, starts `CNSEAL1`). The App Group's `fcm_message_cache.ndjson` cannot be pulled on a store build, so its absence from the backup has no positive control. The three `at_rest_keys/*.json` markers in the backup read `scheme: hardware` and hold an alias and a check value only (no key). The backup was deleted after reading |

**The slow link cost two attempts, and is the chantier's, not a new defect.** The first open of the live preview after a cold start read "Pas de connexion : les regles du live n'ont pas pu etre lues" (the rules call, 20 s) and, after a relaunch, the first "Demarrer le live" sat on "Demarrage..." for about 45 s and ended on "Pas de connexion : le live n'a pas demarre" with NO request at the server; the immediate retry worked. The app was showing "Connexion lente" and a live of the phone ended itself with "la connexion envoie moins vite que la camera n'enregistre" after 42 s (the slow-link stop, working). Not read: the rotation lock's own state (Control Center cannot be driven from here), the video lightbox and the reel pager on the iPhone, the phone's double tap on the preview.

## The Mi 9T readings of 2026-11-15, seventh sitting

`1.6.12` on the Mi 9T, dev estate, the `alpha` account (a plain member of the "Campus" community, a follower of four
associations), logcat and the server's `srvlog.mjs` window kept, the app killed (`am kill` from the background) before each
push, CDP on the phone for the console. The second party is the `gamma` web seat (rig W4): Secretaire of the BDE Fictif, who
files and validates the events and creates the booking space. Evidence (screenshots, logcat) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Openings for followers, a validated event (entry closed 2026-11-16) | **`PASS`** | `alpha` follows the BDE Fictif (the "Suivre" button, `association_follows` row), app killed, an event filed and validated by `gamma`: `[OPENING] followers ... written for event=...: 2 (opens now)`, then the shade row "BDE Fictif publie un evenement / Reading7 event D" (`canari_social`), and a tap on that row lands on `/calendar` |
| Openings for followers, a listed booking space | **`PASS`** | Same setup, `POST /api/bookings/spaces` as `gamma` with `discoverability: listed`: `[OPENING] ... written for booking=...`, the shade row "BDE Fictif ouvre les reservations / Reading7 salle", a tap lands on `/bookings` |
| Openings for followers, the bell at "Rien" | **`PASS`** | `alpha`'s bell on the BDE Fictif set to "Rien" through the picker (`account_bells` `none`), an event validated: `[REMINDER] open sent: userId=<alpha> event=... origin=followed (push withheld by the bell)`, NO shade row, and the bell page lists "BDE Fictif a publie un evenement : Reading7 event E" among the unread |
| **Why the booking-space push of the earlier sitting never arrived** | explained | The daily push cap. A booking or event opening is COUNTED (`PUSH_BUDGET` in `engagement-push-cap.ts`, owner's "quieter" decision of 2026-11-10, #3316: three pushes a day), and `alpha` had `engagement_push_days.pushed = 3` by then. The first event of this sitting, validated at that count, logged `[NOTIFY] type=event_open withheld 1 of 1 (cap, category events off, or no device at 1.6.9)` and drew nothing; with the day's counter reset to 0 the next three openings all rang. Dev still serves the line that lumps the three causes (main logs each apart since 2026-11-14) |
| Follow suggestions, Mi half (entry deleted 2026-11-16, every half read) | **`PASS`** (part) | Pour toi: "Suggestions pour vous" ONCE between the third and the fourth post; a horizontal swipe moved the row (`scrollLeft` 0 to 445); Campus draws none. "Suivre" on a card toasted "Demande de suivi envoyee a Canari Test Delta" and the card left; the X on another card, then an OS kill and a relaunch: both cards still absent (one `follow_suggestion_dismissals` row). On a person's profile "Suivre" became "Demande envoyee" and a "Suivez aussi..." row of five cards opened under it. Not read: the banner "Suivez des comptes..." (the account follows 7, the banner needs fewer than five), a "Suggestion" post in Pour toi, a request from a PERSON's post header (no unfollowed person's post in Campus, only associations') |
| A live and a reel ask the microphone for one channel (entry deleted 2026-11-15, both halves read) | **`PASS`** (Mi half) | The console, in the same page: `[LIVE-CAM] audio layout: mono (ch=1, rate=48000Hz)` opening the live camera (and the live went on air), and `[camera] audio layout: mono (ch=1, rate=48000Hz)` opening the reel camera |
| A salon carries read receipts (entry deleted 2026-11-15) | **`PASS`** | `alpha`, a plain Membre of the Campus community, sent "RR7 read receipt probe" in `general`; `gamma` (Administrateur) opened the salon on the web seat: the sent bubble drew `gamma`'s face under it and the page carried "Message lu par Canari Test Gamma" |
| Found | note | A tap on the GROUPED Canari shade row (three rows collapsed) opened the app on the feed, not on the first row's destination; the same row tapped alone landed on `/calendar`. A gesture of the shade's group summary, not of the push |

Dev data this sitting wrote: five calendar events and one booking space of the BDE Fictif, one live, one message in the Campus
salon, a follow of the BDE Fictif and a follow request to `delta`, one dismissed suggestion; the day's push counter of `alpha`
reset twice (recorded in the harness folder's `WRITTEN-IDS.txt`).

## The both-phones readings of 2026-11-15

Mi 9T (`alpha`, `1.6.12-alpha.2`) and iPhone 12 (`gamma`, TestFlight `1.6.12-alpha.2`) together, dev estate. The iPhone WebView is
not inspectable on a store build, so its halves are read from the picture, the accessibility tree and the server lines; the Mi
console is read over CDP. The seat W5 (`delta`, fake camera) was the third party. Evidence (console files, `dumpsys`) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Call noise suppression, a call between the phones, Mi half (entry closed 2026-11-16) | **`PASS`** | `alpha` dialled `gamma`, answered in the app: `[CALL_REPORT] ns=off`, then with the switch ON `noise suppression: worklet ready (context running)` and `microphone sender now carries the processed track`; OFF then ON again: `AudioContext suspended` / `running`; `enc_frames` kept growing (978, 1479, 1979, 2480) across the switches. End line `ns=on ns_fallbacks=0`, `cost_ms_per_frame=1.169 realtime_pct=11.7`. `dumpsys audio` before, during and after the switch: `MODE_IN_COMMUNICATION`, preferred device unchanged (earpiece), `MODE_NORMAL` after the hang-up |
| Same, iPhone half | **`PASS`** (part) | The switch turned ON (value 1, label "Couper la reduction du bruit"), the earpiece/speaker button still toggled ("Ecouteur" / "Haut-parleur") with it ON and the switch stayed ON; the phone locked for 12 s and unlocked: the call went on (timer 01:06 to 01:44) and the Mi side kept receiving. Not read: the `unavailable (<cause>)` WARN and `ns_fallbacks` on the iPhone (no console on a store build) |
| Same, a call answered from the native ring (Mi) | **`PASS`** | The Mi in the launcher, `gamma` dialled: the system call row "Appel entrant" with Refuser / Repondre, a tap on Repondre brought the app up in the call (`ring_ms=5`); the switch ON mid-call: `worklet ready`; end `ns=on ns_fallbacks=0` (never `pending`), `cost_ms_per_frame=1.325 realtime_pct=13.3` |
| Live titles, title-less push on the Mi (entry closed 2026-11-15, every half read) | **`PASS`** | `alpha` and `gamma` both follow `delta`. App killed (`am kill`, no process), `delta` went live with no title on W5: `[LIVE_ANNOUNCE] ... by <delta> kind=member followers=2 titled=false`; the Mi shade (`dumpsys notification`, channel `canari_social`) read "Canari Test Delta est en live" / "Appuyez pour regarder"; a titled live earlier the same day had its title as the body |
| Title-less push on the iPhone | **`PASS`** | Same live: Notification Center row "Canari Test Delta est en live" / "Appuyez pour regarder" |
| The iPhone as broadcaster | **`PASS`** | Title typed, "Demarrer le live": `[LIVE_ANNOUNCE] ... by <gamma> kind=member followers=1 titled=true`, `[LIVE_POSTER] stored (35876 B)` then 36317 and 36456 B for the WebKit camera grab, far under the 256 KiB bound; the Mi drew the card with the title |
| The Mi as broadcaster | **`PASS`** | "Direct Mi 1115g": `[LIVE] poster of ...: 3771 B` (a dark preview) every 15 s, `PUT /api/lives/<id>/poster` 200, server `[LIVE_POSTER] stored (3744-3771 B)` |
| Carousel with two lives on air, Mi | **`PASS`** | The feed drew two cards side by side (the iPhone's "Direct iPhone 1115g" on a camera picture and `delta`'s title-less "Canari Test Delta est en live" on the fake-camera picture); console `card poster ...: opened, 3923 bytes` and `28859 bytes`: the HKDF poster key opens on the Android WebView |
| Card stop off screen and in the background, one GET per poster name, Mi | **`PASS`** | `[LIVE] feed card: on-screen refresh every 16000 ms`, one `GET /api/media/public/live-poster/<live>/<name>` 200 per new name (`loading` then `opened`, never repeated); after navigating to `/chat` and then HOME no further `feed card: reading the list` line, only `[FOREGROUND] app in the background` |
| Rotation rows, Mi half ([entry](backlog.d/rotation-on-video-and-camera-screens.md)) | nothing left on the bench | Every Mi row the bench can stage was read in the earlier sittings (lightbox, mixed gallery, reel pager, live viewer, broadcaster preview, reload, in-place configuration change); what remains is the lock-OFF turn with the phone held sideways and the iPhone's lightbox and reel pager |
| Backup, Mi ([entry](backlog.d/reading-owed-the-native-caches-sealed-at-rest-2026-10-22-the-upgrade-readings.md)) | **`PASS`** (part) | First export: `[BACKUP_CODE] a recovery code is generated (new)`, the system save dialog, a 3.97 MB `.canari`, the code shown with its explanation; second export: `the device recovery code is reused` and "Le meme code que vos sauvegardes precedentes de cet appareil", the code identical to the first; import of the first file with a wrong code: `wrong_code: AES-GCM tag did not verify`; with the right code: "Sauvegarde restauree : 21 conversations, 463 messages". Not read: the file opened on the OTHER phone (the iPhone runs `gamma`, a backup of `alpha` is another account's) and the new-backup notice after an upgrade |

Dev data written: lives `eb5a0d47` (Mi), `4159bf20` (iPhone), `2a1c8879` and `c5736502` (`delta`), all ended; two calls between `alpha` and `gamma`; one follow request of `alpha` to `delta` accepted; two backup files on the Mi (deleted). Ids are in the harness folder's `WRITTEN-IDS.txt`.


## The phones readings of 2026-11-15, afternoon

`1.6.12-alpha.2` on dev. The Mi 9T is the `alpha` account (Android build 100601202), the iPhone 12 the `gamma` account (TestFlight, WDA and `pymobiledevice3`). Web seats: `gamma` on W4 (restarted with a fake camera), `delta` on W5, `alpha`'s second device on W3, `beta` on W1. Evidence (screenshots, logcat, the WebView console read over CDP) is outside the repository. Rows already read earlier today (birthdays on the iPhone, the group join (c) half, live titles) were not redone.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| The named readers' live chat  (entry deleted 2026-11-15) | **not read, DELETED by the owner** | `beta` holds the grant (Saint-Etienne, whole campus, comments hidden) but joined the chat of two association lives with its composer and a "joined" line, as a viewer who reaches the live without the grant. The bench has four accounts and none is without a space, so the withheld branch cannot be staged. Owner: "Supprimer cette lecture". Two lives (BDE Fictif by `gamma`, Club d'Echecs Fictif by `delta`) were used and ended |
| A group joined in the background, PK2 ([entry](backlog.d/reading-owed-a-group-joined-in-the-background-before-its-row-existed-the.md)) | **`PASS`** | App killed with `am kill` after an MCS heartbeat; a group created by `alpha`'s other device: `isWelcome=true ... background join`, then `processReceivedWelcomeBackground: group joined` 0.6 s later and `markMembershipActive: HTTP 201`. Two messages sent while killed; the next cold start decrypted both (`[MLS] Message decrypted ... addMessageToChat`) with no `LOST frame`, no `past epoch` and no `Message for absent conversation` |
| A group joined in the background, (b) the sub-second window | **DELETED by the owner** | Owner, "Supprimer les trois": the window cannot be hit on purpose. Not read |
| A HISTORY ask answered "I hold nothing" ([entry](backlog.d/reading-owed-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster.md)) | **not read** | Two cold starts with the console captured: nine communities logged `the history of community ... is not asked: no other member, and none of our other devices on its key group is online to receive the request`, and no ask followed. Staging needs a member online on the key group who joined after the history; the web seats left on `/communities` were not on those key groups. The no-answerer branch behaved (no spurious ask, no re-ask), the answering branch is unread |
| iPhone lightbox, rotate button ([entry](backlog.d/rotation-on-video-and-camera-screens.md)) | **`PASS`** | A DM with a photo and two landscape videos from `delta`: the photo drew no rotate button and stayed 390x844 pt; on a video "Passer en paysage" turned the app to 844x390 with the back control at x 59 pt, "Revenir en portrait" returned; turned, a swipe to the next item came back to 390x844 |
| iPhone reel pager, a landscape video | **`PASS`** | A post with a landscape video: the pager opened portrait with the rotate button; turned, 844x390 with the close control at x 55, the rotate button at x 745-789, the caption at x 138 and the action column right of the picture, all clear of the notch and the picture whole; back to 390x844; a swipe up while turned paged and returned to portrait; closing returned to 390x844 |
| Birthdays on the iPhone | already read | The sitting 5 reading stands (a row written by hand and removed); the morning notice is tomorrow's |
| Bench build `ios.yml` with `local_url` (entry deleted 2026-11-16 once its last half was read) | **not taken** | A bench build replaces the TestFlight app the `1.7.0-alpha.1` readings need, and its dispatch is a CI run. It stays owed |
| The blind salon banner  (entry deleted 2026-11-15) | **DELETED by the owner** | It needs a debuggable APK (`run-as` removes the seed mirror); owner, "Supprimer les trois". Its "Marquer comme lu" half was read on the Mi earlier |
| The initials of a named author with no photo (the mention entry, entry deleted 2026-11-15; the birthday ring on initials) | **DELETED by the owner** | No bench account is without a photo; owner, "Supprimer la lecture" |
| The native caches' legacy-format pass | **DELETED by the owner** | No device holds the old format; owner, "Supprimer les trois". The other halves of that entry stay |

Dev data this sitting wrote: the lives above (ended), a DM from `delta` to `gamma` with a photo and two videos, a post of `delta` with a landscape video, the group `PK2-1115h` of `alpha` with two messages. Every id is in the harness folder's `WRITTEN-IDS.txt`. End state: the Mi 9T on the feed, the iPhone on the feed, rotation lock left as the owner set it, no live or call open.

## The owner's hands-on sitting of 2026-11-15

About 14:12-14:30, dev `1.6.12-alpha.2`. The owner held both phones and the lead read the logs. Rotation lock OFF unless said.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Mi 9T, a photo in the lightbox | **`PASS`** | `requestedOrientation` stays PORTRAIT: photos stay portrait by design |
| Mi 9T, a landscape CanaReel | **`PASS`**, one defect | It turns with the phone both ways, in place (activity not recreated, the app redraws 36 ms after the system's decision). Defect, filed by the lead elsewhere: about 0.5 s of stale, garbled frame after the system rotation animation, both directions |
| Mi 9T, the feed turned | **`PASS`** | It stays portrait |
| iPhone 12, a landscape reel | **`PASS`**, same defect | The first toggle had turned the lock ON (syslog `CC user locked orientation`); with it OFF the reel turns both ways, the notch on the left and on the right, nothing under it. The same stale frame as on Android |
| Mi 9T, the camera | **`PASS`** | The glyphs turn with the sensor with the lock ON or OFF, the layout stays portrait; a sideways photo comes out landscape and right way up (owner: "ca me semble tres bien") |
| iPhone 12, the camera | **`PASS`** | The same (owner: "Idem") |
| A Mi 9T to iPhone 12 call, noise suppression ON | **`PASS`** (the owner's ears) | One minute, the owner tested it himself: "dans l'ensemble ca a l'air bien". The default stays OFF |
| Reel tabs moving with a landscape video, the action rail clipped | **read, `PASS`** (Mi 9T and iPhone 12) | Fixed by #3537, read on `1.7.0-alpha.1`: [the Mi sitting](#the-mi-9t-readings-of-2026-11-15-170-alpha1-first-sitting-on-it) and [the iPhone sitting](#the-iphone-12-readings-of-2026-11-15-170-alpha1-first-sitting-on-it) |

## The Mi 9T readings of 2026-11-15, `1.7.0-alpha.1` (first sitting on it)

`1.7.0-alpha.1` on the Mi 9T (`alpha` account, dev), installed over `1.6.12` with `adb install -r` from the GitHub release's `app-universal-release.apk` (versionName `1.7.0`, versionCode `100700001`; the APK's signing certificate is the one already on the phone, so the enrolment survived and no uninstall was needed). `a1tester.mjs --tag v1.7.0-alpha.1` ACCEPTED it (the Android job's log prints `Android build targets dev`; bundle `bacebc1`). Rotation lock found ON-by-sensor (`accelerometer_rotation 1`), restored at the end; rotations were forced with `settings put system user_rotation` and the lock off. Evidence (screenshots, logcat, a screen recording and a contact sheet, the dev log windows) is outside the repository. Web seats were not used; the server halves were read over the rig's read-only log windows.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Reel tabs and action rail, a landscape CanaReel held in portrait (#3537, [entry](backlog.d/rotation-on-video-and-camera-screens.md)) | **`PASS`** | "Pour toi / Recents" read x 106-330 CSS px in a 436 px page (centre 218 = the page centre) with the rotate button drawn at the right; turned to landscape the same tabs read 361-585 in 945 px (centre 473, page centre 472.5). The rail (heart, comment, send, download, sound) is complete in portrait and in landscape, the caption and author clear of it |
| A turn holds the old picture until the new one is drawn (#3626) | **`PASS`** (Android; visual part partial) | 14 forced turns over a landscape reel, both directions: `turn N: the page's frame at the new size is ready after 259-390 ms - draw released` for all 14, no `released WITHOUT`; for every turn the MainActivity window's `finishDrawing of orientation change` comes AFTER the release (14 of 14). A screen recording of 5 turns, read as a contact sheet at 12.5 fps for the first one: the old portrait picture stays whole and still, then the system's turn onto the laid-out landscape page, no frame with the portrait page at its old size beside black. The other turns of the recording were not read frame by frame (the 10 ms classification of the PR's table was not rerun). Android 9-12 and a second Android 13+ maker stay owed, as does the iPhone |
| A booking reminder says when (#3620) | **`PASS`** | Two dev bookings by `alpha` in "Espace 1115e" (1 h and 24 h reminders). Before they fired the list chips read "19:30" (same day) and "Auj. 19:30" (the 24 h one, fired the day before). After the cron sent both: the bell rows read "Rappel : votre reservation commence dans 1 h" (place "Espace 1115e - 20:30") and "... commence demain a 19:30" ("Espace 1115e - 16/11 19:30"), the shade bodies "Espace 1115e - 20:30" and "Espace 1115e - 16/11 19:30" (dd/MM led only on the other-day one), and the chips were gone from the list. Both bookings were cancelled afterwards |
| A group Add with stale devices (#3606) | **`PASS`** (Mi inviter half) | `alpha` created a group, then added `delta` and `beta`. Server: `[WELCOME][welcome-send-...] ADDRESSABILITY ... is offline - the inviter sends it no addressed answer` for each offline device (12 own devices at the creation, then each added account's offline devices), 0 `addressed_unsupported`, no 400 on a send. Inviter console (captured for the `beta` add): `[JOIN_PUSH] ... NOT DELIVERED to <device> - the server answered its Welcome offline ...` at warn for each offline device, one `join push -> <device> (addressable when its Welcome was answered)` for the addressable one, then the empty history bundle, no failed request. The `delta` add's console was not captured (its server lines were) |
| Mesh nginx during the `alpha.1` rolling deploy (#3120) | **partial** | `canari-dev-mesh-1` started 17:07:21Z, the first deploy that carries it, and was reloaded 14 times (17:07-17:09Z) for the replica rotation. Its log holds ONE `[error] connect() failed (111: Connection refused) while connecting to upstream` on `POST /api/internal/presence/shared-communities` to social-service at 17:08:08Z (the retiring replica; nginx answered `upstream server temporarily disabled`, i.e. tried the other), and NO `Connection reset by peer`, no `upstream prematurely closed`. No caller logged a failure for that route. The mesh keeps no access log, so the retried POST's final status was not seen, and the retired replicas' own logs are gone: a reset on a replica that no longer exists cannot be excluded |
| Found | defect | media-service booted at 17:07:59Z beside the OLD social-service and logged `ERROR [RETENTION] read (boot) FAILED (social-service answered 404) and nothing is held: conversation uploads are refused (503) until a read succeeds`; social-service's own boot notice at 17:08:10Z got `read (notice) still failing: social-service answered 404` and `did not re-read the retention durations at this boot (HTTP 201, refreshed=false)`. Nothing later in the window says the read succeeded, so media may still hold nothing until the first conversation upload asks again (not tried). Filed: [entry](backlog.d/p1-media-retention-held-after-the-deploy-that-adds-the-relay.md) |
| Found | note | `Refresh refused for the NATIVE app: no canari_refresh cookie ... client=1.7.0-alpha.1` at 17:12Z and 17:27Z on dev, from an Android 16 device that was not this sitting's (the Mi was installed at 18:18Z); one device without its refresh header after the update, not explained |

Dev data written: two bookings of `alpha` (cancelled), the group "RD1700 stale add" (alpha, delta, beta, one message-less group), both ids in the harness folder's `WRITTEN-IDS.txt`. End state: the Mi on `1.7.0-alpha.1`, logged in, on the feed, auto-rotate back to ON.

## The web seat and production readings of 2026-11-15 on `1.7.0-alpha.1`

A sitting with NEITHER bench phone (both were taken by other sittings): one web seat of the rig on dev `1.7.0-alpha.1` (build `dev.bacebc1`), and production through the read-only form (`default_transaction_read_only` forced on and checked, aggregates only). Evidence and queries stay in the harness state folder (`sitting-1700a1-web/`).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| The pre-live screen says a suspension before Start (entry deleted 2026-11-16, every half read) | **`PASS` on a web seat, staging PARTIAL** | A rig account with two cuts on record (two fixture rows, deleted afterwards - not two cuts through `/admin/moderation`): the sheet said "Vous ne pouvez plus lancer de live jusqu'au 14 décembre." and in English "You can no longer start a live until December 14.", Start greyed, `[LIVE] standing` logged and no `[LIVE] start`; the control before and after (no rows) offered Start. The phone WebView read is left. |
| Native devices with no push token, production re-read ([entry](backlog.d/reading-owed-a-device-with-no-push-token-now-says-so.md)) | **FAIL, filed as a P1** | 0 of 209 active native devices on a build older than `1.6.12` hold no `push_token` row; **25 of 65 on `1.6.12` do** (Android 14 of 43, iOS 11 of 22), none inside the four-minute ladder. Cause not established ([defect](backlog.d/p1-a-third-of-the-1-6-12-native-devices-hold-no-push-token-row.md)). |
| The stricter script policy, the web gestures, re-read (entry deleted 2026-11-16, every half read) | **`PASS` (web)** | Image, video, PDF, GIF picker and trombinoscope export: no violation beyond the edge's injected script. |

**Not taken, and why:** the pseudos remainder, the named readers and the live-title carousel need a second and third signed-in account, and the rig's two spare seats (`W6`, `W7`) hold a vault locked by a PIN older than the file's (the product refused both; recovering would reset the account's PIN for every device), so they cannot be used without re-enrolling a device. LEAF-REFRESH-1..4 still have no runner.

## The iPhone 12 readings of 2026-11-15, `1.7.0-alpha.1` (first sitting on it)

`1.7.0-alpha.1` on the iPhone 12 (`gamma`, dev): TestFlight offered `1.7.0 (100700001)` about 80 minutes after the release run went green and the update was taken from the TestFlight app (the installed `1.6.12 (100601202)` was replaced); Settings > A propos reads "Version de Canari 1.7.0-alpha.1". Driven over WDA (`tools/ios-device`), native lines from `pymobiledevice3 syslog live`, the MJPEG stream on port 9100 for the turn frames. The PIN gate came back after the update and was passed with the keypad. Evidence (screenshots, MJPEG contact sheets of three turns, the syslog's `[CanariOrientation]` lines, the server log window) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Reel tabs and action rail, a landscape CanaReel held in portrait (#3537, [entry](backlog.d/rotation-on-video-and-camera-screens.md)) | **`PASS`** | "Pour toi" and "Recents" spanned x 83-307 pt of a 390 pt screen (centre 195 = the screen's centre) with the rotate button drawn at the right (x 338-393); the rail (heart, comment, send, download, sound) is complete, the author and caption clear of it. Turned to landscape (2532x1170 px) the tabs' centre is the page's centre again and the rail is whole. Cosmetic note, not filed: in portrait the heart's top edge sits a few points above the video's bottom edge at the right (the rail overlays the picture, as on a tall video) |
| A turn holds the old picture until the page is laid out (#3626, iOS half) | **`PASS`** for the hold and release; the iPad-like resize **stays owed** | Three forced turns through the reel's rotate button, the syslog printing for each `turn N: 390x844 -> 844x390 pt, the old picture held until WebKit has its new layout on screen`, then `the page is at the new width` and `new layout on screen ... old picture released` at 408, 402 and 373 ms (the page's width at 396, 382 and 363 ms); no `ERROR`, no `released WITHOUT`. The MJPEG stream of the turns back and forth (contact sheets) shows the landscape layout whole until the turn, then the OLD picture counter-rotating inside its black corners (the held snapshot), then the new layout at full size: no frame with the old layout at its old size beside black. A fourth turn (the reel viewer closed while landscape) logged only its release line, at 1041 ms, the begin and "page is at the new width" lines being absent from the capture: not read as a pass or a fault, and no frames were recorded for it. A Split View or Stage Manager resize needs an iPad: it stays owed, and the `... with no rotation (a window resize) - not held` line was never printed |
| A booking reminder's wording and chip day (#3620) | **`PASS`** | Three dev bookings of `gamma` in "Banc 163 espace BDE" (the first free space), reminders 15 min, 24 h and 24 h. Before they fired the list chips read "Rappel 19:45" (same day), "Rappel Auj. 20:00" (the 24 h one, firing the day before) and "Rappel Dem. 20:00" (the booking two days out). At 19:45 the bell row read "Rappel : votre reservation commence dans 15 min" over "Banc 163 espace BDE - 20:00"; at 20:00 the 24 h one read "Rappel : votre reservation commence demain a 20:00" over "Banc 163 espace BDE - 16/11 20:00"; each fired chip was gone from the list at the next look, the third kept "Dem. 20:00". The push banners were not read: the app was in the foreground |
| A group Add with stale devices (#3606), iPhone inviter | **`PASS` for the server half and for "no 400"; the inviter's own console line is NOT READ** | `gamma` created a group on the phone and added `alpha` (ten enrolled devices) at 19:44: the group shows "Canari Test Gamma a ajoute Canari Test Alpha au groupe". Dev's delivery service, read over the read-only log window for 18:43-18:46Z: 13 `[WELCOME] ... ADDRESSABILITY` lines, 3 "is addressable" and 10 "is offline - the inviter sends it no addressed answer", **0 `addressed_unsupported`** in the window. The `[JOIN_PUSH] ... NOT DELIVERED` line is a page console line: the syslog does not carry the WebView console and the in-app log export (2.1 MB, saved to Files) hung Files' Quick Look when searched, so the line was not read; the Mi inviter's reading of the same rule stands. The absence of `POST /api/mls/send -> 400` is the server's count, not the phone's network panel |
| A reply swipe along a thumb's arc, a RECEIVED bubble on WebKit (#3605, entry closed 2026-11-16) | **`PASS` (6 of 6)** | Not in the brief, taken because the entry's last failure was this exact cell and #3605 is in `alpha.1`. A W3C touch sequence of ten moves on a text bubble of `delta` ("nd ping ..."), 110 pt to the right: drift 45, -45, 60, -60, 45 and -45 pt each staged exactly one "Repondre a Canari Test Delta" bar with its cancel (the page did not scroll instead); a straight 110 pt stroke did too. On `1.6.12` the same arcs staged 0 of 5. The strokes after the first ran with the composer focused by the previous reply's staging, the reply cancelled between strokes |

**Bench notes (iPhone).** The system language of this phone is English, so a Files picker and Quick Look read "On My iPhone", "Save", "Search". The in-app log exported to Files cannot be read from the workstation: Quick Look's text view of a 2 MB file stopped answering (WDA taps and a scroll-indicator drag did nothing, the screenshot never changed) and only a `terminate` of the Files app freed it. A smaller export, or a log viewer in the app, would give the iPhone's console lines. `ios.mjs`'s keyboard guard refuses taps on Quick Look's toolbar (it believes a field has focus): `--no-guard=<reason>` passes it. The reel's rotate button answers a coordinate tap much faster than `tap <text>` (a `tree` call each, about 5 s on that screen), which the MJPEG timing needs. The page showed "Connexion lente" twice during the sitting (after the app came back from Files, and while an empty group was being created, which took about 25 s on "Creation en cours"): not measured, not filed.

**Taken from the plan's "readings owed" and left on purpose:** every row that needs a second account to send, a second seat (the harness Chrome slots were in use by other sittings), a hardware key or an ear, the F1 bench build, and the iOS 16 device. Nothing else was read on this build.

Dev data written: three bookings of `gamma` in "Banc 163 espace BDE" (the 15 min one is in the past, the two 24 h ones on 2026-11-16 and 2026-11-17 stay, to be cancelled by the next sitting), the group "Groupe 1700a1" (`gamma`, `alpha`). A log export `canari-log-1.7.0-alpha.1-20261115-1952.txt` sits in the iPhone's Files "On My iPhone". End state: the iPhone on `1.7.0-alpha.1`, signed in as `gamma`, on a DM thread.

## The iPhone 12 readings of 2026-11-15, `1.7.0-alpha.1` (second sitting)

`1.7.0-alpha.1` on the iPhone 12 (`gamma`, dev), driven over WDA (`tools/ios-device`), native lines from `pymobiledevice3 syslog live` (filtered captures, stopped at the end), the dev server's logs read-only, `gamma` and `delta` on the rig's web seats W4 and W5 (`delta` with a fake camera). Cleanup first: the two 24 h bookings of `gamma` (2026-11-16 and 2026-11-17) in "Banc 163 espace BDE" were cancelled. Evidence (screenshots, syslog captures) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| The live card stops off screen and in the background (entry closed and deleted) | **`PASS`** | Counted from the server's request log, not from a console the store build does not give: the phone's `GET /api/lives` lines stopped while the card was off screen and while the app was in the background, and resumed when it came back. The entry's every half is now read, and it is deleted |
| A first message from someone with no conversation (entry deleted 2026-11-16, every half read) | **`PASS` for the group variant only** | A group minted by `delta` with `gamma` in it: `[CanariNSE] outcome=fallback cause=group-absent;direct=mls-refused` (the phone has no record of the group), the banner is the generic group one, and a tap on it opened the new conversation in the list. The DM from an account with no conversation is not stageable (four bench accounts, all paired); see the defect filed below for what the conversation's first line said |
| Openings: a booking space, a validated event, the bell at "Rien" (entry closed 2026-11-16) | **`PASS` (3 of 3)** | `delta` (BDE Fictif, permissions raised to 225 for the sitting, reverted to 128) listed a space and validated an event: both banners arrived on the phone (the app in the background), each opening a tap on its own target. With `gamma`'s bell at "Rien" the opening was written, the push withheld (no banner) and the bell page lists it. `engagement_push_days` of `gamma` was reset to 0 first so the daily cap of three did not mask the push (the cap explanation of the Mi sitting 7) |
| The card's reminder bell after #3576 | **`PASS`** | A form of BDE Fictif opening 21:08 local: the opening card shows the bell control, the choice taken on the card is the one the bell page shows |
| Sharing, a finger tap on the banner ([entry](backlog.d/reading-owed-sharing-into-canari-on-ios.md)) | **`PASS` through the app row** | Safari, "Canari" from the share sheet's app row: `share extension launched, intent=false`, `opened with 1 item(s), intent=false, send_message_intent=false, suggestion=false`, `share notification posted`; a finger-like tap on the banner (`hold` then `tap`) logged `share banner tapped - the share is imported on activation`, `share imported (share ready)`, and the "Envoyer a..." picker opened on the item. **The suggestion-row path was NOT observed in this capture**: no extension launch with `intent=true` or `suggestion=true` appears, so the P2 entry stays as it is and its cause is still unread |
| Call noise, the `unavailable` WARN and `ns_fallbacks` (entry closed 2026-11-16) | **PARTIAL: the mechanics read, the console lines NOT read** | A dev call with `delta` (W5): the switch ON, the speaker button, a 12 s lock survived, then hung up. The syslog carries no app console, and the only `unavailable` lines in it are the system's own (`GenerativeModels`, `suggestd`), which are not the app's WARN. The in-app log exported to Files (24539 lines) could not be searched from the workstation: Quick Look's text view of a log that size does not answer to WDA. Nothing is claimed about `ns_fallbacks` |
| A 13 MB attachment, kill with a file queued | **NOT TAKEN here, READ in the [third sitting](#the-iphone-12-readings-of-2026-11-15-170-alpha1-third-sitting)** | Time went to the rows above and the two that failed to read |
| The native caches sealed at rest, App Group half ([entry](backlog.d/reading-owed-the-native-caches-sealed-at-rest-2026-10-22-the-upgrade-readings.md)) | **NOT TAKEN here, PARTLY READ in the [third sitting](#the-iphone-12-readings-of-2026-11-15-170-alpha1-third-sitting)** | Needs a device backup read through `Manifest.db`; not started |

**What the pushes of the sitting showed.** Twice the delivery service's Welcome frame reached the app with `[CanariPush] ... isWelcome=1 NOT acted on - outside the background allowlist` (the designed behaviour for a Welcome in the background); the NSE outcomes were `server-content` for every ordinary message and `fallback` only for the two group-absent ones above.

**Bench notes.** The Files Quick Look overlay of a 2 MB+ log cannot be closed over WDA (its close button turns to "Cancel" and stays), and a relaunch of Files reopens it: `terminate` Files and do not open a log that size again. A shorter export, or a viewer in the app, would give the console lines the syslog cannot. `tapText` logs the typed keypad digits to stderr, so a PIN script must redirect stderr.

Dev data written (all in the harness's `WRITTEN-IDS.txt`): a booking space, two events, a form with its post, a live (ended), the group "I1700b nouveau groupe" (`gamma`, `delta`); the temporary permission raise of `delta` was reverted. End state: `1.7.0-alpha.1`, signed in as `gamma`.

## The Mi 9T readings of 2026-11-15 on `1.7.0-alpha.1`, second sitting

`1.7.0-alpha.1` (versionName 1.7.0, versionCode 100700001, the Play tester build, dev estate) on the Mi 9T, the `alpha` account. Web seats used: beta (`W2`, restarted with Chrome's fake microphone for the call) and alpha's two seats; the other two accounts' seats were not touched (another sitting held them). Evidence (screenshots, logcat, the notification dumps) is outside the repository. The shade of this phone carries the owner's own apps' notifications: none of it was read into any note.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Every menu: the hardware back and a reload on a section (entry deleted) | **`PASS` for the back; the reload read, and a sign-out found** | From the dashboard hub a tap on "Boutique" then on "Formulaires": the hardware Back returned to the hub each time. A `location.reload()` of the WebView on `/forms` came back on `/forms`; **a tap on a bottom tab a minute later signed the account out, twice in two tries** - re-read the same evening with the console and the network captured: **NOT A SESSION DEFECT**. The reload re-armed the PIN gate (vault path off), and the tap at the "Discussions" tab's place landed on the gate's own "Se deconnecter" drawn over it; no request answered 401 or 403. The P2 is closed, and the native sign-out line now names its cause ([sessions](sessions.md#a-sign-out-names-who-decided-it-2026-11-15)) |
| The call survives the app leaving the screen, Back at the root (#3544, entry deleted) | **`PASS`** | Beta dialled the alpha account from a seat with a fake microphone; the call was accepted on the Mi (the microphone prompt came up, `RECORD_AUDIO` having been revoked by the earlier sitting: "Lorsque vous utilisez l'appli"), `CallForegroundService isForeground=true types=0x80`. On the feed (a root tab) the call banner showed; the first Back was taken by the WebView history (the session had walked ten pages), the second logged `Back at the root with no history on API 36 - moving the task to the background`: same process id, the foreground service still up, the seat's timer still running; the app brought back to the front showed the call banner, hung up from it, service gone (no `isForeground=true` left) |
| The push of a request to republish a post, the tap landing (entry and the P3 defect deleted) | **`PASS`** | App killed (`am kill` from the background), beta's association "Fanfare Fictive" asked to relay one of alpha's posts: the shade row "Fanfare Fictive demande a relayer votre publication", the group expanded and the ONE row tapped, PIN gate, then the unlock typed WITHOUT any navigation of the rig: the app stood on `/notifications/requests` ("Demandes de republication") with both requests listed. The first row of the sitting (a second association) was lost to the rig's own unlock, which navigates to `/chat` first, so it counts for nothing. The push is raised once per (post, association): a withdrawn and re-asked pair rings nothing, hence the second association. The earlier sitting's "landed on the feed" is not reproduced on a build carrying #3584 |
| CanaReels "Voir plus", three-button navigation (entry closed 2026-11-16) | **`PASS` (part)** | A 125-character caption clamps to two lines with "Voir plus" over the seek slider (CSS px 800-814 against 828-860), toggling to "Voir moins" and back; the 114-character reel of the iPhone sitting does not overflow on this phone. The inset reads 49 px with the bar (24 px on gestures), never 0. Two seek taps moved the video, a tap at 88 percent of the line did not |
| Sharing into Canari, the suggestion row ([entry](backlog.d/reading-owed-sharing-into-canari-on-ios.md)) | **`PASS` (part)** | The chooser lists three Canari conversations as direct-share targets; picking the person opens Canari on "Envoyer a..." with that row highlighted |
| The stricter script policy, Mi gestures (entry deleted 2026-11-16, every half read) | **`PASS` (part)** | 0 `securitypolicyviolation` events across the chat attach menu, the GIF picker, the reel viewer and its comments, and seven routes |
| Overlays, a report dialog and a picker over a sheet over a viewer ([entry](backlog.d/reading-owed-overlays-stacked-by-open-order-not-by-rung.md)) | **`PASS` (part)** | The GIF picker and the comment report dialog each draw above the comment sheet and the reel viewer |
| Follow suggestions, the onboarding banner (entry deleted 2026-11-16, every half read) | **`PASS` (part)** | With the account under five follows the Pour toi tab draws "Suivez des comptes pour remplir votre fil" and a row of person cards |
| A HISTORY ask answered "I hold nothing", the in-session join through the deep link | **NOT READ** | Not staged: the first needs a third account joined after the history, the second an invite link only a free web seat can make, and dev links do not open the Android app ([history](backlog.d/reading-owed-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster.md), [join](backlog.d/p1-owed-one-live-reading-of-the-in-session-join-fix-2026-10-08.md)) |
| "Seeds mirrored" (an old APK), campus trends | **NOT TAKEN** | No old APK of the right age was found on disk for the mirror reading; the trend crossing cannot be staged with four bench accounts |

**Bench notes.** The rig's `unlock.mjs` navigates to `/chat` before it asks for the PIN, so it cannot be used when the question is where a notification tap landed: `pin.mjs --device A1` types the PIN and leaves the route alone. The three-button navigation was set with `cmd overlay enable com.android.internal.systemui.navbar.threebutton` and put back with the gestural overlay; the activity restarts on the PIN gate each time.

Dev data this sitting wrote (also in the harness folder's `WRITTEN-IDS.txt`): one personal post of alpha, two republication requests of beta's associations (declined on the phone), one caption edit of an alpha reel (restored) and one comment of beta on it (deleted), three association follows of alpha removed and put back.

## The iPhone 12 readings of 2026-11-15, `1.7.0-alpha.1` (third sitting)

`1.7.0-alpha.1` on the iPhone 12 (`gamma`, dev), driven over WDA (`tools/ios-device`), native lines from `pymobiledevice3 syslog live` (stopped at the end; the Canari, NSE and push lines kept, the rest of the 690 MB capture deleted), `delta` on the rig's web seat W5. Two readings only, the two halves one iPhone can stage. Evidence (screenshots, the filtered syslog, the manifest reading) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| A 13 MB attachment, the app killed with the file queued (iPhone half of a former entry, now deleted: its Mi 9T half was read on 2026-11-15) | **`PASS`: the queued file survived the kill and was sent** | A 13 631 488-byte file (13,6 MB in Files) chosen through "Tous les fichiers", the Wi-Fi switched OFF from Settings (no SIM, so no link at all), then "Envoyer": the bubble read "En attente de connexion - nouvel essai automatique" with "Reessayer maintenant" and "Annuler l'envoi". The app was ended with `ios.mjs terminate` 24 s after the send and relaunched. Once the Wi-Fi was back and the PIN gate passed, the same bubble was in the conversation reading "Envoi 2 % - 384 Ko sur 13 Mo", then "blob13.bin 13 Mo", with no `upload_error` anywhere: the bytes were still in the outbox's IndexedDB after the kill, so the evicted-blob branch did not occur. Seen on the way: the progress went from 2 % to 50 %, then read 6 % and climbed again to 84 % and the sent state (one attempt restarted at about half, cause not read: the store build has no console), and the upload ran at roughly 40 to 65 KB/s on the bench Wi-Fi, about 5 minutes from the relaunch to the sent state |
| The native caches sealed at rest, App Group half: (c) and (d) | **PARTLY READ: (d) READ for `graine_seeds.json` in the data directory; the App Group files NOT read; (c) for the group NOT read** | `pymobiledevice3 backup2 backup` (device backup encryption off, run twice, the second with the app killed and a push just handled) and its `Manifest.db` read on the workstation. **Data directory:** `graine_seeds.json` EXISTS (15 796 bytes, pulled over house_arrest, first bytes `CNSEAL1`) and is ABSENT from both manifests, while `mls.bin` (1,8 MB), `push_context.json` and `graine_seeds.lock` are PRESENT: that file carries `isExcludedFromBackup`, the two that must not do not. **App Group:** the manifests list `mls.bin`, `push_context.json` and `graine_seeds.lock` and carry neither `graine_seeds.json` nor `fcm_message_cache.ndjson`, but nothing proves they EXISTED in the group at backup time: house_arrest does not serve the group, a store build has no `bench_native_store`, and the second backup came after the push had woken the app, which booted and drained the cache. The syslog does show the NSE writing it with the app killed (`writeFcmCache: messageId=... groupId=...`, `outcome=decrypted`), then the app's boot logging `drainAppGroupFcmCache: 1 entry/entries carried over` and `backupExclusion: 2 cache file(s) excluded`: the code path ran, the flag itself was not read in the group. The injection of the killed-app message was read: the conversation list showed its text (a DM from `delta` sent while the app was killed). Not read: the `cs1:` header of `fcm_message_cache.ndjson`, the `isExcludedFromBackup` flag of the two group files, and the hardware-key list |

**What would close the App Group half.** A file the manifest lacks proves nothing unless it is known to exist. Either a bench build (it has `bench_native_store list`, which reads the group), or a backup taken between the NSE's write and the app's boot: the push wakes the app within the same second (`didReceive` at 22:12:08.30, the drain at 22:12:08.47), so no backup fits in that gap and the bench build is the way.

**Bench notes.** (1) A file reaches the iPhone's "Sur mon iPhone" without a store or a cable-served folder only through Safari: `python -m http.server` on the workstation, `ios.mjs url http://<workstation>:8123/file` (an `http` URL opens Safari), then "Download"; it lands in the picker's Downloads. `pymobiledevice3 afc push` into `/Downloads` is NOT surfaced by Files (the `blob*.bin` files already there never appear). (2) **The PIN gate needs the server**: with the Wi-Fi off the keypad answers "Impossible de contacter le serveur", so a relaunch cannot be read offline, and a second terminate-and-relaunch was needed after the Wi-Fi returned (the web view kept its offline verdict). (3) A script that types a PIN reads it through the rig's `accounts.mjs` and taps by element rectangle (`flatten` of the tree), and prints nothing of it. (4) `pymobiledevice3 backup2 backup` takes about 30 s and 330 MB on this phone, and `backup2 encryption` answers `off`. (5) Git Bash rewrites a leading `/` argument: `MSYS_NO_PATHCONV=1` for the device path of an `afc` command, a `F:/` path for the local one, and `bun` needs `F:/` paths too.

Dev data written (all in the harness's `WRITTEN-IDS.txt`): one message from `gamma` to `delta` carrying a 13 MB file, one text from `delta` to `gamma` sent while the phone's app was killed. End state: `1.7.0-alpha.1`, signed in as `gamma`, Wi-Fi on.

## The web rig readings of 2026-11-16 on `1.7.0-alpha.2`

A web-only sitting on dev `1.7.0-alpha.2` (build `dev.9ca790c`): the rig's three spare seats W6 (alpha), W7 (beta) and W8 (gamma) as three signed-in accounts, plus production and dev through the read-only form (`default_transaction_read_only` forced on and read back, aggregates only). No phone and no seat W1-W5 was touched. **Seats:** W6 and W7 held a vault locked by a PIN older than the file's (the product refused both); they were NOT recovered (that resets the PIN for every device) but made NEW devices with `newdevice.mjs` ([README](../../tools/cross-client-harness/README.md#running-it) - "re-enrolling a spare seat"), the abandoned ids purged. W8 unlocked as it was. Evidence (console captures, the drill's ndjson, scripts) stays in the harness state folder (`sitting-1700a2-weball/`); every dev write is in its `WRITTEN-IDS.txt`.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| "Modifier les pseudos", the remainder ([entry](backlog.d/reading-owed-modifier-les-pseudos-for-a-group-and-a-community.md)) | **(1), (4) community half, (6), (7) with a third member, (8) PASS; (5) LEFT** | A third seat closed during a set, a reset and a second set converged from the log; a community set against a target who blocked the setter answered "Impossible : un blocage existe entre vous et cette personne."; a reported community nickname was listed in `/admin/moderation` with its text and lost the text once changed; a blocked setter's nickname read "Un pseudo que vous ne voyez pas est defini pour vous" on the target while a third member still read it, and the target's reset cleared it on both other seats; sign-out left no `canari_nicknames:*` key. (5) needs a build older than the web's |
| A HISTORY ask answered "I hold nothing" ([entry](backlog.d/reading-owed-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster.md)) | **PASS (web half)**, Mi half left | One ask per member and one `holds nothing ... recorded` per answering device in the joining session, then no `asked` line for that community at a true cold start; answerers were other devices of alpha and gamma, not a web seat that joined after the history |
| The checkpoint every commit awaits (entry deleted: every half is read) | **LEAF-REFRESH-3 PASS (by hand); 1 and 2 PASS, 4 PASS-DIRTY on the runner's own narration gap, in [the leaf-refresh rows](#the-leaf-refresh-rows-on-the-web-rig-2026-11-16-170-alpha2-then-alpha3-dev-builds-dev9ca790c-and-dev68983e3)** | A refresh with the third seat closed: epoch 6 to 7, one `[COMMIT]`, the seat reopened read both texts once, no `[WELCOME]`; the runner `leaf.mjs` then read -1, -2 and -4 |
| The live seen-cipher mark ([entry](backlog.d/reading-owed-the-live-seen-cipher-mark-written-at-the-checkpoint.md)) | **NOT REPRODUCED (3 runs), cause unproven** | TAB-3b's shape on two small seats read 0 accusation lines; the order `processIncomingMessage` (checkpoint) then `noteFrameConsumed` is the candidate window |
| The organiser alert for a payment over capacity ([entry](backlog.d/reading-owed-the-organiser-alert-for-a-payment-over-capacity.md)) | **NOT TAKEN: cannot be** | The switch is a compiled `false`; no Lydia, no money. The flip pull request is owed |
| Campus trends ([entry](backlog.d/reading-owed-campus-trends-and-the-daily-cap-wp-8-wp-10-and-the-quieter-batch.md)) | **STAGED, NOT FIRED** | Two dev posts sit one reaction below `TREND_THRESHOLD`; the next like crosses; it rings the phones' accounts, so a phone sitting fires it |
| Native devices with no push token ([entry](backlog.d/reading-owed-a-device-with-no-push-token-now-says-so.md)) | **Server half read; the fix itself waits for the stable** | Production still `1.6.12`: 27 of 73 `1.6.12` devices tokenless, all born since the deploy; older builds 0 of 205. Dev: both `1.7.0` devices hold a token, `[PUSH_COVERAGE]` names the pre-fix builds |
| The institution's spaces and public ([entry](backlog.d/reading-owed-an-institution-chooses-each-post-s-spaces-and-public.md)) | **Web half re-read; reel path NOT reachable on the web** | The composer's picker, hints and chip again; a post staged for the phones |
| The pre-live screen says a suspension (entry deleted 2026-11-16, every half read) | **PASS on the web (the `/admin/moderation` staging, French and English, console lines); phones: English and console lines STILL OWED** | Two real cuts, strike 1 warning and strike 2 suspension; the sheet in French and English; the control after |
| A deploy's 502/503/504 ([entry](backlog.d/reading-owed-a-deploy-s-502-503-504-is-not-now-never-a-send-failure.md)) | **Web half PASS** (host restart, NOT a deploy; the true deploy drill and the phone half stay OWED) | 257 texts every 3 s across a 2-minute 502: "En attente du serveur..." then "En attente...", no failure state, all 257 on the watcher once; phones and a true deploy owed |
| Follow suggestions, "Suggestion" post (entry deleted 2026-11-16, every half read) | **PASS (web)**, staged for the phones | "Suggestion" and Suivre in Pour toi, none in Campus |
| Openings for followers (entry closed 2026-11-16) | **Nothing web-side owed** | The production booking-space re-read could not be taken (that read was unavailable) |

**Dev data written** (all in `WRITTEN-IDS.txt`): the group and communities of the pseudos and history readings, two live broadcasts and their two cuts (deleted), three reports, two blocks (lifted; they deleted alpha's follow of beta, re-created), the trend and suggestion probe posts with synthetic reaction keys, one institution post, the drill's texts. **Left in place on purpose for the phone sittings:** the trend probes (two posts), the suggestion probes (two posts) and the institution post (ids in `WRITTEN-IDS.txt`).

## The iPhone 12 readings of 2026-11-16, `1.7.0-alpha.2` (the all-entries sitting)

`1.7.0-alpha.2` (TestFlight, build `100700002`) on the iPhone 12, `gamma` on dev, driven over WDA (`tools/ios-device`); the second account was the `delta` web seat (W5, an idle seat left from the earlier iPhone sittings: every port of W1-W5 already had a Chrome, none was started or stopped). Evidence is outside the repository (`iphone-all/` of the harness folder).

**A way to read the page console of a store build (read 2026-11-16).** The in-app log is persisted by `appLog.ts` in IndexedDB (`CanariDBLog`), inside the app container that `house_arrest` serves, so `pymobiledevice3 apps pull` takes the sqlite file and its WAL and the lines decode on the workstation: `bun tools/ios-device/applog.mjs <out.txt>` (its first run prints the database directory to pass as `--db` next time, which skips a 30 s scan). 24 262 lines came out, the whole ring. It replaces the Settings > About export read in Files Quick Look (which hangs on a 2 MB text). The limit: the ring is written in batches, so the newest minutes are not on disk yet (a 34-message send loop left 4 of its lines in the file).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Call noise, the `unavailable` WARN and `ns_fallbacks` (iPhone console half, entry closed 2026-11-16) | **`PASS`** | Read from the pulled log, for the two calls of 2026-11-15 with the switch ON (`1.6.12-alpha.2` at 12:56 and `1.7.0-alpha.1` at 21:24, phone local time): `switched ON by the user`, `building the RNNoise pipeline`, `AudioContext running` (second call), `worklet ready (context running, clock date)`; the end lines `ns=on ns_fallbacks=0 frames=5000 cost_ms_per_frame=0.611 realtime_pct=6.1` and `ns_fallbacks=0 frames=9500 cost_ms_per_frame=0.455 realtime_pct=4.5`, and `[CALL_REPORT] ... phase=end ... ns=on ns_fallbacks=0 enc_frames=5520`. No `unavailable (` line of the noise suppression in the whole ring. The iPhone's half of the entry is read |
| A group Add with stale devices (#3606), the inviter's console line | **`PASS`** | The same log holds the 19:44 add of `alpha` by `gamma`: `[JOIN_PUSH] ... NOT DELIVERED to <device> - the server answered its Welcome offline ...` at WARN for each offline device and `join push -> <device> (addressable when its Welcome was answered)` for the addressable ones |
| The pre-live screen says a suspension before Start, phone WebView half (entry deleted 2026-11-16, every half read) | **`PASS`** | Two fixture rows in `live_cuts` for `gamma` (strikes 1 and 2, cut 3 days and 1 day before, not made through `/admin/moderation`), then composer, "En direct": "Vous ne pouvez plus lancer de live jusqu'au 15 décembre." with "Réessayer", "Démarrer le live" greyed (screenshot). With the rows deleted the same sheet offered Start with no line. The `[LIVE] standing` console line was not on disk when the log was pulled, so it is not claimed |
| A deploy's `502`/`503`/`504` is "not now", DM half ([entry](backlog.d/reading-owed-a-deploy-s-502-503-504-is-not-now-never-a-send-failure.md)) | **PARTIAL** | The dev job of `release.yml` run `43768081052` was re-run (23:34-23:40Z) while the phone sent 34 numbered texts to `delta` in a DM, one every 16-32 s: every send went through (the driver's log records no error for any of the 34; the label sweeps and the `delta` seat's one-copy count were read live and are NOT kept in the evidence folder, so they rest on the sitting's notes), and the phone logged two gateway reconnects (`4 pings without server response - closing zombie connection`, `Reconnecting...`, `Connected` in 1 s) at the restart. **The edge never answered a 502/503/504**: a probe of `/api/version` every 4-6 s read 200 for the whole deploy window (88 of 88 samples between 23:33Z and 23:42Z; one curl failure, `000`, at 00:09:47Z, half an hour after it), so the "not now" path itself was NOT exercised, and the salon half and the Mi 9T were not taken. A first loop (a bug of mine: it typed without focusing the composer) and a second concurrent one sent about 30 stray texts during an earlier re-run (23:20-23:26Z); they are in the DM |
| A share, the suggestion row ([entry](backlog.d/reading-owed-sharing-into-canari-on-ios.md), the P2 since deleted) | **REPRODUCED on `1.7.0-alpha.2`** | Safari on a plain page, Share, the row of four conversations drawn with the Canari badge, a tap on "Canari Test Alpha": the sheet closed, the syslog (filtered on `CanariShare`, `intent`, `suggest`, 437 lines) holds no Canari line at all (the extension did not even launch), no notification card in Notification Center, and Canari opened by hand offered no picker. One attempt on this build; the P2 stands |
| The composer stands still while the keyboard rises ([entry](backlog.d/reading-owed-the-composer-stands-still-while-the-keyboard-rises.md)) | **STILL NOT CLEAN** | WDA's MJPEG stream (9.5 frames/s here, a frame every 105 ms) while tapping the field of a group: one frame shows the keyboard half up, the native "+" at its raised place and NO web composer field, the next has everything settled. The shape of 2026-10-11 (the web layer behind the native "+") is shorter, at most two frames of a 105 ms cadence, but still there. The stream's cadence is too coarse to give a duration |
| A reel, "Voir plus" and the seek line | not retaken | The iPhone half was already read; the far-right seek tap and a zero-inset phone are Mi-side |
| Stricter script policy, iPhone gestures | **NOT READABLE** | `securitypolicyviolation` is not a console call the app log hooks, and a store build's WebView is not inspectable; no iOS 16 device exists |
| The camera preview for a real take | **NOT POSSIBLE** | The "En direct" camera preview is black: the lens is still covered, so no real-content take exists on this phone |

**Not taken in this sitting, and why.** Birthdays (the morning notice and the next-day ring are read by the morning tick, which cannot be forced), an institution reel and its edit form (no staging account other than `gamma`, who is the global admin and was not used for a reel upload), the "Suggestion" post in Pour toi (a third account has to publish; not staged), the pseudos remainder, the remaining overlays (a comment report needs another account's comment on a reel; the message-actions sheet over a reel waits for CanaReels in chats), a first message from an account with no conversation (none of the four bench accounts is without one and a fifth needs an identity-provider sign-in), the iOS rig adapter (a campaign of its own, target 1.10.0), the iPhone enrolment record (it lives in `cas-test.json`, a file this sitting was not to open), and the F1 readings (see below). The in-dialog dropdown of "Nouvelle discussion" was seen drawn above its dialog with the recent names tappable, a tap on one closed nothing; not a verdict.

Dev data written (all in `WRITTEN-IDS.txt`): about 36 DM texts `DD...` from `gamma` to `delta`, two `live_cuts` fixture rows (deleted), a dev re-run of the release's dev job.

## The leaf-refresh rows on the web rig, 2026-11-16 (`1.7.0-alpha.2` then `alpha.3`, dev builds `dev.9ca790c` and `dev.68983e3`)

The runner the reading "the checkpoint every commit awaits" was missing: `tools/cross-client-harness/archive/leaf.mjs` (table and judges `leafrows.mjs`, pinned by `archive/leaf-selftest.mjs`, phase `LEAF` in `checks.mjs` for -1 and -2) on the two spare Chrome seats W6 (alpha) and W7 (beta); no other seat, no phone, nothing on production. Every fault goes through CDP `Fetch` (`fault.mjs`) and `Network.emulateNetworkConditions` (`net.mjs`); every step waits on a logged fact (a held request, the client's own `[COMMIT] ... resubmission ...: <verdict>` line, the gateway reconnecting, a pane showing a marker). The gate's `[COMMIT]` lines in order are the evidence. Each row mints its own `LEAF<n>-<mark>` group (ledger-owned, deleted through the product on a pass). LEAF-REFRESH-3 (a refresh with a member offline) arms no fault and was read by hand on the same day ([web rig](#the-web-rig-readings-of-2026-11-16-on-170-alpha2)).

| Row | Verdict | What was seen |
| --- | --- | --- |
| LEAF-REFRESH-1, the link cut while a due refresh is submitted | **`PASS`** on `dev.68983e3` (every assertion, both invariant passes, both consoles and the server window clean; on three other runs of the same build `PASS-DIRTY` on the filed creation defect below only) | The owner's ledger was backdated eight days; its trigger text made the refresh commit, whose POST was held before the server, the link cut and the held request failed (it never left: the gate decided nothing). The client wrote `resubmission of the commit from epoch 2: unknown` and kept the stage. The commit POST was then answered `503` unsent with the link UP and the gateway reconnected: in that window the owner's two row-group texts were shown 0 times on the peer while its text in a side group reached the peer. With the 503 lifted the client wrote `resubmission ...: accepted`, the gate wrote one `ACCEPT` (epoch 2 to 3), no refusal, no duplicate, and the trigger and both texts arrived once. The ledger then named epoch 3 as a refresh, dated after the backdating, for a new leaf. The first request never reached the server, so the answer is ACCEPT; the lost-answer shape (DUPLICATE) is DUP-1 and OFF-2 |
| LEAF-REFRESH-2, a reload while the commit POST is held | **`PASS`** on `dev.68983e3` | The refresh commit's POST was held (the gate had decided nothing), the page reloaded (about 250 ms). After it the client wrote `[COMMIT] settling 1 staged commit(s) by resubmission` and `resubmission of the commit from epoch 2: accepted`; one `ACCEPT` to epoch 3, no duplicate, no refusal; the ledger named epoch 3, a refresh, a new leaf. The stage and its record therefore came back from disk |
| LEAF-REFRESH-4, a device of the peer revoked | **`PASS-DIRTY` on `dev.9ca790c`, before the narration below; replayed clean over its recorded consoles, NOT re-run** | W7's own campaign-owned device was revoked with `DELETE /api/mls/devices/...` (200) and, in the same page script, a commit was attempted from it: `403 {"code":"DEVICE_REVOKED"}`, and the gate logged `[COMMIT][...] REJECT device_revoked` for the row's group. W6 was then reloaded: it logged one `[STRAY] <group>... 1 revoked device(s) still hold a leaf - removing` in each of 12 groups (12 distinct groups, none twice), each followed by `is now at epoch N - the revoked leaves are gone from the tree`; the row's group moved 2 to 3 by a commit of W6's own device. Those 11 other groups are real test conversations shared by alpha and beta: the product removed only the revoked device's leaf there. Not re-run because it revokes W7's device and W7 is then re-enrolled by hand; its server window was not read |

**How `PASS-DIRTY` became `PASS`.** The first runs were `PASS-DIRTY` on lines the rig's narration did not cover. Each was classified, and the sentences are pinned (at their level, in their happy spelling) in `leafrows.mjs`: the overlay stack, one `join push ->` per delivered Welcome, the peer's `already in tree ... vouching` and its add-lock skip, the group view settling and its one history ask, the boot's decisions (`[LEDGER]`, `[NICKNAME]`, the `[GRAINE]` reasons for a history not asked), the history requests addressed to the owner's other devices, the delivery crossing's one sentence, and the notification-permission asks of an idle window; on -4 only, the revoked seat's wipe steps and the 403 of the commit it was told to attempt. On the SERVER side the window was dirty too (a `PASS-DIRTY` is also a dirty server window), on routine lines `srvlog.mjs` had never read: the gateway's frame census, a Welcome's addressability, the page's boot reads, an avatar `304`, a push registration's end after a sign-out, and the `seat=` the distribution-group read now prints. They are BENIGN now, each pinned beside its dirty twin (`seat=pending`, an unavailable avatar, a push registration that was NOT ended); a phone install of the bench account without a push token is the leaf rows' own (`ROW_RULES`). **One line is a defect and is NOT narrated**: creating a group sometimes makes the creating device discover it as a placeholder (and once recover it), on `dev.68983e3` and not on `dev.9ca790c` ([chat](frontend/modules/chat.md#between-the-registration-and-the-row-a-creating-group-looked-lost-to-the-connection-sweeps-2026-11-16), fixed by #3666 and read below); a run it touched stayed `PASS-DIRTY`, which was its honest verdict.

**Rig facts found.** The server window of a row on the shared dev estate also carries other sittings' sign-outs and deploys: a run overlapped by a release is `VACUOUS` (several were, while `v1.7.0-alpha.3` deployed and `social-service` briefly ran twice). Docker reads a fractional `--since` exactly (measured on the local estate, to the nanosecond), so a fractional instant is not what dropped a `REJECT` line from -4's window on dev: the log's clock is the container's and the instant is the host's, and -4's first gate line follows its start by well under a second. -4 therefore opens its window two seconds early; the other rows of `leaf.mjs` read windows whose first gate line follows their start by seconds, and need no margin. During the cut, a commit POST held at the request stage is released by `fail()`, and one released by `release()` while offline fails by itself: both read as a transport failure. The `newdevice.mjs` re-enrolments of W7 between 01:57 and 02:11Z each wrote a `HEAL-NEW-0` `FAIL` into `results.ndjson` (it reports `sameAccount=false` on a spare seat): those records are a seat being re-enrolled, **not a reading of HEAL-NEW-0**, and no page cites them. Dev data written is in `WRITTEN-IDS.txt` (the row groups, all deleted; the revoked W7 devices).

**The group-creation placeholder, read on `dev.9c109dc` (`1.7.0-alpha.4`, 2026-11-16): `PASS`, entry deleted.** The two spare seats were reloaded past the cache onto the served bundle (`__sveltekit_ndkbj0` to `__sveltekit_7ybmrn`, no PIN gate); every result's `build` names `9c109dcf2`, the fix's bundle, and `estateBuild` `dev.9c109dc` at the start and the end. Five `bun archive/leaf.mjs --row LEAF-REFRESH-1` runs, ten group creations (each run mints the row's group and a side group): all five assertions `PASS`; four runs `PASS` clean, one `PASS-DIRTY`. None of `[DISCOVERY] Placeholder`, `absent locally`, `already in WASM`, `[HISTORY_RECONCILE] no member online` for a new group, or a `[PENDING] N pending invitation(s) to process` line counting the creating seat's rows appears on the owner's seat (W6): the four clean runs carry no unexplained line, and `leafrows.mjs` narrates none of these sentences, so a clean verdict is their absence; the dirty run's console (the only one the runner keeps, `LEAF-REFRESH-1-...T04-48-43-516Z-W6.log`) was searched for each and holds none. The one `[PENDING] 3 pending invitation(s) to process` pair in it is on the peer seat (W7), the invitee, as it must be. **The dirty run shows the window was crossed:** at 05:46:26 on W6 a connection sweep ran while the group was being created and wrote `[Pending] c8c28876... is being created by this device - its 13 row(s) are left to the creation's own Add; any row it does not answer waits for the next sweep` and `[Discovery] c8c28876... is being created by this device - its row is the creation's to write`, the fix's own two sentences, and nothing followed (no placeholder, no recovery). Those two sentences were not in `leafrows.mjs`'s narration, so that run was `PASS-DIRTY` on them only; they are now pinned at `debug` in `LEAF_ROW_NARRATION` (and `leaf-selftest.mjs` judges a run carrying them clean, a placeholder still dirt). The window overlapped in one run of five, so the other four are a negative reading.

## The iPhone 12 readings of 2026-11-16 (second sitting), `1.7.0-alpha.2`: the staged readings, cut short by a sign-out

`1.7.0-alpha.2` (TestFlight) on the iPhone 12, `gamma` on dev, driven over WDA (`tools/ios-device`); the other account was the idle web seat W7 (`beta`, one send). Evidence is outside the repository (`iphone-next/` of the harness folder).

**HOW IT ENDED, FIRST.** The sitting stopped at about 02:00 phone time with the app **signed out** of `gamma`. The PIN gate came up on a WebView reload the app made itself (the log: `App in background` at 01:54:14, then `Initialised in TAURI mode`, `No device key in vault for this account - auto-login impossible` and `Keypad shown` at 01:56:15), and the unlock script that followed ended on MiConnect's "Se connecter". The `[A] logout` line is not on disk (the log ring is written in batches and the pull stops at 01:58:36), so **which tap signed the account out is not read**. The candidate is the known P3 (the gate's one-tap "Se deconnecter" under the tab bar; entry deleted 2026-11-16, every half read): on the iPhone the same overlap holds, the gate's "Se deconnecter" at 127-263 x 761-794 points and the floating tab bar at y 761-844. Signing back in needs the account's identity-provider credentials, which live in `cas-test.json` (not opened, by rule), and the keyboard's AutoFill held no saved password for the identity provider. **The iPhone is left at the Canari login page and nothing more can be read on it until `gamma` is signed back in.** Nothing was uninstalled, TestFlight was not touched, and the bench IPA was not installed (its precondition, a local-stack account, was not met, and installing over a phone with no way back in would have stranded it).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| "Modifier les pseudos", iPhone half, group ([entry](backlog.d/reading-owed-modifier-les-pseudos-for-a-group-and-a-community.md)) | **`PASS`** | In a group `alpha` created (members `alpha`, `beta`, `gamma`): "Gestion du groupe" > "Modifier les pseudos" opens a sheet listing the three members; `gamma`'s own nickname set earlier from the web shows as "Gam1 / Canari Test Gamma - Defini par Canari Test Alpha" with a reset and an edit control. Set from the iPhone: the pencil on `beta`, the field, "Valider" gave "Bet1 / Canari Test Beta - Defini par Canari Test Gamma". `beta` (web seat) then sent a text: in the conversation the sender's name read "Bet1" on the phone. "Reinitialiser" on `beta` brought "Definir un pseudo" back at once. Dark theme not taken |
| "Modifier les pseudos", iPhone half, community | **`PASS`** | In a community where `alpha` is administrator and `beta`, `gamma` are members: the salon's "Membres" lists `gamma` as "Gam3" (set by `alpha`); the sheet says "Seuls les moderateurs en definissent ; chacun peut effacer le sien", shows "Canari Test Gamma - Defini par Canari Test Alpha" with "Reinitialiser" and no edit pencil for a member; "Reinitialiser" cleared it |
| An institution CanaReel, the publish step on the iPhone ([entry](backlog.d/reading-owed-an-institution-chooses-each-post-s-spaces-and-public.md)) | **`PASS` for the step, `PARTIAL` for the rest** | "Publier" > "Photo/video" opened the system picker over the library (it holds black 3-5 s clips, the lens being covered); one clip attached, with the notice "Une video verticale de 90 secondes au plus est un CanaReel". "Publier en tant que" > "Ecole Fictive": the "Rayon d'action" picker with nothing pre-selected, "Choisissez au moins un espace et un public pour publier." and "Publier" greyed; with "Saint-Etienne" (all its cells) and "Etudiants" ticked the hint reads "Seuls les etudiants des espaces coches et les membres de Ecole Fictive le verront." and "Publier" is live. Published: the card in "Organisations" carries the chip "Etudiants - 5 espaces" with the title "Visible par : ..." naming the five spaces, and the CanaReels viewer carries the same chip in its bottom row, legible on the black. **The edit form was not found**: a reel's card menu offers Partager, Republier (pour mes abonnes), Proposer a une association, the "Epingler pour ..." rows, "Supprimer le post" and "Signaler ce post", and no "Modifier" (the viewer has none either), so no edit form was read; a text post by an institution was not staged before the sign-out. Light theme only; the republished card was not taken |
| The "Entre etudiants" switch and chip, iPhone | **`PARTIAL`** | "Publier en tant que" > "BDE Fictif": the switch "Entre etudiants" with the line "Visible par tout le public de BDE Fictif, personnel et lecteurs nommes compris." (off) and, once on, "Seuls les etudiants et les membres de BDE Fictif le verront. Le personnel et les lecteurs nommes ne le verront pas." (read from the accessibility tree); with a clip attached it published, and the card drew the chip "Entre etudiants". The chip in the CanaReels viewer, the switch in an edit form, and the dark theme were not read |
| The "Suggestion" post in "Pour toi" | **NOT TAKEN** | Signed out before it was staged |
| Overlays: the comment report dialog on a POST comment, and the "Nouvelle discussion" dropdown drawn above its dialog | **NOT TAKEN** | Signed out before either. No defect is filed for the dropdown: it was not read properly in this sitting |
| The alpha.2 rows, the flat versus glass look, the back-arrow controls | **NOT TAKEN** (one observation) | Seen only in passing: the floating glass tab bar draws OVER the lower items of a long card menu (a menu opened from a card low in the feed extends under the bar, "Epingler pour PDIS" and "Supprimer le post" half behind it until the menu is scrolled); not a verdict on the entry |
| A first message from a new contact | **NOT STAGEABLE on dev** | A read-only query of the dev database: `gamma` already shares a direct conversation with each of the three other test accounts that hold a device (`alpha`, `beta`, `delta`). The only other accounts with key packages are two real members' accounts (not used); the 21 seeded "Fictif" accounts hold none, so none can send an end-to-end message. A fifth test account needs an identity-provider sign-in |
| F1 notification tap and the App Group, on the bench IPA (entry deleted 2026-11-16 once its last half was read) | **NOT TAKEN** | The local stack is up (`canari-local-nginx-1` healthy, `:8081`) and the IPA is at `F:/tmp/ios-bench-43773355205/`, but no local-stack account was prepared, and the phone could no longer be signed in to dev afterwards, so installing a differently signed build over it was not attempted. "Bench IPA install over TestFlight refused" is therefore **not recorded: it was never tried** |

**Observations that are not verdicts.** (1) In the group above the first system line reads "Utilisateur inconnu a ajoute Utilisateur inconnu, Utilisateur inconnu au groupe" on the phone, while the lines after it name `alpha`, `gamma` and `beta` ("a ajoute un appareil"): the same symptom as [the notice-ids entry](protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice) fixed by #3657, which `1.7.0-alpha.2` does not carry; seen again here, a group `alpha` created on a web seat, and it is that entry's reading on the next pre-release that settles it. (2) A plain WDA tap on the composer's microphone (a channel with an empty composer) started a voice recording that the trash icon, a swipe left, a second tap on the microphone and a W3C press-and-drag did not stop; it ran 2:09 until the screen was left with the back arrow, which ended it (no note was sent). A held finger is the intended gesture, so this may be an artefact of a synthetic tap that never lifts; it was not retried by hand and is not filed. (3) The WDA focus guard believed a field had focus while none was drawn (a stale element after a sheet closed), so a tap in the lower band needed `--over-keyboard`; typing into a pseudo field needed a tap on the field first (the first `type` read 17 characters in another element and cleared it).

Dev data written (all in the harness's `WRITTEN-IDS.txt`): one group text from `beta` ("In1 nick probe") in the pseudos group, left; the nickname of `beta` set and reset from the iPhone; the community nickname of `gamma` cleared; two reels by `gamma` (an institution's and an association's) published, then DELETED by SQL because the phone could no longer delete them from the card menu.

## The Mi 9T readings of 2026-11-16 on `1.7.0-alpha.4`

`1.7.0-alpha.4` (versionName 1.7.0, versionCode 100700004, the release's `app-universal-release.apk`) on the Mi 9T, the `alpha` account, dev estate. The phone ran a sideloaded `alpha.2` (100700002); `adb install -r` over it succeeded (`firstInstallTime` unchanged, no uninstall, the enrolment and the account survived; Play Protect's "send for a check" prompt answered "Ne pas envoyer"). `a1tester.mjs --tag v1.7.0-alpha.4` ACCEPTED it (the Android job's log prints `Android build targets dev`; the running bundle is `9c109dcf2`, built 2026-11-16T04:26Z). The web seat used was W2 (`beta`, idle, no focus taken) to create one group; no other seat was touched, and the iPhone was not used. Taps went through `cdp.mjs click` and the harness's held-press helper; the Android system dialogs (Play Protect, the file picker) were answered through the Android-MCP selector click, never a coordinate tap. Evidence (screenshots, logcat, the console capture of the upload) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| The PIN gate's sign-out in a top row (entry deleted 2026-11-16, every half read), Mi half | **`PASS`** | The gate came up on its own after the install and after every full document load (a rig navigation re-armed it). "Se deconnecter" is drawn at the top right, 42-72 css px from the top, left 304, 121 wide; the screenshot shows it clear of the status bar. The 436x945 css page has nothing near the bottom edge except the "Deverrouiller" button, so nothing under the bottom tab bar can sign out. It was not tapped |
| The composer's "Plus d'options" and "Entre etudiants uniquement" | **`PASS`** | As `alpha` the composer shows no such control; choosing "Bureau des eleves" in "Publier en tant que" adds "Lier a un evenement valide" and a collapsed "Plus d'options" (`details` closed); one tap opens it on the toggle "Entre etudiants uniquement", OFF. The switch was not flipped by a read I can vouch for (it is a checkbox input and the selector click did not change it), so only the disclosure and the default are read. Nothing was published; the composer was closed |
| A Back to the feed lands on the remembered post, Pour toi, 3 runs ([entry](backlog.d/p3-the-feed-offset-restored-after-a-back-from-an-association-lands-about-226-px.md)) | **`PARTIAL`: the post is right, the place is not exact** | Route: feed scrolled to 1500 css px, a post's author profile, an association from it, the hardware Back twice. The same anchor post came back in all three runs, but 45, 48 and 45 px lower in the viewport than where it was left (its top at -513 before, -468, -465, -468 after; the page scroll box at 1500 before, 1455, 1452, 1455 after). The runs repeat to 3 px. It is not the 226 px of `alpha.2`, and it is more than the "within a pixel" the restore asserts |
| A Back to the feed, Organisations, 3 runs | **`FAIL`, one defect, 3 of 3** | The same route started on the "Organisations" tab (scroll box at 1500, the anchor at -234): every Back returned to `/posts` with the "Pour toi" tab selected and the page at the top (0). The remembered place is not restored on this tab, and the tab itself is not remembered. Filed in the entry above |
| The group Welcome names, a group made by a web seat ([entry](protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice)), Mi half | **`PASS`** | `beta` (W2) created "MIA4-WELCOME-1116" and added `alpha`; the Mi joined from the Welcome and the thread's first line read "Canari Test Beta a ajoute Canari Test Alpha au groupe", also after the app was force-stopped and relaunched. No "Utilisateur inconnu" in that thread. The web seat's own view and the iPhone were not read |
| The header icons | **read on the mobile bar; the desktop bar is not shown** | The Mi draws the mobile bar (publish, search, notifications, "Nos autres sites", the avatar). The desktop bar's three controls (apps, sign-out, avatar) are in the DOM at 0x0, hidden; the mobile bar's apps and avatar controls measure 44x44. The "one centre line" fix is a desktop-bar change and is not readable on this phone |
| A 13 MB attachment, queued offline, the app killed, relaunched ([entry](backlog.d/p3-a-13-mb-upload-on-the-iphone-restarted-at-half-and-ran-at-40-to-65-kb-s.md)), Mi half | **`PASS` for the send, "never goes back" NOT read** | A 13 631 488-byte `.bin` chosen through "Tous les fichiers" in the group above. Wi-Fi OFF (`svc wifi disable`; no SIM), "Envoyer": the bubble read "En attente de connexion - nouvel essai automatique". The app was force-stopped 15 s later and relaunched with the Wi-Fi back; after the PIN gate the file was sent. Console: `[OUTBOX] payload read in 92 ms (13631488 file bytes)`, `uploadResumably: ... new session`, `[UPLOAD-RESUME] session ... opened: 13631504 bytes`, `round 1: 13631504 bytes committed in 8536 ms (1597 KB/s), 14/14 part(s) held`, `completed`, `[OUTBOX] ... sent`. The figure was not watched while it ran after the relaunch (the bytes went in one round), so the bar never going back is NOT read on this run |
| The same file, the Wi-Fi cut once mid-upload | **`PASS`** | Sent with the Wi-Fi on, cut 3 s later for 12 s, then back on: `round 1: 1048576 bytes committed in 12315 ms (85 KB/s), 1/14 part(s) held`, `attempt ended (UploadNetworkError, no answer) - session kept for the next attempt`, `transient failure (attempt 1)`, `Flush skipped - offline` twice; on reconnect `resuming ...` then `[UPLOAD-RESUME] session ... resumed: the server holds 3/14 part(s)` (k = 3 > 0), `round 1: 10485776 bytes committed in 7503 ms (1398 KB/s), 14/14 part(s) held`, `completed`, sent. One read of the bubble during the resume said "Envoi 51 % - 6,7 Mo sur 13 Mo". On this phone and this Wi-Fi the link rate is 1.4 to 1.6 MB/s (the 85 KB/s round is the cut one), so nothing here reproduces the iPhone's 40 to 65 KB/s. Logcat does NOT carry the app's console: the `[UPLOAD-RESUME]` lines were read over CDP (`Runtime.consoleAPICalled`, which replays the buffer on attach) |
| The front-camera CanaReel take left last time ([entry](backlog.d/reading-owed-the-canareels-composer-viewer-and-editor-on-real-content.md)) | **`PASS` for the take; the editor only opened** | The composer's "Ouvrir la camera" (this time neither lens was covered: both drew a real scene), "Changer de camera" to the `user` lens (720x1280), the shutter held 4 s through the harness's held-press helper: a 4.02 s 720x1280 video, then the review with its edit and discard controls and "Suivant". "Modifier la photo ou la video" opens "Modifier la capture" with text, emoji, draw, erase, undo and trash tools; none was exercised and "Suivant" was not taken. The discard asks "Abandonner cette capture ? Elle ne pourra pas etre recuperee." with "La garder" and "Abandonner" (read, taken). Camera, then composer, closed; nothing published |

Seen on the way: a full `nav` of the WebView re-arms the PIN gate (the vault path is off), and the hardware Back then left the app on a stale `/settings` document, so the route measurements went through in-app links only; the chat list's rows sit under an open conversation, so a text click on a row name opened another conversation twice (a DM with `gamma`, a group) before the file was sent: the 13 MB file was removed from that composer before any send, and nothing went to `gamma`. The Android-MCP keyboard (`AdbKeyboard`) is the phone's default input method.

Dev data written (all in the harness's `WRITTEN-IDS.txt`): the group "MIA4-WELCOME-1116" (by `beta`, `alpha` added) and two 13 MB file messages from `alpha` in it, all deleted with the group through the product; the file was removed from the phone's Download folder. While cleaning up, four `adb logcat -v time` processes of this workstation were stopped with one command; one was this sitting's, the other three are unattributed (stale, or possibly another sitting's).

## The both-phones readings of 2026-11-16 on `1.7.0-alpha.4`

Mi 9T (`alpha`, `1.7.0-alpha.4`, console over CDP through a small logger kept outside the repository) and iPhone 12 (`gamma`, TestFlight `1.7.0-alpha.4`, WDA; the console read afterwards from the persisted in-app log with `tools/ios-device/applog.mjs`), dev estate. Evidence (console captures, `dumpsys audio`, screenshots) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Call noise suppression, a call between the phones (entry closed 2026-11-16) | **`PASS` on both** | `alpha` dialled `gamma` (header menu, "Appel audio"), the iPhone accepted. Switch ON on both phones mid-call. Mi: `worklet ready (context running)`, ticks `ns=on`, end `ns=on ns_fallbacks=0 frames=3000 cost_ms_per_frame=1.323 realtime_pct=13.2`; `dumpsys audio` `MODE_IN_COMMUNICATION` and the earpiece before and after, `MODE_NORMAL` after the hang-up. iPhone: switch value 1 ("Couper la reduction du bruit"), `worklet ready`, end `ns=on ns_fallbacks=0 frames=3500 cost_ms_per_frame=0.486 realtime_pct=4.9`, no `unavailable (` line in the ring (23 675 lines). The speaker button could not be read ("Haut-parleur" never drew; the button read "Ecouteur") and no lock was taken in this call, the earlier sittings having read both |
| Rotation, the reel pager on the iPhone ([entry](backlog.d/rotation-on-video-and-camera-screens.md)) | **`PARTIAL`** | A portrait reel refused a WDA turn; a landscape reel turned (844x390) with the rotate button, clear insets and the rail; a swipe to a vertical item put the app back in portrait and refused the next turn; in portrait the landscape reel is letterboxed and "Passer en paysage" / "Revenir en portrait" forced and released landscape. Lock ON, lightbox, live viewer and the Mi lock-OFF turn NOT read |
| The PIN gate's sign-out in a top row, iPhone half (entry deleted 2026-11-16, every half read) | **NOT READ** | After sign-out and a sign-in through the local password page, and a relaunch, the app opened with no gate (vault path on): nothing to measure |
| The Organisations Back on the Mi with a history logger ([entry](backlog.d/p3-the-feed-offset-restored-after-a-back-from-an-association-lands-about-226-px.md)) | **NOT REPRODUCED; the ghost walk's `history.back()` observed** | Two runs landed on the Organisations tab (scroll 1500 to 1184). With a ghost `canariOverlay` entry left by a sheet closed through Escape, the app issued one `back` after the Back landed on it, and ended on the feed's entry. Detail in the entry |
| The in-session community join through the deep link; a first message from someone with no conversation; sharing into Canari on iOS | **NOT TAKEN** | Staging not done (join), no account without a conversation exists (first message), time (sharing) |

Seen on the way: the app's "Plus d'actions" call menu holds the audio and video call buttons on this narrow layout (the header ones are 0x0); a WDA tap at the close control while the window was still landscape landed on the home screen and started Weather's location prompt, answered "Don't Allow", Canari relaunched in the reel pager (the process had been replaced). Dev data written: one call record between `alpha` and `gamma`; nothing else.

## The iPhone 12 readings of 2026-11-16 (third sitting), `1.7.0-alpha.4`

TestFlight `1.7.0-alpha.4` (build `100700004`) on the iPhone 12, `gamma` on dev, driven over WDA (`tools/ios-device`); web seats W6 (`alpha`) and W7 (`beta`) were used once each (a group, a comment), no other seat was touched and nothing was killed. Evidence (screenshots, the pulled in-app logs, the signing log) is outside the repository.

**Health.** The phone was seen over USB (`pymobiledevice3 usbmux list`) but nothing answered on `:8100`: the WDA daemon had gone with the unplug, so `tools/ios-device/wda-daemon.py` was started again (tunnel up in 3 s, runner on `:8100`, `/status` answered at once); no re-pair was needed. The app was `alpha.2` (`100700002`); the TestFlight app offered `100700004`, and "Update" then "Open" installed it (no uninstall). `pymobiledevice3 syslog live` streamed at once. **Signing `gamma` back in needs no CAS**: the login page's "Connexion externe (service-account)", the system alert "Canari Wants to Use miconnect.emse.fr to Sign In" (Continue), then MiConnect's own "Connexion par mot de passe" page ("Email or Username", then the password) and the PIN gate; the login, password and PIN came from the rig's `test-accounts.json` (`accounts.third`) through stdin and were never printed. Two driver traps: the first `ios.mjs type` into the Safari view's field answered "typed 17 characters but the field reports 17 characters; field cleared" (equal lengths, still cleared), and a `tap --over-keyboard` on the field first made the next `type` stick; and `ios.mjs long x y ms` fails on this runner with `WDA 500 -[NSNull floatValue]` (use `hold <label> <seconds>` on the element instead).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| The CanaReels composer, viewer and editor on real content, iPhone half ([entry](backlog.d/reading-owed-the-canareels-composer-viewer-and-editor-on-real-content.md)) | **`PASS`** (take, editor, export, publish, viewer); frame timing NOT measured | The lenses are uncovered: the composer's "Ouvrir la camera" drew a real scene (the rear lens, a floor and a skirting board). The shutter held 4 s (`hold "Photo (toucher)" 4`) gave a take; "Modifier la capture" opened and a white pencil stroke, the sticker panel (an emoji placed at the centre) and a text ("Bench iPhone", OK) all drew. **"Suivant" WITH overlays on a video take now works**: "Nouveau CanaReel" opened with the 1-year notice, its thumbnail black for about 4 s then showing the take with the text, the sticker and the stroke burned in (the `alpha.2` run FAILED here); "Publier" posted it (the card read "A l'instant" in Campus, overlays drawn), and the CanaReels viewer played it with the overlays; a swipe up moved to the next reel and a swipe down came back. Not read: the viewer swipe frame timing (WDA's MJPEG runs at about 9.5 frames a second, too coarse), check CR "Garder comme post" (not looked for), and the edited PHOTO take |
| The PIN gate's sign-out in a top row (entry deleted 2026-11-16, every half read), iPhone half | **NOT READ on `alpha.4`** | The gate showed once in the sitting, on `alpha.2` (its sign-out still at the bottom, over the tab bar's zone: the geometry the entry already records). After `alpha.4` was installed no document showed the gate again: a misplaced tap ticked "Rester connecte sur cet appareil" on the first sign-in, and from then a terminate and relaunch, a sign-out and sign-in, and a TestFlight replace all went straight to the feed. The phone's Securite & appareils page does not offer the switch, so the gate could not be raised on demand; the reading needs a sign-in with the box left UNTICKED |
| A group's Welcome notice names its people, a group made by a web seat ([entry](protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice)), iPhone half | **`PASS`** | `alpha` (W6) created a sandbox group and added `gamma`: the phone's log shows `[QUEUE] Processing Welcome group=5fd9196d...`, `[WELCOME] ... ready` and `System event 'memberAdded'` at 08:45:30; the list preview and the thread's one system line read "Canari Test Alpha a ajoute Canari Test Gamma au groupe", also after `terminate` and a relaunch (the load from the store). The old "Utilisateur inconnu" of `alpha.2` is gone for a group a web seat made. The group `I1700b`, whose line was damaged under `alpha.1`, reads "Canari Test Delta a ajoute Canari Test Gamma au groupe" - **read after the TestFlight replace described below, so it may be a fresh load and not the in-place repair of a damaged stored row**. The same group read on a web seat was tried through a harness script on W8 and returned an empty pane: NOT read |
| A newcomer's own "X a ajoute Y" notice ([entry](protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice)) | **`PARTIAL`** | Same cause and same code as the row above, and the Welcome path reads right on the phone; the link-and-accept route of that entry was not repeated |
| The composer's "Plus d'options" and the students-only toggle (#3660) | **`PASS`** | As `gamma` the composer shows none; "Publier en tant que" > "BDE Fictif" adds "Lier a un evenement valide" and a collapsed "Plus d'options"; one tap opens one plain toggle, "Entre etudiants uniquement", with no sub-line; ON (the track turns yellow) it stays on after the section is closed and opened again. Nothing was published; light theme only |
| A Back to the feed puts the same post back (#3655, [entry](backlog.d/p3-the-feed-offset-restored-after-a-back-from-an-association-lands-about-226-px.md)), iPhone half | **`PASS`, one run, Organisations tab** | Organisations scrolled by four swipes (the "PL pdf" card of BDE Fictif 194 points from the top), a tap on that card's association name, then the page's "Retour : Associations": the feed came back on the Organisations tab with the same card at the same place (the two screenshots are identical at the pixel). This is the card-header route, not the Mi's profile-then-association route, and Pour toi was not run on the iPhone |
| A 13 MB upload killed and relaunched ([entry](backlog.d/p3-a-13-mb-upload-on-the-iphone-restarted-at-half-and-ran-at-40-to-65-kb-s.md)) | **`PASS` for the send and the rate; "never goes back" and the mid-upload cut NOT read** | `blob13.bin` (13 631 488 bytes, already in Files), "Tous les fichiers" in the DM with `delta`, Wi-Fi OFF from Settings, send: "En attente de connexion". `terminate` 20 s later, relaunch, Wi-Fi back. The in-app log pulled by `applog.mjs`: `Flush skipped - offline`, `payload read in 39 ms (13631488 file bytes)`, `upload started outside the lane`, `[UPLOAD-RESUME] session c8497081... opened: 13631504 bytes`, `round 1: 13631504 bytes committed in 5707 ms (2389 KB/s), 14/14 part(s) held`, `completed`, `[OUTBOX] ... sent` (08:34:03 to 08:34:10). **The phone's rate is 2.4 MB/s on this Wi-Fi, so the 40-65 KB/s of `alpha.1` is not the phone's path.** The whole upload takes 6 s, so the bubble's figure was never sampled, and a Wi-Fi cut needs a toggle faster than WDA's 3 s; not attempted. The first pull stopped at 08:34:07 and lacked the round line: the ring is written when the app goes to the background (`button home` then a second pull held it) |
| The comment report dialog on a POST comment ([entry](backlog.d/reading-owed-overlays-stacked-by-open-order-not-by-rung.md)) | **`PASS`** | `beta` (W7) commented on the first Organisations post; on the phone the "Commentaires" sheet shows it with a flag; the flag opens "Signaler ce commentaire" (Spam, Harcelement, Contenu inapproprie, Autre; "Signaler" greyed) drawn whole over the sheet and the feed; "Annuler" closed the dialog only |
| A confirmation raised from a modal | **`PASS`** | The sheet's trash (shown on another account's comment: `gamma` is the global admin) raised "Supprimer ce commentaire ? Ses reponses seront supprimees aussi." over the sheet; "Supprimer" removed it ("Soyez le premier...") |
| The "Nouvelle discussion" dropdown inside its dialog | **`PASS`** | "Canari" typed in "Contact": a listbox of four names (Beta, dev smoke, Alpha, Delta) is drawn over the dialog's lower part (the "Demarrer la discussion" button sits under it); a tap on "Canari Test Beta" filled the field and closed the list |
| The message-actions sheet and the emoji picker | **`PASS` over a chat; NOT over a reel** | A hold on a message of the DM drew the reaction strip and the action bar over the dimmed chat; the "+" of the strip opened the full emoji picker above the chat, and a tap outside closed it with the chat unchanged. The native composer "+" stays drawn at the picker's bottom left (native controls sit above the web layer). Over a reel: CanaReels in chats are not flipped. Not read: the guided help and the toast over the stack |
| The "Suggestion" post in Pour toi (entry deleted 2026-11-16, every half read) | **`PASS`** | The post `alpha` staged for this phone ("Suggestion probe A 1700", four synthetic reactions) is the last card of Pour toi, after the followed people's posts: "Canari Test Alpha - 7 h - Suggestion - Suivre", then "Vous avez tout vu !". Campus lists the same post with "Suivre" and no "Suggestion" word. "Suivre" was not tapped (a request would push `alpha`'s phone). With the Mi's rows this closes the entry |
| F1 notification tap and the App Group, on the bench IPA (entry deleted 2026-11-16 once its last half was read) | **NOT READ; the install was NOT refused** | `tools/ios-device/sign-install.mjs` signed the CI bench IPA (`ios-bench-43773355205`, `1.7.0` build `100700001`, local origin at the workstation's LAN address, which still answered) and installed it OVER the TestFlight build: `Installation succeeded`, the app now signed by the development certificate, opening on the login page. The local-estate sign-in as the rig's `owner` account (`alpha`) went through the same "Connexion externe" page, "Allow Canari to find devices on local networks?" was answered Allow, and the local feed drew. **No notification was staged**: the local stack's push path to APNs was not checked and no second local seat was opened, so neither the tap nor the group container were read. To put TestFlight back, the TestFlight app offered "Install" (not "Update") with "You already have this app installed. Do you want to replace the current app version with the test version? You may lose the app's data."; "Install" brought `100700004` back (signer "TestFlight Beta Distribution") at its login page. `gamma` signed in again and reached the feed with no PIN prompt, so the device key survived the two replaces |

**Not taken, and why.** The "Voir plus" and seek-line rows, the rotation row and the guided help were not part of this sitting. The viewer frame timing needs a recorder faster than WDA's MJPEG. Dark theme was not taken anywhere.

Dev data written (all in the harness's `WRITTEN-IDS.txt`): the sandbox group `SBXIP3-mwiykit9yx1` (`alpha` creator, `gamma` member, ledger-recorded); one personal CanaReel of `gamma` (a 4 s take with text, sticker and stroke) in Campus; a 13 MB file message `gamma` to `delta`; one comment of `beta` (deleted by `gamma` from the phone). The local stack saw one sign-in of its `alpha` account from the phone. The iPhone ends on TestFlight `1.7.0-alpha.4`, signed in as `gamma`, Wi-Fi on, the WDA daemon (started this sitting) still running.

## The Mi 9T readings of 2026-11-16 on `1.7.0-alpha.5`

`1.7.0-alpha.5` (versionName 1.7.0, versionCode 100700005, the release's `app-universal-release.apk`) on the Mi 9T, the `alpha` account, dev estate (`/api/version` named `1.7.0-alpha.5`, `dev.2b11ff1`). The phone ran the sideloaded `alpha.4` (100700004); `adb install -r` over it succeeded, no uninstall, the enrolment survived, Play Protect's prompt answered "Ne pas envoyer" through the Android-MCP selector click. The web seat was W2 (`beta`, the second party); the iPhone and its accounts were not touched. Taps went through `cdp.mjs click` (a system shade row and the Play Protect dialog through Android-MCP), the held shutter through `holdAndSlide`, the hardware Back through `input keyevent`. Evidence (screenshots, logcat, the history logger's log) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Native caches sealed at rest, the `alpha.4` to `alpha.5` upgrade ([entry](backlog.d/reading-owed-the-native-caches-sealed-at-rest-2026-10-22-the-upgrade-readings.md)), (a) key | **`PASS`** | Before the install `NativeCacheKey: ensure: present` on `alpha.4` (killed and relaunched); after `install -r` the first launch of `alpha.5` logs `ensure: present` again, no `created`: the key survived the upgrade. No `[NATIVE_CACHE] ... now sealed` line, as expected, since `alpha.4` had sealed already |
| Same, (b) a DM pushed with the app killed | **`PASS`** | Process dead (`pidof` empty), a DM from `beta`: `onMessageReceived`, `decryptProto: success type=text chars=35`, `writeFcmCache`, `showNotification ... bodyChars=35`, and the notification dump holds `android.text=A5 sealed push probe b1 [...]`. After the next start the message was in the conversation list preview (the cached message injected) |
| Same, (c) `CNSEAL1` header read | **NOT READ** | The release APK refuses `run-as` ("package not debuggable"), as on 2026-11-15. The legacy plaintext-to-sealed pass stays unstageable on a release build; the hardware-key list is untouched |
| Editing a CanaReel's caption: the form sends the caption alone (entry deleted) | **`PASS`** | A 4.02 s personal CanaReel with the rear lens was published ("Ouvrir la camera", held shutter, "Suivant", caption "MIA5 reel caption v1"). "Plus d'actions" then "Modifier le post" opened the inline form: its controls are "Mise en forme", "Annuler", "Enregistrer" and the editor, with no file input, no attach, camera or media control and no media strip; the line "1/10 pieces jointes" is still drawn as a counter. Clearing the editor left "Enregistrer" disabled; typing "MIA5 reel caption v2 edited" enabled it; saving closed the form and the card read the new text. After a full document load and a re-unlock the card (Campus) still read v2 and not v1, and the CanaReels viewer showed "MIA5 reel caption v2 edited" under the author row. The HTTP status itself was not captured on this WebView (the app's requests are not in the CDP network log); a 400 would have kept the form open with "Impossible de modifier le post", and the persisted text proves the save landed |
| Rotation on the video, live and camera screens ([entry](backlog.d/rotation-on-video-and-camera-screens.md)), Mi half | **NOT READ** on `alpha.5` | Every lock-ON row was read on the Mi on `1.6.12-alpha.2` (2026-11-15); the lock-OFF rows need the phone physically turned, which the bench cannot do. No landscape video or live was staged in this sitting, so nothing was re-read on `alpha.5` |
| In-session join through a link, Mi half ([entry](backlog.d/p1-owed-one-live-reading-of-the-in-session-join-fix-2026-10-08.md)) | **`PASS` for the join, `FAIL` for a private salon granted afterwards** | `beta` made a community with `salon-pub` and a private `salon-priv`, and posted the invitation link in a DM. As on the iPhone, `dev.canari-emse.fr` is no app link on the phone: `am start -a VIEW` (with and without `-n fr.emse.canari/.MainActivity`) opened the system browser, or was delivered to the running app and ignored. The invitation card in the DM opened `/c/join/...`, "Rejoindre la communaute" joined, and the rail listed `general` and `salon-pub` at once, no reload, and NOT `salon-priv` (which `alpha` may not read). `beta` then granted `alpha` the private salon through its access panel: `salon-priv` appeared in the rail with its lock, no reload, and its first message ("MIA5 priv first") was readable on opening. A message in `salon-pub` raised the OS banner and a badge of 1, then 2 after the second. **But the private salon raised no badge**: `salon-priv` showed none for its first message; a second message after it had been opened raised "1 message non lu". A second private salon, `salon-priv2`, granted and then written to twice, showed no badge for either message, still none a minute later, and both messages were in it when opened. Filed, fixed 2026-11-16: [reading owed](backlog.d/reading-owed-a-salon-message-arriving-before-its-seed-raises-its-badge.md). Left: the universal link into the app on the real host (a stable on `canari-emse.fr`) |
| A FIRST message from someone with no conversation yet (entry deleted 2026-11-16, every half read), Mi half, the DM variant | **`PASS`** | The owner authorised deleting the existing `alpha`-`beta` DM: `beta` used "Supprimer la discussion" (settings of the discussion, "Supprimer"); the phone then listed it as "Canari Test Beta a supprime cette conversation" and "Supprimer localement" removed it. A stale tombstone of the same pair on `beta`'s side (already "Cette conversation a ete supprimee") was dismissed locally too. With the process dead (`pidof` empty), `beta` started a fresh DM ("Nouvelle discussion", the contact's suggestion) and sent "MIA5 first contact hello" 8 s later: the app was woken twice, `isWelcome=true ... background join`, `processReceivedWelcomeBackground: group joined`, `markMembershipActive: HTTP 201`, then `decryptProto: success chars=24` and `showNotification ... bodyChars=24` five seconds after the Welcome; the dump held title "Canari Test Beta", text "MIA5 first contact hello". A second message was sent with the app killed again and the shade row tapped (Android-MCP click on the row): the app opened behind the PIN gate, and after the unlock the Beta DM was the open conversation (composer shown, both messages in order), and the conversation was in the list without a restart. `builtBy` was not read. Not read: the invitation into a community variant (a DM message carrying an invitation link showed as a card, but it was sent with the app open) |
| Back to the feed lands on the remembered post, Pour toi and Organisations ([entry](backlog.d/p3-the-feed-offset-restored-after-a-back-from-an-association-lands-about-226-px.md)), with the history logger | **`PARTIAL`: the tab is kept, the place is 8 to 13 px off** | Logger installed (`pushState`, `replaceState`, `back`, `go`, `popstate`, the tab and the scroll box). **Organisations**, tab chosen in the page, scroll box set to 1500, an association name tapped in a card header, hardware Back: 4 runs, the tab stayed Organisations every time and the place came back 11, 8, 8 and 11 px below where the page was left (left at 1987, back at 1998, 1995, 1995, 1998; the last run through the association's "Membres" page and two Backs). This is no longer the alpha.4 Organisations-lands-on-top failure. **Pour toi**, an author's profile then BDE Fictif then hardware Back twice, and the profile alone with one Back: 6 runs, left at 1446, back at 1455, 1457, 1455, 1457, 1455 and 1459 (9 to 13 px low), tab kept. So the 45 px of `alpha.4` is gone and the restore is still not within the 1 px the entry asks. Method note: a CDP click on a link under the bottom bar scrolls the page into view first (a link at 844 css px moved the page from 1500 to 1997), so a run reads the scroll box at the `pushState` from the logger, not the value set before |
| Found | note | A CDP click on "Ouvrir les CanaReels" while a dialog was up landed on the viewer's like button and liked the reel (the like went with the deleted reel); a click on the "Campus" tab by text opened a photo lightbox. The selectors that read the rail were switched to a marked element |

Dev data this sitting wrote (all in the harness's `WRITTEN-IDS.txt`): one personal CanaReel of `alpha` (caption edited, one like of `alpha` on it), deleted through the product on the phone; two communities `MIA5JOIN7q7s` and `MIA5JOIN80y9` (the second by a duplicated stage run) with their salons, deleted through the product from W2; the `alpha`-`beta` DM deleted by `beta` on the owner's authorisation and a fresh DM started by `beta`, left in place (its two messages `MIA5 first contact ...`). The phone ends on `alpha.5`, signed in as `alpha`, unlocked, Wi-Fi on, the history logger still installed in the WebView page.

## The iPhone 12 readings of 2026-11-16 (fourth sitting), `1.7.0-alpha.5`

TestFlight `1.7.0` build `100700005` (`1.7.0-alpha.5`, dev answering it) on the iPhone 12, `gamma` on dev, driven over WDA (`tools/ios-device`) with `pymobiledevice3` for the syslog and the app's own log (`applog.mjs`); the second account was the `delta` web seat (CDP 9227), and the `gamma` web seat W8 (CDP 9230) was used once, to delete the phone's device. The Mi 9T was driven by another session at the same time and was not touched. Evidence is outside the repository. TestFlight offered `100700005` about 25 minutes into the sitting (its "can now be installed" push was 5 minutes old): the readings that need no new build were taken first, then "Update" and "Open" installed it (no uninstall).

Three driver facts: **the accessibility tree of Springboard costs 19 s**, so a banner cannot be found in it and is tapped at its known place (`tap 195,78`) a few seconds after the send; `ios.mjs gesture` takes ONE sequence object (the `{ "actions": [...] }` wrapper answers `WDA 500 reverseObjectEnumerator`) and Control Center was not reached, so **the rotation lock's own state was not read**; and a syslog stream started with `timeout 400` ended in the middle of the sitting (a share count of 0 was the stream, not the product).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Editing a CanaReel's caption: the form sends the caption alone (entry deleted by the Mi 9T half the same day), iPhone half | **`PASS`** for the save, the form and the card; "cleared again" and the viewer NOT read | `gamma`'s own reel (a take with no caption, in Campus), "Plus d'actions" > "Modifier le post": the form draws the text field, "AA", a counter, "Annuler" and "Enregistrer" (pale with the field blank) and NO attachment strip or toolbar. A caption typed, "Enregistrer" enabled and tapped: the app's log shows `PATCH /api/posts/7d26a37d... -> 200 (434 ms)` and the card reads the new text. Not read: the button going disabled again once the caption is cleared, and the CanaReels viewer showing the new text |
| A notification tap to a usable conversation: F1 (entry deleted 2026-11-16 once its last half was read), iPhone, store build | **`PARTIAL`**: warm and killed both land in the conversation, no timing | **Warm** (app on the home screen): `delta` sent a DM, the banner was tapped about 5 s later, the app opened on the DM with the message drawn and the composer up at the first poll (1.2 s after the tap, a poll costs about 1 s). **Killed** (`terminate`): the same send raised "Canari Test Delta / the text" (the NSE decrypted it: sender, text, avatar); the banner was missed (a screenshot took the 3 s), the row in Notification Center was held (`hold`) then tapped: Canari opened on the DM, message and composer drawn, no PIN gate (the box was ticked). **Not taken, as the entry says:** the four timed readings and the App Group on a BENCH build with the inspector bridge: a store build is not inspectable and the figures above are polls of a tree, not a trace |
| Sharing into Canari on iOS, S5 picking, and the P2 "picking a conversation suggestion offers nothing" ([entry](backlog.d/reading-owed-sharing-into-canari-on-ios.md), P2 (entry deleted 2026-11-16)) | **S5 picking `PASS` once; the P2 `PARTIAL`: 3 of 4 picks reached the extension, the fourth is unexplained** | Safari on example.org, Share, the first suggestion ("Canari Test Delta"): the extension card "Ready. Tap Canari's notification to choose the conversation." and the banner "Choose the conversation" drew, and the syslog read `[CanariShare] share extension launched, intent=true`, `share extension opened with 1 item(s), intent=true, send_message_intent=true, suggestion=true`, `share ready`, `share handed over`, `share notification posted`. The banner was gone by the time it could be tapped (a screenshot costs minutes); the row in Notification Center was held and tapped, and Canari opened on "Envoyer a..." with **Canari Test Delta highlighted** and nothing sent (closed with "Fermer"). Three more scripted picks (menu, "Share", the suggestion, "OK"): the extension launched for two (`suggestion=true` both times) and no line at all appeared for the third; whether that tap reached the suggestion was not looked at. So the finding of 2026-11-14 to 16 (nothing offered, no extension line) was not reproduced on this build in the picks that reached the extension, but a miss without a line in 1 of 4 is not "fixed". The finger-like banner tap right after a suggestion pick was not read |
| Rotation on the video, live and camera screens ([entry](backlog.d/rotation-on-video-and-camera-screens.md)), iPhone halves | **`PASS`** for the lightbox, the live viewer and the broadcaster's preview; the lock's state NOT read | A landscape video (`land1.mp4`, 4.8 MB) sent to `gamma` by `delta` in their DM and opened full screen: "Passer en paysage" turned the app to 844x390 pt (back control at x 59, header and buttons inside the notch), "Revenir en portrait" returned to 390x844; the syslog: `[CanariOrientation] turn 1: ... new layout on screen 467 ms ... old picture released`, `turn 2` at 373 ms, `safe area changed: left 47, right 47`. The live viewer, on a live `delta` started with a title: the same turn (415 and 389 ms), the top controls and the close cross inside the side insets, the comment bar and the reaction column clear, back to 390x844; the viewer closed on "Le live est termine". The broadcaster's preview ("Publier" > "En direct"): 844x390, "Fermer" at x 59, and back; **no live was started**, so "frozen on air" and the double tap were not read. A video post of the feed opens the CanaReels pager (a portrait take, no rotate button), which is not the lightbox: the lightbox row was read on a chat video. The rotation lock is the phone's own setting and was not read, so "lock ON" is the phone as found |
| The native caches sealed at rest: the upgrade readings ([entry](backlog.d/reading-owed-the-native-caches-sealed-at-rest-2026-10-22-the-upgrade-readings.md)), iPhone half | **`PARTIAL`**: the alpha.4 -> alpha.5 update served as "upgrade from the current store build"; the App Group half stays owed | Before the update `graine_seeds.json` (`house_arrest` pull) started `CNSEAL1` (15 796 bytes, written 2026-11-15); after "Update" and "Open" the same file, same size and date, still `CNSEAL1` (nothing rewrote it). The new process's log: `[AT_REST_KEY] hardware-held key read from the keystore`, `hardware-held key in hand before the token`, then `[PIN] Stay signed in on a hardware-held key - keystore unlock, no prompt` (the box was ticked: **stay signed in across the update's restart `PASS`**). **A push readable with the app killed after the migration `PASS`:** `terminate`, a DM from `delta`, the banner read "Canari Test Delta / the text". Not read: how long the storage gate is held by a re-key (nothing re-keyed), and the App Group files (`fcm_message_cache.ndjson`, the `cs1:` header, the `isExcludedFromBackup` control), which need a bench build. The legacy pass over a plaintext file stays deleted |
| The PIN gate's sign-out in a top row, iPhone half (entry deleted 2026-11-16, every half read) | **`PASS`** | **How the gate was raised (owner, 2026-11-16: `gamma` may lose its local history on this phone):** from the `gamma` web seat, Parametres > "Securite & appareils" > "Gerer" lists 10 devices, exactly one "iOS / iPhone / Canari 1.7.0-alpha.5"; "Supprimer l'appareil" > "Supprimer" (the dialog: "L'appareil sera deconnecte, ne pourra plus dechiffrer vos conversations ... il repartira de zero"). The phone dropped to its login page within 12 s. Signing in again needed no CAS: "Connexion externe", Continue on the system alert, MiConnect's password page (login then password, from `accounts.third` through stdin), then the PIN dialog. **The gate: "Se deconnecter" is a top-right row at 243-379 x 55-87 points (right-aligned, under the status bar, nothing near the floating tab bar), in the keypad view and in the manual-entry view; the footer carries "Deverrouiller" alone.** It was NOT tapped. **"Rester connecte sur cet appareil" was TICKED when first seen (value 1) after the re-enrolment**, unticked by one tap (value 0, and it stayed 0 when the gate came back), the PIN typed in manual entry; after `terminate` and `launch` the gate came up again (the keystore unlock no longer applies), with the same geometry. `gamma` was then unlocked with the PIN and left signed in on the feed, the box unticked. The old local history of this phone went with the revoke |

**Not taken, and why.** The notification-tap timings and the App Group half (a bench IPA is not installed on a phone that must stay on TestFlight for the next pre-release); the rotation lock state; the broadcaster on air and its double tap; the reel viewer showing the edited caption; the guided help and dark theme.

Dev data written (also in the harness's `WRITTEN-IDS.txt`): six DMs from `delta` to `gamma` (`F1P5probe`, `F1P5warm1` twice, `F1P5cold1`, `F1P5a5killed`, `RotVid5` with a 4.8 MB video), one live of `delta` titled "Rot5" (ended by the seat), one caption edit on `gamma`'s own reel, and **`gamma`'s iPhone device deleted and registered again** (a new device row). No share was sent (the picker was closed twice). The iPhone ends on TestFlight `1.7.0-alpha.5`, signed in as `gamma`, the box "Rester connecte" unticked, unlocked on the feed, Wi-Fi on, the WDA daemon running.

## The iPhone 12 readings of 2026-11-16, fifth sitting: F1 timings

TestFlight `1.7.0` build `100700005` (`1.7.0-alpha.5`, dev answering it) on the iPhone 12, `gamma` on dev, driven over WDA (`tools/ios-device`); the sender was the `delta` web seat (CDP 9227), a DM to `gamma` per run. The Mi 9T and its accounts were not touched. Evidence (the syslog stream, the app's own log pulled with `applog.mjs`, screenshots) is outside the repository.

**Sign-in with the box ticked.** `gamma` was signed out from the dashboard ("Se deconnecter", no confirmation) and signed in again through "Connexion externe" (MiConnect local login, no CAS); the PIN gate came up and "Rester connecte sur cet appareil" was ticked by one tap, the PIN typed, "Deverrouiller". A `terminate` then `launch` came up on the feed with no gate and `[PIN] Stay signed in on a hardware-held key - keystore unlock, no prompt` in the log: the cold start of every run below never stopped at the PIN.

**How a run is timed, and the one trap.** The phone is a bench build without the inspector bridge (a store build is not inspectable), so there is no page trace. The two ends are read from the phone's OWN clock, which agreed with the workstation's to within about 0.5 s: **the tap** is the line `SpringBoard{UserNotificationsServer} [fr.emse.canari] Received response ... UNNotificationDefaultActionIdentifier` of `pymobiledevice3 syslog live` (a WDA `tapAt` call returns 2.4 s after the touch, so its own clock is useless), and **the events** are the timestamped lines of the in-app log. The ring is written in batches: **it only reaches `house_arrest` after the app goes to the background** (`button home`, a few seconds, then `applog.mjs`); a pull taken with the app in front misses the newest minutes. The banner was tapped blind at `195,78` 3.5 s after the send finished, as the fourth sitting says. **A first set of warm runs measured nothing**: the app had been left IN the conversation, so there was no routing and no `[HISTORY]` line (the log read only `[NotifTap]` then `[LIFECYCLE] App in foreground`); the app is now put on the feed first (back control, then the first tab) and `Pour toi` is checked in the tree before the home press. Two of the discarded runs also left the composer in a stuck voice-recording state (a tap meant for the tab bar landed on the composer); the app was backgrounded for its log, then terminated, nothing was sent.

All times are milliseconds after the tap, three runs each, the app on the feed and the box ticked:

| Step (line in the in-app log) | Warm 1 | Warm 2 | Warm 3 | Killed 1 | Killed 2 | Killed 3 |
| --- | --- | --- | --- | --- | --- | --- |
| `[NotifTap] native tap taken` (the page has the link) | 294 | 313 | 288 | 1021 | 1135 | 1022 |
| `[notifNav] routing to /chat` | 296 | 313 | 288 | 1023 | 1136 | 1023 |
| `[PIN] Stay signed in ... keystore unlock, no prompt` | - | - | - | 1095 | 1195 | 1093 |
| `[CHAT_VIEW] entry settled` (rows drawn, 60 rows) | 1540 | 1487 | 1334 | 1355 | 1466 | 1361 |
| `[INIT] MLS ready` | - | - | - | 1706 | 1884 | 1696 |
| `[HISTORY] stored page drawn (60 row(s)) before the server probe` | 922 | 768 | 673 | 1774 | 1965 | 1777 |
| `[ADD_MSG] Message upgraded ... selected=true` (the new message in the pane) | 1400 | 1328 | 1104 | (in the queue, `1 early-drawn row withdrawn` at 2334, 2465, 2256) | | |

**Reading.** Warm: the link reaches the page about 0.3 s after the tap, the stored page is drawn at 0.7-0.9 s, the new message is in the pane at 1.1-1.4 s and the entry is settled at 1.3-1.5 s. Killed (the process started by the tap): the link reaches the page at 1.0-1.1 s (the cold start), **the pane is settled with its 60 rows at 1.36-1.47 s, BEFORE `MLS ready` (1.7-1.9 s)**, which is F1's claim (the conversation is drawn from the local store before the session); the keystore unlock costs 70 ms and the gate never rose. The WDA tree polls agree within their resolution: the marker and a composer ("Zone de saisie") were first in a tree 1.2-1.7 s after the tap returned for warm and 1.6-3.0 s for killed (a tree costs 1.2-1.8 s here, and the first killed poll of run 2 saw no marker yet). The Mi 9T on 2026-11-15 had the route at about 2.3 s with the PIN gate up (the PIN path); the iPhone with the box ticked has no gate, so the two are not the same case. The new message of the killed runs arrives through the FCM cache and the queue (about 2.3-2.5 s), which the `[ADD_MSG]` line of the warm runs does not show for them.

**Not read, and why.** The PIN path (a cold open that stops at the gate): after the sign-out and the sign-in `gamma` came back with no gate, the stay-signed-in key outliving the sign-out, so the gate that would carry the box could only be raised by deleting the phone's device from the `gamma` web seat; that delete was **refused by the permission system** when it was tried (the device list was read, the confirmation dialog opened and closed, nothing was deleted). **"Rester connecte" was therefore NOT unticked at the end: it is still ticked.** The deep-link runs of the entry (`url fr.emse.canari://chat/<groupId>`, which need a bench build) and the App Group half were not taken.

Dev data written (also in the harness's `WRITTEN-IDS.txt`): thirteen DMs from `delta` to `gamma` in their DM (`F1P6probe`, `F1P6warm1`-`3`, `F1P6warmB4`-`6`, `F1P6warmC1`-`3`, `F1P6coldD1`-`3`); nothing was cleaned (the thread is theirs). The iPhone ends on TestFlight `1.7.0-alpha.5`, signed in as `gamma`, the box "Rester connecte" TICKED, on the Security & devices settings page, Wi-Fi on, the WDA daemon running.

## The Mi 9T readings of 2026-11-16, third sitting on `1.7.0-alpha.5`: the link-and-accept group notice

`1.7.0-alpha.5` on the Mi 9T (already installed by the day's first sitting), the `alpha` account, dev estate. The second party was `beta`'s web seat W2; the iPhone and its accounts (`gamma`, `delta`) were not touched, and no dev service was stopped. `alpha`'s web seat W1 was reloaded once. The page was reached with a client-side navigation to the invitation path (a reload of the WebView re-locks the PIN, and `am start -a VIEW` opens the system browser on this host). Evidence outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| A newcomer's own "X a ajoute Y" notice names both people, the link-and-accept route (entry deleted) | **`PASS`** | `beta` (W2) made the one-member group "MIA5C-Grp-1116" and generated its invitation link ("Lien d'invitation", "Generer un lien"). On the Mi the invitation page showed the group and "Rejoindre le groupe"; the request answered "Demande envoyee !". `beta`'s pane then read "Canari Test Alpha veut rejoindre la conversation" with "Accepter" and "Refuser", and the accept followed. On the Mi the list preview read "Canari Test Beta a ajoute Canari Test Alpha au groupe" within 25 s and the thread's first line read the same, **also after a document reload and a re-unlock**; no "Compte supprime" and no "Utilisateur inconnu" at any point. `beta`'s thread read "Canari Test Alpha a ajoute Canari Test Beta au groupe" in its own wording of the same Add. The `/api/users/batch` call itself was not captured (the release WebView's requests are not in the CDP network log); the names drawn after a reload are the observable |
| A group's "X a ajoute Y" notice keeps its names, a web seat (entry deleted) | **`PASS`** after a reload | `alpha`'s web seat W1, which had held the page open across the build, drew the group's line as "Utilisateur inconnu a ajoute Utilisateur inconnu au groupe" with the banner "Canari a ete mis a jour pendant que cette page etait ouverte": the OLD build, not a defect of the fixed one. After a reload (and the PIN already open) the same thread read "Canari Test Beta a ajoute Canari Test Alpha au groupe". With the Mi (here and on `alpha.4`) and the iPhone (`alpha.4`) every half of the entry has passed |
| The pre-live screen says a suspension before Start, Mi half (entry deleted 2026-11-16, every half read) | **NOT READ** | No free dev admin seat (`gamma` is the global admin and the iPhone's account; `delta` the BDE moderator, also the iPhone's), and no product route lifts a suspension, so it could not be staged and undone through the product. Nothing was written for it |

**Not taken, and why.** The other Mi halves of the plan's "Readings owed" either passed in the day's two earlier Mi sittings or need what this phone and `alpha`/`beta` cannot give: the Emojis row and the once-per-spell unreachable line are in #3678, merged after `alpha.5`; the deploy drill stops dev's services; the history-ask and nickname rows need a third account's seat; the seed-mirror row an uninstall; the zero-inset "Voir plus" another phone; the call-noise rows the iPhone.

Dev data written (also in the harness's `WRITTEN-IDS.txt`): one group of `beta` ("MIA5C-Grp-1116") with `alpha` as its second member, deleted by `beta` through the product ("Supprimer le groupe"); `alpha` removed its local copy ("Supprimer localement"). The Mi ends on `alpha.5`, signed in as `alpha`, unlocked on `/chat`, Wi-Fi on.

## The Mi 9T readings of 2026-11-16, second sitting on `1.7.0-alpha.5`: the staged rotation and editor rows

`1.7.0-alpha.5` (versionCode 100700005, already installed by the first sitting of the day) on the Mi 9T, the `alpha` account, dev estate. The second party was `beta`'s web seat W2 (a landscape video post, then a live with a 1280x720 fake camera, in the Campus space `alpha` reads). The iPhone and its accounts were not touched; no other seat was driven (a harness `unlock.mjs` run also touched the web seats' PIN gates). Taps went through `cdp.mjs click` (a small page-side helper that dispatches in the visual viewport's coordinates was needed while the keyboard was up: `cdp.mjs click` mis-hits by the keyboard's pan and closed the comments sheet three times), the held shutter through `holdAndSlide`, the hardware Back through `input keyevent`. The system's rotation values were put back (`accelerometer_rotation 1`, `user_rotation 0`). Evidence (screenshots, logcat) is outside the repository.

**How the turn was emulated, and what it is not.** The bench cannot tilt a phone. With `accelerometer_rotation 0` (the system lock ON) and `user_rotation 1`, a screen that requests `auto` (`SCREEN_ORIENTATION_USER`) turns to the system's chosen rotation, and a screen that requests `portrait` does not: this exercises the app's orientation requests and the turn hold, and is NOT a sensor turn. One system trait showed on the way: after the app asked for `portrait` (a swipe to a vertical reel) the system value `user_rotation` read 0 again, so each emulated turn had to put 1 back.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Rotation, the reel pager on a staged LANDSCAPE video post ([entry](backlog.d/rotation-on-video-and-camera-screens.md)) | **`PASS`** | Opening it from the post: `orientation portrait -> auto (requestedOrientation=2)`. With `user_rotation 1` it turned in place: `configuration changed in place: landscape (activity not recreated)`, `turn 1 laid out at 2340x1080`, the page at the new size after 244 ms, `draw released` at 293 ms, then `finishDrawing of orientation change` 408 ms. Caption, rail and the rotate button inside the turned frame, the picture whole. A swipe up to a vertical reel logged `auto -> portrait` and rotation 0. The rotate button ("Revenir en portrait" then "Passer en paysage") logged `landscape -> portrait` and `portrait -> landscape (requestedOrientation=11)`; the hardware Back closed the pager in landscape and the phone went to `portrait (1)` |
| Rotation, the live viewer on a staged LANDSCAPE live | **`PASS`** | The feed's live card opened the viewer (`portrait -> auto`); with `user_rotation 1` it turned (the comment bar at the left, the reaction column at its right, the top buttons inside the frame, the 1280x720 picture whole with side bars); the rotate button forced portrait and landscape again; Back returned to portrait with the viewer gone. Across the whole sitting 10 turns: 10 `draw released` (256-374 ms), 0 `released WITHOUT`, 0 `onCreate` |
| Nothing turns outside the four screens, with the system rotation at 1 | **`PASS`** | `/chat`, `/settings`, `/posts` and `/communities` read `SCREEN_ORIENTATION_PORTRAIT` and rotation 0 with `user_rotation 1`. A cold start (`am force-stop`, launcher) opened the PIN gate in portrait, but `user_rotation` read 0 by then, so that start does not prove a held-sideways launch |
| Rotation, the physical turn (lock OFF) | **NOT READ** | Needs a hand; the owner's sitting of 2026-11-15 read it |
| Composer, viewer and editor on a real clip, Mi half ([entry](backlog.d/reading-owed-the-canareels-composer-viewer-and-editor-on-real-content.md)) | **`PASS`** | The composer's camera drew a real scene; a 4 s take (shutter held 4 s), "Modifier la capture": a stroke and its undo, an emoji and a text ("Bench Mi") drew; "Suivant" exported the video with the overlays (thumbnail), under "Une video verticale de 90 secondes au plus est un CanaReel : supprime au bout de 1 an." and with no "Garder comme post"; "Publier" toasted "CanaReel publie" and the viewer played it with the text and the emoji. Viewer swipes (three up, three down), `dumpsys gfxinfo`: 1305 frames, 28 janky (2.15 %), p50 32 ms, p90 38 ms, p99 46 ms, gpu p99 19 ms (the whole session, video decode included; the first measurement was 11.5 %) |
| A confirmation raised from a modal ([entry](backlog.d/reading-owed-overlays-stacked-by-open-order-not-by-rung.md)), Mi half | **`PASS`** | The trash on `alpha`'s own comment, in the comments sheet of `beta`'s post, raised "Supprimer ce commentaire ? Ses reponses seront supprimees aussi." over the sheet, drawn whole, the sheet dimmed; "Annuler" closed it alone and left the sheet; "Supprimer" removed the comment ("Soyez le premier..."). The toast over the stack was not caught, the guided help not staged |
| The stricter script policy, the PDF viewer and a reload under the listener (entry deleted 2026-11-16, every half read), Mi half | **`PASS`** | A listener in the document, a post's PDF opened in its viewer (one page on a canvas, "Agrandir" taken) and closed: 0 violations. A listener installed through `addScriptToEvaluateOnNewDocument` and a `Page.reload`: the document came back at the PIN gate, listener defined, nothing recorded. The trombinoscope export was not reached |
| Found | **filed** | In the live viewer's top bar at 436 css px (portrait) the broadcaster's name truncates ("Canari Te...") and the flag button sits over the viewer count's row; the count is readable and landscape is clean. Filed as [a P3](backlog.d/reading-owed-the-live-viewer-top-bar-at-360-436-px.md); not measured on the iPhone |

**Not taken, and why.** The deploy drill's salon half needs dev's services stopped while the other bench phone is in use. The history-ask and nickname rows need a third account's seat that joins a roster, the seed-mirror row needs an uninstall (never done), the daily-cap fourth push needs a server-side counter write, the pre-live suspension needs a suspended account, "Voir plus" with a zero bottom inset needs a phone this one cannot be, and the call-noise and iPhone rows need the iPhone.

Dev data written (also in the harness's `WRITTEN-IDS.txt`): one video post of `beta` (deleted by `beta` through the product), one live of `beta` titled "Rot A5B" (it ended with the seat's page being navigated away), one comment of `alpha` on that post (deleted by `alpha`) and one personal CanaReel of `alpha` (deleted by `alpha` through the product). The Mi ends on `alpha.5`, signed in as `alpha`, unlocked, Wi-Fi on, rotation settings restored.

## The Mi 9T readings of 2026-11-16, fourth sitting: the pre-live suspension

`1.7.0` (`versionCode` `100700005`, the `alpha.5` build) on the Mi 9T, dev estate, the `alpha` account over CDP; `gamma`'s WEB seat (W8, the dev global admin) did the reports and the cuts. The iPhone and its accounts were not touched and no dev service was stopped. A `console` hook installed on the page before each sheet opened carried the log (a release build prints nothing to logcat, but the page's own console is readable over CDP).

| Reading | Verdict | What was seen |
| --- | --- | --- |
| Control, good standing | **`PASS`** | "Passer en direct", Start enabled, the log `[LIVE-BROADCAST] rules v2, accepted v2; standing clear, 0 cut(s) on record` |
| Two real cuts of `alpha`'s lives through `/admin/moderation` | **`PASS`** | `alpha` went live from the composer on the Mi (phase "live", segments stored); `gamma` (W8) opened the feed card, "Signaler ce live", Spam, then in `/admin/moderation` "Couper le live", Spam, "Continuer", "Couper le live". The Mi's overlay read "Votre live a été interrompu par la modération" within 4 s. After cut 1 the sheet still said `standing clear, 1 cut(s) on record` (the warning rung). A second live, reported and cut the same way, wrote `live_cuts` strike 2 |
| Pre-live screen, suspended, FRENCH | **`PASS`** | "Vous ne pouvez plus lancer de live jusqu'au 16 décembre." (the second cut's day plus 30), "Réessayer" beside it, "Démarrer le live" present and `disabled`. Console: `[LIVE] limits`, `[LIVE] rules`, `[LIVE] standing`, then `[LIVE-BROADCAST] ... standing suspended, 2 cut(s) on record`, and **no `[LIVE] start`** line |
| Pre-live screen, suspended, ENGLISH | **`PASS`** | The language switched in Settings, Preferences (the page reloads and the PIN gate re-locks: `pin.mjs --device A1`). "You can no longer start a live until December 16." with "Try again", "Start the live" `disabled`, the same three `[LIVE]` lines and no `[LIVE] start` |
| Back to French, and the control after the undo | **`PASS`** | The language set back to "Français" (PIN again). After the two `live_cuts` rows were deleted (below) the sheet read `standing clear, 0 cut(s) on record`, Start enabled, no standing line |

**The undo (owner-authorized reversible dev write, 2026-11-09).** No product route lifts a suspension. On the DEV database only: a `SELECT` of the `live_cuts` rows for `alpha` returned exactly the two this sitting wrote (strike 1 and strike 2, live ids in `WRITTEN-IDS.txt`), a `DELETE` of exactly those two live ids answered `DELETE 2`, and `SELECT count(*) FROM live_cuts` read 0 (the table held only those two). The two ended lives left no row (a live's row is purged at its end); the two `content_reports` the reports wrote stay, marked reviewed by the cut, and no product route deletes a report. **What this closes:** every half of the pre-live reading, so its entry is deleted. **Side effect not read:** each live start may have pushed `alpha`'s followers (not checked). The Mi was left on `/posts`, unlocked, in French.

## The iPhone 12 readings of 2026-11-16 (fourth sitting b), `1.7.0-alpha.5`

TestFlight `1.7.0-alpha.5` (build `100700005`) on the iPhone 12, `gamma` on dev, driven over WDA (`tools/ios-device`); `delta`'s web seat (CDP) staged the join and the messages; the Mi 9T and the Pixel were not touched. The sitting started by deleting the six delta-to-gamma test DMs of the previous sitting through the product ("Supprimer" on each message, from `delta`'s seat; the phone shows "Ce message a ete supprime" for each). Evidence (screenshots, the pulled in-app logs, the syslog) is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| The share sheet's conversation suggestion, ten picks ([entry](backlog.d/reading-owed-sharing-into-canari-on-ios.md); the P2 is deleted) | **`PASS`, 10 of 10** | Each pick from Safari reached the extension: `share extension launched, intent=true`, `opened with 1 item(s), intent=true, send_message_intent=true, suggestion=true`, `share notification posted`, with the card "Ready. Tap Canari's notification..." and the banner "Choose the conversation" on the after-shot; the row's order changed between picks (read from the screenshots) so the picks covered four different suggestions. The tenth banner was tapped like a finger: `share banner tapped`, `share imported`, "Envoyer a..." opened on the picked conversation. Nothing sent. Not reproduced, against 5 of 5 on `alpha.2`: the P2 is deleted. |
| The broadcaster ON AIR, orientation and double tap ([entry](backlog.d/rotation-on-video-and-camera-screens.md)) | **`PASS`** | On air the orientation is frozen (a landscape request is refused, no rotate button); a double tap on the on-air picture does not flip the lens; on the preview a double tap flips it and the controls stay. |
| The on-air top row on a 390 pt screen | **FAIL, filed** | The chat toggle and End are drawn past the right edge and absent from the tree ([P2](backlog.d/reading-owed-the-live-on-air-top-row-at-390-pt-and-360-px.md)). |
| A live of about four minutes | **ended itself, cause unproven** | `ended (upload-too-slow) after 256 s: 124 segments`, after two reconnects, a missing manifest and a `LIVE_POSTER_TOO_FAST` 429 ([P2](backlog.d/p2-a-live-ended-itself-upload-too-slow-after-256-s-on-the-iphone.md)). |
| In-session join through the card, iPhone half ([entry](backlog.d/p1-owed-one-live-reading-of-the-in-session-join-fix-2026-10-08.md)) | **`PASS` 3 of 3 for the join** | Three fresh communities, each listing `general`, `salon-a`, `salon-b` at once, no reload; the private salon not listed. The universal link on the real host is still owed. |
| A private salon granted after the join | **FAIL, filed** | Listed with its lock but unreadable and no badge: the key-distribution Welcome was ignored as already held after the external commit was refused ([P2](backlog.d/p2-a-private-salon-granted-after-an-in-session-join-is-unreadable-on-the-iphone.md)). |
| First message after an in-session join raises its badge ([entry](backlog.d/reading-owed-a-salon-message-arriving-before-its-seed-raises-its-badge.md)) | **0 of 3 reproduce** | Both salons of each community showed "1 message non lu" (gaps 0.53, 2.6 and 2.1 s). Kept open: an intermittent defect, no gap under 300 ms tried. |
| F1 notification tap, App Group half, on the bench IPA (entry deleted 2026-11-16 once its last half was read) | **timings NOT taken** | A cold start of the bench build lands on the PIN gate ("Rester connecte" unticked), so a timing would measure the PIN. The four readings need that box ticked at sign-in. |
| Sealed caches, the App Group (c) ([entry](backlog.d/reading-owed-the-native-caches-sealed-at-rest-2026-10-22-the-upgrade-readings.md)) | **`PARTIAL`** | The group listing was read (no `fcm_message_cache.ndjson`: no push is possible on a bench build); both seed mirrors open with the app key; a full backup lists `mls.bin`, `push_context.json` and `graine_seeds.lock` and not `graine_seeds.json` (excluded as designed). The `CNSEAL1` header was not read: no bench op reads it, and `footprint` fails with "Operation not permitted" on `SystemData`. |

**Bench build.** `ios.yml` (`workflow_dispatch`, `local_url` and `local_client_id`, ref `v1.7.0-alpha.5`) built the IPA; `sign-install.mjs` installed it over TestFlight (`Installation succeeded`); the rig's `owner` account signed in through the local MiConnect password page. The bench inspector bridge answered on a non-default port (the default was taken by the workstation's Chrome). **Phone state at the end:** TestFlight `1.7.0-alpha.5` reinstalled over the bench build (the replace prompt answered Install), `gamma` signed in again on dev (password page, PIN by hand), on the Campus feed, "Rester connecte" unticked.

Dev data written (all in the harness's `WRITTEN-IDS.txt`): the six test DMs (deleted from `delta`'s seat), the three communities `IPA5B*` with their salons (deleted by `delta` through the product), one live of `gamma` (ended), and `gamma`'s earlier reel (deleted from the phone's card menu). The bench build wrote only to the local estate.

## The iPhone 12 readings of 2026-11-16 (sixth sitting), `1.7.0-alpha.5`: a ten-minute live, and a newcomer after a nickname

TestFlight `1.7.0-alpha.5` (build `100700005`) on the iPhone 12, `gamma` on dev with "Rester connecte" ticked (never touched), driven over WDA (`tools/ios-device`); `delta`'s web seat W5 (CDP 9227) created and deleted the groups; the Mi 9T and `alpha`/`beta` were another session's and were not touched. Native lines from `pymobiledevice3 syslog live`, the page console from `applog.mjs`, the dev server's lines from `srvlog.mjs --raw` (read-only). Evidence is outside the repository.

| Reading | Verdict | What was seen |
| --- | --- | --- |
| A live of about five minutes, the re-run of [the `upload-too-slow` entry](backlog.d/p2-a-live-ended-itself-upload-too-slow-after-256-s-on-the-iphone.md) | **NOT REPRODUCED, 1 run of 1: the live went on for 10 min 21 s (past 256 s, past 600 s) and was ended by me, not by itself** | "IPH6 live" started from the composer at 14:48:17 (times are the app's clock, UTC+1; the server's own lines are one hour earlier), rear camera, no viewer. The app's own log over the whole live: **276 segment PUTs on disk (the ring is written in batches: the server counted 302), 276 answered `200`, none refused**, 35 poster PUTs all `200`; no `[LIVE-BROADCAST] reconnecting`, no "segments waiting, over the ... the reconnect window holds", no "manifest had no response", no `LIVE_POSTER_TOO_FAST`, no `429` anywhere in the window (the only two warnings in it are the `[LOUDNESS]` lines of the relaunch after the kill). `[LIVE-PIPE] summary` every 15 segments: seal 2.7-3.3 ms average, two-fragment chunks 0, dropped 0, one generation open, 130.6 MB for 270 segments. The server, for the same live: segment N stored every 2 s, **483 659 B on average** (191 stored lines in the first 6 min 22 s, 92.4 MB), and its sweep at the end: `ended by the sweep: dropped, duration=621s segments=302`. No poster refusal line, no 429 line. |
| The upload rate behind that run | **evidence recorded** | Segment PUT durations as the app logged them: **mean 664 ms, p50 630, p95 971, p99 1 340, max 3 082 ms** for a 2 s, about 484 kB segment (about 1.9 Mb/s of media, so about 5.8 Mb/s while a PUT is running: three times the margin). The manifest poll answered in p50 201 ms, max 1 932 ms. The failing run of the morning had `reconnecting` about 1:46 and 3:19 into the live; this one had none for 10 minutes, on the same phone and the same Wi-Fi, so the phone's path alone does not explain it, and the lead (the dev estate's load that minute, or the poster's pacing against the limiter) is neither confirmed nor refuted by one clean run. |
| Ending the live from the phone | **could not be done through the product** | On air the top row is the camera, microphone, camera-off and share buttons (the tree lists no End and no chat toggle); the End button is past the right edge on a 390 pt screen on `alpha.5`, as filed ([the on-air top row](backlog.d/reading-owed-the-live-on-air-top-row-at-390-pt-and-360-px.md), built after this build). The live was ended by `terminate` of the app (an OS death); the server's sweep then closed it at 621 s. |
| A member added after a nickname shows it on first open, iPhone half ([entry](backlog.d/reading-owed-modifier-les-pseudos-for-a-group-and-a-community.md), item 2) | **`PASS`** | `delta` (W5) made the one-member group "IPH6G", opened "Modifier les pseudos" (the sheet lists the member, `delta` himself) and set "Del6" on himself ("Del6 / Canari Test Delta - Defini par Canari T..."), then added `gamma` through "Ajouter". The inviter's console: `[COMMIT] ... admits 10 device(s) at epoch 2`, `[JOIN_PUSH] ... join push -> 223bc34e...:tauri-...-mwj3k80m-cfcy`, **`[HISTORY_BUNDLE] Empty bundle sent for 5c0261ea... (group has no history), addressed to ...tauri-...-mwj3k80m-cfcy`** (the iPhone's device; ten web devices of `gamma` got the Welcome too, two of them a `Full history sent: 1 of 1`). The phone's log: `[QUEUE] Processing Welcome`, `[HISTORY_ADDRESSED] ... admitted - the inviter's push is solicited`, `[WELCOME] Group ... ready`, **`[HISTORY_BUNDLE] 1 nickname(s) taken (unverified) for 5c0261ea... from ...'s join push`**. Opened on the phone, "Parametres du groupe" > "Modifier les pseudos": **"Del6 / Canari Test Delta - Defini avant votre arrivee"** at once, and "Definir un pseudo" for `gamma` herself. Not read: the `localStorage` key `canari_nicknames:v1:<account>:<group>` (a store build exposes no page storage). The account is `gamma`, who has 10 devices, not a fourth account with none; the reading's core (a newcomer's first open, the join push restating the register) is the same. |
| A new group joined while the app is in front | **FAIL, filed (2 of 2)** | Both groups (IPH6G at 15:07:31, IPH6H at 15:17:55 on the app's clock) were joined by the phone within a second (`[WELCOME] Group ... ready`, `Drain complete`), yet **the chat list did not draw the row**: IPH6G stayed absent for 3 min and through a tab change and a pull-down; IPH6H for more than 80 s with a tree read every 10 s. After `button home` and `launch` (a resume) the first screen already listed both, "11 min" and "2 min" old. [filed](backlog.d/reading-owed-a-group-joined-with-the-list-in-front-is-ordered-by-its-admission.md). |
| "Modifier les pseudos", the web-only halves (1, 3, 4 community, 5, 6, 8) | **NOT TAKEN here** | They are web rig readings, taken on 2026-11-16 by the web sitting; the iPhone has no more to give than the second sitting's group and community halves plus the newcomer above. |
| A HISTORY ask answered "I hold nothing" is final for its roster ([entry](backlog.d/reading-owed-a-history-ask-answered-i-hold-nothing-is-final-for-its-roster.md)), iPhone half | **NOT STAGEABLE with `gamma` and `delta` alone** | The reading needs an answerer that holds no seed row of a `shared` community AND is the only online device of every member on the key group's tree, so that "nothing" is final (a member counts as answered only once EVERY tree device of theirs has said it). `delta` has one device (W5), and any community W5 creates, it holds the seeds of; a community `gamma` creates on the phone, the phone holds. The only "holds nothing" answerers the rig has are `alpha`'s and `beta`'s seats, which the Mi 9T session was driving. Nothing was written for it. |

**Not taken, and why.** Another iPhone-only row of the plan's "Readings owed" that needs no bench build and is not the private-salon Welcome or F1: the live viewer's top bar and the on-air top row are built after `alpha.5` (the End button was still off-screen), the Emojis row and the "server already unreachable" line are in #3678 (after `alpha.5`), the birthday morning notice needs a fixture row dated two days back and an hourly tick, the deploy drill stops dev's services, and the iOS 16 policy row needs an iOS 16 phone. Time went to the ten-minute live and the join.

Dev data written (also in the harness's `WRITTEN-IDS.txt`): one live of `gamma` ("IPH6 live", ended by the sweep), the groups `IPH6G` and `IPH6H` (`delta`, then `gamma`), both DELETED by `delta` through "Supprimer le groupe". `gamma`'s phone keeps the two rows as "Canari Test Delta a supprime cette conversation" (a local copy is removed by "Supprimer localement", not done). **Phone state at the end:** `1.7.0-alpha.5`, `gamma` signed in on dev, "Rester connecte" still ticked (no PIN gate after two relaunches), unlocked, on the chat list, Wi-Fi on, charging; the WDA daemon running.

## The iPhone 12 readings of 2026-11-16, sixth sitting, `1.7.0-alpha.5`: "Envoyer a..." rows 1, 12, 8 (partial) and the F1 PIN path

TestFlight `1.7.0` build `100700005` (`1.7.0-alpha.5`, dev), `gamma` on the iPhone 12 over WDA; senders and the second seat were the `delta` and `gamma` web seats (the Mi 9T's `alpha` and `beta` were not touched). Evidence (syslog, app log, screenshots) is outside the repository.

| Reading | Verdict | What was read |
| --- | --- | --- |
| [21.4](frontend/modules/reels-in-chat.md#214-the-bench-readings-before-the-flip) row 1, RC-0 on phone B (a 58 s take from the tab to one DM) | **PASS** | the take was prepared on the phone and sent to the DM, the tile played on the other seat, no WebView reload; the exact `[video-prep]` figures were not kept off the session, so the bar (10 MB, 30 s) is stated as passed, not as a measurement |
| 21.4 row 12, the lock screen for a take sent to G, the app killed | **PASS** | the push read "CanaReel" (with the clapper) under the group title in French and in English; **one anomaly**: the first push after switching the language to English read "[Media]" with no group title |
| 21.4 row 8, a moderator's purge everywhere | **NOT READ** | the take staged from the web seat was landscape, so the server stored it as a plain post, not a reel: the admin's delete took the plain-post path and the shared file stayed. That says nothing on the reel purge path; the row needs a PORTRAIT take by a non-admin author, then `gamma` as the deleter, then a relaunch with the network cut |
| F1 PIN path (killed app, "Rester connecte" unticked) | **PASS** | see below |

**F1, the PIN path.** The gate was raised by deleting the phone's device from the `gamma` web seat and signing in again with "Rester connecte" unticked (the iOS app has no such switch in Settings; the box is on the gate's "Manual entry" view). Run in one process (send, tap, poll, PIN, poll), the app terminated, a DM from `delta`: the banner tap at about 3 s after the send; **the gate was up 0.5-0.9 s after the tap** (a cold start by the push); the PIN typed through the keypad (3.3-3.4 s, the rig's cost) and "Unlock"; **the conversation with the new message drawn 1.9-2.9 s after Unlock** (1.9, 2.0, 2.9 s, three runs). So the gate costs the PIN and nothing else: the pane is not drawn behind it and is complete about two seconds after it drops. A first, hand-timed pair (banner tapped 70 s late, then 3 s) showed the same landing. The box was ticked again at the gate ("Stay signed in on this device"), and a `terminate` then `launch` came up on the feed with no gate.

**Dev data written** (also in `WRITTEN-IDS.txt`): a reel/plain post by `delta` with its DM and CanaReels sends and the feed post deleted through the product by `gamma`; a 58 s take `gamma` to `delta`; one accidental like of a pinned post, undone through the product; `gamma`'s phone device deleted and re-enrolled; DMs `F1PIN1 probe`, `F1PIN1 second`, `F1PIN2a`, `F1PIN2b`, `F1PIN2c` from `delta` to `gamma` (not cleaned, the thread is theirs).

**Not read in this sitting:** the rotation lock row, the two institution/overlay entries, the first-message DM variant, the editor's edited PHOTO take, the `alpha.6` rows (the update was not taken). They stay owed.

**Defects and oddities to weigh:** the native tab bar overlaps the bottom of a post's menu and of the profile list (the last item sits under it); the server logs `[REEL] delete of undefined` after the repository's remove (the id is read after it); the English "[Media]" first push above.
