### Changed - a conversation keeps its place when you come back from a profile

Opening a profile from a sender, the members list or a direct header and coming back now lands on the
message you were reading, not the bottom ([chat](docs/wiki/frontend/modules/chat.md#the-position-of-a-reader-across-a-profile-2026-11-13)).
The position lives in memory for the session only and is dropped at sign-out.
