### Changed - the message a notification opened the app for no longer waits for every conversation's history

On a cold start, a frame refused for lack of a conversation row is asked for again as soon as the rows exist, instead of after the whole history restore; the restore now merges into a row a live delivery wrote meanwhile rather than replacing it ([latency](docs/wiki/frontend/notification-to-conversation-latency.md#f12---the-notified-message-is-asked-for-when-the-rows-exist-not-after-the-history-restore)).
