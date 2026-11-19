## P2 - rows before ratchet: a frame whose dispatch threw is withheld, but its redelivery reads as a duplicate (review of #3851, 2026-11-19)

target: 1.8.0

Left by the fix of #3851's SF-3
([chat](../frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)): a
frame that decrypted and whose dispatch then threw (`InboundDispatchError` in `handleKnownGroup`) is
no longer read as a decrypt failure - no re-add, NOT acknowledged. But its generation is spent and its
fingerprint noted consumed (`noteConsumed`, before the dispatch), so when the next pull lists the frame
again, the decrypt fails `SecretReuseError` and `handleUnreadableFrame` takes it for a duplicate and
acknowledges it. Withholding therefore keeps the message only while no pull comes (a reload before the
next checkpoint re-reads it); after that, a row the dispatch did not store is lost from this device.
The reachable trigger the review named (an unguarded `BroadcastChannel.postMessage` between the render
and the write) is closed (`tabMessageSync.post` never throws); this entry is the general case.

**What closing it needs.** Carry the dispatch failure to where the redelivery is judged - e.g. a
per-session set of fingerprints whose dispatch failed, which `handleUnreadableFrame` reads as a LOSS
(the id-addressed reconcile, `raiseReconcile`) instead of a duplicate - or keep the decoded message
itself in the messaging layer's kept batches so the next hold writes it. A test that a redelivered
frame whose first dispatch threw ends with its row stored or a reconcile raised. **Size: 1 day.**
