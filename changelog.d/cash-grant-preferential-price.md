### Fixed - a cash sale records the preferential price when its beneficiary qualifies

With no amount typed, `grantProductPurchase` records the price the checkout would charge that beneficiary, the member price included, instead of the full price; a typed amount still wins ([cotisations](docs/wiki/cotisations.md#c-manual-grant-from-the-cotisations-tab-cash--retroactive)).
