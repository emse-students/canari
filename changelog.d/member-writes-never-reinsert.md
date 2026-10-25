### Fixed - a member write updates its columns and never re-inserts the row it read

Notification levels, role changes, an erasure's successor promotion and association role changes
write one column-scoped `UPDATE`; 0 rows means the membership is gone and the call is refused
([social-service](docs/wiki/services/social-service.md#a-member-write-updates-columns-never-saves-the-row-it-read-2026-10-25)).
