### Fixed - a maintenance no longer signs users out

The refresh's maintenance 503 cleared the refresh cookie, so web and Android users met the sign-in page once a maintenance ended; it now leaves the cookie and the session alone. The launch screen shows the operator's maintenance text, a lost answer body reads as no answer rather than a sign-out, and only a refresh answer that is no verdict is retried. Mechanism in [offline and weak network](docs/wiki/frontend/offline-and-weak-network.md#first-paint-never-waits-on-the-network-the-boot-session-question-2026-11-05).
