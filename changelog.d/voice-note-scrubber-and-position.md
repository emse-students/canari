### Fixed - a reaction no longer restarts a voice note, and its waveform seeks

A reaction replaced the message object and re-ran the bubble's media download through a tracked `messageId` read, rebuilding the player; and a press on the waveform was read by the bubble as a long press or reply swipe, so it is now a real scrubber ([chat](docs/wiki/frontend/modules/chat.md#a-voice-notes-waveform-is-its-scrubber)).
