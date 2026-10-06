### Fixed - the conversation list is ordered by one key, the newest message's sent time, identical on every device

The order read a stored seed that history replay, channel loads and pending drains never advanced, and that two paths wrote from the local clock. It is now derived from the messages themselves, ties broken by id. See [chat](docs/wiki/frontend/modules/chat.md#the-conversation-list-has-one-ordering-key-2026-10-06).
