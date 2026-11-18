### Added - the global admins are told when a profile correction or a report arrives

A filed profile correction, and the first report on a subject, now ring every global admin (a bell row and a content-free push) and leave every admin's bell once one handles the item; `GET /api/moderation/admin-queues` counts what waits in each queue the caller may act on ([admin](docs/wiki/frontend/modules/admin.md#pending-counts-and-the-admin-notices-owner-2026-11-18)).

Every item that enters or leaves an admin queue sends one empty `admin.queues.changed` frame over the chat socket to the accounts that may act on it, so the badges refetch instead of polling ([admin](docs/wiki/frontend/modules/admin.md#pending-counts-and-the-admin-notices-owner-2026-11-18)).
