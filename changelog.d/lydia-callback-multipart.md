### Fixed - Lydia's callbacks were refused for lack of a readable body

The callback route reads `multipart/form-data` now, and says what it received when a field is missing ([payments](docs/wiki/frontend/modules/payments.md)).
