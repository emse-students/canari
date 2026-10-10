### Fixed - a seed request's decline is delivered like any other message, so a requester is no longer stranded

A bundle of pure declines used to be dropped for a requester with no socket yet, and nothing re-asked; it now travels durably like a seed, and a replayed decline is matched to the request it answers ([mls-graine-state-machine](docs/wiki/protocols/mls-graine-state-machine.md)).
