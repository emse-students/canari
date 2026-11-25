## Voice notes get their own playback loudness law: -16 LUFS, gain capped at +12 dB (owner, 2026-11-22)

target: 1.8.1

A voice note is a recording of one voice, often quiet, and is played beside music and video that carry a different level. Owner decision of 2026-11-22 ([decisions](../decisions/owner-decisions-of-2026-11-22.md), item 6): the playback of a voice note aims at **-16 LUFS** and never applies more than **+12 dB** of gain, so that a whisper is lifted but not turned into noise. Charter principle 2 ([principes](../../principes.md)): the essential, a heard message, is never lost.

What is known: voice notes are recorded as a recording and not a call since 1.7.2 ([sounds](../frontend/sounds.md#a-voice-note-is-a-recording-not-a-call-owner-2026-11-20)). Not built. To settle when it is picked up: where the loudness is measured (at send, stored with the note, or at play) and a test that pins the cap on a quiet and a loud sample.
