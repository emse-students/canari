## Reading owed - voice notes are recorded, not captured as a phone call (both phones)

target: 1.7.3

**What is built** ([sounds](../frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20)):
a voice note asks `RECORDING_AUDIO_CONSTRAINTS` (echo cancellation, noise suppression and auto gain
off, mono) instead of `{ audio: true }`, unless a call holds the microphone, in which case it asks the
call's own constraints. It replaces the P2 "voice notes are captured as a phone call" (owner,
2026-11-20, decisions 16 and 21 of [the day](owner-decisions-of-2026-11-20.md)). Decision 21 lets the
lead ship it without a further question **if the measurements are better**: the rows below are that
measurement. Nothing native changed; the engines read the constraints, so a phone is the only proof.

**The rows, on the Mi 9T AND the iPhone 12, on the pre-release:**

1. **Capture line.** Record a voice note: the in-app log reads `capture as recording (call phase none)`
   then `capture: echo=false noise=false agc=false ... ch=1`. Before the fix the Mi read
   `echo=true noise=true agc=true`; the iPhone's line was never read.
2. **No call configuration.** Mi 9T: `adb shell dumpsys audio` WHILE recording shows mode `NORMAL`
   (not `IN_COMMUNICATION`) and the record client with source `CAMCORDER` or `MIC`/generic, not
   `VOICE_COMMUNICATION`. iPhone: music from another app playing while recording is NOT ducked, and a
   voice note played right after recording comes out of the loudspeaker.
3. **The sound.** The same phrase, before (`1.7.2`) and after, built-in microphone, then a Bluetooth
   headset. Per file: `ffprobe` (codec, rate, channels, bitrate), `ffmpeg -af ebur128` (integrated
   loudness, true peak), `astats` (peak, clipped samples) and a spectrogram. **Acceptance:** spectral
   cutoff at or above 12 kHz on the built-in microphone, no clipped sample, mono, and loudness within
   -18 +/- 2 LUFS after the playback normalisation. A Bluetooth headset in HFP is narrowband whatever
   is asked; its line reads `device=bluetooth`. If a noisy room sounds worse, the A/B is a variant with
   noise suppression ON. If acceptance fails, the remaining levers of the research are, in order: an
   explicit bitrate (Opus 32 kb/s, AAC 48-64 kb/s), a speech loudness target of -16 to -18 LUFS (the
   -1 dBFS clamp kept), an 80 Hz high-pass in the playback route.
4. **A call is not broken.** In a call (Mi 9T and iPhone, each side once), record a voice note from the
   minimised call: the log reads `capture as call (call phase incall)`; the other side hears no echo
   while and after the note is recorded; on the Mi `dumpsys audio` still shows `IN_COMMUNICATION`
   after the note is sent and the call's output (speaker or earpiece) is unchanged; on the iPhone the
   `audio session` log stays `play-and-record` until the call ends, then goes back to `ambient`.
5. **A ring during a note.** Record a locked note, have the other phone call, answer: the call is heard
   both ways without echo; the note sends.

**Sources** (the research of 2026-11-20): Telegram `audio.c` (30 kb/s Opus, 48 kHz, mono, no
effects); Signal `AudioCodec.java` (AAC 32 kb/s, 44.1 kHz, mono, `MIC` source); RFC 7587 s3.1.1; EBU
R128 s2 and AES TD1008 for speech loudness; WebKit bugs 192932, 257495, 234784, 274222.

Charter: principle 2 (the essential is never lost - a voice note that cannot be understood is lost).
