### Fixed - deleting two associations that co-organise each other's events no longer deadlocks

`remove` now locks the association and every association its events' co-organisation reaches, in id
order, before it deletes anything, so two such deletes queue instead of crossing their cascades
([profiles-and-access](docs/wiki/profiles-and-access.md)).
