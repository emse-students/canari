### Fixed - a product withheld because its payments stopped answers "payments not active", not "not found"

A checkout of a product withheld by a readiness revert (a Lydia bridge's switch back onto a historical account that is not ready included) now gets the typed payments-not-ready refusal at its preparation, as at its decision; the Lydia bridge's three-purchase error 5 test no longer depends on how its purchases interleave ([payments](docs/wiki/frontend/modules/payments.md#a-historical-account-collects-until-the-enrolled-business-is-validated-owner-2026-11-13)).
