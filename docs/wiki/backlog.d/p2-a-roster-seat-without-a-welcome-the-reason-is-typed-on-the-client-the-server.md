## P2 - a roster seat without a Welcome: the reason is typed on the client, the server report cannot partition on it yet (prod 2026-09-01)

target: 1.8.0

Open: a client-to-server write (migration) so `reportStrandedDeviceMemberships` can join the reason; read
the first real `skipped` lines before designing it
([detail](../protocols/campaign-measured-defects.md#a-roster-seat-without-a-welcome---the-typed-reason-prod-2026-09-01)). Decided by the user on 2026-10-10: an additive column, one field in the hourly report.

_Context, from the former backlog section "MLS state, device healing and delivery - the defects the campaign measured":_ Open entries only; each carries a title, what is left and a link. The measurements, recurrences and
refuted readings are on [campaign-measured-defects](../protocols/campaign-measured-defects.md), the
cold-start ledger on [history-reconciliation](../protocols/history-reconciliation.md).
