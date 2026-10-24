### Fixed - leaving or deleting a group no longer leaves a frame of it queued for the server to refuse

The exit sends what the group still has queued before its server step, withdraws only what cannot go (logged by kind), and refuses any later frame for it, even after an app kill mid-leave; a lost leave or delete notice is now logged ([chat](docs/wiki/frontend/modules/chat.md#an-exit-takes-the-groups-queue-with-it-before-its-server-step-grp-6-2026-10-22)).
