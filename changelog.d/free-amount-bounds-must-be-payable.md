### Fixed - a free-amount limit the payment provider would refuse is refused at the save

A bound outside 0.50-1000 EUR answers a typed `AMOUNT_OUT_OF_RANGE` carrying that range, and the
product editor names it ([payments](docs/wiki/frontend/modules/payments.md)).
