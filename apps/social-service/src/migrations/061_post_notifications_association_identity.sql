-- A notification for an association's post carried only `actorName` (the association's display
-- name, resolved at send time) - never an id or a logo, because `actorId` on this row is
-- deliberately the PUBLISHING MEMBER, not the association (`createNotifications` excludes the
-- actor from its own recipients, and that exclusion needs the member who pressed publish, not
-- the association they spoke for). `NotificationRow.svelte` had nothing to branch on, so it always
-- rendered a *user* avatar keyed on `actorId` - the poster's own photo, not the association's logo.
--
-- Denormalized here rather than joined at read time, same tradeoff already accepted for
-- `actorName`: a later change to the association's logo does not retroactively rewrite an old
-- notification's picture, which is consistent rather than a new exception.
ALTER TABLE post_notifications ADD COLUMN IF NOT EXISTS "associationId" uuid NULL;
ALTER TABLE post_notifications ADD COLUMN IF NOT EXISTS "associationLogoUrl" text NULL;
