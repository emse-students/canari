### Fixed - a Lydia Responsable with every right was recorded as unconfirmed

The rights read-back looked for `access_*` at the top of Lydia's answer, while Lydia returns them under `data`, so 13 granted rights read as 0 ([payments](docs/wiki/frontend/modules/payments.md)).
