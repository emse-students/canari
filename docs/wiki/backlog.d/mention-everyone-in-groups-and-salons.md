## P3 - "@tous" mentions every member of a group or a community salon

target: 1.8.2

**Decided by the owner on 2026-11-25** (asked the day `1.8.0` shipped): a mention today names one
person only, as one `@[uuid]` token per member (`frontend/src/lib/utils/mentions/mentionEditor.ts`).
There is no way to call a whole conversation.

### What was decided

- **Where**: group conversations AND community salons.
- **Who may write it**: in a group, every member (everyone in a group is equal). In a community
  salon, admins and moderators only - a member must not wake a whole year group.
- **Notification level**: `@tous` counts as a mention. A member at "Mentions" is notified; "Aucune"
  still silences everything.
- **Version**: `1.8.2`, after the reliability work of `1.8.1`.

### How it fits the encryption

The server cannot see who a ciphertext mentions: for a member at `mentions` the push travels with
`mentionsOnly` and the DEVICE decides after decrypting
(`apps/chat-delivery-service/src/services/messaging.service.ts`, the `mentionsOnly` branch). So
`@tous` is a reserved token the device recognises as mentioning its own user. The server changes
nothing for delivery.

### What a salon's restriction needs

The device decides the notification, so a non-moderator's token cannot be refused by the server's
mention logic. The rule must be enforced where the role is KNOWN on both ends:
- the composer refuses to offer or send it;
- every receiving device ignores a `@tous` from a sender who is not an admin or moderator of that
  salon, according to the roster it already holds.
It is classified as a type at the parse, never by matching a message string.

### Done when

The composer offers `@tous` (Paraglide labels, fr and en). It is rendered as a chip. It notifies
"Tous" and "Mentions" members and never "Aucune". A non-moderator's `@tous` in a salon is neither
offered nor honoured. Unit tests cover the parse and the honour rule. Both phones confirm the push.
