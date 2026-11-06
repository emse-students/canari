### Fixed - a failing edge no longer shows the sign-in page at launch

When the first token refresh of a launch got a 5xx or a Cloudflare/nginx HTML 403 instead of the app's answer, the app showed the sign-in page; it now says it cannot reach Canari and retries like any network failure. Only the app's own 401/403 signs a user out. Mechanism in [offline and weak network](docs/wiki/frontend/offline-and-weak-network.md#first-paint-never-waits-on-the-network-the-boot-session-question-2026-11-05).
