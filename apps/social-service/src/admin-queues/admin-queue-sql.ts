/**
 * WHAT "PENDING" MEANS FOR EACH ADMIN QUEUE, AND WHO IS A GLOBAL ADMIN - one SQL fragment each.
 *
 * Three readers share them, so the badge, the bell and the queue page cannot disagree about whether
 * an item still waits: the counts (`AdminQueuesService.pendingCounts`), the bell gates of the two
 * admin notices (`BELL_ROW_GATE` in `posts/bell-row-gates.ts`) and the announcement that writes those
 * notices (`AdminQueuesService.announce`). Each queue page lists exactly what its predicate admits
 * (`ProfileCorrectionService.listPending`, `ModerationService.listAllReports`,
 * `AssociationsService.listPendingCalendarEvents`). docs/wiki/frontend/modules/admin.md, "Pending
 * counts".
 *
 * The tables are read straight out of the shared database, as this service already reads `users`:
 * `profile_correction_requests` (core migration 010) and `alumni_duplicate_flags` (core migration
 * 031, with `alumni_merges`, 028-029) are core-service's, the two others are this service's.
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

/**
 * Alumni duplicate flag `f` (core's `alumni_duplicate_flags`) still waits for an admin: no later
 * reading found it gone or no longer matching (`resolvedAt`), and no merge of it stands - an open one
 * (requested or marked: the admin has answered, MiConnect carries it out at the next sign-in) or a
 * completed one. A CANCELLED merge does not count, so a duplicate whose mark was withdrawn waits
 * again, exactly as the page lists it again. ONE definition: the count, the bell gate and the
 * announcement read it, and `AlumniDuplicateQueue.reconcile` converges the table on what the page
 * lists, so the two cannot disagree for longer than one reading.
 */
export function alumniDuplicatePendingSql(f: string): string {
  return `(${f}."resolvedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM alumni_merges aq_m
      WHERE aq_m."duplicateUuid" = ${f}."duplicateUuid"::text AND aq_m."cancelledAt" IS NULL))`;
}

/** Report row `r` still waits for a moderator: neither reviewed nor dismissed. */
export function reportPendingSql(r: string): string {
  return `${r}.status = 'pending'`;
}

/** Calendar event row `e` still waits for a validator. */
export function calendarEventPendingSql(e: string): string {
  return `${e}.status = 'pending'`;
}

/** Report row `r` names the same SUBJECT as report row `s`: one content type, one content id. */
function sameSubjectSql(r: string, s: string): string {
  return `${r}."contentType" = ${s}."contentType" AND ${r}."contentId" = ${s}."contentId"`;
}

/** Report row `r` was ANNOUNCED: an `admin_report` bell row names it (`AdminQueuesService`). */
function reportAnnouncedSql(r: string): string {
  return `EXISTS (SELECT 1 FROM post_notifications aq_n
      WHERE aq_n.type = 'admin_report' AND aq_n."postId" = ${r}.id::text)`;
}

/**
 * The notice that announced report `report` (a SQL expression naming a report id, a uuid) is still
 * owed to the admins: a report about the same subject waits - the announced one itself, an older one
 * nothing had announced, or a newer one filed before the subject's NEXT announcement. A report filed
 * after a later announcement belongs to that one, so an old notice whose own reports were all handled
 * never comes back when its subject is reported again: each notice answers for its own stretch of
 * reports, read from the reports and the notices themselves. `except` (a uuid expression) is left out
 * of the waiting reports - the report being filed, asking whether a notice already covers it.
 */
export function reportNoticeOwedSql(report: string, except = 'NULL::uuid'): string {
  return `EXISTS (SELECT 1 FROM content_reports aq_rep
      JOIN content_reports aq_open ON ${sameSubjectSql('aq_open', 'aq_rep')}
      WHERE aq_rep.id = ${report} AND ${reportPendingSql('aq_open')}
        AND aq_open.id IS DISTINCT FROM ${except}
        AND NOT EXISTS (SELECT 1 FROM content_reports aq_next
          WHERE ${sameSubjectSql('aq_next', 'aq_rep')}
            AND (aq_next."createdAt", aq_next.id) > (aq_rep."createdAt", aq_rep.id)
            AND (aq_next."createdAt", aq_next.id) <= (aq_open."createdAt", aq_open.id)
            AND ${reportAnnouncedSql('aq_next')}))`;
}

/**
 * Report `$1` (uuid) is already COVERED by a notice still on the admins' bells: another report about
 * its subject was announced and that notice is still owed for a report other than `$1`
 * ({@link reportNoticeOwedSql}). Asked from what was written, never from the age of other reports, so
 * a subject that waited before the notices existed, or whose announcement failed, is announced by its
 * next report. Run under the subject's advisory lock (`AdminQueuesService.announceReport`), so two
 * reports filed at once write one notice. Answers `covered`.
 */
export const REPORT_ALREADY_ANNOUNCED_SQL = `SELECT EXISTS (SELECT 1 FROM content_reports me
    JOIN content_reports ann ON ${sameSubjectSql('ann', 'me')} AND ann.id <> me.id
    WHERE me.id = $1::uuid AND ${reportAnnouncedSql('ann')}
      AND ${reportNoticeOwedSql('ann.id', '$1::uuid')}) AS covered`;

/**
 * The transaction-scoped advisory lock of report `$1`'s subject: announcing a report reads whether
 * its subject is covered and then writes the notice, and two reports on one subject filed at once
 * take this lock in turn, so the second reads the first one's notice. A no-op for an unknown id.
 */
export const LOCK_REPORT_SUBJECT_SQL = `SELECT pg_advisory_xact_lock(
    hashtext('admin_report:' || "contentType" || ':' || "contentId"))
  FROM content_reports WHERE id = $1::uuid`;
