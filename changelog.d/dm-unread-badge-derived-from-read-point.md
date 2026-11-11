### Fixed - a DM or group message never opened keeps its unread badge across cold starts

The load counted only what its own replay added, so a message a push had stored in an earlier session lost its badge at the next start; the count is now derived from the saved read point at every load, and a one-time local seed keeps the upgrade from lighting up old conversations ([chat](docs/wiki/frontend/modules/chat.md#a-dms-unread-count-is-derived-from-its-read-point-at-every-load-2026-11-11)).
