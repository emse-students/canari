## Reading owed - a message received inside a drain survives a kill right after a checkpoint (2026-11-17)

target: 1.7.0

**What is built:** a checkpoint stores the rows a live drain holds in its UI buffer before it exports
their ratchet advance ([chat](../frontend/modules/chat.md#rows-before-ratchet-a-checkpoint-stores-the-buffered-rows-first-2026-11-17)).
Proven by unit tests only (`useMessaging.rowsBeforeRatchet.svelte.test.ts`,
`BaseMlsService.rowsBeforeRatchet.test.ts`); no rig has killed a client inside a window.

**The reading that closes it:** on the `1.7.0` pre-release, on dev, two web clients (the
cross-client rig). B goes offline, A sends 30 messages, B comes back; the moment B's console prints
`[ADD_MSG] A checkpoint is about to export: storing the N buffered message(s) first` or `[MLS]
...checkpoint persisted` while `Bulk ingest done` has not yet printed, B's browser process is
killed (not closed). B reopened holds all 30 messages, and its console carries no `SecretReuseError`
and no `LOST frame` for them. Any message missing is a FAIL. The same on the Mi 9T (swipe the app
away during a catch-up) once the web half passes.
