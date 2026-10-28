### Fixed - a Lydia payment whose callback was lost is now recorded without the payer coming back

A sweep reads at Lydia every form answer and boutique attempt whose request has ended unsettled, and settles it through the existing paths only on an answer whose signature verifies over the row's own amount; behind `LYDIA_RECONCILE_ENABLED`, on in dev and off in production until the signed amount format is measured; a signature with trailing junk no longer verifies ([lydia-api](docs/wiki/lydia-api.md#7-reconciliation---the-sweep-lydias-documentation-asks-for)).
