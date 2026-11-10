### Fixed - Pour toi showed the old Suivis rows (a followed association's post) after the update

The first page of a cold start asked Pour toi as the old `followed` list before `/api/version`
answered, and kept that answer on the device as Pour toi; a ranked list now waits for the estate's
answer. If the check ends with no answer, Pour toi is still asked as `foryou` (an older estate
refuses it, shown as an error, never as other rows); only an estate that says `rankedFeeds: false`
is asked `followed`, and its pages are then kept like any other. A stored copy of the old rows on a
ranked estate is deleted alone, not the other tabs' pages
([legacy-compatibility](docs/wiki/legacy-compatibility.md#no-date-yet---a-feed-client-newer-than-its-server---rankedfeeds-2026-11-10)).
