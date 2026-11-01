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
