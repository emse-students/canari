## P2 - Reading owed - a Gboard GIF committed in an Android chat arrives as an encrypted media

target: 1.7.3

Built: the `onCreateInputConnection` hook that hands the WebView's input connection to
`KeyboardMediaBridge` now lives in the vendored wry template, restored after four months of absence
([chat](../frontend/modules/chat.md#android-keyboard-media-commitcontent)). Compiled, and guarded by
`android-keyboard-media-hook.test.mjs`; not run on a phone (the bench Mi 9T was carrying another
session's alpha readings, and a debug build would have cost it an uninstall).

The reading that closes it, on the first pre-release carrying the fix, on the Mi 9T with Gboard: in
a DM between two test accounts, open Gboard's GIF tab and commit one. Gboard must NOT say "GIF non
disponibles ici", logcat must show `KeyboardMedia: input connection wrapped` then
`keyboard committed 1 item(s)` and `dispatching keyboard media`, and the GIF must arrive on the
other account as an animated media message. Then the same in a post's comment box.
