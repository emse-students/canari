### Fixed - a crossed 1:1 pair can no longer lose both groups at boot

The boot merge of two DM groups for the same two people now folds only into the lowest group id,
and decides nothing when this device's most recent group is another one, so two up-to-date clients
never delete the same pair's last group
([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-crossed-11-pair-the-lower-id-is-never-deleted-2026-11-12)).
