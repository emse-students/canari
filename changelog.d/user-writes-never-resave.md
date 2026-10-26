### Fixed - a user write updates its columns and never saves the row it read

The notepad, the notepad key, the profile, the admin flag, the sign-in's claims, an admin profile
edit, a tag renewal and an unmute write one column-scoped `UPDATE`; 0 rows means the row is gone and
the call is refused. Removing the admin flag ends the person's sessions, nobody writes their own
flag, and an administrator's user creation never overwrites an existing account
([core-service](docs/wiki/services/core-service.md#a-user-write-updates-columns-never-saves-the-row-it-read-2026-10-25)).
