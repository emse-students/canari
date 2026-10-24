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
([cross-client-testing](cross-client-testing-archive-1-4-0.md#14---notif---notifications)).
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
`<workstation>/canari-harness\ios-bench/a4-*.png`.

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
the row says "Mettre a jour"). Evidence: `<harness-dir>/ios-bench/a5-*.png`.

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
- FIXED 2026-10-09 (reading owed, [check H step 4](device-verification.md#h-deep-link-from-an-os-notification-tap---re-opened-on-android)): with the session deleted server-side, a killed-app tap on a post push
  boots, the refresh answers 401 and the app lands on a bare `/login`; the log shows NO
  `[hooks] Processing URL`, so the post target is dropped before any `returnTo` can carry it. A
  `returnTo` fix in `ChatBackgroundService` was tried and reverted: it does not touch this cold-start path.
- NOT taken: the tap on the DM (NOTIF-7/7b) and stale targets were not re-read in a form worth a verdict,
  the admin hub with a tier account, list edit, three-button navigation, and everything iOS.

## 2026-10-09 - CanaReels capture: the video was not fluid and the sound was hot (Mi 9T, lava-lamp bench)

User report: a received reel (`_UAn5N-A.mp4`) is not fluid and sounds horrible; and the screen after a
capture has black bars. The phone sat in front of a lava lamp so the image is never still. Method: the
capture code's own settings run in the app's WebView over CDP (same constraints, same canvas relay, same
`MediaRecorder` options), the real `prepareVideoForUpload` bundled and injected, every file pulled over
adb and read with ffprobe/ffmpeg. **This drives the code paths, not the app's screens; the fixed APK
was NOT built, and the rebuilt screen was measured in headless Chrome only.**

The user's file: 570x1278, H.264 High, `avg_frame_rate` 20.18 against `r_frame_rate` 57600 (variable),
138 frames over 6.86 s, inter-frame 12-173 ms with 17 gaps over 80 ms, key frames every 2 s (the
transcode's, correct); audio AAC mono 48 kHz 128 kb/s, **RMS -10.2 dB, peak +0.18 dB, EBU I -10 LUFS**:
hot and clipped; audio 7.36 s against video 6.92 s.

| Stage (590x1280, 8-10 s) | Before (VP9 + canvas relay) | After (hardware H.264 + canvas relay) |
| --- | --- | --- |
| Camera track itself | 29.8-30.0 fps | 30.0 fps |
| (i) Recorder file | 18.9-20.2 fps, 11-17 gaps over 80 ms, max 135-173 ms | 29.9-30.0 fps, 0 gaps, max 54 ms |
| (ii) After preparation (WebCodecs, 3.1-3.8 s) | 18.9 fps, 10 gaps, 400 kB | 28.8 fps, 0 gaps, 2.85 Mb/s |
| (iv) Playback in the WebView | 0 dropped (plays the 19 fps it is given) | 0 dropped, 0 gaps |

- **Cause of the stutter is the recorder, not compression, upload or playback.** The software VP9
  encoder cannot keep up with the canvas stream and drops a third of the frames; the hardware H.264 one
  (`video/webm;codecs=h264,opus`, supported, written as Matroska) keeps all of them. The transcode copies
  timestamps through and playback drops nothing, so they only carry the loss. Recording the camera
  stream directly with VP9 also read 29.9 fps (the cost is the canvas readback plus the software encoder);
  drawing on `requestVideoFrameCallback` instead of `requestAnimationFrame` gave no gain over H.264 and
  left a few gaps, so `requestAnimationFrame` stays. Upload was not a stage that can change frames: the
  file is encrypted and stored as is.
- **Audio**: `getUserMedia({ audio: true })` leaves the voice-call chain on. Against one source, 6 s,
  gain control alone read 6 dB hotter than none (peak -10.9 against -17.1 dBFS); echo cancellation also
  removes whatever the app itself plays. Reels now ask for all three OFF and 128 kb/s Opus. NOT
  proven by ear (tests stayed silent by decision): the loudness of a real voice with the chain off.
- **Preview screen**: the media is `object-cover`, absolute, looping, no seek bar, timecode or bottom
  sound button; the sound button stays at the top beside the pencil and the cross. Headless Chrome
  at 320x640, 390x844 and 1280x800: the media box equals the viewport at all three (0,0,w,h), no range
  input, "Next" over the bottom edge. A portrait clip on a 1280 wide window is cropped hard by `cover`.
- OPEN: the prepared file has ~4 % fewer frames than the recording (287 of 299); the cause was not found.

## Readings of `v1.2.3-alpha.1` on the bench Mi 9T (2026-10-10)

Run 38041978095, release APK (`versionName` 1.2.3, `versionCode` 100200301: Android drops the
pre-release suffix, the store band carries it). Signed in as the campaign account `fourth` on
`dev.canari-emse.fr` after `pm clear` (a stale vault from the earlier install made `pin.mjs` refuse
before it). Contacts of the dev directory had never signed in, so the bench used a one-member group
room. Screenshots stay in the session scratchpad.

| Reading | Verdict | Evidence |
| --- | --- | --- |
| R1 2.2 MB attachment, dev relay refuses above 1 MiB | **FAIL** | The bubble reads "Plus rien ne passe - 1,4 Mo sur 2,1 Mo envoyes" with a retry and a cancel button after about 25 s, but the header stays "Envoi..." with a spinner ring and never turned into a refused / too-large state in the 150 s watched. The 413 is not surfaced as a cause. Cancel (x) removed the bubble cleanly. |
| R2 300 KB attachment | **FAIL (unresolved)** | Right after the cancelled upload it showed "En attente de connexion - nouvel essai automatique" for over a minute, while `navigator.onLine` was true; a text sent just after read "En attente..." too, then both left that state on the next page load ("Message envoye" for the text). The 293 Ko bubble then stayed dimmed with a spinning ring for 5+ minutes: no progress, no success. logcat shows `SELECT * FROM outbox` once a second with 6 rows returned for that whole time. |
| R3 settings hub (`/profile` itself is the profile page; the hub is `/settings`, reached by the sliders icon) | **PASS** | 7 rows; "Securite & appareils" opens `/settings/security` with breadcrumb "Parametres > Securite & appareils"; Back returns to `/settings`; reload on `/settings/security` stays there; clicking the first crumb returns to `/settings`. |
| R4 sticky date pill, glass | **NOT-DONE** | The room held two items, so nothing scrolled behind the "AUJOURD'HUI" pill; its look cannot be judged. The pill and composer rendered normally. |
| R5 keyboard rise, composer | **PARTIAL** | A per-frame log of the composer's top (CDP, 2 attempts) reads 877 -> 889 -> 800 px in both: a 12 px dip DOWN for 1-2 frames (`innerHeight` still 945 while `visualViewport` is already 856) before it settles above the keyboard. The final position is right; the dip is a small visible jump. No screenrecord frames. |
| R6 edge swipe then scroll | **PARTIAL** | An edge swipe from x=2 inside the room returned to the conversation list (`/chat`). The list held one row, so the scroll after it could not be judged. |

Needs a code look: R1 (a refused upload must end in an explicit state, the stall message is the
only signal) and R2 (a 293 KB file never completes while text goes through; check whether the
cancel of the earlier upload leaves the outbox stuck, and why the outbox is polled every second).
The sticky pill, R4, wants a conversation with a few screens of messages.

## Readings of `v1.2.3-alpha.2` on the bench Mi 9T (2026-10-10)

Run 38050133374, release APK (`versionName` 1.2.3), `pm clear`, then `login.mjs` / `pin.mjs` as `fourth`
on `dev.canari-emse.fr`, one-member group room `BenchR1` (it survived the clear: the server still held it).

| Reading | Verdict | Evidence |
| --- | --- | --- |
| R1 2.2 MB attachment, 413 then terminal FAILED | **NOT-DONE** (harness) | The file never reached the network. `DOM.setFileInputFiles` on the phone answers `NotReadableError` for `/sdcard/Download` files (mode `rw-rw----`, owner shell) and for world-readable files under `/sdcard/Android/data/fr.emse.canari/files/` alike; granting `READ_MEDIA_*` and the all-files appop changed nothing (the grant also kills the app process, so the CDP forward must be re-pointed). The 413 path was therefore not exercised. Console: `[MEDIA] send failed (status=none), 1 file(s) re-staged: NotReadableError`. |
| R2 300 KB then text | **NOT-DONE** (same cause) | Same `NotReadableError`. The text, typed apart from the file, went through (`[OUTBOX] ... sent`); the outbox was NOT polled once a second (a handful of `SELECT * FROM outbox` per send, 14 in 5 minutes). |
| R3 reply to a failed attachment | **NOT-DONE** | Needs R1/R2 staging. |

Incidental, from the failed staging (a real product signal, not the harness): when the file cannot
be READ, the bubble reads "En attente de connexion - nouvel essai automatique" and the composer says
"Echec de l'envoi du media. Reessayez dans un instant." while the file is re-staged. That is a
local read error shown as a connectivity wait: no network request is made, the retry button
("Reessayer maintenant") does nothing visible (two presses, 20 s and 60 s watched, no
`reqwest` connection in logcat), and nothing ever turns terminal. After a re-send, earlier bubbles
stay (one `b2m.bin` showed a spinner with "0 o"). A staging read failure should end in a terminal
state with its own message.

Rig lessons: `login.mjs` against a stale `adb forward` on 9334 (Jelly, the phone's browser, not
Chrome, owns the Custom Tab) fails with "never rendered a credential form" or "no submit button";
`adb forward --remove-all`, `pm clear org.lineageos.jelly`, then login works. Git Bash rewrites
`/sdcard` paths: use `MSYS_NO_PATHCONV=1`.

## 2026-10-11 - iPhone 12, `v1.2.3-alpha.5` TestFlight build (100200305), account gamma

The verdicts, the method (WDA plus its MJPEG stream; the store build is not inspectable) and what is
blocked or waits for the next pre-release are in one table:
[the inventory](device-verification.md#the-iphone-12-owed-readings-inventory-2026-10-11). `PASS`:
#1605 on the iPhone, the glass chrome's alignment, picker and names, #1370 on the front lens, the
emoji pictures in the composer, the profile breadcrumb, the associations scroll. `FAIL`: check W, in
a new shape. Bench trap: TestFlight's automatic updates had put the PRODUCTION stable on the bench.

## 2026-10-19 - `v1.3.1-alpha.1` on both bench phones (iPhone 12 and Mi 9T), and the first 1:1 call between them

Pre-release run 39242441752 (commit `1d0de7574`). **iPhone 12** (iOS 27.0.1): TestFlight installed build
`1.3.1 (100300101)`; Settings > "A propos" reads "Version de Canari 1.3.1-alpha.1". Read signed in on
`dev.canari-emse.fr` through WDA. **Mi 9T** (Android 16, release APK `versionCode` 100300101, sideloaded over
`1.3.0`, data kept): read in a second pass once the screen was unlocked, signed in on dev as a second bench
account, through the app's WebView (inspectable: a `webview_devtools_remote` socket, forwarded with
`adb forward` and driven over CDP) plus `adb` taps for the real touches.

| Reading | iPhone 12 | Mi 9T |
| --- | --- | --- |
| A. starts, signed in on dev, version string | **`PASS`**: PIN screen, then the feed under the "Environnement de test" banner; "A propos" says `1.3.1-alpha.1` | **`PASS`**: lands on the chat list under the test banner; "A propos" says "Version de Canari 1.3.1-alpha.1", "Vous utilisez la derniere version" |
| B1. no abort at launch with accessibility on | **`PASS`**: launched three times under WDA, no Canari crash report | n/a (iOS fix) |
| B2. bookings space editor | **`PASS`**: opens with the fields filled, saves ("Reglages enregistres.") | **`PASS`**: Reservations > Modifier opens "Modifier l'espace" with name, description, poster and resource filled; the description was edited by real typing, "Enregistrer les reglages" answered "Reglages enregistres.", and the new description was on the space page after a re-open |
| C. 1:1 audio call (CALL-L1) | see the call tables below | see the call tables below |
| D. localized native push, #2047, App Group erasure | **`NOT-READ`**: dev cannot send a push (Firebase service account absent on dev) | **`NOT-READ`**: same reason |
| E. booking flow | **`PASS`** book and cancel | **`PASS`**: the 17:00 slot booked ("C'est reserve."), listed under "Mes reservations a venir" as "Titulaire", cancelled behind a confirm; the past list went 1 -> 2 and the upcoming list emptied |
| F. CanaReels | **`PASS`** | **`PASS`**: the viewer opens a reel from the feed and its three clips play (`currentTime` advancing, 718x1278); the composer's "Ouvrir la camera" opens the camera with the close, lens flip and shutter controls; `/camera` opens the same camera |
| App logs | **`NOT-READ`**: the TestFlight build is not inspectable | **`PASS` with findings**: logcat and the page console read for the whole session, see the findings below |

### The call (CALL-L1), Mi 9T (caller) to iPhone 12 (callee), same Wi-Fi, both on speaker

| Step | Result |
| --- | --- |
| Ring on the callee | **`PASS`**: "Appel entrant" with accept and refuse, within seconds; the 60 s ring window closes the call when nobody answers (a late accept is refused, as designed) |
| Answer, both ways audible | **`PASS` for connection**: media flowed both ways for 7 minutes in one call (selected pair `host/udp -> host/udp`, RTT 5-35 ms, no relay). **Audio quality `FAIL`**: see the numbers |
| Hang up from the Mi 9T | **`PASS`**: the other end dropped within 3 s, the chat line read "a duree 7 minutes", audio mode back to normal |
| Hang up from the iPhone | **`FAIL`, not reachable**: the minimised call card's mute, speaker and hang-up controls sit UNDER the glass tab bar (visible through it, the red hang-up glyph under the glass), and its expand button did not react to taps by text, by point and by gesture; the call could only be ended from the other phone |
| Wi-Fi off then on on the Mi 9T, mid-call | **`FAIL`**: a 14 s outage ended the call about 10 s in; a 6 s outage did too. The app log reads `[Call] terminal failure: signalling WebSocket closed code=1006 - ending call`, then `remote track ended`. There is no reconnection and no ICE restart: the call is dead on the first signalling socket close |

### The numbers, Mi 9T receiving the iPhone's audio (`getStats` every 5 s through CDP, 3 calls)

The `getUserMedia` the call makes asks `echoCancellation`, `noiseSuppression` and `autoGainControl` as `ideal: true`
and the Mi 9T applied all three (`channelCount` 1, `sampleRate` 48000, `latency` 0.01; the app log says
`micro: echo=true noise=true agc=true rate=48000Hz ch=1`). Codec Opus, 48000 Hz, 2 channels declared
(`minptime=10;useinbandfec=1`), target bitrate 48000, about 38-45 kbit/s sent, 50 packets/s each way.
Android audio mode `MODE_IN_COMMUNICATION`, route `speaker`, during the whole call.

Call 1, 90 s, per 5 s interval:

```
t(s) pkts lost jitter(ms) jbDelay(ms) concealed% concealEvents inserted rtt(ms) outKbps
  5   233    0     4.0         38          74          46        2636     5       35
 10   254    0     3.0         31          61          63         834     6       40
 15   252    0     8.0         35          66          48         678     8       39
 20   255    0     5.0         31          65          50        1315    34       40
 25   270    0     4.0         32          60          52         378     6       40
 30   265    0     5.0         32          66          60         466     7       38
 35   261    0     4.0         41          77          47         759    17       39
 40   244    0     6.0         40          60          43         870     8       37
 45   246    0     4.0         45          72          53         642     7       36
 51   293    0     4.0         34          59          71        1043     5       38
 57   336    0     4.0         36          64          54        1741     7       39
 64   332    0     5.0         34          65          65        1254     5       39
 70   299    0     3.0         33          61          56        2028    29       38
 82   633    0     7.0         38          57         117        2681     8       39
 89   341    0     5.0         42          66          68        1885    13       38
```

(The `lost` column is the cumulative count; the concealed share is per interval. 633 packets at t=82 is a
12 s gap between two samples.) Calls 2 and 4 read the same: 41-69 % concealed per interval. Over the third
call, 205 s: **6,133,524 of 9,839,040 samples concealed (62 %)**, 2,334 concealment events, 62,430 samples
inserted for deceleration, 7 packets lost. Network: jitter 3-19 ms, RTT 5-53 ms, 0-17 packets lost per call.
The network is not what is lost.

**The cause the logs name.** The WebView's NetEq logged, over the four calls, **14,568 `Decode error` /
`Decoder error (no error code)` pairs, each followed by `GetAudioFromSources: failed to
GetAudioFrameWithInfo() from source`, plus 142 `audio_frame->samples_per_channel_ (480) != output_size_samples_
(480)`**: about 14 a second, 30 % of the 50 packets a second, for the whole call. In words: the iPhone's
packets ARRIVE (low loss, low jitter) but the Opus decoder on the Android side rejects a third of them and NetEq
conceals in their place. That matches "sounds horrible" and it is NOT an echo, level or network problem. What it does
not yet say: whether the fault is the iPhone's WebKit encoder output, the AES-GCM frame transform on either side
(a decrypted payload is the sent payload, so a corrupt one would be a framing issue, not a key one), or a frame-size
mismatch at the Opus layer. The other direction (Mi 9T audio heard on the iPhone) could not be read, the store build
not being inspectable. Next steps: a call between two Chromium engines (the desktop fidelity rig), and a dev build
with the frame transform bypassed: the decode errors stay or go with one of the two.

Input level: the received stream's `audioLevel` read 1.000 in many samples. Both phones were on speaker next to each
other, which is a feedback loop in the room on top of the above; the echo cancellers were on.

### Defects, with evidence

| Id | Severity | Defect | Evidence |
| --- | --- | --- | --- |
| CALL-AUDIO-1 | **P1** | The Opus decoder rejects about 30 % of the received packets (NetEq `Decode error`) while the network loses none; 62 % of the audio is concealed | the tables above; 14,568 `Decode error` lines in logcat over 4 calls |
| CALL-IOS-HANGUP | **P1** | On the iPhone the minimised call card is covered by the glass tab bar: mute, speaker and hang-up cannot be reached and the expand button does not answer; the only way out is the other phone | iPhone screenshots 17:00 and 17:02 (the red hang-up glyph is visible UNDER the glass); the WDA tree puts the buttons at y=768 pt, inside the tab bar |
| CALL-WIFI | **P2** | A signalling-socket close ends the call at once (no reconnect, no ICE restart), although the peer connection could ride out a 6 s outage | `[Call] terminal failure: signalling WebSocket closed code=1006 - ending call` after a 6 s and a 14 s Wi-Fi drop |
| CALL-TURN | **P3** | Every call logs 4-8 `TURN CreatePermission error response` (403 and 600) on a call that runs on the host pair, plus IPv6 socket-binding warnings: noise to explain (dev TURN credentials or the socket binding) | logcat `turn_port.cc:1902` and the `Socket is bound to the address ... rather than an address associated with network` warnings |
| CAM-BANNER | **P3** | On the camera pages the "Environnement de test" banner overlaps the status bar region (dev build only) | Mi 9T screenshot of `/camera` |
| LOG-1 | **P3** | The in-app log is batched: during the session IndexedDB `CanariDBLog` held lines from 2026-10-15 only, so a call's own lines were readable only by hooking `console` live | `CanariDBLog` read over CDP |

Other log lines of the session: `[GroupMembers]` and `Failed to fetch presence` as `TransportFailureError`, and `[WS] 4 pings
without server response - closing zombie connection`, all at the Wi-Fi drops (expected). No Android crash, ANR or fatal in logcat.

Rig lessons: `ios.mjs url <https url>` opens Mobile Safari, not the app; TestFlight may sit on "Mettre a jour" until it is
tapped. On the Mi 9T, `adb` remote paths need `MSYS_NO_PATHCONV=1` under Git Bash, `uiautomator dump` sees only a system dialog over a
Tauri WebView (read the DOM over CDP instead), and a `getUserMedia` hook installed on a live page misses the calls already made. A
60 s ring window makes a slow rig miss the call: accept in the same command that detects the ring.

## 2026-10-19 (evening) - `v1.3.1-alpha.2` on both bench phones: the call UI, CALL-WIFI, the noise, the reel from the composer

Pre-release run 39299547723 (commit `6f97c078e`, dev estate green). **Mi 9T**: the release APK of the
GitHub release, `versionCode` 100300102, `adb install -r` over alpha.1 (data kept), account `delta`, read
over CDP (`adb forward` on the app's `webview_devtools_remote_<pid>`) with real touches from `adb input`.
**iPhone 12** (iOS 27.0.1): TestFlight `1.3.1 (100300102)` (it appeared about 8 min after the release run
ended: pull to refresh, then "Mettre a jour"), account `gamma`, driven through WDA. Both on the bench
Wi-Fi, no SIM. Every call below is `delta` and `gamma` in their shared direct conversation, both apps open.

| Row | Mi 9T | iPhone 12 |
| --- | --- | --- |
| 1. starts, version | **`PASS`**: "A propos" reads "Version de Canari 1.3.1-alpha.2", "derniere version" | **`PASS`**: PIN screen, then the feed under the test banner; "A propos" reads `1.3.1-alpha.2` |
| 2a. incoming ring full screen on any route, Accept focused | **`PASS`**: on `/posts` the `alertdialog` is 436x945 (the whole viewport) at `z-index` 330, `document.activeElement` is "Accepter l'appel entrant", three controls (reduce, refuse, accept) | **`PASS` for the screen**: full screen over the dashboard route, Refuser and Accepter at the bottom; focus is not readable through WDA. An OS banner "Appel entrant - ... vous appelle" was ALSO on screen while the app was in the foreground, see the findings |
| 2b. in-call full screen, controls reachable | **`PASS`**: chevron, E2E line, avatar, timer, speaker / mute / hang-up under the thumb | **`PASS`**: same screen, hang-up at the bottom, not under the tab bar (the tab bar is hidden) |
| 2c. hang up from both | **`PASS`** (full screen and bar): the iPhone left the call within 2 s | **`PASS`: CALL-IOS-HANGUP is closed.** Hang-up reached by a WDA touch from the bar over a conversation (the Mi 9T logged `the other party left the call room` 2 s later) and from the full screen, three calls |
| 2d. minimise over an open conversation / a long page | **`PASS`**: the green bar sits under the test banner, the conversation header and the feed's own header are pushed DOWN, not covered; the tap on the bar returns to the full screen | **`PASS`** for both (conversation, then the feed scrolled): bar under the banner, the page header below it, the glass pill header of the conversation below the bar. The tap on the bar itself was not exercised (only the chevron and the hang-up) |
| 2e. Back from full screen minimises, no ghost history | **`PASS`**: `history.length` 28, first expand 29, then 29 after Back, expand, Back; the path stays `/chat` | n/a (no system Back) |
| 2f. timer after the app was backgrounded 10 s | **`PASS`**: bar read 03:22 at 20:45:06 for a call connected at 20:41:44 | **`PASS`**: 03:45 on the bar after 14 s on the home screen (connected 20:41:44, read 20:45:31) |
| 2g. remote audio starts after Accept | **`PASS` as far as the DOM can say**: the single `<audio>` is playing with one track, no "Toucher pour entendre" ever drawn, `[Call] voice playing (stream arrived)`; NetEq decoded the iPhone's packets from the first second. Heard by ear: not judged | **`NOT-READ`**: no "Toucher pour entendre" in the tree on a call the Mi 9T placed; nothing says the voice was audible |
| 3a. CALL-WIFI, Wi-Fi off 6 s | **`PASS`**: `signalling WebSocket closed code=1006 - resuming`, `reconnecting=true`, attempts 1-3 failed (`connection failed`) while the radio was off, `signalling resumed on attempt 4` 15 s after the drop, `peer ready - ... polite (resumed)`, `reconnecting=false`; no terminal failure; "Reconnexion..." on the bar; NetEq's decode lines stopped 21:05:51 and came back 21:06:02 (the iPhone's audio is back at the Mi 9T). **The direction Mi 9T to iPhone could not be read** (store build) | `NOT-READ` (log unreadable, see the noise section) |
| 3b. Wi-Fi off 14 s | **`FAIL`**: the drop at 21:06:30, attempts 1-4 failed, `connectionState=failed after a connection - left to the ICE restart`, `signalling resumed on attempt 5` at 21:07:02 (32 s after the drop, 16 s after the radio was back) and `ICE disconnected (signalling resumed) - asking the initiator to restart (1/3)`, then NOTHING: no `ICE restart`, no `media path restored`. 90 s later both phones still read "Reconnexion...", no decode line since 21:06:31: no audio. The call was only ended by the hang-up | the iPhone (initiator in this call) also stayed on "Reconnexion..." |
| 3c. Wi-Fi off 90 s | **`FAIL`**: the Mi 9T gave up first, `terminal failure: signalling not restored after 5 resume attempts - ending call` 30 s after the drop (attempts at +1, +2, +4, +8, +16 s, so BEFORE the 60 s seat grace) | **`FAIL`: the iPhone was left on "Reconnexion..." with Raccrocher for over 100 s after the Mi 9T ended**; it only left when its own hang-up was pressed. A phone that gives up while offline cannot tell the relay, and the relay's grace did not end the call on the other side within the time watched |
| 5a. background 10 s (HOME) | **`PASS` with a visible blip**: `[WS] Paused - disconnect sent` then `[Call] app hidden state=incall mic=live voice=playing`; signalling closed 1006 5 s later, attempts 1-2 failed, `[Call] app visible state=incall mic=live voice=playing` on return, `signalling resumed on attempt 3`; "Reconnexion..." for about 12 s; the call survived | **`PASS`**: the call survived 14 s on the home screen, the timer was right; the app's own `app hidden` lines are unread |
| 5b. screen locked 60 s | **`FAIL`**: lock at 21:09:11. The iPhone's audio stopped within 1 s of the lock (74 NetEq decode lines in that second, none after); signalling 1006 at +5 s, attempts 1-4 failed, `terminal failure ... ending call` at +54 s; `[Call] app hidden state=incall mic=live voice=playing` was the only hidden line (no `os-muted`). The call does not survive a locked Android screen, which is what the native half is owed for | **`PASS` for survival, no audio while locked**: locked by WDA for 60 s, the call stayed up (the Mi 9T saw no signalling fault), but the iPhone's audio to the Mi 9T stopped within a second (2 decode lines, then none for 60 s) and came back on unlock |
| 6. composer camera video to a CanaReel (#2124) | **`PASS`**: "Ouvrir la camera" (front lens, dark room), shutter held 3.3 s, review screen (take 718x1278, "Suivant"), the publish step "Nouveau CanaReel" with "CanaReel : supprime au bout de 30 jours. Pour garder la video, gardez-la comme post." and "Visible 30 jours, puis supprime automatiquement...". **"Garder comme post"** closes the sheet and the composer holds the video tile (with "Legende"). **Publier**: `[reel-publish] start: camera, video/x-matroska;codecs=avc1,opus, 202570 bytes`, `POST /api/posts` 201, `a reel filmed from the post composer was published`. **Back during publish: `PARTIAL`**: pressed 0.7 s after Publier, in the re-encode, it DISMISSED the sheet and CANCELLED the publish (`[reel-publish] the sheet was dismissed, publish cancelled`, `stopped: the re-encode was cancelled`) and the review came back; the whole publish took 3 s so a Back after the upload started was not reached | `NOT-READ` |
| 7a. booking smoke | **`PASS`**: Reservations > "Modifier" opens "Modifier l'espace" with the name and description filled; the 11:00-11:30 slot booked ("C'est reserve."), listed as "Titulaire" under "Mes reservations a venir", cancelled behind a confirm, the list empty again | `NOT-READ` |
| 7b. delete without a submission (#2133) | **`PARTIAL`**: a personal form with one question and no submission created and deleted from `/forms` (`DELETE /api/forms/<id>` 200, the list empty). **The association path of #2133 (`retireForms` inside the association's delete) was NOT read**: the bench accounts own no association and the "create" button is absent for `delta` | `NOT-READ` |

### The audio noise (CALL-AUDIO-1), `delta` receiving `gamma`'s iPhone

**Unchanged on alpha.2.** NetEq on the Mi 9T logged **437 `Decode error` (each with a `failed to
GetAudioFrameWithInfo`) in a 30 s window, 14.5 a second**, against 50 packets a second: the same 29 % as
alpha.1 (14,568 over four calls). Per second 3-31, steady for the whole call. The concealed-sample ratio
itself was not read (the peer connection is not reachable from the page; no `getStats`).

**The new diagnostics, verbatim, from the Mi 9T's app log and console, five calls, both roles:**

```
[Call] E2E sender transform attached (audio)
[Call] E2E receiver transform attached (audio)
[Call] audio send=audio/opus pt=111 ch=2 [minptime=10;useinbandfec=1] recv=audio/opus pt=111 ch=2 [minptime=10;useinbandfec=1] | local m=audio opus/111,red/63,g722/9,pcmu/0,pcma/8,cn/13,telephone-event/110,telephone-event/126 | remote m=audio opus/111,red/63,g722/9,pcmu/0,pcma/8,cn/13,telephone-event/110,telephone-event/126
```

The codec is Opus on both sides at payload type 111 and the offer order is `opus/111,red/63,g722/9,pcmu/0,...` in
both descriptions, so H3 of the table in
[calls](frontend/modules/calls.md#the-iphones-sender-read-from-the-code-2026-10-19) is not supported by what the
Mi 9T sees. **What is absent is the finding:** on the Mi 9T, in every call, there is NO
`[Call] E2E sender transformer #N ...` line, NO `[Call] E2E sender audio #N: ... frame(s), not-opus= ...` line, NO
`[Call] E2E encrypting audio (N frame(s))`, NO `[Call] E2E decrypting audio (N frame(s))`, and no `ERROR E2E ...`
line. The worker's first-frame messages should have produced the first two within a second of the first packet
and the last two at frame 1. Either the worker's messages do not reach `appendLog` (the console shows only the
main thread's `attached` lines and the `audio send=` line) or no frame ever reaches the transform on the
Mi 9T. Which one was not separated (no worker target attached over CDP). **It cannot be read as "the transform is
clean" nor as "the transform is off".**

**The iPhone's lines (the sender of the noisy direction) are `NOT-READ`.** The in-app log was exported
("Enregistrer le journal", saved in Files as `canari-log-1.3.1-alpha.2-20261019-2047`, 1.1 MB, 13,371 lines since
2026-10-14, the first call of that session inside it) but it cannot be paged from the workstation: Quick Look's
search field takes the focus and not the text typed through WDA, and WDA times out on the 1 MB text view (the
daemon had to be restarted once). The syslog does not carry the app's console. **Owed: a smaller export (a
"clear the log" button, or one export per call) or any way to get that file onto the workstation.** Calls to
or from a desktop Chrome were not made (no desktop client signed in on dev as the counterpart).

### Findings

| Id | Severity | What | Evidence |
| --- | --- | --- | --- |
| CALL-WIFI-14 | **P2** | After a 14 s outage the call never recovers: the signalling resumes at attempt 5 (+32 s), ICE has failed, the callee asks the initiator to restart (1/3) and nothing follows; both screens say "Reconnexion..." with no audio until someone hangs up. A 6 s outage recovers | rows 3a, 3b; the log of 21:06:30-21:08:30; the initiator's side (iPhone) is unreadable |
| CALL-WIFI-GHOST | **P2** | A phone that gives up (5 attempts, +30 s) while offline leaves the other phone on "Reconnexion..." for more than 100 s; the relay's 60 s grace did not end the call on the remaining side in that time, so a call can sit dead on one phone | row 3c |
| CALL-LOCK-ANDROID | **P1, already in the backlog** | A locked Mi 9T drops the call at +54 s and its audio at once; the iPhone keeps the call but sends no audio while locked | row 5b; the native half is owed |
| CALL-AUDIO-1 | **P1, unchanged** | 14.5 NetEq decode errors a second from the iPhone's sender | above |
| CALL-E2E-LINES | **P2 to read** | No worker E2E line at all on the Mi 9T, neither the new diagnostics nor the first-frame `encrypting` / `decrypting` lines | above; to be read before the diagnostics table can be used |
| CALL-BAR-COVERED | **P3** | With the composer or its camera open (full-screen layers above the banner column), the call bar is hidden: `elementFromPoint` at the bar's centre returns the camera's `<video>`; mute and hang-up are unreachable until the layer is closed (the call itself stays up) | Mi 9T, the composer open then its camera, call minimised |
| CALL-OS-BANNER | **P3** | An OS notification "Appel entrant - ... vous appelle" is drawn on the iPhone while the in-app full-screen ring is already on screen in the foreground | the WDA tree during the ring |
| LOG-IOS-SIZE | **P3 (tooling)** | The iPhone's exported log is 1.1 MB and cannot be searched or paged through the bench; there is no way to clear it | above |

**Owed:** the iPhone's `[Call] ... E2E` lines (needs a readable log), a worker-side read on the Mi 9T, a desktop
counterpart for the noise, the Mi 9T as the caller in the Wi-Fi rows, the iPhone's booking and reel rows, an
association delete with a form (an account that owns an association), a Back after the upload has begun, a hearing
check of the remote voice on both phones, and the iPhone's `app hidden` lines.

## 2026-10-19 - the call noise isolated: the iPhone's SENDER is the faulty side, the Mi 9T is clean

CALL-AUDIO-1 left two suspects (the iPhone sending non-Opus bytes, or the Mi 9T not decrypting). Test, on
`1.3.1-alpha.1` against `dev.canari-emse.fr`, no new build: each phone called from desktop Chrome (a Chromium
engine already proven clean in the fidelity rig), the RECEIVING side read with `getStats()` every 2 s over CDP
and, on the Mi 9T, `logcat`. Desktop microphone: Chrome's fake device playing a 12 s looped speech-like wav (same
`echoCancellation`/`noiseSuppression`/`autoGainControl` constraints as the app). Accounts: the Mi 9T is bench
account `fourth`, the iPhone `third`; the desktop was `fourth`'s dev profile against the iPhone and `third`'s
against the Mi 9T. Each call about 40 s after the accept. Two calls per phone's direction table below, one per
initiator; a call carries both directions, so one call reads two rows.

| Pair (sender -> receiver) | Where read | Concealed / total samples | Lost | `Decode error` (logcat) | Verdict |
| --- | --- | --- | --- | --- | --- |
| iPhone -> desktop, desktop called (C) | desktop `getStats` | **58 %** over 26 s (60 % cumulative), 365 events, 544 discarded | 0 | n/a (desktop) | **NOISY** |
| iPhone -> desktop, iPhone called (D) | desktop `getStats` | **68 %** over 26 s (65 % cumulative), 297 events, 530 discarded | 0 | n/a (desktop) | **NOISY** |
| desktop -> iPhone (C and D) | the iPhone | not readable | - | - | **NOT-READ**: the TestFlight build is not inspectable |
| desktop -> Mi 9T, desktop called (A) | Mi 9T `getStats` + logcat | 0.0 % (0.2 % cumulative, 2 events) | 0 | **0** | **CLEAN** |
| Mi 9T -> desktop, desktop called (A) | desktop `getStats` | 0.0 % (0.1 % cumulative, 2 events) | 0 | n/a | **CLEAN** |
| Mi 9T -> desktop, Mi 9T called (B) | desktop `getStats` | 0.0 % (0.0 % cumulative) | 0 | n/a | **CLEAN** |
| desktop -> Mi 9T, Mi 9T called (B) | Mi 9T `getStats` + logcat | 0.0 % (0.1 % cumulative, 1 event) | 0 | **0** | **CLEAN** |

Every call logged `E2E sender transform attached (audio)` and `E2E receiver transform attached (audio)` on both
ends, no `[Call]` error or warning, and `audioLevel` was a plausible 0.0-0.26 on the clean pairs (the iPhone's
sound reached 0.84 in C). The iPhone calls ran `relay/udp -> srflx/udp` (different networks), the Mi 9T calls
`srflx/udp <-> relay/udp`; packet loss was 0 in all of them, so the network is not the difference.

**Conclusion.** The Mi 9T decodes a Chromium sender's audio perfectly (0 decode errors in logcat against 14,568
on 2026-10-19 receiving the iPhone), and a Chromium receiver is just as clean from the Mi 9T. Receiving the
iPhone, a Chromium receiver on a different engine, network and phone is as noisy as the Mi 9T was (58-68 %
concealed, about half the packets discarded by the jitter buffer). So **the fault is in what the iPhone sends**:
its WebKit sender hands the decoder bytes that are not one Opus packet (the signature the fidelity rig gives for
ciphertext reaching the decoder, [calls](frontend/modules/calls.md#audio-quality-measured-2026-10-19)), whatever the
initiator. It is NOT the Mi 9T's WebView (not decrypting), and not the desktop's. What this does not separate,
inside the iPhone's sender: the sender frame transform running twice, WebKit handing it something other than one
Opus frame per call, or WebKit's own encrypt/packetise path.

Owed: (1) the iPhone as RECEIVER of a clean sender (row desktop -> iPhone), which needs an inspectable iPhone
build or the ear of a person; (2) the witness of the draft PR #2140 on the iPhone (its `ERROR E2E sender` line
names the exact case) once it rides a pre-release, or a desktop-side tap on the encoded frames of the iPhone's
audio (their length and the first byte against RFC 6716). Bench lessons: a Chrome profile left running without the
fake-device flags has no deterministic microphone, relaunch it with `--use-fake-device-for-media-stream
--use-file-for-fake-audio-capture`; `startCall failed: Error: WC not initialized` on a desktop right after the PIN
is cured by a reload plus the PIN again; on the iPhone the ring is a native banner (tap it, then "Accepter l'appel
entrant"); an accept done by a DOM `click()` over CDP is enough on both the desktop and the Mi 9T.

## 2026-10-20 - `v1.3.1-alpha.3` on both bench phones: the E2E worker report, CALL-WIFI, a suspended app

Pre-release run 39375779687 (commit `4cb14cfb7`, dev estate deployed, dev `call-service` restarted with it).
**Mi 9T**: release APK of the GitHub release, `versionCode` 100300103, `adb install -r` over alpha.2 (data kept;
Play Protect asked to scan an unknown app: "Ne pas envoyer"), account `delta`; "A propos" reads "Version de Canari
1.3.1-alpha.3". Read over CDP (the console streamed to a file for the whole session) plus `logcat`. **iPhone 12**:
TestFlight offered `1.3.1 (100300103)` about 6 min after the run ended ("Mettre a jour"), account `gamma`, PIN
screen then the feed; "A propos" reads "Version de Canari 1.3.1-alpha.3". Both on the bench Wi-Fi, no SIM, both apps
in the foreground in their shared direct conversation. Five calls, about 25 min of call time; the server side is
the dev `call-service` log, read only.

**The iPhone's log was read this time.** The exported file (1.4 MB, 16,876 lines) was attached from the iPhone
("+" > "Tous les fichiers") to the bench conversation; on the Mi 9T, a hook on `URL.createObjectURL` installed over
CDP kept the decrypted `Blob` when "Telecharger le fichier" was pressed, and its text was read from the page (the
native save picker that follows was cancelled). That is the way off the phone that LOG-IOS-SIZE asked for, with
no new code. Lines quoted below never include the `fp=` key line.

| Row ([CALL-L1](device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both)) | Verdict | What was read |
| --- | --- | --- |
| 0. idle call > 60 s | **`PASS`** | Mi 9T called, iPhone accepted; nobody spoke, no network change, 96 s paired. Server: `p2p paired`, then only the two `sent Close` at the hang-up (`disposition=client-close` both). **No `held dead`, `keepalive-lost` or `not taken within` line.** Neither app logged a `[Call]` line during the idle minute |
| 1. E2E worker report | **read on both phones** | see the next table: the iPhone's transforms carry every frame; **the Mi 9T's carry none, in every call** |
| 8. Mi 9T Wi-Fi off 6 s (Mi 9T polite) | **`PASS`** | `closed code=1006 - resuming`, attempts 1-3 failed, `signalling resumed on attempt 4` 11 s after the drop, `pair resumed: ... audio packets 627 -> 727`, `the media path carried audio across the outage - no ICE restart`; the iPhone's audio back at the Mi 9T 9 s after the drop (NetEq lines resume); no "Reconnexion..." on the iPhone afterwards. The iPhone (initiator) had sent `ICE restart 1/3` at its own ICE `disconnected`, and on the resume `rolling back unanswered offer #2` then a new restart offer |
| 9. Mi 9T Wi-Fi off 14 s, Mi 9T polite | **`PASS`** | `signalling resumed on attempt 6` (+19 s; the radio needs ~5 s to rejoin after it is switched on), `ICE disconnected (signalling resumed: path down) - asking the initiator to restart (1/3)`, the iPhone's restart offer answered, `media path restored after 1 ICE restart(s)`, audio back. Expected attempt 5 at +15 s; the extra attempt is the radio's rejoin time |
| 9. the same, Mi 9T initiator | **`PASS`** | `signalling resumed on attempt 6` (+19 s), `ICE restart decided (signalling resumed: no packet since the break, path down, ice=disconnected)`, `ICE restart 1/3`, `media path restored after 1 ICE restart(s)`, audio back |
| 10. Mi 9T Wi-Fi off 90 s | **`PASS`** | Mi 9T: 15 attempts, `terminal failure: signalling not restored after 15 resume attempts - ending call` at +55 s. Server: `answered none of 2 keepalive pings - held dead (half-open socket)` at +28 s, `p2p seat EXPIRED ... after 60 s away` at +88 s. iPhone: `the other party lost its signalling connection` at +28 s, `the other party left the call room` at +88.7 s, and the call left its screen. **CALL-WIFI-GHOST is closed** |
| 8-9 on the iPhone (Control Center Wi-Fi toggle, ~26-28 s: the toggles through WDA are slow, a 14 s outage was not reachable) | **`PASS`** | iPhone: `closed code=[redacted] - resuming`, attempts 1-7 failed, `signalling resumed on attempt 8` +28 s, `the media path carried audio across the outage - no ICE restart`. Mi 9T (initiator): `ICE restart 1/3` at ICE `disconnected`, its offer unanswered; on the iPhone's resume `rolling back unanswered offer #3 - its answer can no longer come`, `ICE restart offer #4`, answered; the iPhone's audio back at the Mi 9T. Server held the iPhone's socket dead at +27 s |
| 10 on the iPhone, Wi-Fi off 90 s | **`PASS`** | iPhone: 15 attempts, `terminal failure ... ending call` at +56 s. Server: held dead +26 s, seat EXPIRED +86 s. Mi 9T: `the other party lost its signalling connection` +26 s, `the other party left the call room` +85 s, call ended |
| 11. Mi 9T screen locked 40 s | **`PARTIAL`: the call survives, no audio while locked** | `[Call] app hidden state=incall mic=live voice=playing`; the call socket reset 5 s after the lock (server `Connection reset without closing handshake`, `seat away ... kept for a resume`); the iPhone's audio stopped at the Mi 9T within 4 s; resume attempts 1-4 failed while locked; on unlock `signalling resumed on attempt 5`, `asking the initiator to restart (1/3)`, `media path restored after 1 ICE restart(s)`, audio back. alpha.2 ended the call at +54 s; the 40 s lock is now inside the seat grace. The audio while locked is CALL-LOCK-ANDROID, as expected |
| 11. Mi 9T app backgrounded 40 s (HOME) | **`PARTIAL`, same shape** | `app hidden`, call socket `1006` 5 s later, the iPhone's audio stopped at the same moment; resume attempts kept RUNNING in the background (the app's JavaScript ran: a `connection failed` every 4 s), so the process was not frozen but its sockets could not connect; back in the foreground `signalling resumed on attempt 10`, one ICE restart, audio back |
| 11. iPhone screen locked 40 s (WDA lock) | **`PARTIAL`: the call survives, the iPhone sends no audio while locked** | the app kept running: no server line, no signalling fault on either side (the Pong kept answering). iPhone: `app hidden state=incall mic=live voice=playing`, then `WARN the system took the microphone (track muted)`; its sender stopped encrypting (no frame counted between 08:24:01 and 08:24:49) and the Mi 9T received nothing from it; on unlock `app visible ... mic=live/os-muted`, `the system gave the microphone back`, audio back |
| 11. iPhone backgrounded 40 s (HOME, app state 3) | **`PARTIAL`, same shape** | same lines (`the system took the microphone`), no signalling fault, no iPhone audio for the 40 s, back on return |
| CALL-BAR-COVERED (#2147) | **`PASS` for the chat camera** | call minimised, the chat composer's "+" > "Ouvrir la camera": `elementFromPoint` at the bar's centre is "Revenir a l'appel avec ...", at its right edge the hang-up; the bar is drawn over the camera preview (screenshot), and "Raccrocher" from the bar ended the call (`[Call] hung up from the top banner`). The post composer's camera was not opened this time |
| CALL-OS-BANNER (#2147) | **`PASS`, one ring** | iPhone ringing in the foreground: the WDA tree 1 s into the ring holds only the in-app screen (reduce, "Appel entrant", refuse, accept), no OS notification; the screenshot matches. One ring read, the Mi 9T calling |

### The E2E worker report (#2149), verbatim

**Mi 9T (`engine=Chrome/152`), ten lines, five calls, both roles, all the same shape.** The first and the last:

```
[Call] ERROR E2E worker report (5 s after connected): transformers sender=1 receiver=1 | frames in sender=0 receiver=0 | encrypted audio=0 video=0 | decrypted audio=0 video=0 | decrypt-failed=0 short=0 (empty 0) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=Chrome/152 attr sender=native receiver=native - no frame reached either transform
[Call] ERROR E2E worker report (call end, call=...): transformers sender=1 receiver=1 | frames in sender=0 receiver=0 | encrypted audio=0 video=0 | decrypted audio=0 video=0 | decrypt-failed=0 short=0 (empty 0) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=Chrome/152 attr sender=native receiver=native - no frame reached either transform
```

The worker answered every time (no `did not answer` line). Its transformers exist on both sides, the `transform`
attribute is native, and **neither transform was handed one frame**, at 5 s and at the end of calls of 50 s to 6 min,
while media flowed both ways (NetEq decoding, inbound packet counts rising). In the table of
[calls](frontend/modules/calls.md#the-mi-9t-logged-no-worker-line-at-all-131-alpha2---the-worker-is-now-asked) this
is the row "transformers 1, `frames in` 0 on a side: the transformer exists and is never fed: media flows around it",
on BOTH sides.

**iPhone 12 (`engine=iOS/18`, the WKWebView's user agent), one call shown in full, then the totals.**

```
[Call] E2E sender transformer #1 (1 sender in this worker): first frame audio mime=audio/opus pt=111
[Call] E2E encrypting audio (1 frame(s))
[Call] E2E receiver transformer #2 (1 receiver in this worker): first frame audio mime=audio/opus pt=111
[Call] E2E decrypt failed (1): OperationError: The operation failed for an operation-specific reason
[Call] E2E sender audio #1: 50 frame(s), not-opus=0 repeated-ts=0 own-iv=0 len=65..135 avg=108 toc=config15/code0 (100%)
[Call] audio send=audio/opus pt=111 ch=2 [minptime=10;useinbandfec=1] recv=? | local m=audio opus/111,red/63,g722/9,pcmu/0,pcma/8,cn/13,telephone-event/110,telephone-event/126 | remote m=audio opus/111,red/63,g722/9,pcmu/0,pcma/8,cn/13,telephone-event/110,telephone-event/126
[Call] E2E worker report (5 s after connected): transformers sender=1 receiver=1 | frames in sender=238 receiver=242 | encrypted audio=238 video=0 | decrypted audio=0 video=0 | decrypt-failed=242 short=0 (empty 0) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=iOS/18 attr sender=native receiver=native
[Call] E2E worker report (call end, call=...): transformers sender=1 receiver=1 | frames in sender=4764 receiver=4818 | encrypted audio=4764 video=0 | decrypted audio=0 video=0 | decrypt-failed=4764 short=54 (empty 54) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=iOS/18 attr sender=native receiver=native
```

| Call (caller -> callee) | iPhone at 5 s: frames in sender / receiver, encrypted, decrypted, decrypt-failed | iPhone at the end: the same | not-opus / double | Mi 9T at 5 s and end |
| --- | --- | --- | --- | --- |
| 1. Mi 9T -> iPhone, 96 s | 238 / 242, 238, 0, 242 | 4764 / 4818, 4764, 0, 4764 (short 54, all empty) | 0 0 / 0 | 0 / 0 both |
| 2. iPhone -> Mi 9T, 3 min 45 (rows 8-10) | 237 / 246, 237, 0, 246 | 11119 / 5278, 11119, 0, 5216 (short 62, empty) | 0 0 / 0 | 0 / 0 both |
| 3. Mi 9T -> iPhone, 5 min 30 (iPhone outages) | 241 / 240, 241, 0, 240 | 15086 / 10028, 15086, 0, 9757 (short 271, empty) | 0 0 / 0 | 0 / 0 both |
| 4. iPhone -> Mi 9T, 6 min (row 11) | 242 / 248, 242, 0, 248 | 14249 / 14742, 14249, 0, 14572 (short 170, empty) | 0 0 / 0 | 0 / 0 both |
| 5. iPhone -> Mi 9T, 50 s (stats) | 235 / 245, 235, 0, 245 | 2501 / 2536, 2501, 0, 2510 (short 26, empty) | 0 0 / 0 | 0 / 0 both |

The iPhone's sender shape line, one per call: `not-opus=0 repeated-ts=0 own-iv=0`, `len` 65-147 bytes, average
100-110, `toc=config15/code0 (100%)`; no `ERROR E2E sender` line in any call. On the iPhone **every non-empty frame
received from the Mi 9T failed to decrypt** (`decrypted audio=0`, 381 `E2E decrypt failed` lines in the log, the
counter at 14,572 in call 4), and no `no-key` drop. The iPhone's `audio send=` line reads `recv=?` (the receive codec is
not reported by WebKit).

**The receiving side of the iPhone's audio, Mi 9T (call 5, `getStats` on a peer connection captured by a constructor
hook installed over CDP before the call):** per 5 s interval 55.7, 58.8, 63.5, 63.8, 64.4, 66.6, 67.7, 69.6 %
concealed; cumulative 64.4 % at 45 s; 1 packet lost, jitter 3-4 ms, 835 packets discarded by the jitter buffer, codec
`audio/opus`, 253-256 packets per 5 s. NetEq `Decode error` lines per call: 1,409 / 1,492 / 2,803 / 3,003 / 759
(about 14.5 a second in every call), plus 637 `samples_per_channel_` lines. The iPhone as receiver has no stats line.

**What these numbers say, and no further.** The iPhone's sender transform sees one Opus packet per frame (config 15,
code 0) and encrypts each once (`double=0`, `own-iv=0`). The Mi 9T's transforms receive no frame in either direction.
The iPhone's receiver fails to decrypt every frame that comes from the Mi 9T. The Mi 9T's decoder rejects about 30 %
of the iPhone's packets and conceals ~64 % of the audio. The reading does not show what the Mi 9T puts on the wire,
nor why its worker is never fed, and it sits against the 2026-10-19 desktop rows above (Mi 9T paired with desktop
Chrome, clean both ways), which these counters do not explain: that pairing was on `1.3.1-alpha.1`, without the
report.

### Findings

| Id | Severity | What | Evidence |
| --- | --- | --- | --- |
| CALL-E2E-BYPASS-MI9T | **P1** | On the Mi 9T (Android WebView `Chrome/152`) both E2E transforms are attached (`transformers sender=1 receiver=1`, `attr native`) and receive **0 frames** in 10 reports over 5 calls, while audio flows both ways; the iPhone fails to decrypt every frame it receives from the Mi 9T; the call screen says "Appel chiffre de bout en bout" | the report table above; the iPhone's `decrypt-failed` counters |
| CALL-AUDIO-1 | **P1, unchanged, now with both ends' counters** | the Mi 9T conceals 56-70 % of the iPhone's audio, ~14.5 decode errors a second; the iPhone's sender counters are clean | above |
| CALL-LOCK-ANDROID | **P1, already in the backlog** | a locked or backgrounded Mi 9T loses its call socket and all audio 5 s in; the call now survives a 40 s lock or background through the resume | row 11 |
| CALL-IOS-MIC-HIDDEN | **P2** | a locked or backgrounded iPhone keeps the call (its process answers the keepalive) but the system takes its microphone: the partner hears nothing for as long as it lasts, with nothing on the partner's screen saying so | row 11, `WARN the system took the microphone (track muted)` |
| CALL-RESTART-BUDGET | **P3** | after a resume that rolled back an unanswered offer and restarted on a path already `connected`, the next loss starts at `ICE restart 2/3`, on both engines (iPhone in call 2 at 08:10:31, Mi 9T in call 3 at 08:18:49), although inbound packets rose in between: the refund-on-evidence did not apply. The iPhone in call 2 counted 1/3, 1/3 (after the rollback), then 2/3 at the next loss and 1/3, then 2/3 again | the iPhone's log 08:08:18-08:10:31; the Mi 9T's 08:16:47-08:18:49 |
| LOG-REDACT-CODE | **P3** | the iPhone's in-app log writes the WebSocket close code as `code=[redacted]` (the Mi 9T's live console shows `code=1006`) | the iPhone's export |
| CALL-GATHER-0 | **P3** | one call (Mi 9T polite, call 4) logged `ICE gathering complete (host=2 srflx=0 relay=0)` then `WARN no TURN relay candidate - a call that cannot go direct will fail` 50 ms after `connected`; the same device gathered srflx and relay candidates in every other call | the Mi 9T console, 08:21:17 |
| WS-PAUSE-NOISE | **P3** | at the Mi 9T's lock: `[WS] pauseSocket: native disconnect failed: Trying to work with closed connection` (WARN); on the iPhone, a `signalling WebSocket error` after a call had ended | both logs |

**Cause of CALL-E2E-BYPASS-MI9T, measured afterwards on this Mi 9T over CDP (2026-10-20):** Chromium short-circuits a
transform assigned one task after its sender or transceiver was created, and the app awaited the worker's `keyReady`
in between, so EVERY Chromium client sent clear audio and fed the iPhone's ciphertext to its decoder - which is
CALL-AUDIO-1 too, and why the 2026-10-19 Mi 9T to desktop pairing was clean (clear both ways). See
[calls](frontend/modules/calls.md#call-e2e-bypass-mi9t-2026-10-20---chromium-short-circuits-a-transform-assigned-one-task-late).

CALL-WIFI-14 and CALL-WIFI-GHOST of `1.3.1-alpha.2` are **closed** by rows 9 and 10 on both phones and both roles.
CALL-BAR-COVERED is closed for the chat camera; CALL-OS-BANNER is closed on one ring.

**Owed:** why the Mi 9T's worker is never fed (a worker-side CDP target, or the fidelity rig on an Android WebView);
the same report from a desktop Chrome paired with each phone (`callpeer.mjs`) to place the bypass; the post composer's
camera under the call bar; the iPhone as callee for the OS banner on more than one ring.

Rig lessons: the Mi 9T's call button is in the conversation's "..." menu on the phone layout; the iPhone's Control
Center opens on its media page, swipe down once to reach the Wi-Fi toggle, and WDA taps there take several seconds;
`svc wifi disable` on the Mi 9T over the USB serial keeps `adb` alive (a second, Wi-Fi `adb` transport of the same
phone drops).

## 2026-10-20 - `v1.3.1-alpha.4` on both bench phones: the call audio is clean, both transforms carry every frame

Pre-release run 39390044969 (commit `2299baeea`, carrying #2158: the transforms attached in the task that creates the
sender or receiver, "Verification du chiffrement..." until the worker proves the path, a typed error for a call whose
media flows around a transform). **Mi 9T**: release APK of the GitHub release, `versionCode` 100300104, `adb install
-r` over alpha.3 (Play Protect: "Ne pas envoyer"), account `delta`; "A propos" reads "Version de Canari
1.3.1-alpha.4". **iPhone 12**: TestFlight `1.3.1 (100300104)`, "Mettre a jour", account `gamma`, PIN then the feed;
"A propos" reads "Version de Canari 1.3.1-alpha.4". Same method as alpha.3: the Mi 9T's console streamed over CDP for
the whole session, a constructor hook on `RTCPeerConnection` reading `getStats()` every 5 s, `logcat` beside it; the
iPhone's in-app log exported after the calls (1.4 MB, 17,441 lines) and carried off through the bench conversation;
the dev `call-service` log read only. Both phones on the bench Wi-Fi, no SIM, in their shared direct conversation.
Nobody spoke near them (the Mi 9T's received `audioLevel` stayed 0.00003-0.0013), so the rows with speech are the
desktop ones, whose fake microphone plays a looped speech-like wav. Five phone calls and two desktop calls.

| Row ([CALL-L1](device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both)) | Verdict | What was read |
| --- | --- | --- |
| 1. E2E worker report, Mi 9T <-> iPhone, both callers | **`PASS`** | 238-249 frames per side at 5 s on BOTH phones, `decrypt-failed=0`, no `ERROR`, `E2E path check ... no media around the transform` on both, in every call (table below) |
| 1. Mi 9T hearing the iPhone | **`PASS`** | concealed 0.2-0.6 % cumulative over 60-90 s (alpha.3: 56-70 %), 0-1 lost, 0 discarded, 226-254 packets per 5 s; **0 NetEq `Decode error` lines in `logcat` over the whole session** (alpha.3: about 14.5 a second) |
| 1. iPhone hearing the Mi 9T | **`PASS` on the counters** | `decrypted audio` grows with `frames in receiver` (3784 of 3842 in call 3, the rest `short` empty frames), `decrypt-failed=0` in every call (alpha.3: every frame failed). Concealment NOT-READ: the TestFlight build is not inspectable |
| 1. Screen text | **`PASS`** | Mi 9T: "Verification du chiffrement..." from the dial or the ring, "Appel chiffre de bout en bout" 6-9 ms after `E2E proven`, itself 0.3-0.4 s after the transforms attach. iPhone (WDA tree polled every 0.5-1 s): "Verification du chiffrement..." on the ring, "Appel chiffre de bout en bout" 1.2-3.5 s after the accept tap; its log's `E2E proven` is 1.8 s after the tap in call 1 |
| 2. Mi 9T -> desktop Chrome (`callpeer.mjs`, profile w2 = `gamma` on dev, fake microphone), desktop accepts | **`PASS`** | desktop: 2128 packets in 45 s, 0 lost, **0 % concealed**, `relay->srflx`; Mi 9T hearing the desktop: 0.1 % concealed cumulative at `audioLevel` 0.12-0.41; both reports clean (below) |
| 2. desktop -> Mi 9T, Mi 9T accepts | **`PASS`** | Mi 9T hearing the desktop: 0.1 % cumulative at `audioLevel` 0.11-0.95; desktop hearing the Mi 9T: 0.0-0.1 %; both reports clean. Dialled from the page directly (the same stats hook), since `callpeer.mjs` reloads the page, which re-locks the PIN |
| 3. idle call > 60 s | **`PASS`** | call 2, about 85 s paired with nobody speaking before the outage below: no `held dead`, `keepalive-lost` or `not taken within` line on the server; call 1 (63 s paired) closed with two `disposition=client-close` |
| 3. Mi 9T Wi-Fi off 14 s (Mi 9T polite) | **`PASS`** | `closed code=1006 - resuming`, `signalling resumed on attempt 6` (+19.5 s), `pair resumed: ... audio packets 4699 -> 4808`, `the media path carried audio across the outage - no ICE restart`. The iPhone had restarted ICE at its own `disconnected` (`ICE restart 1/3`, offer #2, `media path restored after 1 ICE restart(s)` +17.7 s) and, on the resume, `rolling back unanswered offer #2`, offer #3 answered. Concealed back to 0.0 % per interval 10 s after the resume |
| 3. Mi 9T Wi-Fi off 90 s | **`PASS`** | Mi 9T: `terminal failure: signalling not restored after 15 resume attempts - ending call` at +55 s. Server: `held dead (half-open socket)` +29.5 s, `p2p seat EXPIRED ... after 60 s away` +89.5 s. iPhone: `the other party lost its signalling connection` +29.6 s, `the other party left the call room` +89.6 s, call screen gone |
| 3. Hang-up from each phone | **`PASS`** | Mi 9T "Raccrocher" (call 1): both ends' `call end` reports, server `client-close` twice. iPhone "Raccrocher" (call 3): `hung up from the full screen`; the Mi 9T logged `remote track ended` and its end report 1.5 s later |
| 3. Call bar above the composer camera (Mi 9T, call 3) | **`PASS`** | call minimised, "+" > "Ouvrir la camera": `elementFromPoint` at the bar's centre is "Revenir a l'appel avec ...", at the hang-up's centre "Raccrocher"; the screenshot shows the green bar over the live preview |
| 4. Video | not read | calls are audio-only on dev |

### The E2E worker report, verbatim

**Mi 9T (`engine=Chrome/152`), call 1 (the Mi 9T calls the iPhone):**

```
[Call] E2E sender transform attached (audio)
[Call] E2E receiver transform attached (audio)
[Call] E2E receiver transformer #2 (1 receiver in this worker): first frame audio mime=audio/opus pt=111
[Call] E2E sender transformer #1 (1 sender in this worker): first frame audio mime=audio/opus pt=111
[Call] E2E proven: this device encrypted a frame and decrypted one from the peer
[Call] E2E sender audio #1: 50 frame(s), not-opus=0 repeated-ts=0 own-iv=0 len=54..140 avg=105 toc=config15/code0 (100%)
[Call] E2E worker report (5 s after connected): transformers sender=1 receiver=1 | frames in sender=243 receiver=243 | encrypted audio=243 video=0 | decrypted audio=243 video=0 | decrypt-failed=0 short=0 (empty 0) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=Chrome/152 attr sender=native receiver=native
[Call] E2E path check (5 s after connected): no media around the transform (packets sent audio=260 video=0 received audio=242 video=0)
[Call] E2E worker report (call end, call=...): transformers sender=1 receiver=1 | frames in sender=3125 receiver=3173 | encrypted audio=3125 video=0 | decrypted audio=3125 video=0 | decrypt-failed=0 short=48 (empty 48) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=Chrome/152 attr sender=native receiver=native
```

**iPhone 12 (`engine=iOS/18`), the same call:**

```
[Call] E2E worker report (5 s after connected): transformers sender=1 receiver=1 | frames in sender=241 receiver=258 | encrypted audio=241 video=0 | decrypted audio=241 video=0 | decrypt-failed=0 short=17 (empty 17) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=iOS/18 attr sender=native receiver=native
[Call] E2E path check (5 s after connected): no media around the transform (packets sent audio=241 video=0 received audio=258 video=0)
[Call] E2E worker report (call end, call=...): transformers sender=1 receiver=1 | frames in sender=3143 receiver=3175 | encrypted audio=3143 video=0 | decrypted audio=3123 video=0 | decrypt-failed=0 short=52 (empty 52) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=iOS/18 attr sender=native receiver=native
```

| Call (caller -> callee) | Mi 9T at 5 s: frames in sender / receiver, encrypted, decrypted, decrypt-failed | Mi 9T at the end | The other end at 5 s | The other end at the end |
| --- | --- | --- | --- | --- |
| 1. Mi 9T -> iPhone, 63 s | 243 / 243, 243, 243, 0 | 3125 / 3173, 3125, 3125, 0 (short 48) | 241 / 258, 241, 241, 0 (short 17) | 3143 / 3175, 3143, 3123, 0 (short 52) |
| 2. iPhone -> Mi 9T, 4 min 25 (the row 3 outages) | 249 / 238, 249, 238, 0 | not logged: the call ended in the 90 s outage | 238 / 266, 238, 248, 0 (short 18) | 13183 / 7852, 13183, 7744, 0 (short 108) |
| 3. Mi 9T -> iPhone, 77 s (call bar, the iPhone hangs up) | 246 / 244, 246, 244, 0 | 3801 / 3841, 3801, 3785, 0 (short 56) | 242 / 260, 242, 242, 0 (short 18) | 3786 / 3842, 3786, 3784, 0 (short 58) |
| A. Mi 9T -> desktop (`Chrome/155`), 47 s | 251 / 275, 251, 253, 0 (short 22) | 2366 / 2408, 2366, 2359, 0 (short 49) | 250 / 248, 250, 248, 0 | 2359 / 2382, 2359, 2356, 0 (short 26) |
| B. desktop -> Mi 9T, 57 s | 249 / 260, 249, 250, 0 (short 10) | 2844 / 2874, 2844, 2836, 0 (short 38) | 250 / 272, 250, 248, 0 (short 24) | 2836 / 2887, 2836, 2834, 0 (short 53) |

`not-opus`, `double` and `no-key` read 0 everywhere. The iPhone's sender shape line: `len` 54-125 bytes, average
80-90, `toc=config15/code0 (100%)`; the Mi 9T's 52-140, average 101-105; the desktop's 105-148, average 126 (it
carries the wav). **CALL-E2E-BYPASS-MI9T and CALL-AUDIO-1 of alpha.3 are closed by these rows**: the Mi 9T's
transforms carry every frame, the iPhone decrypts all of them, and the Mi 9T's decoder no longer rejects the iPhone's
packets. The noise was the Mi 9T's clear audio reaching the iPhone's decrypt and the iPhone's ciphertext reaching the
Mi 9T's decoder, as #2158 found.

### Findings

| Id | Severity | What | Evidence |
| --- | --- | --- | --- |
| CALL-GATHER-0 | **P3, more frequent than alpha.3 said** | the CALLEE logged `ICE gathering complete (host=2 srflx=0 relay=0)` (once `srflx=1 relay=0`) then `WARN no TURN relay candidate` at `connected`, in 3 of the 4 calls where a phone answered: the iPhone in calls 1 and 3, the Mi 9T in call 2 (the Mi 9T in call B gathered `relay=12`); the callers always gathered relays (1-12). These calls connected over host pairs on the shared Wi-Fi, so nothing failed, but a callee that cannot go direct would. The Mi 9T's `logcat` also carries 52 `Received TURN CreatePermission error response, code=600; pruned connection` lines | both logs, 11:20:11, 11:21:44, 11:26:38 local |
| CALL-RESTART-BUDGET | **P3, unchanged** | the iPhone in call 2: `ICE restart 1/3` at the 14 s outage, `ICE restart 1/3` again on the resume (rollback of offer #2), then `ICE restart 2/3` at the next loss (the 90 s outage), although the call had been `connected` for 65 s in between | the iPhone's log 11:23:26-11:24:54 local |
| CALL-E2E-CLAIM-OUTAGE | **a question, not filed** | the Mi 9T's screen kept "Appel chiffre de bout en bout" through both outages (no packet received for about 15 s, then 55 s up to the terminal failure). The claim rests on frames, which kept being encrypted, and [calls](frontend/modules/calls.md) withdraws it only for an unreadable worker or unreadable stats, so this is the documented behaviour; whether an outage should show something else is a UI decision | the screen-text watcher, 11:23:17-11:23:37 and 11:24:37-11:25:34 local |

**Owed:** the iPhone's concealment as a receiver (an inspectable iPhone build, or an ear); the iPhone paired with a
desktop (`callpeer.mjs`), to read its receiver against a known-good sender; the iPhone-side outage rows were not
repeated on this build.

Rig lessons: `callpeer.mjs` reloads the page to install its tracker, and on a profile whose PIN gate comes back on
reload the `--dial` role needs the PIN again (`pin.mjs --port 9223 --account third`) after the reload, so the dial was
done from the live page; with the conversation open on both a desktop and the iPhone signed in as `gamma`, a Mi 9T
call rings both, and the desktop's accept stops the iPhone's ring.

## 2026-10-20 (afternoon) - `v1.3.1-alpha.4` across networks: forced relay, TCP and TLS TURN, a NATed hotspot

Same builds as the morning section (Mi 9T release APK `versionCode` 100300104, account `delta`; iPhone 12 TestFlight
`1.3.1 (100300104)`, account `gamma`), plus two desktop Chrome 155 profiles on dev (`gamma`, `delta`, fake microphone
playing a speech-like wav). Every reading so far ran on ONE Wi-Fi over host pairs; this one makes the direct path
impossible on purpose. No app code was changed: the policy is forced from OUTSIDE the app, by a subclass of
`RTCPeerConnection` evaluated into the LIVE page over CDP (no reload, so no PIN), which rewrites
`iceTransportPolicy` and optionally keeps only some of the TURN URLs the server handed out, and records every
`icecandidate`, `icecandidateerror` and state change with its millisecond. Stats are read every 5 s from the same
object; the desktops' and the Mi 9T's `[Call]` lines come from the console over CDP, the iPhone's from its exported
log (carried off through the bench conversation as before), the Mi 9T's libwebrtc lines from `logcat`, one desktop's
from Chrome's own `--enable-logging` file. The driver is a scratch script, not committed. Cloudflare TURN keeps no log
this project can read; the dev `call-service` log was not needed (every call paired).

| # | Configuration | Verdict | What was read |
| --- | --- | --- | --- |
| D0 | desktop <-> desktop, policy as shipped (`all`) | **`PASS`, and CALL-GATHER-0 reproduced** | `host/udp` both ways, 0 lost, 0 % concealed, reports 250 / 268 at 5 s, `decrypt-failed=0`; the CALLEE logged `ICE gathering complete (host=4 srflx=0 relay=0)` + `WARN no TURN relay candidate`, the caller `host=4 srflx=1 relay=3` (below) |
| D1 | desktop <-> desktop, BOTH `relay`, every TURN URL | **`PASS`** | `relay/udp -> relay/udp`, `relayed=yes relay_proto=udp`, RTT 16-22 ms, jitter 2-3 ms, 0 lost, **0 % concealed**; 250 / 273-274 frames at 5 s on both, `decrypt-failed=0`, path check `no media around the transform`; both sides gathered `relay=5` |
| D2 | the same, TURN over TCP and TLS URLs only | **`PASS`** | `relay_proto=tcp`, RTT 18-24 ms, jitter 1-2 ms, 0 lost, 0.4-0.5 % concealed; 250 / 267-268 at 5 s, `decrypt-failed=0` |
| D3 | the same, TURN over TLS on 443 only | **`PASS`** | `relay_proto=tls`, RTT 17-23 ms, jitter 1-2 ms, 0 lost, 0.1-0.2 % concealed; 250 / 267-268 at 5 s, `decrypt-failed=0`; one relay candidate per side |
| P1 | Mi 9T -> desktop, both `all`, bench Wi-Fi | **`PASS`** | 0 lost, 0-0.1 % concealed; Mi 9T 252 / 277 at 5 s, desktop 250 / 248, `decrypt-failed=0`. Both logged `selected path ... relayed=yes` at `connected` (Mi 9T `srflx->relay`, desktop `relay->srflx`); `getStats` read `host/udp -> host/udp` at the end (CALL-PATH-LINE below) |
| P2 | desktop (`relay`) -> Mi 9T (`relay`, TLS 443 only) | **`PASS`** | Mi 9T `relay_proto=tls`, RTT 24-27 ms, jitter 4 ms, 0 lost, 0 % concealed on both ends; Mi 9T 250 / 270 at 5 s and 2101 / 2138 (2093 decrypted) at the end, desktop 250 / 249 and 2093 / 2111, `decrypt-failed=0`; **no `CreatePermission` error in `logcat`** |
| P3 | Mi 9T (`relay`, every URL) -> iPhone (`all`) | **`PASS`, both ends read** | `relay/udp -> srflx/udp`, RTT 16-44 ms, jitter 4-8 ms, 0 lost, Mi 9T concealed 3.2 % in the first 5 s then 0 %; Mi 9T 250 / 241 at 5 s, end 2102 / 2122 (2094 decrypted); iPhone (callee) `host=2 srflx=2 relay=12`, `selected path pair=srflx/udp->relay/udp relayed=yes`, 240 / 248 at 5 s, end 2108 / 2125 (2101 decrypted), `decrypt-failed=0` both |
| P4 | iPhone (`all`) -> Mi 9T (`relay`, TLS 443 only) | **`PASS`** | `relay(tls) -> srflx`, RTT 19-48 ms, jitter 4-5 ms, 1 packet lost in 40 s, Mi 9T concealed 2.4 % cumulative (seven 5 s intervals at 0-3.4 %, one at 13.4 % with no loss and nobody speaking - TCP head-of-line delay is the likely reading, not measured); Mi 9T 250 / 240 at 5 s, end 2100 / 2120 (2090 decrypted); iPhone 241 / 267 at 5 s, end 2107 / 2141 (2099 decrypted), `decrypt-failed=0` both |
| P5 | Mi 9T on this PC's Windows mobile hotspot (its own NATed subnet, no working IPv6 egress) -> iPhone on the bench Wi-Fi, both `all` | **`PASS` for the call; the network is lossy** | direct through the PC's NAT: Mi 9T `prflx/udp -> host/udp`, iPhone `host/udp -> prflx/udp`, `relayed=no`, RTT 129-174 ms, jitter 30 ms; Mi 9T hearing the iPhone: 1 lost, concealed 4.8 % in the first 5 s then 0-0.2 %; Mi 9T 251 / 244 at 5 s, end 2093 / 2114 (2086 decrypted); iPhone 240 / 227 at 5 s, end **2172 sent / 1891 received** (1822 decrypted, `decrypt-failed=0`): about 10 % of the Mi 9T's frames never reached the iPhone. The hotspot shares the PC's one Wi-Fi radio, so that loss is not attributed to the app |
| P6 | iPhone -> Mi 9T, Mi 9T still on the hotspot | **`FAIL`: the Mi 9T never rang** | the iPhone rang its 60 s window (`ring window (60000 ms) closed unanswered`); the Mi 9T never received the invite: its chat socket had not been up since the network change (CALL-WS-V6 below). Back on the bench Wi-Fi the socket connected in 330 ms |
| C1 | either phone on mobile data | **NOT-READ: no SIM** | neither bench phone has a SIM (`gsm.sim.state=ABSENT` on the Mi 9T) |
| C2 | a desktop behind a different egress (a client-side SOCKS proxy through a remote host, or the school VPN), UDP filtered | **NOT-READ** | the user authorised both for this test; this session's permission guard refused to open the tunnel and to read the VPN profile, so neither was started |
| C3 | as shipped (`all`) with all UDP blocked on one end | **NOT-READ** | Chrome 155 accepted `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` on its command line and still paired `host/udp` without a proxy; an outbound firewall rule needs an elevated shell, which this session did not have. D2-D3 and P2 show TCP/TLS TURN carrying the call; what is not shown is ICE falling back to it on its own |
| - | the iPhone with relay forced | **NOT-READ** | the TestFlight WKWebView is not inspectable, so nothing can be evaluated into it |

**CALL-GATHER-0 - the cause, read in libwebrtc's own log (desktop callee, Chrome `--enable-logging`).** It is not a TURN
fault. The callee starts gathering only at its `setLocalDescription(answer)`, by then it already holds the caller's
trickled host candidates, and on one LAN a host pair answers within a few milliseconds:

```
.119 basic_port_allocator: Start getting ports ... Allocation Phase=Udp   (4 host ports, STUN lookups started)
.131 p2p_transport_channel: Changed writable_ to 1
.131 basic_port_allocator: All candidates gathered
.131 p2p_transport_channel: component 1 gathering complete
.132 [Call] ICE gathering complete (host=4 srflx=0 relay=0)
.220 basic_port_allocator: Discarding candidate because port is already done gathering.
```

With the default gather-once policy libwebrtc stops the allocator session as soon as a connection is writable; the
relay phase, scheduled after the UDP phase, never starts, and the server-reflexive answer that arrives 90 ms later is
discarded. The page timeline agrees on every desktop run: callee `gathering=gathering` at +75-87 ms, `ice=connected`
and `gathering=complete` in the SAME millisecond 2-7 ms later. Every time the direct pair could NOT answer first, the
callee gathered relays: `relay=5` (D1), `relay=12` on the iPhone as callee of a relay-only Mi 9T (P3), `relay=12` on
the Mi 9T as callee of a desktop in the morning. So the callee's call never lacks a relay when it needs one; what is
wrong is the WARN, which fires on every LAN call and names a cause ("Cloudflare TURN unreachable or misconfigured")
that is not there. The predicate that would be true: warn only when gathering completes while ICE is not yet
`connected`/`completed`, or count the page's `icecandidateerror` events, which the app does not listen to (on the
desktops they read `701` "Address not associated with the desired network interface" for TCP/TLS TURN on virtual
adapters, harmless).

**The `TURN CreatePermission` errors (CALL-TURN), read on both engines.** Desktop (Chrome log, one call): 12
`code=403`, every one on a pair from a local relay candidate to a remote HOST candidate whose address is a private
IPv4: Cloudflare will not relay to RFC 1918 peers, and libwebrtc prunes the pair. Mi 9T (`logcat`): `403` and `600`
(30 in one natural call: 6 and 24; 10 in P3; 2 in P4), on both its IPv4 and its IPv6 "Wildcard" relay ports - the
Android WebView gathers on `any` networks, which is what the `Socket is bound to the address ... rather than an address
associated with network` warnings say. `600` is, as far as this reading goes, the value libwebrtc reports for an error
response that carries no `ERROR-CODE` attribute; which peers draw it was not resolved (the WebView logs no peer
address). **When both ends were relay-only (P2) there were none**: the refusals come only from pairing a relay with the
other end's host or IPv6 candidates, pairs that could not carry media anyway, and no selected pair was ever among
them. Noise from libwebrtc on pairs that cannot work, not a credential problem; nothing in the app produces it.

### Findings

| Id | Severity | What | Evidence |
| --- | --- | --- | --- |
| CALL-WS-V6 | **P1** | On a Wi-Fi that hands out IPv6 addresses but carries no IPv6 traffic, the Android app's CHAT socket never connects: every attempt is abandoned by the 15 s JS timeout (`TauriMlsService.connect`) while the native socket's handshake completes 20-21 s after it started. The HTTP client (reqwest) falls back from the IPv6 address to the IPv4 one after 300 ms and works; the WebView's own WebSocket (the call signalling) works. So the phone sends, dials out and calls fine, but receives no live frame and NO CALL INVITE (P6) for as long as it stays on that network. The cause read here: the native connect tries the IPv6 address first and waits on it (IPv6 ping to the internet 100 % lost on that network, IPv6 default routes present); not read: whether each late-completed native socket is closed or left open | Mi 9T console: `Opening connection` at :55.7 / :40.8 / :25.8, `WebSocket connection timeout after 15s` 15 s later each time; `logcat` `tungstenite::handshake::client: Client handshake done` at :15.6 / :01.7 / :46.3, 20-21 s after each; `hyper_util ... connecting to [IPv6]:443` then `connecting to <IPv4>:443` 300 ms later, `connected`; back on the bench Wi-Fi `Connected to Chat Gateway` in 330 ms |
| CALL-GATHER-0 | **P3, cause found: a false alarm** | the callee's `WARN no TURN relay candidate` fires whenever its direct pair becomes writable before its STUN/TURN servers answer (libwebrtc stops gathering then); the callee gathers relays whenever the direct path is slower. The WARN's predicate and its stated cause are wrong; the relay path is not | the libwebrtc log above; D0, D1, P3 |
| CALL-TURN | **P3, explained** | `CreatePermission` `403` = Cloudflare refusing a private-IPv4 peer; `600` on the Android WebView's wildcard relay ports; both on pairs with no future, none when both ends relay; not a credential fault | above |
| CALL-PATH-LINE | **P3** | the `selected path ... relayed=` line, which [calls](frontend/modules/calls.md) calls "the only place that says whether a call was billed", is written once at `connected`; in P1 both ends logged `relayed=yes` while the pair settled on `host/udp -> host/udp`, so the line over-counts relayed calls when ICE moves to a better pair afterwards | P1: the two `selected path` lines against the end `getStats` pair |

**Proven:** the relay path works end to end with E2E on all three engines - Chrome 155, the Mi 9T's WebView Chrome/152
and the iPhone's WKWebView - over Cloudflare TURN by UDP, by TCP, and by TLS on 443 alone (the one transport a
filtered network nearly always lets out), with every frame encrypted and decrypted, 0 decrypt failures and 0-0.5 %
concealment between desktops; and a call across two NATs connects direct. **Not proven:** a real cellular or campus
network; a network that blocks UDP, with ICE choosing TCP/TLS TURN by itself; the iPhone's concealment as a receiver;
the iPhone forced to relay.

**Owed:** a SIM in one bench phone (C1); the user's permission rule for the client-side tunnel or the VPN (C2); an
elevated shell for a UDP-blocking firewall rule, or a proxy that makes Chrome's `disable_non_proxied_udp` bite (C3).

Rig lessons: the policy override is a subclass of `RTCPeerConnection` evaluated into the live page, because the app
constructs its peer connection by the global name at call time - no reload, no PIN; the iPhone answers through WDA
(`Accepter l'appel entrant`) and dials from the conversation's `Plus d'actions` menu; its file picker opens in
selection mode, so a tap on a log SELECTS it and `Ouvrir` attaches it - check the attached name before sending; the
Mi 9T reached over CDP after a Wi-Fi change keeps its `adb` USB forward; Chrome's own log needs `--enable-logging
--vmodule=*/webrtc/*=1` and holds ICE passwords, so it stays in the scratch directory.

## 2026-10-20 (afternoon) - `v1.3.1-alpha.4`: what a locked iPhone keeps, measured for WP-C-BG-I

Same builds and accounts as the morning (Mi 9T `delta`, iPhone 12 `gamma`, iOS 27.0.1), same Wi-Fi. The Mi 9T's
console and a `getStats()` poll every 5 s over CDP (a constructor hook on `RTCPeerConnection` installed before the
dial); the iPhone's app state and lock through WDA every 15 s. Mi 9T called, the iPhone accepted, then WDA locked the
iPhone for 3 min 20 s.

| Observable | Verdict |
| --- | --- |
| iPhone process during the lock | **alive**: the same pid before and after, app state `3` (background, running) at all 12 polls, never `2` |
| iPhone WebRTC during the lock | **alive**: its RTCP kept arriving at the Mi 9T (`remote-inbound-rtp` round-trip measurements 4 -> 39, `remote-outbound-rtp` reports 3 -> 42) |
| iPhone microphone during the lock | **muted within 3 s**: the Mi 9T's inbound audio packets froze at 1020 for the whole lock, concealment +240 000 samples per 5 s |
| After unlock | packets again within 10 s (1020 -> 1614), audio level back; the call never left `connected` |

So CALL-IOS-MIC-HIDDEN is the capture alone - the reasoning and the fix are
[calls, WP-C-BG-I](frontend/modules/calls.md#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20).

### Found on the way (not filed against WP-C-BG-I)

| Id | What | Evidence |
| --- | --- | --- |
| CALL-PAIR-STALL | the first call of the session never paired: the iPhone accepted and showed "Connexion..." for the whole window, the Mi 9T (caller) logged `call_answered` (`signal from ...`) but no `PeerReady`, then its call socket closed `1006` at exactly +60 s (`signalling pair broken`) and the ring window closed. The Mi 9T's CHAT socket had logged `4 pings without server response - closing zombie connection` before it. Neither the dev `call-service` log nor the iPhone's log was read | Mi 9T console 15:16:33-15:17:35 local |
| CALL-LATE-RING | after the Mi 9T's chat socket reconnected (15:18:50), it rang for the iPhone's call `87214182...` that the iPhone had ALREADY hung up: the invite and the hangup arrived together, the full-screen ring stayed up, and a new outgoing call was then refused locally as `busy (state=incoming ...)` | Mi 9T console 15:18:50-15:19:11 |
| BENCH-SHARED | during the measured call the Mi 9T received invites from `gamma` and from another `delta` device (`ignoring invite from own account on another device`): another client of both accounts was calling at the same time. The measurement is unaffected (one peer connection, its counters above), but a run on these accounts is not isolated | Mi 9T console 15:20:35-15:22:38 |

## 2026-10-21 - `v1.3.1-alpha.5` - the stable gate

What a stable `v1.3.1` owes, read on both bench phones with `v1.3.1-alpha.5` as installed.

- **Mi 9T**: release APK, `versionCode` 100300105, account `delta`. Console over CDP, logcat by pid.
- **iPhone 12**: TestFlight `1.3.1-alpha.5`, account `gamma`. Driven through WDA, syslog through `pymobiledevice3`.

Both sign in to `dev.canari-emse.fr`, which was reset to the fictional seed the same day
([dev-environment](infrastructure/dev-environment.md)). The seed has no communities, no conversations and no reels.

| Item | Mi 9T | iPhone 12 |
| --- | --- | --- |
| 1a. double tap likes a POST | **`PASS`** | **`PASS` with W3C taps**, see DT-IOS |
| 1b. double tap likes a REEL | **`PASS`** | **`PASS` with W3C taps**, see DT-IOS |
| 2. the camera no longer turns the app dark | **`PASS`** | **`PASS`** |
| 3. delete a form, then an association | **`PASS`** | nothing to delete: `gamma` is not admin and the UI offers no management |
| 4. five-minute smoke | **partial**: sign-in, DM receive and DM send `PASS`; background/foreground not read | **partial**: sign-in, DM send and receive, background/foreground `PASS`; the push banner not read |
| 5. calls and lives are a pre-release thing | gated off in a stable, by code and tests | same build flag |

### 1. Double tap to like

**Mi 9T posts** (CDP touch events on the WebView):

- A single tap on a post logs nothing and sends nothing.
- A double tap logs `[doubleTapLike] double tap`, then `[PostCard.doubleTap] 08697804...: like`. It sends `POST .../reactions`, which answers `201`, and the heart shows 1.
- A double tap on a liked post logs `already reacted, heart only` and sends no request, so it never unlikes.
- Two taps 450 ms apart are outside the 250 ms window and do not like.
- A triple tap gives ONE like and ONE `POST`.
- After a reaction picked in the picker (😂), a double tap is `heart only`, with no request.
- A single tap on the reaction button still opens the picker.

**Mi 9T reel**: reel `e9b08462` was filmed with the composer camera (4 s, long press) and published as `delta`.

- A single tap logs nothing.
- A double tap logs `[reel-viewer] double tap on e9b08462...: like`, sends a `POST` that answers `201`, and the label reads `J'aime, 1 réaction`.
- A second double tap sends no request.

**DT-IOS: reported as a P1, then NOT REPRODUCED.** The follow-up PR, which logs what reached the card, is
[#2175](https://github.com/emse-students/canari/pull/2175).

- **First attempts, all missed.** They ran right after the PIN-reset sign-in, on a feed still showing its stale pre-sign-in page:
  - a W3C double tap with 100 ms between taps on the "Liste Fictive" post;
  - a W3C double tap with 200 ms on "BDE Fictif";
  - three native `/wda/doubleTap` calls.
- **The same W3C gesture later liked.** It is one pointer, 40 ms holds:
  - 120 ms on "Alice Fictif" gave `❤️ 1`;
  - 200 ms on "Tournoi" gave `❤️ 1`;
  - on reel `e9b08462`, `J'aime, 1 réaction` became `J'aime, 2 réactions`.
- **XCUITest's own `doubleTap` never likes.** It was tried on "Repetition" and on the reel. Its two taps are not what a finger sends, so it is no evidence about WebKit.

So a real double tap likes on iOS. The first misses are unexplained, and #2175's log is what would explain them next
time. The single-tap and never-unlike sub-checks were read on the Mi 9T only. The reading left two of `gamma`'s
reactions on the dev seed:

- a 😊 on "Liste Fictive", from a stray tap;
- a ❤️ on "BDE Fictif", whose moment is uncertain.

### 2. The camera and the theme (#2123)

**iPhone, with the system in light mode.** The app stayed light after every close (screenshots):

- the composer camera, opened and closed 3 times, then 2 more times with the keyboard up;
- the swipe-to-camera tab, opened and closed 3 times.

**Mi 9T:**

- With the system in light mode, `data-theme` read `light` and the body background read `rgb(240, 242, 245)` during and after every cycle, keyboard up included.
- With the system in dark mode, the app stays dark.

Landscape does not apply: both apps are portrait-only.

- The iPhone's `Info.plist` declares Portrait only.
- A forced Android rotation leaves the viewport at 436x945.

The Mi 9T's rotation and night-mode settings were restored after the reading.

### 3. Deleting a form and an association (#2133)

Admin was granted and revoked on the dev test account for this reading, with the owner's approval. The route was
[dev-environment](infrastructure/dev-environment.md) section 3, on the dev database only:

1. A read-only `SELECT` first.
2. One `UPDATE users SET admin = true` on `delta`, which answered `UPDATE 1`.
3. After the deletes, `admin = false`, which answered `UPDATE 1`.
4. A final `SELECT`: `delta` reads `f`, and 0 of the 13 users are admins.

**On the Mi 9T, as `delta`**, after a cold start that carried the claim:

1. "Asso Lecture 1.3.1" was created through the UI: `POST /api/associations` answered `201`.
2. A form was created in it through Gestion > Formulaires > Nouveau formulaire: `POST /api/forms` answered `201`.
3. The form was deleted from the list: `DELETE /api/forms/65e2d181...` answered `200`, and the list emptied.
4. The association was deleted through Gestion > Danger > Supprimer l'association: `DELETE /api/associations/329017de...` answered `200`, followed by the directory reload.

There was no 4xx or 5xx in the window. **`PASS`.**

**On the iPhone, as `gamma` (not admin)**, the association showed in the directory. Its page offers Suivre, Agenda and
Membres, and no management link: the intended refusal.

### 4. The smoke

- **Sign-in**: both phones signed in again after the reset (artefacts below).
- **Communities**: none exist on the reset seed, so opening one was not read.
- **DM, iPhone to Mi 9T.** `gamma` created the DM.
  - The Mi 9T processed the Welcome: `[WELCOME] Group 192834c7... ready`.
  - It decrypted the message.
  - The native builder raised a notification while the app was open on `/posts`, titled with the sender and carrying the text.
- **DM, Mi 9T to iPhone.** The Mi 9T logged `[OUTBOX] 79fa14fa... sent`, the bubble showed on the iPhone, and the iPhone's `read_watermark` came back.
- **iPhone background and foreground.**
  - The app was sent home (state `3`, running in the background) and a message was sent to it from the Mi 9T.
  - On foreground the app resumed in the conversation (state `4`, the same process since 07:55) with the message shown.
  - The push BANNER itself was not observed: the syslog capture had stopped, and the swipe did not open Notification Center. The push is **not read**.
  - On foreground, the app process's only error lines were UIKit keyboard, RemoteTextInput and AudioAnalytics lines. These are frameworks restoring the keyboard, not app code.
- **Mi 9T background and foreground: not read** (see BENCH-SHARED-2).

### 5. Calls and lives in a stable

"En direct" and the `/api/lives` and `/api/calls/*` requests appear in alpha.5 only because it is a development
build. `frontend/src/lib/features.ts` sets four flags:

- `CALLS_COMPILED = false`;
- `CALLS_ENABLED = CALLS_COMPILED || deployEnvironment() === 'development'`;
- `CALLS_VIDEO_ENABLED = false`;
- `LIVE_ENABLED = deployEnvironment() === 'development'`.

`deployEnvironment()` returns `null` unless `VITE_DEPLOY_ENVIRONMENT` names dev, and a production build leaves it
unset. `features.test.ts` pins three things:

- `CALLS_ENABLED` is true for `development`, and false for `''` and for `staging`;
- `CALLS_COMPILED` is false;
- `CALLS_VIDEO_ENABLED` is false.

On the server, `LIVE_ENABLED` makes `/api/lives` answer `404` in production. **A stable build shows neither feature.**

### Filed as dev-reset artefacts (dev only, not product defects)

- **`local_state_sealed_under_old_pin` on both phones** after the reset. Each phone's saved MLS state was sealed under
  the PIN of the pre-reset account. It was cleared through the product's own "PIN oublié ?" > "Réinitialiser".
- **The sentence on that screen misleads after a server reset.** "Si vous avez changé votre PIN sur un autre appareil,
  saisissez l'ancien ci-dessous pour les garder" - but no PIN was changed, the server was reset. Only dev does that.
- **On the Mi 9T, `delta` was then refused `pin_mismatch`**: the reset dev verifier differs from the rig's PIN.
  `delta`'s PIN was reset to the rig's value, so a client that signs in as `delta` on dev with another PIN is now
  refused.

### Found on the way

| Id | What | Evidence |
| --- | --- | --- |
| BENCH-SHARED-2 | **The Mi 9T was driven by another session from 08:03.** That session's camera-swipe investigation sent CDP swipes and `location.href = '/posts'` recoveries, and a system back finished the activity at 08:21:37.<ul><li>Full reloads at 08:21:19, 08:21:28 and 08:28:10 (`[nav] allowing navigation to .../posts`).</li><li>Two `[TAURI] Couldn't find callback id` warnings: Tauri's own line for a reload while a Rust call is pending.</li><li>The Mi 9T background/foreground and a second push attempt could not run.</li></ul>Item 3's `DELETE`s answered before the first reload. **Two sessions on one bench phone invalidate each other's logs: the rig owes a device lock** | Mi 9T logcat 08:21:19-08:21:38, console 08:28:10 |
| EXIT-FORTIFY | **When the activity finished, the process logged a native abort**: `F libc: FORTIFY: pthread_mutex_lock called on a destroyed mutex` at 08:21:37.731, just after `onDestroy: destroying the WebView (... finishing=true)`.<ul><li>`dumpsys activity exit-info` records `EXIT_SELF` with status 0: `exit()` won the race and no crash was reported.</li><li>One of the morning's two finishing exits logged it; the 08:10:47 exit did not.</li></ul>A thread still locks a mutex that the exit's destructors already tore down. **Not filed yet** | Mi 9T logcat, pid 31452 |
| (known) absent-conversation at reload | After the 08:28:10 reload, the drain read a DM frame before the restore had seeded its conversation row: `Message for absent conversation`, then `[PENDING] 1 frame(s) left unacknowledged ... absent-conversation: 1`. The re-fetch on seeding delivered the frame 20 ms later. This is the cold-start P2 in [backlog](backlog.md) ("an absent conversation at cold start"), now on alpha.5. The warning's "re-fetched on every reconnect" overstates a frame recovered at once | Mi 9T console 08:28:11.7-08:28:12.2 |
| (open) overnight zombie sockets | `[WS] 4 pings without server response - closing zombie connection` at 04:36, 04:45, 04:55 and 06:12 local, with the Mi 9T idle overnight. The same line preceded CALL-PAIR-STALL above. Not investigated | Mi 9T console |
| (rig) sign-in warning | `[auth] redirect loop to /posts broken - staying on /login` at 08:05:17, during the Mi 9T sign-in. BENCH-SHARED-2 was forcing navigations to `/posts` in the same minutes, and the cause is not separated | Mi 9T console |
| (incident) | One failed login on a personal account via the iOS autofill sheet; the owner was informed | - |

### Rig lessons

- **The iOS autofill sheet sits over the keyboard's Go key.** "Remplir le nom d'utilisateur" covers the spot a scripted
  submit taps. Close it first (its X), and take a screenshot before every submit on a credential form.
- **XCUITest's `doubleTap` is no double tap for WebKit.** Read a double tap on the iPhone with a W3C sequence: one
  pointer, two 40 ms holds, and the gap under test.
- **`login.mjs` defaults to the `owner` account.** A device holding another account answers
  `device_holds_other_account`, so pass `--account`.
- **Stale Custom Tabs block `login.mjs`.** It fails with "Custom Tab never rendered a credential form". Tap
  "Connexion externe" once by hand, then re-run it, and it answers the open form.
- **A bench phone needs ONE driver.** Look for other CDP or adb clients of the serial before a reading, and again
  before believing a reload in its log (BENCH-SHARED-2).

## Reading runbook for the next calls alpha - one driver per phone, in this order (written 2026-10-21, NOT a reading)

**This section is a plan, not a result.** The next `vX.Y.Z-alpha.N` carries calls on dev builds only (`CALLS_ENABLED`
is true for `development`; `CALLS_COMPILED` stays false). Every row below is copied from a row that already exists;
the link names it, and a verdict goes back into THAT row, never into a new one. **What could not be found is listed
last, not invented.** Pass conditions are the cited rows' own words, shortened.

**Rules for the whole run**

- **One driver per bench phone at a time, assigned by the lead** ([testing-methodology](testing-methodology.md#one-driver-per-bench-phone-at-a-time-bench-shared-2-2026-10-21)).
  Before block M or I, look for other CDP or adb clients of the serial. A reload in a log is believed only when nobody
  else was driving. Blocks M and I are serial per phone; a cross-phone call needs BOTH phones, so it is ONE session
  holding both, never two agents.
- Both phones run the SAME pre-release (Settings > A propos shows `X.Y.Z-alpha.N`, `dev.canari-emse.fr`). **A store serves
  the highest build number**: Play may offer a stable above the alpha, and on TestFlight the alpha is picked by hand
  ([CALL-L1 precondition 1](device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both)).
- Never paste a `media keys derived from MLS` line older than 2026-10-21 into this repo. Record `setup_ms`,
  `relayed`, `rtt_ms`, `loss_in_pct` and `dec_fail` from `[CALL_REPORT]`, per direction, plus the build on each phone.
- A verdict is `PASS` or `FAIL` with the log inline, never `PASS-DIRTY`.

### Step 0 - one click, before any phone (the lead, a global admin)

| What | Why | Source |
| --- | --- | --- |
| `/admin/platform` on `dev.canari-emse.fr`, "Audio et video": set `callsMode` to `audio_video` | migration 014 lands `off` on an EXISTING database, and `off` answers `initiate`, `ring`, `room-token` and `ice-servers` with 403 `CALLS_DISABLED`, so no call works. Dev seeds `audio_video` only on a fresh seed. Read `GET /api/version` for `calls.mode` first: if it already says `audio_video`, no click | [backlog](backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks), [calls](frontend/modules/calls.md#the-kill-switch---platform_configcalls_mode) |

Also know before the first call: **dev sends no push until `DEV_FIREBASE_SERVICE_ACCOUNT_JSON` exists** (owner line in
[backlog](backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)); chat-delivery logs `[ring] Firebase Admin
is not initialised` at every ring until then, which is expected, not the finding.

### Block M - Mi 9T only (one driver; alone, or with a desktop `callpeer.mjs` peer)

Use a release APK: a debug APK installed over a release-signed install costs the enrolment. The phone reads
`ro.build.version.sdk` 36, so the API 28-30 paths stay unread.

**M1. The twelve background readings, WP-C-BG-A**, in a call with the iPhone or a desktop peer. Source:
[calls, "Owed on the Mi 9T"](frontend/modules/calls.md#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20).
Logs: `CallFgService`, `CallAudio`, `CallBridge` in `logcat`; `[Call] ongoing-call service ...` in the app log.

| # | Do | Pass |
| --- | --- | --- |
| 1 | lock 40 s | both sides keep hearing; no `closed code=1006`, no server `held dead` |
| 2 | HOME 40 s | same |
| 3 | read the notification | the name and a running timer; its hang-up ends the call on both ends |
| 4 | Back at the root during a call | the call goes on |
| 5 | speaker / earpiece from the call screen, `adb shell dumpsys audio` | `MODE_IN_COMMUNICATION`, the communication device, and WHO set the mode (Chromium may) |
| 6 | `adb shell dumpsys activity services fr.emse.canari` during the call | `isForeground=true`, `foregroundServiceType=0x80`; gone after |
| 7 | `dumpsys audio` AFTER the hang-up | `MODE_NORMAL`, no communication device (settles the mode's owner, review F1) |
| 8 | reload the page mid-call, then press the notification's hang-up | the service leaves; nothing stays in the shade |
| 9 | the FIRST-EVER call on a fresh install, through the microphone prompt | the service starts once the grant is answered, or is refused `off-screen` and started on `foreground` - never neither |
| 10 | swipe the app from Recents mid-call | the notification goes; the peer sees the call end |
| 11 | connect and disconnect a Bluetooth and a wired headset mid-call | the output follows, logged once per change |
| 12 | notifications DENIED for the app | the service still holds the call (read `dumpsys activity services`) |

Rows 9 and 12 change app state (a fresh install, a permission): run them LAST in this block and restore after.

**M2. The CALL-L1 rows with the Mi 9T as one end** (the iPhone is the other end, so this is the cross-phone session):
[CALL-L1](device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both) row 0 FIRST (an idle
call, more than 60 s), rows 1-5 and 7, then rows 8, 9 and 10 (Wi-Fi off 6 s, 14 s - once as callee - and 90 s) and row 11
(a suspended app, per phone and per gesture). Rows 9 and 10 `FAIL`ed on alpha.2 and were fixed; both are owed a re-read.
Row 6 (a killed callee rings nothing) is EXPECTED, not a `FAIL`.

**M3. The feed's left-edge gesture exclusion (#2184)**, gesture navigation. A row of the backlog, Kotlin and unit tests
only. The nine cells are those of [backlog](backlog.md#owed-a-verification-and-nothing-else) ("the feed's LEFT edge is
excluded"): (1) logcat `gesture exclusion: spans={LEFT=...} -> [ExclusionBand(left=0, ...)]` and the same rect in
`dumpsys window`; (2) on `/posts`, swipes from x = 20, 50 and 60 physical px at y = 1300 AND at the band's top and bottom
rows open the camera, 0 Back; (3) just above and below the band the left-edge Back still works; (4) the right edge is
intact (a reply swipe on an own bubble at x >= 406 CSS px, keyboard closed and open); (5) after a reload then `/posts`,
both edges' Back behave as specified; (6) leaving the feed clears the band (`/posts/<id>`, `/chat`, `/communities`,
`/camera`), as do the keyboard up, a rotation and a resume; (7) with an overlay over the feed (reel viewer, media
viewer, a modal, the composer's camera) a mid-screen left-edge Back closes it; (8) 3-button navigation: no rect, an
empty list in the log; (9) back-sensitivity slider at max: the band widens and still covers the start. A start on a
horizontal chip strip inside the band does nothing, by design. Recipe: `<harness-dir>/a1-bench/camera-swipe-r1021/`,
`gen1.mjs` straight cells. **Then the slow swipe by a real finger**: check
[V](device-verification.md#v-the-camera-swipe-on-a-fresh-feed-after-publishing---owed-on-android)'s own steps (publish, then
swipe right with no other navigation), ONE real-finger swipe, since every injected swipe passed. The slow-swipe cells of
the investigation are not in this repo (see the gaps).

**M4. Double tap, Mi 9T half.** [Check DT](device-verification.md#dt-a-double-tap-likes-a-post---owed-on-both-phones)
steps 1-7 on real fingers (the alpha.5 reading used CDP touches, see [DT-IOS](#1-double-tap-to-like)); step 7: a vibration
tick on a like with vibrations on in the settings, none with them off. Read `[doubleTapLike] double tap`,
`[PostCard.doubleTap] ...: like` and `[reel-viewer] double tap ...: like` over CDP.

**M5. The FCM banner on dev - BLOCKED until the secret exists.** Only once `DEV_FIREBASE_SERVICE_ACCOUNT_JSON` is set on
the `development` environment and a pre-release has deployed with it: a DM from the other account to the shut Mi 9T shows
a banner, and T1 (push to banner latency, [backlog](backlog.md#p2---a-notification-tap-takes-27-s-to-a-usable-conversation-when-killed-5-s-behind-the-pin-measured-2026-10-11))
is measured. Without the secret, record `NOT-OBSERVED`, never `FAIL`.

### Block I - iPhone 12 only (one driver; WDA for taps, the in-app log for lines)

The phone holds `gamma`'s account; pass `--account` to `login.mjs`. The iOS autofill sheet covers the Go key: screenshot
before every submit. **A double tap is a W3C sequence (one pointer, two 40 ms holds), never XCUITest's `doubleTap`**
([rig lessons](#rig-lessons)). In-app log: Settings > A propos > "Enregistrer le journal".

| # | Reading | Pass | Source |
| --- | --- | --- | --- |
| I1 | **CALL-L1 row 12, WP-C-BG-I**, in this order: (a) the iOS job's `UIBackgroundModes of the built app:` line lists `audio`; (b) in a connected call, lock the iPhone 60 s, then background it 60 s; (c) OUT of a call (the mode is app-wide) play a reel with sound, then a voice message, locking then backgrounding during each; (d) in a call, an audio ROUTE change (AirPods in and out, a wired headset) and a 2 s interruption (an alarm or Siri); (e) a call ACCEPTED from the lock screen. Record every `mute`/`unmute` pair with its duration | (b) the Mi 9T's inbound audio packets keep rising (`getStats()` over CDP every 5 s) and the iPhone keeps playing; no `the system took the microphone` line. (c) RECORD whether playback continues (a behaviour to accept or refuse). (d) a route change must NOT log `the system took the microphone`; if it does, how often and for how long. (e) it connects, and a muted start shows the notice until given back. If (b) still mutes, read the syslog (`WebKit`, `mediaserverd`) before any native audio code | [CALL-L1 row 12](device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both), [calls](frontend/modules/calls.md#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20) |
| I2 | **Double tap, iPhone half**: a REAL W3C double tap with the in-app log, [check DT](device-verification.md#dt-a-double-tap-likes-a-post---owed-on-both-phones) steps 1-6 (reel viewer, reel card in the feed, photo, text, poll option, VoiceOver) | one heart and one `like` line per double tap; the viewer does NOT open on a card double tap; a poll option votes and the post is NOT liked. Read #2175's log for the FIRST attempts after a sign-in on a stale feed, which missed on alpha.5 and were never explained: a miss with no `[doubleTapLike]` line means the tap never reached the card | [check DT](device-verification.md#dt-a-double-tap-likes-a-post---owed-on-both-phones), [DT-IOS](#1-double-tap-to-like) |
| I3 | **The push banner** on the shut phone, from a DM by the other account: BLOCKED like M5 until the dev Firebase secret exists, else `NOT-OBSERVED`. The alpha.5 smoke left it unread | a banner on the locked phone | [alpha.5 item 4](#4-the-smoke), [backlog](backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks) |
| I4 | **CALL-OS-BANNER**: one FOREGROUND ring on the iPhone | no "Appel entrant" OS banner over the in-app ring; if one shows, the two native candidates are in the backlog item | [backlog](backlog.md#p3---an-os-incoming-call-banner-over-the-in-app-ring-if-it-outlives-the-web-fix-2026-10-19) |

The iPhone's video reading is V2 and V3 below.

### Block V - video (V1 is the rig, V2 and V3 need both phones)

| # | Reading | Pass | Source |
| --- | --- | --- | --- |
| V1 | The two rig rows `video-switch` and `video-off-on` (`bun matrix.mjs` in `tools/call-audio-fidelity`), re-run on a QUIET host: nothing else heavy on the machine, no other agent's rig running. Not phone work, no phone needed | both `PASS`: `video-switch` ~29.9 fps and sender frames still counted AFTER the switch; `video-off-on` the peer's track mutes when off, events `unmute, mute, unmute`; every gated check: `video-fps` >= 27, `video-freezes` 0, `video-fed-after-op` | [calls, video](frontend/modules/calls.md#video-lot-2-2026-10-20---vp8-behind-a-clear-header-held-by-every-transceiver), [rig README](../../tools/call-audio-fidelity/README.md#the-video-rows-2026-10-20) |
| V2 | **CALL-L1 row 13 - a hidden peer video is still under its transform (B0)**: a dev build WITH video calls a build with video FORCED OFF (`CALLS_VIDEO_ENABLED` false: a local build, or the first audio-only alpha); the video side turns its camera on. ONCE with the iPhone as the audio-only side, ONCE with the Mi 9T | the audio-only side shows NO video and the call goes past 30 s with the camera on; the video side still hears and is heard. Log: `the peer sends video - this build is audio only, it is received and not shown`, then `E2E path check ...: no media around the transform` with `received ... video=` rising; NEVER `media flowed AROUND the transform on receiver:video` nor a `CallE2eBypassedError` end. A false END means the engine does not feed a receiver transform whose track has no sink, and the `inactive` route is owed | [CALL-L1 row 13](device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both), [calls](frontend/modules/calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21) |
| V3 | Video on the phones, the "Owed on the phones" table of the video section: Mi 9T to desktop Chrome `bun callpeer.mjs --browser w3 --launch --dial --video --hangup`, and the phone dialling; off/on, switch front/back, minimise; rotate. iPhone 12: `RTCRtpReceiver.getCapabilities('video')` lists VP8 and `setCodecPreferences` exists | `video ... VP8`, ~30 fps, freezes 0, `not-vp8=0`, `E2E proven`; the picture mutes to the avatar and returns; the back camera is not mirrored; `contain` in landscape, `cover` in portrait; a WebKit naming no codec FAILS CLOSED (a `not-vp8` ERROR) | [calls, video](frontend/modules/calls.md#video-lot-2-2026-10-20---vp8-behind-a-clear-header-held-by-every-transceiver) |

V3 needs `CALLS_VIDEO_ENABLED` true on both ends and V2 needs it false on one: plan the two builds before the session.
The second is a local build, which costs the Mi 9T's enrolment if installed over a release.

### Block N - network rows (the Mi 9T, plus the iPhone for the ring)

| # | Reading | Pass | Source |
| --- | --- | --- | --- |
| N1 | **CALL-WS-V6** (#2167): the PC's mobile hotspot with broken IPv6 (bench P6), the Mi 9T on it | `Connected to Chat Gateway` within a second; ONE `[WS-NET] ... while the preferred address was still pending` INFO line per connect in `logcat` (a WARN `... the preferred address FAILED` means the attempt errored rather than hung: record which); no `[WS] native socket completed ... closing it` WARN; **the iPhone's call RINGS the phone**; back on the bench Wi-Fi, no `[WS-NET]` line above debug. Delete the backlog item with this reading | [backlog](backlog.md#p1---call-ws-v6-is-fixed-on-a-branch-and-owed-one-phone-reading-2026-10-20) |
| N2 | **A relayed call on a phone.** The rig read forced TURN relay clean over UDP, TCP and TLS 443 on all three engines (#2165); no PHONE has read a relayed call. Take any call that goes through Cloudflare TURN (a throttled uplink, or the hotspot of N1) and record `relayed=yes` in `[CALL_REPORT]` and the `selected path pair=` line | audio both ways; `relayed=yes` where it is relayed (`relayed=` can over-count, see CALL-PATH-LINE in the backlog) | [calls B10](frontend/modules/calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21), [backlog](backlog.md#p3---call-path-line-the-selected-path--relayed-line-over-counts-relayed-calls-2026-10-20-not-built) |
| N3 | The Tier B audio cells K1, K9, K12 (Mi 9T / iPhone / desktop) and K6 (both phones) of [the matrix](frontend/modules/calls-revival-plan.md#7-the-test-matrix) | as the cells | calls B10 |

Cellular and campus Wi-Fi stay owed: no SIM on the bench.

### What could NOT be found in the repo (do not read these as covered)

- **The #2165 readings** (forced TURN relay over UDP, TCP and TLS 443; "readings PR open on 2026-10-21" per calls B10) are
  NOT on `main` as of this runbook, so N2 cites no row of theirs. Link them here when that PR merges.
- **A "quiet host" requirement for `video-switch` and `video-off-on`** appears in no repo doc: the rig README and
  [calls](frontend/modules/calls.md#video-lot-2-2026-10-20---vp8-behind-a-clear-header-held-by-every-transceiver) record both as
  `PASS` on 2026-10-20 with no load caveat. V1 follows the lead's instruction.
- **The slow-swipe camera cells** of the camera-swipe investigation (PR #2177) are not documented; only the left-edge
  cause B (decided, built as #2184's backlog row) is. M3 states the real-finger reading from check V instead.
- **A check lettered for the FCM banner on dev**: none exists. M5 and I3 reuse the backlog's T1 item and the owner line
  about the missing secret. Whether that secret exists NOW is not knowable from the repo.
- **One list of "calls readings"** does not exist: they are spread over CALL-L1, calls B8-B13 and the backlog, which is why
  this section exists.

## 2026-10-21 - `v1.3.1-alpha.5` - push banners

This complements the stable-gate section above, whose smoke left "the push banner not read". Same builds and
accounts: the Mi 9T as `delta`, the iPhone 12 as `gamma`. The peer was the rig's W2 desktop Chrome on dev, and the
two phones sent to each other.

**Dev cannot send a push, so the code this stable changes cannot be read on dev.**

- `serve-dev.yml` passes `DEV_FIREBASE_SERVICE_ACCOUNT_JSON`, and that secret exists in neither the repository nor
  the `development` environment. Adding it is the owner item in [backlog](backlog.md) ("set the
  `DEV_FIREBASE_SERVICE_ACCOUNT_JSON` secret").
- The stable's native change, `push_text.rs` and `proto_fields.rs` (#2112, WP-RC-7), is called only by the FCM
  service and the iOS NSE.
- So no banner for an app that is backgrounded or killed can appear on dev, on either phone. What dev CAN show is
  the in-app path: the WebSocket, and the app raising a local notification itself.

| Item | Mi 9T | iPhone 12 |
| --- | --- | --- |
| App backgrounded, screen off or locked, a DM arrives | **`NOT-OBSERVABLE` on dev.** On HOME the app logs `[WS] Paused - disconnect sent, socket released until the next foreground`, and no notification follows. | **`NOT-OBSERVABLE` on dev.** After the app went to state 2, nothing about a push appears in the syslog: no `apsd` delivery, no NSE line. |
| Foreground again, the message is there | **`PASS`.** `[PENDING] Fetched 1 pending messages`, then decrypted and added to the conversation. | **`PASS`.** The message is in the DM after launch. |
| A DM while the app is open elsewhere (the feed) | **`PASS`.** `[NOTIF] Inbound ... while the app is open on /posts showing the list - asking`, then `Raised ... by the native builder`. The notification sits on `canari_messages_v2`, titled with the sender and carrying the text, with the Répondre and Marquer comme lu actions. | **`PASS`.** The iOS banner shows the sender and the text in the foreground (`willPresentNotification delivery succeeded`). |
| Tapping that notification opens the conversation | **`PASS`.** `[notifNav] routing to /chat for pending conversation <the DM>`, and the DM opens. | **`PASS`.** `UNNotificationDefaultActionIdentifier`, and the DM with `delta` opens. |
| A reaction to your own message | **`NOT-OBSERVABLE` on dev.** The reaction frame was processed, and the in-app path raised nothing. That is by construction: `canari_reactions_v2` is posted only by `CanariFirebaseMessagingService`. | not read |
| A group or community message | none: the reset seed has no community | none |

**Logs.** No line from app code reached warning or error, with one exception:

- **Mi 9T, one warning:** `[WS] pauseSocket: native disconnect failed: Trying to work with closed connection`.
  - It came when the notification shade sent the app to the background on the tap. The socket was already closed, so
    a log warning was raised over an outcome that changed nothing.
  - It is **P3 noise**, under the rule that a line is expected AND necessary or is fixed.
- **Mi 9T, platform lines.** Codec2 and MediaCodec lines came from the feed's video decoder.
- **Mi 9T, 26 camera warnings at 08:53:20.** `Handler ... on a dead thread` came from `CameraCaptureSessionImpl.finalize`.
  - A camera session from the earlier camera-swipe work was not closed: the garbage collector finalized it when the app
    was backgrounded.
  - It is filed in Found on the way below.
- **iPhone:** only WebKit sandbox lines, media-timebase lines and UIKit keyboard lines.

**PASS for what dev can carry; the FCM banner itself is owed.** That means the background banners on both phones, the reaction notification and the
reel text. They need production, or dev given its Firebase secret.

### What the unread code risks

`git diff v1.3.0 v1.3.1-alpha.5 -- frontend/src-tauri/src/mobile` touches ONE branch: a `MediaMsg`.

- **What `reel` decides.** `reel` is `kind == video && intent (field 14) == 1`. When it is false, the text, the
  `mediaKind` and `thumbnail_readable` all compute exactly as `v1.3.0` did. Only the debug line's wording changed. So
  every message kind that already existed - text, reply, photo, video, voice note, audio, attachment, poll, reaction,
  system events - is unchanged.
- **What the tests cover.**
  - `a_reel_message_is_announced_as_a_canareel_and_never_hands_over_its_key`, `a_reel_caption_follows_the_announcement`,
    `a_single_block_reel_still_withholds_its_key` and `only_a_video_declaring_reel_message_is_a_reel` cover the new
    branch: no caption, a caption, an empty caption, an unknown intent, no intent, and a photo that declares the intent.
  - `every_sentence_is_written_in_both_languages` covers the two new sentences.
  - They build the bytes by field number, and those numbers match `libs/proto/canari.proto` (`caption = 8`,
    `encoding = 12`, `intent = 14`, `MEDIA_INTENT_REEL_MESSAGE = 1`).
  - The tests ran green in "Test Rust (Frontend Native (Tauri))", CI run 39247158171 on #2112's merge commit, 139
    passed. They could not be re-run here: this box's shared `target/` points at a deleted worktree.
- **Not covered.**
  - No test feeds bytes written by the TypeScript encoder to the Rust reader. `codec.reelMessage.test.ts` proves the
    writer's half on its own.
  - The Kotlin and Objective-C callers pass `mediaKind: "reel"` through. Their only test of it is `!= "image"`, so a
    reel never gets a thumbnail. That rule is read in the code and was never seen on a device.
- **Where reels can come from.** At `v1.3.1-alpha.5` no shipped client CREATES a reel message: the in-chat camera
  takes photos only until RC-3..RC-5 ([reels-in-chat](frontend/modules/reels-in-chat.md)), and `intent` is only
  carried through on decode and on forward. So the new branch has no traffic to meet in production.

**Risk: low.** The changed path is unreachable by shipped writers, and for every existing kind it is identical to
`v1.3.0`, which already passed on the FCM path. An FCM banner read on production after the release is enough.

### Incident: a dev PIN reset on `gamma`

To unlock the rig's W2 Chrome profile on dev, the product's "PIN oublié > Réinitialiser" was used, as the
stable-gate reading had done on the phones. **W2's dev profile (rig account key `third`) IS `gamma`, the iPhone's
account.**

- **What the server reset did.** `pin-reset` purges every device of the account (`security.controller.ts`
  `resetPin`), the iPhone's key packages and push token included.
- **How the iPhone came back.** Its local state was then sealed under a PIN the server no longer knew, so the iPhone
  went through the same reset. W2 was purged in turn.
- **The state afterwards.** The iPhone rejoined by an external commit, and `delta` answered its history request with 6
  messages. Dev only, a test account, nothing lost that mattered.
- **Rig lesson.** Before resetting a PIN, read which account the profile holds: the avatar label next to "Accéder au
  profil". A reset on one device signs out the account's other devices.

### Found on the way

| Id | What | Evidence |
| --- | --- | --- |
| PAUSE-WARN | `[WS] pauseSocket: native disconnect failed: Trying to work with closed connection` logged as a warning for a socket that was already closed (P3 noise) | Mi 9T console 08:57:14.173 |
| CAMERA-LEAK | 26 `W/MessageQueue ... Handler on a dead thread` from `CameraCaptureSessionImpl.finalize` at 08:53:20, when the app was backgrounded: a camera capture session left for the garbage collector instead of being closed. The camera was last used by the camera-swipe session before this reading, so the source is not separated | Mi 9T logcat, pid 32161 |
| (rig) shade tap = background | Opening the shade to tap a notification backgrounds the app, so its pause/resume runs once per tap. Expected, but it explains PAUSE-WARN | Mi 9T console 08:57:14 |
