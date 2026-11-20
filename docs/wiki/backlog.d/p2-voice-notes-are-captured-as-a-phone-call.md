## P2 - Voice notes are captured as a phone call (asked by the owner, 2026-11-20)

target: 1.7.3

The owner reports that voice messages often sound very bad. The recorder
(`VoiceRecorder.svelte`, `beginRecording`) calls `captureUserMedia(..., { audio: true }, 'voice-note')`
with no constraint, so echo cancellation, noise suppression and auto gain are all ON: the engine
captures like a call (Android picks the `VOICE_COMMUNICATION` preset, iOS the voice-processing
unit). No `audioBitsPerSecond` is set either, and until the reporting line shipped with this entry
nothing logged what the engine granted. The reel recorder already turns all three off and asks for
mono (`reels/framedCapture.ts`), with a Mi 9T measurement that AGC pumps.

**What shipped with this entry:** one info line per recording, `[VoiceRecorder] capture: echo=..
noise=.. agc=.. rate=..Hz ch=.. device=<class> mime=.. bps=..` (`utils/audio/voiceNoteCaptureReport.ts`).
`bps` is the engine's default or estimate, not a measurement, and 0 is shown as `?`. The device is a CLASS (bluetooth, headset, builtin-or-other, unlabelled), never the label. Nothing
about the capture itself changes yet: the causes below are ranked, not proven.

### Causes, most likely first

1. **Call-style processing.** The three flags on, plus the communication audio preset.
2. **Bluetooth HFP narrowband.** A headset in call profile delivers 8-16 kHz audio whatever the note asks.
3. **AGC clipping and pumping.** Measured on the Mi 9T in the reel recorder.
4. **Unknown Android encoder.** No bitrate asked, so the engine picks its own.
5. **WebKit Web Audio tap or playback route since #3394** (the loudness tap, the audio session type).
6. **One-sided stereo** if processing goes off without `channelCount: 1`.

### Proposed changes

- **A. Constraints off plus mono, as ONE exported constant** (`echoCancellation`, `noiseSuppression`,
  `autoGainControl` false, `channelCount: 1`), shared with the reel recorder. A/B against a variant
  with noise suppression ON, since a noisy room may prefer it.
- **B. An explicit bitrate:** Opus 32 kbps, AAC 48-64 kbps. Size: about 240 KB/min at 32 kbps Opus
  against 0.4-0.5 MB/min at AAC 48-64 kbps.
- **C. A speech loudness target of -16 to -18 LUFS for voice notes**, allowing more boost than now, the
  -1 dBFS clamp kept.
- **D. An 80 Hz high-pass in the playback route.**
- **E. Do NOT reorder the container list yet** (`audio/mp4` first stays): the cause is not shown to be there.

### Measurement protocol

The same phrase, recorded on the Mi 9T and the iPhone 12, before and after each change, on the
built-in microphone and on a Bluetooth headset. Per file: `ffprobe` (codec, rate, channels,
bitrate), `ffmpeg ebur128` (integrated loudness, true peak), `astats` (peak, clipping count),
and a spectrogram. A reference-based score with ViSQOL or PESQ against the studio take.
**Acceptance:** spectral cutoff at or above 12 kHz, no clipped sample, -18 +/- 2 LUFS, mono.

### Sources

- RFC 7587 s3.1.1: Opus RTP payload, the bitrate range per bandwidth.
- Telegram, `audio.c`: 30 kbps Opus, 48 kHz, mono, no effects.
- Signal, `AudioCodec.java`: AAC 32 kbps, 44.1 kHz, mono, `MIC` source.
- Chromium, the aaudio input preset code (https://source.chromium.org/chromium/chromium/src/+/main:media/audio/android/): the communication preset chosen when processing is on.
- WebKit bugs 192932, 257495, 234784, 274222 (capture and audio session behaviour).
- EBU R128 s2 and AES TD1008: loudness targets for speech.
