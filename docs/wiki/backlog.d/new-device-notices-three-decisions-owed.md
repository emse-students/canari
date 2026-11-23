## New-device notices: three decisions owed (built by #2278, 2026-10-22)

target: 1.9.0

**The three answered by the owner, 2026-11-19** ([decisions](../decisions/owner-decisions-of-2026-11-19.md)):
1. **Yes**: a phone whose WebView is alive in the background also raises a LOCAL notification for a new
   device, disabled in one gesture (its own notification category, Paraglide strings);
2. **No**: a device first seen in a tree this device has just joined is NOT announced; only a device that
   appears AFTER this device's own arrival is;
3. **7 days** stays the bound of a contact's line.
Owed: build 1, and make 2 the rule if the code does not already hold it, each with its test.

The notices ship in every stable since `1.5.0` ([mls-protocol](../protocols/mls-protocol.md#new-device-notices-decided-by-the-user-2026-10-22-refined-the-same-day));
their phone readings are a row of [the readings owed](../plan.md#readings-owed).
Three product questions were left open by the build, and none is answered by the code (re-read
2026-11-11):

1. Whether a phone whose WebView is alive in the background should also raise the local
   notification (today only the in-app alert).
2. Whether a device first seen in a tree this device joined should be announced.
3. Whether 7 days is the right bound for a contact's line (a device first seen by the server earlier
   is a heal, not a new device - the evidence table is in mls-protocol).
