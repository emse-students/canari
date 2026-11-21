## P2 - iPhone message banners as communication notifications: the owner's portal step, then four iPhone readings (2026-11-21)

target: 1.8.0

Built (owner's decision of 2026-11-21): the notification extension donates an incoming
`INSendMessageIntent` and redraws each DM and group banner from it, the app carries
`com.apple.developer.usernotifications.communication`, and the sign-out erases the donations
([mobile](../frontend/mobile.md#communication-notifications-owner-2026-11-21)). Compiled by CI only.

**Owed by the owner first, once** (the pull request stays a draft until then, or every release fails
at codesign): in the Apple Developer portal, Identifiers > `fr.emse.canari` > tick "Communication
Notifications" > Save; then regenerate the "Canari" App Store distribution profile, replace the
`APPLE_PROVISIONING_PROFILE` secret with it, and regenerate the bench development profile
`app.mobileprovision`. The extension's and the share extension's profiles are untouched.

**Then the readings on the iPhone 12**, on the first pre-release carrying it (the extension's
`communication style applied` / `WARN communication style not applied` line in the syslog says which
path ran):

1. A Focus with Canari allowed (or the sender allowed as a person) lets a DM through.
2. A Focus without Canari holds the same DM back.
3. The banner's avatar is the sender's face (or their initials disc when they have no photo), on
   the left, with no second copy of it as an attachment; a photo message keeps its thumbnail.
4. A group banner shows the group's name (an unnamed group: "Conversation de groupe"), and the
   sender.

If a row fails while the app was alive rather than killed, check first which composer drew the
banner: the app's own (`canari_push.mm` `CanariShowMessageNotification`) is not converted.
