## The admin queue badges and notices, owed on both phones (a reading for 1.7.1; owner, 2026-11-18)

target: 1.7.1

Built: a count of pending items on the Administration row of the dashboard and on each admin queue's
row (profile corrections, moderation reports, agenda), from `GET /api/moderation/admin-queues`; and a
bell row plus a push to every global admin when a profile correction is filed or a subject is
reported for the first time, cleared for every admin once one handles it
([admin](../frontend/modules/admin.md#pending-counts-and-the-admin-notices-owner-2026-11-18)).

The reading that closes it, on a `1.7.1` pre-release, the Mi 9T and the iPhone 12 each signed in as a
global admin of dev, a test account filing the items:

1. A test account files a profile correction: the admin phone rings a push reading "Demande de
   correction de profil" (no name), its tap opens `/admin/profile-corrections`; the bell shows the
   row; the dashboard's Administration row and the queue's row show `1`.
2. The other admin phone applies (or refuses) it: on the first phone the bell row is gone and both
   badges are gone after a pull-to-refresh or a reload, with no action on that phone.
3. A test account reports a post twice from two accounts: ONE push and ONE bell row; dismissing both
   reports clears them.
4. A BDE moderator account (no global admin) sees the moderation badge for its own spaces' reports
   only, no push, and no corrections badge.
