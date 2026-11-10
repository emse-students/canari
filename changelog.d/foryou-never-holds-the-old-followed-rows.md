### Fixed - Pour toi showed the old Suivis rows (a followed association's post) after the update

The first page of a cold start asked Pour toi as the old `followed` list before `/api/version`
answered, and kept that answer on the device as Pour toi; a ranked list now waits for the estate's
answer, and a list never stores another list's rows
([legacy-compatibility](docs/wiki/legacy-compatibility.md#no-date-yet---a-feed-client-newer-than-its-server---rankedfeeds-2026-11-10)).
