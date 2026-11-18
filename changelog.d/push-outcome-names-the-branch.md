### Fixed - a phone with no push registration names the branch and the await it stopped at

`register-device` now states `unauthorized:<cause>`, `in-progress:<stage>` or `started:<stage>`, and the daily `[PUSH_COVERAGE]` warning tallies them per build, so the 1.6.12 phones that sent no registration can be explained from the report ([chat-delivery](docs/wiki/services/chat-delivery.md#the-servers-row-decides-whether-a-registration-is-owed-2026-11-15)).
