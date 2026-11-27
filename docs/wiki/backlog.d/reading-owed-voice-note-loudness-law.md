## Reading owed - the voice-note loudness law (-16 LUFS, +12 dB) heard on a phone

target: 1.8.3

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

Built in 1.8.2 ([sounds](../frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20)): a voice note plays under its own law, -16 LUFS and a raise of at most +12 dB. The numbers are pinned by tests on synthetic buffers; what no test hears is the result. On a phone, record a quiet note and a normal one, play them beside a reel and a video, and read the in-app log's `[LOUDNESS]` lines for the gain applied (a whisper at +12 dB, never above). Closes when both notes are audible without a hand on the volume and the whisper is not noise.

**Read on the Mi 9T, 1.8.2-alpha.7 (2026-11-26):** the `[LOUDNESS]` lines show the gain applied, the whisper never above +12 dB. Still owed: the ear's verdict (both notes audible beside a reel, the whisper not noise).

**iPhone 12, `1.8.2-alpha.7` (2026-11-26): BLOCKED on the hearing.** Two notes (a silent room, a played file) recorded and played back: the audio session went `ambient -> playback` and back, and no `[LOUDNESS]` warning or fallback appeared for a voice note. The gain lines are debug level and absent from the in-app log, and no instrument here hears the loudspeaker; the reading that closes the entry is a person's ear, or a debug-level line for the gain applied.
