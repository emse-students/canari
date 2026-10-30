### Fixed - on Android, a conversation with a photo no longer drops away from its last message when the keyboard opens

The keyboard shrinks every photo capped at the screen's height, and the thread used to keep the row
at its top in place rather than its bottom: a reader at the bottom now stays there whichever way the
thread's height moves ([chat](docs/wiki/frontend/modules/chat.md#a-reader-at-the-bottom-is-anchored-to-the-bottom-in-both-directions-2026-10-30)).
