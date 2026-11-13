### Changed - the session's server-event callbacks are declared once

`ChatSessionCallbacks` picks twelve callbacks from `MessageHandlerDeps` instead of repeating them (about 60 duplicated lines, two typed `any`), with a compile-time test pinning the equality ([architecture](docs/wiki/frontend/architecture.md)).
