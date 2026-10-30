### Fixed - the server rejects an unlisted form question type and a non-integer price

`FormItemDto.type` now validates against the canonical question-type list, and `basePrice` and an
option's `priceModifier` are integer cents. A `priceModifier` can no longer be negative, which used
to show the payer a discount the charge never applied ([forms](docs/wiki/frontend/modules/forms.md)).
