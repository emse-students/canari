## P3 - the iOS share suggestions carry no photo (2026-11-20)

target: 1.9.0

The Android shortcuts now carry each conversation's picture ([sharing](../frontend/sharing.md)). The
iOS donation (`ShareSuggestions.swift`, one `INSendMessageIntent` per conversation with a
`speakableGroupName`) carries no `INImage`, so Siri's and the share sheet's suggestions show a
generic glyph where Messenger shows a face. Not trivial: an image per donation
(`INInteraction` / `setImage(_:forParameterNamed:)`) from a cached file the plugin can read, the
same two sources (peer photo, group or community media) and the same initials disc as
`canari_push.mm`'s `CanariInitialsImagePath`. Measure on the iPhone 12 first that the sheet shows
the image for a group-name intent at all.

**2026-11-23, `1.8.0-alpha.3` ([iPhone 12 sitting](../device-verification.md#the-readings-of-2026-11-23-180-alpha3-iphone-12-the-resume-from-settings-the-pushes-name-and-logo-the-banners-the-share-logos-the-ios-27-launch)): the measure is taken.** In the share sheet of Photos the Canari suggestions (a DM, a group, a salon channel, a community channel) are EMPTY grey circles with the Canari badge: no photo for the person who has one, no glyph, as the entry says. The donation is published at every launch (`[ShareSuggestions] publish: 5 of 5 donated`), so what is missing is the `INImage`, nothing else.
