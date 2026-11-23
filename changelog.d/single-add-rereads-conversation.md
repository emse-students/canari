### Fixed - a message shown while another arrival awaited the store is no longer erased from the screen

An arriving message rendered onto the copy of its conversation read before its store read, so a
message sent or received in that gap vanished from memory until the next load. It now renders onto
the row as it stands
([chat](docs/wiki/frontend/modules/chat.md#adds-to-one-conversation-are-not-serialized-so-an-add-renders-onto-the-row-as-it-is-now-2026-11-23)).
