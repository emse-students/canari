## P3 - Nothing warns a manager whose free-amount bounds fall outside the payable range (review of #2208, 2026-10-21, not built)

target: 1.9.0

**Re-read 2026-11-11: unchanged** - `ProductsService` checks only that min <= max. A product's `customAmountMinCents` / `customAmountMaxCents` can be saved outside 0.50-1000 EUR (`libs/contracts/payment-amount-range.json`), so a buyer is refused by the provider range at checkout for an amount the product itself allows. Owed: the product editor names the range when a bound crosses it ([payments](../frontend/modules/payments.md)).
