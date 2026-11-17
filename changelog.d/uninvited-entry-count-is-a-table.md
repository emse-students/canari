### Changed - the uninvited-entry count survives a deploy

`[UNINVITED_ENTRY]` was de-duplicated in one replica's memory and lived only in one container's log, so every deploy reset the count the admission rule's fix-forward is read on. Each entry is now counted once in `uninvited_entries` (migration 053, additive), kept 90 days like the line it de-duplicates ([mls-protocol](docs/wiki/protocols/mls-protocol.md#the-count-is-a-table-uninvited_entries-migration-053-2026-11-17)).
