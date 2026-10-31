## A new device of a member enters without a tap (owner, 2026-10-30), built 2026-10-31

Final decision of 2026-10-30, guided by "je ne veux pas importuner les utilisateurs du tout". It
SUPERSEDES both the 2026-10-27 interim gate (the mandatory tap) and the "one approval per device"
decision recorded earlier the same day. **Restated by the owner on 2026-10-31**, from a screenshot of
"Nouvel appareil de X - Ajouter / Refuser" in a DM with X: *"la barriere est une barriere
utilisateur, pas appareil"*.

1. **Entry.** A new device of a person who is already a member enters with no tap and no ask, from
   anyone. **BUILT (2026-10-31)**: a member's device adds it automatically (`automaticAdmission`
   in `actions.ts` decides on the user's leaf in its own tree), and the device ask, its strings,
   its preview and its tests are deleted
   ([mls-protocol](../protocols/mls-protocol.md#a-device-of-a-member-is-added-never-asked-about-2026-10-31)).
   While it waits, the device shows `chat_waiting_own_device`: no key, no button.
2. **History.** That device receives the whole history its person was entitled to, filtered on that
   person's own presence windows: the existing addressed-answer rule, rule 2, "a new device of a
   continuous member", in [history-answer-addressing](../protocols/history-answer-addressing.md).
   Untouched by the 2026-10-31 change.
3. **Visibility.**
   - A silent system line, "X a ajouté un appareil", in each of X's conversations: no notification
     and no unread count. **BUILT**: every member and X's own other devices, 1:1s included, never
     in a key group, never as the conversation list's preview (`listPreview.ts`).
   - A discreet alert, "Nouvel appareil connecté", on X's other devices, with "Ce n'est pas moi",
     which revokes that device (built before).
   - This is what makes a device added through a compromised login visible. **Accepted residual
     risk, stated plainly:** such a device reads new messages and history until X reacts.
4. **New persons are unchanged.** The 2026-10-21 decision stands: a newcomer receives nothing from
   before their arrival, filtered on arrivals and departures. Link joins still wait for a member's
   Add (decided 2026-10-23), asked as "X veut rejoindre la conversation - Accepter / Refuser".
5. **Delivery.** Step A of history addressing (merged as #2270), and the server holes closed on
   2026-10-31 (a link joiner dated at the Add, the stream held to the span before arrival, a
   newcomer served nothing from before a member added them, #2800 -
   [history-reconciliation](../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21)),
   ship TOGETHER with this model (owner, 2026-10-31: "Non, ensemble"), in the release after 1.5.2.
6. **Interim in 1.5.2.** Device asks leave the global banner and stay only as the in-conversation
   row (a separate PR).

Owed:

- **"Enters by itself" is built as "is added by a member's device, with no tap".** A further device
  still sends a `welcome_request` rather than letting itself in (the tree-based door). A member's
  Android phone answers it from a push too, with the same user-level verdict (owner, 2026-10-31,
  "aussi en arriere-plan"; BUILT the same day). **iOS has no background add path**, so a group whose
  members' devices are all shut iPhones waits for one of them to open the app.
- A rig row: a member's second device enrolled, added with no ask, the line on every member and on
  the owner's other device, no line in the list preview (`DEVREVOKE-KEYGROUP`'s narration was
  updated: a device ask is now dirt there).
- The production rate of device enrolments per week, now that none of them costs a tap.

**Rejected earlier the same day:** one approval per device (a tap, account-wide and durable, plus a
durable server row when the owner has no other device) - replaced by self-entry; self-entry on
revoking old devices (it reopens the stolen-session lock-in); an account recovery key (USK,
[mls-protocol](../protocols/mls-protocol.md) shape B), which costs users an action.
