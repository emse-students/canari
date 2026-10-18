### Fixed - a new client against an older server no longer reports every absent profile as a breach

An answer from `GET /api/users/batch` with no `deleted` field is read the old way (absence = 404, cached, quiet), a dated shim ([legacy-compatibility](docs/wiki/legacy-compatibility.md#no-date-yet---the-profile-batch-answered-without-deleted-by-a-server-older-than-2026-10-18)).
