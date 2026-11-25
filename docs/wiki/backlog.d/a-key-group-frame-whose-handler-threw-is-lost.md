## P2 - A key-group frame whose handler threw is lost, and counted as a loss it is not

target: 1.8.1

Found by the adversarial review of #4084 (2026-11-25).

### What happens

`routeDistributionFrame` (`BaseMlsService.ts`) decrypts a key-group frame in
`openDistributionFrame`, which spends the generation and records it (`noteFrameConsumed`), and only
then hands the plaintext to the seed handler. When the handler throws (a seed STORE that failed: the
storage write, the mirror, a runtime that ended), the frame is left unacknowledged on the argument that
"redelivery is the right outcome". It is not. The redelivered bytes meet a spent generation, are
refused as `secret-reuse`, acknowledged as "unreadable for good", and counted by
`noteKeyGroupFrameLost`. So:

- the seed is lost on this device until a seed request recovers it from a peer;
- the loss counter printed in every seed request blames the network for a local store failure.

### What would close it

Keep the decrypted plaintext durably until its handler succeeds, keyed by the frame. Redelivery then
re-runs the handler on the kept plaintext instead of decrypting again. A failure is never counted as a
`secret-reuse` loss. Or, if the handler cannot be made to succeed, the outcome is classified at the
throw as its own kind, with its own line.

The test that lifts it: a handler that throws once and then succeeds stores the seed on the
redelivery, and `noteKeyGroupFrameLost` is not called.

Not fixed in #4084: the fix touches the decrypt-and-record path that #4083 is reworking, and it needs
a durable plaintext stash with its own retention rule. That is not a comment-sized change.
