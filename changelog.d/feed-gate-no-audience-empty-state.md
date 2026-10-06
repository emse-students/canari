### Fixed - a reader with no space and no association sees an empty state on the posts page, not "Impossible de charger les posts"

The feed guard answers such a reader 403; the page rendered every rejection as the generic error. A 403 is now classified by status as "outside the audience" (dedicated empty state, remembered verdict corrected); other failures keep the generic error. See [profiles-and-access](docs/wiki/profiles-and-access.md#feed_gate---a-403-is-a-verdict-not-a-failure-2026-10-06).
