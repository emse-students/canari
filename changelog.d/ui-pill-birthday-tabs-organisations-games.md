### Changed - the header pill fits its content again, a quiet birthday card, "Organisations", a Games page, a calmer profile header

The conversation title pill adapts to its content once more (the full-width pill of 1.6.9 is reverted); the birthday prompt is a small dismissible feed card instead of a modal and its settings are minimal; the "Associations" tab and directory read "Organisations"; a Games page in the dashboard holds the Minesweeper with an overall and a per-promo ranking; a profile header is a name, one muted line and a rank badge, and the correction request moved to the account information ([minesweeper](docs/wiki/frontend/modules/minesweeper.md), [birthdays](docs/wiki/birthdays.md), [chat](docs/wiki/frontend/modules/chat.md)).

### Fixed - a second browser tab no longer reads "Hors-ligne" while the account is online

The follower's question to the leader tab went out before the account was known and was dropped as another account's; it is now sent when the account becomes known and when the election is decided ([chat](docs/wiki/frontend/modules/chat.md)).
