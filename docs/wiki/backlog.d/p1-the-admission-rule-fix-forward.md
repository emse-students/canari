## P1 - the admission rule's fix-forward: a conversation may refuse an entry no member made only once nothing legitimate produces one

#2815 made a conversation refuse an external commit by a user holding no leaf, then freeze. Its
post-merge review found it froze legitimate members out for good and dropped every later frame, so
the owner DISARMED it on 2026-10-31: the verdict is computed and logged, the commit is merged, and
`[UNINVITED_ENTRY]` still measures it ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).

Owed, in this order, before any refusal is re-armed:

1. **Read the `[UNINVITED_ENTRY]` count on production, by `kind`** (`new-person`, `returning`,
   `direct-peer`, `unvouched-device`), so the legitimate paths are measured first.
2. **The emission side.** A user holding no leaf ASKS a member instead of entering alone, mirroring
   the further-device door (`recovery.ts`, `requestReAdd`); never in a 1:1, where the peer whose
   KeyPackage was skipped at creation is the conversation. The three legitimate producers to close:
   a skipped KeyPackage (`welcome.rs` `external_join_is_a_further_device` false), a leaf removed by
   the stray sweep after its only device was revoked, an evicted only leaf on a standing seat
   (`unhonoured-seat`).
3. **An unfreeze path.** Whatever a refusal leaves is lifted by a person or by a fact, per account,
   never stored device-wide and never permanent.
4. **Never drop frames.** A refusal may stop a recovery; it may not ACK a conversation's messages
   away. And it must hold against a member who enrols a second account to freeze a conversation on
   purpose, and against an older client that merges the commit while its peers refuse it (the
   split): both need the floor raised to the build that refuses.
