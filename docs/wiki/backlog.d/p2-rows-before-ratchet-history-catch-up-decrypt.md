## P2 - rows before ratchet: the history catch-up decrypt sessions take no mark (review of #3851, 2026-11-19)

target: 1.8.0

Outside the ledger the decrypt half built
([chat](../frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)): the
history catch-up decrypts whole pages through an `MlsDecryptSession` (`mlsDecryptSession.ts`, the
sequential one on Tauri and as the web fallback; the crypto-worker one in
`WebMlsService.createDecryptSession`, which installs the worker's state into the live client at
`finish`). Neither marks the rows of the frames it decrypts, so a checkpoint between a page's decrypt
(or the worker state's install) and the replay's write of those rows exports advances whose rows are
not stored. The replay's frames are archive copies, so a kill there costs what the archive replay
would read again only if no landed checkpoint marked them seen - which that very checkpoint did.

**What closing it needs.** Decide the unit: a mark per page (settled once the page's rows are stored
or buffered) or one for the session (settled at `finish`, after the rows) - and never across work that
awaits a checkpoint. A test per session kind. **Size: 1 day**, Opus review.
