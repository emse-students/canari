### Fixed - the deploy-rolling self-test's lone reset is explained: a renamed replica list starts with no peer

Each take-out and restore reload renames a `resolve` server, and nginx fills a renamed one only when its own DNS query returns, refusing what it takes meanwhile (measured; the fix is designed, not built). The self-test now prints failure times and proxy warnings when a POST fails. See [cicd](docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to) and [backlog](docs/wiki/backlog.d/p1-a-renamed-replica-list-starts-with-no-peer.md).
