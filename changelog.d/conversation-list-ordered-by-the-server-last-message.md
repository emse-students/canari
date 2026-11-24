### Fixed - a new device orders its conversations before their history arrives

The server now keeps the receive time of each conversation's newest visible message (migration 057,
no content, said to the admitted members only), and the list uses it as a floor until the restored
history reaches it. A conversation already quiet when this ships keeps its old place until its next
visible message ([chat](docs/wiki/frontend/modules/chat.md#the-conversation-list-has-one-ordering-key-2026-10-06)).
