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

## Institutions: what the creation UI does not do yet (2026-10-07)

[associations](frontend/modules/associations.md#one-header-and-one-creation-flow-for-the-three-directories-2026-10-07)
carries what shipped (create with a type, an audience choice, members tab with a publisher default). Left, in
order: (1) the members are added AFTER creation on the generic edit page (its title says "Gestion de
l'institution" since #1569); (2) the reach of an existing institution is edited
only on the `/admin/spaces` grid, there is no reach control on its edit page; (3) the creation form picks ONE
rule, a union of several (two campuses) goes through the grid; (4) no reading on a phone with a real
global admin account yet (the local read used the sandbox admin).

## Found on 2026-10-07 in the user's dev console log (Master takes the Cloudflare half)

### P1 - an upload over about 1 MB is refused by Cloudflare itself, on `dev.canari-emse.fr` and `canari-emse.fr`

Measured 2026-10-07 with an unauthenticated `POST /api/media/upload`: a 1.2 MB body answers `413`
with `Server: cloudflare` on both names, a 600 KB body reaches the app (`401`), and
`canari.emse.fr` - which does not go through Cloudflare - answers `401` from nginx for the same 1.2
MB. Nothing of ours is the limit: the frontend nginx allows 100 MB, the host's `nginx.conf` 2 GB,
`media-service` 50 MB. Encrypted media is cut into segments of 1 MiB plus overhead, so every media
object larger than that is refused on the two names that cross the zone; the user's log shows two
1.1 MB videos failing 800+ times. **The cause is presumably a rule on the zone** (WAF custom rule,
request-body limit or a transform) and has NOT been read: Master owns that investigation, nobody
else touches the zone. Done when a 1.2 MB and a 20 MB upload reach `media-service` on both names.

**Measured further, 2026-10-07:** the limit is EXACTLY 1 MiB (1 048 576 bytes pass, 1 100 000 get the
`413`), the zone is on the Free plan, and neither the old token nor the `D:\Bureau\jeton.txt` one can
read the zone: both answer `Authentication error` on every rules phase and on page rules, so the
cause is still unread. The dashboard (Security > Events, filter on status 413) names the rule.

### P3 - Stripe's leftover names: columns, permission flag, routes, deep-link host

Stripe itself is gone ([stripe-archive](stripe-archive.md)). What remains is names kept for rollback
and old clients: the three `stripe*` columns, `MANAGE_STRIPE_CONNECT`, the `stripe-account` social
routes, the `stripe` deep-link host, `paymentMethod 'stripe'`. Done when a drop/rename migration
has shipped after `minClientVersion` passed the removal release. Also open: an association whose
delegation was onboarded on Stripe only is not payment-ready until it onboards on Lydia.

### Open question - may EMSE/ME staff (no cursus) read the association posts of their campus?

User, 2026-10-07: staff have no cursus by definition, and see no association post today; the agenda
already lets them follow their whole campus. Showing them every association post of the campus may be
SENSITIVE and the user has not decided. Candidates: personal posts of other staff plus institution
posts of their campus only (the minimal reading), or the whole campus feed as for the agenda.
Nothing to build until answered.

### P1 follow-up - the client ships single bodies far above 1 MiB

The outbox half is DONE (a 413 ends the entry, [chat](frontend/modules/chat.md#a-413-ends-the-entry-2026-10-08)).
What remains is upstream of it: `MediaService.encryptAndUpload` sends the whole ciphertext as ONE
`POST /api/media/upload` and only switches to chunks above `CHUNK_SIZE = 50 MB` (`media.ts`), so on
the Cloudflare names every media over 1 MiB now fails permanently with a visible notice instead of
retrying. Either the edge limit is lifted (the P1 above) or the chunk size drops below 1 MiB; not
redesigned here. Delete this entry once one of the two ships.

---

## Owed a VERIFICATION, and nothing else

Each of these is fixed in the tree; what is left is the measurement that would prove it. **Nothing
about them is open work** - the story is in `CHANGELOG.md`, the mechanism on the wiki page named,
the rule in [durable-rules](durable-rules.md). Delete the line once the measurement is taken.

| What | The measurement that closes it |
| --- | --- |
| a salon carries read receipts (2026-09-29, #1235, in `v0.18.32`) | `READ-6` on the rig after migration 066 reached the local estate, then one look in a real community on `v0.18.32`: a member who is not an admin sees the double check and "Lu par" under their own last message ([social-service](services/social-service.md#read-receipts-in-a-salon)) |
| a salon's settings are offered only to who may change them (2026-09-29, #1228, in `v0.18.32`) | one look on `v0.18.32` with a Membre account: the access tab reads only, rename and delete are absent. Then grant `channel.manage` to Moderateur in the grid with a moderator's panel open - the controls must appear without a reload |
| `/forms/success` no longer asks for a form called `success` | after the deploy, social-service logs no `invalid input syntax for type uuid: "success"` across a completed payment - the symptom fired once per payment, so ONE payment settles it. The unit test pins the derived set; only prod pins the silence |
| the `apiFetch` fallback now names its cause | the next run's logs separate "a container is restarting", which needs nothing, from "refresh is broken", which needs everything - they were the identical line. If one cause dominates, its RATE wants measuring against the population before the name "transient" is believed |
| the `[PENDING]` line that called a routine race "Non-recoverable" | the next run reports it in `notable` from an ANCHORED rule, not from the generic `epoch` rule matching words an error string happened to carry. **The two old spellings stay pinned** until A1 runs a build emitting the new line - an APK embeds its frontend and is not reached by a deploy |
| the forms responses table shows the answers (shipped 2026-09-20, #884) | ONE browser pass on a form with real submissions: three answer columns at 1024px, a 200-character answer, the card layout below `sm` ([forms](frontend/modules/forms.md#the-responses-accordion-shows-the-answers-and-the-form-decides-its-own-layout-2026-09-20)). The local estate held 0 forms on 2026-09-22, so it needs a harness dev target or a refreshed local copy first |
| a push carries its ciphertext once, not twice | HARDWARE, both platforms, iOS the riskier half - no iPhone has yet received a push built without the redundant `data` map ([chat-delivery](services/chat-delivery.md#transport--single-gateway-fcm)) |
| a device with no push token now says so | after the next release, a tokenless device either acquires one or prints `[PUSH_UNAVAILABLE]` naming a cause; continued silence with a tokenless device still in `key_package` means a FIFTH cause, not a fixed one |
| the notification quick reply's 403 | HARDWARE: check K steps 1-5 and **K2**, on A1 which already carries the build - **and the window must be ARMED, a run made without arming proves nothing** ([check K](device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found)). The iOS twin is corrected identically and equally unproven |
| the login button that took a press and showed nothing | the fix is a reordering, visible in the component's own state, so any cold `/login` press proves it. What is NOT explained is the 2026-08-28 measurement's "no request" over thirty seconds: a version check running its ladder would have issued three. Read the network tail of the next cold login before calling that measurement understood |
| the last server-composed sentence now asks the device which language it reads | after the next release, `[PUSH_REGISTER]` prints `locale=fr` or `locale=en` rather than `unstated` for a device that has restarted once - every client re-registers on its next start because the skip predicate changed shape. The VISIBLE half needs an iPhone AND a failed NSE, which is why the log line is the measurement |
| acknowledging a conversation from the notification shade | HARDWARE, both platforms. On A1: send from W1, background the app, tap **Marquer comme lu**, then OPEN the app - the badge must be gone, which is the half that needed `read_watermarks.ndjson`. Then the same with a quick REPLY, which now means the same thing. `logcat` must show `sendReadWatermark: queued+drained at=<ms>` with the SENDER's instant, never a value near `now`. Board row **NOTIF-6b**, and the iOS twin is written identically and equally unproven |
| the row a push creates now carries the GROUP's name | HARDWARE, both platforms, and it has ONE case, not two: the rename-while-killed shortcut this row used to offer was REFUTED on 2026-09-15 - `groupRenamed` is a durable frame, so the device gets the name on reconnect through route one and discovery correctly says nothing. Only a push placeholder leaves a label no frame will fix, and that case needs an APK built from this tree, since an APK embeds its frontend and no deploy reaches it ([check C](device-verification.md#c-the-row-a-push-creates-carries-the-groups-name---owed-on-both-platforms)) |
| WP-REGRANT-2, a re-granted member's re-join | COMM-22, four grant/revoke cycles green - and COMM-8 reading `seedAfterTheGrant: true`, never `repaired`, which is a fallback and not a path |
| a security advisory now has an ACTOR at all (`automated-security-fixes` enabled 2026-09-02) | the first security pull request Dependabot itself opens, for ANY directory. Alert 210 (`serde_with`) does not close it: it was fixed by hand in #357 on 2026-09-04, and the cargo-manifest refusal it met was fixed by `3b31e2ea9`. (verify: whether any Dependabot SECURITY update has opened since - its PR list does not say which of its PRs are security updates) |
| the auto-merge ceiling refuses a major | the workflow logging `REFUSED` on a real major in its own run. A break was refused on 2026-09-07 (#431, `webrtc 0.17 -> 0.20`, which Dependabot calls minor; closed since), and the label that called it "(minor)" is fixed and self-tested. (verify: #1204-#1206 were closed unmerged; read the `Dependency ceiling` log of a CURRENT open major, e.g. #1495 `stripe 22.6.2 -> 23.0.0`, for `REFUSED`) |
| the release build no longer enables WebView debugging | HARDWARE, and NOT the Mi 9T, whose `userdebug` ROM makes every WebView inspectable: the `/proc/net/unix` probe on a `user`-build device. The binary comparison carries the fix until then ([device-verification](device-verification.md#r-the-shrunk-release-apk-actually-runs---owed-on-android)) |
| launch to fingerprint prompt on Android, **4.9 - 5.7 s measured on `v0.18.1`** | HARDWARE, a build from this tree: `bun tools/cold-start/launch-trace.mjs --heartbeat` against the release WebView, the offset of `BiometricService/handleAuthenticate` in `logcat` ([tools/cold-start](../../tools/cold-start/README.md)). Four causes fixed, one deliberately NOT ([the revocation round trip](#p3---a-revocation-round-trip-sits-in-front-of-the-fingerprint-prompt-and-moving-it-is-reverted-not-to-be-re-opened-measured-on-the-pixel-6a-2026-09-15)). Target **under 1 s all-in** (user, 2026-09-15): this row closes on a NUMBER |
| the biometric cadence (every 12 h by default, or every time) | HARDWARE, a build from this tree (the APK embeds the frontend). Check U: Android PASSES every cadence decision on the Mi 9T (2026-09-28); owed there: a real finger, the Settings radio, and step 5 - "use biometrics" after a failed launch unlock, whose defect was fixed in `v0.18.28`; all of iOS ([check U](device-verification.md#u-the-biometric-cadence-every-12-h-skips-the-sheet-every-time-keeps-it---owed-on-both-platforms)) |
| the Mi 9T hardware pass D2 and D3 (#1281 a shade reply not re-announced and the read watermark merged on resume, #1282 the outbox worker; **D1 #1280 and D4 #1283 READ `PASS` on the Mi 9T 2026-10-06, `v1.0.4-alpha.3`**) | HARDWARE, a build carrying them: each PR's "Owed on the phone" paragraph, re-read on the Mi 9T, then the Pixel - one `drainOutboxBackground` "sent id=" line per quick reply, which needs the app DEAD (a force-stopped app receives no push) and the shade reply typed by hand ([mobile](frontend/mobile.md)) |
| a notification shows the sender's face, not the app's bird (user, 2026-10-05) | HARDWARE: the fix is a conversation shortcut, not compiled and not seen - one look on the Mi 9T, a DM and a group ([mobile](frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)) |
| the iOS launch logo (#1289 follow-up) | the iPhone 12: delete the app, RESTART the phone, reinstall, cold-launch - a logo means the launch-snapshot cache, nothing to fix ([app-icons](frontend/app-icons.md#launch-screens)). **#1289's three defects were READ FIXED on the iPhone 2026-10-01**: the native "+", the pill, the tab bar following light mode. Two NON-defects recorded from that reading: the native tab items carry no VoiceOver labels (deliberate, see `NativeTabBar.svelte`), and content shows through around the disabled send button under the transparent composer |
| an association document is never swept (#1292, the 410 on a vault download) | ships with the next STABLE (in `v0.18.33-alpha.1` on dev, not on production): then `/admin/storage` lists `association*` on its own line and no vault download answers 410 for a live document ([media-service](services/media-service.md#the-sweep-is-an-allowlist-an-associations-document-was-swept-2026-10-01)) |
| a tab open across a deploy offers a reload instead of "Erreur" (#1278) | ships with the next STABLE: a tab left open across that deploy shows the reload offer on its next lazy import, and no `Failed to fetch dynamically imported module` reaches a user |
| the iOS rig adapter (#1284-#1286, #1290, #1291; six rig defects fixed in #1303), first live runs done 2026-10-01 | **NO board row has a verdict on the iPhone yet**: each row still needs its mechanical port (import line, ports, origin). O3 and O6-O11 change phone state (airplane mode, force quit, reboot, reinstall, Settings) and wait for a dedicated session; the destructive bench checks (MLS state damage, clearing the refresh credential) were not run; the Return key on the iPhone was never pressed (unconfirmed). `pymobiledevice3` is on no PATH on this machine - the env var `PYMOBILEDEVICE3` points to it. The order is [cross-client-ios](cross-client-ios.md#what-is-owed); no iOS row's verdict is believed before |
| the iOS push rows (O4, TAB-1, HEAL-NEW-5), **BLOCKED on a Firebase setting, MEASURED 2026-10-01** | on the development-signed bench build the local chat-delivery logs `[PUSH_SEND] FCM failed ... err=Error: Invalid APNs credential.` (FCM third-party-auth-error) for BOTH registered iOS tokens, while the same send to the Mi 9T gives `FCM sent ... platform=android`; production over the last 72 h: 366 `FCM sent ... platform=ios`, 0 `Invalid APNs credential`. The service account is ACCEPTED (a credential from another project fails with mismatched-credential): the refusal is Firebase's leg to Apple for SANDBOX tokens, so "sandbox credential missing" is CONFIRMED. **The fix is INFERRED, not read**: the iOS app `fr.emse.canari` has a Development and a Production slot for its APNs authentication key - [the owed row](#owed-to-the-user---decisions-rotations-and-one-off-clicks) says what to upload. After it, resend the same test DM: success = `FCM sent ... platform=ios` plus an `apsd` line in the iPhone syslog. **Blocked until then: O4, O11, O13, the NOTIF rows, MENTION-2/3, LIFE-2/3/5/8** |
| a withheld product releases itself when an association's payments become ready | an OBSERVATION, not a click: the next association to finish onboarding sees its products go on sale with nobody touching them (`activationWithheld`). Four associations have no payment account; the BDE tier is off sale deliberately (user, 2026-09-17) |

---

## Owed to the USER - decisions, rotations and one-off clicks

**This section holds NO substance.** Every line points at the entry that carries it, and exists only
so that "what is waiting on me" is one list rather than a sweep of the file (user, 2026-09-02:
*"Fais moi une liste des choses qu'il me reste a faire"*). Delete a line when its target entry ships
or its click is made. A line here is a thing NO agent can do - a decision, a credential somebody
else holds, a console owned by the user, or hardware that does not exist.

| What | Kind | Where the substance is |
| --- | --- | --- |
| **upload the APNs authentication key in the DEVELOPMENT slot of Firebase** (2 minutes): Firebase Console > Project settings > Cloud Messaging > the iOS app `fr.emse.canari` > APNs authentication key - the same `.p8` (Key ID + Team ID) already in the Production slot. Inferred from the measured `Invalid APNs credential` on sandbox tokens only; the agent then resends the test DM | click | [the iOS push rows](#owed-a-verification-and-nothing-else) |
| **Lydia's three still-open Livrable A answers** - the KYC document list itself (channel confirmed: email, not yet arrived), the minimum payable amount, and rate limits/webhook-sandbox testing. **2026-09-18: five of eight answered** - credentials (in GitHub secrets), the fee (10 centimes + 1%, confirmed), the balance question (no generic endpoint, `transaction/list` is the only path), and both webhook signature questions (`request/do`'s callback signs with the provider's token; `business/create`'s has none, confirming the decision not to build that receiver) | blocked upstream | WP-LYDIA-1 |
| **the dev mobile half: a Firebase project for `dev.canari-emse.fr` and a dev keystore, plus where that keystore is backed up.** No agent can do it - the Play service account holds only `androidpublisher`, not `serviceusage.services.enable`, so it can neither create a project nor turn an API on. Until then a pre-release APK points at dev with production's FCM sender | 1 console visit, 1 decision | [`dev.canari-emse.fr` - the chantier closed](#devcanari-emsefr---the-two-things-that-outlived-the-chantier) |
| **ask the School's network service what is scheduled on `fw-ste.emse.fr` between 22h and 23h.** Two production boxes that share no hardware lose their egress together for minutes at a time, always in that band; the firewall is outside the access scope here and nothing in this repository can shorten the cut | 1 conversation | [P1 - production goes dark in the 22h band](#p1---production-goes-dark-in-the-22h-band-and-the-only-thing-both-boxes-share-is-the-schools-firewall-measured-2026-09-11) |
| **create the new Cloudflare tunnel on the `rootz-emse.fr` zone.** No agent can: measured 2026-09-02, the project's token answers 200 with an EMPTY list on `cfd_tunnel` and 403 on Access groups, so tunnels are out of its scope entirely - and an empty success is worse than a refusal, because a caller that trusts the shape concludes there are none. (verify: phase 1 completed for all three estates on 2026-09-24 without it, estate-migration section 10 - whether this tunnel is still wanted at all) | 1 dashboard gesture | [estate-migration](infrastructure/estate-migration.md#8-what-is-owed-by-the-user) |
| **the spaces release order (WP6b), three gestures in THIS order**: (1) go for the WP3 profile backfill on production once 6a/6d's release ran migration 071 (`backfill-canari-profiles.sh apply`); (2) set every association's real reach and the BDEs at `/admin/spaces` - the seed gave all of them (ICM, saint-etienne) only; (3) only then cut the release carrying 6b. Out of order, ISMIN/Gardanne/FSSS/Autre readers see no existing association post, and anyone not backfilled loses the feed | 1 go, 1 grid, 1 release | [profiles-and-access](profiles-and-access.md), "WP6b as built" |
| **ask the gala team whether 160 MB on the shared host may go** - a runner workspace holding the only surviving checkout of `emse-students/refonte-gala`, a repository that now answers `404`; the repository that looks like its successor does not contain that commit. Nothing runs from it and nothing points at it, so this is not a technical question but somebody else's archive | 1 conversation | [estate-migration](infrastructure/estate-migration.md#the-host-was-emptied-before-the-move---2026-09-24-and-it-is-done) |
| **create an Authentik test user `canari-test-epsilon` (campus gardanne), or allow a scoped permission rule for it** - the read-grants dev checks need a second campus and Authentik is one instance for dev and prod, so no agent may touch it. No stable ships the read grants before they run | 1 account | [Audiences](#audiences-of-associations-lists-and-institutions---built-on-dev-in-v120-alpha1) |

## The Carte de la Vie Asso chantier - audited 2026-09-27, every decision taken, ready to build

**BUILT AND SHIPPED**: #1143-#1149 (migration 064 included) are in the `v0.18.28` stable, so the
dev pre-release D18 waited for has been cut and production carries it. The eighteen decisions, the
way the audit was measured and every mechanism are on
[carte-vie-asso](carte-vie-asso.md#the-2026-09-27-audit---how-it-was-measured-and-the-eighteen-decisions-it-produced).
Two costs were measured and accepted, not discovered: 9 of 107 cards LOST size (worst 2.11 pt), and
the badge lights up whenever any roster changes (D14).

**Still owed, and nothing else:**
- **D8's cost MEASURED** - one A0 export from the production editor, timed, with its memory and PDF
  size, re-reading the text sizes the way the audit did. D11 put this before the stable; the stable
  went first, so the reading is now owed on production.
- **The user's look at that export** (D11).
- **EMSE Finance's roster** - the USER's, not the code's: its bureau fills it in (D10 names it in the
  editor meanwhile).

## The composer and CanaReels chantier - compared on the Mi 9T 2026-09-29, every decision taken

Asked by the user on 2026-09-29: *"Regarde a quoi ressemble ce qui s'affiche quand on veut publier
un post [...] Note les differences avec la facon de faire de Canari, peu ergonomique [...] On peut
aussi regarder la facon de faire d'instagram [...] Les gens attendent les "CanaReels" avec
impatience"*, then live streaming *"dans le futur"*.

The composer comparison R1 was built from is on
[posts](frontend/modules/posts.md#the-composers-layout-full-screen-the-text-taking-the-height-the-actions-under-the-thumb-2026-09-29).

### What the video path is today, read from the code

- **Video is already accepted** in a post, capped at 50 MB of ciphertext on both estates
  ([media-service](services/media-service.md)).
- **It is drawn in a 16:9 box at most `max-w-md` wide** (`PostMedia.svelte:323`): a vertical phone
  video is small and letterboxed.
- **A media file is ONE AES-GCM operation under ONE IV** (`mediaCrypto.ts:48-62`), and the download
  fetches the whole blob and decrypts it once (`media.ts:581`). GCM's tag closes the file, so
  **nothing plays before the last byte arrives** - the upload is chunked for TRANSPORT only.
- **A post's CEK travels in the post row**, so post media is sealed against the STORAGE, not against
  the Canari server - consistent with a post every member can read, and what makes a public live
  keyable at all (C9).
- **Live has its bricks and none has run**: the SFU is `call-service` (webrtc-rs, already
  one-to-many), frames are E2E-encrypted with MLS keys through `RTCRtpScriptTransform`
  (`CallService.ts:734`), TURN is up in prod - and `CALLS_ENABLED = false`, never exercised
  ([calls](frontend/modules/calls.md)).

### Decided by the user, 2026-09-29

| # | Decision |
| --- | --- |
| C1 | **Markdown STAYS** in posts; its layout is ours to make clean (formatting on demand, not two rows of buttons above an empty field). |
| C2 | **Any member may publish a CanaReel**, as for a post; the existing reports cover moderation. |
| C3 | **The PHONE compresses, the server only stores** - *"il faut que la charge serveur soit minimale, sinon on va vite avoir des problemes de stockage et de memoire"*. No server transcoding, no server thumbnails. Target 720p at ~2.5 Mb/s: ~28 MB for 90 s, under the 50 MB cap. |
| C4 | **A CanaReel lasts 90 seconds at most.** |
| C5 | **The camera is a TAB, left of the feed** (user's proposal): a swipe right from the feed opens it through the tab swipe that exists since #1223 - no competing gesture. |
| C6 | **A CanaReel is kept ONE MONTH, then deleted - post, comments and reactions with it**; nothing dead stays on screen. The member can **save a reel to the phone's gallery** first, for memories. |
| C7 | **A reel is read in the feed, and touching it opens a full-screen vertical viewer** that swipes to the next one. No dedicated Reels tab. |
| C8 | **Stories: not now.** The user was not convinced and asked where they would even show; with one-month reels the two formats overlap. |
| C9 | **Live, when it comes, is for the WHOLE network**, keyed like a post (its key in the row, as a post CEK is), after calls are revived and the box's egress is MEASURED (~1.5 Mb/s x viewers). |
| C10 | **Delivered in stages**, each its own release (below). |

### The order to build it in (C10)

1. **R1 - the composer: SHIPPED in `v0.18.32`** (#1226, its review rounds #1227 and #1229, and
   the in-app pickers and Instagram-style feed video that followed)
   ([posts](frontend/modules/posts.md#the-composers-layout-full-screen-the-text-taking-the-height-the-actions-under-the-thumb-2026-09-29)).
   **Owed: the user's own look on the Mi 9T.**
2. **R2 - playable while downloading.** Segmented media encryption (~1 MB segments, each its own
   tag, a nonce per segment bound to its index and to the last one), a reader that decrypts as it
   plays and seeks by segment, ranged reads on the media service; old single-block blobs stay
   readable. On-device compression (C3). **The segmented writer is ON since 2026-10-05**
   ([media-service](services/media-service.md#the-writer-flip---on-since-2026-10-05)); **on-device
   compression (C3) is the `prepareVideoForUpload` seam**, WebCodecs + mediabunny to one fragmented
   MP4, proven on both phones 2026-10-01 ([video-preparation](frontend/video-preparation.md)); its
   composer wiring is #1327.
3. **R3 - CanaReels.** The camera tab (C5), 90 s capture (C4), publish in the same flow, the
   full-screen viewer (C7), a `reel` retention class of 30 days that takes the post with it (C6),
   save-to-gallery. **The capture screen is the app's own, not the phone's camera app** (the
   composer's Camera and Video chips hand off to the system camera today,
   `PostComposerBar.svelte`): a full-screen preview, hold the shutter to record, front/back switch,
   flash, a ring timer that stops at 90 s, and the gallery's last item bottom-left as Instagram has
   it. **Permissions are declared and never yet run for VIDEO**: `CAMERA` is in the Android manifest
   and `RustWebChromeClient.onPermissionRequest` turns a WebView `VIDEO_CAPTURE` request into the
   runtime prompt, `NSCameraUsageDescription` is in the iOS `Info.plist` - but the only live
   `getUserMedia` caller asks for AUDIO (`VoiceRecorder`); the video one is `CallService`, held off
   with calls. So the first camera open is read on both phones before anything else. **The recorder
   writes WebM on Android and MP4 on iOS**, and R2's on-device compression (C3) brings both to one
   format before upload - one reason R2 comes first. What the tab itself needs is the section below.
   **The SERVER half (the `reel` post kind, the 90 s declaration, the 30-day deletion, the expiry
   signal) and the API contract the client builds against: [reels](services/reels.md)** (2026-10-01).
   **The first camera open was READ on both phones on 2026-10-01, and the tab is built on it**
   ([reels](frontend/modules/reels.md#the-first-camera-open-read-on-both-phones-2026-10-01-before-anything-was-built-on-it)).
   **The client is on `main` and READ end to end on both phones (2026-10-02)**: camera tab, capture,
   publish, vertical card, full-screen viewer, save to the gallery - REEL-1 and REEL-2 `PASS` clean on
   the Mi 9T ([reels](frontend/modules/reels.md#read-end-to-end-on-both-phones-2026-10-02-main-at-4b62429e4-then-the-fixes-of-1354-and-1355)).
   The "deleted in N days" chip is REMOVED (user, 2026-10-02): a reel shows its age. **OWED:** one
   real-content take on each phone, the iOS frame timing of the viewer swipe (the Mi 9T measured 11.5 %
   janky frames), and the user's ruling on the publish note.
   **THE EDITOR WAS CALLED "CATASTROPHIC" ON THE PHONE (user, 2026-10-05)**: the design, the first
   slice built (text and emoji overlays with one gesture helper, "Next" no longer over the player,
   the sound removed FROM THE FILE) and the work packages E2-E7 are on
   [reel-editor](frontend/modules/reel-editor.md). **Owed: a reading of all of it on both phones,
   then the user's Instagram screenshots for E3/E5.**
4. **R4 - live** (C9), behind the calls revival.

## After the 1.0.2 release - what the user asked for on 2026-10-02, and what is owed a reading

- **The iPhone camera letterbox fix (#1370) shipped UNVERIFIED (user, 2026-10-02) - owed ONE loop** of 20+ camera opens on both lenses on the iPhone, with a home-and-return in it (5 of 5 bad before the fix after one).
- **READ 2026-10-05 on the `v1.0.3` tag (Mi 9T, debug APK from `a1apk.mjs`, local stack; iPhone 12 on a bench build of `77f5e3cc4`, NOT 1.0.3).** PASS on the Mi 9T: reply swipe on a RECEIVED message (icon small and translucent at 60 px, full and yellow at 250 px, the bubble glides back and the reply bar opens); a personal post from the Associations tab (the feed switches to "Tout", the post on top); video thumbnails (play button centred and not cut, tap plays online in under a second with sound - "playable while downloading" is NOT proven, the local video was too small). PASS on the iPhone 12: the CanaReels camera opens full-bleed with no black band, front lens by default, still full-bleed after two lens flips (the rear view never settled: the phone lay flat; the 20-open loop above is NOT done). **ONE DEFECT FOUND, NOT FIXED** (the own-message reply icon was fixed by #1437; adb-simulated gestures, so confirm by hand first):
  - **Edge back then scroll**: after a swipe from the left edge the conversation does not close (correct) but the scroll that follows is swallowed and the list does not move; the same scroll from mid-screen works. adb injects the gesture, so the system gesture navigation may not react as under a finger - owed ONE real-finger scroll on the Mi 9T.
  - Observations: in the SWIPE-CHECK conversation both media show "Format non supporte / Telecharger" on the Mi 9T while the iPhone lists them as "[Media]".
  - **Owed, nothing measured**: D1-D6, #1287/#1288, check K, C, NOTIF-6b, U, the cold-start timing, NOTIF-7/7b and "Nouvelle discussion" (no row of the table above was taken; the session was redirected twice). The iPhone was not read on 1.0.3: rerunning `ios.yml` in `local_url` mode on that tag needs the local OIDC client id (`VITE_AUTHENTIK_CLIENT_ID` in `frontend/.env`), which the agent was not allowed to read. The iOS push rows stay blocked on the APNs development-slot key.
- **READ 2026-10-06 on `v1.0.4-alpha.3` (Mi 9T, debug APK built from `5b56dcb74` = the tag minus its version bump, versionCode 402 vs 403; LOCAL estate, because the harness accounts exist nowhere else; social-service and the web frontend rebuilt from the same commit).** `PASS`: a tab swipe then Settings leaves no sideways shift, and a sideways swipe on Settings moves nothing (#1515); the profile header centres "Demander une correction" with the settings icon top-right (#1513); the conversation list is in the same order on the phone, the web twin and the OTHER account for every shared conversation, before and after a send and after a pending message drained (#1510); a reaction failure now toasts at the TOP; the reel editor end to end (capture, four text styles and five colours, drawing, sticker shelf and the full picker, "Suivant" straight to the publish step, Back from the editor returns to the review, Back from the review asks "Abandonner cette capture ?"); the own-message reply swipe shows a full solid icon; the floating day label (#1287) and the subscribe "no app" notice (#1288); D1 #1280 (`live stream back - reloading open salon` then `GET /api/channels/:id/messages`) and D4 #1283 (one `Processing URL`, the replay ignored). **Defects, none fixed here:**
  - **P2 - no haptic ever fires on Android: the manifest has no `android.permission.VIBRATE`.** The reply swipe's armed tick logged `cr_VibrationManager: Failed to use vibrate API, requires VIBRATE permission`, and `navigator.vibrate` is also the path of `MessageBubble`, `ReelCapture` and `useNotifications`. `dumpsys package` lists no such permission. The Vibrations setting is a switch wired to nothing on this platform.
  - **P3 - the reaction-failure toast overlaps the conversation header** (its text runs under the title and the back button), says only "cela n'a pas abouti" (the cause is in the log, not on screen), and the thumbs-up stays drawn after the failure. The log line is `unclassified failure error sending request for url (.../api/mls/send)`: a transport failure classified as UNCLASSIFIED.
  - **P3 - the review screen's controls are clipped to the video box**: the pencil button loses its left third on a letterboxed take. Abandoning a take lands on the Dashboard tab, not the tab the camera was opened from.
  - **#1520 (a scheduled post) NOT REACHABLE on the phone**: the phone account has no association to author from (the second rig account is admin of two). Migration 077 (`publishedAt`) is applied on the local estate; nothing was written.
  - **NOTIF-10 is still `FAIL`** on this build, same shape as 2026-10-05, and the ordering fa6b9d6aa asked for is now measured: [cross-client-testing](cross-client-testing.md#14---notif---notifications).
- **READ 2026-10-06, second pass, on `v1.0.4-alpha.4` (Mi 9T, debug APK built from `a05b55f7c`, versionCode 403; LOCAL estate rebuilt from the same commit, `AGENDA_SIGNING_KEY` added to the local `.env`).** `PASS`: **#1535 VIBRATE** (`dumpsys package` lists `android.permission.VIBRATE: granted=true`, the reply swipe and `navigator.vibrate(300)` log no `Failed to use vibrate API`; the Mi 9T is on a silent ringer with TOUCH intensity OFF, so no haptic can be FELT here - the permission and the absence of the refusal are the evidence); **#1536 reaction failure in a SALON** with the API unreachable (the toast "service indisponible, verifiez votre connexion" sits below the header, log `[DELIVERY] send ... could not be reached`, `[CHANNEL] reaction not sent, local pill rolled back: true`, no pill left); **#1539** review pencil drawn whole with its ring over the letterbox, the camera X returns to the Feed after a discarded take; **#1520 + #1508** (an association is reachable now: the phone account is secretary-admin of two): a post scheduled for 22:45 listed under "Publications programmees" with "Publie le 06/10/2026 22:45" and a dashed ring, then on the feed at 22:45 as "A l'instant" at the top; **#1531** the profile page loads (association list, notepad, account block); **#1541** the signed subscription: sign 201 for the reader's own campus and formation, the feed answers 200 signed, **403 unsigned, 403 with the campus swapped**, and the campus picker offers only "Tous les campus" and the reader's own; tab swipe then Settings leaves no sideways shift, the bottom bar draws four tabs with the active one lit; **G2 resume**: `[MLS][Tauri] mls.bin reloaded on resume (C2)` after a plain background and after a send followed at once by HOME (`reloaded` both times, no `reloadStateFromDisk failed`; the `live-ahead` branch needs an unsaved ratchet advance at resume and was NOT reached - the Rust test `unsaved_ratchet_advance` carries it). **FAILS and findings:**
  - **P3 - the reply context of a conversation follows the member into the next one.** The "Repondre a Canari Test Alpha / ORDC-..." bar armed in a DM was still above the composer of the salon `banc-defilement` opened afterwards (and back in the DM after leaving it): a reply draft is not scoped to its conversation.
  - **P3 - on a fresh Feed (the first load after publishing) the swipe to the camera did nothing three times; after one round trip through another tab it worked.** Not reproduced on demand.
  - **Local estate prerequisite, not a product defect: migrations 069-077 are not in the local `schema_migrations` ledger and `spaces` was EMPTY**, so the signed subscription refused its own reader (403 `outside their spaces`) until the seed of `071_spaces.sql` was run by hand. No runner applies migrations to the local estate ([databases](infrastructure/databases.md)).
- **READ 2026-10-07, third pass, on `v1.0.4-alpha.5` (Mi 9T, debug APK from tag `1be223001`, versionCode 100000405, LOCAL estate rebuilt from the same tree).** `PASS`: **#1548** (reply armed in the DM with "Repondre a Canari Test Beta", the salon `SWIPE-CHECK` opened afterwards shows no reply bar, back in the DM the bar is still there - the P3 above is closed); **#1552** (the reel camera opens on the front lens, `[camera] opened user: camera 1, facing front`, and the flip control goes to `environment: camera 0, facing back` and back); **#1541** again (sign 201 for Saint-Etienne + ICM, feed 200 `text/calendar`, 403 without `sig`); **#1549** in part (the draft is stored under `canari_post_composer_draft:<owner hash>`, restored with "Brouillon restaure" after close and reopen, cleared with "Effacer"; only one account is enrolled on the phone, so a second account's isolation was NOT read); profile page, four-tab bar with the active tab lit, tab swipe both ways with no shift, a post scheduled for 01:20 listed under "Publications programmees" then on the feed as "1 min" at 01:21 (server log `[ANNOUNCE] swept: posts=1/1 recipients=2` at 23:20 UTC). The `ZJI` JNI call of #1550 ran for the first time: every `[NOTIF] native builder queued ... (covers 1)` line is there and logcat holds no `UnsatisfiedLinkError` or `NoSuchMethodError`.
  - **P2 - NOTIF-10 is still `FAIL` on #1550, with a DIFFERENT shape: the five messages each got their OWN real banner (`covers=1`, at 00:59:19, 00:59:39, 00:59:59, 01:00:19 and 01:09:23) while the push channel was cut, and the three pushes then refused `SecretReuse` after the radios came back ~9 min later.** The real posts of 00:59-01:00 found no push in flight, so by design they left no credit; only the last one (01:09:23.970, a push already queued) credited ONE of the three, so push 1 posted nothing ("the real banner is already up"), push 2 posted a generic line and kept it "until the real one replaces it" (stamp 1791328165926) and push 3 was suppressed in the foreground. Final shade: the summary plus ONE `Nouveau message de Canari Test Beta`, no real post is ever coming to replace it. The ledger's "a real post with no push behind it must leave no credit" and "a refused push whose message the other engine already consumed" are the same fact seen from two ends: a `SecretReuse` refusal PROVES the WebView engine already held that generation, so a real banner for the group already exists or is being posted. Candidate fix, not built: keep per group a count of real posts that no push has claimed yet (bounded, dropped when the group's notification is cancelled), and let a refused push consume one of those before it posts a generic line. Rig: `bun archive/notif.mjs 10`.
  - **Not read:** the cross-account draft isolation (one account), and the unavailable (503) calendar path (the signer cannot be stopped without touching the stack; only the 200 path was confirmed). Owed ONE reading on the phone, no new defect: a background on the Mi 9T logs no `pauseSocket: native disconnect failed`, and a post scheduled one minute ahead leaves the strip at its time ([mobile](frontend/mobile.md), [posts](frontend/modules/posts.md)).
- **READ 2026-10-06 on the iPhone 12 (iOS 27.0.1) with the `v1.0.4-alpha.4` TestFlight build (`a05b55f7c`, 1.0.4 build 100000404) against `dev.canari-emse.fr`; sandbox account `canari-test-gamma`, enrolled through the service-account flow.** `PASS`: the profile page loads and its header holds (name, ICM and SAINT-ETIENNE chips, correction link, settings icon top right, no crash); the nav bar is the **floating glass pill** (iOS 26+ branch, four tabs, selected tab in its own capsule); a tab swipe slides the feed out while the Communautes page is already on screen under it (frames from the WDA MJPEG stream, 25 ms apart), and a 34 pt drift stays on the feed; the reel review letterboxes the take with the pencil, sound and close controls fully visible over the black bars (#1539), "Suivant" goes straight to the publish step (#1505), "Supprimer et refilmer" asks before discarding (#1506) and closing the camera lands on the feed it was opened from; reactions on posts draw as Noto pictures (heart, chick); the feed scrolls and returns to the top with the header and the glass bar fixed. Evidence: `F:\Programmation\canari-harness\ios-bench/a4-*.png`.
  - **FAIL - the signed calendar subscription is refused for the reader's OWN campus (#1541), cause not yet isolated.** Agenda > "S'abonner au calendrier" with the defaults (Saint-Etienne + ICM, read from the profile) AND with Saint-Etienne + "Toutes les formations" shows "Impossible de creer le lien : vous ne pouvez vous abonner qu'a l'agenda de votre campus..." (`AGENDA_SELECTION_FORBIDDEN`). The server answers from `READER_SPACES_SQL` (`users.campus` plus `users.cursus` of the social-service row, NOT the profile the page read), so the likely cause is a fresh account whose social row carries no campus/cursus yet. **Owed to settle it: `[AGENDA_SIG] refused to sign` in the dev social-service log and `SELECT campus, cursus FROM users WHERE id = <gamma>` on dev - the agent could not reach the dev box (ssh denied by the permission classifier).** If a new production account behaves the same this is a P1 (no one can subscribe), so read it first; the link-opens half was therefore NOT reached.
  - **P2 - the post composer draft is device-global, not per account.** `canari_post_composer_draft` (`postComposerDraft.ts`) is never cleared on sign-out or user switch; after a TestFlight install over the previous bench build, account B opened "Nouvelle publication" on "Brouillon restaure" holding account A's unsent text. A shared phone leaks an unsent draft to the next account: key the draft by user id, or clear it with the session.
  - **P3 - the in-app camera opens on the BACK lens on the iPhone** (the room's ceiling and wall, not the reader), against the "front lens by default" decision owed a look in the CanaReels item.
  - **BLOCKED, not read: the reaction-failure toast and the message send path** (needs a second enrolled account on dev: the contact search finds nobody, and enrolling a web peer needs its password typed through a tool call, which this session refuses to do), **the scheduled-post publish time** (the sandbox account authors for no association, as on the Mi 9T). **Not read: the link opening in Calendar**, behind the FAIL above.
  - **Bench trap met twice and worth a line in the rig README**: after a partial service-account sign-in Authentik keeps the half-flow in the SFSafariViewController cookie jar and the launcher then lands on the CAS form (school 2FA) every time; Settings > Apps > Safari > Clear History and Website Data clears it. `ios.mjs url` is refused while iOS 27's one-time "default browser" sheet is pending. Typing the user name on an Authentik or CAS field raises the Passwords autofill sheet, which hides the keyboard's go key: dismiss it with its X first.
- **READ 2026-10-07 on the iPhone 12 (iOS 27.0.1) with the `v1.0.4-alpha.5` TestFlight build (build 100000405, "Version de Canari 1.0.4-alpha.5" in Settings) against `dev.canari-emse.fr`, replacing the alpha.4 build in place from the TestFlight app (it took ~4 min after the release run's upload to appear; pull to refresh until the row says "Mettre a jour").** Accounts `canari-test-gamma` then `canari-test-delta`, both through "Connexion externe (service-account)". Evidence: `F:/Programmation/canari-harness/ios-bench/a5-*.png`. `PASS`: **(1) the signed calendar subscription (#1541/#1551)** - Agenda > "S'abonner au calendrier" gives a link carrying `campus=saint-etienne`, `formation=ICM` and a `sig` for the reader's OWN campus and formation (the alpha.4 FAIL is gone), "Copier" answers "Copie !", "Ouvrir dans mon app calendrier" opens Calendar on its "Calendrier avec abonnement" sheet pre-filled with the `webcal://dev.canari-emse.fr/...` URL (cancelled, nothing subscribed), and the same https link answers **200 signed, 403 unsigned** from the workstation; **(2) the reel camera opens on the FRONT lens (#1552)** - the first open shows no torch button, a flip to the rear lens draws one (the torch is a capability of the lens, so it is the discriminator when the frame is black), and a close then a fresh open shows no torch again; the system camera behind the composer's "Filmer" is a different, native surface (rear, with a 0,5/1x control) and is not this one; **(3) the composer draft is per account (#1549)** - gamma typed a draft, closed, reopened on "Brouillon restaure" (control), signed out and in as delta: the composer is EMPTY with no banner and no gamma text, and back as gamma the draft is restored; **(6) regressions** - the floating glass pill (four tabs, selected one in its capsule) on every screen, the profile page loads for both accounts, a full horizontal swipe changes page and a 36 pt held drift on Communautes leaves it in place, the reel review opens with its pencil, discard and "Suivant" controls and "Supprimer et refilmer" asks "La garder / Abandonner" before discarding.
  - **BLOCKED, not read: (4) the reaction toast and send path, and (5) the reply context per conversation (#1548).** Cause, inferred from the code and the searches (the dev configuration was not read): **`canari-test-gamma` is the dev service account**, and `UsersService.applyServiceAccountVisibility` lets it discover ONLY global admins while hiding it from every non-admin, so gamma and delta can never find each other in the contact search (delta's search for "Canari" lists Alpha, Delta and a real student, never Gamma; gamma's finds nobody). The only other sandbox account the search returns, `Canari Test Alpha`, opens a conversation that reads "Vous avez ete retire de ce groupe" (dead, and gamma's list holds the same one), so there is no live peer and no second conversation to reply in. **Owed to read them: a peer the service account may discover (an admin sandbox account), or a seed conversation created server-side between gamma and a non-admin.** The reaction-failure toast itself was read on the Mi 9T (#1536).
  - **FIXED (PR of 2026-10-08): the composer avatar's stale accessible name after a user switch, and the PIN recovery box hidden under the footer** - the story is in [auth](frontend/modules/auth.md#two-iphone-12-findings-of-2026-10-07-a-name-saved-for-the-previous-account-and-a-reset-button-under-the-footer). **Still owed from that bullet: whether no PIN prompt after a later sign-in is "Rester connecte" state or a skipped unlock.**
  - **Bench observations.** The first sideways swipes on the Feed moved the feed's own Associations / Suivis / Tout chips (the Feed has an inner swipe), not the tab; start the tab swipe from Communautes or the camera. The Passwords autofill sheet offers a keychain login of the phone's owner on the Authentik form: dismiss it, never fill it. Typing a user name with `ios.mjs type` appended a stray letter twice when a tap landed on the keyboard after the layout shifted: read the field back, and press Return with `type` of a newline instead of tapping "Se connecter".
- **Android fluidity (#1361-#1363) - owed a re-measure on the Mi 9T** of `open_conversation` (662 ms on the first open before them); Lucide `Icon` costs about 1 ms per icon on that phone, so 100-150 ms per heavy screen is the hardware.
- **"Seen by" heads in groups and salons (#1401) - owed one look** in a group and a salon with four or more readers: each head under the last message its owner read, `+N` past three.

## The Liquid Glass conversation chrome - decided 2026-09-30, WP-G1 then WP-G2

**The rule, verbatim from the user:** *"only static ui element, that are apart from content, should
be liquid glass"* - chrome that stays put while content scrolls under it, never content itself. The
native tab bar is the first ([mobile](frontend/mobile.md#the-native-ios-tab-bar)); the conversation's
top bar and its composer are next: *"replace the bar on top of messages with just a back and menu
button that then grows (as intended by the liquid glass design) to show the other options
(pictures, search, etc.) and do the same for the composer"*.

**Decisions (user, 2026-09-30):**
- **L1 - the header is three pieces of glass:** back on the left, the contact's avatar and name in a
  CENTRE PILL (tap: the conversation's settings/info panel), and a menu on the right that GROWS into
  the actions the header carries today - Members (community channels), Media, Search, Settings, and
  the call buttons once `CALLS_ENABLED` returns. The lock and the channel label go with the actions.
- **L2 - the composer's actions become ONE "+" that grows** into Photos and videos, All files, GIF,
  and Poll (channels). The chevron fold (`controlsCollapsed`) goes: a single button needs none. The
  text field, the microphone and Send stay where they are - and stay WEB on iOS too, since the
  plugin has no native text field.
- **L3 - OVERRULED THE SAME DAY: the PHONE APPS only** (user, 2026-09-30: *"only apply it on phone
  finally, the design is good on web"*). iOS and Android wear it - native Liquid Glass on iOS (WP-G2),
  CSS glass on Android; the website keeps its classic header and composer at every width, a phone's
  browser included. One predicate decides it, `usesGlassChrome` (`lib/mobile/glassChrome.ts`).
- **L4 (assumed, not asked) - phone width only.** The desktop header has no back button and room for
  its icons; it and the desktop composer are unchanged. Overrule here if wrong.

**Both halves MERGED 2026-09-30 and SHIPPED in `v0.18.32`**: WP-G1, the apps in CSS (#1251,
[chat](frontend/modules/chat.md#the-conversations-chrome-in-the-phone-apps---glass-floating-over-the-thread-2026-09-30)),
and WP-G2, the iOS native glass drawn at the web pieces' rects (#1254,
[mobile](frontend/mobile.md#the-conversations-native-glass-chrome)). **Owed on the iPhone 12**:
the alignment, the keyboard, "+" > Photos opening the picker, VoiceOver's four names. **Read 2026-10-05 on the iPhone 12 (bench build of `77f5e3cc4`, local stack): the native glass tab bar refracts the content under it, and in a conversation back, title and the menu are native glass - PASS.** The keyboard, the picker and VoiceOver are still owed.

## The MiConnect profile reform - decided 2026-09-29, the technical plan is next

Anyone with a CAS (soon an Alumni SSO) account reaches MiConnect, and what decides access today is
one self-declared string, `formation = 'ICM'`, hard-coded in three places. The user decided the
whole model in one sitting: cumulative affiliations (cursus or staff post), one campus, spaces =
formation x campus, audiences fixed by the publishing association, one BDE per space, Authentik as
the single truth edited from Canari by admins only, per-application access decided centrally, and the
migration of the 600 accounts. **Thirty-two decisions, all on
[profiles-and-access](profiles-and-access.md), the only copy** - with the production measurement they
were taken against. **The technical plan is its section 4, eleven work packages, VALIDATED by the
user the same day: WP0, then WPA (authentik as code), then WP1.** WP0 SHIPPED, WPA and WP1 LIVE on production (2026-09-30); WP4 (4a, 4b #1471) is on main; WP5 is next. **WP6b (readers by space) is BUILT on its branch (2026-10-04) and its release order is forced** - see the owed-to-the-user table above.

## Asked by the USER on 2026-10-05 - one request, not built

**Reply and mark-as-read from a salon notification** - absent on Android AND iOS by design; a salon send is server-authoritative, so it needs its own native send path. iOS actions never run in this repo's gates: owed a hand on an iPhone for a DM and a group.

## Open defects, in severity order

### P2 - about one CAS return in six reaches MiConnect with no code and no state, and the sign-in fails (measured 2026-09-29)

`docker logs miconnect-server-1` since its 2026-09-24 restart: **72 `State check failed`**
(`authentik.sources.oauth.views.callback`, preceded by "No state parameter returned by the source")
against ~420 responses on `/source/oauth/callback/cas-emse/` - between 3 and 21 a day. Every failing
request reads the BARE callback URL: no `code`, no `state`, no query string at all, while a working
one carries `?code=...&state=...`. So this is not a stale or mismatched state: the CAS sends the
browser to the callback without answering the authorization request. The same user agent fails
three times in a row (twice on 2026-09-29, a Linux desktop and an Android phone), so people retry
and stay out. The deny text of the unreferenced `miconnect-auth-fallback` flow describes exactly
this, so somebody met it before and it was never measured.

**Not yet known, and the next probe:** what brings the CAS to redirect to the bare URL - a CAS login
page left open past its webflow timeout, a bookmarked CAS page, or a CAS SSO session answering a
request it no longer holds. Read the access log of ONE failing sequence end to end (the request
before the bare callback, its `Referer`, the time since `/source/oauth/login/cas-emse/`), then
reproduce it on purpose. What the user SEES afterwards is also unobserved. **A request is already with the DSI (user, 2026-09-29), and the rest waits for its
answer.** Nothing may be changed on the CAS side from here; the fix may be a DSI ticket, or a MiConnect flow that restarts the
authorization instead of failing. [authentik](infrastructure/authentik.md#the-hand-built-configuration-audited-2026-09-29).

### P1 - Graine v2 - an author that is proven, and a ciphertext bound to its place (decided 2026-09-28)

**What is wrong**: v1 hides a salon message from the server and proves nothing about who wrote it or
where - the server can re-attribute, move or replay a row, and any member can forge one in another
member's name. The table is [channel-encryption §7](protocols/channel-encryption.md#7-what-the-server-can-still-do-stated-rather-than-implied),
the design [§21](protocols/channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28).
**The user decided all three on 2026-09-28**: the whole of it (bound context, checked author, a
signature per session); a relayed endorsement checked against the server-published device key once
the minter's device has left the tree; the DMs in the same chantier.

One pull request per package, in this order. R1 = G2-0 to G2-4 and the writer G2-5 are SHIPPED (#1221; the writer first ships in the stable `v1.0.3`, 2026-10-05);
`minClientVersion` is STILL `1.0.0` (read 2026-10-04) and is raised by the user only. The mechanism is [channel-encryption §21](protocols/channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28).
**What is left**: the second half of G2-5 (BLOCKED until `minClientVersion` is >= `1.0.3` and both stores serve it), G2-6b and G2-6; hardware is the Mi 9T, the iPhone reading is owed ([device-verification](device-verification.md)).

| WP | What | State |
| --- | --- | --- |
| G2-5 | **The WRITER shipped** (#1221). **Open: v1 ends (user, 2026-09-28)**: a v1 seed that ARRIVES is refused - a modified client could otherwise keep minting v1 to forge an author - while v1 seeds already held stay readable until their rows age out (365 days), and the v1 reader is deleted | writer shipped (stable `v1.0.3`); **refusal and reader deletion BLOCKED on the floor**: clients `1.0.0`-`1.0.2` still mint v1 seeds, so refusing one now drops their messages. Unblock = raise `minClientVersion` to >= `1.0.3` once BOTH stores serve it (`bun tools/play-vitals/vitals.mjs` + App Store), then touch `utils/graine/{sessionManager,wireSeed}.ts`, `crypto/graine.ts` and the native `merge_graine_seed` |
| G2-6b | **Salon edits (2026-10-05) are author-proven only under v2 sessions**: an edit row from a v1 session has an unsigned, server-supplied `senderId` (same trust as DELETE, a deliberate level, no code owed); closes with the v1 reader when the last v1 session ages out ([§21.5b](protocols/channel-encryption.md#215b-what-a-salon-edit-trusts-2026-10-05)). **Also owed, only if a channel ever gets an older-page load:** `listMessages` with a `before` cursor omits edit (and reaction) rows made after the cursor; the fix would need the page's targets reachable, which the opaque rows forbid server-side | open |
| G2-6 | Campaign row `GRAINE-AUTH` (a relabelled row on dev, a replay, a seed relayed from a departed member - each refused with its line); `NOTIF-19` and `NOTIF-20` on a v2 session; the durable rule | rig row, board entry and durable rule written 2026-10-05 (GRAINE-AUTH-1 to -3 have a runner, -4 has none); **owed: a run of GRAINE-AUTH-1..3 on the local estate and NOTIF-19/20 on the Mi 9T against a G2-5 build** |

**What v2 does not close**: the server can still admit a device it controls or publish a false
device key - BasicCredential's limit, stated in §21.

### P1 - a returner's devices: one reading owed (shipped in `v0.18.26`)

The election reads presence and waits for an online holder ([channel-encryption](protocols/channel-encryption.md#wp-33-and-the-answerer-nobody-elects)). **Owed:** a reading of the returner's devices (`[GRAINE] asked <online member>` or `wait for a holder to come online`, then the salon filling); the second community of 2026-09-24, member by member; an end-to-end harness row. **Residue, not fixed:** a backgrounded Android can hold its socket and look online while unable to answer - the elected member is then silent and the next start re-asks.

### P3 - every keyboard rise moves the composer for a moment, on both phones, and the cause is a different stale number on each (measured 2026-10-02)

Found while reading the GIF panel (#1345). The composer's top was recorded on every animation frame
via CDP, with the keyboard opened by tapping the text field. **Both happen on a plain keyboard open
with no panel involved**, so neither comes from the panel's hand-off, though both show through it.

- **Mi 9T (A1, Android WebView).** The top sits at 877 px, then for 60-100 ms at **174 px**, then at
  532 px. During that window `visualViewport.height` reads **230** while `innerHeight` is already
  **588**. 945 - 2 x 357 = 231: the keyboard's height is taken off TWICE for one report, once by the
  resize and once by the visual viewport. `keyboardViewport` follows the visual viewport, so the
  composer jumps 358 px up and comes back. Measured twice (with and without the GIF panel), with the
  same numbers both times. The remembered keyboard height is not polluted: the last write wins, and
  it is 357.
- **iPhone 12 (I1, iOS 27.0.1).** The top sits at 766 pt, then for ~400 ms at **465 pt**, then at
  487 pt. `visualViewport.height` is 543 from the first frame, but `--safe-area-inset-bottom` stays at
  **34px** for ~400 ms before it falls to 0. `.keyboard-open .chat-composer-footer` pads
  `max(0.75rem, var(--safe-area-inset-bottom))`, so the composer stands 22 pt (34 - 12) too high
  until the inset catches up.

Neither is fixed. The Android one wants the WebView's double report recognised for what it is (a
viewport that shrank inside a layout viewport that already shrank). The iOS one wants the footer
not to pad a safe area the keyboard already covers. That runs against the comment on that rule ("the
reserved space must not visibly shrink just because the keyboard opened"), which has to be read
before changing it. Readings: [#1345](https://github.com/emse-students/canari/pull/1345#issuecomment-5943602239).

### P3 - MiConnect: one string left after the French pass, and one observation (2026-09-25)

The layout, the flat pass, the French titles and prompts, the redirect to Canari and the signed-in
`continue` are SHIPPED ([authentik](infrastructure/authentik.md#one-language-french-in-the-ecosystems-tu-2026-09-25)).
Left: authentik's own untranslated "Go back" (its reason on that page). **One observation owed**:
`miconnect-auth` opened while signed in, on the Mi 9T, should now go straight through.


### P3 - the login page's "Ouvrir dans l'application": one tap owed on each phone (2026-10-08)

The French badges and the link are shipped ([auth](frontend/modules/auth.md#open-in-the-app-from-the-login-page-2026-10-08));
"Connexion externe (service-account)" stays word for word by the user's decision. Owed: tap the
link on a phone WITH the app (Android and iPhone) and see it open.


### P3 - a CrowdSec ban on this host closes the co-tenant sites too (measured 2026-09-25)

The two actionable halves shipped (`real_ip` through the tunnel connector, acquisition widened to
three access logs - [estate-migration](infrastructure/estate-migration.md#crowdsec-covers-this-host-in-two-halves-and-only-one-of-them-reaches-every-vhost)).
**What is left is not ours to close.** A CrowdSec decision is GLOBAL per address on this machine,
so a ban earned on Canari traffic already shuts `gala`, `mep` and `portail-etu-new` to that address,
and a ban earned on theirs shuts Canari. `/etc/crowdsec/acquis.yaml` is likewise the DSI's file.
Both were true before any of this work and neither is a change this repository may make alone - it
is a conversation with the machine's owner, and it is recorded here so nobody re-derives it as a
finding a third time. `canari-dev.access.log` stays deliberately unparsed: dev is reached only
through the relay, so it still shows one address for every visitor.


### P3 - a French app's notification settings show six French channels and one called "Default" (measured 2026-09-23)

`tauri-plugin-notification` creates a channel on plugin load whose name and description are the
hardcoded literal `"Default"` (`TauriNotificationManager.kt:96`, version 2.4.0) - not a resource, so
it is not localizable and Paraglide cannot reach it. It appears beside `Messages Canari`,
`Mentions Canari`, `Appels Canari`, `Activite sociale Canari`, `Reactions a vos messages` and
`Rappels de formulaires` in the Android notification settings screen. **Nothing posts to it**: the
manifest points Firebase at `canari_messages`, and every builder in this repository names a
`canari_*` channel, so it is an empty row rather than a mis-routed notification. It is created in
BOTH build types, so it is not a shrinking regression. Closing it means deleting the channel after
the plugin registers it, or carrying a patch upstream.


### The MLS audit items that are still real, with their verified counts (swept 2026-09-12)

**These numbers are the swept ones, not the audit's.** The audit was written by reading the source,
so each item was a hypothesis; the counts below were re-derived against `main`, and eight of them
came back LARGER than claimed. Every item the sweep killed has been deleted from this list rather
than recorded - what shipped is in `CHANGELOG.md`.

The duplicate half of the audit is gone from this file: five rows on 2026-09-14 and none of them
survived the day. Its account is on
[the triage page](protocols/mls-graine-state-machine.md#8-several-paths-to-one-thing---the-duplicates)
and the rule it cost is in
[durable-rules](durable-rules.md#an-open-item-whose-substance-has-never-been-in-the-repository-is-not-an-open-item).
**What follows is the whole of what is left of the audit.**

**Availability dead ends - every one needs an exit that EXISTS** (the user, 2026-09-12: *"on ne peut
pas demander a un utilisateur de sortir de l'impasse lui-meme. La sortie de l'impasse doit exister
pour garantir la disponibilite"*, scoped the same day to availability rather than deliberate
refusals):

| Item | The state | Population |
| --- | --- | --- |
| an outbox entry with no terminal state | the two permanent dispositions are `group-deleted` and `evicted`; a group nobody can repair is **neither**, so a held entry stays pending for the life of the install | **the counter it would need now exists** (2026-09-14); what is missing is the PROOF a terminal disposition may be taken on, and a clock is not one |
| `R-E9`, `R-E11` | peer-unresolved; `readWelcomeOwed() === null` | retried for ever, no counter |
| `DE7` | `MLS_LOCAL_STATE_UNDECRYPTABLE` | the only route offered requires the OLD PIN |
| `G-E10` | `forgetCommunityGraine` with no runtime | warns, returns 0; seeds and joined groups stay |

### P3 - one seat on production has no client behind it, and removing it is not the server's to do (measured 2026-09-22)

**The placeholder-seat question finally has production evidence, and it is one seat.** The three
identities previously cited as instances were this campaign's own mention fixtures. Swept
estate-wide, **two** seats belong to users with no `key_package` anywhere: one is a real member of a
real two-person conversation who has never had an MLS device, and one is a brand-new account that
made a one-member group at epoch 0 and locks nobody out.

**The real one was taken on 2026-08-10, inside the window where `userHasMlsDevices` was a constant
`true`** - the guard whose whole job is to refuse exactly that invitation, broken until 2026-08-19.
The sweep finds no real case after the fix, so this is residue and the guard holds. Full table and
the reasoning in [the state machine](protocols/mls-graine-state-machine.md#a-seat-with-no-client-behind-it---the-first-real-one-and-the-population-is-two-2026-09-22).

**What is open is small and may well close as "leave it".** Whether the MLS tree still carries a
leaf for that member is a question only a holder's CLIENT can answer, and removing it is a client
action inside a real student's conversation. The decision is whether one residual seat is worth any
mechanism at all.

### P1 - a damaged local MLS state is reported as a PIN rotation, and the PIN the user actually holds does not get them back in (measured 2026-09-08)

**WHAT IS LEFT IS STEP 2, AND IT IS BLOCKED ON ONE FACT.** CORRUPT-2 and CORRUPT-1 (2026-09-08)
measured a damaged state misnamed a PIN rotation and the correct PIN refused; the typed errors, the
honest message naming the reset, and the blob-header READER (step 1) shipped in `v0.18.18` (#901), and
the "first connection" heading that contradicted it is fixed. The mechanism and the measurements are
on [mls-protocol](protocols/mls-protocol.md#the-state-blobs-framing---read-first-write-later).
**Step 2** is the one-line writer flip (`state_blob::frame_v1` at `save_encrypted_with_key`) plus the
`minClientVersion` bump, and its one remaining precondition is that the fleet has taken the reader (`>= 0.18.18`) -
`minClientVersion` is already `1.0.0`, so ONE measurement with `play-vitals` and the App Store settles it, never a date written here. Until then the two causes of `MLS_LOCAL_STATE_UNDECRYPTABLE` stay unseparated in
the field, and `DE7` keeps its old-PIN-only route.

**When step 2 lands**, `serverProse.test.ts`'s one `ALLOWED` entry (`sessionAuth.ts`, comparing
against `MLS_LOCAL_STATE_UNDECRYPTABLE`) must stop being allowed - the guard FAILS on an entry that
stops offending, so it will say so. **Still worth a run once a device's history is expendable**: the
sign-out half, which was answered by READING `handlePinSignOut` (it keeps the local state), not by a
run.

**What step 2 must NOT become**: a fallback that re-enrols whenever a decrypt fails would destroy
the history of every user whose PIN really was rotated - the case `noFreshStart` exists to protect.
The two causes are TOLD APART by the fingerprint, never merged.

**Where the evidence is.** Board cell CORRUPT-2 on [cross-client-testing](cross-client-testing.md);
the runner in `tools/cross-client-harness/archive/corrupt2.mjs`.

---

### P2 - the legacy rows are LOADED on both estates, and NOT ONE claim has been observed (shipped 2026-09-11, v0.17.1)

**1429 rows are staged on dev and on production** - 269 BDE, 1160 Cercle, applied through
`--emit-sql` and `psql`, `INSERT 0 0` on a re-run. Nothing is waiting on a load any more. What is
still missing is a single observed claim: the mechanism has never been watched granting a tag to a
real person, and the instruments that would show it - the service log line and
`/admin/legacy-cotisations` - have never been read against one.

**Sixty accounts will settle it without anybody arranging anything.** Projected against production's
396 accounts by computing each user's key with `normalizeMatchKey` itself, rather than an
approximation of it in SQL:

| | staged | has an account today | will be GRANTED | will close `already-held` |
| --- | --- | --- | --- | --- |
| BDE | 269 | 152 | 27 | 125 |
| Le Cercle | 1160 | 156 | 33 | 123 |

Zero keys are held by two accounts on either estate, so the collisions tab starts empty and any row
appearing in it later is a real homonym. The remaining ~1120 rows belong to people with no account,
which is the whole reason this is a staging table and not a one-shot grant.

**`already-held` is the DOMINANT case, not the rare one** - 248 of the 308 rows that have an account.
Each is somebody who already paid through Canari and whose row closes without granting, because the
sibling-tier revoke inside `grantCotisant` would otherwise take away the tier they paid for. The
guard is therefore load-bearing on first contact with real data, and it is the one thing to read on
the screen once sign-ins start.

**What to read, and when.** The next time somebody signs in, `/admin/legacy-cotisations` should move
off zero in the claimed tab. Until it does, an empty screen and a broken claim still look identical.

The key's two assumptions (promo offset, the `promo.csv` accent repairs) were measured, the excluded
rows and the unserved promo-2026 cohort are decided: all on
[cotisations](cotisations.md#loading-a-source).

### P3 - message notifications share one group key across conversations (measured against Messenger, 2026-09-09)

The conversation shortcut shipped (#1448; [mobile](frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)). **What remains:** `setGroup(GROUP_KEY_MESSAGES)` is still ONE constant at three call sites of `CanariFirebaseMessagingService.kt` with one summary, while Messenger keys per THREAD, so four messages across two conversations stack as one here and two there. P3, a placement difference only; measure on the Mi 9T after any change, since nothing in CI sees which section of the shade a notification lands in.

---

### P3 - a revocation round trip sits in front of the fingerprint prompt, and moving it is REVERTED, not to be re-opened (measured on the Pixel 6a, 2026-09-15)

Three of the four causes of a slow launch-to-prompt are fixed (with the 2 731 ms `mls.bin` bridge
crossing); **the fourth, `isDeviceRevoked` in front of the prompt, STAYS** - why it may not move
behind `init()` and why it cannot be "issued early" beside the refresh are on
[cold-start](frontend/cold-start.md#the-revocation-gate-stays-in-front-of-the-prompt-and-the-launchs-console-noise-is-explained-pixel-6a-2026-09-15),
as is the disposition of the launch's seven console lines. What is open is whether the round trip is
worth REMOVING, and the verification table's launch row is the number that decides it. In the
measured trace (`v0.18.1`) the login path reached `init()` at +1405 ms behind two serial round trips,
the refresh (132 ms) and the probe (never timed alone).

Three shapes were weighed ([cold-start](frontend/cold-start.md#the-revocation-gate-stays-in-front-of-the-prompt-and-the-launchs-console-noise-is-explained-pixel-6a-2026-09-15)): overlapping the probe with `init()` needs the `wipingRevokedDevice` latch to cover a login already in flight, with no timeout and no heal; letting the refresh answer both questions costs an internal call on EVERY refresh; a separate credential for the probe is rejected on sight.

**MEASURE BEFORE CHOOSING, and that is not a deferral - it is the same rule this entry was written
under.** The refresh was 132 ms; the probe has never been timed on its own; and the `mls.bin` block
that dominated everything is gone as of `v0.18.3`. If the remaining budget is not dominated by these
two round trips, this is the wrong first target. `bun tools/cold-start/launch-trace.mjs --heartbeat`
on the Pixel 6a is what says so - and it needs a build pointing at an environment where that device
HAS a session, which is the coupling this file records separately.

---
### P2 - the MLS init waited ten seconds behind twenty-four avatars on `v0.18.5`, and nothing has re-read that window on a cold PHONE (measured on production 2026-09-16)

The avatars are edge-cached since 2026-09-16 and batching them is REFUTED
([core-service](services/core-service.md#the-avatar-proxy)). On the user's cold `v0.18.5` console,
`Initialising MLS (vault device key path)...` and `WasmMlsClient::new` were ten seconds apart, inside
the avatars' window, and the cause - network concurrency, main-thread contention, or a slow vault
derivation - was never named. The browser re-reading on `v0.18.16` (2026-09-20) puts MLS ready at
968-1182 ms with every asset forced over the wire, so the window did not reproduce there
([cold-start](frontend/cold-start.md#the-split-answered-on-the-day-it-shipped-an-ordinary-boot-is-968-ms-and-mls-load-state-is-8-of-it-2026-09-20)).
**Owed**: one cold start on a phone, whose console lines bracket themselves (`+<ms>` since #742) -
write no marks. **Do not "fix" it by lowering the avatars' fetch priority**: a hint is advisory and
per-engine, and would make the measurement unreproducible.

---
### P2 - A CHANGED PROFILE PHOTO: `no-cache` + ETag SHIPPED (2026-10-08), ONE EDGE READING OWED

The proxy no longer claims 24 h; the shape, the layers table and the busted-URL alternative are in
[core-service](services/core-service.md#no-cache--the-upstream-etag-and-the-busted-url-it-did-not-need-2026-10-08).
**Owed, then delete this entry**: after the deploy, `curl -sI` a face twice through `canari.emse.fr`
and confirm Cloudflare revalidates (`cf-cache-status` not a `HIT` with a growing `Age`), then change a
photo in MiGallery and watch it appear. If the avatar Cache Rule overrides the origin, the fix is
that rule, not a number here.
### P3 - THE TWO OPENING LINES BELONG TO THE DOCUMENT THAT IS LEAVING, AND THE GUARD WAS WATCHING AN EVENT THAT ARRIVES TOO LATE (production, 2026-09-16)

#754 shipped: `WebMlsService` listens for `beforeunload` as well as `pagehide`; the mechanism and the Chrome ordering are in [auth](frontend/modules/auth.md#and-what-is-not-a-reconnect-the-page-leaving). **Owed: ONE Firefox reload of a build carrying it** - are the two outgoing-page lines (`+15269ms` stamp, the previous build's `app.*.js`) gone? If they are still there, Firefox closes the socket before dispatching any event: then no DOM event can discriminate, and the lines are to be EXPLAINED where they are read, never suppressed.

---
### P3 - ONE MAINTENANCE PASS IS ON THE AWAITED PATH, BLOCKED ON A FACT NOBODY HAS DEFINED

**AND ONE PASS IS STILL ON THE AWAITED PATH, BLOCKED ON A FACT NOBODY HAS DEFINED.**
`prune_expired_key_packages` costs **10.08 ms** at a 1000-bundle pool after #824 (criterion, OXYGEN; 88 % of it is `serde_json` decoding, which a partial shape cannot avoid - [cold-start](frontend/cold-start.md)) inside
`load_or_create`, in front of the first screen - NATIVE ONLY, the web never runs it. It is maintenance, not a diagnostic - what it deletes
must be deleted and nothing else deletes it - so moving it needs a TRIGGER, and a clock is forbidden
here. **The blocking condition, written so nobody ships a timer instead:** name a durable fact that
says *this pool has been pruned since it last changed*, carried in the state blob rather than
inferred, and prune when that fact is absent. Until such a fact exists the pass stays where it is,
because a pool that silently stops being pruned makes the prekey P1 worse.

**THE NEXT QUESTION IS INSIDE RUST, AND ITS 82.7% MUST BE RE-DERIVED BEFORE IT IS QUOTED AGAIN.** It
said ONE native call is 82.7% of post-login. On 2026-09-20 post-login is 282 ms, of which that call
is 74 ms (26%) and `revocation-gate` is 123 ms (44%) - so the figure describes a population these
readings do not contain, and *a predicate that named the last incident is not the predicate that
names the next one*. What survives untouched is the shape it pointed at: the cost is linear in a pool
nothing reclaims, which is the prekey P1 measured from the other end - 32% of everything decrypted on
every boot is the unreclaimed one-time pool.

### P2 - THE NETWORK FOR THE JAVASCRIPT IS SOLVED; 1.62 MB OF IT STILL HAS TO BE PARSED BEFORE ANYTHING RUNS (measured on production 2026-09-16)

The delivery is solved (21 ms TTFB, merging chunks refuted) and what is left is parse and evaluation of 1.62 MB of JavaScript on `/chat`, of which two chunks (the chat engine, 404 879 B, and the protobuf codec, 146 160 B) are 44 % of what `/login` loads through ONE static import in the root layout (`+layout.svelte`, `globalChatSingleton`). The measurements, the module-graph reading and what NOT to do (touch the preload header, merge chunks) are on [cold-start](frontend/cold-start.md#the-javascript-is-parsed-before-anything-runs-the-delivery-is-solved-measured-on-production-2026-09-16).

**THE NEXT STEP IS STILL A MEASUREMENT, NOT A REFACTOR OF THE LAYOUT.** The user's next cold-start
export is what says whether parse time is even the dominant term - since #742 every console line
carries `+<ms>`, so the gap between the first line and `Initialised in WEB mode` is readable
directly. Splitting the root layout's chat import is a real architectural change to the thing that
keeps the session alive across navigation, and it buys nothing on the route the target is measured
on.

---
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
- **P1 - USER DECISION: should a phone join a salon's key group from the PUSH, as it joins a DM from
  a Welcome?** Two Gala members (`76198d2d`, `7bc0efc7`) held no device in the key group: the seat is
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
- **P3 - USER DECISION, then native work: the push scanner's sixteen sentences are French literals and
  a voice note is announced as an audio file** (`mobile/proto_fields.rs`). Word them in Rust from the
  mirrored locale, or hand the KIND to Kotlin and Swift - the second changes what the FCM cache stores
  as a body. Either needs an Android and an iPhone reading to ship.
- **P2 - one observation: the post its publisher could not delete (2026-09-17)** - the post's URL, or
  whether its publisher held `POST_AS_ASSO` on that association.
- **P2 - one observation: the member who could not publish (2026-09-21)** - once he is past `0.18.14`
  (still there 2026-09-23), whether the composer, which now names its failing stage, refuses him
  anything ([posts](frontend/modules/posts.md#one-catch-said-seven-things)).

## Notifications - one builder on Android since 2026-09-18, and the rows that still owe it a run

### P2 - NOTIF-15 - NOTHING HAS HEARD `canari_reactions` ON A REAL HANDSET

Owed: NOTIF-15 on a real Android handset - a reaction to the recipient's OWN message rings on
`canari_reactions`, and every other reaction stays silent. That the channel exists in both locales
is already asserted (`notificationChannels.test.ts`); how it sounds is not.

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

### P3 - three tap/reply rows owed against Android's single notification builder

Owed on the board, each stating its trigger (`builtBy`): NOTIF-6c (quick reply, backgrounded, and its
2026-08-30 `403` fix), NOTIF-7c and NOTIF-7d (tap into a CHANNEL, backgrounded and killed). Also
settle whether NOTIF-11/-12 (`MessagingStyle` stacking) already speak for the backgrounded path,
which reaches the same builder.

## CI and the chain that runs unattended

### P3 - a PRE-RELEASE tag still races a merge between the head read and the tag

The stable half closed with #1367. Open only if it recurs on an alpha; the direction is in
[cicd](cicd.md#a-pre-release-tag-can-still-race-a-merge-between-the-head-read-and-the-tag).

### P3 - EVERY `.swift` IN THE iOS TREE IS UNGUARDED, AND NOTHING HAS MEASURED WHETHER A SUITE EVEN EXISTS

The Android half closed on 2026-09-22 (one pure function compiled twice, [mobile](frontend/mobile.md#the-android-half-of-it-is-one-function-compiled-twice-2026-09-22)).
iOS is untouched: two Swift test targets exist under the vendored plugins (`tauri-plugin-keystore`,
`tauri-plugin-customtabs`), and nothing has measured whether the NSE/app Swift is in the position the
Android ladder was (needing no platform), nor whether those targets run anywhere.

### P1 - production goes dark in the 22h band, and the only thing both boxes share is the School's firewall (measured 2026-09-11)

The measurement (175 `cloudflared` edge-dial timeouts in seven days, all at 22h-23h CEST, the School's
`fw-ste.emse.fr` the only element both egress paths cross), the two refuted hypotheses and the egress
probe are on [cloudflare-edge](infrastructure/cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it).

**Open since the 2026-09-24 cutover:** whether the Portail-etu host sees the same drop is UNMEASURED.
Read `journalctl -u cloudflared` on `portail-etu-direct` for 1033 and edge-dial timeouts at hours 22-23
over seven days; ask the School's network service what is scheduled on `fw-ste.emse.fr` only if it
does. **Re-arm the egress probe on the Portail-etu host or retire it** (its crontab is on the old VM,
which runs no container).

### P3 - audit advisories are suppressed because they cannot be reached, and should stop being

Four advisories (`GHSA-vcc3-ghjq-m6fr`, `GHSA-528h-pc64-c93x`, `GHSA-hqr4-qq8f-hg3x`,
`GHSA-mjw6-4jj6-33hc`) are ignored on the `minio > ...` edge of media-service. **Retire the ignores and
the premise assertion (`.github/scripts/stream-json-premise.sh`) the day minio publishes a release that
moves either pin** (last checked 2026-10-06: minio still 8.0.7). The reasoning, the upstream-check log
and the dead retirement condition are in [cicd](cicd.md#four-audit-advisories-are-suppressed-on-one-edge-of-media-service-and-why-each-is-unreachable).

### P2 - THREE hosts take security updates that nothing reports on, and a library nothing restarts (the rest closed 2026-09-03)

The mechanism and report exist since 2026-09-03 ([host-updates](infrastructure/host-updates.md)). Three
open items, each with its retirement condition in
[host-updates](infrastructure/host-updates.md#what-stays-open-the-reports-reach-the-raid-channel-and-libraries-nothing-restarts):

1. the report points at the OLD production origin and reaches no other host (`mitv`, `cercle`,
   `miconnect` unreported) - a runner key on them is the user's decision;
2. `mitv`'s 7.3 TB RAID1 has a sensor (`mdmonitor`) and no channel - `/proc/mdstat` into the daily report;
3. a library fix is installed, not in effect - `needrestart -b` into the same report.

## iOS, platform and runtime - the residue that fits no other section

### P2 - iOS carries none of the window-layout work Android already has (user, 2026-08-28)

**OWED - an iPhone re-read of the bars.** The code half shipped (#1242, #1261, #1289;
[android-ios-parity](frontend/android-ios-parity.md) 1.1, 1.3 and 1.4 are FIXED); what is owed is the
user's look at the status bar and the home indicator on the iPhone, with the liquid-glass chrome
([backlog](#the-liquid-glass-conversation-chrome---decided-2026-09-30-wp-g1-then-wp-g2)). This closes
by hardware, never by a fix against a suspected bug nobody has seen.

### P3 - nothing records which BUILD each device runs, though two mechanisms already carry it (2026-08-27)

A column and a write, and a decision (which table owns it, whether a web session is a device, what a
dashboard shows). The two mechanisms and the question are on
[core-service](services/core-service.md#nothing-records-which-build-each-device-runs-2026-08-27).

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
relay-path call, two peers, audio and video, TURN as production configures it, taken by hand
([calls](frontend/modules/calls.md#the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27)).

### P2 - what made the profile fetches fail on that device at that moment

Owed: the DENOMINATOR (the `(failed/attempted lookups failed this session, X%)` suffix on every
`displayName.ts` warn), read from a device or browser console during a run, then a decision about
`FAILURE_BACKOFF_MS` ([chat](frontend/modules/chat.md#profile-fetches-that-failed-on-a-device-and-the-denominator-that-is-owed-2026-08-16)).

---

## Communities and permissions

### P2 - a bundle of pure DECLINES still goes out as transport, and a dropped decline strands a requester

Never observed. Fixing it needs a frame delivered to an offline device WITHOUT appending it to the
group's log (the fourth `DELIVERY` combination) - a wire-level change that waits for a measurement
([mls-graine-state-machine](protocols/mls-graine-state-machine.md#a-bundle-of-pure-declines-goes-out-as-transport-open-never-observed)).

## Messaging convergence

### P1 - the repair of a rewound sender lands on a coin flip, the ask cadence is identical either way, and a peer 21 messages behind was told "same state - nothing to do" (measured 2026-09-08, ten runs across three builds)

HEAL-repair heals 3 times in 10 because the server elects a random online member, one of three holds
the messages, and the walk stops on a peer's AGREEMENT. Open: specify the state the fix remembers
(WHAT, for HOW LONG, what discharges it - the repair landing) and exclude an agreeing peer while the
asker holds frames it cannot read. The measurement, the root cause and the two refuted causes (not to
be re-opened) are in [history-reconciliation](protocols/history-reconciliation.md#heal-repair-lands-on-a-coin-flip-the-measurement-and-the-root-cause-2026-09-08).

### P3 - the pull and the socket hand the SAME row in, and the queue notices afterwards instead of the overlap not existing (measured 2026-09-08)

Open: (1) the web overlap - the pull should not queue a row already queued for the device (a
membership test in the same module), after measuring the RATE (`notableCount` was 91 on one record);
(2) one on-device NOTIF-10 re-read of the generic-banner ledger (#1550); (3) `read_and_clear_fcm_cache`
clears before the JS has persisted - read, persist, THEN clear. The analysis, who consumes the
generation and the withdrawn 2026-09-08 fix are on
[mobile](frontend/mobile.md#one-row-arriving-through-the-push-the-pull-and-the-socket-measured-2026-09-08-to-2026-10-06).

## Background notifications on Android - what the 2026-09-05 investigation left open

### P2 - a COMMUNITY message is not decrypted in a background notification, and the KILLED case is unmeasured for both kinds (user, 2026-09-05)

Owed: four NOTIF rows on ONE build - salon x {backgrounded, killed} and DM x {backgrounded, killed} -
so the comparison is one afternoon. Read the board first: NOTIF-18/-19/-20 (killed salon rows) may
already answer the killed salon cell with a mirrored seed. A blind banner is counted since
2026-10-05 (`[PUSH_BLIND]`, `missing=` names the cause), so the fleet rate can be read beside them.

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

### P1 - twelve of sixteen messages were FETCHED AND DROPPED (prod 2026-09-02) - the residue

Four causes fixed. Open: the twelve are recoverable only by diffing the peer's iPhone; **which arm of
`process_message` dropped them is not established - do not write a fix against a suspected arm**; whether a
device that dropped a frame should say so is not decided
([detail](protocols/campaign-measured-defects.md#twelve-of-sixteen-messages-fetched-and-dropped-the-hole-at-epoch-121-prod-2026-09-02)).

### P3 - the phone polls presence every ten seconds over a live WebSocket (2026-09-02)

Still so (`presenceStore.ts`). A push first needs the decision of who may watch whose presence
([detail](protocols/campaign-measured-defects.md#the-presence-poll-logcat-2026-09-02)).

### P2 - a device holds a distribution group the group holds no row for, and heals by rejoining (2026-08-29)

A race that heals is still a defect. First question: is it ONE defect with the `no_key_package` refusal
below (same group `315b8a1d`, a second apart, recurred on every fresh device)?
([detail and recurrences](protocols/campaign-measured-defects.md#a-device-holds-a-distribution-group-the-group-holds-no-row-for-2026-08-29))

### P2 - a membership is REFUSED for want of a KeyPackage one second after the device external-joined that group (2026-08-29)

Open: the KeyPackage publication's timestamp against the refusal's names which ordering is real; HEAL-NEW
verdicts are "clean on the web client", never on the server
([detail](protocols/campaign-measured-defects.md#a-membership-refused-for-want-of-a-keypackage-one-second-after-the-external-join-2026-08-29)).

### P1 - a device asks for a Welcome for ever and the member that answers resets the row (prod 2026-09-01) - the residue

Six causes fixed (`CHANGELOG.md`). Open: one prod measurement (stale bases at `activeEpoch`, one reading
of the hourly *kicked with no re-add* ERROR arm) and the local `[KICK] Stale leaf` sighting. The rotation
fix for the dead-end responder was REFUTED 2026-09-08, not to be re-opened
([detail](protocols/campaign-measured-defects.md#the-welcome-livelock---the-residue-prod-2026-09-01)).

### P2 - a roster seat without a Welcome: the reason is typed on the client, the server report cannot partition on it yet (prod 2026-09-01)

Open: a client-to-server write (migration) so `reportStrandedDeviceMemberships` can join the reason; read
the first real `skipped` lines before designing it
([detail](protocols/campaign-measured-defects.md#a-roster-seat-without-a-welcome---the-typed-reason-prod-2026-09-01)).

### P1 - the placeholder is GONE from prod; what it may have left in the MLS TREE is not answered

The server estate is clean; whether a leaf survives in `7da231f8-119c-4ce2-884f-55f5c94c903f` (epoch 118) is
answered only from a member's own client, which reads the tree
([detail](protocols/campaign-measured-defects.md#the-placeholder-and-the-mls-tree)).

### P2 - a group that never leaves its creation epoch keeps collecting device invitations nobody can honour (prod 2026-08-30)

Open decision, three parts together: should an invitation expire, should a group whose creator holds no
state still be offered, should an unservable group show a tile. Never by widening a sweep; `activeEpoch
<= 1` is NOT the predicate, a duration measured against the population is
([population and SQL shape](protocols/campaign-measured-defects.md#a-group-that-never-leaves-its-creation-epoch-keeps-collecting-invitations-prod-2026-08-30)).

### P2 - a re-admitted device calls its own exclusion window a loss, and reconciles for it (2026-08-26, widened 2026-08-30)

Not built: an ENTITLEMENT FLOOR per group at every entitlement START (re-admission AND a fresh device after
a revocation wipe), keyed on the stream position or a surfaced frame epoch. Confirm with GRP-8 AND
HEAL-REVOKE-5. Never read "no fingerprint repeats across runs" as "new messages"
([measurements and the discriminator](protocols/campaign-measured-defects.md#a-re-admitted-device-calls-its-own-exclusion-window-a-loss-2026-08-26),
[open-questions](open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add)).

### P2 - a device revoked while OFFLINE keeps its store until someone LOGS IN on it (2026-08-30)

Open decision: how long the residue (an id plus sealed key material) may sit. Both ways out are bad: an
unauthenticated revocation route is an enumeration oracle, a local expiry is a clock
([detail](protocols/campaign-measured-defects.md#a-device-revoked-while-offline-keeps-its-store-until-someone-logs-in-on-it-2026-08-30)).

### P1 - the cause of a REVOKED device's partial restore is not established

The wipe and tombstone halves are fixed ([auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it)); HEAL-REVOKE-1, -2, -3 are `PASS`. The shortfall report is built ([auth](frontend/modules/auth.md#a-restore-that-comes-back-partial-says-so-2026-10-08)). Open: which cause the user hit (a session-only row removal, `revokeRowSessions` failing, or the watchdog rebuilding the store) is separable only from the user's own history. Not worth code without a measurement.

## Mentions

Both owed to a product choice; the designs are on
[campaign-measured-defects](protocols/campaign-measured-defects.md#mentions).

- **P3 - a mention of a deleted account writes a browser-level 404 no client code can suppress (2026-09-08).** Owed to the USER: the server answers 200 with a tombstone, or the mention carries a name snapshot. Never an `ignoringExpectedLog` on the row.
- **P3 - a mention banner says "someone" where the NAME could be.** The hex is gone from every native composer; owed one look on an iPhone (compiled, never run). A name is a design choice (a device-side mirror like `graine_seeds.json`, or the first name from the server within the 4 KB APNs budget).

## The harness itself

Open findings about the instrument; the reasoning is on
[cross-client-harness-findings](cross-client-harness-findings.md).

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

Owed to the USER, one-off on the workstation: merge the directories or delete the decoy `names.mjs` (both hold credentials and Chrome profiles). The preflight prints `rig state: <STATE_DIR>` first ([table](cross-client-harness-findings.md#two-out-of-tree-directories-are-both-called-canari-harness-2026-09-04)).

## The graphical pass - every page at 100 % (user, 2026-09-13)

**EVERYTHING BUT REAL HARDWARE IS DONE** (the route sweep at 390, 1280 and 1920, the truncation defects and
census, the many-channels and long-name halves: [design-reference](frontend/design-reference.md) sections
16, 17, 19-21 and 39, stories in `CHANGELOG.md`). Left: the same measurements on real hardware, where all of
it was Chrome with a device-metrics override and three of three iOS defects were invisible to every gate
([device-verification](device-verification.md)). The instrument is `tools/cross-client-harness/sweep.mjs`;
CLAUDE.md queue item 16 carries it.

- **Suspended, not filed**: the "Nouvelle discussion" dialog showed no result list on A1 against `dev`, where the harness directory does not exist. One re-run against the LOCAL estate settles it ([detail](cross-client-harness-findings.md#the-2026-09-14-hardware-session-one-suspended-measurement)).
- **P2 - the wry bump that removes the abort** (found 2026-09-14 on A1): closed in this app by `webview_may_load`; the re-check is the move to tauri 2.12, which needs `wry ^0.57` AND `tao ^0.37`, so the vendored `tao 0.35` fork must be rebased by hand, then a deep link and `sweep.mjs --route /posts` on A1. A native work package owed hardware, not an unattended bump ([detail](cross-client-harness-findings.md#the-wry-bump-that-removes-the-abort-a1-2026-09-14)).

## Composer and reactions

### Emoji pictures - the campaign rows, which need real devices

The pictures replaced the font on 2026-09-25 ([emoji](frontend/emoji.md)). **Open:** the twelve rows of the second campaign, all needing real devices (the iPhone, where the font never drew, first) - they live in [emoji](frontend/emoji.md#what-a-future-campaign-owes---the-twelve-rows-moved-from-the-backlog-2026-10-08).

## Storage and retention

### P1 - the resume reload and the receive ratchet: fixed, owed one device reading; a SEND-side rewind is still unexplained (measured on the Mi 9T 2026-09-08)

Defects A (#435, `v0.16.6`) and B (#1527, the native reload refuses `live-ahead`) are shipped; mechanism in [mls-desync-prevention](protocols/mls-desync-prevention.md#the-resume-reload-re-installed-a-receive-ratchet-behind-the-live-one---the-2026-09-08-captures-mi-9t). **Owed on the Mi 9T:** (1) resume right after a received frame with no checkpoint between and read `[MLS][Tauri] Resume reload SKIPPED`; (2) re-measure the `E/` pair (a duplicate `recevoir_messages_batch` 83 ms apart) on a rebuilt APK (`adb logcat -v time` during NOTIF-7); (3) reproduce the 2026-09-06 SEND-side rewind from the phone. **Do not await the outbound checkpoint** ([why](protocols/mls-desync-prevention.md#the-checkpoint-window-and-the-per-document-snapshot-counter-moved-from-the-backlog-2026-10-08)).

### P2 - the notification QUICK ACTIONS exist only while the app is DEAD, so check K's backgrounded case is not performable (measured 2026-09-06)

The JS-side `sendNotification` path posts no reply/mark-read actions; only the Kotlin FCM service does. **Owed: a decision** - post through the Kotlin service or grow actions on the JS path ([mobile](frontend/mobile.md#notification-quick-actions-exist-only-while-the-app-is-dead-measured-on-the-mi-9t-2026-09-06)). Check K records `SKIPPED` until then.

### P1 - THE MINTING LOOP HAS NEVER BEEN OBSERVED ON THE HANDSET, AND A BLOB'S SIZE CANNOT SETTLE IT

Population, refuted causes and rules are on [key-package-pool](protocols/key-package-pool.md), the only copy. **Owed, in order:** (1) one CDP console read (not logcat) of the reload path across a background/resume on a real handset, looking for `[RESUME]` and the `publishedThisSession` refusal counter; (2) a device-side state census (groups, members, one-time bundles, last-resort); (3) the per-connection fallback reuse. The shipped guard closes the observed case, not the class: `publishedThisSession` is per-process, so a keystore emptied and then RESTARTED would run the loop again.

### P2 - NOTHING REPUBLISHES A LAST-RESORT PACKAGE'S EXPIRY, SO THE UNDATED ROWS DRAIN ONLY AS THEIR OWNERS UPGRADE (production, re-measured 2026-09-22)

Undated rows are exactly the clients below `0.18.10`, draining about 20 a day; both client repairs are REFUTED. Measurements and mechanism: [key-package-pool](protocols/key-package-pool.md). **Owed:** re-measure the undated count; only if it stops falling, decide on a server-side KeyPackage lifetime decoder in `chat-delivery-service` (which today never interprets MLS bytes).

### P2 - the MLS snapshot version is a PER-DOCUMENT counter compared ACROSS documents, so a second tab's write is dropped on a collision (measured on TAB-4, 2026-09-05)

Whether anything is lost is unmeasured; the state is expected to converge. **Owed:** a shared counter or a proof of convergence and its delay ([mls-desync-prevention](protocols/mls-desync-prevention.md#the-checkpoint-window-and-the-per-document-snapshot-counter-moved-from-the-backlog-2026-10-08)).

## Payments

Lydia ("Paiement Canari") and cash are the only payments since Stripe was removed (#1589, [stripe-archive](stripe-archive.md), which lists the names kept for rollback and old clients). `payment_provider` is `lydia | disabled`, default `disabled`; mechanism in [payments](frontend/modules/payments.md) and [core-service](services/core-service.md#payments-stripe--lydia).

### WP-LYDIA-1 - Lydia live in production, with one payment observed end to end

**Owed:** Master tests one homologation payment end to end on dev with a test account (payer e-mail prompt, callback included; not yet observed); production tokens and `LYDIA_ENV=production`; each association re-onboarding on Lydia (**an association with a Stripe-only payment account is no longer payment-ready until it does**); Lydia's still-open Livrable A answers ([plan](../../plans/stripe-to-lydia-migration.md)). The `business/create` `BUSINESS_VALIDATED` webhook is deliberately NOT built: no documented signature and `vendor_token` is public, so anyone could forge an association's onboarding state - ask Lydia whether it signs before building it.

### Owed to the user after the Stripe removal

Delete the GitHub secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUB_KEY` and the Stripe webhook endpoint; review the rewritten CGU and privacy text naming Lydia. Later, once the previous release is no longer a rollback target: drop the three Stripe columns and rename the permission with a data migration ([stripe-archive](stripe-archive.md#the-names-that-outlived-the-processor-kept-on-purpose)).

### A PAID PUBLIC FORM (user, 2026-09-30) - the paid half waits for Lydia

The free half is shipped (`/f/:id`, migration 068, [forms](frontend/modules/forms.md#a-public-form-is-answered-without-an-account-2026-09-30)). **Owed:** one guest answer sent from a private window on `dev.canari-emse.fr`, with the `canari-dev-frontend-1` log showing a real client address rather than the Docker gateway (the `real_ip` change it carries); the paid half is scoped on [forms](frontend/modules/forms.md#the-paid-half-what-it-needs-scoped-2026-09-30) and needs WP-LYDIA-1.

### P3 - an admin who never joined a private salon is not told when it is deleted

Not on the roster, so no `channel.deleted`; the sidebar keeps a stale row until the next load. **Do not widen the audience** (that is what leaked private-salon traffic to non-members); the shape that would work is a contentless `channel.gone` addressed to the community, worth doing only if the stale row is ever seen to matter.

### P2 - WP-RESTORE-1: Zero-Tap Sign-In restoration, required by Google Play from April 2027

The principle is accepted (user, 2026-08-26) and the work is scheduled AFTER the campaign; the Block Store exemption date of 30 September 2026 has passed and enforcement begins April 2027. It needs a WebAuthn server `core-service` does not have. Mechanism, the E2EE argument and the three traps: [mobile](frontend/mobile.md#wp-restore-1---zero-tap-sign-in-restoration-accepted-2026-08-26-scheduled-after-the-campaign).

## Tooling

### P2 - a cargo bump in `mls-core` leaves two committed lockfiles Dependabot will never fix

`mls-wasm` and `src-tauri` carry committed locks and depend on `mls-core` by path, so Dependabot's single pull request (against `mls-core/Cargo.toml`) is incomplete by construction and fails CI's lockfile step - the one dependency update that cannot merge unattended. **Remedy, not done:** one cargo workspace with ONE `Cargo.lock` for `frontend/`, which restructures a Tauri build this workstation can only compile. Until then such a bump is done by hand in one commit refreshing all three locks ([cicd](cicd.md#dependency-updates-and-the-auto-merge-that-ships-them)).

### P1 - ONE CLASS OF DEPENDENCY UPDATE STILL CANNOT MERGE UNATTENDED, AND IT NAMES ITS MISSING TEST

`webrtc` and the ICE crates are refused by `ci.yml`'s `Dependency ceiling` check: the SFU has ten tests and none touches the ICE stack. The test that retires it is one relay-path call (campaign rung 15 CALL, which has no runner), and the next version is a PORT onto the `rtc` crate (26 errors against this SFU, measured 2026-09-15), not a bump. See the SFU entry under "iOS, platform and runtime". Quote no refuse count: read `gh pr list --app dependabot`. **Recorded flake:** chat-delivery-service failed one test in one of five local runs on 2026-08-31 and was not reproduced; if it recurs, capture the suite name first. Do not widen the ceiling list to feel safe: name the failure, then the test that would have caught it.

### P3 - `submissions.formId` names a form nothing keeps, and 28 rows point at deleted ones

No foreign key (measured on prod 2026-08-31): 28 orphaned submissions over twelve missing forms, 5 of them `paid` (36,00 EUR). **Decision owed**, not "add a foreign key" (a cascade would delete paid submissions): a tombstoned form (soft delete) or a `formTitle` denormalised on the submission at write time.

### P3 - MiGallery's `resolve()` bypasses, and an inherited disable is the only reason nobody sees them

The Canari half is done; `../MiGallery/oxvelte.config.json` still disables `svelte/no-navigation-without-resolve` (16 call sites). Wrap them with the same `internalPath()` pattern, then delete the disable. Measure by MOVING the config file, never by dropping `--config`.

## Localisation

### P2 - NO REFUSAL CAN BE TOLD FROM ANOTHER, BECAUSE ONLY SOME ENDPOINTS CLASSIFY AT THE THROW

The English-on-a-French-screen sweep is finished ([durable-rules](durable-rules.md), [social-service](services/social-service.md)). **Owed:** a code at the THROW, per endpoint, most-used screens first, for the refusals a user can act on (model: `DEVICE_REVOKED`, `PARTNERSHIP_NO_CODES_LEFT`). One site cannot close alone: `sessionAuth.ts` compares against `MLS_LOCAL_STATE_UNDECRYPTABLE`, which collapses `sealed` and `unknown`; it closes with the damaged-MLS-state P1, and its allowlist entry in `serverProse.test.ts` fails the day the site stops offending.

## Infrastructure

### P2 - MIGALLERY'S ONLY OFFSITE STILL LANDS ON THE OLD CANARI VM

`mitv`'s `backup-offsite.sh` pushes the Immich dump (~2 GB/night) to `canari:~/migallery-offsite`. **Owed:** the user's decision on a destination off `mitv` on the private path, then a MiGallery PR, before the old VM can be wound down. User gestures: a real Sky sign-in with `/admin/legacy` showing the June data, and deleting the stopped `sky-sky-1` container with `/home/mitv/Sky/database` ([estate-migration](infrastructure/estate-migration.md)).

### P2 - A DEPLOY NO LONGER ERASES THE LOGS, BUT NO ARCHIVE HAS BEEN SEEN YET (merged 2026-10-08)

**Owed after the next deploy of each estate:** one `.log.gz` per container in `~/deploy-log-archive/<project>/` and `max-size` on a recreated container ([logging](infrastructure/logging.md)). Authentik's hand-run stack is bounded only when next recreated and is not archived.

### P3 - docker-prune is built for the Portail-etu host but not installed there

The host was `/` 88 % used on 2026-10-08. **Open:** the user or Master runs the one-off command in the [README](../../infrastructure/docker-prune/README.md#on-the-portail-etu-host-nothing-is-installed-yet), then a cron entry. Dangling VOLUMES are never pruned by a flag ([databases](infrastructure/databases.md#reaching-it-from-a-workstation)).

## What the duplicated group notice left behind (2026-09-16)

- **P2 - nothing repairs a notice already duplicated on a device.** Owed: the population first (on one real device, the count of `isSystem` rows sharing `(conversation, content)`). Only if large, a one-shot pass gated on proof of breakage with an allowlist of rows - never a heuristic collapse.
- **P2 - 13 full archive walks and 37 reconciliation answers in ten minutes, for one group.** Owed: from production logs (`[HISTORY]` carries `user=`/`device=` since 2026-09-16), walks per group per hour across the estate and the `after=start` fraction per DEVICE.

## Post-campaign projects - decided, not scheduled

- **The MLS + Graine guide for the user** shipped ([chiffrement-et-historique](../user-guide/chiffrement-et-historique.md), #1585). **Owed: the user's read**, and a re-check whenever retention, history rules or device limits change.
- **One MLS client in a SharedWorker** - decided 2026-08-17, after the campaign: [mls-wasm](frontend/mls-wasm.md#one-mls-client-in-a-sharedworker---decided-2026-08-17-not-scheduled).

### `dev.canari-emse.fr` - the two things that outlived the chantier

Environment and decisions: [dev-environment](infrastructure/dev-environment.md). **Owed to the user, nothing here can do it:** the mobile half - a dev Firebase project (the Play service account lacks `serviceusage.services.enable`), a dev keystore and where it is backed up, and a second package id so a pre-release can be measured against production (one item with "a second package id" above).

### A SECOND campaign, for everything that is not chat - asked 2026-08-16

Not started. Design, the named starting point (the `social` notification family) and the three things to settle first (venue, observer, what a verdict rests on): [cross-client-campaign](cross-client-campaign.md#the-second-campaign-for-everything-that-is-not-chat---asked-2026-08-16).

## THE DELIVERY CHAIN REVIEW - opened by the 2026-09-06 outage

**Open: a real sign-in against the deployed estate, in the pipeline, right after the dev deploy and before a stable proceeds.** The wasm check ships as a gate (2026-10-06, [cicd](cicd.md)) but is not a login. It needs a USER decision: a dedicated smoke account on both estates, its credentials as GitHub secrets, and accepting that a CI job holds a real login on production. The other items shipped or were decided not to be built ([cicd](cicd.md#two-incident-time-items-decided-not-to-be-built-2026-10-06)); any proposal must keep four visible workflows.

## The first iOS feedback (2026-09-20) - one reading and one measurement

- **One reading on the reporting iPhone**: the `/posts` and associations scroll on a build carrying the fix ([design-reference section 28](frontend/design-reference.md#28-every-scroll-in-the-app-ran-on-the-main-thread-for-a-gesture-ten-prefixes-cannot-perform)); the Mi 9T settles only Chromium.
- **P3 - one memory measurement on a long feed** (not virtualised; avatars deliberately not lazy). Measure before changing either.

## Audiences of associations, lists and institutions - built, on dev in `v1.2.0-alpha.1`

WP-A (#1582), WP-B (#1584), the star reading its audience (#1593), the nominative read grants WP-C (#1606) and their write-boundary fixes (#1608) are built. Decisions and as-built: [profiles-and-access](profiles-and-access.md#the-audiences-chantier---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08). **Owed:**

- **The on-device look** at the Audience tab, the profile campus prompt and the `/admin/read-access` grid.
- **Dev checks that were NOT TESTABLE, and no stable may ship the read grants until they run** (Master, 2026-10-08): all four dev sandbox accounts are ICM / saint-etienne and the campus is only an Authentik attribute (`attributes.profile`, read by `apps/core-service/src/users/miconnect-profile.ts`). Authentik is ONE instance for dev and prod, so even a read-only `ak shell` counts as production access and was denied. **User:** create an Authentik user `canari-test-epsilon` with campus gardanne (same groups and attributes shape as `canari-test-delta`, credentials into `F:/Programmation/canari-harness/test-accounts.json`, never on a command line) or allow a scoped permission rule for creating it. Then the agent verifies: a grantee sees the association posts of the granted campus and NO personal post, can react and comment, cannot vote nor republish through the grant, and a revoke restores the baseline; and a star's audience read, own campus versus another campus.
- **User decision:** let the directory be widened for grantees? (not widened now; only posts, comments, reactions and events are).
- **Ambiguity to answer:** what "an institution of another campus" means for a reader (the grant reaches it today).
- The document-reviewer rows were NOT moved into the grants table (a separate capability on the same page).

## Answers of 2026-10-07 that are not done

- **`minClientVersion` rises after 1.1.2, once both stores serve at least 1.0.3** - the user's gesture; G3 of Graine v2 waits for it.
- **Staff accounts labelled EMSE that are ME** (Aurelie Boyer, Celine Haton) get `posts=["ME"]` in Authentik BY THE USER, from a table Master hands over.
