### Fixed - an out-of-range checkout amount is logged and says its bounds

The refusal (provider range 0.50-1000 EUR, or a product's own bounds) is now a typed `AMOUNT_OUT_OF_RANGE` carrying `minCents` / `maxCents`, logged where it is decided, and the shop and form payment UIs show its own sentence instead of "Erreur lors du paiement". See [cotisations](docs/wiki/cotisations.md).
