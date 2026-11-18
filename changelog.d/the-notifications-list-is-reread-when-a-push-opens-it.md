### Fixed - a push that opens the notifications list while it is already open shows its new row

Tapping a sanction or birthday push on `/notifications` itself left the list stale: it was read on mount only. It is now re-read when the navigation lands on the route it left ([mobile](docs/wiki/frontend/mobile.md)).
