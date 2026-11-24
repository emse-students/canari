## P2 - a catch-up still pays one store round trip per reaction and per read mark

target: 1.9.0

Measured on the owner's Android `1.7.3` catch-up (148 frames, ~10 s): 34 reactions at ~75 ms
(`applyReactionFrame` stores each before its handler returns) and the peer's read marks at ~65 ms
(`systemMessageHandler` awaits one `saveConversation` per mark) - ~4.2 s that the texts' batching
(2026-11-24) does not touch. Batching them per window means holding each frame's ack until its write
landed, as the text rows already do (rows before ratchet), never acknowledging ahead of the disk
([chat](../frontend/modules/chat.md#a-catch-up-lands-in-one-render-2026-11-24)).
