## Reading owed - the push sentences are worded in Rust from the app language and a voice note is announced as one

target: 1.7.0

**What is built:** the push sentences are worded in Rust from the app language and a voice note is announced as one (#2037, `mobile/push_text.rs`, [chat](../frontend/modules/chat.md#a-voice-note-declares-itself-because-nothing-downstream-can-tell)); the iOS FFI and the Kotlin/Swift callers verified by compiling only

**The reading that closes it:** the app set to English on the Mi 9T and the iPhone 12, app killed: a reaction, a photo and a voice note from another account - each banner in English, the voice note named as one

**Triage 2026-11-14: Mi 9T about 10 min, iPhone about 10 min** (app in English, killed; a reaction, a photo and a voice note from a web seat).

**iPhone 12 half, READ 2026-11-15 on dev (TestFlight `1.6.12-alpha.2`, build `100601202`, app language English, app killed):** from the delta web seat, a voice note (recorded on a fake microphone in a mobile viewport) drew "🎤 Voice message", a photo "📷 Photo" with its thumbnail (`fetchAndDecryptMedia: thumbnail ready`), and a reaction "reacted 👍 to your message" (a `social` push, `outcome=server-content`); each NSE run ended `decrypted` or `server-content`. The app was set back to French afterwards. **Left: the Mi 9T half.**
