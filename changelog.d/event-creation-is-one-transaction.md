### Fixed - creating an event with co-organisers is atomic

The event was saved before its partners' proposals, so a failing proposal left an event with no proposals behind a 500, and the retry created it twice. Creation is now one transaction, announced after the commit ([profiles-and-access](docs/wiki/profiles-and-access.md#e2-partner-rights-on-a-co-organised-event-wp-q1-2026-11-03)).
