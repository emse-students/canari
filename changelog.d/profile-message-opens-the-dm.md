### Fixed - a profile's "Message" button opens the conversation with that person

It handed the chat page the person's id as if it were a conversation, so nothing opened; it now opens
the existing conversation, or starts a new one, once the conversations are loaded
([chat](docs/wiki/frontend/modules/chat.md#opening-from-another-page-a-conversation-or-the-dm-with-a-person-fixed-2026-11-11)).
