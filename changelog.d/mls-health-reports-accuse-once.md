### Fixed - chat-delivery's hourly MLS health reports accuse each item once instead of every hour

A commit-log hole, a conversation with too few holders, a stranded device or a stale base is printed at ERROR or WARN on the run that first finds it in its state, again only when that state changes, and counted otherwise by one daily LOG line per report; the ledger is migration 049 ([chat-delivery](docs/wiki/services/chat-delivery.md#each-item-is-accused-once-report_accusations-migration-049-2026-11-13)).
