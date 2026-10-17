-- Migration 012: the durable queue, and journal, of account erasures.
--
-- Decision of 2026-10-16: deleting an account is COMPLETE and GUARANTEED, not best effort. Core used
-- to call chat-delivery, social and media once each with `.catch(warn)` and delete the user row
-- regardless, so a service that was down at that moment orphaned the account's data for ever with
-- no retry. Now the request writes ONE ROW PER SERVICE here (core's own data included), in the same transaction that deletes
-- the user row, and `AccountErasureService` retries each call with backoff until it answers 2xx
-- (docs/wiki/account-erasure.md).
--
-- A pending row holds the account id in "subjectId" (the OIDC subject - authentik's opaque
-- hashed_user_id), because the call is made with it and a sign-in is REFUSED while a row is pending:
-- `users.id` IS that subject, so signing in again before the erasure finished would recreate the
-- account under the same id and the next attempt would erase the new account's data. A completed
-- row keeps only `sha256:<digest>` and its timestamps. No name, no profile, nothing nominative.
--
-- ONE PENDING ROW PER (subject, service), enforced by the partial unique index: a second request
-- (an old token replaying DELETE /users/me) adds nothing, while a person who comes back, has a new
-- account, and deletes it again gets new rows beside the completed ones.
--
-- No foreign key: the user row is deleted in the transaction that writes these.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

CREATE TABLE IF NOT EXISTS account_erasure_jobs (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "subjectId"           VARCHAR(255) NOT NULL,
    service               VARCHAR(32) NOT NULL,
    "requestedAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "credentialsExpireAt" TIMESTAMPTZ NOT NULL,
    attempts              INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "lastAttemptAt"       TIMESTAMPTZ,
    "lastError"           VARCHAR(500),
    -- How many CONSECUTIVE attempts ended in this same `lastError`: reset by a different error or a
    -- success. The core pass is local, so five in a row is a defect rather than a blip.
    "sameFailureRun"      INTEGER NOT NULL DEFAULT 0,
    -- 'transient' or 'permanent' (`classifyFailure`): a permanent failure is accused at once and
    -- turns the sign-in refusal into "contact us". Cleared by a success.
    "lastFailureKind"     VARCHAR(16),
    "completedAt"         TIMESTAMPTZ,
    -- NULL for a job the worker completed. Set ONLY by an operator who closed a stuck job by hand
    -- (the statements are in docs/wiki/account-erasure.md): what was done and why, never who the
    -- subject was.
    resolution            VARCHAR(500)
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_account_erasure_pending"
    ON account_erasure_jobs ("subjectId", service) WHERE "completedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "IDX_account_erasure_due"
    ON account_erasure_jobs ("nextAttemptAt") WHERE "completedAt" IS NULL;
