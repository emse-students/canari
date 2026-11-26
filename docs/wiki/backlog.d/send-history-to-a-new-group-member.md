## P3 - a member sends their history to a new group member (owner, 2026-11-25)

target: 1.8.2

**Decided** ([owner, 2026-11-25, item 5](../decisions/owner-decisions-of-2026-11-25.md)): under the
"X a rejoint le groupe" notice of a private group, any member may press "Envoyer l'historique des
messages" and send the newcomer the messages their own device holds, from a date they choose; every
member sees a notice saying so. An explicit exception to
[a new member receives nothing from before their arrival](../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21),
whose default stays: nothing is sent unless a member presses the button. End to end, the server sees
nothing. Private groups only (communities keep `shared`/`joined`; a 1:1 has no add path).

**What to build.**

- **The button** on the joined notice, offered for a NEWCOMER only - never for a new device of an
  existing member, which already restores its history automatically.
- **The date picker**: shortcuts 24 h, 7 days, 30 days, everything, or a date.
- **The bundle, filtered by its start date**, inside the existing per-person span machinery (Step C
  of the same [history-reconciliation](../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21)
  section): the sender's push carries the newcomer's span from the chosen date instead of withholding it.
- **The system notice to every member**, "A a envoyé à X l'historique des messages échangés depuis :
  <date>", with an "En savoir plus" link - Paraglide strings (`fr.json`, `en.json`) from the first draft.
- **The receiving side** places the messages in order and dedupes them against anything it already holds.

**Open design points, to settle when it is built:** what the notice says when two members both send;
a size bound for "everything"; what the newcomer sees while the history arrives.

**Read 2026-11-25 - what the design must ride on, so the first slice is not built on the wrong path.**
The join push carries the conversation's STATE and no message since 2026-11-17: it answers no ask,
so it cannot be sealed to its reader, and a message in it would be readable by any member a server
hands it to ([history-reconciliation](../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21),
`sendFullHistoryBundle`). And three layers drop the newcomer's pre-arrival past on purpose: the
answerer's filter on the reader's `withheld` windows (`readerHistorySelection`), the receiver's own
(`dropOwnExcludedMessages`), and the server's stream. So the button cannot simply push a bundle.
The shape that fits all three: the press sends a GRANT (an MLS application message every member
decrypts - it IS the notice, so the server still sees nothing), naming the newcomer, the granter
and the start date; the newcomer's device answers a grant addressed to it with its own SEALED
history ask to the granter, naming the grant; the granter answers that ask filtered from the
grant's date instead of the newcomer's span; the receiver lifts its own pre-arrival drop for that
answer only, bound to that grant and that granter. Three pull requests: (a) the grant frame and its
notice (Paraglide); (b) the sealed ask under a grant, both ends, with the receiver's lift; (c) the
button and the date picker, which need (a) and (b) to do anything. An older newcomer ignores the
unknown frame and keeps receiving nothing - the decided default, so no floor is needed.

