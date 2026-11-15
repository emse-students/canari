## Reading owed - a live or a reel asks the microphone for one channel

target: 1.7.0

**What is built:** a live or a reel asks the microphone for one channel (#3226, first stable `v1.6.9`; [live](../frontend/modules/live.md#audio-channels-the-sound-that-plays-out-of-one-side))

**The reading that closes it:** on the Mi 9T and the iPhone 12, a live and a reel each: the `audio layout:` line reads `mono`, which closes it; `stereo` after the mono request means the engine ignored the ideal - then decode a recorded file and compare the two channels' energy, and only then down-mix at the source through an `AudioContext`

**Triage 2026-11-14: Mi 9T about 10 min, iPhone about 10 min** (the `audio layout:` line from logcat and from the syslog; a live and a reel each).

**Mi 9T half, READ 2026-11-15 on dev (`1.6.12-alpha.2`, read from the page console over CDP, since the release-style bench build prints nothing to logcat):** a live preview logged `[LIVE-CAM] audio layout: mono (ch=1, rate=48000Hz)`, and the in-app post camera, which is the reels' capture path (`cameraAccess.ts`), logged `[camera] audio layout: mono (ch=1, rate=48000Hz)`. No `stereo`, so no decode is owed. **Left: the iPhone 12 half (a live and a reel, from the syslog).**
