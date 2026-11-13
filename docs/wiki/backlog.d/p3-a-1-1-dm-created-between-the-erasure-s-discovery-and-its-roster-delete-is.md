## P3 - A 1:1 DM created between the erasure's discovery and its roster delete is not tombstoned (review of #2258, 2026-10-24)

target: 1.9.0

`deleteUserData` tombstones the DMs its discovery found. A DM opened with the account after that
read (by the account while a token is valid) loses the
account's roster row to the roster delete and its device rows to the sweep's cut, but its
`dm_groups` row and the other party's side stay: a 1:1 conversation with one member left. The final
pass does not find it either, since nothing of the account names it any more. Small and rare (a DM
opened inside the erasure window); fix by having the sweep tombstone any DM whose roster the
account was on. Re-read 2026-11-11: unchanged in code; re-read again 2026-12-11.
