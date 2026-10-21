### Fixed - a boutique product can be bought again after a declined or expired payment

Every checkout reused one Lydia order_ref, which Lydia refuses the second time; each attempt is now a stored row (migration 101) with its own order_ref, the purchase is settled from that row on the payer's return or Lydia's verified callback, and "already purchased" is decided by Canari before any payment request ([payments](docs/wiki/frontend/modules/payments.md#a-product-checkout-is-a-row-one-per-attempt-2026-10-21)).
