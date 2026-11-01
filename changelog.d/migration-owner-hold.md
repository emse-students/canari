### Fixed - a migration the owner must approve is held until a committed line approves it

A migration marked `-- canari:hold-for-owner`, or containing a data-destroying statement, now fails the deploy before anything is applied until `infrastructure/migration-approvals.txt` names its checksum ([cicd](docs/wiki/cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)).
