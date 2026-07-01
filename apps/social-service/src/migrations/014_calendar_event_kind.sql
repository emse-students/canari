-- Adds the visual `kind` to association calendar events: `event` (a card) or `break` (a full-day
-- background band for no-course / vacation / holiday periods). Defaults to `event`.
-- With synchronize=true (non-production) TypeORM also adds this column; this migration covers
-- production where synchronize is disabled.

ALTER TABLE association_calendar_events
  ADD COLUMN IF NOT EXISTS "kind" varchar(16) NOT NULL DEFAULT 'event';
