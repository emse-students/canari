### Fixed - the server rejects an unlisted form question type and a non-integer price

`FormItemDto.type` now validates against the canonical question-type list, and `basePrice` and an
option's `priceModifier` are integer cents, so a hand-posted write can no longer store junk
([forms](docs/wiki/frontend/modules/forms.md)).
