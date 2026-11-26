## Reading owed - the voice-note loudness law (-16 LUFS, +12 dB) heard on a phone

target: 1.8.2

Built in 1.8.2 ([sounds](../frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20)): a voice note plays under its own law, -16 LUFS and a raise of at most +12 dB. The numbers are pinned by tests on synthetic buffers; what no test hears is the result. On a phone, record a quiet note and a normal one, play them beside a reel and a video, and read the in-app log's `[LOUDNESS]` lines for the gain applied (a whisper at +12 dB, never above). Closes when both notes are audible without a hand on the volume and the whisper is not noise.
