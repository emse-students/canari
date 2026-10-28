### Fixed - the native MLS manager and its at-rest key no longer outlive the account that loaded them

A sign-out, an account switch, a failed sign-in and a state reset now end the native MLS session in one locked step, and every MLS command refuses with a typed error when none is installed; a signed-in session found without one ends into the sign-in screen ([mls-protocol](docs/wiki/protocols/mls-protocol.md#the-native-manager-does-not-outlive-its-account-2026-10-27)).
