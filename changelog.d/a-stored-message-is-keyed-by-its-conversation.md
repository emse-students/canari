### Fixed - a stored message is keyed by its conversation

The device's message store now keys every row by its conversation and its id, on SQLite and in the browser, so two conversations holding the same message id each keep their own row; existing stores are migrated in place, every row kept ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-stored-message-is-keyed-by-its-conversation-review-of-2936-the-key-itself-2026-11-24)).
