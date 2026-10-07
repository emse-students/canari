### Fixed - an upload the edge refuses with 413 is no longer retried for ever

The outbox now ends the entry after one attempt and tells the author in the thread ([outbox](docs/wiki/frontend/modules/chat.md#a-413-ends-the-entry-2026-10-08)). The 1 MiB edge limit itself is still open in the [backlog](docs/wiki/backlog.md).
