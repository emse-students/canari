## P3 - the bell picker keeps its old level after a re-follow, until the page is opened again

target: 1.8.0

**Seen 2026-11-15 on the iPhone 12** (TestFlight `1.6.12-alpha.2`, dev, an association page). The steps were:

1. Set the bell to "Rien".
2. Tap "Ne plus suivre", then "Suivre".

The server reset the bell, as designed: `FollowsService.followAssociation` deletes the row (`[FOLLOW] ... followed, bell reset`). The picker beside "Ne plus suivre" still read "Rien" until the page was opened again, and then it read "Publications et lives".

A member who re-follows is therefore told the wrong level. The follow answer already knows that it reset the bell, so the fix is to carry that fact back to the client, which then sets the picker's level from the answer. It must not re-fetch on a timer. Pin it in the `AccountBell` component test.
