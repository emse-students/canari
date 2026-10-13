### Changed - one roster read per connection, not one per conversation

The stray-leaf sweep that runs on every connection read the rosters one `GET user-members` at a time (81 requests, 5.0 s in production). It now reads them all in one `POST /api/mls/group-rosters`, authorized group by group; a group it names a stray in is read again, tree then roster, right before the removal. Against a server without the route it removes nobody until the server deploys ([chat-delivery](docs/wiki/services/chat-delivery.md#many-rosters-in-one-read---post-apimlsgroup-rosters-2026-10-13)).
