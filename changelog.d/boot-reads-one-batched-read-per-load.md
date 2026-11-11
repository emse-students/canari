### Changed - a load asks the salons and key group of all communities in one request, and the follow chips wait for one round

Nine communities cost 27 requests at every connection and now cost 10 (one new batched
`boot-reads` route; the old routes stay), and eight cards mounting in turn sent eight
`follow-statuses` calls and now send two. See the
[audit, section 4](docs/wiki/frontend/weak-network-audit-2026-11-10.md).
