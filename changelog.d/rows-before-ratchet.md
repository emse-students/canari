### Fixed - a message received during a catch-up is stored before the checkpoint that spends its key

A checkpoint landing while a live drain's window was open could make a message's ratchet advance durable
while its row was still only in memory, so a kill there lost the message for good; the checkpoint now
stores the buffered rows first ([chat](docs/wiki/frontend/modules/chat.md#rows-before-ratchet-a-checkpoint-stores-the-buffered-rows-first-2026-11-17)).
