### Fixed - the lives integration specs no longer fail once in a while

A live's announcement runs in the background, so its `[LIVE_ANNOUNCE]` warning could land in the NEXT test: two specs only passed because of that leak. Each reading now awaits `announcementsSettled()` and says the true count; the service itself was not racy. Same mechanism as the log guard of [testing-methodology](docs/wiki/testing-methodology.md).
