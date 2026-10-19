### Fixed - a programming `TypeError` inside a request is no longer retried or held as "no answer"

`isTransportFailure` now reads only `TransportFailureError` (and `RequestDeadlineError`); the browser's own `fetch` rejection is typed where it is raised ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#14-a-transport-failure-is-one-type-on-every-platform-2026-10-14)).
