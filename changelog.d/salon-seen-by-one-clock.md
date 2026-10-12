### Fixed - the "seen by" heads under a salon's last message no longer appear then vanish

A salon row was dated by the server on the live path and by the author's clock on the history load, so the heads flipped with every reload when the author's clock ran ahead; it is now dated by the server on every path ([social-service](docs/wiki/services/social-service.md#read-receipts-in-a-salon)).
