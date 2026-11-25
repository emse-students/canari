### Fixed - the thread's last-visible measure no longer loses the newest row behind a system line

A system row (call, device notice) had no `msg-` id, and the binary search read it as "below", so a DM ending after one reported its newest row out of view (the entry line, the unread pill's anchor). Every row now has one box and the search skips a boxless one and names it ([chat](docs/wiki/frontend/modules/chat.md#reading-the-add_msg-selected-flag-against-chat_view)).
