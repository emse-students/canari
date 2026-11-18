/**
 * WHAT "PENDING" MEANS FOR EACH ADMIN QUEUE, AND WHO IS A GLOBAL ADMIN - one SQL fragment each.
 *
 * Three readers share them, so the badge, the bell and the queue page cannot disagree about whether
 * an item still waits: the counts (`AdminQueuesService.pendingCounts`), the bell gates of the two
 * admin notices (`BELL_ROW_GATE` in `posts/bell-row-gates.ts`) and the announcement that writes those
 * notices (`announceToGlobalAdmins`). Each queue page lists exactly what its predicate admits
 * (`ProfileCorrectionService.listPending`, `ModerationService.listAllReports`,
 * `AssociationsService.listPendingCalendarEvents`). docs/wiki/frontend/modules/admin.md, "Pending
 * counts".
 *
 * The tables are read straight out of the shared database, as this service already reads `users`:
 * `profile_correction_requests` is core-service's (its migration 010), the two others are this
 * service's.
 */

/**
 * Account `user` (a SQL expression) is a platform administrator NOW - `users.admin`, the column the
 * access token's `admin` claim is read from. A scalar on the primary key, never an `EXISTS` (the
 * reason `holdsFlagSql` in `bell-row-gates.ts` gives).
 */
export function isGlobalAdminSql(user: string): string {
  return `COALESCE((SELECT bool_or(aq_admin.admin) FROM users aq_admin WHERE aq_admin.id = ${user}), false)`;
}

/** Profile correction request row `r` still waits for an admin: `pending` (an `applying` claim is in hand). */
export function profileCorrectionPendingSql(r: string): string {
  return `${r}.status = 'pending'`;
}

/** Report row `r` still waits for a moderator: neither reviewed nor dismissed. */
export function reportPendingSql(r: string): string {
  return `${r}.status = 'pending'`;
}

/** Calendar event row `e` still waits for a validator. */
export function calendarEventPendingSql(e: string): string {
  return `${e}.status = 'pending'`;
}

/**
 * Report `report` (a SQL expression naming a report id, a uuid) is about a SUBJECT on which a report
 * is still pending - itself or another one about the same content. What the bell row announcing
 * the subject is shown under: the subject leaves the admins' attention when its LAST pending report
 * is handled, and a second report on a subject already announced writes no second notice
 * (`ModerationService.announceIfFirstPending`).
 */
export function reportSubjectPendingSql(report: string): string {
  return `EXISTS (SELECT 1 FROM content_reports aq_rep
      JOIN content_reports aq_open ON aq_open."contentType" = aq_rep."contentType"
        AND aq_open."contentId" = aq_rep."contentId"
      WHERE aq_rep.id = ${report} AND ${reportPendingSql('aq_open')})`;
}

/**
 * Report `$1` (uuid) is the OLDEST pending report about its subject - the one that announces the
 * subject. Of two reports filed at once on a quiet subject exactly one is the oldest, whatever the
 * order their transactions commit in, so the subject is announced once and never zero times; a
 * subject that already had a pending report is not announced again. Answers `first`.
 */
export const REPORT_IS_FIRST_PENDING_SQL = `SELECT NOT EXISTS (SELECT 1 FROM content_reports me
    JOIN content_reports older ON older."contentType" = me."contentType"
      AND older."contentId" = me."contentId" AND older.id <> me.id
      AND ${reportPendingSql('older')}
      AND (older."createdAt", older.id) < (me."createdAt", me.id)
    WHERE me.id = $1) AS first`;
