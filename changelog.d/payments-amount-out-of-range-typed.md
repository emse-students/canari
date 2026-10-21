### Fixed - an out-of-range checkout amount is logged and says its bounds

The refusal (provider range 0.50-1000 EUR, or a product's own bounds) is now a typed `AMOUNT_OUT_OF_RANGE` carrying `minCents` / `maxCents`, logged where it is decided, and the shop and form payment pages word the range in the reader's language instead of "Erreur lors du paiement" or the server's English. See [payments](docs/wiki/frontend/modules/payments.md).
