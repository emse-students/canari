## Reading owed - new-device notices (#2278, every stable since `1.5.0`; mls-protocol)

target: 1.7.0

**What is built:** new-device notices (#2278, every stable since `1.5.0`; [mls-protocol](../protocols/mls-protocol.md#new-device-notices-decided-by-the-user-2026-10-22-refined-the-same-day))

**The reading that closes it:** add a web device with both phones shut: a local notification on each (the iPhone at its next message push), the in-app alert on opening, no second notification; a line "X added a device" in a DM with a contact who adds one; NO line in a community or salon

**Triage 2026-11-14: both phones, about 30 min** (a fresh browser profile logs in as each bench account to add a device with the phone shut: gamma's for the iPhone, alpha's for the Mi 9T; a DM with a contact who adds one; a community and a salon for the "no line" cases). #3550, the revoked-device check moved to registration, is not in `v1.6.12`; it is not read here.

**iPhone 12, sixth sitting, 2026-11-15 (`1.6.12-alpha.2`, dev): the iPhone half READ.** With the app in the background, gamma's second web seat had its origin cleared and logged in again (a new gamma device). At the next DM push Notification Center held ONE local notification "Nouvel appareil / Un nouvel appareil a ete ajoute a votre compte..."; opening the app, Notifs held the row "Nouvel appareil sur votre compte (15 novembre 2026 a 12:38)" with its buttons and the banner was gone, none drawn twice; the DM with a contact showed one line "Canari Test Gamma a ajoute un appareil"; an (empty) community salon drew none. **Left: the Mi 9T half (alpha's account).** Evidence: [device-verification](../device-verification.md#the-iphone-12-readings-of-2026-11-15-sixth-sitting).
