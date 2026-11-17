## P2 - A withdrawn broadcaster can be given the right back only from a PENDING live report

target: 1.7.0

_2026-11-17, scope cut: KEPT in `1.7.0` - the lift control and its toasts are new in `1.7.0` (a regression of that version); one fix with [the staff view of a standing](p2-no-staff-view-of-a-broadcaster-s-standing-without-a-report.md)._

Read on dev, `1.7.0-alpha.8`, 2026-11-17 ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)). The lift control ("Rétablir le droit",
`ModerationLiveBlock`) renders only inside a pending report row whose content is a live
(`/admin/moderation`, `pendingReports`); resolved rows are drawn as one line with no block. A
withdrawn broadcaster cannot start a live, and a report on a cut live is refused (`POST
/api/moderation/reports` answers `404 LIVE_NOT_FOUND`), so once the reports naming them are marked
reviewed or dismissed no screen offers the lift; the sitting had to insert a pending report on dev to
reach it. The withdrawal is a standing of the member, not of a report: the lift needs a place that
does not depend on a report's status (the member's row in "Muted users", or the resolved row).

Seen on the same screen: the three success toasts of the live block (cut, withdrawal, lift; e.g.
"The right to broadcast was restored.") are drawn as ERROR toasts, because `showToast` defaults its
type to `'error'` and `handleLiveCut` / `handleLiveWithdrawn` / `handleLiveLifted` pass none.
