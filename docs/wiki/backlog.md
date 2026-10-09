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
carries what shipped. Left, in order: (1) the members are added AFTER creation on the generic edit page
(its title says "Gestion de l'institution" since #1569); (2) the reach of an existing institution is
edited only on the `/admin/spaces` grid, its edit page has no reach control (the "Audience" tab of #1584
is for associations and lists, institutions keep the grid); (3) the creation form picks ONE rule, a union
of several (two campuses) goes through the grid; (4) no reading on a phone with a real global admin
account yet (the local read used the sandbox admin). The audience policy, presets and read grants are
BUILT (#1582, #1584, #1593, #1606, #1608, [profiles-and-access](profiles-and-access.md#audiences-policy-as-built-wp-a-2026-10-08)); owed there: one look at `/admin/read-access` signed in.

## Cloudflare, Stripe and the staff feed (2026-10-07/08)

### P1 - an upload over 1 MiB is refused with a 413 on `dev.canari-emse.fr` and `canari-emse.fr` - the relay's nginx, one line (cause found 2026-10-09)

NOT a Cloudflare rule: the 413 page body is nginx's, and both relay files on the old VM lack
`client_max_body_size` (default 1m). Measurement, the two lines to add and the verification are on
[cloudflare-edge](infrastructure/cloudflare-edge.md#a-request-body-over-1-mib-is-refused-with-a-413-on-the-legacy-names---it-is-the-relays-nginx-not-cloudflare-measured-2026-10-07-cause-found-2026-10-09).
**Owed: the gesture on `ssh canari` (the owed table).** Done when a 1.2 MB and a 20 MB upload reach
`media-service` on both legacy names. Not an app change: chunking under 1 MiB is rejected there.

### P3 - Stripe's leftover names: columns, permission flag, routes, deep-link host

Stripe itself is gone (#1589, [stripe-archive](stripe-archive.md), which lists each name kept for
rollback and old clients). Left: a drop/rename migration once `minClientVersion` passed the removal
release; and an association whose delegation was onboarded on Stripe only is not payment-ready until it
onboards on Lydia.

---

## Owed a VERIFICATION, and nothing else

Each of these is fixed in the tree; what is left is the measurement that would prove it. **Nothing
about them is open work** - the story is in `CHANGELOG.md`, the mechanism on the wiki page named,
the rule in [durable-rules](durable-rules.md). Delete the line once the measurement is taken. The
phone passes already taken are history: [device-readings-2026-10](device-readings-2026-10.md).

| What | The measurement that closes it |
| --- | --- |
| a post push tapped with the session dead lands on `/login?returnTo=` the post (2026-10-09) | check H step 4 on the Mi 9T, killed app AND backgrounded ([device-verification](device-verification.md#h-deep-link-from-an-os-notification-tap---re-opened-on-android)); a bare `/login` with no `[hooks] Processing URL` means the intent never reached the JS |
| after an edge swipe the next scroll is swallowed (Mi 9T, 2026-10-05; NOT a code defect anyone has seen: the page never holds the touch) | check X, ONE real-finger scroll on the Mi 9T with the `[swipeBack]` lines now logged ([device-verification](device-verification.md#x-the-scroll-after-an-edge-swipe---owed-on-the-mi-9t)) |
| NOTIF-10: a refused push after real banners leaves no generic line (2026-10-09, `GenericBannerLedger` unclaimed notes; JVM-tested, the service's two cancel hooks NOT compiled from here) | `bun archive/notif.mjs 10` on the Mi 9T against a build carrying it: five messages with the push channel cut, then the radios back; the shade ends with the summary and the real banners, NO `Nouveau message de ...` ([mobile](frontend/mobile.md), board row [NOTIF-10](cross-client-testing.md#14---notif---notifications)) |
| the plugin's "Default" notification channel is gone (2026-10-09; Kotlin written, NOT compiled from here) | the release APK builds, then on a phone: Settings > Apps > Canari > Notifications lists no "Default" after one app resume ([mobile](frontend/mobile.md)); if it is back after a cold start, the plugin loads after the first resume and the call moves to `onWebViewCreate` |
| the swipe to the camera after publishing a post (2026-10-09) | check V on the Mi 9T: publish, swipe right at once, three times ([device-verification](device-verification.md#v-the-camera-swipe-on-a-fresh-feed-after-publishing---owed-on-android)) |
| a salon carries read receipts (#1235, `v0.18.32`) | `READ-6` on the rig, then one look in a real community: a member who is not an admin sees the double check and "Lu par" under their own last message ([social-service](services/social-service.md#read-receipts-in-a-salon)) |
| a salon's settings are offered only to who may change them (#1228, `v0.18.32`) | one look with a Membre account: the access tab reads only, rename and delete are absent; then grant `channel.manage` to Moderateur in the grid with a moderator's panel open - the controls must appear without a reload |
| `/forms/success` no longer asks for a form called `success` | after a completed payment on production, social-service logs no `invalid input syntax for type uuid: "success"` (once per payment, so ONE payment settles it) |
| the `apiFetch` fallback now names its cause | the next run's logs separate "a container is restarting" from "refresh is broken"; if one cause dominates, measure its RATE against the population before the name "transient" is believed |
| the `[PENDING]` line that called a routine race "Non-recoverable" | the next run reports it in `notable` from an ANCHORED rule; the two old spellings stay pinned until A1 runs a build emitting the new line (an APK embeds its frontend) |
| the forms responses table shows the answers (#884) | ONE browser pass on a form with real submissions: three answer columns at 1024px, a 200-character answer, the card layout below `sm` ([forms](frontend/modules/forms.md#the-responses-accordion-shows-the-answers-and-the-form-decides-its-own-layout-2026-09-20)); the local estate held 0 forms, so it needs a refreshed copy first |
| a push carries its ciphertext once, not twice | HARDWARE, both platforms, iOS the riskier half ([chat-delivery](services/chat-delivery.md#transport--single-gateway-fcm)) |
| a device with no push token now says so | after the next release a tokenless device either acquires one or prints `[PUSH_UNAVAILABLE]` naming a cause; silence with a tokenless device still in `key_package` means a FIFTH cause |
| the notification quick reply's 403 | HARDWARE: check K steps 1-5 and **K2** on A1, **with the window ARMED** ([check K](device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found)); the iOS twin is corrected identically and unproven |
| the login button that took a press and showed nothing | any cold `/login` press proves the reordering; NOT explained is the 2026-08-28 "no request" over thirty seconds (a version check running its ladder would have issued three): read the network tail of the next cold login |
| the last server-composed sentence asks the device which language it reads | after the next release `[PUSH_REGISTER]` prints `locale=fr` or `locale=en`, not `unstated`, for a device that has restarted once; the VISIBLE half needs an iPhone AND a failed NSE |
| acknowledging a conversation from the notification shade (NOTIF-6b) | HARDWARE, both platforms: on A1 send from W1, background the app, tap **Marquer comme lu**, OPEN the app - the badge must be gone; then the same with a quick REPLY. `logcat` shows `sendReadWatermark: queued+drained at=<ms>` with the SENDER's instant, never near `now` |
| the row a push creates carries the GROUP's name | HARDWARE, both platforms, ONE case (a push placeholder), on an APK built from this tree ([check C](device-verification.md#c-the-row-a-push-creates-carries-the-groups-name---owed-on-both-platforms)) |
| WP-REGRANT-2, a re-granted member's re-join | COMM-22, four grant/revoke cycles green, and COMM-8 reading `seedAfterTheGrant: true`, never `repaired` |
| a security advisory now has an ACTOR (`automated-security-fixes`, 2026-09-02) | the first security pull request Dependabot itself opens, for ANY directory (alert 210 does not count: fixed by hand in #357) |
| the auto-merge ceiling refuses a major | the workflow logging `REFUSED` on a real major in its own run: read the `Dependency ceiling` log of a CURRENT open major |
| the release build no longer enables WebView debugging | HARDWARE, NOT the Mi 9T (its `userdebug` ROM makes every WebView inspectable): the `/proc/net/unix` probe on a `user`-build device ([check R](device-verification.md#r-the-shrunk-release-apk-actually-runs---owed-on-android)) |
| launch to fingerprint prompt on Android, 4.9 - 5.7 s on `v0.18.1` | HARDWARE, a build from this tree: `bun tools/cold-start/launch-trace.mjs --heartbeat`, the offset of `BiometricService/handleAuthenticate` ([tools/cold-start](../../tools/cold-start/README.md)). Target **under 1 s all-in** (user, 2026-09-15); the round trip left in front of the prompt is [below](#p3---a-revocation-round-trip-sits-in-front-of-the-fingerprint-prompt-and-moving-it-is-reverted-not-to-be-re-opened-measured-on-the-pixel-6a-2026-09-15) |
| the biometric cadence (every 12 h by default, or every time) | HARDWARE, a build from this tree. Android passes every cadence decision (Mi 9T, 2026-09-28); owed there: a real finger, the Settings radio, and step 5; all of iOS ([check U](device-verification.md#u-the-biometric-cadence-every-12-h-skips-the-sheet-every-time-keeps-it---owed-on-both-platforms)) |
| the Mi 9T pass D2 (#1281 a shade reply not re-announced, read watermark merged on resume) and D3 (#1282 the outbox worker) | HARDWARE, a build carrying them, then the Pixel: one `drainOutboxBackground` "sent id=" line per quick reply, with the app DEAD (a force-stopped app receives no push) and the shade reply typed by hand ([mobile](frontend/mobile.md)) |
| a notification shows the sender's face, not the app's bird | HARDWARE: one look on the Mi 9T, a DM and a group ([mobile](frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)) |
| the iOS launch logo (#1289 follow-up) | the iPhone 12: delete the app, RESTART the phone, reinstall, cold-launch - a logo means the launch-snapshot cache, nothing to fix ([app-icons](frontend/app-icons.md#launch-screens)) |
| an association document is never swept (#1292, in `v1.1.2`) | on production `/admin/storage` lists `association*` on its own line and no vault download answers 410 for a live document ([media-service](services/media-service.md#the-sweep-is-an-allowlist-an-associations-document-was-swept-2026-10-01)) |
| a tab open across a deploy offers a reload instead of "Erreur" (#1278, in `v1.1.2`) | a tab left open across the next deploy shows the reload offer on its next lazy import, and no `Failed to fetch dynamically imported module` reaches a user |
| the iOS rig adapter (#1284-#1286, #1290, #1291, #1303) | **NO board row has a verdict on the iPhone yet**: each row needs its mechanical port; O3 and O6-O11 change phone state (airplane mode, force quit, reboot, reinstall) and wait for a dedicated session; the Return key was never pressed; `pymobiledevice3` is on no PATH (the env var `PYMOBILEDEVICE3` points to it). Order: [cross-client-ios](cross-client-ios.md#what-is-owed) |
| the iOS push rows (O4, TAB-1, HEAL-NEW-5), **BLOCKED on a Firebase setting** | the development-signed bench build gets `[PUSH_SEND] FCM failed ... Invalid APNs credential` for sandbox tokens while production sends 366 `platform=ios` with 0 failures: the APNs key is missing in the DEVELOPMENT slot (the fix is INFERRED, not read; [the owed click](#owed-to-the-user---decisions-rotations-and-one-off-clicks)). After it, resend the test DM: success = `FCM sent ... platform=ios` plus an `apsd` line in the iPhone syslog. Blocked until then: O4, O11, O13, the NOTIF rows, MENTION-2/3, LIFE-2/3/5/8 |
| a withheld product releases itself when an association's payments become ready | an OBSERVATION: the next association to finish onboarding sees its products go on sale untouched (`activationWithheld`); four associations have no payment account, the BDE tier is off sale deliberately (user, 2026-09-17) |
| the login page's "Ouvrir dans l'application" (#1605) | tap the link on a phone WITH the app, Android and iPhone, and see it open ([auth](frontend/modules/auth.md#open-in-the-app-from-the-login-page-2026-10-08)); "Connexion externe (service-account)" stays word for word (user's decision) |
| a background on the Mi 9T no longer logs `pauseSocket: native disconnect failed`, and a post scheduled one minute ahead leaves the strip at its time (#1603) | ONE reading on the phone ([mobile](frontend/mobile.md), [posts](frontend/modules/posts.md)) |
| the identity label after an account switch and the PIN reset box (#1604) | **whether no PIN prompt after a later sign-in is "Rester connecte" state or a skipped unlock** ([auth](frontend/modules/auth.md#two-iphone-12-findings-of-2026-10-07-a-name-saved-for-the-previous-account-and-a-reset-button-under-the-footer)) |
| the reaction-failure toast, the send path and the reply context per conversation (#1536, #1548) on the iPhone | a peer the dev service account may discover (an admin sandbox account) or a seed conversation between gamma and a non-admin ([readings](device-readings-2026-10.md#2026-10-07---iphone-12-v104-alpha5-testflight-build-100000405-accounts-gamma-then-delta)) |
| the iPhone camera letterbox fix (#1370, shipped UNVERIFIED by the user's choice) | ONE loop of 20+ camera opens on both lenses on the iPhone, with a home-and-return in it (5 of 5 bad before the fix after one) |
| Android fluidity (#1361-#1363) | a re-measure on the Mi 9T of `open_conversation` (662 ms on the first open before them); Lucide `Icon` costs ~1 ms per icon there, so 100-150 ms per heavy screen is the hardware |
| "Seen by" heads in groups and salons (#1401) | one look in a group and a salon with four or more readers: each head under the last message its owner read, `+N` past three |
| the signed calendar subscription's 503 path (#1551) | the signer cannot be stopped without touching the stack: only the 200 path was read on a phone |
| the audiences chantier (#1582, #1584, #1606, #1608) | one look at `/admin/read-access` signed in; the Audience tab of an association read by a BDE star; a global admin's phone reading of the institution creation flow |

---

## Owed to the USER - decisions, rotations and one-off clicks

**This section holds NO substance.** Every line points at the entry that carries it, and exists only
so that "what is waiting on me" is one list rather than a sweep of the file (user, 2026-09-02:
*"Fais moi une liste des choses qu'il me reste a faire"*). Delete a line when its target entry ships
or its click is made. A line here is a thing NO agent can do - a decision, a credential somebody
else holds, a console owned by the user, or hardware that does not exist.

| What | Kind | Where the substance is |
| --- | --- | --- |
| **add `client_max_body_size 100m;` and `proxy_request_buffering off;` to the `server` block of `/etc/nginx/sites-enabled/canari-relay-prod.conf` and `canari-relay-dev.conf` on `ssh canari`, then `sudo nginx -t && sudo systemctl reload nginx`** (the 1 MiB 413 is the relay's nginx default, not Cloudflare) | 1 ssh gesture, 2 lines | [the P1 above](#p1---an-upload-over-1-mib-is-refused-with-a-413-on-devcanari-emsefr-and-canari-emsefr---the-relays-nginx-one-line-cause-found-2026-10-09) |
| **upload the APNs authentication key in the DEVELOPMENT slot of Firebase** (2 minutes): Firebase Console > Project settings > Cloud Messaging > the iOS app `fr.emse.canari` > APNs authentication key - the same `.p8` (Key ID + Team ID) already in the Production slot. The agent then resends the test DM | click | [the iOS push rows](#owed-a-verification-and-nothing-else) |
| **Lydia's three still-open Livrable A answers** - the KYC document list (channel confirmed: email, not yet arrived), the minimum payable amount, and rate limits/webhook-sandbox testing | blocked upstream | WP-LYDIA-1 |
| **the dev mobile half: a Firebase project for `dev.canari-emse.fr` and a dev keystore, plus where that keystore is backed up.** The Play service account holds only `androidpublisher`, not `serviceusage.services.enable`, so no agent can create a project. Until then a pre-release APK points at dev with production's FCM sender | 1 console visit, 1 decision | [the second package id](#p3---a-second-package-id-so-a-pre-release-can-be-measured-against-production-decided-2026-09-15) |
| **ask the School's network service what is scheduled on `fw-ste.emse.fr` between 22h and 23h.** Two production boxes that share no hardware lose their egress together, always in that band; the firewall is outside the access scope here | 1 conversation | [P1 - production goes dark in the 22h band](#p1---production-goes-dark-in-the-22h-band-and-the-only-thing-both-boxes-share-is-the-schools-firewall-measured-2026-09-11) |
| **create the new Cloudflare tunnel on the `rootz-emse.fr` zone.** The project's token answers 200 with an EMPTY list on `cfd_tunnel` and 403 on Access groups, so tunnels are out of its scope. (verify: phase 1 completed for all three estates on 2026-09-24 without it - whether this tunnel is still wanted at all) | 1 dashboard gesture | [estate-migration](infrastructure/estate-migration.md#8-what-is-owed-by-the-user) |
| **the spaces release order (WP6b), three gestures in THIS order**: (1) go for the WP3 profile backfill on production once 6a/6d's release ran migration 071 (`backfill-canari-profiles.sh apply`); (2) set every association's real reach and the BDEs at `/admin/spaces` - the seed gave all of them (ICM, saint-etienne) only; (3) only then cut the release carrying 6b. Out of order, ISMIN/Gardanne/FSSS/Autre readers see no existing association post, and anyone not backfilled loses the feed | 1 go, 1 grid, 1 release | [profiles-and-access](profiles-and-access.md), "WP6b as built" |
| **ask the gala team whether 160 MB on the shared host may go** - a runner workspace holding the only surviving checkout of `emse-students/refonte-gala` (the repository answers `404`). Nothing runs from it; it is somebody else's archive | 1 conversation | [estate-migration](infrastructure/estate-migration.md#the-host-was-emptied-before-the-move---2026-09-24-and-it-is-done) |
| **decide two privileges for the host-update report**: a sudoers rule letting the runner account run `needrestart -b` (without it the check is blind), and/or a runner key on `mitv`, `cercle`, `miconnect` | 1 decision | [the P2](#p2---three-hosts-take-security-updates-that-nothing-reports-on-and-a-library-nothing-restarts-the-rest-closed-2026-09-03) |
| **decide whether `arm-auto-merge.yml` may arm a pull request opened by the `canari-auto-merge` App itself** (a lockfile-refresh superseding a Dependabot pull request, which is how the last class of dependency update that needs a person would merge unattended) | 1 decision | [the P2](#p2---a-cargo-bump-in-mls-core-leaves-two-committed-lockfiles-dependabot-will-never-fix) |
| **EMSE Finance's roster** - its bureau fills it in (the Carte de la vie asso editor names it meanwhile) | 1 conversation | [below](#the-carte-de-la-vie-asso-chantier---audited-2026-09-27-every-decision-taken-ready-to-build) |
| **raise `minClientVersion` to `1.2.1` once BOTH stores serve `1.2.1`** - `1.0.3`-`1.1.2` keep the native key-group epoch bug (a cold start arms an epoch gap, salon sends are refused, the device re-joins 45 s later); the same floor clears Graine v2's `>= 1.0.3` | 1 gesture | [channel-encryption §22.3](protocols/channel-encryption.md#223-the-native-app-read-every-held-key-group-as-epoch-0-and-re-joined-them-all---fixed-2026-10-09), [Graine v2](#p1---graine-v2---an-author-that-is-proven-and-a-ciphertext-bound-to-its-place-decided-2026-09-28) |
| **set `posts=["ME"]` in Authentik for the staff accounts labelled EMSE that are ME** (Aurelie Boyer, Celine Haton), from the table Master hands over | 2 attributes | [profiles-and-access](profiles-and-access.md) |

## The Carte de la Vie Asso chantier - audited 2026-09-27, every decision taken, ready to build

**BUILT AND SHIPPED** (#1143-#1149, migration 064, `v0.18.28`). The eighteen decisions, the audit and
every mechanism are on
[carte-vie-asso](carte-vie-asso.md#the-2026-09-27-audit---how-it-was-measured-and-the-eighteen-decisions-it-produced).
**Still owed, and nothing else:** one A0 export from the production editor, timed, with its memory and
PDF size, re-reading the text sizes the way the audit did (D8's cost; D11 wanted it before the stable,
the stable went first); then the user's look at that export (D11); and EMSE Finance's roster (the
USER's, above).

## The composer and CanaReels chantier - compared on the Mi 9T 2026-09-29, every decision taken

**BUILT AND SHIPPED in `v0.18.32` (R1) and `v1.0.0`-`v1.0.2` (R2, R3).** The comparison, the ten
decisions (C1-C10) and the build order are on
[reels](frontend/modules/reels.md#the-chantier-the-comparison-the-ten-decisions-the-build-order-user-2026-09-29);
the editor is [reel-editor](frontend/modules/reel-editor.md). **Owed, readings only:**
- the user's own look at the R1 composer on the Mi 9T;
- one real-content take on each phone, the iOS frame timing of the viewer swipe (the Mi 9T measured
  11.5 % janky frames), and the user's ruling on the publish note;
- a reading of the whole editor (text, drawing, stickers, "Suivant") on both phones, then the user's
  Instagram screenshots for E3/E5 ([reel-editor](frontend/modules/reel-editor.md));
- the front-lens default and full-bleed preview on the iPhone, and the live-mic echo fix (#1368);
- R4 (live, C9) waits for the calls revival.

## The Liquid Glass conversation chrome - decided 2026-09-30, WP-G1 then WP-G2

Decisions L1-L4 (the three-piece glass header, the "+" that grows, phone apps only) and both halves,
shipped in `v0.18.32` (#1251, #1254), are on
[chat](frontend/modules/chat.md#the-conversations-chrome-in-the-phone-apps---glass-floating-over-the-thread-2026-09-30)
and [mobile](frontend/mobile.md#the-conversations-native-glass-chrome). **Owed on the iPhone 12**: the
alignment, the keyboard, "+" > Photos opening the picker, VoiceOver's four names (the glass tab bar and
the conversation's back/title/menu were READ 2026-10-05).

## The MiConnect profile reform - decided 2026-09-29, the technical plan is next

Thirty-two decisions and the eleven-package plan (validated 2026-09-29) are on
[profiles-and-access](profiles-and-access.md), the only copy. State: WP0, WPA and WP1 LIVE on
production; WP4 (4a, 4b #1471) and WP6a/6b (#1384, #1389) and the audiences work are on main; **WP5 is
next**. WP6b's release order is forced: see the owed-to-the-user table above.

## Asked by the USER on 2026-10-05 - one request, not built

**Reply and mark-as-read from a salon notification** - absent on Android AND iOS by design; a salon send is server-authoritative, so it needs its own native send path. iOS actions never run in this repo's gates: owed a hand on an iPhone for a DM and a group.

## Asked by the USER on 2026-10-09 - CanaReels in a conversation, a design study, not built

**An ephemeral video message filmed in the chat (DMs, groups, salons), E2E, 30 days, like Snapchat** - not a link to a published reel. Study, model, 12 work packages (RC-0 to RC-11) and 11 decisions owed: [reels-in-chat](frontend/modules/reels-in-chat.md). RC-0 (measure a 90 s take, the salon media-access rule) comes first; the upload and outbox half waits on the weak-network PR.

## P1 - Offline and weak network: salon sends are lost offline, the cold start is 103 s on Slow 3G (user, 2026-10-09; measured, not built)

DMs and groups already have an optimistic row and a durable outbox; **salon writes have neither** (offline send: text lost) and **nothing has a deadline**. Cold start on Slow 3G: first paint 23 s, list usable 103 s (JS 57 s, then the 2 MB WASM 45 s, then the list); warm 2.1 s. Fourteen ordered work packages, each with its test, and the measured table: [offline-and-weak-network](frontend/offline-and-weak-network.md). Start with WP-OFF-1 (keep the salon draft on failure), WP-W1/W2 (compression, WASM preload), WP-W3. Owed: peer-side delivery, Android and iOS runs (the page lists them).

## P3 - iOS notification sounds still play the default tone (palette A is Android and in-app only, 2026-10-09)

The palette-A trills reach the app's tones and the three Android channels ([sounds](frontend/sounds.md)). On iOS the banner sound comes from the APNs payload's `sound` field (the NSE sets `content.sound = .default`), so it needs: the three files as `.caf`/`.wav` bundled in the app AND `canari_NSE` targets (`project.yml` resources), the push server naming one per message / mention / reaction, and the NSE honouring it. Do it as one change across the three, then listen on the iPhone.

## Seen on the 2026-10-09 bench runs (around `v1.2.1`)

### P1 - a tab or app open across a production deploy sees the outage as "Échec de l'envoi"

The 1-2 min a prod deploy takes answers `502`, and a send in that window shows "Échec de l'envoi". Clients older than `1.2.1` then stayed blocked by the key-group epoch bug ([channel-encryption §22.3](protocols/channel-encryption.md#223-the-native-app-read-every-held-key-group-as-epoch-0-and-re-joined-them-all---fixed-2026-10-09)), but the deploy outage is user-visible on its own: whether the deploy library can be zero-downtime is the open question ([cicd](cicd.md)).

### P2 - the dev estate cannot send a push

Firebase is not initialized in `canari-dev-chat-delivery-service`, so no notification check can be performed on `dev.canari-emse.fr` ([dev-environment](infrastructure/dev-environment.md)).

### P2 - iPhone: once, a message that arrived while the app was killed left no unread dot

Neither the tab nor the salon showed one. Not reproduced.

### P3 - switching accounts on one iPhone install makes the local store unreadable

The next session shows "Vos messages enregistrés sur cet appareil n'ont pas pu être ouverts", and only a reinstall clears it.

### P3 - every cold start re-registers the device and fetches `/groups` two or three times

`POST /api/mls/register-device` runs on every cold start; the Mi 9T also sends `POST /mls/history-request` twice.

### P3 - the harness gamma bench PIN is refused on dev

## Open defects, in severity order

### P1 - owed: ONE live reading of the in-session join fix (2026-10-08)

The fix is built ([chat](frontend/modules/chat.md#a-community-joined-in-session-is-listed-whole-2026-10-08)): a community new to the device is hydrated by the full listing. Owed: `bun unread-communities.mjs run join` on W1/W2 (written, not run), and one look at a join through the deep link on iOS/Android, private salon the joiner may read included.

### P2 - the unread counts of salons ride a date, not a baseline (2026-10-08)

`UNREAD_TRACKED_SINCE_MS` (`channel.service.ts`) floors the server's count for a salon the member has no read mark in, so history from before marks existed (2026-09-29) is not called unread. Messages posted between that date and the deploy of `unread-counts` count for a never-opened salon, which is true. Open: a membership notice that is not `silent` counts as unread until the salon is opened (the client cannot be asked, the row is encrypted); mute levels are ignored, as the badges already did; and the in-session mark of a phone with the app asleep still depends on the 2 s receipt debounce.

### P2 - some CAS returns reach MiConnect with no code and no state, and a client can stay out (diagnosed 2026-10-09, DSI answer owed)

Read end to end on 2026-10-09 ([authentik](infrastructure/authentik.md#the-hand-built-configuration-audited-2026-09-29),
last bullet): **52 % of the failing requests are server-side probes, not people**, the flow heals itself
once for a browser, and one Android client failed three times in a row. Nothing can be changed from here
(the CAS is the DSI's, MiConnect is shared production). **Owed**: (1) the DSI's answer on the request of
2026-09-29, now with the two facts they can use: a Java HttpClient calls the bare callback, and
`-cas1`/`-cas2` bridge nodes; (2) **`docker logs miconnect-server-1` is unreadable since the 2026-10-07
restart (NUL bytes in the json log)**: a recreate of the container by whoever owns the box restores it, and
only then can the browser failure rate be re-counted without the probes.

### P3 - in the SWIPE-CHECK conversation both media show "Format non supporte" on the Mi 9T (2026-10-06)

Both media show "Format non supporte / Telecharger" on the Mi 9T while the iPhone lists them as
"[Media]". Unexplained; the swipe half of that report is fixed
([mobile](frontend/mobile.md#a-modal-closed-by-its-owners-state-left-the-overlay-stack-and-the-tab-swipe-stood-down-2026-10-09)).

### P1 - Graine v2 - an author that is proven, and a ciphertext bound to its place (decided 2026-09-28)

v1 proves nothing about who wrote a salon message or where; the table is
[channel-encryption §7](protocols/channel-encryption.md#7-what-the-server-can-still-do-stated-rather-than-implied),
the design [§21](protocols/channel-encryption.md#21-graine-v2-an-author-that-is-proven-a-ciphertext-bound-to-its-place---decided-by-the-user-2026-09-28)
(all three decisions of 2026-09-28: the whole of it, a relayed endorsement, the DMs included). R1 =
G2-0 to G2-4 and the writer G2-5 are SHIPPED (#1221; the writer in the stable `v1.0.3`, 2026-10-05).
`minClientVersion` is STILL `1.0.0` (read 2026-10-04) and is raised by the user only.

| WP | What is left |
| --- | --- |
| G2-5 | **v1 ends (user, 2026-09-28)**: a v1 seed that ARRIVES is refused, v1 seeds already held stay readable until their rows age out (365 days), the v1 reader is deleted. **BLOCKED on the floor**: clients `1.0.0`-`1.0.2` still mint v1 seeds. Unblock = raise `minClientVersion` to >= `1.0.3` once BOTH stores serve it (`bun tools/play-vitals/vitals.mjs` + App Store), then touch `utils/graine/{sessionManager,wireSeed}.ts`, `crypto/graine.ts` and the native `merge_graine_seed` |
| G2-6b | a salon edit from a v1 session has an unsigned, server-supplied `senderId` (a deliberate level, no code owed, [§21.5b](protocols/channel-encryption.md#215b-what-a-salon-edit-trusts-2026-10-05)); closes with the v1 reader. **Only if a channel ever gets an older-page load:** `listMessages` with a `before` cursor omits edit and reaction rows made after the cursor |
| G2-6 | rig row `GRAINE-AUTH` and `NOTIF-19`/`NOTIF-20` written 2026-10-05 (GRAINE-AUTH-4 has no runner); **GRAINE-AUTH-1..3 are `PASS` since 2026-10-05 on the local estate** ([board](cross-client-testing.md#20---graine---an-author-that-is-proven), the claim that they were owed was stale); **owed: NOTIF-19/20 on the Mi 9T against a G2-5 build** (needs adb), **GRAINE-AUTH-4** (no runner can exist without a decision on a mutating dev hook, see the board row) and the iPhone reading ([device-verification](device-verification.md)) |

What v2 does not close: the server can still admit a device it controls or publish a false device key
(BasicCredential's limit, §21).

### P1 - a returner's devices: one reading owed (shipped in `v0.18.26`)

The election reads presence and waits for an online holder ([channel-encryption](protocols/channel-encryption.md#wp-33-and-the-answerer-nobody-elects)). **Owed:** a reading of the returner's devices (`[GRAINE] asked <online member>` or `wait for a holder to come online`, then the salon filling); the second community of 2026-09-24, member by member; an end-to-end harness row. **Residue, not fixed:** a backgrounded Android can hold its socket and look online while unable to answer - the elected member is then silent and the next start re-asks.

### P3 - every keyboard rise moves the composer for a moment, on both phones (measured 2026-10-02)

Two different stale numbers: Android's WebView takes the keyboard height off TWICE for one report (the
composer jumps ~358 px up for 60-100 ms), iOS keeps `--safe-area-inset-bottom` at 34px for ~400 ms
(the composer stands 22 pt too high). Not fixed; the readings and the cause of each are on
[chat](frontend/modules/chat.md#every-keyboard-rise-moves-the-composer-for-a-moment-on-both-phones-measured-2026-10-02-open).

### P3 - MiConnect: one string left after the French pass

The layout, flat pass, French prompts, redirect to Canari and signed-in `continue` are SHIPPED
([authentik](infrastructure/authentik.md#one-language-french-in-the-ecosystems-tu-2026-09-25)). Left:
authentik's own untranslated "Go back". **One observation owed**: `miconnect-auth` opened while signed
in, on the Mi 9T, should go straight through.

### P3 - a CrowdSec ban on this host closes the co-tenant sites too (measured 2026-09-25)

The two actionable halves shipped ([estate-migration](infrastructure/estate-migration.md#crowdsec-covers-this-host-in-two-halves-and-only-one-of-them-reaches-every-vhost)).
**What is left is not ours to close**: a CrowdSec decision is GLOBAL per address on this machine, so a
ban earned on Canari traffic shuts `gala`, `mep` and `portail-etu-new` to that address and the reverse,
and `/etc/crowdsec/acquis.yaml` is the DSI's file. A conversation with the machine's owner, recorded so
nobody re-derives it a third time. `canari-dev.access.log` stays deliberately unparsed (dev shows one
address for every visitor).

### The MLS audit items that are still real, with their verified counts (swept 2026-09-12)

**Work to the swept numbers, never the audit's** (eight came back LARGER than claimed). The duplicate
half is gone ([triage](protocols/mls-graine-state-machine.md#8-several-paths-to-one-thing---the-duplicates),
[durable-rules](durable-rules.md#an-open-item-whose-substance-has-never-been-in-the-repository-is-not-an-open-item));
what follows is the whole of what is left.

**Availability dead ends - every one needs an exit that EXISTS** (user, 2026-09-12: *"on ne peut pas
demander a un utilisateur de sortir de l'impasse lui-meme. La sortie de l'impasse doit exister pour
garantir la disponibilite"*, scoped to availability rather than deliberate refusals):

| Item | The state | Population |
| --- | --- | --- |
| an outbox entry with no terminal state | the two permanent dispositions are `group-deleted` and `evicted`; a group nobody can repair is **neither**, so a held entry stays pending for the life of the install | the counter it needs exists (2026-09-14); what is missing is the PROOF a terminal disposition may be taken on, and a clock is not one |
| `R-E9`, `R-E11` | peer-unresolved; `readWelcomeOwed() === null` | retried for ever, no counter |
| `DE7` | `MLS_LOCAL_STATE_UNDECRYPTABLE` | the only route offered requires the OLD PIN |
| `G-E10` | `forgetCommunityGraine` with no runtime | warns, returns 0; seeds and joined groups stay |

### P1 - a damaged local MLS state is reported as a PIN rotation, and the PIN the user actually holds does not get them back in (measured 2026-09-08)

Typed errors, the honest message naming the reset, and the blob-header READER (step 1) shipped in
`v0.18.18` (#901); the measurements are on
[mls-protocol](protocols/mls-protocol.md#the-state-blobs-framing---read-first-write-later). **What is
left is step 2, BLOCKED on one fact**: the one-line writer flip (`state_blob::frame_v1` at
`save_encrypted_with_key`) plus the `minClientVersion` bump, once the fleet has taken the reader
(`>= 0.18.18`) - `minClientVersion` is already `1.0.0`, so ONE `play-vitals` and App Store measurement
settles it, never a date written here. Until then the two causes of `MLS_LOCAL_STATE_UNDECRYPTABLE`
stay unseparated in the field and `DE7` keeps its old-PIN-only route. When step 2 lands,
`serverProse.test.ts`'s one `ALLOWED` entry (`sessionAuth.ts`) must stop being allowed - the guard
FAILS on an entry that stops offending. **Still worth a run once a device's history is expendable**:
the sign-out half (answered by READING `handlePinSignOut`, not by a run). **Step 2 must NOT become** a
fallback that re-enrols whenever a decrypt fails: that destroys the history of every user whose PIN
really was rotated (what `noFreshStart` protects); the two causes are TOLD APART by the fingerprint.
Board cell CORRUPT-2 on [cross-client-testing](cross-client-testing.md); runner
`tools/cross-client-harness/archive/corrupt2.mjs`.

### P2 - the legacy cotisation rows are LOADED on both estates, and NOT ONE claim has been observed (shipped 2026-09-11, v0.17.1)

1429 rows are staged on dev and on production; the projection (60 production accounts will be granted
at their next sign-in, 248 close `already-held`) is on
[cotisations](cotisations.md#what-the-load-did-projected-on-production-shipped-2026-09-11-v0171). What
is missing is a single observed claim: the next sign-in should move `/admin/legacy-cotisations` off zero
in the claimed tab, and until it does an empty screen and a broken claim look identical. The service
log line and that page have never been read against a real claim.

### P3 - message notifications share one group key across conversations (measured against Messenger, 2026-09-09)

The conversation shortcut shipped (#1448; [mobile](frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)). **What remains:** `setGroup(GROUP_KEY_MESSAGES)` is still ONE constant at three call sites of `CanariFirebaseMessagingService.kt` with one summary, while Messenger keys per THREAD, so four messages across two conversations stack as one here and two there. A placement difference only; measure on the Mi 9T after any change, since nothing in CI sees which section of the shade a notification lands in.

### P3 - iOS stacks the reactions to a post but does not merge them into one banner (2026-10-08)

Android shows ONE notification per post, "A, B et N autres", with up to three faces
([mobile](frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)). iOS only files them under the thread `post_reaction_<postId>`. The merge would be the NSE reading `getDeliveredNotifications` for that thread, rewriting the text and drawing a collage - native code to be run on an iPhone, not compiled. Owed: one look at the stack on the iPhone, then the decision.

### P3 - a revocation round trip sits in front of the fingerprint prompt, and moving it is REVERTED, not to be re-opened (measured on the Pixel 6a, 2026-09-15)

Three of the four causes of a slow launch-to-prompt are fixed; **the fourth, `isDeviceRevoked` in front
of the prompt, STAYS** - why it may not move behind `init()` and the three shapes weighed are on
[cold-start](frontend/cold-start.md#the-revocation-gate-stays-in-front-of-the-prompt-and-the-launchs-console-noise-is-explained-pixel-6a-2026-09-15).
**MEASURE BEFORE CHOOSING, and that is not a deferral**: the refresh was 132 ms, the probe was never
timed alone, and the `mls.bin` block that dominated everything is gone as of `v0.18.3`. If the remaining
budget is not dominated by these two round trips this is the wrong first target.
`bun tools/cold-start/launch-trace.mjs --heartbeat` on the Pixel 6a says so, with a build pointing at an
environment where that device HAS a session.

### P2 - the MLS init waited ten seconds behind twenty-four avatars on `v0.18.5`, and nothing has re-read that window on a cold PHONE (measured on production 2026-09-16)

The avatars are edge-cached and batching them is REFUTED
([core-service](services/core-service.md#the-avatar-proxy)); the browser re-reading on `v0.18.16`
puts MLS ready at 968-1182 ms, so the window did not reproduce
([cold-start](frontend/cold-start.md#the-split-answered-on-the-day-it-shipped-an-ordinary-boot-is-968-ms-and-mls-load-state-is-8-of-it-2026-09-20)).
**Owed**: one cold start on a phone, whose console lines bracket themselves (`+<ms>` since #742) -
write no marks. **Do not "fix" it by lowering the avatars' fetch priority** (advisory, per-engine,
would make the measurement unreproducible).

### P2 - a CHANGED PROFILE PHOTO: `no-cache` + ETag SHIPPED (2026-10-08), ONE EDGE READING OWED

The shape and the layers table are on
[core-service](services/core-service.md#no-cache--the-upstream-etag-and-the-busted-url-it-did-not-need-2026-10-08).
**Owed, then delete this entry**: after the deploy, `curl -sI` a face twice through `canari.emse.fr`
and confirm Cloudflare revalidates (`cf-cache-status` not a `HIT` with a growing `Age`), then change a
photo in MiGallery and watch it appear. If the avatar Cache Rule overrides the origin, the fix is that
rule.

### P3 - THE TWO OPENING LINES BELONG TO THE DOCUMENT THAT IS LEAVING (production, 2026-09-16)

#754 shipped (`beforeunload` as well as `pagehide`;
[auth](frontend/modules/auth.md#and-what-is-not-a-reconnect-the-page-leaving)). **Owed: ONE Firefox
reload of a build carrying it** - are the two outgoing-page lines (`+15269ms` stamp, the previous
build's `app.*.js`) gone? If not, Firefox closes the socket before dispatching any event: no DOM event
can discriminate, and the lines are to be EXPLAINED where they are read, never suppressed.

### P3 - ONE MAINTENANCE PASS IS ON THE AWAITED PATH, BLOCKED ON A FACT NOBODY HAS DEFINED

`prune_expired_key_packages` costs **10.08 ms** at a 1000-bundle pool (criterion, OXYGEN; 88 % is
`serde_json` decoding, [cold-start](frontend/cold-start.md)) inside `load_or_create`, in front of the
first screen - NATIVE ONLY. It is maintenance (what it deletes must be deleted and nothing else deletes
it), so moving it needs a TRIGGER, and a clock is forbidden. **The blocking condition**: name a durable
fact, carried in the state blob rather than inferred, that says *this pool has been pruned since it last
changed*, and prune when it is absent. Until then the pass stays, because a pool that silently stops
being pruned makes the prekey P1 worse. **Re-derive before quoting** the old "82.7 % of post-login": on
2026-09-20 post-login is 282 ms, that call 74 ms (26 %) and `revocation-gate` 123 ms (44 %).

### P2 - THE NETWORK FOR THE JAVASCRIPT IS SOLVED; 1.62 MB OF IT STILL HAS TO BE PARSED BEFORE ANYTHING RUNS (measured on production 2026-09-16)

Two chunks (the chat engine, 404 879 B, and the protobuf codec, 146 160 B) are 44 % of what `/login`
loads, through ONE static import in the root layout (`+layout.svelte`, `globalChatSingleton`);
measurements and what NOT to do (touch the preload header, merge chunks) are on
[cold-start](frontend/cold-start.md#the-javascript-is-parsed-before-anything-runs-the-delivery-is-solved-measured-on-production-2026-09-16).
**THE NEXT STEP IS STILL A MEASUREMENT, NOT A REFACTOR**: the user's next cold-start export says
whether parse time is the dominant term (the gap between the first console line and `Initialised in WEB
mode`). Splitting the root layout's chat import changes the thing that keeps the session alive across
navigation, and buys nothing on the route the target is measured on.

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

### P3 - notification taps: what the 2026-10-08 audit left open

Matrix and reasoning: [mobile](frontend/mobile.md#what-every-notification-opens-and-what-was-measured-2026-10-08).
Fixed on a branch (not shipped until released): a proposal push opened the feed, three notices had no switch, a
browser salon notification clicked through `/chat`. Open:

1. **P3 - a comment, reply or mention opens the post, not the comment.** No `commentId` travels in the payload or the URL.
2. **P3 - the Android manifest and `tauri.conf.json` declare five hosts; the page hosts a push writes (`posts`,
   `calendar`, `admin-agenda`, `proposals`) rely on the explicit intent of the notification.** Read it once on the Mi 9T.

The two questions of the audit are answered (2026-10-08): a follow keeps its meaning, a per-association mute exists, read-grant holders stay unannounced - [social-service](services/social-service.md#follow-mute-and-read-grants-three-different-facts-decided-by-the-user-2026-10-08).

## CI and the chain that runs unattended

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
moves either pin** (last checked 2026-10-09: minio still 8.0.7). The reasoning, the upstream-check log
and the dead retirement condition are in [cicd](cicd.md#four-audit-advisories-are-suppressed-on-one-edge-of-media-service-and-why-each-is-unreachable).

### P2 - THREE hosts take security updates that nothing reports on, and a library nothing restarts (the rest closed 2026-09-03)

The mechanism and report exist since 2026-09-03 ([host-updates](infrastructure/host-updates.md)). Three
open items, each with its retirement condition in
[host-updates](infrastructure/host-updates.md#what-stays-open-the-reports-reach-the-raid-channel-and-libraries-nothing-restarts):

1. the report reaches the Portail-etu host (where the runner lives, checked 2026-10-09) and no other host (`mitv`, `cercle`,
   `miconnect` unreported) - a runner key on them is the user's decision;
2. `mitv`'s 7.3 TB RAID1 has a sensor (`mdmonitor`) and no channel - `/proc/mdstat` into the daily report;
3. a library fix is installed, not in effect - `needrestart -b` as the runner's unprivileged account is BLIND (prints only its version, measured 2026-10-09), so it waits on a sudoers rule for that one command, the user's decision.

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
relay-path call, two peers, audio and video, TURN as production configures it, taken by hand (the in-process half of it runs in CI since 2026-10-09: `apps/call-service/tests/relay_path.rs`)
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
asker holds frames it cannot read. **Re-read 2026-10-09, STILL OPEN and NOT changed: the fix is a design
whose state is not specified (WHAT is remembered, for HOW LONG, what discharges it), the cause is measured
only on the local rig (ten runs), and production's half cannot be read from the server** - 32 h of
`[HISTORY_REQ]` held 423 `NO_PEER_ONLINE` against 54 `FORWARDED`, which is a population of askers with no
peer online, not the coin flip. What would settle it: a harness `HEAL-repair` batch with the asker's
election log beside it, then the exclusion-on-agreement change with its state written first. The
measurement, the root cause and the two refuted causes (not to be re-opened) are in [history-reconciliation](protocols/history-reconciliation.md#heal-repair-lands-on-a-coin-flip-the-measurement-and-the-root-cause-2026-09-08).

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

### P3 - the phone polls presence every ten seconds over a live WebSocket (2026-09-02)

Still so (`presenceStore.ts`). A push first needs the decision of who may watch whose presence
([detail](protocols/campaign-measured-defects.md#the-presence-poll-logcat-2026-09-02)).

### P2 - a new device's join of a community's key group reaches the commit gate BEFORE its KeyPackage (2026-08-29, cause measured on production 2026-10-09)

**ONE defect, and the two entries that stood here were it.** All six `[MEMBERSHIP_ACTIVE] REFUSED ... no_key_package` of 32 hours of production were on four COMMUNITY distribution groups and no conversation; each device's first run logged `[PURGE_PREKEYS]` (its key package round starting), then the join's commit and its refusal in the same second, then `[REGISTER_DEVICE] START` - the join committed between the mint and the publication, so the gate wrote no membership row and the device held a tree that routed nothing to it ("holds the group, the group holds no row", the rejoin, the extra epoch). Three of the six healed 2 min to 1 h 44 min later (an iPhone among them: seeds unrouted for that long), the other three devices are gone. **A fix is in a DRAFT pull request** (`externalJoin` waits for the key package round already running; failing test first, [detail](protocols/campaign-measured-defects.md#a-new-devices-join-reaches-the-commit-gate-before-its-keypackage-2026-10-09)). **Owed after it ships:** the same read of the server log (REFUSED lines on a distribution group of a `isNew=true` device should be zero), and HEAL-NEW verdicts remain "clean on the web client", never on the server. **KNOWN RESIDUAL, not covered and not measured (no evidence of one in the six):** a join that starts BEFORE the round has set `keyPackageRoundInFlight` sees no round and commits as before; and the round's own HTTP calls (`fetchPrekeyCount`, `registerDeviceKeyPackage`, `publishKeyPackages`, `deleteAllOneTimePrekeys`, the native `invoke`) carry NO per-request deadline, so a request that never answers holds the wait - and every join of a group queued behind it - for as long as the transport lets it hang. **The design that closes both is proof-based:** the join waits on a PUBLISHED FACT, not on a running round - read the server's own statement that this device has a static KeyPackage (the same `deviceAddressability` the gate reads) and join when it is true, so a round that has not started yet, a round that ended, and a round that hung are one case (the fact is false until it is true) and the wait ends on the fact with no clock. Needs a read route for it; do not add a timer on the field instead. A failed round no longer proceeds to a doomed commit: `externalJoin` answers `{ joined: false, reason: 'key_package_round_failed' }` and its callers treat it like any other refusal.

### P2 - a roster seat without a Welcome: the reason is typed on the client, the server report cannot partition on it yet (prod 2026-09-01)

Open: a client-to-server write (migration) so `reportStrandedDeviceMemberships` can join the reason; read
the first real `skipped` lines before designing it
([detail](protocols/campaign-measured-defects.md#a-roster-seat-without-a-welcome---the-typed-reason-prod-2026-09-01)).

### P1 - the placeholder is GONE from prod; what it may have left in the MLS TREE is not answered

The server estate is clean; whether a leaf survives in `7da231f8-119c-4ce2-884f-55f5c94c903f` (epoch 118) is
answered only from a member's own client, which reads the tree
([detail](protocols/campaign-measured-defects.md#the-placeholder-and-the-mls-tree)).

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

- **Suspended, not filed**: the "Nouvelle discussion" dialog showed no result list on A1 against `dev`, where the harness directory does not exist. One re-run against the LOCAL estate settles it ([detail](cross-client-harness-findings.md#the-2026-09-14-hardware-session-one-suspended-measurement)). **Why no agent re-ran it (2026-10-09):** the local estate is up, but every signed-in client of the rig reaches its session through Authentik's login, which an agent may not drive, and the app keeps no other session path (tokens live in memory only); the re-run is one `bun sweep.mjs --device W2 --route /chat` plus the dialog by a session holder.
- **Done 2026-10-08 - the wry bump** (tauri 2.12.1, wry 0.57.0, tao 0.37.1; the vendored `tao` fork DELETED, upstream already carries its guard): one re-check left, none owed ([detail](cross-client-harness-findings.md#the-wry-bump-that-removes-the-abort-a1-2026-09-14)).

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

### P2 - NOTHING REPUBLISHES A LAST-RESORT PACKAGE'S EXPIRY, SO THE UNDATED ROWS DRAIN ONLY AS THEIR OWNERS UPGRADE (production, re-measured 2026-10-09)

**Re-measured 2026-10-09: 457 undated of 1016 rows (291 users, 116 of them with NO dated row), down from 597 on 2026-09-22 - about 8 a day, the 20 a day of 2026-09-18 slowing.** The split is STILL a client version with no exception (559 of 559 dated rows are `>= 0.18.10`; no undated row is, 393 carry no version at all and 29 are below it), and the newest undated row was created 2026-09-25: the population is frozen and only drains. Both client repairs are REFUTED; mechanism in [key-package-pool](protocols/key-package-pool.md). **The server-side lifetime decoder (an MLS reader in `chat-delivery-service`, which never interprets MLS bytes) is NOT justified while the count falls**; a count that stops falling is what would justify it, so re-measure after the floor moves (`minClientVersion`, the user's gesture) - which is also what empties it.

### P2 - the MLS snapshot version is a PER-DOCUMENT counter compared ACROSS documents, so a second tab's write is dropped on a collision (measured on TAB-4, 2026-09-05)

Whether anything is lost is unmeasured; the state is expected to converge. **Owed:** a shared counter or a proof of convergence and its delay ([mls-desync-prevention](protocols/mls-desync-prevention.md#the-checkpoint-window-and-the-per-document-snapshot-counter-moved-from-the-backlog-2026-10-08)).

## Payments

Lydia ("Paiement Canari") and cash are the only payments since Stripe was removed (#1589, [stripe-archive](stripe-archive.md), which lists the names kept for rollback and old clients). `payment_provider` is `lydia | disabled`, default `disabled`; mechanism in [payments](frontend/modules/payments.md) and [core-service](services/core-service.md#payments-stripe--lydia).

### WP-LYDIA-1 - Lydia live in production, with one payment observed end to end

**Owed:** Master tests one homologation payment end to end on dev with a test account (payer e-mail prompt, callback included; not yet observed); production tokens and `LYDIA_ENV=production`; each association re-onboarding on Lydia (**an association with a Stripe-only payment account is no longer payment-ready until it does**); Lydia's still-open Livrable A answers ([plan](../../plans/stripe-to-lydia-migration.md)). The `business/create` `BUSINESS_VALIDATED` webhook is deliberately NOT built: no documented signature and `vendor_token` is public, so anyone could forge an association's onboarding state - ask Lydia whether it signs before building it.

### Owed to the user after the Stripe removal

Delete the GitHub secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUB_KEY` and the Stripe webhook endpoint (the CGU and privacy text naming Lydia was APPROVED by the user on 2026-10-08). Three later items: the unsigned Lydia partnership contract, proof the payer e-mail is not kept, and association enrolment with conditions and uploaded documents. Later, once the previous release is no longer a rollback target: drop the three Stripe columns and rename the permission with a data migration ([stripe-archive](stripe-archive.md#the-names-that-outlived-the-processor-kept-on-purpose)).

### A PAID PUBLIC FORM (user, 2026-09-30) - the paid half waits for Lydia

The free half is shipped (`/f/:id`, migration 068, [forms](frontend/modules/forms.md#a-public-form-is-answered-without-an-account-2026-09-30)). **Owed:** one guest answer sent from a private window on `dev.canari-emse.fr`, with the `canari-dev-frontend-1` log showing a real client address rather than the Docker gateway (the `real_ip` change it carries); the paid half is scoped on [forms](frontend/modules/forms.md#the-paid-half-what-it-needs-scoped-2026-09-30) and needs WP-LYDIA-1.

### P3 - an admin who never joined a private salon is not told when it is deleted

Not on the roster, so no `channel.deleted`; the sidebar keeps a stale row until the next load. **Do not widen the audience** (that is what leaked private-salon traffic to non-members); the shape that would work is a contentless `channel.gone` addressed to the community, worth doing only if the stale row is ever seen to matter.

### P2 - WP-RESTORE-1: Zero-Tap Sign-In restoration, required by Google Play from April 2027

The principle is accepted (user, 2026-08-26) and the work is scheduled AFTER the campaign; the Block Store exemption date of 30 September 2026 has passed and enforcement begins April 2027. It needs a WebAuthn server `core-service` does not have. Mechanism, the E2EE argument and the three traps: [mobile](frontend/mobile.md#wp-restore-1---zero-tap-sign-in-restoration-accepted-2026-08-26-scheduled-after-the-campaign).

## Tooling

### P2 - a cargo bump in `mls-core` leaves two committed lockfiles Dependabot will never fix

`mls-wasm` and `src-tauri` carry committed locks and depend on `mls-core` by path, so Dependabot's single pull request (against `mls-core/Cargo.toml`) is incomplete by construction and fails CI's lockfile step - the one dependency update that cannot merge unattended. **Remedy, not done:** one cargo workspace with ONE `Cargo.lock` for `frontend/`, which restructures a Tauri build this workstation can only compile. Until then such a bump is done by hand in one commit refreshing all three locks ([cicd](cicd.md#dependency-updates-and-the-auto-merge-that-ships-them)).

**A mechanism was designed and tested 2026-10-09, and is PARKED on a decision (nothing of it is in the repository).** A scheduled job takes each Dependabot pull request whose only failure is the lock guard, opens a NEW pull request (never a push onto Dependabot's branch, which [cicd](cicd.md) records as refused for good) carrying Dependabot's cherry-picked commits plus `cargo update --precise` refreshes of the locks, closes the original with a pointer, and lets `CI passed` decide. It refuses, once and with a comment, a plugin whose crate drags `tauri`/`wry`/`tao`, a lock still failing `cargo metadata --locked`, and anything `lib/ceiling.sh` has no gate for; it runs only when every commit is Dependabot's and every changed file a manifest or lockfile. Tested with fake `cargo`/`gh` and a local bare remote (29 assertions). **Blocked because** the new pull request must be armed by the `canari-auto-merge` App and the safety classifier refused edits letting `arm-auto-merge.yml` arm a bot-opened pull request from a non-Dependabot author - so this is the user's decision to allow ([owed table](#owed-to-the-user---decisions-rotations-and-one-off-clicks)); the design is rebuilt from this paragraph in about a day.

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

Measured 2026-10-09: the Portail-etu host is 60 % used (26 G of 45 G, 18 G free, 2.8 GB of images reclaimable, no build cache) and the old VM 18 %. **Standing authorisation (user, 2026-10-09: "Je t'autorise le nettoyage si besoin"):** an agent installs and runs the prune when the host passes 80 %, using the four commands and the one cron entry written out in full with the host's real paths and the facts that make them safe (checked read-only 2026-10-09) in the [README](../../infrastructure/docker-prune/README.md#on-the-portail-etu-host-nothing-is-installed-yet). Dangling VOLUMES are never pruned by a flag ([databases](infrastructure/databases.md#reaching-it-from-a-workstation)).

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

## Audiences of associations, lists and institutions - built, in production since `v1.2.0`

WP-A (#1582), WP-B (#1584), the star reading its audience (#1593), the nominative read grants WP-C (#1606) and their write-boundary fixes (#1608) are built. Decisions and as-built: [profiles-and-access](profiles-and-access.md#the-audiences-chantier---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08). **Owed:**

- **The on-device look** at the Audience tab, the profile campus prompt and the `/admin/read-access` grid.
- **The 8 dev checks of the read grants PASSED on 2026-10-09** ([verdicts](profiles-and-access.md#the-eight-dev-checks-2026-10-09-devcanari-emsefr-on-121-alpha1-same-code-as-v121)). Check 2 (no personal post) passed on the predicate only; an end-to-end reading needs a personal post by a gardanne account, and `canari-test-epsilon`'s credentials are NOT in `F:/Programmation/canari-harness/test-accounts.json`. **User:** add them there (never on a command line).
- **User decision:** let the directory be widened for grantees? (not widened now; only posts, comments, reactions and events are).
- **Ambiguity to answer:** what "an institution of another campus" means for a reader (the grant reaches it today).
- The document-reviewer rows were NOT moved into the grants table (a separate capability on the same page).

## Navigation, tooltips and the camera (2026-10-08)

### P2 - Sections are navigated in depth, not shown as tabs (user, 2026-10-08)

Two menu patterns, both bad on a phone: a scrolling row hides tabs, a wrapped grid takes half the screen. Replace them with a hub, route-segment sections, a breadcrumb and a rail on wide screens. Design, order, traps and the two open choices: [section-navigation](frontend/section-navigation.md). Start with the permission gap on the edit page, then the edit page itself.

## Tooltips: one remaining inconsistency (audit 2026-10-08)

The app still has THREE hover/tap systems (native `title`, the `PostPolls` voters bubble, `MessageInfoTooltip`) and no shared `Tooltip` component. Redesign only if a fourth appears; the 38 icon buttons whose `title` and `aria-label` are two different keys for the same hint could share one key ([convention](frontend/design-reference.md#tooltips-one-convention-audited-2026-10-08)). `ReactionsDisplay`'s native reactor `title` is removed in its own PR.

## CanaReels: the camera tab cannot be guessed (user, 2026-10-09)

Swiping right from the leftmost tab opens the camera, and nothing says so. Wanted AFTER the video, discard and weak-network chantiers are stable, not before. Ideas to weigh with the user: a peeking camera edge on the leftmost tab (a visible handle that nudges once); a first-run coachmark shown once per account and remembered server-side; a permanent camera icon in the app bar next to the plus; and a "Canareels" entry in the plus menu so the feature is reachable without the swipe. Measure how many users have ever opened the camera before choosing.
