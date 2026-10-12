### Changed - the message a notification opened the app for no longer waits for every conversation's history

On a cold start, the frame refused before the conversation rows existed is asked for again as soon as they do, and bulk-ingest windows are closed by handle so a drained message is no longer held behind an overlapping history load: drawn ~0.47 s sooner on the Mi 9T ([latency](docs/wiki/frontend/notification-to-conversation-latency.md#f12---the-notified-message-is-asked-for-when-the-rows-exist-not-after-the-history-restore)).
