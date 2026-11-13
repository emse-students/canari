## P3 - Salon rows that cannot be read (Graine v1 rows, a missing seed `key:24`) are warned again on every open, for ever (1.6.8 logs, 2026-11-09)

Rows written under a Graine v1 session this device does not hold, or whose seed key is missing, can
never be read here (the salon notice is `utils/chat/olderMessagesNotice.ts`). Each open of the salon
re-attempts them and warns again. Fix: latch per salon (durable state; `utils/changeLatch.ts`, added
by the noise batch, is the helper) - say it once per (salon, set of dropped row ids) and let the notice
the salon already shows carry the rest. The warn site was not located in the batch (the log text was
not in the brief); find it from the `droppedV1RowIds` producer that feeds `olderMessagesNotice`.
