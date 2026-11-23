### Fixed - a DM thread keeps its end when the app returns with the keyboard up (iPhone)

Leaving the app with the keyboard open now starts a keyboard transition, so WebKit's reveal at the
return is put back like a rise's instead of read as the reader leaving; the pane logs its geometry at
every foreground and keyboard edge ([chat](docs/wiki/frontend/modules/chat.md#the-keyboard-comes-back-with-the-app-2026-11-23)).
