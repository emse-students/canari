## Reading owed - a member sends their history to a new group member (owner, 2026-11-25)

target: 1.8.2

**Built, covered by unit tests, never read across two devices** ([history-reconciliation](../protocols/history-reconciliation.md#a-member-may-send-their-history-to-a-newcomer-owner-2026-11-25); owner decision of 2026-11-25, item 5, [decisions](../decisions/owner-decisions-of-2026-11-25.md); charter principle 1). The cross-client rig drives only a DEPLOYED build, so it reads this once a pre-release carrying it serves dev.

**What to read** (dev, two browser contexts, W1 `owner` and W2 `peer`; then once on a phone as the newcomer):

1. **The default holds.** W1 creates a private group alone or with a third member, sends five messages over a few minutes, then adds `peer`. W2 opens the group: the five messages are NOT there, only what follows the addition.
2. **The button.** On W1, under "owner a ajouté peer au groupe", "Envoyer l'historique des messages" shows; it does not show on W2 (the viewer is the added person), nor in a 1:1, a salon or "Mes notes".
3. **The grant.** W1 presses it, picks "Tout l'historique", sends. Both W1 and W2 draw "owner a envoyé à peer l'historique des messages échangés depuis le début" with its "En savoir plus". Within seconds W2 holds the five messages, in place and once each. The logs carry `[HISTORY_GRANT] ... asking`, `[HISTORY_GRANT] ... answering from`, and `[HISTORY_GRANT] ... a granted answer: our arrival span lifted`; no `REFUSED`.
4. **A date.** A second grant from "7 derniers jours" (or a date after some of the five) delivers only what lies after it - nothing older appears.
5. **A Remove still holds.** W1 removes `peer`, sends two messages, re-adds `peer`, grants "everything": the two messages sent while `peer` was out never reach W2.
6. **The phone.** The same grant with the phone as the newcomer's second device: it receives the history too, its own ask answered.
