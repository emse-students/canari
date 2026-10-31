## A new device of a member ENTERS BY ITSELF, with a history and a visible trace (owner, 2026-10-30, the WhatsApp model, not built)

Final decision of 2026-10-30, guided by "je ne veux pas importuner les utilisateurs du tout". It
SUPERSEDES both the 2026-10-27 interim gate (the mandatory tap) and the "one approval per device"
decision recorded earlier the same day. Planned for the release after 1.5.2.

1. **Entry.** A new device of a person who is already a member enters by itself. No tap and no ask,
   from anyone: not the owner's other devices, not contacts.
2. **History.** That device receives the whole history its person was entitled to, filtered on that
   person's own presence windows: the existing addressed-answer rule, rule 2, "a new device of a
   continuous member", in [history-answer-addressing](../protocols/history-answer-addressing.md).
3. **Visibility.**
   - A silent system line, "X a ajouté un appareil", in each of X's conversations: no notification
     and no unread count.
   - A discreet alert, "Nouvel appareil connecté", on X's other devices, with "Ce n'est pas moi",
     which revokes that device.
   - This is what makes a device added through a compromised login visible. **Accepted residual
     risk, stated plainly:** such a device reads new messages and history until X reacts.
4. **New persons are unchanged.** The 2026-10-21 decision stands: a newcomer receives nothing from
   before their arrival, filtered on arrivals and departures. Link joins still wait for a member's
   Add (decided 2026-10-23).
5. **Delivery.** Step A of history addressing (merged as #2270, in no release yet), and the two
   server holes closed on 2026-10-31 (a link joiner dated at the Add, the stream held to the span
   before arrival - [history-reconciliation](../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21)),
   ship TOGETHER with this model, in the release after 1.5.2.
6. **Interim in 1.5.2.** Device asks leave the global banner and stay only as the in-conversation
   row (a separate PR).

**Rejected earlier the same day:** one approval per device (a tap, account-wide and durable, plus a
durable server row when the owner has no other device) - replaced by self-entry; self-entry on
revoking old devices (it reopens the stolen-session lock-in); an account recovery key (USK,
[mls-protocol](../protocols/mls-protocol.md) shape B), which costs users an action.

Mechanism and the superseded interim: [mls-protocol](../protocols/mls-protocol.md#an-unseen-device-of-a-member-2026-10-27-interim).
