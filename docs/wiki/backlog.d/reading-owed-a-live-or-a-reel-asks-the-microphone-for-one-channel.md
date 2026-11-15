## Reading owed - a live or a reel asks the microphone for one channel

target: 1.7.0

**What is built:** a live or a reel asks the microphone for one channel (#3226, first stable `v1.6.9`; [live](../frontend/modules/live.md#audio-channels-the-sound-that-plays-out-of-one-side))

**The reading that closes it:** on the Mi 9T and the iPhone 12, a live and a reel each: the `audio layout:` line reads `mono`, which closes it; `stereo` after the mono request means the engine ignored the ideal - then decode a recorded file and compare the two channels' energy, and only then down-mix at the source through an `AudioContext`

**Triage 2026-11-14: Mi 9T about 10 min, iPhone about 10 min** (the `audio layout:` line from logcat and from the syslog; a live and a reel each).

**Mi 9T half, READ 2026-11-15 on dev (`1.6.12-alpha.2`, read from the page console over CDP, since the release-style bench build prints nothing to logcat):** a live preview logged `[LIVE-CAM] audio layout: mono (ch=1, rate=48000Hz)`, and the in-app post camera, which is the reels' capture path (`cameraAccess.ts`), logged `[camera] audio layout: mono (ch=1, rate=48000Hz)`. No `stereo`, so no decode is owed. **Left: the iPhone 12 half (a live and a reel, from the syslog).**

**iPhone 12 half, READ 2026-11-15 by the audio server, not by the `audio layout:` line** (TestFlight `1.6.12-alpha.2`, dev, gamma): the line is a `console.info`, the syslog does not carry it, and a TestFlight build's WebView is not inspectable (`pymobiledevice3 webinspector opened-tabs` lists nothing), so it cannot be read here. The syslog (`pymobiledevice3 syslog live`) answers the same question one layer down. A reel recorded from the camera and then a live of about 20 s each opened ONE input on the microphone for the WebKit GPU process of the app, and `audiomxd` logged it as `Got input layout ... numberDescs=1, descs=[Mono]` (reel 10:49:06, live 10:50:45), while the hardware and the capture daemon beside it stayed `[L, R]`: the mono request was honoured on both captures. The bench reading is the OS-side one; the `audio layout:` line stays the Mi 9T's (logcat). Evidence in the private sitting folder.

**Mi 9T half, READ 2026-11-15, sitting 7: PASS** (`1.6.12`, dev, console read through CDP): opening the live camera logged `[LIVE-CAM] audio layout: mono (ch=1, rate=48000Hz)` and the live went on air; opening the reel camera logged `[camera] audio layout: mono (ch=1, rate=48000Hz)`. **Left: the iPhone 12 half** (the syslog; a TestFlight WebView is not inspectable, so the line is not readable there: decode a recorded live and compare the two channels' energy instead). The live the reading started was left on air when the app went to the background and ended on its own.
