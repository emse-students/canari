## P2 - the retention durations a sweep applies are not yet admin settings

target: 1.7.0

The owner decided on 2026-11-14 that every retention duration becomes a platform admin setting, the
privacy policy rendering the values in force, a lowered duration applying to new content only. Four
are built ([retention-settings](../retention-settings.md)): feed CanaReels, live replays, CanaReels
sent in a conversation, and files sent in a conversation - each STAMPED on the item at creation.

What is left is every duration a SWEEP applies ("now minus N", read at each run): salon messages
(365 d) and their traces (30 d), in-app notifications (90 d), handled reports (90 d), queued MLS
messages and the group history stream (90 d), push tokens (90 d), the MLS commit log (365 d), and the
rest of the inventory on [retention-settings](../retention-settings.md#every-retention-duration-in-the-code-inventory-of-2026-11-14).
A setting read by such a sweep would apply a lowered value to everything already stored, so each
needs its expiry stamped at creation first (a column per table, or a field per entry), then a column
in `platform_config`, a row in the admin section and its rendering in the privacy policy.

Proposed to stay constants, for the owner to confirm: the TTLs of seconds to hours (presence, call
state, upload sessions, pending uploads, restore challenges), the per-form and per-space durations
already chosen by their organiser (form files, booking answers), and the backups (an infrastructure
script, not a service).
