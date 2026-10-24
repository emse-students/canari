# `v1.4.0-alpha.4` read on the Mi 9T, sideloaded, 2026-10-22

Second sideload reading of the 1.4.0 line, after the `alpha.1` reading in
[backlog](backlog.md#owed-a-verification-and-nothing-else). **A sideload proves the CODE, not the
Play-signed path**: the Play `internal` track is not usable from the bench phone's Google account (the
tester opt-in is a human click), so the release asset was installed with `adb`.

## Artefact and install

- The release asset `app-universal-release.apk` of the tag `v1.4.0-alpha.4`: package `fr.emse.canari`,
  versionName `1.4.0`, versionCode `100400004`, SHA-256 prefix `d30ff90638d5c45b`.
- The phone held a debuggable 1.3.1 build (installer none). It was uninstalled first (a bench phone
  is a sandbox, the data was disposable), then `adb install` of the APK.
- Sign-in on `dev.canari-emse.fr` went through the phone browser's live IdP session (no credential
  typed). The PIN gate was then passed by the lead, who reset the bench account's PIN on the phone;
  the PIN is not in this page.

## Verdicts

| # | Reading | Verdict | Evidence |
| --- | --- | --- | --- |
| 0 | unlock after kill and relaunch | **PASS** | unlock after kill and relaunch: PASS on the Mi 9T (alpha.4, build 100400004) |
| 1 | the app shows its version | **PASS** | Settings > About: "Version de Canari 1.4.0-alpha.4 - Vous utilisez la derniere version" |
| 2 | the feed renders, three tabs | **PASS** | Associations (four association posts), Suivis, Tout (a video post with a play button) each render; the "Environnement de test" banner shows. The scroll-up behaviour was skipped (its PR is not merged) |
| 3 | comments open in the full-screen sheet | **PASS** | the "Commentaires" sheet covers the screen with the post as its header and the composer above the keyboard; closed with its button. Nothing was posted |
| 4 | DM and group message, received and answered | **PASS** (salon NOT READ) | a second dev account drove a desktop browser. The conversation list showed both conversations with an unread count and the previews "DM-F4-01 ..." and "GRP-F4-01 ..."; both opened and displayed their message (the group also shows its "added to the group" notice). A reply typed in each was sent: the DM shows "Message envoye", and the group reply appeared with "Message lu par" the counterpart within 3 s. The counterpart agent was asked to confirm both replies on its side; that confirmation did not reach this reading, so the reverse direction rests on the read receipt alone. No salon exists on dev: not read |
| 5 | camera tab, 5 s shot, publish a CanaReel, it plays | **PASS** | reached with a swipe to the right on the feed; camera and microphone permissions granted; a 5.5 s press on the shutter gave a preview and "Suivant"; the "Nouveau CanaReel" step (30-day notice) published and returned to the feed. The reels viewer then showed the new reel ("A l'instant") and the video decoder looped on a ~5 s period (flush indices 144, 288, 432 at ~30 fps) |
| 6 | a push banner with the app killed | **NOT READ** | the app was stopped with `am force-stop`, which the runbook forbids (it puts the package in the STOPPED state and Android cancels every FCM delivery): logcat shows `GCM: broadcast intent callback: result=CANCELLED forIntent { act=com.google.android.c2dm.intent.RECEIVE ... pkg=fr.emse.canari }` at 17:55:02 and no notification of the app was posted in 200 s. That is the reader's error, not a finding about the app. The relaunch then met the PIN gate, where the reading stopped (the PIN was set by the lead and is not known to this reader). To redo: `input keyevent KEYCODE_HOME`, `am kill`, assert `pidof` is empty, then send |
| 7 | logcat | **PASS, with the lines below** | 42 401 lines for the whole device, 2 028 for the app process after the relaunch, 0 `FATAL`, 0 `ANR`, 0 `SIGABRT`; the release build prints no console line to logcat, so web console errors are not covered |

## Log lines that were not explained away

- `E/CanariFCM: retrievePushSecret: no pending file and no Keystore entry - background send cannot
  authenticate` at first launch, before any sign-in. Plausible on a fresh install (no secret yet);
  not checked that it does not recur after sign-in.
- `E/chromium [aw_browser_terminator.cc:173] Renderer process (30045) crash detected (code -1)` and
  `[...:122] Render process (30045) kill (OOM or update) wasn't handed by all associated webviews,
  killing application` at 17:18:00, one minute after first launch, from a process id that is not the
  app's (`cr_ChildProcessConn: onServiceDisconnected (crash or killed by oom): pid=30045`). The owner
  of that WebView was not identified, and the app was afterwards relaunched by the lead, so whether
  the app itself was hit is not known.
- `E/fr.emse.canari: Failed to query component interface for required system resources: 6` at 17:33
  and `E/cr_VideoCapture: CameraDevice.StateCallback onOpened` at 17:35: the second is an
  informational line logged at error level by WebView; the first is an OS resource query, unexplained.
- `W/chromium [sync_reader.cc:154] ASR: No room in socket buffer.: Broken pipe (32)` during the reel
  playback.

Explained by the platform and not counted: SELinux `avc: denied { search }` on cgroup, `userfaultfd:
MOVE ioctl seems unsupported`, the WebView feature warnings (Fenced frames, Topics, SharedStorage),
the Bluetooth permission lines of `cr_media`, `Codec2Client: query -- param skipped`.

## One observation in the accessibility tree

While the reel played, the viewer's accessibility tree carried a node "Impossible de lire les contenus
multimedias." although the video decoded and looped. It is probably the video element's fallback
content, always present in the tree; not confirmed against the markup.

## What this does NOT cover

A salon message, a push banner with the app killed (item 6),
any live feature, share-in and share-out, the iPhone 12.
