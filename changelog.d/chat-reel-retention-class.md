### Added - media-service `chat-reel`: a reel sent in a conversation is deleted 30 days after upload

Swept by age (never by idleness), answered `410` afterwards, capped at 500 MB per member per day (`429`), and deletable by its sender only (`DELETE /api/media/chat-reel/:id`). Nothing sends the class yet. See [media-service](docs/wiki/services/media-service.md#the-chat-reel-class-a-reel-sent-in-a-conversation-rc-2-2026-10-09).
