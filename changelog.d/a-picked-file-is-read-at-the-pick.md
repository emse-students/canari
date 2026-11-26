### Fixed - a file picked in the Android app is no longer queued with zero bytes

The Android file chooser hands the page a copy read to its end, never trusting the size a provider states (a log export saved in Downloads was stated as 0 bytes); the log save checks the size it leaves recorded; the composer reads a picked file's bytes at the pick and refuses one it cannot read, said on the banner; an attachment queued with no bytes now fails at once with a line in the thread instead of retrying ([chat](docs/wiki/frontend/modules/chat.md#a-picked-file-is-read-at-the-pick-p1-of-181-2026-11-26)).
