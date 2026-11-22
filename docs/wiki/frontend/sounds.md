# Sounds - every sound the app emits, and the output it holds

**The rule: the app holds NO audio output when it is not playing something.** An output is opened
for a sound and released when that sound ends or when the app leaves the screen - by events
(`ended`, `visibilitychange`, `canari:foreground`), never by a timer.

## Why the rule exists (measured 2026-10-09)

A Pixel 6a on the store app `1.1.2`, read with `adb shell dumpsys audio`: the Canari process held
an AAudio output stream (usage `MEDIA`, mono 48 kHz) in state `started` **permanently** - in the
background too, while Android's cached-app freezer had the process frozen. When a push thawed it,
logcat printed `AudioTrack: restartIfDisabled(): releaseBuffer() track ... disabled due to previous
underrun, restarting`, and the user heard strange looping noises exactly as notifications arrived.
`adb shell appops set fr.emse.canari PLAY_AUDIO deny` stopped the noises while the native banners
still posted, which put the source in the WebView's own output, not in the notification channel.

The holder was the notification tones' `AudioContext`: built on the first tone, never suspended,
never closed. A running context renders silence for ever, so its platform stream stays `started`
whether anything is audible or not; freezing the process starves that stream, and thawing it
replays what the buffer held.

**Android's visibility API never changes in a backgrounded Tauri app**
([appForeground.ts](../../../frontend/src/lib/utils/appForeground.ts)), so "the app left the screen" is
ONE question with two sources: `visibilitychange` on web and desktop, the `canari:foreground` event
on Android. `onAppScreenChange` subscribes to both, and every release below uses it.

## The inventory

| Sound                                                 | Trigger                                                                                                                       | Output                                                                                              | Released                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "Message" trill (palette A; the "mention" one when it names the reader) | A message from someone else lands where the reader can see it (`canSeeArrival`); otherwise the OS notification sounds instead | the shared tone context ([toneOutput.ts](../../../frontend/src/lib/utils/toneOutput.ts)) | suspended when its oscillator ends |
| "Send" trill (palette A) | The reader sends a message | same | same |
| "Read" trill (palette A) | Messages the reader wrote are marked read | same | same |
| Incoming-call ring (Canari's ring "C1", two canaries, 5 s loop - [below](#the-incoming-ring---c1-owners-choice-2026-11-01)) | An incoming call rings in the open app ([calls](modules/calls.md#the-incoming-ring-canaris-own-owner-2026-11-01)) | ANDROID: a native `MediaPlayer` on the RINGTONE stream (`CallRingPlayer.kt`, through `canariCall.ringStart`); elsewhere the shared tone output, the file `static/sounds/canari_ring.wav` looped by its own `AudioBufferSourceNode` ([callRing.ts](../../../frontend/src/lib/utils/callRing.ts)), as a `call` tone (exempt from the call gate) | at the answer, decline or end; on leaving the screen (Android hands the call to the native CallStyle ring; web, desktop and the iPhone's open app post ONE OS notification), restarted on return while the call still rings |
| The caller's ringback (a canary roll and two falling whistles, 4 s loop) | The caller's invite has left and nobody answered yet (`CallService.ringingOut`) | a looping `<audio>` beside the call's voice in `CallOverlay` ([callRingback.ts](../../../frontend/src/lib/utils/callRingback.ts)), the file `static/sounds/canari_ringback.wav` | paused at the transition that ends the ring, and with the overlay |
| Voice notes, audio attachments                        | The reader presses play                                                                                                       | an `<audio>` element, under [playbackArbiter](../../../frontend/src/lib/actions/playbackArbiter.ts) | paused by another media starting, and on leaving the screen on a native phone              |
| Post, reel, live and conversation videos; the reel review | Scrolled into view (muted, ambient) or opened (audible)                                                                       | `<video>` elements, same arbiter                                                                    | ambient ones paused on leaving the screen everywhere                                       |
| A call's remote audio                                 | A call in progress                                                                                                            | the hidden sink in `CallOverlay`                                                                    | unbound (`srcObject = null`) when it stops carrying the stream                             |
| None: the voice-note waveform decode                  | A voice note is drawn                                                                                                         | an `OfflineAudioContext` - renders to memory, opens no device                                       | -                                                                                          |
| None: the reel editor's render                        | Publishing an edited video reel                                                                                               | a muted `<video>` captured into a recorder                                                          | element unloaded and both capture streams stopped when the render ends, success or failure |

