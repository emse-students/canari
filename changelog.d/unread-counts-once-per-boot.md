### Fixed - a cold start asks for the unread counts once

The community load and the live-stream reconnect shared no request, so `unread-counts` went out twice; a caller that owes no read mark now joins the one in flight, and a test counts the requests of a recorded boot ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#19-wp-w4-second-part-unread-counts-is-one-request-per-boot-ordered-after-the-read-mark-flush-2026-10-19)).
