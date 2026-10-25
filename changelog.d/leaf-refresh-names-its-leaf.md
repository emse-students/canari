### Fixed - an unclean exit after a commit no longer makes the next send refresh the leaf again

The leaf-refresh ledger now names the leaf each entry dates, so an entry the browser lost after the merge reached disk is read as a former leaf and costs no commit ([mls-protocol](docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh)).
