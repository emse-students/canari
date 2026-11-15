## P3 - A salon is read before the key-group drain has finished, so its rows warn "unreadable - missing seed" and are read again later (1.6.11 logs, 2026-11-14)

target: 1.7.0

Opening a salon can read its rows while the key-group drain (the Welcomes and seed frames that deliver
its keys) is still running. The rows are then refused with `unreadable - missing seed`, warned, and
only readable at a later open - a race that heals cleanly, which is still a defect
([durable-rules](../durable-rules.md): name what makes the two paths overlap and delete the overlap; a
re-read afterwards is a witness, never a fix).

Fix: the salon read waits on the drain's own completion (a settled promise or a latch held by the drain,
never a timer), so a row is either read with its key or reported as truly missing after the drain ended.
The test is a salon opened while a drain is pending: no `missing seed` warning, and the rows are read
once the drain settles. Distinct from
[the Graine v1 rows warned on every open](p3-salon-rows-warned-unreadable-on-every-open.md), which is
about rows that can NEVER be read here.
