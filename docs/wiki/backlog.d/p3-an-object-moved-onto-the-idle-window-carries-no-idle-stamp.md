## P3 - an object moved onto the idle window after upload carries no stamp, so the idle-file setting never governs it

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20 ([reading](../device-verification.md#the-production-reading-of-2026-11-20-the-171-stable-deploy)): the index still holds exactly the seven unstamped `ephemeral` entries created since the `1.7.0` deploy, 27 stamped conversation files beside them, and none created since the `1.7.1` deploy. Nothing new to decide; the replanning to the new version is the plan's whole re-read._

Since 2026-11-14 an `ephemeral` file is stamped at its UPLOAD with the idle window in force
(`idleRetentionMs`, from `retention_idle_file_days`), and an entry with no stamp is meant to be a file
uploaded BEFORE the setting existed, which keeps the constant `RETENTION_MS` (90 days) - the comment
beside the constant in `media.service.ts` and [retention-settings](../retention-settings.md) both say so.

**Production says otherwise.** In the first 45 minutes after the `1.7.0` deploy (2026-11-18) the media
index gained 7 `ephemeral` entries and every one is unstamped: they were uploaded as `archive` (feed
post media, through an upload session) and moved to `ephemeral` a minute later by
`POST /api/media/internal/retention-class` (`Retention class ephemeral applied to 7 object(s)`), the call
social-service makes when a post stops citing its media (`PostMediaRetentionService.release`, and the
same call in `moderation.service.ts`). That route changes the class and leaves the stamp absent, so
these objects sit on the hard-coded 90 days whatever an admin sets, and "no stamp = uploaded before the
setting" is no longer true of the population.

**What deciding it takes:** state whether a released post's media is a "file sent in a conversation"
for the setting (the admin page's wording) - if yes, the route stamps the window in force when it moves
an object INTO `ephemeral`; if no, the setting's description and the constant's comment say that
released media keep the constant, and the inventory row in retention-settings names it. Either way one
fact decides it, not the absence of a field. Reading of the day:
[device-verification](../device-verification.md#the-production-reading-of-2026-11-18-the-170-stable-deploy).
