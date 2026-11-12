### Fixed - a 1:1 joined by Welcome takes every stored message of the duplicate it replaces

A duplicate 1:1 restored without its messages in memory kept its stored rows when the Welcome of the
merged conversation arrived, so each history read warned about rows of another conversation until
the next start. The Welcome now moves them through the boot merge's own move
([history-reconciliation](docs/wiki/protocols/history-reconciliation.md)).
