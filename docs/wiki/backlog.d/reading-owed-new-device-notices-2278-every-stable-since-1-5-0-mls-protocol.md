## Reading owed - new-device notices (#2278, every stable since `1.5.0`; mls-protocol)

target: 1.7.0

**What is built:** new-device notices (#2278, every stable since `1.5.0`; [mls-protocol](../protocols/mls-protocol.md#new-device-notices-decided-by-the-user-2026-10-22-refined-the-same-day))

**The reading that closes it:** add a web device with both phones shut: a local notification on each (the iPhone at its next message push), the in-app alert on opening, no second notification; a line "X added a device" in a DM with a contact who adds one; NO line in a community or salon

**Triage 2026-11-14: both phones, about 30 min** (a fresh browser profile logs in as each bench account to add a device with the phone shut: gamma's for the iPhone, alpha's for the Mi 9T; a DM with a contact who adds one; a community and a salon for the "no line" cases). #3550, the revoked-device check moved to registration, is not in `v1.6.12`; it is not read here.
