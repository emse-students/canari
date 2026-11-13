### Fixed - a web window left open with nobody at it no longer marks messages read

A window counts as read only after a gesture in the last two minutes; what lands while it is idle
stays unread, notifies, and is marked at the first gesture. Native mobile is unchanged
([read-receipt-privacy](docs/wiki/read-receipt-privacy.md#reopened-2026-11-11---an-idle-window-is-not-a-reader)).
