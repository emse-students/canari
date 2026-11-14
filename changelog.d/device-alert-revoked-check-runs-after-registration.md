### Fixed - a revoked device's alert is dropped even when the view opens before registration

The new-device alert of a revoked device is dropped even when the notifications view opens before the account registers (a cold start or a reload lands on it directly): the check is now owed and runs at registration, and every branch of it logs which way it went (counts, no ids). Found on the Mi 9T, 2026-11-14 ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
