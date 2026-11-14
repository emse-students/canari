## Reading owed - a salon carries read receipts, seen in a real community

target: 1.7.0

**What is built:** a salon carries read receipts (#1235, `v0.18.32`; [social-service](../services/social-service.md#read-receipts-in-a-salon)). **The rig half passed on 2026-11-14**: `READ-6`, twice on the local estate at `ad2053fc0`, the non-admin sender's message marked read within 101 ms and 0 ms of the reader opening it, no exception on the reader (the verdict reads `PASS-DIRTY` only for the sender's own send lines, which the classifier does not yet name).

**The reading that closes it:** one look in a real community on a phone: a member who is not an admin sees the double check and "Lu par" under their own last message.
