### Changed - a key-group frame can be stored once, not once per seat (readers now, writer later)

Migration 034 and the readers of a shared key-group payload ship now; the writer stays off behind `QUEUED_PAYLOAD_SHARED_WRITES=false` and is turned on in a later release, so no rollback can land on an image that would serve a shared record as an empty frame ([chat-delivery](docs/wiki/services/chat-delivery.md#a-key-group-frame-is-stored-once-migration-034-2026-10-22)).
