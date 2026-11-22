### Fixed - deleting a paid answer said it was deleted while it stayed

A manager deleting a paid answer was told it was deleted, though the guard had kept it: the delete's result was misread. The 409 "refund or cancel it instead" now reaches the manager ([forms](docs/wiki/frontend/modules/forms.md#payment-methods)).
