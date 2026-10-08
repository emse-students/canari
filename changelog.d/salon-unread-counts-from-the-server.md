### Fixed - a salon's unread badge no longer vanishes at every reload

Nothing marked a salon read that was not opened (measured on ten communities), but the badge was a live tally that a reload, a cold start or a down socket reset to zero. The server now counts per salon against the member's read mark and the app merges that count. See [chat](docs/wiki/frontend/modules/chat.md#unread-counts-of-salons-the-server-counts-this-device-only-merges-2026-10-08).
