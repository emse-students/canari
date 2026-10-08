# Device readings, 2026-10-05 to 2026-10-07 - the alpha passes, what passed and what was found

The log of the phone readings taken on the `v1.0.3` stable and the `v1.0.4-alpha.3` to `alpha.5`
pre-releases (Mi 9T and iPhone 12). **It is HISTORY**: what each pass proved, with the evidence. What
is still OPEN from these passes (a defect, a reading still owed) is in [backlog](backlog.md), never
here. The runbook that defines each check is [device-verification](device-verification.md); the
campaign board is [cross-client-testing](cross-client-testing.md).

Rig facts that recur: the Mi 9T runs a debug APK from `a1apk.mjs` against the LOCAL estate (the
harness accounts exist nowhere else); the iPhone 12 (iOS 27.0.1) runs a TestFlight or bench build
against `dev.canari-emse.fr` through the "Connexion externe (service-account)" flow. adb-simulated
gestures are not a finger.

## 2026-10-05 - `v1.0.3` (Mi 9T, local stack) and an iPhone 12 bench build of `77f5e3cc4`

- `PASS` on the Mi 9T: the reply swipe on a RECEIVED message (icon small and translucent at 60 px,
  full and yellow at 250 px, the bubble glides back and the reply bar opens); a personal post from
  the Associations tab (the feed switches to "Tout", the post on top); video thumbnails (play button
  centred and not cut, tap plays online in under a second with sound - "playable while downloading"
  was NOT proven, the local video was too small).
- `PASS` on the iPhone 12 (bench build, NOT 1.0.3): the CanaReels camera opens full-bleed with no
  black band, front lens by default, still full-bleed after two lens flips (the phone lay flat, so the
  rear view never settled; the 20-open loop was NOT done). The native glass tab bar refracts the
  content under it, and in a conversation back, title and menu are native glass.
- One defect found then (the own-message reply icon) was fixed by #1437. Another is still open: the
  edge-back-then-scroll swallow, in the backlog.
- Observation: in the SWIPE-CHECK conversation both media showed "Format non supporte / Telecharger"
  on the Mi 9T while the iPhone listed them as "[Media]".
- Not taken in that session: D1-D6, #1287/#1288, check K, C, NOTIF-6b, U, the cold-start timing,
  NOTIF-7/7b, "Nouvelle discussion". Rerunning `ios.yml` in `local_url` mode on the tag needs the local
  OIDC client id (`VITE_AUTHENTIK_CLIENT_ID` in `frontend/.env`), which the agent was not allowed to read.

## 2026-10-06 - `v1.0.4-alpha.3` (Mi 9T, debug APK from `5b56dcb74`, versionCode 402)

