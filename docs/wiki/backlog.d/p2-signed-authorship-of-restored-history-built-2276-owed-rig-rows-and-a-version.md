## P3 - an unsigned restored message is only marked, and a history bundle has no byte cap per chunk

target: 1.10.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

Restored history carries each message's author signature, and frames carry a signed epoch fingerprint ([history-reconciliation](../protocols/history-reconciliation.md#restored-history-carries-its-authors-signature-2026-10-22), [mls-protocol](../protocols/mls-protocol.md#fork-detection-a-signed-epoch-fingerprint-in-every-application-frame-2026-10-22)).

**The rig rows were closed on 2026-11-14 without a run, on named tests.** Neither can be provoked on the rig: every client the estate admits signs (`minClientVersion` `1.6.6`), so a fresh seat holds no unsigned message to restore, and the server orders commits, so no client gesture forks an epoch. Pinned instead by `systemMessageHandler.bundleAuthorship.test.ts` (a relayed unsigned message kept and MARKED, a verifying copy upgrading it), `messageAuthorship.test.ts` (a proof verifies under the author's device key), `MessageMetadata.unverified.svelte.test.ts` (the "non verifie" marker) and `integrityFindings.test.ts` (a same-epoch refusal reported as one fork finding per session).

- **The floor:** unsigned messages are only MARKED today. Re-read 2026-11-11: no client allowed to connect sends an unsigned message any more (#2276 is in every stable since `1.5.0`). Refusing them outright waits only on the oldest unsigned message a device may still hold: with native retention at 5 years (owner, 2026-11-11, [history-reconciliation](../protocols/history-reconciliation.md#two-boundaries-not-one)), that is any unsigned message less than 5 years old.
- **A history bundle has no byte cap per chunk, only a message count** (re-read 2026-11-11: still none), and each message now carries its body and proof beside its content (about 2.5x per message). A cap in bytes is owed before bundles of long messages are common.
