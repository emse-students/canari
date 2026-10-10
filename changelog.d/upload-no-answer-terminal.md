### Fixed - an attachment the server never answers ends as "failed" with retry and delete, and no longer blocks the messages after it

After three attempts with no answer (a relay refusing early and closing the socket delivers no status) the bubble says so instead of spinning for ever; a blocked or failed attachment no longer holds back later messages ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
