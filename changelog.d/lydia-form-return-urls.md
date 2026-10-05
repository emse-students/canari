### Fixed - a paid form paid through Lydia no longer lands on "payment not found"

Lydia cannot fill in Stripe's `{CHECKOUT_SESSION_ID}`, so its return URLs carry the submission id and the page reads that submission until the signed callback has marked it paid ([payments](docs/wiki/frontend/modules/payments.md#where-lydia-sends-the-payer-back-2026-10-05)).
