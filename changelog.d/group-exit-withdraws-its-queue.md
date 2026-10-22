### Fixed - leaving or deleting a group no longer leaves a frame of it queued for the server to refuse

The exit withdraws the group's queued outbox entries and its owed read mark before its server step, and a lost leave or delete notice is now logged ([chat](docs/wiki/frontend/modules/chat.md#an-exit-takes-the-groups-queue-with-it-before-its-server-step-grp-6-2026-10-22)).
