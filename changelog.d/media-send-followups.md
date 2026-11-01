### Fixed - a file sent while its DM was merged follows it, and one whose conversation is gone says so

A file sent while a duplicate DM group was merged now follows the conversation to its new key; one
whose conversation was deleted or left is no longer dropped with only a log line - the member is
told, and the caption goes back to the draft ([chat](docs/wiki/frontend/modules/chat.md#a-file-is-queued-at-the-tap-like-a-text-2026-11-01)).
