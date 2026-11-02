## Decided - the owner's answers of 2026-11-01, what `1.5.5` carries and what is left to build

Decisions, not open questions; each is built or owed as stated, and this entry is deleted when the
last one ships.

- **Follows and WP-F5** ([the plan](../backlog.md), [profiles-and-access](../profiles-and-access.md)):
  every ACCEPTED follow, the grandfathered ones included, opens across spaces, with no notice.
- **A join ask** ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)):
  one push per ask to the admitted members, plus a dot on the conversation row (shipped in #2834).
- **D5 in a 1:1**: the only action offered is "Retirer de ma liste". Owed.
- **Into `1.5.5`**: #2832 (D1) and #2824 (server-time order).
- **Calls** ([calls](../frontend/modules/calls.md)): the incoming-call screen is in-app plus Android
  full screen, with the same design (#2835); the live end keeps the red X, since a confirmation modal
  exists. RNNoise ships OFF with an in-call switch
  ([entry](call-noise-suppression-clean-speech-gate-fails-and-readings-owed.md)).
- **Migrations**: applied only if additive, reviewed, and with a backup just before - a held
  migration now fails the deploy until the owner approves it
  ([the gate](../cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)).
- **After `1.5.5`**: the next big chantier is opening a community, the 200 ms budget measurement
  ([community-open-budget](../frontend/community-open-budget.md)).
