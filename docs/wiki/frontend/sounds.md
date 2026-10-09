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
| Receive chime (920 -> 680 Hz, sine)                   | A message from someone else lands where the reader can see it (`canSeeArrival`); otherwise the OS notification sounds instead | the shared tone context ([toneOutput.ts](../../../frontend/src/lib/utils/toneOutput.ts))            | suspended when its oscillator ends                                                         |
| Send chirp (740 -> 980 Hz, triangle)                  | The reader sends a message                                                                                                    | same                                                                                                | same                                                                                       |
| Read tick (1080 -> 820 Hz, sine)                      | Messages the reader wrote are marked read                                                                                     | same                                                                                                | same                                                                                       |
| Incoming-call ring (440 + 480 Hz bursts, every 2.4 s) | An incoming call, while calls are enabled ([calls](modules/calls.md); `CALLS_ENABLED = false`)                                | same                                                                                                | suspended after each burst                                                                 |
| Voice notes, audio attachments                        | The reader presses play                                                                                                       | an `<audio>` element, under [playbackArbiter](../../../frontend/src/lib/actions/playbackArbiter.ts) | paused by another media starting, and on leaving the screen on a native phone              |
| Post, reel and conversation videos                    | Scrolled into view (muted, ambient) or opened (audible)                                                                       | `<video>` elements, same arbiter                                                                    | ambient ones paused on leaving the screen everywhere                                       |
| A call's remote audio                                 | A call in progress                                                                                                            | the hidden sink in `CallOverlay`                                                                    | unbound (`srcObject = null`) when it stops carrying the stream                             |
| None: the voice-note waveform decode                  | A voice note is drawn                                                                                                         | an `OfflineAudioContext` - renders to memory, opens no device                                       | -                                                                                          |
| None: the reel editor's render                        | Publishing an edited video reel                                                                                               | a muted `<video>` captured into a recorder                                                          | element unloaded and both capture streams stopped when the render ends, success or failure |

The OS notification sounds (channels `canari_messages`, `canari_mentions`, `canari_calls`) are
posted by the platform and are not the app's output.

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
