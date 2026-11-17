## P2 - staff have no view of a broadcaster's standing without a report, so a withdrawal is lifted only from a report row among the 50 newest

target: 1.7.0

_2026-11-17, scope cut: KEPT in `1.7.0` - the lift control is new in `1.7.0`, and a withdrawn broadcaster with no way back is a defect of that new code; the same gap, read on a phone, is [this entry](p2-a-withdrawn-broadcaster-can-be-lifted-only-from-a-pending-live-report.md)._

Found 2026-11-17 while building the lift control
([live](../frontend/modules/live.md#the-moderation-client-wp-l8s-client-half-2026-10-19)). The standing
(cuts on record, suspension, withdrawal) reaches staff only on a `live` report row of
`/admin/moderation` (`ReportedLive.broadcasterStanding`), and the queue lists the 50 newest reports,
pending first (`GET /api/moderation/reports`, default `limit` 50). A broadcaster withdrawn long ago,
whose reports are all handled and pushed past the 50 newest, has no row: the right cannot be
restored from the app, though `DELETE /api/lives/broadcasters/:userId/withdrawal` exists. The
caller's own `GET /api/lives/standing` is not for staff.

**The fix, about 1-2 days:** a staff read of one account's standing
(`GET /api/lives/broadcasters/:userId/standing`, the same `assertStaff` and
`assertModeratesBroadcaster` as the withdrawal, `standingOf` already exists), and a list of the
withdrawn broadcasters in `/admin/moderation` (the `live_broadcast_withdrawals` rows the caller may
act on), each with the lift control `ModerationLiveBlock` already carries. Tests: the route's
predicate in `lives.controller` specs, the list and its lift in a component test. Charter: principle
6 (kindness) - a sanction must be reversible by the people who gave it.
