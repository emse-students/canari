## P2 - an iOS salon banner names no speaker and draws the salon's letter as a face (found 2026-11-01)

The Android half shipped on 2026-11-01 ([mobile](../frontend/mobile.md#a-mention-names-its-author-from-the-phones-own-copy-wp-mention-name-2026-10-18)):
a salon banner that opened its message now names the proven author from `display_names.json`, draws
their initials, logs `[SALON_AUTHOR] proven author UNNAMED reason=...` at WARN when the phone cannot
name them, and keeps the salon only on a blind banner (`push/ChannelBannerAuthor`).

iOS still has the defect the owner read on Android (`v1.6.0`): the NSE's `handleChannelMessage` sets
`content.subtitle` only on a mention of the reader, and both it and `canari_push.mm` (the in-app
trunk, `shownMentionsMe, channelName, YES, NO`) draw `attachInitials(content:, name: channelName)`
whenever the face is missing. Owed: the same three answers on both Apple composers - the author's
name as the subtitle on an opened banner, their initials, the accusing line - reusing
`mentionNameBook`; then `initialsFallback.test.ts` moves its pinned iOS line, and one reading on the
iPhone 12.
