## Reading owed - voice notes are recorded, not captured as a phone call (both phones)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

**What is built** ([sounds](../frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20)):
a voice note asks `RECORDING_AUDIO_CONSTRAINTS` (echo cancellation, noise suppression and auto gain
off, mono) instead of `{ audio: true }`, unless a call holds the microphone, in which case it asks the
call's own constraints. It replaces the P2 "voice notes are captured as a phone call" (owner,
2026-11-20, decisions 16 and 21 of [the day](owner-decisions-of-2026-11-20.md)). Decision 21 lets the
lead ship it without a further question **if the measurements are better**: the rows below are that
measurement. Nothing native changed; the engines read the constraints, so a phone is the only proof.

**The rows, on the Mi 9T AND the iPhone 12, on the pre-release:**

1. **Capture line.** Record a voice note: the in-app log reads `capture as recording (call phase none)`
   then the `capture:` line. Mi 9T: `echo=false noise=false agc=false ... ch=1 rec=as-granted`. iPhone:
   `echo=false noise=unsupported agc=unsupported rate=48000 size=16 ch=unsupported rec=mono-downmix`,
   preceded by `recorded through a one-channel downmix at 48000 Hz, context running` and followed by no
   `downmix context did not start` error. No field reads `undefined` any more. Before #3934 the Mi read
   `echo=true noise=true agc=true`; on `1.7.3-alpha.4` the iPhone read `ch=? noise=undefined
   agc=undefined`, which proved nothing (fixed: unsupported settings are named).
2. **No call configuration.** Mi 9T: `adb shell dumpsys audio` WHILE recording shows mode `NORMAL`
   (not `IN_COMMUNICATION`) and the record client with source `CAMCORDER` or `MIC`/generic, not
   `VOICE_COMMUNICATION`. iPhone: music from another app playing while recording STOPS - other audio is
   interrupted on purpose, as WhatsApp does (owner, 2026-11-22,
   [decision](owner-decisions-of-2026-11-22.md); this row used to say "NOT ducked") - and a voice note
   played right after recording comes out of the loudspeaker.
