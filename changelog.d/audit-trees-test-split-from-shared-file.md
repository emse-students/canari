### Changed - the audit-tree table's assertions moved to their own Canari-only test

`audit-dependencies.test.sh` is one of the files the four repositories must keep byte-identical, and its second half tested a Canari-only table, so it had forked. That half is now `audit-trees.test.sh` ([cicd](docs/wiki/cicd.md#the-audit-blocks-on-what-we-ship-2026-11-17)).
