## P2 - rows before ratchet: a frame carrying no message whose dispatch threw is withheld, but its redelivery reads as a duplicate (reviews of #3851, 2026-11-19)

target: 1.8.5

Left by the fixes of #3851
([chat](../frontend/modules/chat.md#a-poison-row-is-dropped-not-kept-2026-11-19)). A frame that
decrypted and whose dispatch then threw (`InboundDispatchError` in `handleKnownGroup`) is no longer read
as a decrypt failure - no re-add, NOT acknowledged - and a MESSAGE whose add threw is kept by
`useMessaging.addMessageToChat` with its `frameId`, so the checkpoint's hold writes it or is refused.
What is left is a frame carrying NO message: a reaction, a system event (an edit, a deletion, a
notice's other effects), a call signal. Its generation is spent and its fingerprint noted consumed
(`noteConsumed`, before the dispatch), so once a checkpoint lands, the next pull's copy fails
`SecretReuseError` and `handleUnreadableFrame` takes it for a duplicate and acknowledges it. A
reaction, an edit and a deletion whose WRITE fails are parked (on disk) and never reach this; what
reaches it is a throw elsewhere in those dispatches.

**What closing it needs.** Carry the dispatch failure to where the redelivery is judged - e.g. a set of
fingerprints whose dispatch failed this session, which `handleUnreadableFrame` reads as a LOSS (the
id-addressed reconcile, `raiseReconcile`) instead of a duplicate - or refuse checkpoints while such a
failure stands. A test that a redelivered frame whose first dispatch threw ends with a reconcile
raised or its effect applied. **Size: 1 day.**