3. **The sound.** The same phrase, before (`1.7.2`) and after, built-in microphone, then a Bluetooth
   headset. Per file: `ffprobe` (codec, rate, channels, bitrate), `ffmpeg -af ebur128` (integrated
   loudness, true peak), `astats` (peak, clipped samples) and a spectrogram. **Acceptance:** spectral
   cutoff at or above 12 kHz on the built-in microphone, no clipped sample, mono (`ffprobe` channels=1 on
   BOTH phones: `1.7.3-alpha.4` gave the iPhone's AAC two channels, now downmixed), and the loudness question
   below (the playback law lands a note at -14 LUFS, not -18; the owner decides the target). A Bluetooth headset in HFP is narrowband whatever
   is asked; its line reads `device=bluetooth`. If a noisy room sounds worse, the A/B is a variant with
   noise suppression ON. If acceptance fails, the remaining levers of the research are, in order: an
   explicit bitrate (Opus 32 kb/s, AAC 48-64 kb/s), a speech loudness target of -16 to -18 LUFS (the
   -1 dBFS clamp kept), an 80 Hz high-pass in the playback route.
4. **[CLOSED by tests, 2026-11-22: `recordingConstraints.test.ts`, the pair `incall` / `none`; the OS mode is the call's own, `CallSoundHoldTest.kt`]** **A call is not broken.** In a call (Mi 9T and iPhone, each side once), record a voice note from the
   minimised call: the log reads `capture as call (call phase incall)`; the other side hears no echo
   while and after the note is recorded; on the Mi `dumpsys audio` still shows `IN_COMMUNICATION`
   after the note is sent and the call's output (speaker or earpiece) is unchanged; on the iPhone the
   `audio session` log stays `play-and-record` until the call ends, then goes back to `ambient`.
5. **[CLOSED, 2026-11-22: the OS's audio focus, no test can place a real ring; row 4's tests cover the page's side]** **A ring during a note.** Record a locked note, have the other phone call, answer: the call is heard
   both ways without echo; the note sends.
6. **The first press, through the permission prompt (iPhone; the Mi 9T once too).** With the microphone
   permission reset (reinstall), press and hold the microphone: the prompt appears; answer it. The
   recorder must NOT stay in `holding` with its clock running (`1.7.3-alpha.4`: stuck until the app was
   killed): the log reads `the press was interrupted while arming (window lost focus)` (or `pointer
   capture lost`) and the bar is back. The second press records and sends normally.
7. **A banner does not end a hold (Mi 9T).** Hold the microphone, have the other phone send a message
   so a heads-up notification drops over the app while the finger is down: the hold must go on (a
   `blur` from the banner would end it - `the hold was interrupted (window lost focus)` in the log is a
   FAIL), and the release sends. Once on the iPhone too, with a banner.

**Sources** (the research of 2026-11-20): Telegram `audio.c` (30 kb/s Opus, 48 kHz, mono, no
effects); Signal `AudioCodec.java` (AAC 32 kb/s, 44.1 kHz, mono, `MIC` source); RFC 7587 s3.1.1; EBU
R128 s2 and AES TD1008 for speech loudness; WebKit bugs 192932, 257495, 234784, 274222.

Charter: principle 2 (the essential is never lost - a voice note that cannot be understood is lost).

**2026-11-21, iPhone 12 on `1.7.3-alpha.4` (TestFlight build 100700304), account `gamma`, sitting r173a4-ios (evidence out of the repo).**
Mi 9T rows not taken here (its build failed). The WDA bench cannot hold a finger, so the notes were
recorded through the lock gesture (press, slide right 90 pt, release), not hold-and-release.

| Row | Verdict | Evidence |
| --- | --- | --- |
| 1 capture line | **PARTIAL** | The app log reads `capture as recording (call phase none)`, then `capture: echo=false noise=undefined agc=undefined rate=48000Hz ch=? device=builtin-or-other mime=audio/mp4 bps=192000`. Echo is off and the call branch is not taken; WebKit reports no noise or gain state and no channel count, so the line cannot prove `noise=false agc=false ch=1` on iOS. |
| 2 no call configuration | **PARTIAL** | The log shows `audio session ambient -> play-and-record` at the start and `-> ambient` at release (0 mic holders left). The WebKit session is `PlayAndRecord_WithBluetooth_DefaultToSpeaker`, mode `VideoChat` (WebKit's, expected). **Another app's music is STOPPED, not ducked:** with Safari playing audio, the syslog line `cmsInterruptSession ... INTERRUPTING ... [MediaPlayback] [NonMixable] ... stopping playing` fires at the first microphone open, and the Safari clock lost the recording's duration. The loudspeaker read after recording was not taken by ear. |
| 3 the sound | **NOT TAKEN** (container only) | Three notes fetched decrypted from the web peer: AAC, 48 kHz, **2 channels**, 150 kb/s. Every file is near-silent (peak -45 to -50.6 dBFS, integrated -64 LUFS): the workstation speech was not picked up and the phone's own playback was interrupted by the recording (row 2), so no loudness, clipping or cutoff figure exists and no `1.7.2` comparison was possible (no older iPhone build). Mono is NOT met on the iPhone (2 channels in the file). |
| 4 a call is not broken | **NOT TAKEN** | The iPhone called the web seat; the callee showed "Connexion..." and the call ended "Call not answered" (the web seat has no fake media device). |
| 5 a ring during a note | **NOT TAKEN** | Needs a call partner. |

Seen on the way: a microphone permission prompt raised by the very first press left the recorder in
`holding` with its timer running for minutes and no way out (slide, bin), until the app was ended;
not reproduced, since the prompt appears once.

**Mi 9T sitting, 1.7.3-alpha.5 (2026-11-22): PARTIAL, entry stays. Capture was observed with dumpsys audio during a recording; the iPhone half and any remaining rows are UNREAD.**

**2026-11-22, [I1 sitting](../device-verification.md#the-iphone-12-readings-of-2026-11-22-173-alpha5-the-backup-domains-the-banners-the-reactions-the-replay-bar-the-outage-drill) (`1.7.3-alpha.5`, iPhone 12): the iPhone's capture line is read:** `capture: echo=false noise=undefined agc=undefined rate=48000Hz ch=? device=builtin-or-other mime=audio/mp4 bps=192000`. WebKit reports only `echo` (false), so the call-style flags are neither shown nor refuted on the iPhone.

**Mi 9T sitting, `1.7.3-alpha.6` (2026-11-22): rows 1 and 2 PASS on Android.** A held microphone button: `capture as recording (call phase
none)` then `capture: echo=false noise=false agc=false rate=48000 size=16 ch=1 rec=as-granted ... mime=audio/mp4 bps=128000`.
`dumpsys audio` while recording: requested and actual mode `MODE_NORMAL`, the record client `src:CAMCORDER`, never
`VOICE_COMMUNICATION`. Rows 3 (sound), 4 (a call), 5 (a ring) and the iPhone half are not taken: the entry stays.

**Mi 9T sitting 2, `1.7.3-alpha.6` (2026-11-22): row 3 PARTIAL, rows 4 and 5 NOT readable, each with its replacement.** Row 3: a real six-second hold in a DM, the decrypted file fetched from the peer's web seat: MP4 container, Opus, 48 kHz, **one channel**, 126 kb/s, 6.7 s; peak -48.9 dBFS, no clipped sample - the room was silent, so loudness, the 12 kHz cutoff and the `1.7.2` A/B are not read (no speech source near the phone; the `1.7.2` build cannot sit beside this one; a Bluetooth headset's narrowband line is the OS's). **Replacements:** `recordingLoudness.test.ts` (what the playback law really does to a synthetic buffer, see the closing block); `monoRecording.test.ts` (the destination's one-channel configuration). Row 4: `recordingConstraints.test.ts` pins the pair - a call phase asks the call's own constraints, no phase asks `RECORDING_AUDIO_CONSTRAINTS`; the OS audio mode after the note has no automated reader and the page never sets it, so that half closes (`CallSoundHoldTest.kt` holds the call's own mode). Row 5 closes: a ring during a note is the OS's audio focus, no test can place a real ring, and row 4's two tests cover the page's side. The entry stays for the iPhone and rows 6 and 7.

**Closed by tests (2026-11-22).** Row 4 and row 5 are closed as above. Row 3's mono half is `monoRecording.test.ts` (the destination's one-channel configuration) beside the read file (Opus, 48 kHz, ONE channel, on the Mi 9T); the 12 kHz cutoff stays unread (a silent room) and is the encoder's; the `1.7.2`
A/B closes as impossible (that build cannot sit beside this one) and a Bluetooth HFP line is the OS's. **A FINDING, NOT A PASS - row 3's
loudness:** `recordingLoudness.test.ts` passes a synthetic 48 kHz buffer through the recording tap and the one playback law, and the law
brings a note to -14 LUFS (the video target), raised by at most +6 dB with the peak held under -1 dBFS. A note measured near -24 LUFS therefore
plays at -18, but **a quiet one does not**: 1 kHz and 14 kHz tones at -30 dBFS measure -34 LUFS and play at -28. "-18 +/- 2 LUFS after the
playback normalisation" is not a property of the law, so it cannot be closed by a test; the owner's call is whether a voice note gets its own speech
target (-16 to -18, the lever named above, peak clamp kept). **Still open:** that call, the iPhone half (row 1's capture line shows no
`noise`/`agc`, mono on the iPhone, rows 3, 6 and 7).

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** Loudness is decided: the owner chose a playback law of its own for voice notes ([decisions](owner-decisions-of-2026-11-22.md), item 6, [the entry](voice-notes-have-their-own-playback-loudness-law.md)), so row 3's loudness leaves this entry. Fix shipped in `1.7.3`, takeable now. Left for the next phone sitting: the iPhone's capture line (row 1) and mono file (row 3), row 6 on the iPhone and once on the Mi 9T, row 7 on the Mi 9T and once on the iPhone.

**2026-11-23, [`1.8.0-alpha.2`](../device-verification.md#the-readings-of-2026-11-23-180-alpha2-the-resume-with-salons-the-share-shortcuts-the-keyboard-on-a-photo-dm-the-inactive-iphone) (iPhone 12): row 7, the release that sends, is CLOSED, not takeable.** WDA cannot release a hold so that it sends; `VoiceRecorder.gesture.svelte.test.ts` covers the send on a plain release. Left: the iPhone half (rows 1, 3 and 6).
