### Added - the table of the salon fan-out outbox (migration 093)

A salon row committed by a process that died before its broadcast is never broadcast or pushed; the fix is a transactional outbox, its writer in a second pull request ([backlog](docs/wiki/backlog.md)).
