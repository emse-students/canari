### Fixed - a live viewer whose app was suspended mid-request retries instead of stopping on "Live indisponible"

The lives client now reads every response body through `readApiJson`, so a body lost after the head is a transport failure the viewer retries, not WebKit's bare `TypeError: Load failed` ([read on the iPhone](docs/wiki/device-verification.md#the-phone-readings-of-2026-11-19-s10-171-alpha3), [offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
