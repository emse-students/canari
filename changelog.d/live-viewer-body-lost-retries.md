### Fixed - a live viewer whose app was suspended mid-request retries instead of stopping on "Live indisponible"

The lives client now reads every response body through `readApiJson`, so a body lost after the head is a transport failure the viewer retries, not WebKit's bare `TypeError: Load failed` ([entry](docs/wiki/backlog.d/reading-owed-a-live-viewer-suspended-mid-request-retries.md), [offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
