### Fixed - a re-keyed 1:1 carries the mutations waiting under its old group, and an own act on a row that cannot open keeps nothing

The move of a duplicate 1:1's rows now carries the deletions, edits and reactions still waiting under the old group; an own act is kept under the lowercased conversation id, and never kept for a row this device cannot open ([history-reconciliation](../docs/wiki/protocols/history-reconciliation.md)).
