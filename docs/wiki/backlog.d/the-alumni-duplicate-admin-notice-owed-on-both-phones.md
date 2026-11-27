## The Alumni duplicate admin notice, owed on both phones (a reading for 1.8.3; owner, 2026-11-26)

target: 1.8.3

Built: the Alumni duplicates are the fourth admin queue
([admin](../frontend/modules/admin.md#pending-counts-and-the-admin-notices-owner-2026-11-18)): a push
("Doublon Alumni à rattacher", no name) and a bell row to every global admin ONCE when an account an
Alumni sign-in created has an existing account an admin can attach it to (a search by its name finds an eligible one, homonyms included: the lead's reading of D55, [decisions](../decisions/owner-decisions-of-2026-11-27.md)), a live count on the Administration entry and on the
`/admin/alumni-duplicates` row, the item cleared for every admin as soon as one marks it for a merge.
The native side (`social_admin_alumni_duplicate` on Android and iOS, the `admin-alumni-duplicates`
deep-link host) is NOT compiled by the gates that ran here: a `1.8.3` pre-release is what compiles it.

The reading that closes it, on a `1.8.3` pre-release, the Mi 9T and the iPhone 12 each signed in as a
global admin of PRODUCTION (dev shares production MiConnect and holds no editor token, so neither the
sign-in finding nor the page can run on dev), a duplicate being, by its nature, a real account:

1. When the next Alumni-created account matching an existing one appears (or at the first reading of
   `/admin/alumni-duplicates` after the deploy, for one already there): each admin phone rings ONE
   push reading "Doublon Alumni à rattacher", no name; its tap opens `/admin/alumni-duplicates`; the
   bell shows the row; the dashboard tab, the Administration row and the queue's row show the count.
2. One admin marks it for a merge: the other phone's badges drop within seconds with no action, and
   the bell row is gone at its next load. Cancelling the mark brings the count back and rings NO new
   push.
3. MiConnect completes the merge at the duplicate's next Alumni sign-in: no push, the item stays gone.
4. Opening the page again never rings a second push for the same duplicate.
