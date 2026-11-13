## Reading owed - one MLS state per account on a native install: `mls.bin` is the signed-in account's slot, every other account's state...

target: 1.7.0

**What is built:** one MLS state per account on a native install: `mls.bin` is the signed-in account's slot, every other account's state parked by rename (owner, 2026-11-02; compiled and host-tested only, [auth](../frontend/modules/auth.md#one-mls-state-per-account-on-a-native-install-owner-decision-2026-11-02))

**The reading that closes it:** on the iPhone 12 after a pre-release: A -> B -> A -> B, each account opens its messages, the `[MLS_ACCOUNT]` lines show each park and unpark
