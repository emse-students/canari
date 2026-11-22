### Fixed - a device removed from the account, then its PIN typed at the gate, no longer reads "server unreachable"

A 401/403 from the PIN salt or check is now a typed answer: the gate asks why the session was refused and shows "Cet appareil a ete retire de votre compte" with no keypad (or signs out for any other dead session). Only a transport failure reads as unreachable ([auth](docs/wiki/frontend/modules/auth.md#pin-and-device-key), [backlog](docs/wiki/backlog.d/reading-owed-pin-gate-audit-rows-of-2026-11-20.md)).
