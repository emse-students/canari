## P3 - the iOS share suggestions carry no photo (2026-11-20)

target: 1.8.0

The Android shortcuts now carry each conversation's picture ([sharing](../frontend/sharing.md)). The
iOS donation (`ShareSuggestions.swift`, one `INSendMessageIntent` per conversation with a
`speakableGroupName`) carries no `INImage`, so Siri's and the share sheet's suggestions show a
generic glyph where Messenger shows a face. Not trivial: an image per donation
(`INInteraction` / `setImage(_:forParameterNamed:)`) from a cached file the plugin can read, the
same two sources (peer photo, group or community media) and the same initials disc as
`canari_push.mm`'s `CanariInitialsImagePath`. Measure on the iPhone 12 first that the sheet shows
the image for a group-name intent at all.
