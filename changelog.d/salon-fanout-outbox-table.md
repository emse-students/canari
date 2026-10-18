### Added - the table of the salon fan-out outbox (migration 093, unused for one release)

A salon row committed by a process that died before its broadcast is never broadcast or pushed; the fix is a transactional outbox, shipped in two releases so a deploy never fails a send ([backlog](docs/wiki/backlog.md)).
