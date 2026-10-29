### Fixed - every seat writer reads the key package under the seat lock, and an erasure's retry removes every unseated route

A group creator's enrolment now goes through the one pending-seat writer, an external join whose seat cannot be written is refused whole, and an account erasure removes, under each group's seat lock, only the routes no active seat stands behind ([channel-encryption](docs/wiki/protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).

Two callers who both read a new group's roster empty can no longer both enrol as its creator: the empty roster is re-read under the seat lock, and the second gets `409 MEMBER_NOT_ADMITTED` ([chat-delivery](docs/wiki/services/chat-delivery.md)). The erasure route's user-id check no longer caps the length the mint rule does not.
