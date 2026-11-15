## Reading owed - the push sentences are worded in Rust from the app language and a voice note is announced as one

target: 1.7.0

**What is built:** the push sentences are worded in Rust from the app language and a voice note is announced as one (#2037, `mobile/push_text.rs`, [chat](../frontend/modules/chat.md#a-voice-note-declares-itself-because-nothing-downstream-can-tell)); the iOS FFI and the Kotlin/Swift callers verified by compiling only

**The reading that closes it:** the app set to English on the Mi 9T and the iPhone 12, app killed: a reaction, a photo and a voice note from another account - each banner in English, the voice note named as one

**Triage 2026-11-14: Mi 9T about 10 min, iPhone about 10 min** (app in English, killed; a reaction, a photo and a voice note from a web seat).

**Mi 9T, READ in part on 2026-11-15 on dev (`1.6.12-alpha.2`, build 100601202, the alpha account; the app switched to English in Settings > Preferences; app killed; beta's web seat as the sender):**
- **The reaction:** the banner read "Canari Test Beta / reacted 👍 to your message", in English (`reaction: group=eb14b4a4 actor=c71e1a5b`).
- **The photo:** the banner read "📷 Photo", with the thumbnail (`thumbnail ready`, `hasMedia=true`). That word is the same in both languages in `push_text.rs`, so it shows only that the Rust path ran.

**Left on the Mi 9T: the voice note ("🎤 Voice message").** The web composer has no voice-note control, so it needs a sender on a phone.
