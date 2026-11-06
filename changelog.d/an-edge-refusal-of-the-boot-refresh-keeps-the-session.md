### Fixed - a failing edge, server or portal no longer shows the sign-in page at launch

When the first token refresh of a launch got a 5xx, a 408/429, an edge's HTML 403 or a captive portal's `200 text/html` instead of the app's answer, the app showed the sign-in page; it now keeps the session and says who failed - this network, the server, or a maintenance - and retries. Only the app's own 401/403 signs a user out. Mechanism in [offline and weak network](docs/wiki/frontend/offline-and-weak-network.md#first-paint-never-waits-on-the-network-the-boot-session-question-2026-11-05).
