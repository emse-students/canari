### Fixed - the tab-commit delegation tests no longer take their turns from a timer

Under the full parallel run, single `tabCommitDelegation` cases passed the 5 s default: each of its simulated turns was a
`setTimeout(0)`, a real clock tick. They now use `setImmediate`, with the same ordering and no clock; one
`pendingMutationsStore` flood case is also smaller ([test-suite-reform](docs/wiki/test-suite-reform.md)).
