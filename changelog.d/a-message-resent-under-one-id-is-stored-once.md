### Fixed - a quick reply resent after a lost answer reaches nobody twice

The server stores one message per sender device and `messageId` (migration 048): a native resend
after a late answer is answered with the first copy's time, with no second row, history entry or
push ([chat-delivery](docs/wiki/services/chat-delivery.md#a-message-sent-twice-under-one-id-is-stored-once-migration-048-2026-11-13)).
