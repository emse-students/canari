## The admin queue badges and notices, owed on both phones (a reading for 1.7.1; owner, 2026-11-18)

target: 1.7.1

Built: a count of pending items on the Administration row of the dashboard, on the dashboard place of
the bottom bar and the sidebar, and on each admin queue's row (profile corrections, moderation
reports, agenda), from `GET /api/moderation/admin-queues`; and a bell row plus a push to every global
admin when a profile correction is filed or a subject no notice still covers is reported, cleared for
every admin once one handles it
([admin](../frontend/modules/admin.md#pending-counts-and-the-admin-notices-owner-2026-11-18)).

The reading that closes it, on a `1.7.1` pre-release, the Mi 9T and the iPhone 12 each signed in as a
global admin of dev, a test account filing the items:

1. A test account files a profile correction: the admin phone rings a push reading "Demande de
   correction de profil" (no name), its tap opens `/admin/profile-corrections`; the bell shows the
   row; the dashboard tab, the dashboard's Administration row and the queue's row show `1`.
2. The other admin phone applies (or refuses) it: on the first phone, left open on the dashboard, the
   badges drop within a few seconds with no action on that phone (the `admin.queues.changed` frame,
   no timer); the bell row is gone at its next load. Then background the first phone, file and
   answer another correction from the second, and bring the first back: its badges are right on
   return. On a computer, with two tabs of the web app open, the badges move in BOTH tabs.
3. A test account reports a post twice from two accounts: ONE push and ONE bell row; dismissing both
   reports clears them.
4. A test account reports a post in a BDE moderator's space while that moderator's phone is open:
   its moderation badge rises without a reload; a report outside its spaces moves nothing on it.
5. A BDE moderator account (no global admin) sees the moderation badge for its own spaces' reports
   only, no push, and no corrections badge.
