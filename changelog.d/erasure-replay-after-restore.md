### Fixed - a backup restore no longer brings back the accounts erased after the archive

`restore.sh` reads the current erasure journal before it replaces the database and erases those accounts again afterwards, keeping the new account of a person who came back ([account-erasure](docs/wiki/account-erasure.md#a-restore-replays-the-erasures)).
