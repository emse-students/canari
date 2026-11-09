-- Migration 145: a form is a DRAFT until a manager publishes it, and a paid form chooses whether it
-- takes online payment (owner, 2026-11-08).
--
-- docs/wiki/frontend/modules/forms.md, "A form is a draft until it is published". A draft is built
-- and saved by its managers - a paid one included, before its association's Lydia is ready - and is
-- invisible to every respondent read (`respondentFormWhere`, `form-status.ts`) until "Publier".
--
-- `forms.status` varchar(16) NOT NULL DEFAULT 'published', CHECK draft | published.
--
-- EVERY EXISTING FORM IS PUBLISHED: the default fills them, so nothing changes for a form, an answer
-- or a link already handed out. The default also keeps the overlap deploy and a rollback safe: an
-- older container names no status in its INSERT (TypeORM writes DEFAULT) and creates a published
-- form, exactly as before. Only a client that asks for a draft (`draft: true` on create) gets one.
--
-- ADDITIVE: two columns with a constant default (a catalogue change since PostgreSQL 11, no rewrite)
-- and one CHECK. The CHECK is added NOT VALID then validated, so the scan that proves the existing
-- rows takes only a SHARE UPDATE EXCLUSIVE lock. Idempotent for CD: IF NOT EXISTS, and the
-- constraint is added only when absent.
-- LOCKS: ACCESS EXCLUSIVE on `forms` for the catalogue changes; the migration gives up after 5 s
-- rather than queue behind a long transaction (the re-run is safe).

SET lock_timeout = '5s';

ALTER TABLE forms ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'published';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forms_status_check') THEN
    ALTER TABLE forms ADD CONSTRAINT forms_status_check
      CHECK (status IN ('draft', 'published')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE forms VALIDATE CONSTRAINT forms_status_check;

-- `forms."allowOnlinePayment"` boolean NOT NULL DEFAULT true (same owner decision): a paid form may
-- take online payment, cash, or both - online was the only way before, so every existing form takes
-- it, and an older container writing DEFAULT keeps that. A constant default: no rewrite.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "allowOnlinePayment" boolean NOT NULL DEFAULT true;
