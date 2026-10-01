### Added - one log line per avatar request, at both hops of a notification photo

`[PUSH_AVATAR]` (chat-delivery) and `[AVATAR]` (core-service) now log the outcome, status, duration and a truncated target id of every avatar fetch, so a notification that drew initials once is findable ([chat-delivery](docs/wiki/services/chat-delivery.md#the-push-avatar-log-line)).
