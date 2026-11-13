### Changed - a cold start on a slow link no longer waits for the session refresh to draw

The announcement, the help-seen set, the "birthday entered" fact and, on a hardware-held phone, the
feed's stored page are drawn from the device before the token arrives, then revalidated
([local-first-ui](docs/wiki/frontend/local-first-ui.md#4bis-the-session-refresh-no-longer-gates-the-boot-paths-first-paint-2026-11-11)).
