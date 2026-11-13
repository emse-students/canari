## P2 - the MLS snapshot version is a PER-DOCUMENT counter compared ACROSS documents, so a second tab's write is dropped on a collision (measured on TAB-4, 2026-09-05)

target: 1.8.0

**Data point, web log 2026-11-08: one multi-tab collision DID drop a staged commit.** "Whether anything is lost" is therefore no longer unmeasured - at least one loss is on record (the tab, the group and the exact counters were not kept; the next reading should capture them). The state is expected to converge otherwise. **Owed:** a shared counter or a proof of convergence and its delay ([mls-desync-prevention](../protocols/mls-desync-prevention.md#the-checkpoint-window-and-the-per-document-snapshot-counter-moved-from-the-backlog-2026-10-08)).
