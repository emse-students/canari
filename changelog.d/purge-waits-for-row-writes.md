### Fixed - a conversation removed while a message batch was being written no longer gets its rows back

The removal cleared the store before taking the conversation out of the map, so a write that had
already asked the map inserted after the clear. A removal now leaves the map first and waits for the
writes in flight before clearing the store. A message sent into a conversation removed meanwhile is
refused and the member told, rather than queued, and a queued message whose conversation is gone is
retired instead of asking for a re-add on every start
([chat](docs/wiki/frontend/modules/chat.md#adds-to-one-conversation-are-not-serialized-so-an-add-renders-onto-the-row-as-it-is-now-2026-11-23)).
