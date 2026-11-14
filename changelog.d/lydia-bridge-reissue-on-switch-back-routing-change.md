### Changed - a purchase caught by a Lydia bridge's switch back is re-issued by the server, not refused

A purchase prepared on the enrolled Business and decided after a switch back to the historical account is now opened again once on the historical account, as one decided a moment earlier already was, instead of answering `PAYMENT_ROUTING_CHANGED`; every other routing change keeps the 409 ([payments](docs/wiki/frontend/modules/payments.md#a-historical-account-collects-until-the-enrolled-business-is-validated-owner-2026-11-13)).
