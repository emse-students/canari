## Reading owed - the signed history restore and forced-fork rig rows

target: 1.7.0

Restored history carries each message's author signature, and frames carry a signed epoch fingerprint ([history-reconciliation](../protocols/history-reconciliation.md#restored-history-carries-its-authors-signature-2026-10-22), [mls-protocol](../protocols/mls-protocol.md#fork-detection-a-signed-epoch-fingerprint-in-every-application-frame-2026-10-22)). Owed:

- **Rig rows:** a history restore between two clients on a live local estate (a signed message verified, an older one marked "non verifie"), and a forced fork that must produce one `[INTEGRITY] fork` line on each side.
- **The floor:** unsigned messages are only MARKED today. Re-read 2026-11-11: `minClientVersion` is `1.6.6`, a signing build (#2276 is in every stable since `1.5.0`), so no client allowed to connect sends an unsigned message any more. Refusing them outright now waits only on the oldest unsigned message a device may still hold: with native retention at 5 years (owner, 2026-11-11, [history-reconciliation](../protocols/history-reconciliation.md#two-boundaries-not-one)), that is any unsigned message less than 5 years old.
- **P3 - a history bundle has no byte cap per chunk, only a message count** (re-read 2026-11-11: still none), and each message now carries its body and proof beside its content (about 2.5x per message). A cap in bytes is owed before bundles of long messages are common.
