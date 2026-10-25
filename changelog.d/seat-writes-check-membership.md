### Fixed - seat writes check membership

A demotion only updates the seat it read and never creates one; in a key-distribution group, a report of `active` and a first commit from a `pending` seat are accepted only once social-service answers that the owner is entitled ([state machine](docs/wiki/protocols/mls-graine-state-machine.md#seat-writes-check-membership-2026-10-25)).
