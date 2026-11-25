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
