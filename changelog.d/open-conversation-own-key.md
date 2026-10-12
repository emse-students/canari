### Changed - a message in another conversation no longer redraws the open one

The open conversation was found by iterating every conversation, so each message received anywhere regrouped and re-rendered the thread on screen; it is now read by its own key ([frontend/architecture](docs/wiki/frontend/architecture.md#a-derived-that-needs-one-key-reads-the-sveltemap-by-key-never-by-iterating-it-2026-10-12)).
