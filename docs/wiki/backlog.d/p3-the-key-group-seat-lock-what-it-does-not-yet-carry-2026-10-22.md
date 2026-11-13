## P3 - The key-group seat lock: what it does not yet carry (2026-10-22)

target: 1.9.0

Every seat-creating write (a commit's committer and its admits, a key group's publisher) and every
eviction share one per-group advisory lock, and a seat claim is the group's own generation,
`dm_groups."seatGeneration"`, which every eviction moves (chat-delivery migration 036; a claim an
unrelated eviction overtook refuses the whole commit with a retryable 409 `SEAT_CLAIM_OVERTAKEN`).
`dm_seat_evictions` only names a key-group departure in progress, and an erasure deletes its rows;
every key-group departure, account erasure included, goes through one function and
records its outcome in `distribution_departures` (social migration 108), which the hourly drain asks
for ([channel-encryption](../protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
Both migrations are applied by the release's deploy before the new containers start, and may ride the
next stable (user, 2026-10-22). The first-writer-wins race runs against PostgreSQL in CI
(`distribution-departure.integration.spec.ts`), and chat-delivery's seat lock orderings too
(`seat-lock.integration.spec.ts`, `test-chat-delivery-integration`). A rejoin after a lost second eviction
waits for the hourly drain, by design ([channel-encryption](../protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
Owed: (1) the counts of `[KEY_DISTRIBUTION] second eviction FAILED`, `departure ABANDONED`,
`abandoned departure NOT settled`, `first eviction named NO departure`, `DEPARTURE_SUPERSEDED`,
`route NOT written`, `ROUTE_NOT_RESTORED`, `SEAT_GONE_NOT_QUEUED`, `REJECT seat_claim_overtaken`
(by `seat=committer|admit`, and how many in an ordinary conversation), `reason=no_key_package`
(`ADMIT_REFUSED`, `REFUSED` and `REJECT committer_not_member`), `[INTERNAL_DELETE] ... route(s) no
seat stands behind outlived the cuts above and were removed` and `[SEAT_DRAIN]` outcomes on dev then production, expected near 0 (the
unnamed line only during the deploy itself); (2) the latency of a key group's commit with admits
(the questions are asked in parallel, one round trip) measured on dev. Re-read 2026-11-11: log
counts on the hosts, not taken by the triage; re-read again 2026-12-11.
