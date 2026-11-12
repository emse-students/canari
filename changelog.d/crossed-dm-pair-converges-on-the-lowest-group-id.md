### Fixed - a crossed 1:1 pair no longer loses both groups at boot

Two DM groups for the same two people now end on the lowest group id on every device of both, and
the boot merge deletes a group on the server only when every leaf of it is in the survivor and an
older client would keep the same one
([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-crossed-11-pair-ends-on-the-lowest-group-id-2026-11-12)).
