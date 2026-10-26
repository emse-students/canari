### Fixed - a platform config, moderation, report or role history write updates columns, never saves the row it read

Two administrators editing different platform settings keep both; a tag grant and a mute are one `INSERT ... ON CONFLICT`; a report review and a role history edit update their own columns, `404`/`409` on a row gone or changed ([social-service](docs/wiki/services/social-service.md#a-member-write-updates-columns-never-saves-the-row-it-read-2026-10-25)).
