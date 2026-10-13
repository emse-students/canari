### Changed - one roster read per connection, not one per conversation

The stray-leaf sweep that runs on every connection read the rosters one `GET user-members` at a time (81 requests, 5.0 s in production). It now reads them all in one `POST /api/mls/group-rosters`, authorized group by group. Against a server without the route, it reads each roster on its own, as before ([chat-delivery](docs/wiki/services/chat-delivery.md#many-rosters-in-one-read---post-apimlsgroup-rosters-2026-10-13)).
