-- Migration 006: the admin announcement, shown once per ACCOUNT.
--
-- Asked for by the user on 2026-08-18: a message published from /admin/platform that people see the
-- next time they open the app, on whichever device gets there first, and never again anywhere.
--
-- WHY THE "SEEN" STATE IS A TABLE AND NOT A FLAG ON THE CLIENT: local state is wiped by a
-- reinstall, and an announcement that reappears after one is worse than none. Keyed by
-- (announcement, user) - one row answering exactly one question, "has this account seen this
-- announcement". Not "is the account current", not "has it been notified": two questions that
-- differ only in lifetime sharing one row is how a durable-state trigger gets silenced.
--
-- WHY BOTH LANGUAGES ARE COLUMNS: the server is the only layer that does not know the reader's
-- language, so it stores both and sends both, and the client picks with the locale chosen inside
-- Canari. A `locale` column here would be the same mistake the server-composed notification bodies
-- already carry.
--
-- ONE ACTIVE ANNOUNCEMENT AT A TIME, and the partial unique index below is what makes that true
-- rather than the service code that happens to write it. Two active rows would make "the
-- announcement" ambiguous for every reader at once, and the publish path retires the old row and
-- inserts the new one in ONE transaction precisely so this index has nothing to reject.
--
-- The version range is a FILTER and never a gate: a client outside it is not told an announcement
-- exists and refused, it simply has none. NULL on either bound means no bound on that side.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout (synchronize builds these in dev; this is prod).

CREATE TABLE IF NOT EXISTS platform_announcements (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title_fr             TEXT NOT NULL,
    title_en             TEXT NOT NULL,
    body_fr              TEXT NOT NULL,
    body_en              TEXT NOT NULL,
    min_client_version   VARCHAR(32),
    max_client_version   VARCHAR(32),
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_by           UUID NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active row, enforced by the database rather than by whoever writes next.
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_platform_announcements_one_active"
    ON platform_announcements (active) WHERE active;

CREATE TABLE IF NOT EXISTS platform_announcement_seen (
    announcement_id  UUID NOT NULL,
    user_id          UUID NOT NULL,
    seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (announcement_id, user_id)
);

-- The one question asked on every app opening: "has this account seen the active one".
-- The primary key already serves it; this index serves the admin panel's reach count instead.
CREATE INDEX IF NOT EXISTS "IDX_platform_announcement_seen_announcement"
    ON platform_announcement_seen (announcement_id);

-- Cascade so retiring is a decision and deleting is complete: an announcement removed by hand does
-- not leave its readership behind. Both columns are uuid here, so unlike the chat-delivery tables
-- this constraint is available and is the right tool.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FK_platform_announcement_seen_announcement'
  ) THEN
    ALTER TABLE platform_announcement_seen
      ADD CONSTRAINT "FK_platform_announcement_seen_announcement"
      FOREIGN KEY (announcement_id) REFERENCES platform_announcements (id) ON DELETE CASCADE;
  END IF;
END $$;
