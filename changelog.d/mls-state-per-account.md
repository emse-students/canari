### Fixed - Two accounts on one phone each keep their own encrypted messages

The local MLS state was one file per install, so the second account to sign in could not open it and only a reinstall cleared it. Each account's state is now its own file: the signed-in account's sits where every engine reads it, the others are parked aside and moved back - never rewritten - when their account signs in, ownership proven by the record the file already carries ([auth](docs/wiki/frontend/modules/auth.md#one-mls-state-per-account-on-a-native-install-owner-decision-2026-11-02)).
