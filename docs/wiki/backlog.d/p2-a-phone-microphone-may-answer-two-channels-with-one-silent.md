## P2 - a phone microphone may answer two channels with one silent (reported 2026-11-09)

Owner: the live's sound is "mono", maybe some videos too. Read as: the sound plays out of ONE side.

**What the code shows.** The live and the reel recorders take the microphone with `REEL_AUDIO_CONSTRAINTS`
(no echo cancellation, noise suppression or gain) and, until this change, NO channel constraint. `MediaRecorder` writes as many
AAC/Opus channels as the track has; a phone mic captured raw can be a 2-channel track with an empty second
channel, which a player renders on one side. The transcode (`prepareVideoForUpload.ts`) keeps the source's
channel count, the live packager and the server do not touch audio, the player routes nothing through Web Audio
(no splitter or panner anywhere): the capture is the only place the layout is decided.
Calls already ask `channelCount: { ideal: 1 }`.

**Built.** `channelCount: { ideal: 1 }` in `REEL_AUDIO_CONSTRAINTS`; one info line per capture
(`[LIVE-CAM] audio layout: mono (ch=1, ...)`, `utils/audioLayout.ts`) saying what was granted.

**Not confirmed, reading owed on the Mi 9T and the iPhone 12.** Start a live and record a reel on each, read the
`audio layout:` line. `mono` closes it. `stereo` after a mono request means the engine ignored the ideal: then
decode a recorded file and compare the two channels' energy to prove the silent side, and, only then, down-mix
at the source through an `AudioContext` (mono destination) rather than guess.

**Already published media with a silent side.** A playback-side fix (Web Audio upmix of the live channel) is
possible but needs per-file detection (decode, measure each channel) on every play; not worth it - the files are
few and live replays are not kept. Not built.
