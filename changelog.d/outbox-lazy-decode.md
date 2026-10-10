### Fixed - a queued attachment is decoded only when it is sent, and no longer retries for ever

Reading the queue no longer decrypts the file of an attachment that is not due, an attachment that keeps failing on this device is parked with a message and a retry button, the retry button works on a 403-parked message, and a busy phone no longer shows the "slow connection" banner ([wiki](docs/wiki/frontend/offline-and-weak-network.md#136-a-queued-attachment-is-decoded-when-it-is-sent-never-when-the-queue-is-read-and-no-retry-loop-is-endless-2026-10-10)).
