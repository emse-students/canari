### Fixed - a single-answer form no longer takes a second paid answer

A submit after a paid (or still pending, free or cash) answer is refused server-side with 409
`ALREADY_ANSWERED` before any payment request is issued ([forms](docs/wiki/frontend/modules/forms.md)).
