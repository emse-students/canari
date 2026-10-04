### Fixed - the one-shot history audit no longer re-lists distribution groups on every connection

A distribution group can never be audited, so it can never be discharged; it no longer owes the audit, which ends the `auditing N group(s)` / `0/N asked` pair on every connection ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#and-the-fix-does-not-reach-backwards---hence-the-audit)).
