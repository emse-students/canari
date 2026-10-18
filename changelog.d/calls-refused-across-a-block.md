### Added - a call is refused across a block

`POST /api/calls/initiate`, `POST /api/calls/ring` and `GET /api/calls/room-token` answer `403 USER_BLOCKED` when a block stands between the two people, so nothing rings. The app shows a neutral "cannot be placed" message ([moderation-and-blocking](docs/wiki/moderation-and-blocking.md#what-a-block-does-exhaustively)).
