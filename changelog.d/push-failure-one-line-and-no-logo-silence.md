### Fixed - a failed push is one explained WARN, an association with no logo is silent

`PushService` puts the error (and the timeout budget) in its message instead of Nest's context slot, and the "pushes no picture" WARN now fires only for a logo id that is present but refused. The checkout refusal for an unpriced product is logged, and two lines of the 1.7.0 reading stay owned ([entry](docs/wiki/backlog.d/p3-what-the-1-7-0-stable-day-log-read-left-unexplained-or-noisy.md)).
