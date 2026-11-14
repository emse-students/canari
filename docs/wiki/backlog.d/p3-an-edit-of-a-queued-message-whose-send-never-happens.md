## P3 - an edit of a queued message whose file is then withdrawn or fails for good still goes out, naming a message nobody receives

target: 1.10.0

**Found** in the review of #3368 (caption edits, 2026-11-11). An edit of a DM or group message still
in the outbox is queued as its own `edit_message` control frame. `dependsOnAny` (`outbox.ts`) holds it
behind the message while the message is unsent. But if the message then never leaves, the hold is
lifted and the edit is sent anyway. That happens when its file is withdrawn ("Annuler", a delete of
an unsent message) or its upload fails for good. Each peer then keeps the edit as a parked mutation
(`keepPendingMutation`, `pendingMutations.ts`) for a target that will never arrive, with no end. A
text message's edit has the same shape, though a text rarely fails to send for good.

**What a fix has to say:** a withdrawal or final failure of a message also retires the control frames
still queued that name it (the same byte match `dependsOnAny` already makes). A parked edit whose
target never came also needs a bound decided from durable state, not from a clock. Mechanism:
[chat](../frontend/modules/chat.md#a-media-messages-edit-is-a-caption-edit-2026-11-11).
