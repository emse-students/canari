### Changed - Lydia callbacks are verified with the association's own Business key, and only trigger a read of the row's request

The key is entered write-only by the payout manager and encrypted at rest (migration 086); an association without one has its callbacks refused and its form payments confirmed on the payer's return. The dev-only observation of #1928 is removed ([payments](docs/wiki/frontend/modules/payments.md#what-confirms-a-payment-2026-10-16)).
