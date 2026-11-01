### Fixed - a local copy of production no longer stops on an unclassified variable

`env-from-prod.sh` refuses any production variable it does not classify, and `QUEUED_PAYLOAD_SHARED_WRITES` (rendered on both estates since migration 034) was in no list; it is kept as production has it ([chat-delivery](docs/wiki/services/chat-delivery.md#a-key-group-frame-is-stored-once-migration-034-2026-10-22)).
