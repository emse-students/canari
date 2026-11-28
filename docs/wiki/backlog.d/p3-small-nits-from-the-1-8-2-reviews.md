## P3 - one nit left from the 1.8.2 reviews (the GIF-only bubble pulse)

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-27: the first nit shipped - an unvouched salon `@tous` is drawn as the plain typed word, not an accent chip: the history row now carries the server's `mentionsEveryone` (social-service `listMessages`), the decode keeps it as `everyoneVouched`, `ChatMessageGroups` computes `everyoneMentionOf(isSalon, vouched)` per row and hands `everyoneHonoured` down the bubble, `MessageTextBody` / `MessageMediaRenderer` and `MessageInlineText`. The fact is sealed in the stored row's payload (`messagePayload.ts`, never a clear column), so a page drawn from the on-device copy already draws the chip, with no flip when the server page lands. The phone reading is its own entry, [p3-reading-unvouched-salon-everyone-plain](p3-reading-unvouched-salon-everyone-plain.md)._

**The GIF-only bubble pulse is looser than the GIF** (`GifEmbed` carries `my-1.5 rounded-xl`, the outline the jump pulse draws follows the bubble) and a class re-render can drop the pulse early. It belongs to the jump-outline work (`fix/selected-message-outline`, held for 1.8.3): fix it there when that merges, with the same reading.
