# Bench readings for calls and live, 2026-10-18

The phone bench pass asked for calls (lot 1, [calls](frontend/modules/calls.md)) first, then the
live feasibility bench (WP-L1, [live](frontend/modules/live.md)). **No call could be placed: every
call reading is `BLOCKED`, and the cause is below.** The live readings were taken instead, on both
bench phones, with no Canari code involved.

## 1. Calls - `BLOCKED`, no build within reach carries lot 1

| Reading | Verdict | Exact cause |
| --- | --- | --- |
| 1:1 call PC <-> Mi 9T, PC <-> iPhone 12: setup time, direct or TURN, audio both ways | **`BLOCKED`** | `dev.canari-emse.fr` answers `/api/version` `1.2.9-alpha.7` (`build dev.83ae8ba`). Lot 1 (#1997, merged 2026-10-17 23:41Z) and the ring window (#2010, merged 2026-10-18) are in NO tag: `v1.2.9-alpha.7` and `v1.2.9` both carry `CALLS_ENABLED = false` and the old `call-service`. So dev has no call button, no `p2p` room mode, and no Cloudflare TURN pair (the dev TURN secrets reach dev "at the next pre-release deploy", #1997). The phones run the same builds: Mi 9T `1.2.9` (store release, not inspectable), iPhone 12 TestFlight `1.2.9-alpha.7` |
| Video both ways | **N/A by design** | `CALLS_VIDEO_ENABLED = false` in lot 1: audio only until WP-C3 |
| `[CALL_REPORT]` line | **`BLOCKED`** | #2011 is OPEN (draft), not merged, not deployed |
| Ring/invite ordering on a weak uplink | **`BLOCKED`** | same as the first row |
| Key-mismatch behaviour | **`BLOCKED`** | same as the first row. #2013 (keys per direction, visible mismatch) is an open draft and changes this behaviour, so the reading is worth taking on a build carrying #2013 |

**Why the local estate was not used instead.** A local estate reaches the Mi 9T (`adb reverse`)
but not the iPhone, which has no reverse tunnel. `getIceServers` answers 503 with no Cloudflare TURN
pair, and the client then refuses the call before ringing (`CallService.ts`), so the local `.env`
would need that pair. And the Mi 9T would need a debug APK installed over the release one, which
costs the device (an uninstall). Dev is the target the brief names. One pre-release unblocks every
row.

**What unblocks it:** a pre-release cut from `main` (lot 1 + #2010, and #2011 if it has merged by
then). It deploys dev with the TURN pair and builds the tester apps with `CALLS_ENABLED`. After that,
TestFlight shows the update on the iPhone (one tap, see
[device-verification](device-verification.md#the-iphone-12-readings-of-v129-alpha7-2026-10-17)),
and Play's internal track updates the Mi 9T. That pre-release is the lead's call to make.

## 2. Live (WP-L1) - capture into short fMP4 segments and a growing MSE source, 30-42 min

**The method.** A probe script was injected through the inspector into a blank HTTPS page
(`example.com`). It ran in **Chrome 154 on the Mi 9T** (Android 16; the app's System WebView is
152) and in **Safari on the iPhone 12** (iOS 27.0.1). It does four things:

- capture with `getUserMedia` at 1280x720 / 30 fps from the back camera, with the microphone;
- record with `MediaRecorder` at a 2 s timeslice (`videoBitsPerSecond` 2.5 Mb/s, audio 64 kb/s);
- seal every chunk with AES-GCM-256 (WebCrypto), as a live segment would be sealed;
- append every chunk, as it comes out, to a `<video>` fed by `MediaSource` on the Mi 9T and
  `ManagedMediaSource` on the iPhone (a growing source, trimmed to the last 10-30 s).

A sample was read every 60 s through CDP / the WebKit inspector bridge. Battery and temperatures
came from `dumpsys battery` / `dumpsys thermalservice` (HAL values) and `pymobiledevice3
diagnostics battery`. Both phones were on USB, on Wi-Fi, screen on, page in front. **Nothing was
uploaded.** The byte rate produced is the uplink a broadcaster needs; a real upload needs a
target, and that is the host question (Q3).

| Reading | Mi 9T (Chrome 154) | iPhone 12 (Safari) | Verdict |
| --- | --- | --- | --- |
| Duration recorded | 36 min (2 159 s) | 42 min (2 530 s) | **`PASS`** both, past the 30 min floor |
| Recorder format | `video/mp4;codecs=avc1.42E01F,mp4a.40.2` (WebM also offered) | the same string | **`PASS`**: both phones record fragmented MP4 (H.264 + AAC) natively |
| Captured size | 720x1280 (portrait, the sensor is rotated) | 1280x720 | portrait vs landscape needs handling in the player |
| Bytes produced = uplink needed | 780 MB, **2.89 Mb/s mean**; 60 s windows p50 2.9, max 4.8 Mb/s | 433 MB, **1.37 Mb/s mean**; windows 1.2-1.57 Mb/s | Chrome **overshoots** the 2.5 Mb/s target by ~15 % on average and ~90 % at peak; Safari **undershoots** it by ~45 %. Budget an uplink of **~3-5 Mb/s** for an Android broadcaster |
| Seal cost (AES-GCM per 2 s chunk) | 5.3 ms (~730 KB chunks) | 1.4 ms | **`PASS`**: negligible |
| Growing source in MSE: appends, errors | 724 appends, **0 errors** | 1 348 appends, **0 errors** (`ManagedMediaSource`) | **`PASS`**: a MediaRecorder fMP4 chunk is appendable as is, on both engines |
| Playback | 3 dropped of 63 512 frames, never paused | 11 dropped of 74 444, never paused | **`PASS`** |
| Playback distance to the newest appended byte | p50 4.7 s, max 6.8 s | p50 0.9 s, max 2.1 s | that is the local floor. A viewer adds upload + manifest polling + download on top, so the 5-10 s estimate in [live](frontend/modules/live.md) is plausible on the iPhone and tight on Android |
| Battery | 47 % -> 38 % in 34 min = **~16 %/h**, on USB 500 mA (Android reported "not charging"). Idle with the same screen: < 1 % in 10 min | stayed at 100 %. USB gave 2.17 W and the battery gave another ~73 mA, so **~2.5 W in total**, against **~0.84 W** idle with the same screen (1.49 W in, of which 147 mA went to charging): **~+1.65 W** for the live | an estimate on both: see the unplugged run owed below |
| Heat | battery 27.9 -> 38.3 C; CPU4 48.2 -> 53.0 C; GPU 42.7 -> 47.5 C; thermal status **0 (none)** throughout; Chrome's GPU process p50 46 % of one core | **not readable**: diagnostics expose no temperature, and the phone did not raise a thermal warning on screen | Mi 9T **`PASS`**, no throttling at 36 min; iPhone **owed by hand** |
| App in the background for 20 s mid-live | capture **stops** (3 chunks in 33 s instead of ~16) with no `mute` event; the recorder stays `recording` and resumes on return | capture **stops**: the track fires `mute`, and resumes on return | confirms Q6: **a live drops when the broadcaster leaves the app**, on both |
| The player after that gap | stays **~22.5 s behind** the live edge and plays the backlog | the same, **~22.3 s** | **a finding for WP-L5**: after a stall, a live player must seek to the live edge, not play the backlog |

### 2b. The same live UNPLUGGED (2026-10-18, 10:50-11:25Z)

The user pulled both cables. The probe, the page and the settings were the same as above; the Mi 9T
was read over wireless adb (`USB powered: false` checked at the start). Battery level, voltage and
the HAL temperatures were read every minute.

| Reading | Mi 9T (Chrome 154), 35 min unplugged | iPhone 12 (Safari), unplugged from ~11:17Z to the replug at ~12:23Z |
| --- | --- | --- |
| Battery | **38 % -> 7 % in 31.3 min = ~59 %/h**, 5 % at the end; 3.52 -> 3.40 V under load. The replugged run above (~16 %/h) was USB covering most of the draw | **100 % -> 86 %**, read by the user. The reading time is uncertain: the relay said "about 30 min", but the phone stayed unplugged until ~12:23Z (~66 min). So the drain is **~14-28 %/h**, against ~59 %/h on the Mi 9T |
| Heat | battery 31.5 -> 40.8 C, CPU 44 -> 54-56 C, GPU 38 -> 47.5 C; thermal status **0** throughout | **warm (tiede)** at the back near the camera, by hand; the user says everything was fine |
| Stream | 806 MB, 714 appends, **0 append errors**, never paused, recorder never stopped; bitrate mean 3.06 Mb/s (60 s windows median 3.0, max 4.9); player behind the newest segment median 2.0 s, max 6.2 s | Safari stayed in front and the video kept moving (the user); 719 MB over 3 961 s, **mean 1.45 Mb/s** (60 s windows 1.27-2.38, median 1.43); **0 append errors**, never paused, every sample `recording/live/visible`, no window short of chunks; player behind the newest segment median 1.2 s, max 2.2 s; **17 dropped of 118 711 frames** |
| Degradation | dropped frames on the player 3 -> **571 of 63 015 (0.9 %)**, all after ~11:07Z, once the battery was under ~25 % and above ~38.5 C. The capture side held | none seen; the track muted once, at the replug |

**Verdict, Mi 9T: the stream is `PASS` for 30 min, the battery is not.** A 2019 phone streaming
720p at ~3 Mb/s with the screen on empties **~60 % of its battery per hour**. So a 60 min live
(the L4 ceiling) needs a charged phone, or a plugged one: the app should warn below ~60 %.
**Verdict, iPhone 12: `PASS` for 66 min unplugged** - a clean stream, warm to the touch, and a
drain several times lower than the Mi 9T's at about half the bitrate.

**What this settles for option C.** On both phones, MediaRecorder already produces the segment
format the plan wants (fMP4, H.264 + AAC), sealing it costs nothing, and a growing source plays
through MSE / ManagedMediaSource for 40 minutes with no append error. Nothing found refutes C. The
costs are the broadcaster's battery (~59 %/h unplugged on a 2019 Android phone, section 2b) and,
on Android, an encoder that does not hold its bitrate target.

**The limits of these readings.** They ran in Chrome and Safari, not in the app's WebViews: the
installed builds are a store release and a TestFlight build, and neither can be inspected. Chrome
154 and WebView 152 are both Chromium. Safari and WKWebView are both WebKit, but
**whether WKWebView exposes `ManagedMediaSource` is not read here**. One run each. Indoor light.

## 3. Owed - what needs a human hand

1. **Cut the pre-release** that carries lot 1 (section 1). That is the lead's action, not a touch on
   a phone. Then the iPhone's TestFlight "Mettre a jour" tap, if the update does not install in the
   background.
2. ~~An unplugged 30 min live on each phone~~ - TAKEN 2026-10-18 (section 2b). The probe,
   samplers and logs are in `<harness-dir>/live-bench-2026-10-18/`. The iPhone has no Wi-Fi
   pairing, so it was injected over USB, unplugged, and read back over USB. Its battery is a
   reading by hand with an uncertain time; a timed reading would narrow the 14-28 %/h.
3. **A WKWebView reading** of `ManagedMediaSource` needs an inspectable iOS bench build
   (`tools/ios-device/sign-install.mjs`). That is the agents' to do, not a human's; it is listed so
   that it is not mistaken for done. **2026-10-19**: the ANDROID app's WebView was read (the tester
   build is inspectable), with uploads through the dev ingest; the iOS app's WKWebView is still
   owed ([live, WP-L1](frontend/modules/live.md#wp-l1---measured-2026-10-19)).
4. **Cellular**: no SIM in either bench phone, so every reading above is on Wi-Fi.

## See also

- [calls](frontend/modules/calls.md), [calls-revival-plan](frontend/modules/calls-revival-plan.md)
- [live](frontend/modules/live.md) - WP-L1
- [device-verification](device-verification.md) - the bench and its rules
