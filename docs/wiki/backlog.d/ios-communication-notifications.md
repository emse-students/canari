## P2 - iPhone message banners as communication notifications: seven iPhone readings owed (2026-11-21)

target: 1.8.0

Built (owner's decision of 2026-11-21): the notification extension donates an incoming
`INSendMessageIntent` and redraws each DM and group banner from it, the app carries
`com.apple.developer.usernotifications.communication`, and the sign-out erases the donations
([mobile](../frontend/mobile.md#communication-notifications-owner-2026-11-21)). Compiled by CI only.

**The portal step is DONE (2026-11-21)**: the owner enabled "Communication Notifications" on the
`fr.emse.canari` App ID; the regenerated "Canari" distribution profile (to 2027-07-11) is in the
`APPLE_PROVISIONING_PROFILE` secret and the bench development profile (to 2027-11-21) is installed;
both carry the communication and time-sensitive entitlements.

**Not a `Reading owed - ` entry, deliberately**: `plan.mjs` places a reading in the earliest tier
only (1.7.3), and this ships after it; the target is the owner's, 1.8.0.

**The readings on the iPhone 12**, on the first pre-release carrying it (the extension's
`communication style applied` / `WARN communication style not applied` line in the syslog says which
path ran):

1. A Focus with Canari allowed (or the sender allowed as a person) lets a DM through.
2. A Focus without Canari holds the same DM back.
3. The banner's avatar is the sender's face (or their initials disc when they have no photo), on
   the left, with no second copy of it as an attachment; a photo message keeps its thumbnail.
4. A group banner shows the group's name (an unnamed group: "Conversation de groupe"), and the
   sender.
5. A group @-mention keeps the group's name (it declares `recipientCount` 2) - not drawn as a DM.
6. After a sign-out, a push still delivered draws the PLAIN banner (`reason=no-account-context`)
   and the next account's share sheet offers none of the previous account's senders.
7. Signed out in flight mode and swiped away at once: the next launch logs
   `conversation shortcuts erased` (`launch`) and the next account's share sheet still offers none
   of the previous account's senders.

**Noise to rule out**: on a phone restarted and not yet unlocked, a push must skip with
`reason=no-account-context` (the App Group file is unreadable then) - if instead `donate` fails and
logs `WARN` on every push, that is noise and is fixed before the stable.

If a row fails while the app was alive rather than killed, check first which composer drew the
banner: the app's own (`canari_push.mm` `CanariShowMessageNotification`) is not converted.
