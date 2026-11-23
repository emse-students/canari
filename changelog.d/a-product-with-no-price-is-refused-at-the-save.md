### Fixed - a product nothing prices is refused when it is saved, not at its first checkout

Creating or editing a product with no fixed amount, no free amount and no grid answers a typed 400
`PRODUCT_HAS_NO_PRICE`, worded in the editor ([payments](docs/wiki/frontend/modules/payments.md)).
