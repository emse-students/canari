### Fixed - the first checkpoint after a state opens weighs the seen ledgers five times faster

Weighing every seen ledger once, character by character, cost 86 ms on a full state (and timed a CI case out). An ASCII
ledger is now measured in one native scan ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md)).
