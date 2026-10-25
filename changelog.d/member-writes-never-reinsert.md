### Fixed - a write to a row read earlier updates its columns and never re-inserts or reverts it

Notification levels, role changes (now conditioned on what was judged, `409 MEMBER_CHANGED_MEANWHILE`),
an erasure's successor promotion, association role changes and two community settings write one
column-scoped `UPDATE`; 0 rows refuses the call
([social-service](docs/wiki/services/social-service.md#a-member-write-updates-columns-never-saves-the-row-it-read-2026-10-25)).
