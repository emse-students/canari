## Reading owed - a live or a reel asks the microphone for one channel

target: 1.7.0

**What is built:** a live or a reel asks the microphone for one channel (#3226, first stable `v1.6.9`; [live](../frontend/modules/live.md#audio-channels-the-sound-that-plays-out-of-one-side))

**The reading that closes it:** on the Mi 9T and the iPhone 12, a live and a reel each: the `audio layout:` line reads `mono`, which closes it; `stereo` after the mono request means the engine ignored the ideal - then decode a recorded file and compare the two channels' energy, and only then down-mix at the source through an `AudioContext`
