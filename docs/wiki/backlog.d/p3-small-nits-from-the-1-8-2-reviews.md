## P3 - two nits left from the 1.8.2 reviews (an unvouched salon `@tous` drawn as a chip, the GIF-only bubble pulse)

target: 1.8.3

1. **An unvouched salon `@[everyone]` is drawn as an accent chip** (`MessageInlineText.svelte`, `type === 'everyone'`) although the server did not vouch for it and nobody was called: the chip promises a notification that never left. It should be drawn plain (the typed text) unless the conversation honours it (`everyoneMentionOf(isSalon, vouched)`). Plumbing owed: the message's `everyoneVouched` and the salon fact reach `MessageBubble`, then `MessageTextBody` and `MessageMediaRenderer`, then the inline text - three components and their tests.
2. **The GIF-only bubble pulse is looser than the GIF** (`GifEmbed` carries `my-1.5 rounded-xl`, the outline the jump pulse draws follows the bubble) and a class re-render can drop the pulse early. It belongs to the jump-outline work (`fix/selected-message-outline`, held for 1.8.3): fix it there when that merges, with the same reading.
