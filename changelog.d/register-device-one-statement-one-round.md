### Fixed - two registrations of one device in the same millisecond no longer answer 500

The server writes a device's key package row in one `INSERT ... ON CONFLICT DO UPDATE` instead of a read then an insert, and the client runs one key package round at a time, so a second caller joins the round in flight. See [chat-delivery](docs/wiki/services/chat-delivery.md#a-registration-writes-its-row-in-one-statement-and-the-client-sends-one-2026-11-07).
