### Fixed - the server rejects an unlisted form question type and a non-integer base price

`FormItemDto.type` now validates against the canonical question-type list and `basePrice` is integer
cents, so a hand-posted write can no longer store junk ([forms](docs/wiki/frontend/modules/forms.md)).
