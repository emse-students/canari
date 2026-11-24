## P2 - iPhone message banners as communication notifications: one iPhone reading owed, the sign-out row (2026-11-21)

target: 1.8.1

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

**2026-11-23, `1.8.0-alpha.4` ([iPhone 12 sitting](../device-verification.md#the-readings-of-2026-11-23-180-alpha4-iphone-12-the-bell-after-a-re-follow-the-dm-thread-the-communication-banners-the-focus-rows-the-voice-note-the-composer)): rows 1 to 5 are READ and PASS, row 7 is CLOSED, row 6 stays.** Row 1 and 2: with Do Not Disturb on and Canari absent from its allowed apps a DM from `delta` raised nothing on the lock screen (the extension still ran: `communication style applied`); with Canari added to the allowed apps the next DM came through as a banner with the sender's face. Row 3: the DM banner draws the sender's face on the left with the Canari badge, the sender as the title, no second copy as an attachment (`communication style: donating isGroup=false source=avatar`). Row 4 passed on `alpha.3`. Row 5: a group @-mention keeps the group's name ("Mentioned you - S15R2B" as the subtitle, `message shape isGroup=true declared=Optional(true)`). **Seen, not a row:** that mention banner carries the TIME SENSITIVE label and the plain app icon with no face although the extension logged `communication style applied isGroup=true`; the face is the one thing the row did not ask for, and the plain look is what iOS drew. **Row 7 is closed:** it needs the app swiped away in the app switcher, which the driver cannot do ([the rule](../device-verification.md#readings-closed-on-2026-11-23---no-hand-can-take-them)). **Row 6 stays**: it signs the bench account out and back in, and no sitting has yet taken the cost of the re-enrolment.

**2026-11-24, `1.8.0-alpha.6` ([iPhone 12 sitting](../device-verification.md#the-readings-of-2026-11-24-180-alpha6-iphone-12-the-dm-thread-again-the-composer-the-ios-27-sdk-build-the-broadcasters-column-the-voice-note-the-sign-out-row)): row 6 FAIL on its second half, its first half cannot be produced online.** After a sign-out the push registration is ended (`[Push] sign-out ended this device's push registration (ios)`), so a DM sent afterwards raised no banner and ran no extension: "a push still delivered" is only reachable through row 7's offline gesture. The share sheet, from Photos, still offered "Canari Test Delta" 90 s and 3 min after the sign-out: [P2 - the share sheet still offers the previous account's sender](p2-the-share-sheet-still-offers-the-previous-account-s-sender-after-a-sign-out.md). Rows 1 to 5 stay read and PASS; row 7 stays closed.
