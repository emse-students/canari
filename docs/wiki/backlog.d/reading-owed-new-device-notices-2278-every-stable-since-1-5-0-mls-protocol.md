## Reading owed - new-device notices (#2278, every stable since `1.5.0`; mls-protocol)

target: 1.7.0

**What is built:** new-device notices (#2278, every stable since `1.5.0`; [mls-protocol](../protocols/mls-protocol.md#new-device-notices-decided-by-the-user-2026-10-22-refined-the-same-day))

**The reading that closes it:** add a web device with both phones shut: a local notification on each (the iPhone at its next message push), the in-app alert on opening, no second notification; a line "X added a device" in a DM with a contact who adds one; NO line in a community or salon

**Triage 2026-11-14: both phones, about 30 min** (a fresh browser profile logs in as each bench account to add a device with the phone shut: gamma's for the iPhone, alpha's for the Mi 9T; a DM with a contact who adds one; a community and a salon for the "no line" cases). #3550, the revoked-device check moved to registration, is not in `v1.6.12`; it is not read here.

**Mi 9T half, READ 2026-11-15 (dev, `1.6.12-alpha.2`, build 100601202, the alpha account; the app opened, the screen shut and locked):**
- **A web device added with the phone shut.** A wiped scratch seat of the same account logged in and enrolled (a fresh MLS identity, session and KeyPackage published): ONE local notification "Nouvel appareil / Un nouvel appareil a été ajouté à votre compte. Si ce n'est pas vous, ouvrez Canari." arrived on the lock screen (channel `canari_messages_v2`), about 1 minute after the enrolment began.
- **The in-app alert on opening.** After unlocking, `/notifications` listed exactly one "Nouvel appareil sur votre compte" row dated to the minute of the enrolment (the persisted notice queue held one entry); "Compris" cleared it. No second notification was posted by opening the app (the shade held no further "Nouvel appareil").
- **A DM with a contact who adds a device.** A fresh browser profile logged in as the DM's other account and enrolled: the DM on the phone showed the line "<contact> a ajouté un appareil" (and the line for the alpha device above it).
- **NO line in a community or a salon.** The community's `général` channel and two salons, opened after both enrolments, carried no "a ajouté un appareil" text.

**Left: the iPhone half (gamma's seat for it).**
