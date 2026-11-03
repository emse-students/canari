### Fixed - creating an event with co-organisers is atomic

The event was saved before its partners' proposals, so a failing proposal left an event with no proposals behind a 500, and the retry created it twice. Creation is now one transaction (form detach, insert, proposals), announced after the commit ([profiles-and-access](docs/wiki/profiles-and-access.md#e2-partner-rights-on-a-co-organised-event-wp-q1-2026-11-03)).

The validators' notice now never rejects (a failure is logged at WARN with its stack), the manager-less `sync` branch is gone, and the new test awaits the notice it starts.
