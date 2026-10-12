### Changed - a batch of received messages is merged into a conversation with one sort

It used to re-sort the whole conversation once per message; 200 messages into 5000 went from ~20 ms to 0.1 ms on a desktop ([chat](docs/wiki/frontend/modules/chat.md#a-catch-up-batch-is-merged-with-one-sort-2026-10-12)).
