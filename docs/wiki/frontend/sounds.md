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
| Incoming-call ring (440 + 480 Hz bursts, every 2.4 s) | An incoming call, while calls are enabled ([calls](modules/calls.md); `CALLS_ENABLED = false`)                                | same                                                                                                | suspended after each burst                                                                 |
| Voice notes, audio attachments                        | The reader presses play                                                                                                       | an `<audio>` element, under [playbackArbiter](../../../frontend/src/lib/actions/playbackArbiter.ts) | paused by another media starting, and on leaving the screen on a native phone              |
| Post, reel and conversation videos                    | Scrolled into view (muted, ambient) or opened (audible)                                                                       | `<video>` elements, same arbiter                                                                    | ambient ones paused on leaving the screen everywhere                                       |
| A call's remote audio                                 | A call in progress                                                                                                            | the hidden sink in `CallOverlay`                                                                    | unbound (`srcObject = null`) when it stops carrying the stream                             |
| None: the voice-note waveform decode                  | A voice note is drawn                                                                                                         | an `OfflineAudioContext` - renders to memory, opens no device                                       | -                                                                                          |
| None: the reel editor's render                        | Publishing an edited video reel                                                                                               | a muted `<video>` captured into a recorder                                                          | element unloaded and both capture streams stopped when the render ends, success or failure |

The OS notification sounds (channels `canari_messages_v2`, `canari_mentions_v2`,
`canari_reactions_v2`, `canari_calls`) are posted by the platform and are not the app's output.

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
- **iOS: not done.** A banner's sound is chosen by the APNs payload's `sound` field (set by the push
  server) and the file must be bundled in BOTH the app and the NSE targets, which means editing the
  Xcode project and the delivery service together. The Xcode project is the hand-maintained
  `project.pbxproj` (not `project.yml`), which is why it is not built from a workstation.
  Recorded in [backlog](../backlog.md).

**Owed:** a listen on the Mi 9T and the Pixel (channels, after upgrade: the old entries gone, the new
ones sounding) and on a browser (the in-app trills against the prototype).

## The tone output, in detail

`playTone(name, score)` is the only way a tone is played. `score` schedules oscillators and returns
them; each one is counted in flight, and the `ended` of the LAST one calls `suspend()` - the Web
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
