### Fixed - editing a message puts the caret at the end, and an incoming message no longer closes the edit

The edit reset keyed on the conversation object instead of its id, so every arrival dropped the banner ([chat](docs/wiki/frontend/modules/chat.md#editing-a-message-happens-in-the-composer-not-in-the-bubble-2026-10-02)).
