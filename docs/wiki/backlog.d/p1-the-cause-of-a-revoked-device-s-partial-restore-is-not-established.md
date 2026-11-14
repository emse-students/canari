## P1 - the cause of a REVOKED device's partial restore is not established

target: 1.7.0

The wipe and tombstone halves are fixed ([auth](../frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it)); HEAL-REVOKE-1, -2, -3 are `PASS`. The shortfall report is built ([auth](../frontend/modules/auth.md#a-restore-that-comes-back-partial-says-so-2026-10-08)). Open: which cause the user hit (a session-only row removal, `revokeRowSessions` failing, or the watchdog rebuilding the store) is separable only from the user's own history. Not worth code without a measurement.

_Context, from the former backlog section "MLS state, device healing and delivery - the defects the campaign measured":_ Open entries only; each carries a title, what is left and a link. The measurements, recurrences and
refuted readings are on [campaign-measured-defects](../protocols/campaign-measured-defects.md), the
cold-start ledger on [history-reconciliation](../protocols/history-reconciliation.md).
