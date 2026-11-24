## P2 - Reading owed - a Gboard GIF committed in an Android chat arrives as an encrypted media

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Built: the `onCreateInputConnection` hook that hands the WebView's input connection to
`KeyboardMediaBridge` now lives in the vendored wry template, restored after four months of absence
([chat](../frontend/modules/chat.md#android-keyboard-media-commitcontent)). Compiled, and guarded by
`android-keyboard-media-hook.test.mjs`; not run on a phone (the bench Mi 9T was carrying another
session's alpha readings, and a debug build would have cost it an uninstall).

The reading that closes it, on the first pre-release carrying the fix, on the Mi 9T with Gboard: in
a DM between two test accounts, open Gboard's GIF tab and commit one. Gboard must NOT say "GIF non
disponibles ici", logcat must show `KeyboardMedia: input connection wrapped` then
`keyboard committed 1 item(s)` and `dispatching keyboard media`, and the GIF must arrive on the
other account as an animated media message. Then the same in a post's comment box and in the post
composer, and once in a field that refuses (a message being edited): the toast "Les GIF ne peuvent
pas etre ajoutes ici" and a `KeyboardMedia` line naming `chat-edit`.

**2026-11-24, [`1.8.0-alpha.5`](../device-verification.md#the-readings-of-2026-11-24-180-alpha5-mi-9t-sign-out-and-sign-in-the-comment-push-the-hidden-tab-the-notification-state-the-keyboard-gif-the-voice-note-under-a-banner) (Mi 9T, Gboard): the DM half PASS.** No "GIF non disponibles ici"; `KeyboardMedia: input connection wrapped`, `keyboard committed 1 item(s)`, `dispatching keyboard media: 102446 bytes`; the web peer received an animated `tenor_gif....gif`. **Left:** the post comment box, the post composer, and the refusing field (a message being edited: toast and the `chat-edit` line).