`PASS`: a tab swipe then Settings leaves no sideways shift and a sideways swipe on Settings moves
nothing (#1515); the profile header centres "Demander une correction" with the settings icon top
right (#1513); the conversation list is in the same order on the phone, the web twin and the OTHER
account, before and after a send and after a pending message drained (#1510); a reaction failure
toasts at the TOP; the reel editor end to end (capture, four text styles, five colours, drawing,
sticker shelf and full picker, "Suivant" straight to the publish step, Back from the editor returns
to the review, Back from the review asks "Abandonner cette capture ?"); the own-message reply swipe
shows a full solid icon; the floating day label (#1287) and the subscribe "no app" notice (#1288);
D1 #1280 (`live stream back - reloading open salon`, then `GET /api/channels/:id/messages`) and D4
#1283 (one `Processing URL`, the replay ignored).

Defects found, all since fixed: no haptic ever fired on Android because the manifest lacked
`android.permission.VIBRATE` (#1535); the reaction-failure toast overlapped the header, said only
"cela n'a pas abouti" and left the thumb drawn (#1509, #1536; the log line was
`unclassified failure error sending request for url (.../api/mls/send)`); the review screen's
controls were clipped to the video box and abandoning a take landed on the Dashboard (#1539).
#1520 (a scheduled post) was not reachable that day: the phone account authored for no association.

## 2026-10-06, second pass - `v1.0.4-alpha.4` (Mi 9T, debug APK from `a05b55f7c`, versionCode 403)

`PASS`: **#1535 VIBRATE** (`dumpsys package` lists `android.permission.VIBRATE: granted=true`, no
`Failed to use vibrate API`; the Mi 9T is on a silent ringer with TOUCH intensity OFF, so no haptic can
be FELT - the permission and the absence of the refusal are the evidence); **#1536** reaction failure
in a SALON with the API unreachable (the toast sits below the header, `[DELIVERY] send ... could not
be reached`, `[CHANNEL] reaction not sent, local pill rolled back: true`); **#1539**; **#1520 + #1508**
(a post scheduled for 22:45 listed under "Publications programmees" with a dashed ring, then on the
feed at 22:45 as "A l'instant"); **#1531** the profile page; **#1541** the signed subscription (sign 201
for the reader's own campus and formation, the feed answers 200 signed, **403 unsigned, 403 with the
campus swapped**, the campus picker offers only "Tous les campus" and the reader's own); **G2 resume**
(`[MLS][Tauri] mls.bin reloaded on resume (C2)` after a plain background and after a send followed at
once by HOME; the `live-ahead` branch needs an unsaved ratchet advance at resume and was NOT reached -
the Rust test `unsaved_ratchet_advance` carries it).

Findings: the reply context followed the member into the next conversation (fixed by #1548); the
swipe to the camera did nothing three times on a fresh Feed (open, in the backlog); NOTIF-10 stayed
`FAIL` with the ordering fa6b9d6aa asked for now measured
([cross-client-testing](cross-client-testing.md#14---notif---notifications)).
**Local estate prerequisite, not a product defect**: migrations 069-077 were not in the local
`schema_migrations` ledger and `spaces` was EMPTY, so the signed subscription refused its own reader
(403 `outside their spaces`) until the seed of `071_spaces.sql` was run by hand. No runner applies
migrations to the local estate ([databases](infrastructure/databases.md)).

## 2026-10-06 - iPhone 12, `v1.0.4-alpha.4` TestFlight build (1.0.4 build 100000404), account `canari-test-gamma`

`PASS`: the profile page and its header (name, ICM and SAINT-ETIENNE chips, correction link, settings
icon top right); the nav bar is the floating glass pill (iOS 26+ branch, four tabs, selected tab in
its own capsule); a tab swipe slides the feed out while the Communautes page is already on screen
under it (WDA MJPEG frames 25 ms apart) and a 34 pt drift stays on the feed; the reel review
letterboxes the take with controls fully visible over the bars (#1539), "Suivant" goes straight to
the publish step (#1505), "Supprimer et refilmer" asks before discarding (#1506); reactions on posts
draw as Noto pictures; the feed scrolls with the header and glass bar fixed. Evidence:
`F:\Programmation\canari-harness\ios-bench/a4-*.png`.

Found: the signed calendar subscription refused the reader's OWN campus (`AGENDA_SELECTION_FORBIDDEN`)
- read fixed in alpha.5 by #1541/#1551; the post composer draft was device-global (#1549); the
camera opened on the back lens (#1552). Blocked then: the reaction toast and send path (no second
enrolled account on dev) and the scheduled-post publish time (the sandbox account authors for no
association).

**Bench traps, met twice** (candidates for the rig README): after a partial service-account sign-in
Authentik keeps the half-flow in the SFSafariViewController cookie jar and the launcher then lands on
the CAS form (school 2FA) every time - Settings > Apps > Safari > Clear History and Website Data
clears it; `ios.mjs url` is refused while iOS 27's one-time "default browser" sheet is pending;
typing the user name on an Authentik or CAS field raises the Passwords autofill sheet, which hides the
keyboard's go key - dismiss it with its X first.

## 2026-10-07 - Mi 9T, `v1.0.4-alpha.5` (debug APK from tag `1be223001`, versionCode 100000405)

`PASS`: **#1548** (reply armed in the DM with "Repondre a Canari Test Beta"; the salon `SWIPE-CHECK`
opened afterwards shows no reply bar; back in the DM the bar is still there); **#1552** (the reel
camera opens on the front lens, `[camera] opened user: camera 1, facing front`, the flip goes to
`environment: camera 0` and back); **#1541** again (sign 201 for Saint-Etienne + ICM, feed 200
`text/calendar`, 403 without `sig`); **#1549** in part (the draft is stored under
`canari_post_composer_draft:<owner hash>`, restored with "Brouillon restaure" after close and reopen,
cleared with "Effacer"); profile page, four-tab bar with the active tab lit, tab swipe both ways with
no shift, a post scheduled for 01:20 listed under "Publications programmees" then on the feed as
"1 min" at 01:21 (server log `[ANNOUNCE] swept: posts=1/1 recipients=2`). The `ZJI` JNI call of #1550
ran for the first time: every `[NOTIF] native builder queued ... (covers 1)` line is there and
logcat holds no `UnsatisfiedLinkError` or `NoSuchMethodError`.

**NOTIF-10 is still `FAIL` on #1550, in a DIFFERENT shape**: the five messages each got their OWN
real banner (`covers=1`, 00:59:19 to 01:09:23) while the push channel was cut, and the three pushes
then refused `SecretReuse` after the radios came back ~9 min later. The real posts of 00:59-01:00
found no push in flight, so by design they left no credit; only the last one (01:09:23.970, a push
already queued) credited ONE of the three, so push 1 posted nothing ("the real banner is already
up"), push 2 posted a generic line and kept it "until the real one replaces it", and push 3 was
suppressed in the foreground. Final shade: the summary plus ONE `Nouveau message de Canari Test Beta`,
no real post ever coming to replace it. The ledger's "a real post with no push behind it must leave
no credit" and "a refused push whose message the other engine already consumed" are the same fact seen
from two ends: a `SecretReuse` refusal PROVES the WebView engine already held that generation, so a
real banner for the group already exists or is being posted. Candidate fix, not built: keep per group
a count of real posts that no push has claimed yet (bounded, dropped when the group's notification is
cancelled), and let a refused push consume one of those before it posts a generic line. Rig:
`bun archive/notif.mjs 10`.

## 2026-10-07 - iPhone 12, `v1.0.4-alpha.5` TestFlight build (100000405), accounts gamma then delta

The update took ~4 min after the release run's upload to appear in TestFlight (pull to refresh until
the row says "Mettre a jour"). Evidence: `F:/Programmation/canari-harness/ios-bench/a5-*.png`.

`PASS`: **the signed calendar subscription (#1541/#1551)** - a link carrying `campus=saint-etienne`,
`formation=ICM` and a `sig` for the reader's own spaces (the alpha.4 FAIL is gone), "Copier" answers
"Copie !", "Ouvrir dans mon app calendrier" opens Calendar on its "Calendrier avec abonnement" sheet
pre-filled with the `webcal://dev.canari-emse.fr/...` URL (cancelled, nothing subscribed), and the
same https link answers 200 signed, 403 unsigned from the workstation; **the reel camera opens on the
FRONT lens (#1552)** - the torch button is the discriminator when the frame is black (a capability of
the lens: absent on the front, drawn on the rear); **the composer draft is per account (#1549)** -
gamma's draft survives close and reopen, delta sees an EMPTY composer, gamma gets it back;
regressions: the floating glass pill on every screen, the profile page for both accounts, a full
horizontal swipe changes page and a 36 pt held drift on Communautes leaves it in place, the reel review
and "Supprimer et refilmer".

**BLOCKED, not read: the reaction toast and send path, and the reply context per conversation
(#1548).** `canari-test-gamma` is the dev service account, and
`UsersService.applyServiceAccountVisibility` lets it discover ONLY global admins while hiding it from
every non-admin, so gamma and delta can never find each other in the contact search. The only other
sandbox account the search returns, `Canari Test Alpha`, opens a conversation that reads "Vous avez
ete retire de ce groupe". To read them a peer the service account may discover (an admin sandbox
account) or a seed conversation created server-side between gamma and a non-admin is needed.

Two iPhone findings of that day (a stale accessible name after a user switch, a PIN recovery box under
the footer) were fixed by #1604
([auth](frontend/modules/auth.md#two-iphone-12-findings-of-2026-10-07-a-name-saved-for-the-previous-account-and-a-reset-button-under-the-footer)).

Bench observations: the first sideways swipes on the Feed moved the feed's own Associations / Suivis /
Tout chips (the Feed has an inner swipe), not the tab - start the tab swipe from Communautes or the
camera. The Passwords autofill sheet offers a keychain login of the phone's owner on the Authentik
form: dismiss it, never fill it. `ios.mjs type` appended a stray letter twice when a tap landed on the
keyboard after the layout shifted: read the field back, and press Return with `type` of a newline
instead of tapping "Se connecter".

## 2026-10-08 - origin/main without #1630 (Mi 9T, debug APK, local stack rebuilt)

Rig: the Pixel 6a left the bench, so every check ran on the Mi 9T only (a second Android phone still owes
a second OEM's notification grouping, three-button navigation and the multi-device read-mark cases).
The local estate has no migration runner (ledger stops at 068): migrations 069-079 were applied by hand.

- `PASS` A: 10 of 10 community salon rows open the conversation (taps at x >= 200 px; a tap under that
  hits the rail). `PASS` B: the unread badges come back from the SERVER count after force-stop, a network
  cycle and lock/unlock, and a mere launch posts no read mark.
- `PASS` D: the grouped reaction notification is one row per post (collage of up to 3 faces).
- `PASS` NOTIF-7c and 7d (salon push tap, backgrounded and killed behind the PIN). A first run looked
  like a FAIL of 7d; it was the instrument: `phone.ensure()` and `unlock.mjs` reload the page and drop
  the pending deep link. Use `keepIntent` and `pin.mjs --device A1`.
- DEFECT FOUND AND FIXED: a calendar, admin-agenda or proposal push tap did NOTHING on Android. Root
  cause: the four hosts were absent from `plugins.deep-link.mobile`, so the plugin never forwarded
  the intent (see [mobile](frontend/mobile.md)). After the fix, read backgrounded and killed: the event,
  the agenda and the proposal queue open. Test: `deepLinkHostsDeclared.test.ts`.
- `PASS` follow end to end: a real `social_followed_post` push reached the phone for a person followed in
  the same space; with the `posts` category disabled (set through `PUT /api/mls/notification-preferences`,
  NOT by tapping the settings switch) the next post announced to the same recipient raised no notification.
  Data note: a campus stored as `SAINT-ETIENNE` against `saint-etienne` shares no space (recipients=0);
  whether campus should be normalised is an open question.
- OPEN, measured and NOT fixed: with the session deleted server-side, a killed-app tap on a post push
  boots, the refresh answers 401 and the app lands on a bare `/login`; the log shows NO
  `[hooks] Processing URL`, so the post target is dropped before any `returnTo` can carry it. A
  `returnTo` fix in `ChatBackgroundService` was tried and reverted: it does not touch this cold-start path.
- NOT taken: the tap on the DM (NOTIF-7/7b) and stale targets were not re-read in a form worth a verdict,
  the admin hub with a tier account, list edit, three-button navigation, and everything iOS.