The OS notification sounds (channels `canari_messages_v2`, `canari_mentions_v2`,
`canari_reactions_v2`, `canari_calls_v2`) and CallKit's ring are posted by the platform and are not
the app's output.

**During a call every sound above but the call's own is silenced** (2026-10-31): one gate,
[callSoundGate.ts](../../../frontend/src/lib/utils/callSoundGate.ts), held from the ring (out or in)
to the end - see [calls](modules/calls.md#the-apps-other-sounds-during-a-call-2026-10-31), which also
covers the native notifications.

## The palette - "A - Gazouillis" (user's choice, 2026-10-09)

ONE unique sound per event, each a light canary-bird trill, high but soft: **message** (two rising
chirps), **mention** (three rising chirps and a falling tail), **reaction** (one tiny high chirp),
**send** (one rising chirp), **read** (one tiny falling chirp). The parameters are a faithful port of
the listening prototype the user chose from, and live in ONE file,
[soundPalette.ts](../../../frontend/src/lib/utils/soundPalette.ts), read by both renderers:

- **In-app**: `scoreSound(name, ctx, startAt)` schedules the voices dry (the room reverb is omitted
  on purpose: the output suspends on the last oscillator's `ended`, which would cut a tail) at the
  prototype's 0.6 master gain. The vibrato oscillators are returned too, so none outlives the
  suspend. A mention shares the message rate limit (600 ms). **There is no in-app reaction tone**:
  reactions to one's own message arrive by push only, so that sound exists as the Android channel.
- **Android**: `bun tools/notification-sounds/render.mjs` renders message, mention and reaction
  offline (seeded room reverb, 44.1 kHz mono WAV, one common gain so the loudest peaks at -3 dBFS and
  relative levels hold) into `gen/android/app/src/main/res/raw/canari_gazouillis_*.wav`; `--check`
  fails on drift (tolerating a rounding step across platforms), and `notificationSoundsDrift.test.ts` runs it in CI. Re-run it after ANY palette edit and commit the files.
- **Channel ids moved to `_v2`.** A channel's sound is immutable once created, so
  `canari_messages`, `canari_mentions` and `canari_reactions` are deleted at startup
  (`CanariApplication.deleteSupersededChannels`) and the three sounding channels are re-created as
  `canari_*_v2` with the bundled file. Users lose any per-channel setting they had on the old ids.
  The group summary stays silent (`setOnlyAlertOnce` + `GROUP_ALERT_CHILDREN`). Pinned by
  `notificationChannels.test.ts` and `soundPalette.test.ts`.
- **iOS (2026-10-17): the same three files, NOT copied.** The hand-maintained `project.pbxproj` has
  a `NotificationSounds` group pointing at the Android `res/raw`, and each file is in the Resources
  phase of BOTH the app and the extension - so the drift test above covers the iPhone too. The
  banner's sound is a FILE NAME: the APNs `sound` the delivery service writes
  (`IOS_NOTIFICATION_SOUND`, choice per push in [chat-delivery](../services/chat-delivery.md)), the
  local notifications `canari_push.mm` posts (message, mention, reaction), and the "mention" trill
  the extension sets after decrypting, the one fact the server cannot see. A name a build does not
  bundle plays the default, silently, so `iosNotificationSounds.test.ts` holds the four spellings
  and the two Resources phases together. A post, a comment, a form keep the default, as their
  Android channels do.

**Owed:** a listen on the Mi 9T and the Pixel (channels, after upgrade: the old entries gone, the new
ones sounding) and on a browser (the in-app trills against the prototype); on the iPhone 12, a DM, a
mention and a reaction each heard as its trill (a TestFlight build carrying the bundle), and the
bundle read from the archive's `CompileC`/`CpResource` log lines.

## The incoming ring - "C1" (owner's choice, 2026-11-01)

Canari rings with its OWN tone, on every surface. The owner heard five candidate renders and chose
**C1**: a melody on the G major pentatonic (G6 B6 D7 B6 A6 / G6 B6 A6 E6 G6, a grace trill into D7)
sung by a canary, and a second, softer canary a third below it, 15 ms late, the pair resolving on a G
chord. 96 BPM, 8 beats: ONE seamless loop of exactly 5.000 s.

- **One definition.** `RING_PHRASE` and `RING_PERIOD_S` in
  [soundPalette.ts](../../../frontend/src/lib/utils/soundPalette.ts), the same voice model as the
  trills. `render.mjs` renders it with the same synthesis and room, then FOLDS every sample past the
  loop's end (the cadence's room tail) back onto its start, so `loop` playback has no seam; peak
  -1 dBFS (a ring must carry across a room, on the RINGTONE stream). The render is byte-identical to
  the file the owner approved. The room convolution is done by FFT since this sound (five seconds of
  sustained notes; the direct sum took minutes) - the other files' `--check` still passes unchanged.
- **Three files, one rendering**, all under `--check` (`notificationSoundsDrift.test.ts`):
  `res/raw/canari_ring.wav` (the Android channel and the native in-app player),
  `static/sounds/canari_ring.wav` (the web page), and `gen/apple/CallSounds/canari_ring_callkit.wav`
  - five loops, 25 s, seamless and under the 30 s Apple allows a bundled sound - for CallKit's
  `ringtoneSound`, which repeats it. `soundPalette.test.ts` pins the loop's length, that Android and
  the web ship the same bytes, and that the CallKit file is whole loops of it.
- **Android channel `canari_calls_v2`.** A channel's sound is immutable, so the Canari ring lives on a
  new id (`IncomingRing.CHANNEL_ID`, `call/IncomingRing.kt`); `canari_calls`, which rang the
  system's default ringtone, is deleted at startup with the palette's superseded ids. Same
  importance (HIGH), bypass-DND request, `USAGE_NOTIFICATION_RINGTONE` and vibration. The user can
  still pick another sound in the channel's settings; a per-channel setting on the old id is lost.
- **iPhone.** `CXProviderConfiguration.ringtoneSound = canari_ring_callkit.wav`, bundled in the app's
  Resources from the `CallSounds` group of the hand-maintained `project.pbxproj`
  (`iosNotificationSounds.test.ts`). A missing file is logged at ERROR and CallKit rings the system
  tone.
- **The iPhone with no VoIP token** gets the generic ring ALERT through FCM (`ringViaFcm` in
  chat-delivery's `calls.service.ts`), whose APNs `sound` is the same file (`IOS_CALL_RING_SOUND`
  in `push-payload.ts`; it named `default` until the backlog triage of 2026-11-11). The extension
  keeps the server's sound for a `call_ring`. `iosNotificationSounds.test.ts` holds the name, the
  service's use of it and the bundle together.
- **In the open app**: [calls](modules/calls.md#the-incoming-ring-canaris-own-owner-2026-11-01).

## The tone output, in detail

`playTone(name, score)` is the only way a tone is played. `score` schedules sources - the palette's
oscillators, or the incoming ring's looping buffer, which its owner `stop()`s - and returns them
(so does `playTone`); each one is counted in flight, and the `ended` of the LAST one calls `suspend()` - the Web
Audio call that stops the platform stream. The next tone calls `resume()`. Leaving the screen calls
`close()` and forgets the context; the next tone builds a new one. A voice of a closed context that
ends late is ignored, so a new context always counts from zero. There is ONE context for the app,
where each of the two `useNotifications()` instances used to open its own.

Pinned by `toneOutput.test.ts` (suspend after the last tone, not the first; resume rather than a
second context; close on `visibilitychange` hidden and on `canari:foreground` false) and
`playbackArbiter.test.ts` (ambient paused on hide and resumed on return; every media paused on a
native phone).

**Owed:** the same `dumpsys audio` reading on the Pixel 6a once a build carrying this is installed -
no stream `started` while the app is backgrounded.

## The silent switch and the ringer: who owns the category (owner, 2026-11-04)

**Reported (iPhone, 2026-11-04):** *with the phone in silent mode, sending a message still plays the
send sound - every other app is silent.* **The owner's rule, the same day:** the app's own sounds
(send, receive, read, mention, reaction) ALWAYS obey the silent switch; a CanaReel STARTS MUTED, and
once the reader taps its speaker the reel's sound plays even in silent mode - an explicit request,
as on Instagram; a call has the microphone's category while it runs.

**The measured cause.** Nothing in Canari set an audio session category: no `setCategory` in
`canari_ios.mm`, `canari_push.mm`, the NSE, a plugin or the Rust (searched 2026-11-04; the only
`AVAudioSession` use is the call proximity's route READ). WebKit chose alone, in
`MediaSessionManagerCocoa::updateSessionState` (read in WebKit's source the same day): a category
OVERRIDE first; else PlayAndRecord while the microphone is captured (and while Web Audio plays
after it - it sticks); else MediaPlayback when any `<audio>`/`<video>` is audible OR **has played
audibly since the last interruption**; else AmbientSound for Web Audio alone. AmbientSound obeys
the switch; MediaPlayback does not. So one voice note, one unmuted reel or one ringback left the
session in MediaPlayback for as long as its element lived, and every tone - Web Audio,
[`toneOutput.ts`](../../../frontend/src/lib/utils/toneOutput.ts) - rode it through the switch.

**The fix: the page owns the category** ([`audioSession.ts`](../../../frontend/src/lib/utils/audioSession.ts)),
through WebKit's Audio Session API - `navigator.audioSession.type`, the override WebKit applies
before every rule above (`DOMAudioSessionEnabled`, status mature, on by default in WKWebView; iOS
16.4+). ONE decision, `decideAudioSessionType`, over three facts that arrive as events:

| Facts | Type | WebKit category |
| --- | --- | --- |
| a call placed or answered (`callSoundPhase` `calling` / `incall`), OR a microphone held by any capture (`captureUserMedia`) | `play-and-record` | PlayAndRecord, mode VideoChat - what capture already got, and the ONLY override under which WebKit lets `getUserMedia` capture audio |
| an unmuted registered media playing (`playbackArbiter`: a reel the reader unmuted, a voice note, a video) | `playback` | MediaPlayback - plays with the switch on |
| everything else: idle, every tone, a ring coming in (`incoming`) | `ambient` | AmbientSound - obeys the switch, mixes with other apps |

- **THE MICROPHONE IS A FACT OF ITS OWN (review of #3018).** Once the page sets an override, WebKit
  no longer reaches its own "capturing -> PlayAndRecord" rule, and `MediaDevices::getUserMedia`
  REJECTS an audio capture under any override but none (`auto`) or PlayAndRecord (`InvalidStateError`,
  "AudioSession category is not compatible with audio capture" - read in WebKit's source). So EVERY
  audio capture goes through `captureUserMedia(devices, constraints, holder)` in `audioSession.ts`: it
  holds the microphone BEFORE the ask and releases it when every audio track of the capture has
  stopped (the prototype's `stop`, wrapped once, since `stop()` fires no event) or ended. The sites:
  the voice note (`VoiceRecorder.svelte`), the reel camera and the post camera's microphone
  (`cameraAccess.ts`), the live camera and the live screen's microphone (`liveDevice.ts`), and the
  call's microphone (`CallService.setupMedia` - an ANSWER opens it while the phase is still
  `incoming`, `ambient`). While a microphone is held, an unmuted media starting or stopping does not
  move the type under the live capture. `audioSession.captureSites.test.ts` scans the source and
  fails on any other `getUserMedia` that asks for audio; a video-only one (a call's camera) stays
  direct.
- **Who tells it.** `callSoundGate` exposes `callSoundPhase`, the strongest phase among its holders
  (`incall` > `calling` > `incoming`); the arbiter re-reads "a registered media plays unmuted" on
  every `play`, `pause`, `ended`, `volumechange` and unmount. `playTone` and the arbiter ARM the
  owner before any sound, so the first tone of a session already plays under `ambient`. A type equal
  to the one applied is not set again: the in-app log carries one `Log.i` line per transition,
  `audio session <from> -> <to> (<reason>)`.
- **A ring coming in stays `ambient`, so the in-app ring obeys the iPhone's silent switch -
  deliberately** (owner's rule, 2026-11-04): CallKit's ring obeys it too, and Web Audio alone is
  what WebKit already put there. The caller's ringback plays in `calling`, when the microphone is already
  open (`setupMedia` runs before the ring), so its category is the one it always had.
- **Only on iOS** (the user agent, or "Macintosh" with more than one touch point - an iPad): no other system has a silent switch, so elsewhere nothing is set and nothing is said. `window.webkit.messageHandlers` is NOT the test - WebKitGTK (Linux Tauri) and older macOS have it, without the API.
- **An engine without the API** (an iPhone before 16.4) keeps WebKit's own choice; the page says so
  ONCE, `[AUDIO] navigator.audioSession is absent`, at warn. A `type` the engine refuses
  (`InvalidStateError`) is said at error level and retried on the next change.

**Android: the ringer mode.** The WebView plays Web Audio on the MEDIA stream (`usage MEDIA`, the
2026-10-09 reading above), which ignores the ringer, and no web API reads it. So `MainActivity`
registers `window.canariAudio.ringerMode()` (`AudioManager.getRingerMode()`), and `playTone`
refuses an APP tone unless the mode is `RINGER_MODE_NORMAL`
([`androidRinger.ts`](../../../frontend/src/lib/mobile/androidRinger.ts)) - read at each tone,
never cached; an unknown mode plays, as `IncomingRing.plan` reads it; a missing bridge is said once
at error level. The call's own ring (`purpose: 'call'`) is not an app tone. Media the reader starts
(a voice note, an unmuted reel) is untouched on both platforms: the reader asked for it.

Pinned by `audioSession.test.ts` (the table and every transition: a microphone held before the ask and released at the stop of its last audio track, an unmuted media during a recording leaves the type alone, the camera path, a refused capture; arm -> ambient, media -> playback
-> ambient, call placed -> play-and-record -> ambient, ring in stays ambient, a call over a playing
media hands playback back, a refusal, the absent API), `audioSession.captureSites.test.ts`, `callSoundGate.test.ts` (the strongest
phase), `playbackArbiter.test.ts` (what is reported), `androidRinger.test.ts` and
`toneOutput.test.ts` (a silenced ringer opens no output).

**Owed on the phones** (nothing above was read on a device): iPhone 12, switch on SILENT - send a
message (no trill), play a voice note (heard), open a reel (muted; tap the speaker: heard), send
again while the reel plays and after it (no trill once it stopped), then a call placed and ended
(the call is heard; the next send is silent); record a voice note while a reel plays unmuted, film a reel with sound, ANSWER a call that rang in - each capture opens (no `InvalidStateError`), and the log shows `microphone held by ...` / `released` around it - and the in-app log's `audio session` lines for each.
Mi 9T: ringer on vibrate, then silent - a send makes no trill and the log says `the phone's ringer
is silent or vibrate`; normal - the trill is back.

## A voice note is a recording, not a call (owner, 2026-11-20)

**Reported:** voice messages often sound very bad. The capture line shipped with #3910 read on the
Mi 9T `capture: echo=true noise=true agc=true rate=48000Hz ch=1 mime=audio/mp4 bps=128000`: the
note was captured under a phone call's configuration.

**Who set it - no Canari code.** Native code sets `MODE_IN_COMMUNICATION` only in
`CallForegroundService.kt` (the ongoing call), and no Objective-C sets an `AVAudioSession` category
or mode. The ENGINE derived the call configuration from the capture's constraints:
`VoiceRecorder.svelte` asked `{ audio: true }`, which leaves echo cancellation, noise suppression
and auto gain ON. Read in the engines' sources on 2026-11-21:

- **Android (Chromium WebView).** Echo cancellation ON asks the platform canceller
  (`AudioParameters::ECHO_CANCELLER`, `audio_manager_android.cc`). The input stream is then opened
  with the `VOICE_COMMUNICATION` preset (`aaudio_stream_wrapper.cc`; `opensles_input.cc` the same),
  and `AudioManagerAndroid::MakeAudioInputStream` sets `MODE_IN_COMMUNICATION` on the FIRST input
  stream that carries an effect, restored by `ReleaseInputStream` once the LAST input stream closes.
  Output streams opened meanwhile take usage `VOICE_COMMUNICATION` (routed as a call's audio, the
  call volume). With every effect off the preset is `GENERIC` (`CAMCORDER` on OpenSL) and the mode is left alone.
- **iOS (WebKit).** Echo cancellation ON selects the Voice-Processing I/O unit (`CoreAudioCaptureUnit`,
  a telephone's chain that also ducks other audio); OFF selects `RemoteIO`. The CATEGORY is
  `play-and-record` (the page states it, [above](#the-silent-switch-and-the-ringer-who-owns-the-category-owner-2026-11-04)),
  and for that category WebKit forces the MODE to VideoChat (`MediaSessionManagerCocoa::updateSessionState`;
  VoiceChat when a call chose the receiver). **That mode is WebKit's and stays**: setting it
  natively would race WebKit's own `setCategory`, which runs on every session change.

**The fix** ([`recordingConstraints.ts`](../../../frontend/src/lib/utils/audio/recordingConstraints.ts)):
ONE constant, `RECORDING_AUDIO_CONSTRAINTS` (the three processings off, `channelCount: { ideal: 1 }`),
asked by the voice note, the reel camera and the live - the reel's measured constants
([reels](modules/reels.md)) moved there unchanged. `VoiceRecorder` logs its choice once per note,
`[VoiceRecorder] capture as recording (call phase none)`, before the existing `capture:` line
(`voiceNoteCaptureReport.ts`) reports what the engine granted.

**A live call keeps its configuration.** On iOS every capture of the page feeds from ONE shared
capture unit, and a source asking another echo setting RECONFIGURES it
(`CoreAudioCaptureSource::initializeToStartProducingData`): a note with processing off, recorded
during a call, would switch the CALL's echo canceller off. On Android a second input stream
reselects the communication device. So `voiceNoteCapture(callPhase)` returns EXACTLY the call's
constraints (`buildCallAudioConstraints`) while the call gate reads `calling` or `incall`, and the note
is logged `capture as call`. When the note ends during the call, nothing has to be restored: the
call's capture is still open, so Chromium keeps the mode (it restores after the LAST input stream),
the ongoing-call service's `MODE_IN_COMMUNICATION` and output are untouched, and the audio session
stays `play-and-record` because the call phase is a fact of its own (`audioSession.test.ts`, "a voice
note ending during a call"). A ring coming in (`incoming`) holds no microphone, so a note recorded
while it rings is a recording; answering then opens the call's capture with echo ON, which on iOS
moves the shared unit to voice processing for the rest of that note - the call is never the one
that loses.

**Pinned by** `recordingConstraints.test.ts` (the constant, the choice per phase, and two source
pins: only `CallForegroundService.kt` sets `MODE_IN_COMMUNICATION`, no native code sets an
`AVAudioSession` category or mode), `VoiceRecorder.gesture.svelte.test.ts` (what is asked, idle, in a
call, during a ring) and `audioSession.test.ts`. **Verified by compiling only**: the readings on
both phones are [owed](../backlog.d/reading-owed-voice-notes-are-recorded-not-called.md).

**One channel, whatever the engine granted (iPhone 12, `1.7.3-alpha.4`).** The note recorded on the
iPhone was AAC in TWO channels: WebKit implements no `channelCount` (absent from
`getSupportedConstraints()` and from `getSettings()`), so `{ ideal: 1 }` is ignored there, and with
echo cancellation off WebKit captures through `RemoteIO`, which hands the built-in microphones over in
two channels; its recorder writes the AAC file with the channel count it receives.
[`monoRecording.ts`](../../../frontend/src/lib/utils/audio/monoRecording.ts) decides ONCE per note, from
the track's REPORTED channel count: `1` is recorded as granted (Android, desktop Chromium - no graph);
anything else, two or nothing reported, is recorded through the engine's own downmix,
`MediaStreamSource -> MediaStreamAudioDestinationNode` pinned to one channel (`explicit`, `speakers`:
the spec's L/R average). The recorder AND the loudness tap read that stream, so the playback
normalisation measures the file that is sent. Its `AudioContext` lives exactly as long as the note, in
the foreground, and is closed with the device (the rule at the top of this page); its state is logged
when made and on every `statechange`. **The recorder starts only once the context RUNS**: the step
awaits `resume()`, and a context still not `running` after it rejects with `DownmixNotRunningError`
(an `error` line) - that graph would record silence. The rejection, like a graph the engine refuses,
fails the start through the recorder's refusal branch (everything released, the microphone toast):
neither a silent note nor a stereo one is sent instead.

**The capture line says what the engine does not implement** (`voiceNoteCaptureReport.ts`): each
setting prints its value, `unsupported` when the engine lists no such constraint
(`getSupportedConstraints()`), `unreported` when it lists it and reported nothing - never a bare
`undefined`, which on the iPhone proved nothing. It also prints `size=` (`sampleSize`, which WebKit
exposes), `rec=mono-downmix|as-granted` and `exposed=[...]`, every setting the engine did report
(the device and group ids left out). Expected on the iPhone: `echo=false noise=unsupported
agc=unsupported rate=48000 size=16 ch=unsupported rec=mono-downmix`.

**Other apps' audio is INTERRUPTED by a voice note on iOS, on purpose (owner, 2026-11-22).** Recording
a note stops the music another app plays, as WhatsApp does, and the owner wants that behaviour: no
code tries to mix with or duck other audio during a note. A reading that hears the music stop while
recording is a PASS, not a defect. ([decision](../backlog.d/owner-decisions-of-2026-11-22.md))

**The hold ends when a prompt takes the finger (iPhone 12, `1.7.3-alpha.4`).** On the FIRST note the
microphone permission prompt took the touch: no `pointerup` nor `pointercancel` reached the page, the
recorder went from `arming` to `holding` once the prompt was answered and stayed there - its clock
running, no slide, no bin - until the app was killed. `VoiceRecorder` now ends a POINTER hold on any
proof that the finger's gesture is over: `lostpointercapture` on the microphone, `blur` on the window
(an alert over the app), the page hidden. While arming that is a release before the microphone
opened (the device is handed back when `getUserMedia` resolves, nothing recorded); while holding, a
discard. A second finger or a palm (a non-primary pointer) is ignored and never ends a hold. Each
start carries its own attempt token, checked after every await, so a release then a new press while
the first microphone is still opening never runs two recorders. A keyboard start (no finger) and a
locked recording are not touched. Pinned by
`VoiceRecorder.gesture.svelte.test.ts` ("a permission prompt takes the finger").

**Not changed, and why.** No bitrate is asked (the Mi 9T's AAC already reads 128 kb/s), no new
loudness target and no high-pass: the research of 2026-11-20 ranked them after the processing, and
they are taken only if the readings below fail their acceptance. A Bluetooth headset in HFP stays
narrowband whatever the note asks (cause 2 of the research), which the `device=bluetooth` class of
the capture line names.

**What a bench could not read, pinned by tests (2026-11-22, `1.7.3-alpha.6`).** The decrypted file of a real note is
Opus, 48 kHz, ONE channel (read). The numbers: `recordingLoudness.test.ts` runs a synthetic 48 kHz buffer (1 kHz and
14 kHz tones) through the recording tap and the one playback law, and **the law lands a note at -14 LUFS, raised by
at most +6 dB, peak under -1 dBFS - so a note measured near -24 LUFS plays at -18, and a quiet one (tones at -30 dBFS,
-34 LUFS) plays at -28**: the "-18 +/- 2" acceptance is not a property of the law. `monoRecording.test.ts` pins the
destination's configuration (one explicit channel, `speakers` interpretation); the averaging and the 12 kHz cutoff are the
engine's and the encoder's, read on a phone for the channel count only. `recordingConstraints.test.ts` pins the
pair: `incall` asks the call's own constraints, `none` asks `RECORDING_AUDIO_CONSTRAINTS`; the page never sets an OS
audio mode (`CallSoundHoldTest.kt` holds the call's).
