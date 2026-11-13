### Fixed - the notification bell and a profile already opened draw from the device on a weak link

The notification list and the last 12 profiles opened are now kept sealed on the device (per account,
never in clear) and drawn at once, then revalidated; a failed revalidation keeps the copy. Pour toi
already had its stored first page
([local-first-ui](docs/wiki/frontend/local-first-ui.md#4ter-the-bell-and-profiles-already-opened-have-a-local-copy-2026-11-11)).
