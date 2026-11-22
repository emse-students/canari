-- canari:hold-for-owner - a BACKFILL of user data: every stored anonymous answer's dates are cut to their week.
-- Migration 181: an anonymous form's answer keeps only its WEEK, never its day (owner, 2026-11-22,
-- charter principle 1, docs/wiki/backlog.d/owner-decisions-of-2026-11-22.md).
--
-- docs/wiki/frontend/modules/forms.md, "An anonymous form keeps no author". Until this file the
-- release of a batch dated its answers with the UTC DAY it ran (`anonymous-answer-batches.ts`, #3952),
-- and the rows stored before it were cut to their day by a one-off repair. A day on which a single
-- person answered is a group of one: the manager reads that day beside the answer and can guess who
-- gave it. The release now writes the start of the ISO week (`anonymousAnswerWeekSql`:
-- `date_trunc('week', ...)`, Monday 00:00 on the UTC wall clock the `timestamp` columns hold); this
-- file cuts the answers already stored the same way.
--
-- WHAT IT TOUCHES: `submissions` rows of a form whose `anonymous` is true, and only the three dates
-- a release writes - `createdAt`, `updatedAt`, `paymentRequestedAt` - each cut to its own week. Every
-- other column of `submissions` that holds a time is NULL on an anonymous answer
-- (`SUBMISSION_COLUMNS_A_RELEASE_LEAVES_UNSET`). `form_answers_held` keeps no time at all. A named
-- form's answers are not read.
--
-- ONE STATEMENT, so every row it rewrites carries the same `xmin`: the rewrite itself pairs no answer
-- with another, nor with any registry row. No row is inserted again, deleted or given a new id.
--
-- Idempotent for CD: a row already at the start of its week is not written, so a second run writes
-- nothing (`IS DISTINCT FROM`, which a NULL cannot slip past). LOCKS: row locks on the rewritten
-- answers, released at COMMIT; a release of the same form waits for it, and the file gives up after
-- 5 s rather than queue (the re-run is safe).
--
-- ROLLBACK: none, by design - the day and the time are what this file exists to forget. An image
-- older than it reads a week start as an ordinary date, but dates the batches it releases with their
-- day again; once the newer image is back, those rows are cut by running the UPDATE below by hand
-- (it is idempotent, and touches nothing already cut).

SET lock_timeout = '5s';

UPDATE submissions s
   SET "createdAt" = date_trunc('week', s."createdAt"),
       "updatedAt" = date_trunc('week', s."updatedAt"),
       "paymentRequestedAt" = date_trunc('week', s."paymentRequestedAt")
  FROM forms f
 WHERE f.id = s."formId"
   AND f.anonymous
   AND (s."createdAt" IS DISTINCT FROM date_trunc('week', s."createdAt")
     OR s."updatedAt" IS DISTINCT FROM date_trunc('week', s."updatedAt")
     OR s."paymentRequestedAt" IS DISTINCT FROM date_trunc('week', s."paymentRequestedAt"));
