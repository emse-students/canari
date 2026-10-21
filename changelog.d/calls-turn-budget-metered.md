### Fixed - calls: the TURN budget counts what Cloudflare relayed, not every call at 3000 kbps

`ice-servers` now compares the month's egress metered by Cloudflare (GraphQL analytics, two new secrets) to the budget; the duration estimate is deleted ([calls](docs/wiki/frontend/modules/calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)).
