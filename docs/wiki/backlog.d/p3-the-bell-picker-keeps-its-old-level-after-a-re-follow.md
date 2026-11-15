## P3 - the bell picker keeps its old level after a re-follow, until the page is opened again

target: 1.8.0

**Seen 2026-11-15 on the iPhone 12** (TestFlight `1.6.12-alpha.2`, dev, an association page). The steps were:

1. Set the bell to "Rien".
2. Tap "Ne plus suivre", then "Suivre".

The server reset the bell, as designed: `FollowsService.followAssociation` deletes the row (`[FOLLOW] ... followed, bell reset`). The picker beside "Ne plus suivre" still read "Rien" until the page was opened again, and then it read "Publications et lives".

A member who re-follows is therefore told the wrong level. The follow answer already knows that it reset the bell, so the fix is to carry that fact back to the client, which then sets the picker's level from the answer. It must not re-fetch on a timer. Pin it in the `AccountBell` component test.

**Seen again 2026-11-15 on the Mi 9T** (`1.6.12-alpha.2`, dev, an association page; the same defect, both platforms): with the bell at "Lives seulement", "Ne plus suivre" then "Suivre" on the SAME open page. `GET /api/posts/me/bells` answered `[]` right after the re-follow (the server did its part), but the page kept reading "Lives seulement" for the 5 s it was watched; leaving and coming back read "Publications et lives". `AccountBell.svelte` reads its level once, on mount, and `AssociationDetailView.svelte` mounts it beside the follow state, so a follow that resets the bell never reaches it. The person profile did not show it in the same sitting (its follow is a request, read again on the next visit). Whichever way the fix goes (the follow answer carries the reset, or the bell re-reads when the follow state turns to "following"), it is the cause that is fixed, never a timer, and the component test pins unfollow, follow and the new level on both the association page and, if it shares the bell, the person page.
