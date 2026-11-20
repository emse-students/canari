## Reading owed - a media message is worded the same in the list, the quotes and the banners (owner, 2026-11-20)

target: 1.7.3

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Built: a photo, GIF, video, voice note, audio file, file or CanaReel reads `📷 Photo`, `🌀 GIF`,
`🎥 Vidéo`... (caption after it, a file named) in the conversation list, the reply quotes, the in-app
notification AND the native push banner, one table guarded by a test
([chat](../frontend/modules/chat.md#a-media-message-is-previewed-by-what-it-is-2026-11-20)).

The reading that closes it, on a phone: send each kind, with and without a caption, to a bench account in
French and in English; read the list row, the banner while the app is closed (Android FCM and the iOS
extension: the native change is in `push_text.rs`), a reply quote above a reply to a photo, and a named file.
The two wordings must be identical. No phone reading has been taken.

**2026-11-20, [S18](../device-verification.md#the-readings-of-2026-11-20-s18-172-alpha3-notice-previews-launcher-shortcuts-the-capture-line-live-screens-and-the-backup-domains) (`1.7.2-alpha.3`): READ on the Mi 9T, PASS; the iPhone half is partly read.** Android notifications: "📷 Photo", "🌀 GIF", "🎥 Vidéo", "📎 Fichier : rapport.pdf", "🎵 Fichier audio" and "📷 Photo : legende test"; the conversation list "📷 Photo"; the web list "🎤 Message vocal". iPhone, app killed: the banners "Photo", "Photo: caption" and "Audio file". **Left:** the iPhone's GIF, video and file banners, and a reply quote above a reply to a photo.
