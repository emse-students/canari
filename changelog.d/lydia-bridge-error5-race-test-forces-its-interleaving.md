### Fixed - the Lydia bridge's three-purchase error 5 test no longer depends on how its purchases interleave

A purchase prepared before another's switch back and decided after it is refused `PAYMENT_ROUTING_CHANGED`, unissued, as designed; the test now forces each interleaving instead of assuming one ([payments](docs/wiki/frontend/modules/payments.md#a-historical-account-collects-until-the-enrolled-business-is-validated-owner-2026-11-13)).
