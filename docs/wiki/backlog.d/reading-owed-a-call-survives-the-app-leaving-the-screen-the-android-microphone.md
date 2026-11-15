## Reading owed - a call survives the app leaving the screen: the Android microphone foreground service

target: 1.7.0

**What is built:** a call survives the app leaving the screen: the Android microphone foreground service (WP-C-BG-A, #2162) and the iPhone's `audio` background mode (WP-C-BG-I, #2164), both in `v1.3.1` ([calls](../frontend/modules/calls.md#the-blockers-each-with-its-evidence), rows B8 and B9)

**The reading that closes it:** the twelve Mi 9T readings of [WP-C-BG-A](../frontend/modules/calls.md#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20) and CALL-L1 row 12 on the iPhone 12

**Triage 2026-11-14 - MERGED with "a call that loses the audio focus holds its microphone and never hangs up"** (D056, decided 2026-11-12, `CallFocusHold.kt`, `CallService.onAudioFocus`, in `v1.6.12`; [calls](../frontend/modules/calls.md#a-call-behaves-like-a-phone-call-2026-10-30-after-the-owners-first-production-call)): during a Canari call with the iPhone, the Mi 9T loses the audio focus - the iPhone shows the microphone cut, the Mi 9T its banner, `focus`/`lost` then `gained` in the app log; once unmuted and once muted before the loss, the second comes back muted; the call is never ended. **Staging: the loss is made by another app taking the focus (a video started with `adb shell am start`), the same `onAudioFocus` path as a SIM ring; the bench needs no SIM.** **Left, both phones together, about 40 min on the Mi 9T side and 10 min on the iPhone side: the twelve WP-C-BG-A readings, the focus loss, and CALL-L1 row 12.**
