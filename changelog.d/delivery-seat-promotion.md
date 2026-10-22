### Changed - chat-delivery: reporting a device `active` promotes an existing seat only

`POST /mls/invitations/status` with `active` now needs the device's own membership row in that group
and, in a conversation, its owner on the roster; otherwise it is refused as `NOT_A_MEMBER` and
logged. Every legitimate report follows the commit or Welcome that wrote that row.
