## Reading owed - a DM read receipt survives a kill inside the 2 s window

target: 1.7.0

**What is built:** a DM read receipt survives a kill inside the 2 s window (the owed mark written at decision time and drained at every outbox registration; [history-reconciliation](../protocols/history-reconciliation.md#the-sender-says-only-what-is-new-and-the-outbox-keeps-one-watermark-per-conversation-2026-10-15))

**The reading that closes it:** on the Mi 9T: read a DM, kill the app within 2 s, relaunch - the peer shows it read; and the count of received `[READ] ... has read up to` lines and of MLS checkpoints per 3 minutes of a two-person exchange, against the build before the coalescing
