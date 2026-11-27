### Fixed - a top-up paid for a member who has never signed in to Le Cercle is parked there and credited at first sign-in, instead of waiting for a retry

Le Cercle answered `404` and Canari retried it on a backoff, so the credit landed minutes to hours after the first sign-in. Le Cercle now parks it and answers `202`, which Canari records as `parked`, off the failure ladder and re-sent every six hours until Le Cercle answers it credited; a `404` stays a failure ([cotisations](docs/wiki/cotisations.md#outbound-canari---cercle-balance_topup-webhook)).
