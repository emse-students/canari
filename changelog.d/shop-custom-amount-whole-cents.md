### Fixed - a shop free amount must be whole cents

The checkout's `customAmountCents` was never validated: `5000.5` passed the bounds and was charged rounded while recorded as sent, and a string compared as NaN and passed both. It is now refused at the controller with a typed, logged `AMOUNT_INVALID`, and the manual cash grant's bounds check answers the typed `AMOUNT_OUT_OF_RANGE` its screen words. See [payments](docs/wiki/frontend/modules/payments.md).
