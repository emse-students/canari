## Reading owed - a media message is worded the same in the list, the quotes and the banners (owner, 2026-11-20)

target: 1.7.2

Built: a photo, GIF, video, voice note, audio file, file or CanaReel reads `📷 Photo`, `🌀 GIF`,
`🎥 Vidéo`... (caption after it, a file named) in the conversation list, the reply quotes, the in-app
notification AND the native push banner, one table guarded by a test
([chat](../frontend/modules/chat.md#a-media-message-is-previewed-by-what-it-is-2026-11-20)).

The reading that closes it, on a phone: send each kind, with and without a caption, to a bench account in
French and in English; read the list row, the banner while the app is closed (Android FCM and the iOS
extension: the native change is in `push_text.rs`), a reply quote above a reply to a photo, and a named file.
The two wordings must be identical. No phone reading has been taken.
