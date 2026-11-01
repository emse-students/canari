### Fixed - a migration the owner must approve is held until the owner's own merge approves it

A migration marked `-- canari:hold-for-owner`, or with any statement that is not plainly additive, refuses the release tag and the deploy until `infrastructure/migration-approvals.txt` names its checksum - a file no auto-merge may touch - and an approved one is applied right after a database dump; TypeORM `synchronize` is now an explicit flag a production service refuses ([cicd](docs/wiki/cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)).
