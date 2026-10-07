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

### P3 - Stripe leaves the product: remove it, or archive it as documentation (user, 2026-10-07)

*"Stripe va disparaitre"* - the payments run on Lydia. Remove the Stripe code paths and secrets
(`apps/core-service`), or keep only an archived note of what they did; the dependency PR for Stripe 23
(#1495) is ignored meanwhile. Done when no Stripe package, secret or route remains, or the archive says so.

Already removed from the UI (forms PR, 2026-10-07): the form builder's selectable card with Stripe
wallet/Visa/Mastercard/Amex copy and its "Active" badge, `cardPaymentCopy`, the `form_card_*`
Paraglide keys; the builder now shows one "Paiement Canari" line and the member form says
"Paiement Canari" instead of "Carte / wallet". Still to do: the saved-card flow
(`supportsSavedCards`), the `stripe` wire value of `paymentMethod`, and everything backend.

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
  - **P3 - the composer's identity picker avatar keeps a stale accessible name after a user switch.** Signed in as delta, "Nouvelle publication" shows "Canari Test Delta" beside the avatar but the avatar's accessibility label reads "Avatar de Canari Test Gamma" (stable over two reads, seen in the WDA tree only; the picture shows initials "CT" for both). `PostIdentityPicker.svelte` hands `globalSession.userId` to `Avatar.svelte`, whose label comes from the display-name cache. Owed: read what `globalSession.userId` and the name cache hold right after a switch (the draft was keyed correctly, so the id is probably right and the cache stale).
  - **P3 - recovering a PIN on an iPhone 12 hides its only button.** The dev PIN of gamma no longer matched the harness file (it was reset during the alpha.4 pass), so the reset path was needed: "PIN oublie ?" TOGGLES an info box (a second tap closes it) and "Reinitialiser mon PIN" sits under the sticky "Deverrouiller" footer until the dialog is scrolled with a drag started on the keypad; a tap on the footer's coordinates hits "Deverrouiller" instead. The account was reset (sandbox), then the file PIN set again; the harness file now matches. No PIN prompt followed delta's or gamma's later sign-ins on this build (the chat list opened directly): owed a look at whether that is "Rester connecte" state or a skipped unlock.
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


### P3 - Canari's web login shows developer vocabulary and English store badges (measured on the Mi 9T, 2026-09-25)

Seen at `canari.emse.fr/login` on the Mi 9T, against the ecosystem checklist
([ecosystem-convergence](ecosystem-convergence.md#12-the-interface-bar---one-checklist-for-every-site-each-rule-tied-to-a-measurement-2026-09-25)):
"**Connexion externe (service-account)**" is shown to every user; the store badges are the English artwork
("Download on the App Store", "GET IT ON Google Play") though both stores publish French ones; and a
phone that HAS the app gets no "Ouvrir dans l'application". The signed-in web app was NOT audited:
a web sign-in registers an MLS device on the account, so it waits for the user to say which account.

**Decided by the user, 2026-09-25**: "Réinitialiser l'appareil" was a developer tool, removed from
the login page by #1097. "Connexion externe (service-account)" STAYS - the store reviewers sign in
through it - and its wording stays exactly as it is. The signed-in web app is NOT to be audited
here: Canari's interface is its own long-running work, and this entry was about the login page only.

**Still open, re-read 2026-10-06**: the English badge artwork, and no "Ouvrir dans l'application" on `/login`.


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
### P2 - A CHANGED PROFILE PHOTO IS STILL INVISIBLE FOR UP TO 24 h, AND ONLY `max-age` DECIDES THAT - THE SHAPE THAT MOVES IT IS THE OPEN DECISION (measured on production 2026-09-16, asked by the USER)

**There is no invalidation of any kind on an avatar, at any layer.** Canari does not own the photo -
it proxies MiGallery - so the only question is how fast a change there reaches a face here, and the
answer today is "when four independent timers happen to have run out".

| Layer | How long it holds | What invalidates it |
| --- | --- | --- |
| MiGallery (`gallery.mitv.fr`) | - | source of truth, changes at once |
| `AvatarService`'s in-process LRU (`IMAGE_TTL_MS`) | 1 h | nothing; TTL only, and **one copy per replica** |
| Cloudflare (the Cache Rule, deployed 2026-09-16) | 24 h | nothing |
| the browser's own HTTP cache | 24 h | nothing |

Measured live, `GET /api/users/<id>/avatar`:

```
Cache-Control: public, max-age=86400
etag: W/"3020-Bw+qPypeSB5uzDJv2iONFgFB+94"
Age: 855      cf-cache-status: HIT
```

**THE ETAG IN THAT RESPONSE IS NOT MiGALLERY'S, IT IS EXPRESS'S.** Nest lets Express compute a weak
ETag over whatever bytes go out; it can only ever produce a 304 AFTER the 24 h has elapsed, so it
says nothing about staleness.

**AND MiGALLERY HAD ALREADY SOLVED THIS.** `src/routes/api/users/[username]/avatar/+server.ts` in
the MiGallery repo keys an ETag on the ASSET ID - the thing that changes when the user changes their
photo - and answers accordingly:

```ts
const etag = `"${assetId}"`;
'Cache-Control': busted ? 'public, max-age=15552000, immutable' : 'no-cache'
```

It says *revalidate every time, and here is the version*. `AvatarService` now revalidates its 1 h entry with `If-None-Match` and the controller forwards MiGallery's ETag (landed 2026-09-16, [core-service](services/core-service.md#the-avatar-proxy)), but the controller still answers `Cache-Control: public, max-age=86400` (`users.controller.ts`) over an upstream `no-cache`, and `fetchUserAvatar` never passes `?v=`: a response the upstream marked as needing revalidation is republished by us as fresh for a day.

**THE RULE THIS BREAKS IS ALREADY WRITTEN IN THIS REPOSITORY**, in `userAvatarCache.ts`, by the pass
that deleted a Cache Storage bucket for the same reason: *a key naming a CONTENT may be cached for
ever; a key naming an IDENTITY may not.* `/api/users/<id>/avatar` names a person.

**THE FIX IS ENTIRELY INSIDE CANARI - MiGallery needs no change**, and what is left is the decision: stop claiming 24 h. **THIS IS THE WHOLE OF WHAT A USER SEES - the revalidation already landed did not shorten it by a second.** Two shapes, and they are not equivalent:
   - **`no-cache` + the real ETag**: correct, deterministic, and puts one conditional request per
     face per render back on the wire - the amplification this endpoint was fixed of, and the reason
     the edge rule exists.
   - **a busted URL**: the client asks `/api/users/<id>/avatar?v=<version>` and Canari may then
     answer `immutable`. A photo change changes the version, changes the URL, and all four layers
     invalidate at once with no revalidation traffic at all. **Its blocking condition is that the
     version must reach the client without fetching the avatar first** - today core-service learns
     the asset id only by downloading the image, which is circular. `/api/users/batch` is the
     natural carrier and MiGallery would have to expose the id cheaply, which is the one part that
     crosses a repository boundary. **MiGallery was read on 2026-09-16 and exposes
     `photos_asset_id` in exactly one place - `/api/users/[userId]/photo-access`, one call per
     person behind its own scope.** There is no batch carrier today, so the blocking condition
     stands.

     **AND THE OBVIOUS WAY ROUND IT IS REFUTED, NOT UNEXPLORED.** Core-service now holds the asset
     id after the first fetch, so `/api/users/batch` could carry it when the cache has it and omit
     it otherwise - self-priming rather than circular. It must not be built: that cache is **per
     replica**, so the same face would come back busted from one replica and unbusted from another,
     and the client would keep two cache entries for one photo and thrash between them. A version
     must come from somewhere shared and authoritative; an in-process LRU is not that.

**Do not ship part 3 without deciding which shape**, and do not lower the TTL as a compromise: a
smaller number is the same defect at a different rate, and it would still be a claim nobody can
honour.
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
  `[PushBG]` line is lost exactly where it is needed. A logger installed in `JNI_OnLoad` would take
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

Owed to the USER: a written decision of which refusal is intended, before any file is touched -
picking one guard as "the" guard silently changes what the other two refuse. The HMAC they share is
already one declared file (`internal-token.ts`).

| Where | Refuses on |
| --- | --- |
| `core-service/.../nginx-auth.guard.ts` | empty `x-user-id` |
| `social-service/.../nginx-auth.guard.ts` | empty `x-user-id`, and a 401 when `NODE_ENV` is UNSET |
| `chat-delivery-service/.../header-auth.guard.ts` | `x-user-logged-in !== 'true'` (logs a denial on `/push/` routes) |
| `chat-gateway/src/presence.rs` | empty `x-user-id` - Rust, stays where it is |

The same decision says whether `X-Internal-Token` is required OUTSIDE production too (today only
production asserts it). Not an access-rule question: presence about an arbitrary user id is parked
in `presence.rs`'s docblock.

### P2 (hardware-owed) - a FIRST message from someone you have no conversation with, measured end to end (user, 2026-09-08)

Both halves are fixed since `v0.18.18`; nothing has run them on a genuine first contact. Owed:

1. **Enrol a third account** (`canari-test-gamma` exists on Authentik, credentials out of tree): a
   first sign-in through the app (materialises the user row and its display name), a Chrome
   profile with its `PORTS` / `ORIGIN` / `ACCOUNT_OF` entries, and a third identity in `names.mjs`
   ([harness entry](#p2---the-rig-can-express-exactly-two-identities-and-the-third-and-fourth-accounts-now-exist-measured-2026-09-10)).
2. **One run**: A1 backgrounded and alive, the new peer starts a conversation and sends one message;
   read the shade, whether the tap lands, whether the conversation is in A1's list WITHOUT a
   restart, and `builtBy`. Then the same with an INVITATION into a community (the user's question
   of 2026-09-05), and once with A1 COLD, which collects the message from history.
3. **NOTIF-17b re-run on the `admits` route** (a device added while offline is a recipient of the
   next message).
4. **Unexamined: a first-contact Welcome exceeds the FCM data budget** - `[PUSH_SEND][welcome-send-4964245c]
   proto not inlined: 4608B over a 3716B budget`, so it travels without its payload inlined.

### P3 - three tap/reply rows owed against Android's single notification builder

Owed on the board, each stating its trigger (`builtBy` - a direct message is notified by the
WebSocket frame, a salon message by the FCM push, on the same backgrounded phone): NOTIF-6c (quick
reply, backgrounded, and its 2026-08-30 `403` fix), NOTIF-7c and NOTIF-7d (tap into a CHANNEL,
backgrounded and killed). Also settle whether NOTIF-11/-12 (`MessagingStyle` stacking) already
speak for the backgrounded path, which reaches the same builder.

## CI and the chain that runs unattended

### P3 - a PRE-RELEASE tag still races a merge between the head read and the tag (the stable half closed by #1367)

Gate 2 of `.github/scripts/release-preflight.sh` refuses an alpha whose sha `main` has moved past, and a rerun re-reads the SAME tag, so it cannot rescue one. A stable no longer has this problem: it ships the latest pre-release of its version on `release/vX.Y.Z` and the tag moves ([cicd](cicd.md)). **Open only if it recurs on an alpha**: let the gesture name "the release" and the machine take `main` HEAD, never a sha a human read seconds earlier - and never a rebase or a lenient gate 4, which are fallbacks.

### P3 - EVERY `.swift` IN THE iOS TREE IS UNGUARDED, AND NOTHING HAS MEASURED WHETHER A SUITE EVEN EXISTS

**The Android half of this closed on 2026-09-22** and is on
[mobile](frontend/mobile.md#the-android-half-of-it-is-one-function-compiled-twice-2026-09-22): the
ladder is one pure function in `fr.emse.canari.push`, a source directory of the app module AND of
the standalone JVM test project, so `PushDecryptLadderTest` drives the code the service runs. The
cost this entry feared - needing the app module, whose `tauri.settings.gradle` is gitignored and
whose `google-services.json` is a secret - did not arrive, because the shared package imports no
Android and a plain source directory carries it.

**iOS is untouched by that.** The same trap covers it - a test file nobody runs reads as coverage -
and nothing here has measured whether an equivalent suite even exists. **The Android answer is a
shape to copy, not a precedent to argue from**: what made it cheap was that the ladder needed no
platform, and whether any Swift here is in that position has not been looked at.

### P1 - production goes dark in the 22h band, and the only thing both boxes share is the School's firewall (measured 2026-09-11)

**The measurement, the drop pattern and the shared uplink are on
[cloudflare-edge](infrastructure/cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it),
the only copy.** In one line: every hostname on two zones, on two machines, returned 1033 for six
minutes; 175 `cloudflared` edge-dial timeouts in seven days, ALL in hours 22 and 23 CEST; the single
element both egress paths crossed is `fw-ste.emse.fr`, the School's Stormshield border firewall.

**Open since the 2026-09-24 cutover:** production left both boxes, the two netwatch witnesses stopped
themselves on 2026-09-12, and nothing records that their ledgers were read. Whether the Portail-etu
host sees the same 22h-23h drop is UNMEASURED: read `journalctl -u cloudflared` on
`portail-etu-direct` for 1033 and edge-dial timeouts at hours 22-23 over seven days, and ask the
School's network service what is scheduled on `fw-ste.emse.fr` only if it does.

**TWO HYPOTHESES ARE REFUTED AND MUST NOT BE RE-OPENED.** A Proxmox `vzdump` freezing the container
(both journals carried entries for every minute of the window; the ledger gap was the probe's own
`AbortSignal.timeout` - **a gap in a ledger is evidence about its WRITER before it is evidence about
the world**, [durable-rules](durable-rules.md)), and "the whole campus loses the network every
evening" (zero events on 09-05, 09-06 and 09-07).

**The egress half**: `UpstreamUnreachableError` and `OUTBOUND_BUDGET_MS` are shipped; whether such
stalls are CORRELATED is read from [`infrastructure/egress-probe/`](../../infrastructure/egress-probe/README.md),
armed in the `canari` crontab - the old VM since the cutover, which runs no container. **Re-arm it on
the Portail-etu host or retire it.**

### P3 - A MERGED BRANCH THAT IS STILL THERE WAS NOT LEFT BEHIND, IT WAS PUSHED BACK (measured 2026-09-22)

**THE CAUSE IS NO LONGER UNMEASURED, AND IT IS NOT GITHUB.** This row used to record one
occurrence - #341, 2026-09-03, whose branch was still present twelve minutes after a squash
auto-merge while #339 and #340 were already 404 - and said the cause was unknown. A second
specimen settles it.

On 2026-09-22 exactly ONE branch of a merged pull request was still on the remote out of **596
merges since that day**: `perf/le-blob-ne-traverse-plus-le-pont`, from #825. Its numbers say what
happened:

| | |
| --- | --- |
| #825 merged (squash, auto-merge) | 2026-09-17 19:09:28 Z |
| head the merge consumed | `9ff6d0755` |
| head the branch carries today | `4b4b5862b`, committed **2026-09-17 22:08 Z** |

Three hours AFTER the merge. **GitHub re-creates a branch when something pushes to it**, so nothing
failed to delete anything: the branch was deleted on merge and a workstation pushed it back. That
also explains #341 without a second theory - the row already records that `DELETE
/git/refs/heads/...` removed it with **no error and no refusal**, which is exactly what a
deleted-then-recreated branch looks like from the API.

**WHAT IT COSTS, AND IT IS NOT THE UNTIDINESS.** The commit pushed there was a CHANGELOG shortening
the USER had asked for that same evening. It never travelled to `main` on that branch - a pull
request that has already merged does not carry another commit - and it only reached `main` because
the same edit was made again later. **Work pushed to a merged branch is committed, pushed, and
unshipped, and nothing says so**: `git status` is clean, the push succeeds, and the branch exists.

**The prevention already exists and this is why it is there**: THE DEVELOPMENT CYCLE in `CLAUDE.md`
ends with `git branch -D`. A local branch kept past its merge is the only thing that can be pushed
back, which is the sentence that line was missing.
### P3 - TWO audit advisories are suppressed because they cannot be reached, and both should stop being

`GHSA-vcc3-ghjq-m6fr` (moderate, denial of service) covers every `decode-uri-component` at or below
0.4.2 and reaches media-service as `minio > query-string > decode-uri-component`. **It is ignored
for that one service only**, because nothing in the chain can move - minio 8.0.7 is the latest
release and pins `query-string: ^7.1.3`, which pins `decode-uri-component: ^0.2.2` - and because the
fixed 0.5.0 is ESM-only where `query-string@7` is CommonJS, so an override would fail at boot
instead of at audit. The reachability argument and the assertion that keeps it honest are in
`.github/workflows/code-analysis.yml`, which is the only copy.

`GHSA-528h-pc64-c93x` (moderate, denial of service) is the SECOND, added 2026-09-03 when it turned
every pull request red. It covers every `stream-json` at or below 3.4.0 - its `pick`/`ignore`/
`filter`/`replace` filters are O(depth^2) on nested input - and arrives as `minio > stream-json`.
Again nothing in the chain can move: minio 8.0.7 requires `stream-json: ^1.8.0` and the fix is
3.5.0, two majors outside it. It is unreachable twice over: minio imports exactly one thing from the
package (`stream-json/jsonl/Parser.js`, in its bucket-notification module) and NONE of the four
filters the advisory is about, and this service never calls that API at all - its whole use of the
client is `bucketExists`, `fPutObject`, `getObject`, `makeBucket`, `putObject`, `removeObject`.

**THIRD AND FOURTH, 2026-10-06:** `GHSA-hqr4-qq8f-hg3x` (JSONC parser/verifier re-scan, <= 3.5.0) and
`GHSA-mjw6-4jj6-33hc` (Assembler prototype pollution, < 3.6.0) on the same `minio > stream-json`
edge. The override to 3.x was refused: fixed stream-json is `type: module` with `src/` entry points
where minio's CJS build `require`s it, and nothing proves that boot. Both ride leg one, now an
ALLOWLIST (minio may import only `stream-json/jsonl/Parser.js`) in `.github/scripts/stream-json-premise.sh`,
self-tested by `tests/stream-json-premise.test.sh`. The retirement condition is unchanged, with 3.6.0 as the floor.

**What retires this row:** minio publishing a release that moves either pin - dropping
`query-string@7`, or requiring a `stream-json` at or above 3.5.0 - or `query-string` itself
depending on a `decode-uri-component` above 0.4.2. Any of those makes an ignore unnecessary, and it
should be deleted the same day, along with the premise assertion beside it. Until then the
assertions are what stop the suppressions outliving their reason: CI fails if minio ever parses a
query string, if the `stringify` call site the measurement was taken on disappears, if minio starts
importing a stream-json FILTER, or if this service starts calling the notification API.

**UPSTREAM RE-CHECKED 2026-10-06 AND NOTHING HAS MOVED** (previous checks 2026-09-24, 2026-09-22, 2026-09-15): `minio` is
still 8.0.7, published 2026-02-27, with `query-string: ^7.1.3` and `stream-json: ^1.8.0` unchanged.
Both suppressions are still correctly refused. Record the date of the next such check here rather
than re-deriving it - the registry answers in one request and the answer is the whole of this row.

**AND ONE OF THE THREE RETIREMENT CONDITIONS ABOVE IS ALREADY SPENT WITHOUT HELPING**, which is
worth writing down so a later reading does not chase it: `query-string` DOES now depend on a fixed
`decode-uri-component` - latest is 9.5.1 on `^0.5.0`. It changes nothing, because minio's pin is
`^7.1.3` and cannot reach a 9.x. **So only minio moving retires either suppression**, and the
third condition should be read as dead rather than pending.

---

### P2 - THREE hosts take security updates that nothing reports on, and a library nothing restarts (the rest closed 2026-09-03)

**The mechanism and the report both exist since 2026-09-03**, installed on the user's decision
(*"unattended-upgrades securite + rapport"*) across all four hosts: security origins only, nothing
reboots, and `.github/workflows/scheduled.yml` fails a daily run on any finding. The whole
write-up - the policy, the `#clear` that the file needs to not be decorative, the 30-second `502`
this scope does NOT incur and the evidence for that, and the two defects the report itself had - is
[host-updates](infrastructure/host-updates.md), the only copy.

**THREE THINGS STAY OPEN and they are smaller than what closed.**

1. **The report covered the old production origin and no other host - and production moved to the Portail-etu host on 2026-09-24.** First settle where `host-update-report.sh` (run by `scheduled.yml`) points now; the runner's key was authorised on none of the other three (measured 2026-09-03). So `mitv`, `cercle` and `miconnect` apply their security updates with
   nothing saying whether they still are - which is exactly the shape this row was opened about, one
   estate smaller. **Retired by** either a key for the runner on the other three (a privilege
   expansion, so the user's decision), or the Cloudflare Access service token already listed as
   optional in the dev-environment work, which would let an `ubuntu-latest` job reach all four the
   way a workstation does.
2. **`mitv`'s 7.3 TB RAID1 has a sensor and no report** (merged here from its own entry; the
   kernel reboot this item used to name was TAKEN on 2026-09-03 and is what found the array).
   `mdmonitor.service` had refused to start on every boot back to at least 9 June; it runs since
   2026-09-03, severity by event class, its alarm proved by a test event through the real path
   ([host-updates](infrastructure/host-updates.md#the-73-tb-raid1-nobody-was-watching-found-while-rebooting-for-the-kernel-2026-09-03),
   including why `MAILADDR` would have made it worse). **What stays open is the channel**: the events
   go to syslog, read by nobody - postfix and exim4 inactive, `monit` with no `set alert` and no
   `set mailserver` - so a failing disk is RECORDED and not REPORTED. **Retired by** `/proc/mdstat`
   read into the daily host report (a degraded array is the shape it already handles) PLUS item 1,
   the report reaching `mitv`. The two close together or not at all.
3. **A library security fix is installed, not in effect.** `unattended-upgrades` restarts no
   services, so an `openssl`/`libssl3t64` upgrade leaves every long-running process mapped to the
   old library until something restarts it. Nothing measures that. **Retired by** reading
   `needrestart -b` (or `/usr/lib/needrestart/`) into the same report - which turns a silent gap
   into a named finding without deciding to restart anything.

## iOS, platform and runtime - the residue that fits no other section

### P3 - a media object that is gone reads as a hard error unless one JSON file survived, and that file is known to be losable (found 2026-09-05)

`MediaService.download` answers `purged` - which the controller turns into a 410 and the client into
a calm *"media expired"* label - only when `media_metadata.json` still holds an entry with
`purgedAt` and `purgeReason === 'retention_expired'`. If the object is gone and that entry is not,
the answer is a 404, and `PostMedia` renders the red failure and writes `console.error`. The two are
the same event to the user.

**The metadata file is known to be losable, in this very service**: `downloadPublic` carries an
explicit *"metadata lost after a container restart"* fallback that backfills an entry from storage.
`download` has no equivalent, so the private path depends on a file the public path is written not
to trust.

**What is NOT known** is how often a 404 on this endpoint means "purged" rather than "never existed
here" - that is a measurement on production's media service, not a reading. **A predicate that named
the last incident is not the predicate that names the next one**, and this one has not been measured
on the population it would run on. Cheap and worth doing before deciding anything: count 404s and
410s on `/api/media/:id` over a week.


### P2 - iOS carries none of the window-layout work Android already has (user, 2026-08-28)

**Named by the user from real use on an iPhone**, and one of the three is already fixed. The Android
half of each of these took a measurement and a comment to get right (`MainActivity`,
[mobile](frontend/mobile.md#the-window-layout-the-keyboard-and-the-orientation-lock)); iOS inherited
none of it because `gen/apple` is a different generated project nothing compared against `gen/android`.

- **DONE 2026-08-28 - the keyboard.** WKWebView was never resized, so the shell was pinned to the
  visible height inside a full-height document and a keyboard-tall empty band opened below it.
  `CanariApplyKeyboardLayout` shrinks the WebView's frame; no web change was needed. Written up on
  [mobile](frontend/mobile.md#ios-shrinks-the-webview-and-that-is-the-same-decision-taken-twice).
- **OWED - an iPhone re-read of the bars.** The code half shipped (#1242, #1261, #1289; [android-ios-parity](frontend/android-ios-parity.md) 1.1, 1.3 and 1.4 are FIXED); what is owed is the user's look at the status bar and the home indicator on the iPhone, with the liquid-glass chrome ([backlog](#the-liquid-glass-conversation-chrome---decided-2026-09-30-wp-g1-then-wp-g2)).

**This closes by HARDWARE, one item at a time**, like every other iOS finding: three of three defects
so far were invisible to every gate here.

### P3 - nothing records which BUILD each device runs, though two mechanisms already carry it (2026-08-27)

Asked by the user while debugging the iOS session: is there one place naming the version of every
device? There is not, and the two pages that look like it are not it - `/admin/platform` WRITES
`minClientVersion` (a policy, not an observation) and `/admin/status` reads live presence out of the
gateway (no version at all). The question mattered immediately: every `Refresh refused` line from an
iPhone was ambiguous until the user stated by hand that all of them were on 0.14.5.

**Two mechanisms already receive the value.** `GET /users/me/announcement?clientVersion=` takes it from
every client on every launch and uses it only to decide an announcement's audience, then discards it;
and since 2026-08-27 `POST /auth/refresh?clientVersion=` carries it for the refusal log. Meanwhile
`push_token` already holds exactly one row per `(userId, deviceId)` with a `platform` and an
`updatedAt`. Recording the version against a device is therefore a column and a write, not a feature -
and it would have answered both this question and the iOS FCM one above without asking anybody.

Not done tonight because the cheap version is genuinely cheap and the useful version is a decision:
which table owns it, whether a web session counts as a device, and what a dashboard should show
(distribution by version, or the laggards below `minClientVersion`).

`key_package.deviceAppVersion` is written on every platform since #613 (2026-09-14: the web and the iOS native path used to leave it NULL); devices enrolled before it re-report only when they next publish a key package. It is the column `minClientVersion` decisions must be measured against ([durable-rules](durable-rules.md#release-and-ci---cicd)).

### P3 - the native refresh credential could live in the platform keychain, on BOTH platforms (2026-08-27)

**Not a defect - a strict improvement, deliberately not bundled with the fix that needed shipping.**
Today the credential sits in a file inside the app sandbox: the Chromium cookie file on Android, a
`@tauri-apps/plugin-store` file on `tauri://localhost` ([sessions](sessions.md#the-credential-a-client-carries-itself)).
Both are protected by the OS at the container level and neither is encrypted as a secret. The
platforms both offer better - iOS Keychain, Android Keystore / `EncryptedSharedPreferences` - and the
same argument applies to each, which is why this is one item and not two.

**What blocks it from being trivial:** `patches/tauri-plugin-keystore` already reaches the iOS keychain,
but its `ios/Sources/CustomTabsPlugin`-style path builds `SecAccessControlCreateWithFlags` with
BIOMETRIC flags, because it guards the MLS device key - reading it raises Face ID, which cannot sit in
front of every cold start. So this needs a second, non-biometric command in the vendored plugin
(`kSecAttrAccessibleAfterFirstUnlock`), Kotlin parity so the Android build still links, a permission
entry, and an iOS build to verify - none of it measurable from this machine.

**Do not start it as a security fix.** The current posture is the one Android has had all along and
which the user has accepted; this is an upgrade to both, worth doing when native work is being done
anyway rather than as an emergency.

### P3 - the last node runtime: four jest suites that will not run under bun (decided 2026-08-27, AFTER the campaign)

**Scheduled, not parked, and the decision behind it is the user's** (2026-08-27): npm leaves now,
node leaves later. npm is already gone - `node --run test` replaced the one `npm test` in
`ci.yml` and the one `bun run test` in the Makefile's `test-history`, so nothing in this repository
invokes a package manager other than bun. What survives is the node RUNTIME, in three places:
`actions/setup-node` twice in `ci.yml` (once for the backend suites, once for the harness
self-tests) and once in `code-analysis.yml`.

**The measured blocker, and it is one file.**
`apps/chat-delivery-service/src/controllers/admin-storage.controller.mls.spec.ts` passes 8/8 under
node and fails under the bun runtime. That single spec is why CI installs, lints and builds with bun
but TESTS with node, and both call sites say so in a comment. **Do not collapse the two runtimes
without re-running that spec** - the note has been in `CLAUDE.md` since the bun migration and it is
the only thing standing between a green pipeline and a silently weaker one.

**What the work actually is.** Porting four NestJS services from jest to `bun test`: `jest.fn()` and
`jest.spyOn` to bun's `mock`/`spyOn`, `ts-jest` (which TypeScript 7 already could not load - see
[ecosystem-convergence](ecosystem-convergence.md) section 9), the `moduleNameMapper`, and the
`@nestjs/testing` module fixtures. It is days, not hours, and it touches suites that guard MLS
storage - the wrong place to discover a mock that silently stopped asserting.

**Sequencing, and why it is not now.** The campaign is running and prod is the test server. A test
framework migration changes what "green" means for every rung still to be taken, so it waits until
the ladder reaches the bottom. Until then the honest description of this repo is: **bun is the
package manager and the runtime everywhere except one test invocation, which runs on node on
purpose, for a reason that has been measured.**

### P3 (blocked: calls held off) - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27)

**RE-RATED P1 -> P3 on 2026-10-01**: `CALLS_ENABLED = false` since 2026-09-01 (`CLAUDE.md` queue
item 18), so no user can reach this code; it becomes P1 again the day calling is revived, and the
one relay-path call below is the revival's gate.

**This is not a bug report. It is the absence of one, which is worse.** `apps/call-service` was
brought back to compiling on 2026-08-27 after two Dependabot majors had merged onto `main` through a
CI hole (story in `CHANGELOG.md`; the hole itself is closed - the crate is in the Rust matrix now).
The bumps were `webrtc` 0.11 -> 0.17 and `axum` 0.7 -> 0.8. **What is verified is that it builds,
that clippy is clean under `--all-features`, and that its ten unit tests pass. Not one of those runs
the ICE stack, and not one of them places a call.** The repository's own rule names exactly this
distance: a green gate is not a working system.

**Six majors of webrtc-rs is not a version bump, it is a different library.** One behaviour change is
already known because it caused a compile error: `RTCIceServer::credential_type` is gone, and the
rule it carried moved inside the crate - `RTCIceServer::urls()` now returns `ErrNoTurnCredentials`
for a `turn:`/`turns:` URL whose username or credential is empty, where 0.11 accepted the same input
with an `Unspecified` credential type. A misconfigured TURN entry therefore used to degrade quietly
and now fails the WHOLE ICE configuration for that peer connection. `build_rtc_ice_server` warns and
names the offending server, which is the only thing that can be done from here without a call.

That one surfaced because it broke the build. **The ones that did not break the build are the reason
this entry exists**, and they cannot be enumerated by reading a diff - between 0.11 and 0.17 the
crate reworked ICE gathering, DTLS and the RTP/RTCP interceptor chain, none of which this crate's
types force it to acknowledge.

**AND THE NEXT BUMP IS A PORT, NOT A BUMP - MEASURED 2026-09-15**: `webrtc` 0.20 is webrtc-rs re-founded over the Sans-I/O `rtc` crate, 26 errors with the imports not even resolving; the port table is on [calls](frontend/modules/calls.md#the-webrtc-020-port-measured-2026-09-15). The refusal text in `.github/scripts/lib/ceiling.sh` says so.

**What settles it is one call, and only one call.** Two peers, audio and video, over the SFU, with
TURN configured as production configures it - the relay path specifically, because that is the path
the `ErrNoTurnCredentials` change sits on and the path a STUN-only test never touches. Watch for: the
peer connection reaching `connected` at all; the terminal ICE line the crate already logs; whether
renegotiation still lands (`main.rs` has a renegotiation path that no test covers either).

**AND IT IS TAKEN BY HAND, WITH NO CALL RUNNER WRITTEN** (decided 2026-09-06). This is rung 15 of
the ladder, CALL, one of the three phases with no runner - and building one is not what the single
call above needs. `CALLS_ENABLED` is flipped in the LOCAL tree only and put back; the five switches
that move together at a real revival stay untouched. **The twenty CALL rows stay NEVER RUN,
deliberately**, the user's ranking being unchanged since 2026-09-01 (*"les appels video et audio ne
sont pas la priorite"*) - so the campaign cannot be called finished, which is an honest state rather
than a gap. Until the call is placed, calls are UNVERIFIED on this build, not broken: nothing
observed them failing, because nothing observed them at all.

**What is still owed is unchanged, and now has a name to flip.** One relay-path call, two peers, audio and video, with TURN as production configures it - prod HAS it configured and has never once used it. The revival is one commit (`CALLS_ENABLED = false` is held off since 2026-09-01, [calls](frontend/modules/calls.md)).

### P2 - what made the profile fetches fail on that device at that moment

**What is owed is the DENOMINATOR, and it is a measurement rather than a change.** The log line that
makes it countable did not exist when the symptom was seen - twice on 2026-08-16, on both platforms,
nine of ten sidebar rows carrying "Utilisateur inconnu" for twenty seconds. Do not assume it is the
same fault as the avatar endpoint, and do not assume it is not.

The denominator rides on the accusation since 2026-08-19: every warn in `displayName.ts` ends `(failed/attempted lookups failed this session, X%)`, counting only lookups that reached the network.

**Where the number will come from:** the campaign run logs, on both platforms. Nothing here is sent
anywhere - there is no client telemetry and this did not add any - so the rate is read from a device
or a browser console during a run, which is exactly where the symptom was seen. Server-side is not
an option: `GET /api/users/:id` is not request-logged, and a client that never reached the network
would not appear there anyway.

**Then decide about `FAILURE_BACKOFF_MS`.** A high rate argues the two-minute suppression is doing
real work against a refusing server; a rate near zero argues it is a clock hiding a name for two
minutes over a blip that the reconnection listener already handles.

---

## Communities and permissions

### P2 - a bundle of pure DECLINES still goes out as transport, and a dropped decline strands a requester

**What is left is the same shape, smaller, and has never been observed.** A bundle of PURE DECLINES
still goes out as transport, deliberately: it carries no key material and restates a fact the requester
could derive. But a dropped decline strands a requester exactly as permanently as a dropped seed did -
it is the fact that sends them to the NEXT member, and nothing re-asks.

**Why it is not fixed with the other half.** It needs the ability to deliver a frame to a device that
presence reports offline WITHOUT appending it to the group's log - the fourth combination `DELIVERY`
does not have (`silent` and `durable` were one boolean until 2026-08-12, and `durable` still gates both
the presence filter and the history append server-side). Splitting them is a wire-level change, so it
waits for a measurement that needs it rather than being guessed at now.

## Messaging convergence

### P1 - the repair of a rewound sender lands on a coin flip, the ask cadence is identical either way, and a peer 21 messages behind was told "same state - nothing to do" (measured 2026-09-08, ten runs across three builds)

**THE ROW IS HEAL-repair, AND ITS `PASS` OF 2026-09-06 WAS ONE DRAW OF A THREE-SIDED COIN** (ten runs across three builds, 2026-09-08). Two candidate causes were refuted by A/B and are not to be re-opened without new evidence ([durable-rules](durable-rules.md)).

**WHAT ACTUALLY SEPARATES A HEALED RUN FROM A PARTIAL ONE, and it is not the asking.** The cadence is
identical in both: three asks, about 33 s apart, `escalated: true` every time. The difference is
whether any one of them is ANSWERED.

    healed    01:44:32  asked ... whether we hold the same history     <- nothing comes back
              01:45:06  asked ...                                     <- nothing comes back
              01:45:39  asked ...
              01:45:40  [HISTORY_BUNDLE] 18 messages received         <- 172 ms later

    partial   01:48:53  asked ...
              01:49:27  asked ...
              01:50:00  [HISTORY_REQ] same state as <W1> - nothing to do
              01:50:00  asked ...                                     <- no bundle, ever

Every PARTIAL run contains ZERO `[HISTORY_BUNDLE]` lines. Every HEALED run contains exactly one, and
it answers the LAST ask rather than the first.

**AND THE FIRST LEG HAS BEEN WRONG AT LEAST ONCE, WHICH IS THE HARDEST FACT HERE.** On the healed run
of 01:07:

    01:07:46.524  [HISTORY_REQ] 2bd5add9... same state as <W1> (287cc8e5...) - nothing to do
    01:07:46.689  [HISTORY_DIGEST] Sent for 2bd5add9... - ids mode, 837 id(s), asking from 2026-06-10
    01:07:46.791  [HISTORY_BUNDLE] 21 messages received for 2bd5add9... from f7a9bb80

The state-key leg answered *we hold the same history* and a digest found **21 missing messages 267 ms
later**. Both keys are computed over the ASKER'S window (`historyStateKeyFor(groupId, probe.since)`),
so this is not two devices measuring different spans. The stale-cache explanation is already
excluded: `invalidateHistoryStateKey` is called on every write path of BOTH backends
(`indexeddb.ts`, `sqlite.ts`). What is NOT excluded, and is where to look first, is the window -
`historyRangeStartFor` - and whether an empty or clipped span makes two different stores hash alike.

**THE SAME DEFECT IS WHY TAB-3b IS `PASS-DIRTY`, and that is how long it has been standing.** W1
reports the *same two frames* on reload after reload - r2, r3, r4, r5 of one run - as `[History]
frame never read here and unreadable for good (secret-reuse); will reconcile`, group `2bd5add9`,
frames `7e:4yhgc8` and `5p:1s1iuic`. The reconciliation is promised four times and never happens. A
row that stays dirty across reloads is not noise: it is this P1, seen from a check that was not
looking for it.

**THE DIRECTION, AND IT IS ALREADY WRITTEN DOWN.** [durable-rules](durable-rules.md) says of this
exact handshake that *a deadline is not a termination proof* and *a leg that needs no remembered
state to answer must not require a live waiter to answer it*. An answer that arrives only when the
responder happens to be idle is the live waiter, and three asks 33 s apart is the deadline. Neither
half is fixed by asking more often, which removing the 30 s coalescing window proved by trying.

**ROOT CAUSE, FOUND 2026-09-08 AFTER THE ABOVE, AND IT IS ARITHMETIC.** The server elects a RANDOM
online member. Over the A/B window the twenty history requests were routed:

    10  ->  mtnci3lc-7mhd   (W3 - same user as W1, real and active, 5 groups, seen the same day)
     7  ->  mtry8bhy-u3tl   (W1 - the ONLY device that holds the messages)
     3  ->  mtmp9dha-9nia   (W2 - these are W1's own asks)

**Half the asks go to a member that cannot help, and the run heals only when one draws W1.** Three
candidate responders, one holder: `P(draw the holder)` is about a third, and the row heals three
times in ten. The stale-device theory is dead - `bun devices.mjs` shows W3 idle `0d` with five
groups, so it is a legitimate member, not a ghost in Redis. It cannot help for a good reason: the
rewind is on W1's SENDER ratchet, so every receiver fails those frames identically, and W3 is
missing exactly what W2 is missing.

**AND THE WALK TERMINATES ON A FALSE PROOF, at a line that says so itself.** `actions.ts`, the state
leg: when `ourKey === probe.key` the responder logs `same state - nothing to do` and answers with its
COVERAGE. Coverage that is adequate is signalled by SILENCE - *"a member whose coverage turns out to
be adequate simply says nothing"* - so the asker reads *we agree, and this member is complete* and
stops. Both halves are individually right: W2 and W3 really do hold the same messages, and W3's
coverage really does span the window. The defect is the INFERENCE. The comment above that branch
already says **AGREEMENT IS NOT COMPLETENESS** and then addresses only the window case - two peers
missing the years below - never the case measured here, where two peers agree while a THIRD member
holds what both lack.

**What makes this fixable rather than philosophical: the asker holds POSITIVE PROOF it is
incomplete** - frames it has and cannot read - which is the same evidence `escalateReconciliation` is
already gated on. So the rule is *a peer's agreement is not a termination while this device holds
frames it cannot read; it is a reason to EXCLUDE that peer and elect another*. That drives the
exclusion walk from an ANSWER rather than from an absence, which is the only safe form of it - the
2026-09-08 attempt that drove it from an absence excluded W1 two hundred milliseconds after electing
it (see [durable-rules](durable-rules.md)).

**NOT ATTEMPTED IN THIS SESSION, DELIBERATELY.** The three previous attempts to carry "this group is
incomplete" across an exchange were all wrong in subtle and different ways - a durable marker read as
"have I already asked", a coalescing clock, an absence read as silence - and each was measured wrong
only after shipping. This one needs its state specified before it is built: WHAT is remembered, for
HOW LONG, and WHAT discharges it, with the discharge being the repair landing rather than any peer
saying anything.


### P3 - the pull and the socket hand the SAME row in, and the queue notices afterwards instead of the overlap not existing (measured 2026-09-08)

**SEEN ON THE PHONE FOR THE FIRST TIME, 2026-09-08, AND IT IS WORSE THERE.** NOTIF-7 (backgrounded,
push, tap, foreground) left six `severe` lines on A1: two frames at ONE epoch - group 2bd5add9,
`msg_epoch=196 group_epoch=196`, generations 7 and 8 - each refused with
`Ciphertext generation out of bounds` / `SecretReuseError` and
`MLS decryption failed at exactly its own epoch, so no redelivery can help`.

A same-epoch `SecretReuseError` means the generation was ALREADY CONSUMED, so these are duplicates
and not losses - which the row's own count confirms: it displayed exactly one message and passed
every assertion it makes.

**The asymmetry is the point.** On the web the same overlap is caught by the queue and files
`[QUEUE] delivery ... arrived twice`, a notice. On the phone nothing catches it and it reaches
openmls, which reports at ERROR - so the same defect costs a `PASS-DIRTY` on the web and SIX SEVERE
LINES on a handset, in a log a user's crash reporter would carry. It is one more reason the overlap
has to stop existing rather than be reconciled afterwards.

**RE-MEASURED ON `00a86a1a8`, 2026-09-23, AND IT IS STILL THERE - TWO SEVERE LINES WHERE THERE WERE
SIX.** The same row (NOTIF-7b, killed mode), the same shape: one epoch, `msg_epoch=2 group_epoch=2`,
`SecretReuseError`, 21 ms apart, on a run that PASSED its own assertions. So the count moved and the
mechanism did not, which is what this entry predicts - the overlap is still reconciled after the
fact rather than absent, and a handset still pays for it at ERROR. Nothing here is closed by that
reading; it dates the entry against current code so the next session does not re-derive it.

**RE-READ 2026-10-06 AFTER NOTIF-10 WENT `FAIL` ON THE MI 9T (2026-10-05, TWICE, `7ab8f1780`) - THE
ENTRY BELOW IS WRONG ABOUT WHO CONSUMES THE GENERATION, AND THE BANNER HAS ITS OWN MECHANISM.**
Read from code and from the two `results.ndjson` records; no phone touched.

1. **The push path does NOT consume anything durably.** `background.rs`
   (`decrypt_push_message_with_key`, header "These never persist `mls.bin`") loads the state, decrypts
   in memory and discards the manager; only the outbox batch and the Welcome paths call
   `save_encrypted_with_key`. So the 2026-09-08 sentence *"the FCM service writes the advanced state
   back"* is not what the code does. A push decrypt answering `SecretReuse` was refused because ANOTHER
   ENGINE persisted that generation first: the JS/WebView engine (socket drain, catch-up pull) or the
   `MlsBackgroundWorker`. The two consumers are still different layers, which is the entry's point; the
   consumer is just not the Kotlin service.
2. **The banner is a straight line, not a leak.** `RefusedForGood` (`mls-refused-for-good`, kind
   `SecretReuse`) on a VISIBLE push skips the ladder and the worker (#1394) but still falls through
   `decrypted == null` in `handleMlsFrame` to `buildFallbackText` -> `Fallback notification: Nouveau
   message de <sender>` -> `showMessageNotification`. Nothing posted earlier is replaced: the generic
   line IS the notification. It is suppressed only when `MainActivity.isInForeground` is true at post
   time.
3. **NOTIF-10, 2026-10-05, both runs, same shape**: FOUR pushes refused `SecretReuse` at one epoch
   (`msg_epoch=group_epoch=20`, then 26), 0.5-1.4 s apart, four `Fallback notification` lines, and ONLY
   the last ends in `showMessageNotification: app in foreground -> suppressed`. So three generic
   banners were posted while `isInForeground` was false and one was suppressed after it flipped - the
   same "three nameless banners" the 2026-09-23 run saw. 5 of 5 markers still arrive (the JS engine
   holds all five), which is why the verdict is a banner and not a loss.
4. **DECIDED AND IMPLEMENTED 2026-10-06: DESIGN (b).** The Mi 9T logcat (`mi9t-notif10-logcat.txt`) is case (i): the JS engine's `[QUEUE] Processing` at 19:46:17.46 came ~1.4 s before the first push `SecretReuse` refusal (18.892), no `onResume` between, no `MlsBackgroundWorker` line - and the JS engine DOES post a real banner (`notifyMessageFromWebSocket`, 18.970), 56 ms BEFORE the push's generic line (19.026), which is why the shade showed both. Kotlin-side only: `push/GenericBannerLedger.kt` pairs the two in either order (see [mobile](frontend/mobile.md)). **OWED: one on-device NOTIF-10 re-read by the lead** (the batched-banner half, `covers`, was added after the 2026-10-06 `messages=5` reading) (the service itself cannot be compiled outside the Tauri Android project; the ledger is JVM-tested).

**WHAT THE 2026-09-08 READING GOT WRONG, AND WHAT SURVIVES IT.** It followed one frame from `CanariFCM tryDecrypt` (generation 117 consumed, the notification shown) to the pull offering the same two rows 10 s later and `SecretReuseError` on generation 117, and concluded that the Kotlin handler consumes the generation durably and never acknowledges. The code read of 2026-10-06 above refutes the first half (a push decrypt persists nothing), so the fix it proposed - acknowledge the row at the cache write, or make the foreground consult the FCM cache by `messageId` + `groupId` - is WITHDRAWN now that item 4 names the consumer (the JS engine). **What survives:** the frames ARE the same ids end to end (`queuedMessageId` in `CanariFCM` is `qId` in `[QUEUE]`); `BaseMlsService.deliveries` cannot see a consumer in another layer; and `read_and_clear_fcm_cache` clears BEFORE the JS has persisted anything, so a crash between that clear and `saveMessage` loses the plaintext for good - a window to close on its own (read, persist, THEN clear), never by retrying or suppressing the log line (*a fallback is a signal, never a path*).

**What is seen.** One line on W3, on every HEAL-NEW run that has a fresh device pulling while a
socket is already live:

    [QUEUE] delivery 32db7fea... arrived twice - the pull listed a row the socket had already
    handed in and this device has not drained yet - the ordinary crossing, and nothing is wrong;
    not decrypting it again. Further ones of this shape are counted, not printed.

**Why it is filed rather than declared expected.** Nothing is lost and nothing is decrypted twice -
the line is the app correctly recognising its own duplicate. But it is the visible end of two
delivery paths overlapping BY CONSTRUCTION, and *a race that heals cleanly is still a defect*: the
reconciliation after the fact is a witness, not a fix. Declaring it `ignoringExpectedLog` on the
rows that meet it would demote a real overlap to keep a cell green, which is the one disposition
[durable-rules](durable-rules.md) refuses. So HEAL-NEW-2 stays `PASS-DIRTY` until the overlap goes.

**The direction, and it is small.** The duplicate is caught at the DRAIN, by a queue that already
holds the row the socket handed in. The pull that lists it again could ask that same question one
step earlier - a row already queued for this device is not a row to queue - which deletes the
crossing rather than absorbing it. Both halves are in-memory and in the same module, so this is a
membership test, not a new ledger.

**What is owed before the change.** The RATE, against the population: this is currently known from
one row on one client shape. `notableCount` on the same record was 91, so the counted-not-printed
tail is where the real number is. Measure it before believing the shape is as narrow as it looks.


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

Each entry is independent and carries its own measurement. Order inside this section is
chronological rather than by severity - the queue in `CLAUDE.md` carries the priority.

### P3 - the read-receipt half of the visibility fix is unit-tested and OWED a hardware pass, and the probe that would give it needs a different precondition (2026-09-05)

The notification half was verified on the device (shade carries the decrypted text 2 218 ms after
the send, LIFE-2 `FAIL` -> `PASS`). **The read-watermark half was not**, and it is the same one-term
guard reading the same `isAppInForeground()` whose value WAS measured flipping correctly on hardware
(`{"foreground":false}` backgrounded, `true` in front) - so the residual risk is that the watermark
path behaves differently, not that the fact is wrong.

**Two instrument problems stopped the probe, and both are worth having written down.**

**`openConversation` CANNOT BE A PRECONDITION ON A PHONE THAT IS ALREADY IN THE CONVERSATION.** It
waits for the peer's row in the SIDEBAR, and on a mobile layout the list and the conversation are
different screens - so it reported `listedEntries: 0` for three and a half minutes about a client
sitting inside the very DM it wanted. A screenshot settled it in one look: the app was in the
conversation, showing every probe message including the one the probe thought had gone nowhere. **It
was one step from being filed as "the phone's sidebar comes back empty after a reinstall"**, against
an app doing exactly the right thing. The rig's own rule - LOOK AT THE SCREEN when something does
not work - is what caught it.

**And a raw `/api/mls/send` count is the wrong observable.** The watermark is an MLS control frame
among other control frames, so the count cannot name it; and the probe's own positive control came
back ZERO in the foreground, where a watermark IS owed, which correctly made the whole run
`INCONCLUSIVE` rather than a pass. Whether that zero is "already at its target" (`if (target <=
held) return`), a watermark sent before the observer attached, or a path this probe does not see, is
not established.

**What a real row needs**: the peer's view, not the sender's traffic. W2 holds the read state for
its own message, and that is the fact a user cares about - `A1 read it` appearing for a message
nobody looked at. That is one DOM read on W2 against a marker, and it is falsifiable in both
directions without counting anything.

### P2 - the Android background/resume sequence hangs on a visibility edge that never fires (owed ONE device run)

A backgrounded Android WebView stays `visible` ([durable-rules](durable-rules.md)). The cheap sites
now also take the native edge (`onAppForegroundChange`): the MLS persister flushes on backgrounding,
the Tauri socket reconnects on return, the login page resets on return. **What is left must move
TOGETHER and only after one run on a phone**, because the pieces depend on each other:

- `ChatBackgroundService.svelte` `handleVisibilityChange`: on hidden it pauses the socket, flushes
  and releases the native foreground guard (`pause_mls_foreground`); on visible it reloads `mls.bin`
  into the warm engine before anything processes. On Android neither half runs today.
- `createPausableInterval` drives the `mls_foreground_heartbeat` that keeps that guard alive.
  Pausing it on the native edge ALONE would let the guard expire while the resume reload above
  still never runs - a warm engine overwriting a background engine's advance (`SecretReuseError`).
  It also drives the presence poll, so that battery cost waits on the same change.
- the visibility guards in `frontend/src/lib/components/layout/ChatBackgroundService.svelte` and `MainChatPage.svelte`, and the version check on return in `routes/+layout.svelte`.

**The run that settles it**: on the Mi 9T, background the app with the WebSocket up, wait past the
guard's 30 s, send it a message, bring it back - and read whether the background engine delivered,
whether the warm engine reloaded, and whether the socket paused. Switching the sequence to the
native edge also changes how a backgrounded phone is notified (socket paused -> FCM), which is the
behaviour the 2026-09-05 notification fix rests on.

### P2 - a cold start re-accuses frames it already read, because the ratchet advance is durable and its mark is not (TAB-3b `PASS-DIRTY`, measured 2026-09-08)

**What shipped is not repeated here.** The two silent decrypt paths that spent a generation without
recording it (`noteFrameConsumed`, asserted by `historyFrameConsumptionSeam.test.ts`), the
checkpoint-bound replay marks (`commitPendingHistoryMarks`) and the ack barrier that removed the
drain/refetch duplicate (`announceAck` / `ackInFlight`) are all in `CHANGELOG.md`; the duplicate
delivery that remains is its own entry, *the pull and the socket hand the SAME row in*. The run-by-run
evidence is on the TAB-3b row of [cross-client-testing](cross-client-testing.md).

**What is left, measured 2026-09-08 with the cap and hydration both exonerated (`seenset.mjs`).**
Each TAB-3b cold start still prints `[History] frame never read here and unreadable for good
(secret-reuse)` for frames the device already decrypted, re-accuses every earlier one (the set grows
by three generations per start, so the cost is QUADRATIC in cold starts), and fires a full
`[HISTORY_RECONCILE]` each time. The accused fingerprints are ABSENT from every ledger on the client
- never written, not written and lost - while the frame no longer decrypts (`SecretReuseError` at its
own epoch). **So the advance IS durable and the mark is NOT.**

**THE FIX IS ATOMICITY, NOT ORDERING, AND NO SMALLER FIX SHOULD BE ATTEMPTED.** Writing the mark
eagerly is right for a ROW key (*"I walked this row"* has no ratchet to run ahead of) and the
OPPOSITE defect for a FINGERPRINT: one written before its advance is durable tells the next replay to
SKIP a frame nobody read - a silent real loss, strictly worse than a false accusation. The mark and
the advance are one fact and must be one write: the mark belongs INSIDE the checkpoint, or *"have I
already consumed this ciphertext"* should be answered FROM the MLS state rather than from a parallel
ledger that can disagree with it.

**Still unmeasured**: which path spends the generations - live delivery, the queue drain, or the
archive replay's own successful pages. A console tailer cannot answer it (the row destroys the CDP
target it would attach to); it needs a purpose-built reproduction that brings W1 down between a known
send and a known decrypt.

**Two growth hazards the same read surfaced:**

1. **The 5 000 cap is shared by two namespaces and the wrong one is winning.** Fingerprints (*"I
   consumed this generation"*) and message ids (*"I walked this row"*) go into one array and
   `saveSeenCipherHashes` keeps the LAST 5 000 - on the busiest conversation 2 762 message ids crowd
   out 2 073 fingerprints, so the first thing evicted is the mark whose loss produces the accusation.
2. **The cap is PER GROUP and nothing bounds the number of groups** - 169 ledgers, 247 kB on W1; at
   the cap that is several megabytes against a 5-10 MB origin quota, and the failure is silent by
   design (a caught write error, then a full history re-walk on every boot).

**And the catch-up is a TIMER - worth a row of its own.** Five cold starts took 61 863 to 62 019 ms
to show a message sent while the browser was down, a 156 ms spread: something waits about sixty
seconds before an offline device is given a message the server already holds. `PHASE_STUCK_MS` is
60 s but only REPORTS, so it is not that. On a phone this is a minute of an empty conversation.


### P3 - HEAL-W2's break cannot take, because the live client writes its MLS state back over the restore (measured 2026-09-06)

The row makes a group unknown by restoring an MLS blob that predates the join. On `60432d09` the
restore is immediately undone: `digest after restore` and `digest after reload` differ, which is
exactly the discriminator the runner already carries - **the live app checkpointed its in-memory
state back over the restored blob before the reload**. `brokeForReal: false`, so it records
`SETUP-FAILED` and asserts nothing downstream. That refusal is correct and is not the work.

**THE WORK IS ARRANGING FOR NOTHING TO BE EXECUTING BETWEEN THE RESTORE AND THE LOAD**, and the two
obvious ways do not survive contact:

- park the page on `about:blank` first - the origin changes, so `mlsdb.mjs` can no longer reach the
  `localhost:8081` IndexedDB it has to write;
- `Emulation.setScriptExecutionDisabled` - freezes the page's own scripts, but the restore tool
  drives the same page through `Runtime.evaluate`, which it would also be freezing.

A same-origin document that boots no app (a static text path) is the shape that satisfies both
constraints, and whether IndexedDB is scriptable from one is the thing to measure before writing it.

**AND A SECOND, INDEPENDENT GAP IN THE SAME ROW**: `markerReason: UNRESOLVED GROUP ID` - the runner
could not map the group NAME to its uuid, so the awaiting-history marker could not be read for the
group under test even if the break had taken. Two fixes, not one, and neither is the app.

### P2 - FIVE rows watch a responder heal a device that no longer needs one, and the rung has to be redesigned around a group the device cannot self-serve (four HEAL-NEW 2026-09-06, MULTI-9 2026-09-07)

**MULTI-9 IS THE FIFTH, AND IT IS THE SAME MECHANISM SEEN FROM THE MEMBERSHIP TABLE.** The row asks
what a message sent to a `pending` device is worth once that device activates - written after a
device sat `pending` for 134 minutes while messages were accepted, fanned out and lost. Measured
2026-09-07, on its FIRST EVER EXECUTION (`roster.mjs` had died at module load since it was written):
the new device reached `active` in **105 ms**, with the peer deliberately killed, because the owner
held FIVE devices in that group and one of them committed the add immediately. There is no window to
send into, so all 5 of 5 messages arrived at an ACTIVE membership and the row proved nothing about
its own question.

It records `VACUOUS` for exactly that case - the sole unmet expectation being the window itself -
and never for the two failures it must not absorb: a device that never activates, and a message
lost in a window that DID exist, are separate expectations checked first. Recording `FAIL` would
have been the board accusing the product of the fix that closed the window.

`HEAL-NEW-11`, `-12` and `-15` were written for a product where a fresh device sat AMBER until some
member served it. They wait up to 90 s for an "amber alone" state, then start the responder, then
watch it heal. On `c643a411` that state never arrives:

```
 11 749ms  the client is LIVE on /chat - the mint hands over
102 008ms  never went amber alone within 90s: rows 36, ready 36, syncing 0   (+90 114ms)
102 008ms  starting the late responder w1
133 992ms  watching the sidebar ...  settled (+3ms)
```

**HEAL-NEW-1 is the measurement that explains it, and it is a PASS**: with the phone force-stopped,
both browsers down and the GATEWAY confirming `extra: []`, a fresh device reaches **36 of 36 ready in
8.0 s**. It serves itself through the external-join seam - `roster seat with NO queued Welcome and NO
add in flight - nobody owes us anything; serving ourselves`. **A device holding a roster seat does
not need a responder**, so a rung built on watching one arrive has nothing left to watch.

  THE LATE WATCH IS A SYMPTOM, NOT THE FAULT, and this matters because the runner already carries a
  comment about having fixed a 49 s lateness by moving work below the watch. It is 122-166 s now, and
  every extra second of it is the 90 s amber poll plus the responder boot that the dead premise makes
  the row wait for. Fixing the arming point would not make these rows observable; it would only make
  them fail faster.

**WHAT WOULD MAKE THE QUESTION ASKABLE AGAIN is a group the device CANNOT let itself into** - one it
is owed a Welcome for rather than one it holds a seat in. The product distinguishes them in its own
log (`already in tree for <id> - skip (will join via queued Welcome)` against the self-service line
above), so the discriminator exists; what does not exist is a fixture that puts the subject in that
state deliberately. That is the piece of work, and it is a rung redesign rather than a row edit.
**Deliberately NOT rescued with a second probe**: `healnew.mjs` says `never a PASS over an unasked
question, and never a second probe invented to rescue it`, and clicking a healed sidebar to report a
number would be exactly that.

**THE WINDOW CAME BACK ON 2026-09-08, ONCE, AND NOTHING HERE EXPLAINS WHY - so this entry stands.**
All three rows passed clean on `9cf5191cc` with `healed: true` and `watchOpenedAfterLiveMs` of
**24.2 s** against the 122-166 s above, which is the signature of the amber-alone state arriving
promptly instead of never: the row is no longer paying the 90 s poll it used to lose. The board cells
are updated because a verdict is a verdict and the runs were clean and unchanged. But **one record
is one draw** - the tool that would say otherwise now exists (`rows.mjs` reports a row that answered
twice on one build) and it has ONE record for each of these - and a premise that returns without an
explanation is not a premise that has been restored. Two things are owed before this closes: WHY the
device sat amber here when it self-serves in 8 s on HEAL-NEW-1, and a re-run that shows the window is
reliable rather than lucky. Until then the fixture described above is still the piece of work.

### P1 - twelve of sixteen messages were FETCHED AND DROPPED, and the commit log has a PERMANENT HOLE at epoch 121 (measured on prod 2026-09-02)

**THE FOUR DEFECTS ARE FIXED AND IN `CHANGELOG.md`; WHAT IS LEFT IS THE RESIDUE.** DM `7da231f8`: of
sixteen messages the peer sent, the Android phone fetched all sixteen and displayed four. The four
causes - a best-effort commit-log insert outside the epoch-advance transaction, `getCommitsSince`
blind to a hole in the middle (`gapAt`), a `pending` sender accepted and fanned out
(`403 sender_not_active`), and application frames emitted between a device's own commit and its
acceptance (`epochSendBarrier`) - were fixed 2026-09-02 and stop the NEXT loss; they recover none of
these twelve. Still open:

- **The twelve messages.** Their plaintext exists only on the peer's iPhone; the ciphertexts on prod
  are past `max_past_epochs(2)`. A diff against that iPhone is the only recovery.
- **Which arm of `process_message` dropped the 13:10 four is not established**, and the logcat
  cannot say retroactively (the app's own lines had already rotated out). Settling it needs a
  reproduction with `clearLogcat()` first, through
  [phone.mjs](../../tools/cross-client-harness/phone.mjs) and the `LOGCAT_TAGS` in
  [verify-on-device.py](../../tools/android/verify-on-device.py). **Do not write a fix against a
  suspected arm** - the candidates in [messaging.rs](../../frontend/mls-core/src/messaging.rs) are the
  epoch-gap fast-fail, the past-epoch application arm and the same-epoch refusal, and they carry
  different fixes.
- **A dropped application frame is told to nobody.** The green "SÉCURISÉ & SYNC" shield that lied
  here is gone: [ChatGroupPanel](../../frontend/src/lib/components/chat/ChatGroupPanel.svelte) now
  says only "Chiffré de bout en bout", unconditionally, by the user's choice to stop exposing the
  machinery. Whether a device that dropped a frame should say so anywhere is NOT decided.


---

### P3 - the phone polls presence every ten seconds over a live WebSocket (measured by logcat 2026-09-02)

Read off the Pixel 6a with `adb logcat`: **45 `GET /api/presence` in seven minutes** - one every ten
seconds (`presenceStore.ts`, `createPausableInterval(checkPresenceNow, 10_000)`, still so on
2026-10-04), on a mobile client that already holds a live WebSocket. A clock where a push belongs,
and it costs battery and data on every phone. (The other half of this entry, the `pong` WARN line,
is fixed: `isHeartbeatFrame` in `channelEventTypes.ts`.)

**Why it is not simply built: a push needs a DESIGN DECISION first.** The gateway would have to send
presence changes to the users allowed to see them, and who may watch whose presence is the open
question `get_presence` in `apps/chat-gateway/src/presence.rs` already names (today any authenticated
caller may ask about any user id). Decide that, then the push is a gateway subscription plus a
client listener that replaces the interval.

---

### P2 - a device holds a distribution group the group holds no row for it, and heals by rejoining (measured 2026-08-29)

**Handed back by HEAL-NEW-15's branch on `038c7e8d`, deliberately unacted on because its blast radius
leaves that row.** Sixty seconds after external-joining the community distribution group `315b8a1d`
at epoch 56, the fresh device logged:

```
this device holds the distribution group but the group holds NO row for it (3 device(s) for this user)
 - the local group is stale, rejoining
```

and joined again at epoch 57. **A race that heals cleanly is still a defect**: if the mechanism needs
a heal in THEORY it is wrong whatever it does in practice, and the thing to find is what makes the
two paths overlap, not to admire the repair.

**Two facts from the same run belong with it and may or may not be one cause.** `315b8a1d` is the
ONLY group of eleven the reconciliation did not ask about - `reconciliation pass complete - 10/11
group(s) asked in 794 ms` - and it is also the only group that was external-joined twice, at 56->57
and 57->58, both before the late responder arrived. Whether the skipped reconciliation is a
CONSEQUENCE of the membership row being absent, or a second symptom of the same stale local state, is
undetermined and is the first question to ask. **Do not assume the correlation is causation**; one
`GROUP BY` over `dm_device_group_memberships` for this device and this group settles which row
existed when.

**RECURRED ON BOTH ROWS OF THE 2 / 12 PAIR, same build `038c7e8d`, so it is not a one-run
coincidence and the population is "every freshly minted device", not "a device that waited for a late
peer".** Stamps, which is all these two rows owe it: row 2 logged the stale-group line at 15:09:47
and `externalJoin succeeded for 315b8a1d...` at 15:09:48; row 12 logged both at 15:14:31. In both,
the community is `fbddc890` and the device count in the line is 3. **Two of the reading conditions
differ from row 15's and rule nothing out:** each of these rows external-joined `315b8a1d` TWICE and
no conversation group at all, and the reconciliation asked 0 of 1 and 0 of 2 rather than skipping one
of eleven - so the "only group the reconciliation did not ask about" correlation cannot be tested at
this fleet size and is neither confirmed nor refuted here.

**RECURRED ON A DIFFERENT RUNG, AND THE DEVICE COUNT IS NOT A CONSTANT.** HEAL-REVOKE-5 on
`96bdd1bb`, 2026-08-29: the wipe window logged the line at 23:00:52 with `(3 device(s) for this
user)` and the reference device logged it at 23:02:55 with `(2 device(s) for this user)` - **two
different counts in ONE run, two minutes apart**, tracking the live device population as devices were
revoked and minted. So the `3` recorded above is not part of the shape and nothing should be read
into it; what is constant across every sighting is the community, `fbddc890`. The population is
therefore wider than "every freshly minted device": a device that RETURNS from a revocation wipe
produces it too, which is a second rung and a second build. Not chased here, per the row's brief.

### P2 - a membership is REFUSED for want of a KeyPackage one second after the device external-joined that very group (measured 2026-08-29)

**It heals, and by the standing rule that is still a defect:** a race that needs a heal in THEORY is
wrong whatever it does in practice, and a ledger that reconciles the two paths afterwards is a
witness, never a fix.

Seen twice in HEAL-NEW-15's run on `dc8bf000` / runner `56090443`, on a device that had been minted
seconds earlier: the client logs `externalJoin succeeded` for a group, and roughly one second later
the server logs `[MEMBERSHIP_ACTIVE] REFUSED ... reason=no_key_package` for the SAME group. The
membership goes active shortly afterwards, so no row went amber for it and nothing in the sidebar
records that it happened.

**What has to be named before a fix is written** is which of the two orderings is the real one - a
KeyPackage published after the external commit, or an activation read that runs before the
publication it depends on has committed. The two are indistinguishable from the refusal line alone,
and this is the second time on this rung that a `no_key_package` refusal has meant something other
than what it said (see the entry below, where it meant the device cap). The discriminator is the
publication's own timestamp against the refusal's, both of which exist.

**It cost nothing here** because W1 was online and serving; the concern is the population where
nothing is. Nobody has measured how often it happens outside this rig.

**RECURRED ON BOTH ROWS OF THE 2 / 12 PAIR, on `038c7e8d`, and the refused group is the SAME ONE the
entry above is about.** Row 2: `[MEMBERSHIP_ACTIVE] REFUSED group=315b8a1d... reason=no_key_package`
at 13:09:20, then `[MEMBERSHIP_ACTIVE] group=315b8a1d...` at 13:09:47 - 27 s. Row 12: refused
13:13:36, active 13:14:31 - 55 s. **In both, the group is the community distribution group and NOT a
conversation**, and in both the client external-joined that same group twice and logged the stale
local group of the entry above within a second of the activation. Two P2s, one group, one second
apart, twice: **treat "are these one defect" as the first question, not two independent
investigations.** The discriminator both entries name is still unmeasured - the KeyPackage
publication's own timestamp against the refusal's.

**RECURRED ON HEAL-REVOKE-5, `96bdd1bb`, 2026-08-29 - same group `315b8a1d`, on the SEED device, at
21:00:41.** This sighting cannot measure the interval the entry asks for: **no `[MEMBERSHIP_ACTIVE]`
line for that device appears in the window at all**, and that is explained by the ROW rather than by
the defect - HEAL-REVOKE-5 revokes the seed roughly ninety seconds later, so the activation had no
opportunity to happen. Recorded so the absence is not later read as a refusal that never healed. The
population now includes "a device minted as a revocation row's seed", which is a third rung.

**And on those two rows the refusal was invisible from the client half.** `healnew.mjs` records only
`observers: { w3 }`; the server window is taken by `run.mjs` per PASS and printed, not written to the
ledger row - so `bun rows.mjs` and every HEAL-NEW cell are silent about it, and it was found by
reading the run's stdout. Nothing here is wrong, but a HEAL-NEW verdict says "clean on the web
client", never "clean on the server".

### P1 - a device asks for a Welcome for ever, and the member that answers RESETS the row that would have let it heal itself (measured on prod 2026-09-01)

**THE LIVELOCK IS FIXED AND ITS STORY IS IN `CHANGELOG.md`; WHAT IS LEFT IS ONE PROD MEASUREMENT
AND ONE LOCAL SIGHTING.** Reported 2026-09-01: a web device stuck on `SYNC` for
20 hours on three conversations, the responder's `[KICK]` resetting the very row that would have let
it external-join itself. Six causes, all fixed: `pending` read as an in-flight Add (A, now
`welcomeQueued` + `addInFlight`), the kick writing `pending` before the Add landed (B,
`MlsError::NoSuchMember`), `stale_base` answered with a Welcome instead of a republish (C,
`staleBase.ts`), a failed re-add reported nowhere (D, `kickedAt` + the hourly ERROR arm), a device
still holding the group skipping the seam (`recoverRosterDisagreement`, 2026-09-04), and a fallback
KeyPackage dying at its first Welcome (`last_resort`, 2026-09-06,
[mls-protocol](protocols/mls-protocol.md#the-two-kinds-of-key-package)). The watchdog's
`[READD] ... throttled` noise went with `isReAddDue` (2026-09-12).

- **The prod measurement.** The stale bases at `activeEpoch`, read with
  `SELECT ... FROM mls_group_info gi JOIN dm_groups g ...` and no hand-written UPDATE, and one reading
  of the hourly report's *kicked with no re-add* ERROR arm - the first count of how often the re-add
  after a kick fails. `4f87267a`, the original witness, is no clean probe any more: on 2026-09-12 no
  device could open it until its other member returns (`CHANGELOG.md`).
- **`[KICK] Stale leaf` still appears locally** (HEAL-REVOKE-5, 2026-09-06 01:03): a device asking for a
  Welcome for a group whose leaf is already in the tree. It is the local reproduction to take the
  measurement against. Its blast radius is measured on the HEAL-repair P1 above: a kicked leaf is
  elected as a history responder like any other member and is silently a dead end (the rotation fix
  was REFUTED 2026-09-08, not to be re-opened).

The cause of the skipped Add itself is the P2 immediately below.

### P2 - a device was given a roster seat and never a Welcome: THE REASON IS NOW TYPED ON THE CLIENT, THE SERVER REPORT CANNOT PARTITION ON IT YET (measured on prod 2026-09-01)

The inviter now carries a typed reason per skipped KeyPackage and prints it per cause (`skipped`,
`SkippedKeyPackageReason`; mechanism in
[chat-delivery](services/chat-delivery.md#a-roster-seat-is-not-a-key-and-only-a-welcome-tells-the-two-apart)).
**What remains is the half that needs a design**: the hourly `reportStrandedDeviceMemberships` still
partitions on the queue, because the reason lives only in the INVITER's console and nothing sends it
to the server. Closing it means a client-to-server write (an endpoint, and a column or table keyed
by device and group so the report can join it), i.e. a migration - not inlined. Two facts to settle
with it: the client CANNOT say last-resort vs one-time (the extension is unreadable on a refused
package; the server, which chose the row, would have to record which it served), and the first
`skipped` lines from real inviters are the measurement that says whether a spent OTK pool (the
original hypothesis: all four of the peer's web devices showed 0 one-time packages) or a rejected
package is the cause. Read those before designing the write.

### P1 - the placeholder is GONE from prod; what it may have left in the MLS TREE is not answered

**The defect, its cause, the guards of 2026-08-28 and the hand cleanup of 2026-08-30 - with every
count and the evidence the deleted frames carried - are in `CHANGELOG.md` and on
[chat-delivery](services/chat-delivery.md#the-placeholder-that-took-a-conversations-first-seat-cleaned-by-hand-2026-08-30).
None of it is restated here.** The server estate is zero on all four tables and the DM kept its eight
real device rows. One thing is open, and it is not a database question: the live behaviour is measured clean (MULTI-8 `PASS` 2026-09-07, the second device reached active with no placeholder written).

**WHETHER IT LEFT A LEAF, which no server query can answer.** The server row is not the MLS tree:
if a commit ever Added the placeholder, only a Remove commit from a member drops it, and deleting
   the row did not. The group sat at **epoch 118** and the placeholder held a `key_package`, so an
   Add is likely rather than certain. **It is answered from a member's own client** - both members
   are the account owners, so either can read the tree of `7da231f8-119c-4ce2-884f-55f5c94c903f` and
   say how many leaves it carries and whether one has no owner. Until then, that conversation may be
   encrypting to a member that does not exist, which costs nothing cryptographically and makes the
   roster wrong.
### P2 - a group that never leaves its creation epoch keeps collecting device invitations nobody can honour (measured on prod 2026-08-30)

Found by HEAL-REVOKE-7 `--order last` on `edb8d7ab` - the run that was supposed to confirm the P1
above and instead FAILed on that P1's RESIDUE. Kept as its own item because the residue turned out to
name a class, and the class has real conversations in it.

**What the row saw.** `equalityGap: ["rows: 12 vs 13", "syncing: 0 vs 1"]`. The server listed 13
groups for the subject; the returning device built 12 rows and settled; the freshly minted reference
built 13, the 13th amber for ever. The extra one was `8868be1c`, the very group the P1 above
destroyed. The actor itself reported `12 ready of 13` - so no device in the fleet could serve it.

**What prod said, and it is the membership row that lies.** The group was alive (`deletedAt` null,
`activeEpoch 1`, no rotation payload) and its device memberships read:

    web-...-msgm5z5j-136y   active    2026-08-30 01:20:44.793     <- the creator, holding NOTHING
    web-...-mtd1d1fc-m84y   pending   2026-08-30 01:20:44.849
    tauri-...-mtd1qgu3-vnde pending   2026-08-30 01:20:44.849
    web-...-mtf6rlvn-hkhr   pending   2026-08-30 02:24:18.378     <- this run's reference mint

`active` is written when the creator registers itself, and nothing ever revisits it. The creator's
local MLS state was gone 291 ms later, so the server went on offering the group to every device that
enrolled afterwards - including a device minted an hour later, which duly went `pending` and stayed
there. **A membership row records that an invitation was SENT; nothing reads back whether it was ever
honoured, and nothing expires it.**

**THE POPULATION, because this is exactly the kind of question no row on the board asks** (measured
2026-08-30, before the sweep that cleared the instance):

    -- invitations still pending on a LIVE group, by age
    SELECT CASE WHEN now() - m."createdAt" < interval '1 hour' THEN 'a: < 1h (in flight)'
                WHEN now() - m."createdAt" < interval '1 day'  THEN 'b: < 1 day'
                WHEN now() - m."createdAt" < interval '7 days' THEN 'c: < 7 days'
                ELSE 'd: older' END AS age,
           count(*) AS pending_rows, count(DISTINCT m."groupId") AS groups,
           count(DISTINCT m."groupId") FILTER (WHERE g."activeEpoch" <= 1) AS in_epoch1_groups
    FROM dm_device_group_memberships m JOIN dm_groups g ON g.id = m."groupId"
    WHERE g."deletedAt" IS NULL AND m.status = 'pending' GROUP BY 1 ORDER BY 1;

    a: < 1h (in flight)    2 rows   2 groups   1 at epoch 1
    b: < 1 day             9 rows   5 groups   1 at epoch 1
    c: < 7 days           13 rows   5 groups   3 at epoch 1

**22 of the 24 pending rows on live groups were older than an hour, 13 of them older than a day**, and
none pointed at a revoked device - they are live devices holding invitations that will not resolve.
Of the nine live groups sitting at epoch 0 or 1, **four carried pending rows and three of those are
real conversations, not harness debris** - two DMs from 2026-08-03 and 2026-08-28, and one unnamed
group from 2026-08-28. The oldest such group is 33 days old. `HGRP` debris was one of the four and
has been swept; the other three are untouched, deliberately - they are real user data and no
destructive control here has a reason to name them.

**Do not take `activeEpoch <= 1` for the predicate.** Pending rows exist on healthy groups too
(epochs 3, 4, 5, 8, 10, 108 and 258 each had one), so "pending" alone is not the signal and "epoch 1"
alone is not either: a DM created and never written to legitimately sits at epoch 1 with everyone
`active`. What distinguishes the corpse is a `pending` row that has outlived any plausible delivery -
which is a duration, and therefore has to be measured against the population before a name is put on
it, not chosen from this one incident.

**The second fact, and the one that reaches a HEAL row.** The two devices disagree about an
unservable group: a FRESH device creates a row for it and leaves the tile amber for ever; a RETURNING
device creates no row at all. Neither is obviously wrong - not showing it is arguably the better of
the two - but they differ, and "a returned device ends where a fresh device ends" is precisely what
rung 16 asserts. **So this class can fail a HEAL-REVOKE row that is not about it**, which is how it
was found, and it is the same family as the dead row a deleted group leaves every other member.

**Not fixed here: the blast radius leaves the row's subject.** Three things want deciding together,
and the third is the only one that is cheap: whether an invitation should expire; whether a group
whose creator holds no state should still be offered; and whether an unservable group should present
a tile at all. Nothing here should be settled by widening a sweep - the P1 above is precisely what
happens when a destructive path decides a group is dead from an incomplete read.

### P2 - a re-admitted device calls its own exclusion window a loss, and reconciles for it (measured 2026-08-26)

**Found by a fix working.** GRP-8's round-2 re-admission Welcome used to be dropped as a redelivery
(closed in `e027679a`), so the re-admission never happened on the joiner and the check passed anyway -
it counts the INVITER's roster. With the Welcome processed, this is the honest consequence. Nine clean
`PASS` rows before `feecfaf5`, `PASS-DIRTY` on it.

**THE SAME FRAME IS JUDGED TWICE AND THE TWO ANSWERS DISAGREE**, fifteen seconds apart, on `feecfaf5`:

    11:09:19  Frame arrived after this device was evicted - ACKed and dropped, no repair is owed
              msg_epoch=3 group_epoch=3
    11:09:34  [WELCOME] held but EVICTED - re-admission, not a redelivery   -> forget_group, epoch 4
    11:09:34  Past-epoch application frame, unreadable for good: msg_epoch=3 group_epoch=4
    11:09:34  [History] frame never read here and unreadable for good; will reconcile
    11:09:34  [HISTORY_RECONCILE] asked ... whether we hold the same history

`history.ts`'s `kind === 'evicted'` branch already carries the whole argument three lines above the one
that fires - *"we are not entitled to the plaintext, so there is nothing for a reconciliation to
recover"*. The defect is that this reasoning is keyed on the CURRENT membership state, so it stops
applying the instant the device is re-admitted, while the frames it protects are still in the stream.
**A column is only evidence for the question it was written to answer**: `evicted` answers "am I out
NOW", not "was I out THEN".

**What it costs:** one reconciliation per re-add over the whole exclusion window rather than one frame,
so it scales with how long the device was out and how busy the group was - against *"doit marcher avec
une conversation de toute les tailles"*. And it puts a repair line in a window where nothing needed
repairing.

**The fix, and the one thing blocking the obvious version.** An ENTITLEMENT FLOOR per group, written
where the Welcome installs - which is now a named branch, `readmittedAfterEviction` in
`setupMessageHandler.ts`. A frame below the floor is then handled exactly like `evicted`: marked seen,
no loss, no reconciliation. **The frame's own epoch is not visible from JS** - Rust has it and prints it
(`msg_epoch=3 group_epoch=4`) but the error reaching `classifyIncomingDecryptError` is
`SecretTreeError(TooDistantInThePast)` with no number, and `getEpoch(groupId)` gives only the current
epoch. So either surface the frame's epoch through the decrypt error - **never learn by failing what a
fact could have told you** - or key the floor on the STREAM POSITION at re-admission, since the replay
already walks rows in order and row ids are timestamps. The second needs no WASM rebuild and no APK.

**A policy question sits behind it and is NOT answered here** - see
[open-questions](open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add). Nothing
should be changed on the strength of a reading of it.

**How to confirm it is gone:** GRP-8 goes clean. It is the only check that re-adds a removed member.


**RECURRENCE 2026-08-30, AND IT WIDENS THE POPULATION THIS ENTRY CLAIMS.** Read off six
HEAL-REVOKE-5 runs, builds `96bdd1bb` through `0044a041`. **The device losing the frames was never
evicted from the group it loses them in** - it is a fresh device of the same user, joining for the
first time after a revocation wipe. So the entitlement floor cannot be keyed on
`readmittedAfterEviction` alone, which is what the fix above proposes: that branch never runs here.
**A floor belongs at every entitlement START, however the entitlement was acquired.** And "how to
confirm it is gone: GRP-8, the only check that re-adds a removed member" is incomplete for the same
reason - HEAL-REVOKE-5's reference observer reaches this branch with no eviction anywhere in the row.

**What was measured.** 107 distinct `LOST frame` fingerprints over the six runs, growing run over run
(1, 8, 8, 9, 30, 51). In the run of record, 50 of 51 fall in ONE group of the 23 the owner is a member
of. They are not chat text: the fingerprint's first field is `frame.length` in base 36, so the sizes
read straight off it - median 52 KB, max 84 KB, 5.6 MB over the six runs.

**A SECOND AND MUCH LARGER POPULATION SITS BEHIND THE SAME GROUP**, reported in aggregate rather than
per frame:

    [HISTORY] 642f389a... holds 8005 frame(s) it can never read - reconciling (e.g. 5p:1cx1kog, ...)
    [HISTORY] 642f389a... holds 3005 frame(s) it can never read - reconciling (e.g. 5p:1cx1kog, ...)

`5p` is 205 bytes, so these are small frames and a different population from the 52 KB ones above. The
example fingerprints are IDENTICAL across all three observers of one run, so that backlog is stable.

**WHAT IS NOT ESTABLISHED, AND THE INFERENCE THAT MUST NOT BE DRAWN FROM IT.** No fingerprint repeats
across any two runs, and **that is not evidence the frames are new messages.** `frameFingerprint` is
FNV-1a over the CIPHERTEXT bytes, and `historyManifest.ts` answers a reconciliation by re-encrypting
the peer's durable copy at the CURRENT generation - so the very same message re-sent to a new device
fingerprints differently every time. Zero overlap discriminates nothing here, and a reading of it as
"fresh traffic each run" was formed and retracted before it reached this page.

**The cheap discriminator, for whoever takes it.** The digest that precedes the burst asks with
nothing held - `[HISTORY_DIGEST] Sent for 642f389a... - ids mode, 0 id(s), asking from
2026-05-31T00:00:00.000Z` - so whether the 52 KB frames ARE that answer is settled by putting the
`Sent` stamp beside the burst, which lands inside a single second. Worth one look before anything is
changed: if the reconciliation's own answer is what arrives unreadable, the repair is feeding the
loss it was sent to cure.

**One more line from the same window, unqueued elsewhere and not chased here:**
`[HISTORY_RECONCILE] no probe sender yet - 642f389a... deferred until one is installed`, five times
across two groups before the first digest goes out.


### P2 - a device revoked while OFFLINE keeps its store until someone LOGS IN on it (measured 2026-08-30)

**The product does what it says, and HEAL-REVOKE-9 now asserts three things where it asserted one.**
While the victim was severed (`severed: true` in 4 ms) and revoked from the owner's panel
(`stillAddressable: false` in 2 106 ms), its state was still there - `identityKeys: 1`, 2 databases, 22
localStorage keys, `wipeRan: false`. **A device that cannot ask does not conclude**, and a wipe there
would have been this rung's worst possible outcome. A reload alone changed nothing
(`revocationSeen: false`; `footprint.mjs` still read 6.54 MB fourteen minutes later); one
`login.mjs --device W3` then took it to `identityKeys: 0`, 3.46 MB. **The wipe is DEFERRED, not lost.**
`sessionAuth.ts` has exactly three triggers and each requires a credential or a live socket, so a page
load that finds a dead cookie hits none of them - by design, since wiping on an unauthenticated page
visit is a destructive control firing without a confirmed server fact.

**SO WHAT IS OPEN IS A DECISION, NOT A PATCH: how long the residue may sit.** On a machine never logged
into again - the stolen-laptop case revocation exists for - it stays on disk indefinitely. It is an
identifier (`mls_device_id_<userId>`) plus SEALED key material (`canari_device_key_vault`) over databases
encrypted under that device key: ciphertext and a name, not readable messages, which is why this is a P2.
Closing it needs a choice between two bad options - asking the revocation route at the login GATE means
answering `/api/mls/devices/:userId/:deviceId/revoked` to an unauthenticated caller, a device-enumeration
oracle; the alternative is a local expiry, the exact clock this project refuses to make load-bearing.
**That question is the whole of what stays open here.**

### P1 - a REVOKED device's partial restore reports no shortfall, and the cause the user hit is not established

The wipe and tombstone halves are fixed ([auth](frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it), `canRepresentThePeer` in `v0.18.18`); HEAL-REVOKE-1, -2 and -3 are `PASS` on [the board](cross-client-testing.md). Two items remain:

- **A partial restore is worse than no restore.** The restore must know its expected count and report a shortfall (not checked in code on 2026-10-01).
- **Which cause the user hit** (a session-only row removal, `revokeRowSessions` failing, or the watchdog rebuilding the store) is only separable from the user's own history. Not worth code without a measurement.

## Mentions

### P3 - a mention of a deleted account writes a browser-level console error no client code can suppress, and the row that meets it cannot declare it expected (measured 2026-09-08)

Owed to the USER: a product choice. `GET /api/users/<id> -> 404` is written by the browser, not the
app (the client already caches the 404 for its 30 s TTL). Two designs remove it: the server answers
**200 with a tombstone** (`deleted: true`, no name), or the mention carries a **name snapshot** taken
when written (the only one that survives the server forgetting the user). Not to be silenced by an
`ignoringExpectedLog` on the row - the same shape is how an unminted identity in a roster shows.

### P3 - a mention banner says "someone" where the mentioned member's NAME could be

**The hex is gone from every native composer** (Android, the iOS extension, `canari_push.mm`). **Owed: one look on an iPhone** (compiled, never run).

**What is left is a NAME instead of the word, and it is a design choice, not a defect.** The MLS path
cannot be told server-side (the server never sees the text); the device already holds names
(`peekUserDisplayName` / `seedUserDisplayName` in `utils/users/displayName.ts`), so the cheap shape is
a mirror like `graine_seeds.json` - a Rust command plus its `capabilities/` grant, a call site in the
resolver, a Kotlin and a Swift reader - with no network on the push path. The channel path could
instead take the first mentioned name from the server, bounded against the 4 KB APNs budget
(`push-payload.ts`). Either way a miss keeps today's word.

## The harness itself

### P3 - the phone's local debris cannot be swept, so every run ends on a line that says so (measured on A1 2026-09-08, still true 2026-09-21)

`sweepDismissed` (`archive/dismiss.mjs`) clears the client-side half of a deleted throwaway group -
the conversation a device keeps after the server row is tombstoned. **It cannot reach a Tauri
client.** Its reader enumerates `indexedDB.databases()` for `CanariDB_<userId>`, and on
`http://tauri.localhost` the only database is `emoji-picker-element-fr`: the native client keeps no
conversation store there. So every pass ends with

```
A1 debris NOT swept: [dismiss] NO Canari conversation store at http://tauri.localhost
```

**THE MESSAGE IS CORRECT AND THE SITUATION IS NOT.** That sentence was written on 2026-09-08
precisely because the previous one read as a chooser declining, and nobody asked why - while a group
deleted seven hours earlier was still in that phone's sidebar, rendering under the PEER's name, which
made `openConversation` ambiguous and cost NOTIF-1b three verdicts. The wording fixed the
DIAGNOSIS. The debris is still unreachable, and a line printed on every single run is one its reader
learns to skip - which is the exact failure the file's own docblock warns about for the 189 rows of
2026-08-24.

**WHAT CLOSES IT, AND WHY IT IS NOT A ONE-LINER.** The filter is `isGroupDebris(row.name)`, and the
phone's DOM carries the PEER's name for such a row rather than the group's, so enumerating from the
sidebar would not recognise the debris either - **the name has to come from somewhere that still has
it**, which means the server's tombstoned rows, joined to what the phone shows, rather than a
client-side scan. Dismissing through the app's UI on A1 the way a user would is the other route; failing
the ROW when it created something on A1 is the least. Until then the phone accumulates exactly what W1
and W2 no longer do.

**IT IS P3 BECAUSE NOTHING HAS COST A VERDICT SINCE THE WORDING CHANGED**, not because the debris is
harmless: the 2026-09-08 incident is what it costs when it is not read.

### P2 - no row on the board can tell a healthy conversation from an epoch-forked one (measured 2026-08-29)

Two production conversations sat forked one epoch behind for twenty-four hours, refusing 191 and 172
commits, and **every reading this rig takes was green throughout**: `data-ready="true"` on both tiles,
`syncing: 0`, `amber: []`. The fork was found in the SERVER's refusal count while chasing something
else. Reasoning in
[testing-methodology](testing-methodology.md#a-green-sidebar-tile-does-not-prove-the-group-is-not-epoch-forked);
this is the queue entry for the gap it leaves.

**THE PREDICATE IS BUILT END TO END (2026-10-04)**: `epochfork.mjs` compares, `archive/syncrows.mjs`
`readEpochForks` reads both halves, and the client half is `window.__canariMlsEpochs()`, installed by
`createMlsService` (`frontend/src/lib/mls-client/epochDevTools.ts`). **What is owed is the ROW, and
it needs the rig**: a MULTI-shaped row asking `readEpochForks` of a conversation it is NOT itself
using - the only place a quiet fork can live - run once on a build carrying the hook (older builds
answer `unobservable`, never clean).

### P2 - a LIVE socket dies in the middle of GRP-3, and no navigation explains it (measured 2026-08-25)

**Accepted as a `PASS-DIRTY` by the user's decision of 2026-08-25** - *"on peut se contenter des pass
dirty et passer a la suite"* - so this is recorded rather than blocking rung 8. The frontier drawn with
that decision is what makes it recordable: dirt whose CLASS has been read and named may pass, dirt that
is unclassified or that touches an assertion may not. This one is a known SHAPE with an UNKNOWN cause,
which is the reason it is a P2 and not a note.

**The measurement.** `GRP --repeat 5`, pass 1, 2026-08-25. Ten rows, nine `PASS`, and GRP-3
`PASS-DIRTY` on exactly one line:

    dirt_W1: wsEvents: ["11:28:30.944 Network.webSocketClosed {requestId 20644.93706}"]

Every product assertion held - `rosterBeforeRemoval: 2`, `rosterAfterRemoval: 1`,
`peerStillHoldsPreRemovalMessage: true`, `peerReceivedPostRemovalMessage: false`,
`removedDeviceLearntFromTheCommit: true`, `removedDeviceAskedToComeBack: []`. The row was recorded at
11:28:42, so the close landed ~12 s before the end of the check: inside the 30 s negative window,
roughly 18 s AFTER `removeMember` and after the post-removal send. It is on W1, the client that did
the removing, not W2, the one removed.

**WHY THE KNOWN EXPLANATION DOES NOT APPLY, which is the whole finding.** Rule 14 of
[testing-methodology](testing-methodology.md) established that every `goto` is a `Page.navigate`, that
a document replacement closes its own socket, and that `1006` follows - so `ignoringNavigation`
forgives at most `documentsReplaced` closes. This close was NOT forgiven, and GRP-3 gives it nowhere
to come from: every `openGroup` in it passes `navigate: false`, and `ensureChat` does not reload - it
clicks `text=Discussions`, a client-side SvelteKit route change, which fires
`Page.navigatedWithinDocument` and replaces no document. So `documentsReplaced` is 0, the forgiveness
budget is 0, and this is a live socket dying. `wsidle.mjs` already ruled out the other cheap reading:
W1 and W2 left untouched for eight minutes produced **zero** closes, so nothing on the path drops an
idle connection and the event is caused by something the check does.

**What is NOT known, and must not be guessed.** No console line accompanied it - READ's instance of
this shape came with `[WS] Disconnected. Code: 1006` beside it and this one came with nothing, though
that may only mean the app's own line is classified BENIGN and therefore absent from the dirt
projection rather than absent from the log. Whether the socket reopened is also unmeasured HERE:
`watch.mjs:1121` collects `Network.webSocketFrameError` and `Network.webSocketClosed` and **not**
`Network.webSocketCreated`, so a reconnection could never have appeared in this row. Reading its
absence as a failure to reconnect would be exactly the inference rule 39 warns about.

**The rate.** One in two recent runs: clean on the attempt of 2026-08-25 that stopped on the server
window, dirty on the next. GRP-3's `PASS-DIRTY` of 2026-08-24 is a DIFFERENT cause and must not be
counted here - it was an `[OUTBOX] ... evicted from ...` line from a browser left on a stale bundle,
which is what `8c248131` closed.

**How to settle it - the instrument half is DONE (2026-10-04), the run is owed.** `report()` in
`watch.mjs` now records every completed socket handshake as `wsOpened` (dated, outside `clean`) and
puts it on the `timeline`, so a close followed by a reconnection is visible in any row. What is left
needs the rig: run `ws1.mjs` over GRP-3's sequence. If the close sits at a fixed offset from
`removeMember` it belongs to the Remove commit path; at a fixed offset from the socket's own age it is
a lifetime, which `wsidle.mjs` did not test (it watched a fresh socket, not an old one).

### P2 - ONE NAMED STARTING POINT, reachable at every granularity (asked 2026-08-25)

**The user's requirement, verbatim:** *"Le preflight doit permettre d'executer chaque phase, voire meme
chaque etape de phase ou groupe d'etape en ayant le meme point de depart, independamment de ce qui a pu
se passer avant"*, and before it *"tu peux recharger la page au debut de la phase au moment de l'etape
d'initilisation, ce serait beaucoup plus simple"* and *"Si le modal de pin s'affiche, tape le pin, s'il
ne s'affiche pas, ne le tape pas, si on est sur la mauvaise page, on peut recharger la page"*. It is
their standing directive - deterministic, reproducible, explicable - applied to initialisation.

**What is true today, measured 2026-08-25 rather than assumed.** `client()` opens a CDP connection and
guarantees NOTHING about the application: not the route, not the lock, not whether a modal is up. Of
23 sampled runners, **8 assert something at their start** (`ensureChat` or `goto`) and **15 assert
nothing at all** - `msg2`, `msg3`, `msg5`, `msg67`, `msg8`, `msg9`, `msg10`, `type`, `del1`, `comm2`,
`comm14`, `tab1` among them. They inherit whatever the previous script left, which is exactly what
`client()`'s own comment admits: *"Seventeen call sites pass no match at all and were relying on the
browser having one page - true after the preflight, and silently false the moment anything leaves a tab
behind."* The preflight does the work ONCE per run, so the guarantee decays with every script after it.

**The contract to write.** One exported entry point, idempotent, with an ASSERTED postcondition rather
than a described one:

- **The target state is named, not implied**: on `/chat`, unlocked, no overlay, chat mounted, on the
  deployed bundle. The same five facts `state.mjs` already reads.
- **It is cheap when already satisfied** - read the state first, act only on what diverges. That is
  what makes it affordable to call between step GROUPS inside a phase, which is the granularity asked
  for; a call that always paid a reload would be too expensive to put there.
- **The PIN is typed only if the gate is really up** (the user's wording exactly). Detected
  structurally: `#encryption-pin`, or a button whose text is the `U+232B` backspace glyph. Never by
  searching the page text - see the predicate entry below, which is what made a false lock permanent.
- **A wrong route is repaired by RELOADING, for a web client.** Not because a reload is a fallback -
  it is a REPAIR, logged loudly, and CLAUDE.md's rule stands: a fallback is a signal, never a path.
  Reaching it means the previous check left the client somewhere, and the log is what makes that
  visible.
- **A1 is excluded from the reload, by construction.** `goto` on the phone re-locks the PIN and breaks
  Tauri's IPC callbacks into the old document; `chat.mjs` throws rather than let a caller do it by
  accident. The phone keeps the repair path.
- **It says what it erased, before erasing it.** The existing repairs are loud on purpose - *"the day
  it is something else, the line is the only warning"* - and a check that leaves a modal up is a defect
  in that check. Silent tidying would delete the only evidence of it.
- **Then every runner calls it**, and `run.mjs`'s preflight becomes that same contract applied per
  device plus the run-wide checks (identity, bundle, server window). One definition, not two.

**Why it is worth the conversion cost.** [testing-methodology](testing-methodology.md) 33 says changing
what a check READS invalidates its green rows, and that is the argument that has deferred other
wholesale conversions. It does not bite here in the same way: the contract does not change what any
assertion measures, it makes the state BEFORE the assertion known. What it removes is a class of
failure the campaign has already paid for repeatedly - a check measuring behind a modal, on the wrong
route, or behind a PIN gate - each of which produced a refusal or a hang, never a false PASS. The rows
stay; the flakiness they cost goes.

### P3 - the bubble-action and observation helpers live in one runner, and every other runner re-invents them

`mut.mjs` carries `clickBubbleIcon` / `deleteBubble`, which locate a message's controls by their
lucide icon class and prove the click was RECEIVED - its own header calls this "a pattern the rest of
the harness could adopt". `search.mjs` did not adopt it and hand-rolled a confirm click that pressed
the wrong button for as long as the check has existed (2026-08-22, see `CHANGELOG.md`). The same
split exists for observation: `longestSilence` turns a hole in a client's timeline into a value, MUT's
`finish()` attaches it to every non-PASS verdict, and no other phase does - which is exactly the
evidence rung 5's one SEARCH-2 miss needed and did not have.

**Why it is not done yet, and this is the whole reason it is written down.** The shared home is
`chat.mjs`, and every phase consults `chat.mjs`. Moving a helper there invalidates MSG, TYPE, READ and
MUT under [testing-methodology](testing-methodology.md) 33 - "a board row whose phase was touched
anywhere gets re-run rather than reasoned about" - which is hours of ladder time to buy a refactor
nothing is currently failing for. So it waits for a moment when the rig can be changed wholesale and
the affected phases re-run together, rather than being slipped in mid-ladder where it would silently
cost four phases their verdicts.

### P3 - eight runners open IndexedDB by hand, and `idb.mjs` exists

`idb.mjs` (2026-08-24) is the one reader that ITERATES the databases a profile holds, filters
`CanariDB_` while excluding `CanariDBMls*`, and never decrypts. It was written because `recon.mjs`
takes the FIRST database it finds, which on a two-account Chrome profile is a coin toss, and because
reaching into `CanariDBMls*` by prefix returns an empty result that reads exactly like "nothing
queued". Counted 2026-08-24, `indexedDB.databases` appears in nine files and one of them is `idb.mjs`: EIGHT
call sites still carry their own copy of the preamble (`del1`, `dismiss`, `grainestore`, `grp`,
`identity`, `mlsdb`, `mut`, `recon`), and `del.mjs` is the only phase reading through the module.

**Why the copies are deliberately still there.** Converting a caller changes what that caller READS,
and every one of them belongs to a phase already green on the board - so the conversion invalidates
those rows under [testing-methodology](testing-methodology.md) 33, exactly as the
bubble-helper entry above does. The duplication costs nothing while it is identical; it costs a phase
the day one copy is fixed and ten are not, which is the shape `recon.mjs`'s first-database bug already
had. So this waits for the same wholesale moment: convert all eight, re-run the phases together.

### P2 - re-registering the PIN verifier strands every other client SILENTLY, and only its next unlock finds out (measured 2026-09-04)

`pin_verifier` holds ONE row per user - verifier, salt, `registeredAt` - and minting a fresh device
re-registers it. The owner's row was re-registered at **15:32:11** during the P1 reproduction, when a
device was re-minted after a PIN reset.

**Nothing told the other clients, and nothing had to, for four and a half hours.** W1 was already
unlocked and holds its derived key in memory, so it kept sending, receiving and passing checks all
afternoon against material the server had replaced. The staleness became visible only at 20:15, when
TYPE-3 killed W1's tab and forced a fresh unlock: the correct PIN was then refused with *"Votre PIN a
ete change sur un autre appareil. Recuperez vos messages avec votre ancien PIN."*

**Why this is written down rather than fixed here.** Two of the three parts may well be correct. An
unlocked session keeping a key in memory is the design; the refusal message is accurate and names the
remedy. What is NOT obviously correct is the silence: a client whose vault material has been replaced
is, from that moment, one reload away from being locked out of its own history, and it is told
nothing while it can still act. The signal exists on the server (`registeredAt` moved) and reaches no
one.

**What it costs the campaign, which is the immediate cost.** `newdevice.mjs` is the HEAL-NEW runner
and re-minting is its whole job, so every HEAL-NEW row re-registers the verifier and strands W1 and
W2 at their next unlock - hours later, in a different rung, reading as a broken client. Its
`WIPEABLE` allowlist protects the profile it wipes and says nothing about the account-wide effect of
a PIN reset. **A destructive control needs an allowlist of what it may touch**, and the verifier is
outside the one it has.

**THE REPAIR IS KNOWN AND CHEAP, MEASURED 2026-09-04 21:27.** A stranded client is fixed by WIPING
it, not by recovering it: `bun newdevice.mjs --device W1` removed the stale local material, logged
back in with no human step, answered the account's current PIN, minted `...mtnci3lc-7mhd`, and
rejoined all four conversations plus the venue's distribution group by external commit, self-service,
inside a second. The two `pending` seats the old device held on Repro Alpha and Repro Beta went with
it - `READD ... roster seat with NO queued Welcome and NO add in flight - nobody owes us anything;
serving ourselves`. It does NOT touch `pin_verifier`, so the other clients are unaffected, which a
re-registration would not have left true. **What the wipe costs is the local history, and that is
already unreadable by the time anyone notices - so the repair is free exactly when it is needed.**

**Owed before this can be closed.** Whether the same digits re-registered produce a verifier the
other clients would accept (they did not here, so the refusal is about material rather than value);
whether the "ancien PIN" recovery restores a stranded client's MLS state or resets it, which decides
whether a stranded W1 is recoverable or must be re-minted; and whether production has ever put a real
member in this state - `registeredAt` beside each device's `lastSeen` would answer it from the table.

### P3 - a check that dies mid-gesture leaves a file staged in the composer, and the NEXT check sends it (measured 2026-09-04)

MSG-4 stages a file, types a caption and clicks send. When it died between those steps - which it
did all afternoon, on a fixture that did not exist - the composer kept the staged attachment. The
next runner opened the same conversation, typed its own text and sent, and the orphaned file went
with it. MSG-6 recorded `PASS-DIRTY` on `Erreur envoi media: A requested file or directory could not
be found`, an error about MSG-4's fixture, in a check that never attaches anything. Both rows came
back clean once MSG-4 stopped dying.

**Why this is the same fault the campaign already names.** `openDM`'s docblock states that a check
may not inherit a precondition from whatever ran before it, and every runner now navigates for
itself. The composer's staging tray is a piece of state that survives that navigation, so it is
exactly the residue the rule was written about, and nothing asserts it is empty.

**What would close it.** A staged-tray assertion in the shared entry point rather than in each
runner - the same shape as `clearOverlays`, which already runs at the top of `ensureChat` for the
same reason. It is P3 and not P2 only because the dirt is LOUD: it surfaced as a recorded
`PASS-DIRTY` naming a file the check does not use, which is a verdict pointing at its own cause.
The danger is the quiet version - a valid file staged by a check that then passes, sending an
attachment nobody asked for into a row about plain text.

### P3 - TWO out-of-tree directories are both called `canari-harness`, and a decoy `names.mjs` sits in the one the harness does not read (measured 2026-09-04)

The rig keeps its secrets and state outside the public tree, and two different directories now
answer to that description because two tools resolve the same name to different places:

| Reader | Specifier | Resolves to | Holds |
| --- | --- | --- | --- |
| `tools/cross-client-harness/names.mjs` | `../../../../canari-harness/` | `<parent-of-EMSE>/canari-harness/` | `names.mjs`, the three Chrome profiles, `results.ndjson`, `logs`, `test-accounts.json` |
| `tools/play-vitals/lib.mjs` | `../../../canari-harness/` | `<EMSE>/canari-harness/` | `play-console-sa.json`, `google-services.json`, `dumps`, AND a stale `names.mjs` |
| `infrastructure/local/pull-prod-dump.sh` | `$ROOT/../canari-harness/dumps` | `<EMSE>/canari-harness/` | the production dumps |

Both are live and neither is wrong on its own - `names.example.mjs` documents `<repo>/../../` and
`play-vitals/lib.mjs` documents `../canari-harness/`, and each is accurate about itself. What is
wrong is that they share a NAME while meaning different directories, and that the one the harness
does NOT read contains a `names.mjs` of its own: same filename, same shape, same constants, one
`VENUE` line apart. Editing it changes nothing and says nothing, which is exactly what happened
during the venue rename on 2026-09-04 - the edit landed, `grep` confirmed it, and the run kept
printing the old value.

**What is left is the user's one-off**: merging the two directories (or deleting the decoy `names.mjs`) on the workstation; both hold credentials and Chrome profiles a wrong move destroys, so it is not a code change ([ONE-OFF ACTIONS GO TO THE USER](../../CLAUDE.md)). The preflight already prints `rig state: <STATE_DIR>` on its first line.

## The graphical pass - every page at 100 % (user, 2026-09-13)

**The mandate, verbatim:** *"il faudra (re)faire une passe graphique aussi (tester toutes les pages,
voir si tout s'affiche bien a 100%...)"*. Every page, at 100 % zoom, and on a phone width - not a
sample. **The scale to work to is [design-reference](frontend/design-reference.md) - seven
`--text-*` steps and FOUR radii - and no raw hex or px enters any of these.**

**EVERYTHING BUT REAL HARDWARE IS DONE.** The route sweep (every route at 390, 1280 and 1920, nothing
scrolls sideways), its four truncation defects, the truncation census and the many-channels /
long-name halves are closed; the evidence is [design-reference](frontend/design-reference.md)
sections 16, 17, 19-21 and 39, the stories in `CHANGELOG.md`. **What is left is REAL HARDWARE** - all
of it was Chrome with a device-metrics override, and three of three iOS defects were invisible to
every gate here ([device-verification](device-verification.md)). The instrument is
`tools/cross-client-harness/sweep.mjs` (the same three measurements over CDP on A1, W1, or an
iPhone once one is inspectable); CLAUDE.md queue item 16 carries it.

### ONE MEASUREMENT FROM THE 2026-09-14 HARDWARE SESSION IS SUSPENDED, NOT FILED

The "Nouvelle discussion" dialog rendered **no result list at all** on A1 - for an empty query, for
`a` and for `e`, three runs with the field cleared between each so a stale query could not be
blamed. **That is not yet a defect**: the build pointed at `dev`, where the directory the harness
populates does not exist, and an empty estate is the expected reading. It is worth exactly one
re-run against the LOCAL estate, where a directory with people in it exists; what the session
established about reading a device before trusting it is in
[device-verification](device-verification.md).

### P2 - the wry bump that removes the abort, once a STABLE runtime asks for it (found 2026-09-14 on A1)

**THE DEFECT IS CLOSED IN THIS APP AND THE ENTRY SURVIVES ONLY AS A RE-CHECK.** A URL `http::Uri`
cannot parse used to abort the whole process from inside wry's Android JNI frame - SIGABRT, nothing
on either side of the bridge able to catch it. Since 2026-09-15 the app refuses such a navigation
before the WebView starts it (`mobile::navigation::webview_may_load`, wired to `on_navigation`), so
`currentUrl` never becomes the fatal value. The measurement, the predicate and the residue it does
NOT close are on
[mobile](frontend/mobile.md#the-app-owns-which-urls-its-own-webview-may-load); the story is in
`CHANGELOG.md`.

wry 0.56.1 (commit `5ce72b0`, tauri-apps/wry#1772) replaces the `unwrap()` with a `match` that logs and drops the request; the lock here still has `tauri 2.11.1`, `wry 0.55.1`.

**THE CONDITION IS MET (re-checked 2026-10-04), AND IT IS NO LONGER A LOCKFILE BUMP.**
Stable `tauri-runtime-wry 2.12.0` (2026-09-26) and `2.12.1` (2026-09-30) require `wry ^0.57.0` -
past the fix - but also `tao ^0.37.0`, and this app builds against the VENDORED `tao` fork in
`frontend/src-tauri/patches/tao`, which is `0.35.0` (the Android `intent.getType()` null guard,
`[patch.crates-io]` in `Cargo.toml`). So moving to tauri 2.12 means **rebasing that fork onto
`tao 0.37` by hand** (Dependabot cannot, see `.github/dependabot.yml`), then a deep link
(`fr.emse.canari://callback`) and `sweep.mjs --route /posts` on A1 - the fork guards a crash a
compile cannot see. A native work package owed hardware, not an unattended bump.

**Do not "fix" the remaining question by changing the instrument.** `sweep.mjs` found a line that
aborts the process on bad input; changing how it navigates would hide it. Run it as
`MSYS_NO_PATHCONV=1 bun sweep.mjs --route /posts` - Git Bash rewrites a leading-slash argument into
a Windows path, which is how the killer URL was produced in the first place.

## Composer and reactions

### Emoji pictures - the campaign rows, which need real devices

The pictures replaced the font on 2026-09-25 and the mechanism is the whole of
[emoji.md](frontend/emoji.md), the only copy. What remains is below - rows for the **second
campaign**, asked for by the user on 2026-08-23 and rewritten for pictures. Every one names the
evidence it rests on, because "the emoji looked fine" is not an observation.

#### What a future campaign owes

1. **Pictures, not glyphs**, per platform, on W1, W2 and A1 - and the iPhone, where the font never
   drew: every emoji of a message is an `img.emoji` with `naturalWidth > 0`, read from the DOM.
2. **The same codepoint is the same picture on every device.** One message carrying a v1 emoji, a
   country flag, a ZWJ family, a skin-toned person, an Emoji 16 and an Emoji 17 addition, and one sent
   WITHOUT U+FE0F (`📽`); compare the rendered bubble across the clients.
3. **A flag and a ZWJ sequence are ONE picture**, not two letters or five people.
4. **The whole set is reachable in the picker**: scroll to the last row of the last category, on a
   short viewport, with the recents row both empty and full.
5. **The panel is entirely inside the viewport** at each anchor: first message, last message, a row at
   the top edge, one at the bottom, on the own side and the peer side.
6. **French search finds things with a typo** ("ceour") **and English search works with the network
   off** once the dataset is cached.
7. **Pick, send, peer**: the codepoint the peer receives equals the one picked, and it is still a
   CODEPOINT on the wire - copy the text out and assert on it. **WebKit's copy is the unmeasured one**
   (Chromium carries the `alt`, measured).
8. **A reaction** carrying a flag and a ZWJ sequence survives the round trip, including the
   distinct-reaction limit path.
9. **The notification shade is drawn by the OS**, so an emoji in a notification body is the SYSTEM
   glyph. Assert what it does; do not assert that it matches.
10. **Exported artefacts**: an emoji in a poster, a calendar and a trombinoscope PDF is a picture in
    the raster (measured in Chromium through snapdom; owed on the phones that export).
11. **Cold start, offline, on A1**: open the picker with no network and confirm the set is complete AND
    that no request left the device.
12. **The composer on the iPhone**: its emoji keyboard, a paste, and an IME commit each turn into a
    picture with the caret after it, and Backspace removes the emoji whole (measured in Chromium only).

What the pictures do NOT change - the shade, the share sheet, form fields and every other native
surface, drawn by the platform - is stated once, on
[emoji](frontend/emoji.md#what-the-pictures-do-not-change).

## Storage and retention

The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any server storage measurement belongs.

### P1 - the resume reload and the receive ratchet: fixed, owed one device reading; a SEND-side rewind is still unexplained (measured on the Mi 9T 2026-09-08)

The 2026-09-08 captures, the four-row decryption table and the mechanism are on [mls-desync-prevention](protocols/mls-desync-prevention.md#the-resume-reload-re-installed-a-receive-ratchet-behind-the-live-one---the-2026-09-08-captures-mi-9t). **Two defects, both shipped:** A (the duplicate batch, #435, `v0.16.6`) and B (the resume reload rewinding the receive ratchet; #1527 - the native reload refuses `live-ahead`, receives included). **What is owed:**

1. **Defect B on the phone**: resume the Mi 9T right after a received frame with no checkpoint between, and read `[MLS][Tauri] Resume reload SKIPPED` instead of a second decrypt of the same generation.
2. **Defect A's field re-measurement** on a rebuilt APK: the `E/` pair (a duplicate `recevoir_messages_batch` 83 ms apart) must be gone (`adb logcat -v time` during NOTIF-7).
3. **The 2026-09-06 SEND-side rewind**, measured from the PHONE (W1 and W2 saw its read receipt at epoch 139): unexplained, needs a reproduction on the Mi 9T.

**The checkpoint window**: the outbound checkpoint in `emitFrame` deliberately does not await, sized for 1.5 s in August, and costs 17-20 s on a 19.5 MB `mls.bin`, so any death of the process in that window restores a state behind frames that left. **Do NOT "fix" it by awaiting the checkpoint** (refuted in August at 1.7 s per send, seventeen now): the invariant is that a state restored behind a frame that left is RECOGNISED and repaired, which is a counter and a burn.

### P2 - the notification QUICK ACTIONS exist only while the app is DEAD, which is why check K's backgrounded case has never been performable (measured on the Mi 9T, 2026-09-06)

Two posters write Canari's Android notifications and only one of them is the app's own.

| | posts when | style | quick actions |
|---|---|---|---|
| `CanariFirebaseMessagingService.showNotification` | a push arrives - i.e. the app is killed or its ACK was late | `MessagingStyle`, stacked, self `Person` | `buildReplyAction` + `buildMarkReadAction`, always, on any non-`channel_` conversation |
| `useNotifications.svelte.ts` -> `sendNotification` | the JS layer has the frame - i.e. the app is ALIVE, foreground or background | whatever `tauri-plugin-notification` builds | **none** |

The notification record read off the device for a real message received while backgrounded carries
no `actions` at all, and the shade drew no `Repondre`. So the gesture `device-verification.md` step
4 asks for **cannot be made** in the state check K is written about, which is a better explanation of
why that re-measurement has sat unmade since 2026-08-30 than "nobody got round to it": the 2026-08-30
PASS was taken on a KILLED app, where FCM posts and the actions exist.

**This is not the same defect as the missing body** (fixed 2026-09-06 by giving every `sendNotification`
a `largeBody`; see `CHANGELOG.md`). That one was the plugin dropping text it had been handed; this is
the app never asking for the actions on this path at all. WP-XP-1 shipped them believing they were on
every message notification.

**What is owed before anything is written**: decide whether the JS path should post through the
Kotlin service - which already builds the right thing, stacks by conversation, and refreshes the
badge - or grow its own actions. The first removes a poster rather than teaching a second one the
same lesson, and is the shape the rest of this codebase has converged on everywhere else; it needs a
Tauri command bridging into `showNotification` and an answer to what happens on desktop, where
neither the service nor FCM exists. **Check K stays unmeasurable in the backgrounded case until this
is decided**, and `archive/k.mjs` records `SKIPPED` rather than `FAIL` when no reply is made, so a
run cannot be mistaken for a product verdict.

### P1 - THE MINTING LOOP HAS NEVER BEEN OBSERVED ON THE HANDSET, AND A BLOB'S SIZE CANNOT SETTLE IT

Every count this repository has carried for the one-time pool - 3053, 3051, 2782, ten thousand - was
INFERRED from a blob's weight plus an assumption about what else was in it. The full record, the
production populations, and the rules and candidate causes REFUTED on the way are on
[key-package-pool](protocols/key-package-pool.md), the only copy. **Do not re-derive any of it**; in
particular all three reclaims are refuted against this pool (`0 expired, 0 undecodable` on every
census), and the 2026-09-06 prune bounds the ceiling rather than touching the loop that fills it.

**WHAT IS OWED, IN ORDER.**

1. **ONE OBSERVATION OF THE RELOAD PATH ON A REAL HANDSET, READ OVER CDP AND NOT LOGCAT.** The
   instrument ships and ACCUSES rather than refuses: `reconcilePublishedKeyPackages` refuses to purge
   a package this process minted (`publishedThisSession` holds the fingerprints), counts the refusal
   and raises it at `console.error`. The 2026-09-08 attempt drove a full NOTIF phase across the phone
   and found no `[RESUME]` line at all - **which is not evidence the reload never ran**: the success
   path logs at `debug`, which a release build may filter, and the JS half of the sequence never
   reaches logcat, because logcat carries only the native side and the WebView's console is read over
   CDP. So the owed line is one CDP console read across a background/resume.
2. **A DEVICE THAT CAN REPORT ITS OWN STATE CENSUS**, and it is now cheaper than (1): groups, members,
   one-time bundles, last-resort. It would settle this entry, the blob entry and the 2026-09-06
   19.5 MB question in one line each. Filed on the blob entry, where it serves three items.
3. **THE PER-CONNECTION FALLBACK REUSE**, already filed against the blob entry - the same family of
   waste.

**AND THE SHIPPED GUARD CLOSES THE OBSERVED CASE, NOT THE CLASS.** `publishedThisSession` is
per-process and deliberately not durable - the claim it supports is "this process minted these
bytes". Packages minted in an EARLIER session are still purgeable, so a device whose keystore is
emptied and then RESTARTED would run the loop again with nothing to refuse it.

### P2 - NOTHING REPUBLISHES A LAST-RESORT PACKAGE'S EXPIRY, SO THE UNDATED ROWS DRAIN ONLY AS THEIR OWNERS UPGRADE (production, re-measured 2026-09-22)

**DOWNGRADED P1 -> P2 ON 2026-10-01.** Both client repairs below are REFUTED and the entry itself
says it closes on the drain; what is owed is a re-measure and, only if the count floors, the
server-decoder decision. The 1013-key-package web measurement that used to sit above this entry was
closed (`0 expired`, accrual correct by construction) and its numbers are on
[key-package-pool](protocols/key-package-pool.md#a-web-profile-holds-1024-bundles-all-live-and-that-is-accrual-correct-by-construction-production-consoles-2026-09-16).

**The re-measurement this entry was waiting for happened, and it refuted the entry.** The server did
NOT refuse expired last-resort packages: the guard tested `device.notAfter && ...`, that column is
written only by `register-device`, and 683 of 719 rows on production were NULL - so 95% of devices
escaped the refusal entirely. A console export the user took on 2026-09-18 caught one served 3.88
days dead, the join failing on every launch. The shipped half, the one-way bound that needs no client
to speak, and why the two tables need opposite answers are on
[key-package-pool](protocols/key-package-pool.md).

**What is owed is the half a server cannot do.** `lastResortDeadline` condemns the rows it can PROVE dead; the rest stay unjudgeable until their owner re-enrols, because `republishKeyMaterial` refreshes the one-time pool every 30 s and never touches the last-resort row. Both client shapes (carry the date on that routine; re-mint the last resort when it has elapsed) are REFUTED, and not to be re-opened: each is code the client runs, so it reaches only devices already dating their row at `register-device` (`mlsDeliveryApi.ts`, #759, first in `v0.18.10`). Migration 025 (v0.18.12) made the one-time pool TOTAL (0 undated of 31,636, `DEFAULT now() + '84 days'`) and refused the 3 last-resort rows it could prove dead; 677 stayed unjudgeable.

#### THE UNDATED ROWS ARE A CLIENT VERSION, NOT A MYSTERY - AND THEY ARE DRAINING (production, 2026-09-22)

**759 rows, and the split is EXACT on one version boundary with no exception anywhere in the table:**

| `deviceAppVersion` | dated | undated |
| --- | --- | --- |
| `>= 0.18.10` | **162** | 0 |
| `< 0.18.10` | 0 | 134 |
| none at all (a column older rows predate) | 0 | 463 |

`notAfter` is not derived by the server: `register-device` reads `body.notAfter`, so **the column
records whether the CLIENT sent one**. 162 of 162 and 597 of 597, across 28 distinct versions - and
**the cause is confirmed rather than inferred from the correlation**: `git log -S` puts the line that
sends it (`mlsDeliveryApi.ts`) in `f88a65d0b` (#759, 2026-09-16), and `git tag --contains` makes
`v0.18.10` the first release carrying it. The boundary in the table and the boundary in the history
are the same one. So "unjudgeable BY CONSTRUCTION" was the wrong reading - these rows name the
un-upgraded fleet, and nothing about the package or the protocol is unknowable.

**AND THAT IS WHY BOTH SHAPES ABOVE ARE REFUTED.** Each is code the CLIENT would run, so each can
only reach a device already on a build that dates its row at `register-device`. **A repair written
in the client can never be the fix for a population defined by not carrying the client change.**

**THE ROWS DATE THEMSELVES, AND THE RATE IS MEASURED**: 677 undated on 2026-09-18, **597 four days
later** - about 20 a day, through nothing but people opening an updated app. Of the 246 devices
that re-registered in the last 7 days, 162 (66%) were already on `>= 0.18.10`. By age since last
registration the undated residue is 84 under 7 days, 359 at 7-30 days, 76 at 30-60 and 77 at 60-84,
so most of it is devices that simply have not been opened since the boundary shipped.

**ONE SHAPE IS LEFT AND IT IS A SERVER ONE, WITH A COST THIS ENTRY DOES NOT PAY BLIND.** The date is
a property of the `keyPackage` bytes the server already stores, so the server could read it without
any client speaking - which is the only thing that can reach the 597. It would mean decoding an MLS
KeyPackage's leaf lifetime in `chat-delivery-service`, a TypeScript service whose whole design is
that it never interprets MLS bytes, and no decoder exists there. **That is the trade to decide, and
it is the entry - not a count nobody can produce.**

**SO THIS CLOSES ON THE DRAIN, NOT ON A FIX.** Re-measure the table; if the undated count keeps
falling at ~20/day it reaches zero by itself, and the server-side decoder buys only the tail. The
one number that would change the disposition is a floor: an undated count that stops falling while
devices are still registering means a population that never upgrades, and only then is the decoder
worth its cost.

### P2 - the MLS snapshot version is a PER-DOCUMENT counter compared ACROSS documents, so a second tab's write is dropped on a collision (measured on TAB-4, 2026-09-05)

`saveMlsStateEncrypted` refuses any tagged write whose version is not strictly newer than the stored
one. The version comes from `tagMlsSnapshot`, which is `++_snapshotSeq` - a module-level counter,
and therefore **one counter per DOCUMENT**, seeded from the persisted version by
`seedMlsSnapshotSeq` when the tab loads.

Within one tab this is exactly right and is what the guard was written for: a slow off-thread Argon2
flush finishing after a fresher one must not clobber it, and there `version < stored` is a true
statement about ordering.

**Across two tabs it is comparing two unrelated sequences.** Both tabs load, both seed from stored
version *N*, and both then produce *N+1* for their next snapshot - different bytes, same number. The
guard sees `version <= stored` and drops the second one. Measured on TAB-4, which drives two tabs of
one client: `Skipping stale MLS state write (v3294 <= stored v3294)` on an ordinary run.

**What is not yet answered is whether anything is LOST.** The dropped snapshot may hold state the
winner does not - the second tab may have processed a frame the first had not - and the counter
cannot say, because it is not a clock over the pair. In practice a later flush from either tab
carries a higher number and lands, so the state is expected to converge; that expectation is
untested and the window is unmeasured. **A clock written by one writer is not evidence about
another's ordering** - the same rule as a liveness column written by something other than the thing
whose liveness it measures.

The wording is already fixed (2026-09-05): the collision case says so instead of claiming staleness,
and `hex.mlsVersion.test.ts` pins both branches. That makes the event visible; it does not decide
it. Deciding it means either making the version a shared counter (a `BroadcastChannel` claim, or an
IndexedDB read-modify-write inside the same transaction as the put - the transaction is already
there) or establishing that convergence always happens and how long it takes.

## Payments

### A PAID PUBLIC FORM (user, 2026-09-30) - PARKED BEHIND LYDIA, THE FREE HALF IS BUILT

Asked for: a form anyone can open from a shared link, with no Canari account, that can take a single price. **The free half is shipped** (`/f/:id`, migration 068, [forms](frontend/modules/forms.md#a-public-form-is-answered-without-an-account-2026-09-30)); **owed: one guest answer sent from a private window on `dev.canari-emse.fr`, and the `canari-dev-frontend-1` log showing a real client address rather than the Docker gateway** (the `real_ip` change it carries). **The paid half waits for WP-LYDIA-1 below**, because Lydia does not work today and Stripe is leaving the app (user). **Open question first:** does the existing paid-form checkout work at all - read the core-service and social-service logs on dev (the scoping notes are on [forms](frontend/modules/forms.md#the-paid-half-what-it-needs-scoped-2026-09-30)).

### Flipping `payment_provider` from Stripe to Lydia (WP-LYDIA-1)

**The code is not the blocker - it is already written and tested.** `PaymentProvider` is an interface
(`apps/core-service/src/payment/payment-provider.interface.ts`), `LydiaPaymentProvider` implements the
two flows that map cleanly onto it (one-off checkout, session lookup) with its own signature module
and specs, and the choice is a platform config column (`payment_provider`) that **defaults to
`stripe`**. Stripe is what runs today and nothing about that is broken.

What is missing is not code, which is why this is a question and not a P-anything: **the answers
Lydia still owes** (Livrable A, below). **The homologation credentials themselves are no longer
missing** - the `provider_token`/`private_token` pair arrived 2026-09-18 and is in GitHub secrets
(`LYDIA_PROVIDER_TOKEN`, `LYDIA_PROVIDER_PRIVATE_TOKEN`), so `serve-prod.yml` writes them into
`core-service` on the next stable release exactly as it already does for Stripe's. **This does
NOT flip anything live**: `platform_config.paymentProvider` still defaults to `stripe`, an
admin-only switch at `/admin/platform` - the credentials merely make homologation testing
possible once flipped, deliberately, by a human. Everything that does not map - live balance and
status, saved payment methods - throws a documented error rather than faking a result, and that is
deliberate: Lydia has no live status-poll endpoint, and the saved-card flow was **explicitly
dropped by the user** rather than reimplemented, so every purchase becomes its own interactive
request. Do not re-litigate that.

The full provider mapping, the remaining open questions and the credentials still owed are in
[`plans/stripe-to-lydia-migration.md`](../../plans/stripe-to-lydia-migration.md), which the wiki page
[payments](frontend/modules/payments.md) already points at.

Checkout routing and server-side confirmation are shipped: `resolvePaymentTarget` takes the active provider, `POST /api/payments/lydia-request-callback` verifies the signature and fans out through a shared `order_ref` (`lydia-order-ref.ts`) - mechanism on [core-service](services/core-service.md#payments-stripe--lydia).

**What still blocks actually flipping the switch:**
1. **The payer's address shipped (2026-10-05)**: the PAYER TYPES it at payment (`PayerEmailPrompt`, only when the provider is Lydia), it is never stored ([payments](frontend/modules/payments.md#the-payer-types-an-e-mail-and-lydia-bounds-the-amount-2026-10-05)). **NOT yet observed end to end**: it needs a dev pre-release and one homologation payment.
2. **The `business/create` `BUSINESS_VALIDATED`/`BUSINESS_UNVALIDATED` webhook is deliberately not
   built.** It has no documented signature and `vendor_token` is PUBLIC - building it as-is would let
   anyone knowing another association's vendor_token forge or break its `lydiaOnboardingComplete`,
   with no resync since Lydia sends the event once. Add "does `business/create`'s `webhook` param
   have a signature scheme?" to Livrable A below before building this.

---

### Removing Stripe from Canari - decided by the user 2026-10-05, NOT started

"In fine il va falloir tout enlever (a minima archiver) ce qui concerne Stripe" (user). 129 files
mention Stripe (counted 2026-10-05 with `git grep -il stripe` over apps, frontend/src, infrastructure
and .github; `bun.lock` and generated Paraglide output not excluded by the count, so treat it as an
order of magnitude). **Nothing here is safe before Lydia has taken a real payment in production and
every residual Stripe balance has been paid out** - the dependency order is the whole plan:

1. Lydia live (production tokens, `LYDIA_ENV=production`, each club re-onboarded) and one payment
   observed end to end, callback included.
2. Residual Stripe Connect balances paid out (three prod associations are onboarded on Stripe today).
3. Then, one pull request per layer, each green alone: the saved-card surface
   (`setup-payment-method`, `payment-methods`, `charge-*-saved-method`, `PaymentModal`,
   `SettingsPaymentsSection`, `SavedCardsList`, `AddCardForm`, already dropped BY DECISION for Lydia);
   `StripePaymentProvider`, its webhook, `stripe-*.ts`, `stripeFees` and the SDK dependency; the
   `stripe*` columns and `paymentProvider`'s `stripe` value (a migration, never a rename); the
   `STRIPE_*` secrets in CI, compose files and `infrastructure/MIGRATION.md`; the CGU and privacy
   text naming the processor.
4. "Archive" = delete from `main` and keep the commit reachable under a tag (`archive/stripe`);
   no dead code stays in the tree (CLAUDE.md: delete unused code immediately).

Until then the platform switch `payment_provider = disabled` is the kill switch, and
`stripeAccountId` columns must keep being written by nothing but the Stripe provider.

---

### P3 - an admin who never joined a private salon is not told when it is deleted

`channelAudience` is the salon's roster, and since 2026-08-19 an administrator reaches a private
salon by JOINING it rather than through `workspace.manage` - so one who has not joined is not on the
roster and receives no `channel.deleted`, nor any other event the salon emits. They ARE shown that
the salon exists (name only, `viewerHasAccess: false`), so their sidebar keeps a row for something
that is gone until their next load.

**Not fixed by widening the audience**, which is the obvious move and the wrong one: that is exactly
what put every private salon's messages, typing, pins and poll tallies on the socket of members the
same server refuses to serve them over REST, and it was closed this week. The shape that would work
is a separate, contentless `channel.gone` addressed to the community - worth doing only if the stale
row is ever seen to matter, since a reload clears it and nothing is wrong underneath.

### P2 - WP-RESTORE-1: Zero-Tap Sign-In restoration, required by Google Play from April 2027

**Play's requirement, verbatim in substance:** an app that supports user sign-in, optional or
mandatory, must support Zero-Tap Sign-In restoration when the user moves to a new Android device.
Mobile and tablet only. Games are exempt; Canari is not. Enforcement begins **April 2027**. Three
exemptions exist and none obviously fits us: a Block Store integration completed by **30 September
2026**, enterprise or permanently-private apps, and a regulatory exemption requested for
financial/healthcare mandates.

**The mechanism is the Restore Credentials API**, and a restore credential is a system-managed
WebAuthn public key credential - a passkey the user never sees, tied to the package name, created
silently after sign-in, backed up with the device and readable on the new one during setup. It is
`androidx.credentials`, minimum Android 9 (our minSdk is exactly 28, so every install qualifies),
GMS core 24220000 or higher. **It works regardless of `android:allowBackup`**, which matters here:
the credential lives in the system credential store, not in app data, so it is orthogonal to the
device-transfer exclusion shipped on 2026-08-26 and does not reopen it.

**What this costs is a server we do not have.** `grep` over `apps/core-service/src` for `webauthn`,
`passkey`, `publicKeyCredential` and `fido` returns NOTHING: there is no WebAuthn registration or
assertion endpoint anywhere, and a restore key needs both - a `PublicKeyCredentialCreationOptions`
to create, an assertion to verify, and a store that keeps restore keys distinguishable from real
passkeys. Canari's session model is an opaque refresh row plus a stateless 1 h access token
([sessions](sessions.md)); a successful assertion has to mint exactly that pair.

**THE PRINCIPLE IS DECIDED - THE USER ACCEPTED IT ON 2026-08-26, AND THE WORK IS SCHEDULED AFTER
THE CAMPAIGN.** The question put to them was not technical: zero-tap means the new device is signed
in with no password and no second factor, and Google's documentation states plainly that the API
"does not handle multi-factor authentication", while Canari has 2FA and SETUP-4 exists because
re-enrolling a device costs one. It was accepted on the ground below - a restored session
authenticates, it does not decrypt - and because the exemptions on offer (enterprise, permanently
private, financial or healthcare regulation) do not describe a student messaging app, so refusing
would have risked a publication block rather than bought time. **Do not re-open the principle; what
is open is the build, and it does not start before the ladder reaches the bottom.**

**What it does NOT restore, and why that is fine.** Keystore material is non-exportable, so the MLS
device key does not travel. A zero-tap sign-in authenticates; it does not decrypt. The new device
still enrols as a new MLS client and is re-invited, exactly as
[frontend/backup](frontend/backup.md) already describes for a restore onto a different device. The
feature is therefore coherent with E2EE - it removes a password prompt, not a re-enrolment.

**Three traps to carry into the work when it is scheduled:**

- **The logout half is a requirement, not a nicety** - Play requires the restore key be deleted when
  the user signs out. Canari's logout lives in TypeScript, so this needs a Tauri command down to
  `ClearCredentialStateRequest(TYPE_CLEAR_RESTORE_CREDENTIAL)`, and it must run on the paths that
  log out WITHOUT a user gesture too - a 401/403, a revoked session.
- **The library is `1.7.0-alpha03` at the time of writing.** An alpha is not shippable on the
  release track here; check for a stable line before starting, not after.
- **`E2eeUnavailableException` is expected, not exceptional** - it fires when the user has no screen
  lock or no Google backup, and the documented handling is to retry with `isCloudBackupEnabled =
  false`. That is a second path, so it is logged at a level that accuses and its rate is measured
  before anyone believes what it says.


## Tooling

### P2 - a cargo bump in `mls-core` leaves two committed lockfiles Dependabot will never fix

`frontend/mls-core` is a library: its `Cargo.lock` is gitignored. `frontend/mls-wasm` and
`frontend/src-tauri` are binaries with COMMITTED lockfiles, and both depend on `mls-core` by path -
so every crate `mls-core` names appears in their locks too.

**Dependabot opens one pull request, against `mls-core/Cargo.toml`, and that pull request is
incomplete by construction.** There is no manifest to change in the other two directories, so their
locks keep the old version and CI's `Refuse a lockfile the manifests no longer describe` step fails
with `cannot update the lock file ... because --locked was passed`. Measured on PR #300 (argon2
0.5.3 -> 0.6.0, since CLOSED unmerged - the class still holds): four jobs red, two of them for this
reason alone and nothing to do with argon2.

This is not a ceiling refusal - the gate is right to fail, the pull request really is unmergeable -
and it is not something `@dependabot recreate` can fix either. **It is the one shape of dependency
update in this repository that CANNOT be merged unattended**, which is what makes it worth a row.

**The remedy, named rather than done:** make `frontend/` a single cargo workspace with ONE
`Cargo.lock` covering `mls-core`, `mls-wasm` and `src-tauri`. One lock means one resolution, so
Dependabot's pull request is complete again and the class of failure disappears. It was not done in
the same pass as the argon2 bump because `src-tauri` is the crate whose build this workstation can
only COMPILE - never run on iOS or macOS - and restructuring a Tauri build is not a change to make
where the only available gate is `cargo check`. Until then, a bump of any crate `mls-core` names is
done by hand in one commit that refreshes all three locks, and the Dependabot pull request is
superseded rather than merged.

### P1 - TWO CLASSES OF DEPENDENCY UPDATE STILL CANNOT MERGE UNATTENDED, AND EACH NAMES ITS MISSING TEST

**`ci.yml`'s `Dependency ceiling` check refuses only what this repository has no gate for**, and
every refusal names its missing test in its own annotation (`::error title=No gate would see this
fail::`), which is part of `CI passed` and therefore binding rather than advisory. The standing directive is that a refusal is
never a routing decision to a human queue (user, 2026-08-31), so THIS TABLE IS THE WORK: each row
closed is a whole class of update that starts merging on its own. Five rows closed between
2026-08-31 and 2026-09-15 and are not repeated here - the gates they bought are in `CHANGELOG.md`
and [cicd](cicd.md). **Quote no refuse COUNT from anywhere**: the hourly sweep that used to print one
was deleted 2026-09-04, so the only current reading is `gh pr list --app dependabot` with the
ceiling check's annotation on each.

| Refused | Why the suite cannot see it | The test that retires it | State |
| --- | --- | --- | --- |
| `webrtc` and the ICE crates (no PR open as of 2026-10-01; the last, #431, was CLOSED) | the SFU has ten tests and not one touches the ICE stack | one relay-path call - campaign rung 15 CALL, which has no runner | not started, and the SFU is already SIX majors unplaced (see "the SFU runs SIX webrtc majors it has never placed a call on" in this file). **AND THE NEXT ONE IS A PORT, NOT A BUMP** - `webrtc` 0.20 is a rewrite onto the Sans-I/O `rtc` crate and gives 26 errors against this SFU, measured 2026-09-15, so the call comes after the port |
| `stripe` | **half of it the compiler already sees, and that half is safe.** The SDK types `apiVersion` as the literal its release was cut against and this service pins that value in one constant, so a bump that still COMPILES cannot change which API the app talks to and merges like anything else. A bump that crosses an API version stops the tree compiling in four files at once. What no gate can answer is whether the app still READS what the new API sends - payload shapes and object fields are what an API version decides | fixtures per API version for this service's Stripe surface: the events `webhook.controller.ts` handles and the fields `stripe-payment-provider.ts` and `users.service.ts` read, so a crossing is proved rather than read in a changelog | open, and no Stripe bump PR is open as of 2026-10-01 (#304, 22.3.2 -> 22.6.x, was CLOSED unmerged; it wanted `2026-08-26.dahlia` where the constant says `2026-06-24.dahlia`, and CI was red on exactly those four files). The next crossing is the live case. Crossing it is a decision about PAYMENTS and therefore the USER's - see `apps/core-service/src/payment/stripe-api-version.ts`, which says so in its own docblock |

**ONE FLAKE IS RECORDED HERE BECAUSE AN UNATTENDED MERGE IS EXACTLY WHAT A FLAKE BREAKS.**
chat-delivery-service's suite failed 1 test in the first of five consecutive local runs on
2026-08-31 and passed 308/308 in the other four; the failing run was concurrent with a CD build on
the same machine, and its output was not captured. Not reproduced, not identified. If it recurs,
capture the suite name before anything else - a green-gated auto-merge that retries into a green run
will merge on the second try and tell nobody.

**Do not widen this list to feel safe.** Every entry costs the queue it blocks, and the honest test
of a new one is: name the failure, then name the test that would have caught it. If you cannot name
the test, the entry is a guess.

### P3 - `submissions.formId` names a form nothing keeps, and 28 rows point at deleted ones

**Measured on prod 2026-08-31.** There is no foreign key at all:

```sql
SELECT conname FROM pg_constraint WHERE conrelid = 'submissions'::regclass AND contype = 'f';
-- (0 rows)
```

Twelve `formId` values in `submissions` match no row in `forms`. Of the 28 orphaned submissions,
**5 are `paid`** (36,00 EUR in total), 6 `pending` (101,00 EUR never charged), 16 `free` and 1
`cancelled`. Only one form of the thirteen referenced still exists. The amounts date from May and
June 2026 and read as forms from the development period, so this is P3 on the money and P3 on the
count - but not on the shape.

**What it costs today**: five people have a paid line whose title nobody can render, and
`markPaid`'s own `grantCotisationIfConfigured` would have had nothing to read either. Deleting a form
also strands whatever `user_tags` its `grantsCotisation` had issued, which no longer names anything.

**The decision this needs is not "add a foreign key"** - a cascade would DELETE paid submissions,
which is worse than the orphan. The shapes worth weighing are a tombstoned form (soft delete, the
title survives, the join keeps working) or a denormalised `formTitle` on the submission at write
time. The first keeps one truth; the second survives a hard delete. Neither is obviously right,
which is why this is written down rather than done.

### P3 - 108 navigations bypass `resolve()` (92 here, 16 on MiGallery, counted 2026-08-27), and an inherited disable is the only reason nobody sees them

**The Canari half is done (2026-10-05)** - every call site goes through `resolve()` (`internalPath()`, `src/lib/utils/internalPath.ts`) and the lint gate is the test that the sweep stays complete. **What is left is MiGallery**: `../MiGallery/oxvelte.config.json` still disables `svelte/no-navigation-without-resolve` (verified 2026-10-06; 16 call sites, 86 vs 70 findings with the file moved aside). Work: wrap them in `resolve()` via the same `internalPath()` pattern, then delete the disable. **Measure by MOVING the file, never by dropping `--config`**: oxvelte finds the file in the working directory either way, and that comparison is a thing against itself.

## Localisation

### P2 - NO REFUSAL CAN BE TOLD FROM ANOTHER, BECAUSE ONLY SOME ENDPOINTS CLASSIFY AT THE THROW

The sweep that stopped the server's English reaching a French screen is finished - `src` is owned
whole by `frontend/src/lib/associations/serverProse.test.ts`, which walks 1 004 hand-written sources
and holds ONE allowlist entry. The mechanism, the rule it enforces and the two routes to a localized
line (`LocalizedError` for a throw whose message is the reader's, `describeApiRefusal` for a status)
are on [durable-rules](durable-rules.md) and
[social-service](services/social-service.md); the passes are in `CHANGELOG.md`.

**WHAT THE SWEEP NEVER NEEDED IS STILL OWED.** Not showing English needed nothing from the server;
distinguishing one refusal from another does, and that is **a code at the THROW, per endpoint**. The
shape to copy is the delivery service's `DEVICE_REVOKED` / `DEVICE_LIMIT_REACHED`, and
`PARTNERSHIP_NO_CODES_LEFT` plus its three siblings. It is per-endpoint judgement about which
refusals a user can ACT on, never a mechanical rewrite - which is why it is endpoint by endpoint,
most-used screens first. Until an endpoint has one, a screen that cannot map a refusal shows a
generic localised line, which is correct and uninformative.

**AND ONE SITE CANNOT CLOSE ALONE.** `sessionAuth.ts:793` compares an error against the shared
constant `MLS_LOCAL_STATE_UNDECRYPTABLE` - stable matching, but the defect is upstream:
`classifyStateLoadFailure` already separates `sealed` (an old PIN opens it) from `unknown`
(corruption, no PIN helps), and both throws collapse the two into that one marker. Typing the marker
without deciding what the screen DOES with `unknown` ships the same wrong diagnosis behind a better
shape. It closes with the P1 that reports a damaged MLS state as a PIN rotation. It is the guard's
one allowlist entry, and that entry FAILS the day the site stops offending, so it cannot rot while
the P1 waits.

## Infrastructure

### P2 - MIGALLERY'S ONLY OFFSITE STILL LANDS ON THE OLD CANARI VM

Sky took `sky.emse.fr` on 2026-09-28; the old name is a pure `301` and the relay on `mitv` stays on purpose ([estate-migration](infrastructure/estate-migration.md)). What is left:

- **MiGallery's offsite still lands on the old Canari VM, and it is its ONLY offsite.** `mitv` root's `backup-offsite.sh` (~2 GB/night) pushes the Immich dump to `canari:~/migallery-offsite`. It needs a destination off `mitv` (the School host, on the private path) before the old VM can be wound down - the user's decision, then a MiGallery PR.
- **The user's gestures**: a real Sky sign-in with `/admin/legacy` showing the June data, and deleting the stopped `sky-sky-1` container with `/home/mitv/Sky/database`.

### P2 - A DEFECT REPORTED AFTER A DEPLOY HAS NO EVIDENCE, BECAUSE A DEPLOY DESTROYS IT (measured on production 2026-09-21)

**FOUND WHILE DIAGNOSING A REPORT, WHICH IS THE ONLY WAY THIS ONE EVER GETS FOUND.** A member could
not publish a post from their phone; the investigation read `infrastructure-frontend-1` and
`infrastructure-social-service-1` for the hour, found no `POST /api/posts` and no error, and
concluded the request had never left the device. **That conclusion was one step further than the
evidence went**, and the reason is this entry: both containers report `StartedAt` of
`2026-09-20T21:46:52Z`, so nothing before that moment existed to be read. The hour that was read was
the hour the REPORT arrived in, not the hour the attempt was made in.

**THE MECHANISM, SHOWN GONE RATHER THAN ASSERTED** (read on the old origin 2026-09-21; the compose files still carry no `logging:` stanza). `docker inspect -f '{{.HostConfig.LogConfig.Type}}'`
returns `json-file` with an empty config on every service; `/etc/docker/daemon.json` sets `dns` and
nothing else; and no container on the box runs loki, promtail, fluentd, vector or filebeat. So a
container's own stdout is the whole record, it has no `max-size` and no `max-file`, and a deploy
RECREATES the container rather than restarting it - which deletes the log file with the container it
belonged to. Every deploy is therefore a full erasure of production's only observability.

**WHY THIS IS P2 AND NOT P3.** The window it destroys is exactly the window that matters. Reports
arrive from students hours to days after the fact, and deploys are frequent because the release
cycle is designed to be; the two together mean the default outcome for a user-reported defect is
that its evidence is already gone. This one cost a wrong conclusion that was written into a wiki
page before it was caught - *a claim that something is stale must name the mechanism that would
honour it and show that mechanism gone*, and here the mechanism was believed to exist.

**WHAT WOULD SETTLE IT.** Any sink that outlives a container recreation. The cheapest is a logging
driver with rotation writing outside the container's lifetime; the honest one is a collector, since
the box already hosts the dev estate beside prod and a per-container file answers no
cross-service question. **Not decided here** - the shape is the open question, not whether it is
needed. Re-read the disk on the Portail-etu host before sizing a sink: the 2026-09-21 reading (`/` 43 % used) was the old origin's.

---

### P3 - docker-prune is not shown running on the Portail-etu host

`infrastructure/docker-prune/` (`prune.py`, README) reclaims dangling images and build cache and only REPORTS volumes; the 2026-08-27 measurement concerned `canari` and `mitv`, which no longer run production. **Open:** install it on the Portail-etu host with a project filter ([estate-migration](infrastructure/estate-migration.md): no `docker system prune` without one) after one read-only `docker system df`, and update the README's "Installing it". **SINCE 2026-10-06 PRODUCTION DEPLOYS `v<version>`**, so a replaced image keeps its tag, is NOT dangling, and neither a plain prune nor `prune.py`'s dangling-only allowlist reclaims it (eight images per stable): add an allowlisted removal of `ghcr.io/emse-students/canari/*:v*` images that no container runs and that are not among the newest N releases (the rollback margin). Dev still pulls its moving `dev`. **Dangling VOLUMES are never pruned by a flag**: enumerate by name against an allowlist ([databases](infrastructure/databases.md#reaching-it-from-a-workstation)).

## What the duplicated group notice left behind (2026-09-16)

### P2 - nothing repairs a notice already duplicated on a device, and nothing should, blind

Owed: the POPULATION first - on one real device, the count of `isSystem` rows sharing
`(conversation, content)`. Only if that number is large is a repair worth its risk, and then only
the repo's shape for one: a one-shot pass gated on proof that the state is broken, an allowlist of
the rows it may delete, and a report of what it did. Never a heuristic collapse.

### P2 - 13 full archive walks and 37 reconciliation answers in ten minutes, for one group

Owed (production logs): with `[HISTORY]` / `[HISTORY_BATCH]` now carrying `user=... device=...`,
measure walks per group per hour across the estate and the `after=start` fraction per DEVICE.
Only against that population is one group being built (31 members in batches) a defect or not.
The 2026-09-16 measurement it replaces (one prod group, 31 members, 14:17-14:49): 13 `[HISTORY]
after=start` walks (two in the same second), two cursor resumes from before the announcement, 37
`[HISTORY_REQ] FORWARDED` over seven devices (8/7/6/5/5/4/1) and 14 `NO_PEER_ONLINE` - unattributed,
since it predates the `user=`/`device=` fields.

## Post-campaign projects - decided, not scheduled

### The MLS + Graine explanation, written FOR THE USER - audience settled 2026-08-20

**Asked for earlier, deferred on one question: who reads it.** Three audiences were offered and the
user chose the first outright.

**Who it is for: the user.** What is guaranteed, against whom, and - as loudly - what is NOT.
Prose and diagrams. **No file names, no function names, no code**, because those are what a
maintainer needs and this is not for a maintainer. Readable end to end in one sitting, which is a
length constraint and therefore a selection constraint: everything that does not change what the
reader can conclude is cut.

**What it must contain, since the whole point is the boundary.** What the server sees (ciphertext,
sizes, timings, who talks to whom) and what it cannot see. What a community's shared key means: every
member of a community holds the key to every PUBLIC salon in it, by design, and until 2026-08-20 to
every private one too. What a private salon's own group changed, and what it did not - an admin now
JOINS and is visible in the member list; forward secrecy was decided AGAINST, deliberately, and the
document says so rather than omitting it. What leaving, being removed, and being re-invited actually
do to the keys. What a stolen device gets, and what the PIN does and does not protect.

**The two audiences declined, recorded so the choice is not re-litigated.** A maintainer's page (file
names, invariants, where each is held) would be a wiki page more, long, needing to stay synchronised
- the wiki already carries that, split across
[mls-protocol](protocols/mls-protocol.md), [graine](protocols/channel-encryption.md) and
[the state machine](protocols/mls-graine-state-machine.md). A security
assessor's document (explicit threat model, what an excluded member can do) is the most demanding of
the three and nobody has asked for one.

**Written AFTER the campaign**, because the campaign is what turns the design into something
measured, and a document that says "this is guaranteed" before anything has run is a claim about a
file rather than about a system.

### One MLS client in a SharedWorker - decided 2026-08-17

**It would remove the multi-tab class outright**, and that class is not theoretical: W2 was measured
carrying seven `canari-emse.fr` tabs, each a full MLS client with its own gateway socket and its own
in-memory counters, sharing one IndexedDB key. Two campaign findings dissolved on that fact alone
(see [testing-methodology](testing-methodology.md), rule 5), and the harness's answer - `client()`
refusing an ambiguous browser, `onetab.mjs` repairing it - protects the INSTRUMENT and not the user.

**Why it is not a queue item.** The cost is not the worker: it is the worker TRANSPORT, the startup
sequence, the PIN unlock and the Safari/mobile fallback, all of which have to be redone. Doing it
before the campaign would invalidate every verdict already taken, since the boot path is what half of
them measure.

### `dev.canari-emse.fr` - the two things that outlived the chantier

The environment is built (2026-09-01) and is the pre-release target. **Every decision about it -
isolation, the unscrubbed prod copy, `DEV_<NAME>` secrets, Access, how a release picks the estate -
is on [dev-environment](infrastructure/dev-environment.md), the only copy, and is TAKEN.** One thing
outlived the chantier:

1. **Phase 2, mobile, is OWED TO THE USER and nothing here can do it.** The dev Firebase project -
   the Play service account holds only `androidpublisher`, not `serviceusage.services.enable`, so it
   can neither create a project nor turn an API on - and the dev keystore, plus a decision on where
   that keystore is backed up. See the table at the top of this file.

### A SECOND campaign, for everything that is not chat - asked for 2026-08-16

**It is a second campaign, not more sections on this one** - the user's framing, and it settles a
structural question. The expected size is dozens of checks per surface, where the current dashboard
already carries 18 sections in one file whose entire job is to be a LIVE summary someone can read.
Pouring a second campaign into it destroys that property. So: its own dashboard, its own manifest, its
own phase files - and `checks.mjs`'s phase list is the seam to look at first, since a second campaign
must be runnable without re-running this one.

The 18 sections were written around one class of failure: a message crossing between two transports
and two platforms, and the silent loss that class produces. That leaves whole surfaces with **no check
at all** - posts, forms, communities as a management surface, profiles, media browsing, calendar,
payments - and a surface with no check is not a surface that works, it is one nobody has asked about.

The named starting point is the **`social` notification family**: a post, a comment, a reaction on a
post, a form alert. It does **not** share the chat path - no MLS, no per-device fan-out, no outbox -
so none of the verdicts already taken transfer to it, and its delivery is server-decided, which is a
different failure mode (an audience computed wrong notifies the wrong people, and nothing on the
client can detect that).

Three things must be settled BEFORE writing checks:

- **The venue.** Every existing check sends into the two-test-account DM or `Canari Test Venue`
  precisely because production is shared. A post or a form alert has an AUDIENCE, so the same
  discipline needs an answer that does not exist yet: what does a test post look like that no real
  member is notified by? Until that is answered, no social check may run on prod.
- **The observer.** `srvlog.mjs` partitions its window by subject and classifies every line. The
  services behind posts and forms are not in that window today, and an unclassified window is not an
  observation.
- **What a verdict rests on.** A chat check reads the peer's DOM. A notification with an audience is
  only correct if the people who should NOT get it did not - an assertion about absence, over a
  population, needing its window sized from a measured latency rather than guessed
  ([testing-methodology](testing-methodology.md), rule 13).

**The twelve emoji rows belong to this campaign** - they are listed under "Emoji pictures - the
campaign rows" (section Composer and reactions), which is their only copy.

## THE DELIVERY CHAIN REVIEW - opened by the 2026-09-06 outage, agreed with the user the same night

*"C'est peut-etre pour ca qu'apres la resolution rapide de ce probleme, il faut qu'on revoie le
workflow"* (user, 2026-09-06), after an earlier exchange in which the complaint was READABILITY -
*"C'est pas un peu alambique tout ces workflows ?"*. The outage turned that into seven items (items 1 and 5
shipped) that are DEMONSTRATED rather than argued. Ordered by value, which is not the order they were noticed in.

**2. A DEPLOYED ESTATE IS NOT ASKED WHETHER IT WORKS.** P1, and it is what let this reach users.
The release run was green, `canari-emse.fr` and `dev.canari-emse.fr` both answered `HTTP 200`, and
every login was refused. `CLAUDE.md` already says a green deploy proves the containers started and
never that the site answers; **answering does not prove it works either**.
`tools/cross-client-harness/deployed-wasm-check.mjs` was written during the incident and refuses an
estate serving a wasm that can panic - it named `mls_wasm_bg.YXThuGSF.wasm` on production, the exact
file in the user's stack trace, with no credentials and in seconds. **SHIPPED 2026-10-06 as a gate**:
`serve-dev.yml` runs it before `dev-deployed` moves, so a refused wasm cannot reach a stable
([cicd](cicd.md)). It is NOT a login and must not be sold as one - the sign-in below is what stays open.

**The honest check cannot be a campaign row**: the rig has targeted the LOCAL estate since
2026-09-03, deliberately, and the next defect of this class may not be in the wasm at all. **The real
check is a sign-in against the deployed estate, in the pipeline, right after the dev deploy and
before the stable is allowed to proceed.** That needs a USER decision rather than code: a dedicated
smoke account on both estates, its credentials as GitHub secrets, and accepting that a CI job holds a
real login on production. **The alternative - that nobody signs in before users do - is what happened
on 2026-09-06.**

(Items 1 and 4 to 7 are closed: 1 and 4 shipped, 5 shipped in `v0.18.18`, and 6 and 7 were DECIDED
not to be built, with the reasons on [cicd](cicd.md#two-incident-time-items-decided-not-to-be-built-2026-10-06).
**Any proposal here must keep four visible workflows** - user, not to be relitigated.)

## The first iOS feedback (2026-09-20) - one reading and one measurement

- **One reading on the reporting iPhone**: the `/posts` and associations scroll, on a build carrying
  the fix ([design-reference section 28](frontend/design-reference.md#28-every-scroll-in-the-app-ran-on-the-main-thread-for-a-gesture-ten-prefixes-cannot-perform));
  the Mi 9T settles only Chromium, and WebKit is the engine that reported it.
- **P3 - one memory measurement on a long feed**: the feed is not virtualised (the composited layer
  grows with every page), and the avatars carry no `loading="lazy"` on purpose (a cached blob sets
  `imageLoaded` eagerly; a lazy one would show an empty disc mid-fling). Measure before changing
  either.

---

## Audiences of associations, lists and institutions - decided by the user 2026-10-07, ready to build

Seven decisions, in the user's answers of 2026-10-07 (the last one asked for Master's opinion and was accepted as recommended):

1. **The manager chooses among THREE presets**, never the raw grid: my campus; my campus plus the formations I name; everyone. `everyone` is offered to institutions only. The global admin keeps the full grid in Espaces & audiences.
2. **Default at creation**: the association's campus, every formation, applied automatically and editable. A list gets the same default.
3. **An association present on two campuses is TWO associations**, partners on a shared event (D39, migration 074); there is no multi-campus audience on one entity.
4. **A change of audience applies to everything, past posts included**: visibility follows the current rule, nothing is frozen on the post.
5. **A manager with no campus completes their profile first**: the presets are computed from a campus.
6. **Only institutions, created by a global admin, may target everyone.** The server REFUSES an `everyone` rule on any other type - the UI hiding it is not the rule.
7. **The star (space BDE) may set the audience of the associations of ITS campus, and only that**: the super-role "manage associations" includes the audience, bounded to the BDE's own campus; never another campus, never an institution.

**WP-A (server) BUILT 2026-10-08**, as built in [profiles-and-access](profiles-and-access.md#audiences-policy-as-built-wp-a-2026-10-08); **WP-B (client + creation bound) BUILT 2026-10-08**, as built in [profiles-and-access](profiles-and-access.md#audiences-client-presets-as-built-wp-b-2026-10-08); owed: one look at the Audience tab and the prompt on a signed-in estate (not rendered by the agent), and the user's call on letting a BDE star READ `GET /api/associations/:id/audiences`.

Work packages: (a) server: default rule at creation, refusal of `everyone` outside institutions, the BDE's campus bound on writes, with tests; (b) client: the three presets on the association page for a manager and a BDE, the profile prompt for a campus-less manager; (c) wiki: [profiles-and-access](profiles-and-access.md) D-section. Done when a manager of a fresh association sees it reach its campus with no setup, can narrow or widen it to the presets, and a hand-written `everyone` is refused by the server for a non-institution.

---

## Nominative read access to the student feed - decided by the user 2026-10-07, built WITH the audiences chantier (1.2)

This is WP7 of [profiles-and-access](profiles-and-access.md) (D24: grants only ADD, a global admin grants across spaces), given its first capability. Cases named by the user: Celine Haton (director of the ME), Aurelie Boyer (ME communication) and Julie Blanc (School, student liaison) reading the posts of associations, **but not the personal posts of students**; and a director of formations reading the associations of Saint-Etienne and Gardanne, formations ICM and another.

Decisions:

1. **A grid of checkboxes per person**, shaped like `/admin/spaces`: one cell per campus x formation (and "whole campus"), so one grant can cover several campuses and formations. It replaces the document-reviewers page, whose rows migrate into it.
2. **Covers**: the posts of associations, lists AND institutions of the ticked spaces - an institution of ANOTHER campus too, which its own audience (whole campus) never shows a reader of this one - with their comments and reactions, and the events and agenda of those associations.
3. **Never** the personal posts of students: the capability reads posts published AS an entity, nothing else.
4. **Readers may react and comment**, like any reader of the feed.
5. A global admin grants it (it crosses spaces); a BDE would grant only inside its own space. The grant ADDS to what the population gives and never removes.
6. This closes the staff-feed question: staff without a cursus see nothing more by default, the named ones do.
7. **No end date, ever** - only grant and revoke. **The list of named readers is internal**: only global admins see it; students are not told. **A journal** keeps who granted what to whom and when (`granted_by`, date), visible to global admins.The user's example formation "ISTP" is FSSS (answered 2026-10-07): no new formation. Done when a named reader sees exactly the association, list and institution posts of their ticked cells and no student's personal post, and a reader with no grant sees what they saw before.

---

## Answers of 2026-10-07 that fix the order of work

- **Named readers (the nominative read grants above) only READ and react**: publishing goes through an institution (D31), a separate gesture; they get NO notifications for their perimeter.
- **1.1.2 carries nothing more** than what is already in it (deploy order, the author of an association post notified, edit caret and banner, own-space agenda, the Lydia fixes, the three-section Spaces page, institutions UI). **Stripe is removed in a dedicated batch AFTER 1.1.2.**
- **`minClientVersion` rises after 1.1.2, once both stores serve at least 1.0.3** - the user's gesture; G3 of Graine v2 waits for it.
- **The Lydia payment is tested end to end on dev by Master alone**, on a test account.
- **The staff accounts labelled EMSE that are ME** (Aurelie Boyer, Celine Haton) get `posts=["ME"]` in Authentik BY THE USER, from a table Master hands over.
