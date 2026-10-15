### Fixed - an abandoned form checkout no longer keeps its seat for ever

An online `pending` answer holds its seat for 30 minutes from its own row, then expires; a payment arriving later takes a free seat or is flagged `paid_over_capacity` for a refund, and concurrent submits can no longer oversell a capped form ([forms](docs/wiki/frontend/modules/forms.md#an-online-payment-holds-its-seat-for-30-minutes-and-a-late-one-is-decided-from-the-row-2026-10-15)).
